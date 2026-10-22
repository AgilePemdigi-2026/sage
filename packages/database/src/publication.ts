import { createHash } from "node:crypto";
import { parseCanonicalCkg } from "../../contracts/src/ckg.ts";
import { projectArchitectureDocument } from "@sage/documents/model";
import { ANALYSIS_STAGE_DEFINITIONS } from "../../contracts/src/stages.ts";
import type { AnalysisStageTargetContext } from "./stages.ts";
import { AnalysisQueueInvariantError, snapshotAnalysisJobClaim } from "./queue.ts";
import type { AnalysisJobClaim } from "./queue.ts";
import { Prisma } from "../generated/client.ts";
import type { PrismaClient } from "../generated/client.ts";

const ANALYSIS_SLOT = "analysis";
const SHA256 = /^[a-f0-9]{64}$/;
const COMMIT_SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;
const LIMITATION_EXPLANATIONS = {
  SOURCE_FILES_EXCLUDED: "Beberapa file source dikecualikan oleh kebijakan analisis yang dikonfigurasi.",
  SOURCE_FILES_FAILED: "Beberapa file source yang didukung tidak dapat dianalisis.",
  MODEL_LIMITATIONS: "Model canonical memiliki keterbatasan atau relasi yang belum terselesaikan.",
} as const;

export interface AnalysisSnapshotManifest {
  readonly storageObjectId: string;
  readonly archiveSha256: string;
  readonly archiveBytes: number;
  readonly commitSha: string;
  readonly files: number;
  readonly extractedBytes: number;
}

export interface PublishAnalysisResultInput {
  readonly claim: AnalysisJobClaim;
  readonly target: AnalysisStageTargetContext;
  readonly configuration: unknown;
  readonly snapshot: AnalysisSnapshotManifest;
  readonly sourceBytes: Readonly<Record<string, Uint8Array>>;
  readonly canonicalCkgJson: string;
  readonly expectedCkgSha256: string;
  readonly graphBundleId: string;
  readonly canonicalDocumentJson: string;
  readonly expectedDocumentSha256: string;
  readonly architectureDocumentId: string;
  readonly signal?: AbortSignal;
}

interface SafeLimitation {
  code: keyof typeof LIMITATION_EXPLANATIONS;
  stageKey: string;
  affectedPartCount: number;
  safeExplanation: string;
}

class PublicationLeaseLostError extends Error {}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactDataObject(value: unknown, fields: readonly string[], label: string): Record<string, unknown> {
  if (!isPlainObject(value)) throw new Error(`${label} is invalid.`);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.length || keys.some(key => typeof key !== "string" || !fields.includes(key))) {
    throw new Error(`${label} has invalid fields.`);
  }
  for (const key of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) throw new Error(`${label} must contain data properties.`);
  }
  return value;
}

type JsonValue = null | string | boolean | number | JsonValue[] | { [key: string]: JsonValue };

function canonicalJson(value: unknown): string {
  const active = new Set<object>();
  let nodeCount = 0;
  const normalize = (item: unknown, depth: number): JsonValue => {
    nodeCount += 1;
    if (nodeCount > 20_000 || depth > 64) throw new Error("Configuration is too complex.");
    if (item === null || typeof item === "string" || typeof item === "boolean") return item;
    if (typeof item === "number") {
      if (!Number.isFinite(item)) throw new Error("Configuration contains an invalid number.");
      return Object.is(item, -0) ? 0 : item;
    }
    if (typeof item !== "object" || active.has(item)) throw new Error("Configuration is invalid.");
    active.add(item);
    try {
      if (Array.isArray(item)) {
        if (Object.getPrototypeOf(item) !== Array.prototype || item.length > 20_000) throw new Error("Configuration array is invalid.");
        const keys = Reflect.ownKeys(item);
        if (keys.some(key => typeof key !== "string" || (key !== "length" && !/^(0|[1-9]\d*)$/.test(key)))) throw new Error("Configuration array is invalid.");
        const result: JsonValue[] = [];
        for (let index = 0; index < item.length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(item, String(index));
          if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) throw new Error("Configuration array is invalid.");
          result.push(normalize(descriptor.value, depth + 1));
        }
        return result;
      }
      if (!isPlainObject(item)) throw new Error("Configuration object is invalid.");
      const keys = Reflect.ownKeys(item);
      if (keys.some(key => typeof key !== "string")) throw new Error("Configuration object is invalid.");
      const result: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
      for (const key of (keys as string[]).sort()) {
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) throw new Error("Configuration object is invalid.");
        result[key] = normalize(descriptor.value, depth + 1);
      }
      return result;
    } finally {
      active.delete(item);
    }
  };
  const result = JSON.stringify(normalize(value, 0));
  if (typeof result !== "string") throw new Error("Configuration cannot be serialized.");
  if (Buffer.byteLength(result, "utf8") > 1_048_576) throw new Error("Configuration is too large.");
  return result;
}

function snapshotTarget(input: unknown): AnalysisStageTargetContext {
  const fields = ["analysisId", "repositoryId", "repositoryFullName", "repositoryVisibility", "branchName", "commitSha", "configurationHash", "analyzerVersion", "schemaVersion"] as const;
  const value = exactDataObject(input, fields, "Analysis target");
  const strings = ["analysisId", "repositoryId", "repositoryFullName", "branchName", "analyzerVersion", "schemaVersion"] as const;
  if (strings.some(key => typeof value[key] !== "string" || !(value[key] as string).trim()) ||
      !COMMIT_SHA.test(String(value.commitSha)) || !SHA256.test(String(value.configurationHash)) ||
      !["PUBLIC", "PRIVATE", "INTERNAL", "UNKNOWN"].includes(String(value.repositoryVisibility))) {
    throw new Error("Analysis target is invalid.");
  }
  return Object.freeze({
    analysisId: value.analysisId as string,
    repositoryId: value.repositoryId as string,
    repositoryFullName: value.repositoryFullName as string,
    repositoryVisibility: value.repositoryVisibility as AnalysisStageTargetContext["repositoryVisibility"],
    branchName: value.branchName as string,
    commitSha: value.commitSha as string,
    configurationHash: value.configurationHash as string,
    analyzerVersion: value.analyzerVersion as string,
    schemaVersion: value.schemaVersion as string,
  });
}

function snapshotManifest(input: unknown): AnalysisSnapshotManifest {
  const fields = ["storageObjectId", "archiveSha256", "archiveBytes", "commitSha", "files", "extractedBytes"] as const;
  const value = exactDataObject(input, fields, "Source snapshot");
  if (typeof value.storageObjectId !== "string" || !value.storageObjectId.trim() ||
      typeof value.archiveSha256 !== "string" || !SHA256.test(value.archiveSha256) ||
      typeof value.archiveBytes !== "number" || !Number.isSafeInteger(value.archiveBytes) || value.archiveBytes <= 0 ||
      !COMMIT_SHA.test(String(value.commitSha)) ||
      typeof value.files !== "number" || !Number.isSafeInteger(value.files) || value.files < 0 ||
      typeof value.extractedBytes !== "number" || !Number.isSafeInteger(value.extractedBytes) || value.extractedBytes < 0) {
    throw new Error("Source snapshot is invalid.");
  }
  return Object.freeze({
    storageObjectId: value.storageObjectId,
    archiveSha256: value.archiveSha256,
    archiveBytes: value.archiveBytes as number,
    commitSha: value.commitSha as string,
    files: value.files as number,
    extractedBytes: value.extractedBytes as number,
  });
}

function snapshotSourceBytes(input: unknown): Record<string, Uint8Array> {
  if (!isPlainObject(input)) throw new Error("Source bytes are invalid.");
  const result: Record<string, Uint8Array> = Object.create(null) as Record<string, Uint8Array>;
  const keys = Reflect.ownKeys(input);
  if (keys.some(key => typeof key !== "string")) throw new Error("Source bytes are invalid.");
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor) || !(descriptor.value instanceof Uint8Array)) {
      throw new Error("Source bytes are invalid.");
    }
    result[key] = new Uint8Array(descriptor.value);
  }
  return result;
}

function snapshotInput(input: PublishAnalysisResultInput) {
  const fields = [
    "claim", "target", "configuration", "snapshot", "sourceBytes", "canonicalCkgJson", "expectedCkgSha256",
    "graphBundleId", "canonicalDocumentJson", "expectedDocumentSha256", "architectureDocumentId",
  ] as const;
  if (!isPlainObject(input)) throw new Error("Publication input is invalid.");
  const keys = Reflect.ownKeys(input);
  if (keys.some(key => typeof key !== "string" || (!fields.includes(key as (typeof fields)[number]) && key !== "signal")) ||
      fields.some(key => !keys.includes(key))) throw new Error("Publication input has invalid fields.");
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) throw new Error("Publication input must contain data properties.");
  }
  const value = input as unknown as Record<string, unknown>;
  if (value.signal !== undefined && !(value.signal instanceof AbortSignal)) throw new Error("Publication signal is invalid.");
  const claim = snapshotAnalysisJobClaim(value.claim as AnalysisJobClaim);
  const target = snapshotTarget(value.target);
  const configurationJson = canonicalJson(value.configuration);
  if (sha256(configurationJson) !== target.configurationHash) throw new Error("Analysis configuration does not match its queued hash.");
  const snapshot = snapshotManifest(value.snapshot);
  if (snapshot.commitSha.toLowerCase() !== target.commitSha.toLowerCase()) throw new Error("Source snapshot does not match its queued commit.");
  if (typeof value.canonicalCkgJson !== "string" || typeof value.canonicalDocumentJson !== "string" ||
      typeof value.expectedCkgSha256 !== "string" || !SHA256.test(value.expectedCkgSha256) ||
      typeof value.expectedDocumentSha256 !== "string" || !SHA256.test(value.expectedDocumentSha256) ||
      typeof value.graphBundleId !== "string" || !value.graphBundleId.trim() ||
      typeof value.architectureDocumentId !== "string" || !value.architectureDocumentId.trim()) {
    throw new Error("Canonical result metadata is invalid.");
  }
  return {
    claim,
    target,
    configurationJson,
    snapshot,
    sourceBytes: snapshotSourceBytes(value.sourceBytes),
    canonicalCkgJson: value.canonicalCkgJson,
    expectedCkgSha256: value.expectedCkgSha256,
    graphBundleId: value.graphBundleId,
    canonicalDocumentJson: value.canonicalDocumentJson,
    expectedDocumentSha256: value.expectedDocumentSha256,
    architectureDocumentId: value.architectureDocumentId,
    signal: value.signal as AbortSignal | undefined,
  };
}

function currentLeasePredicate(claim: AnalysisJobClaim, tokenHash: string): Prisma.Sql {
  return Prisma.sql`
    EXISTS (
      SELECT 1 FROM "WorkerSlot" AS slot
      JOIN "Job" AS job ON job."id" = slot."jobId" AND job."ownerUserId" = slot."ownerUserId"
      JOIN "Analysis" AS analysis ON analysis."id" = job."analysisId" AND analysis."ownerUserId" = job."ownerUserId"
      WHERE slot."slotKey" = ${ANALYSIS_SLOT}
        AND slot."jobId" = ${claim.jobId} AND slot."ownerUserId" = ${claim.ownerUserId}
        AND slot."leaseTokenHash" = ${tokenHash} AND slot."leaseUntil" > clock_timestamp()
        AND job."id" = ${claim.jobId} AND job."analysisId" = ${claim.analysisId}
        AND job."ownerUserId" = ${claim.ownerUserId} AND job."type" = 'ANALYSIS'
        AND job."status" = 'RUNNING' AND job."attempt" = ${claim.attempt}
        AND job."leaseExpiresAt" > clock_timestamp()
        AND analysis."id" = ${claim.analysisId} AND analysis."ownerUserId" = ${claim.ownerUserId}
        AND analysis."status" = 'RUNNING'
    )
  `;
}

async function hasCurrentLease(
  tx: Prisma.TransactionClient,
  claim: AnalysisJobClaim,
  tokenHash: string,
): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ active: boolean }>>`
    SELECT ${currentLeasePredicate(claim, tokenHash)} AS "active"
  `;
  if (rows.length !== 1) throw new AnalysisQueueInvariantError();
  return rows[0].active;
}

function matchesGraphBundle(
  bundle: {
    id: string;
    ownerUserId: string;
    analysisId: string;
    schemaVersion: string;
    configurationHash: string;
    canonicalContent: string | null;
    nodes: unknown;
    edges: unknown;
    nodeCount: number;
    edgeCount: number;
    contentHash: string;
  },
  graph: Extract<ReturnType<typeof parseCanonicalCkg>, { ok: true }>,
  ownerUserId: string,
  analysisId: string,
  expectedId: string,
): boolean {
  return bundle.id === expectedId && bundle.ownerUserId === ownerUserId && bundle.analysisId === analysisId &&
    bundle.schemaVersion === graph.value.schemaVersion && bundle.configurationHash === graph.value.configurationHash &&
    bundle.canonicalContent === graph.json && bundle.contentHash === graph.sha256 &&
    bundle.nodeCount === graph.value.counts.nodes && bundle.edgeCount === graph.value.counts.edges &&
    bundle.nodes === JSON.stringify(graph.value.ccm.nodes) && bundle.edges === JSON.stringify(graph.value.ccm.edges);
}

function matchesDocument(
  row: {
    id: string;
    ownerUserId: string;
    analysisId: string;
    title: string;
    documentModelVersion: string;
    interfaceCatalog: unknown;
    softwareEngineeringDiagram: unknown;
    umlClassDiagram: unknown;
    canonicalContent: string | null;
    contentHash: string;
  },
  document: Extract<ReturnType<typeof projectArchitectureDocument>, { ok: true }>,
  ownerUserId: string,
  analysisId: string,
  expectedId: string,
): boolean {
  return row.id === expectedId && row.ownerUserId === ownerUserId && row.analysisId === analysisId &&
    row.canonicalContent === document.json && row.contentHash === document.sha256 &&
    row.title === document.value.title && row.documentModelVersion === document.value.schemaVersion &&
    row.interfaceCatalog === JSON.stringify(document.value.interfaceCatalog) &&
    row.softwareEngineeringDiagram === JSON.stringify(document.value.softwareEngineeringDiagram) &&
    row.umlClassDiagram === JSON.stringify(document.value.umlClassDiagram);
}

function safeLimitations(graph: Extract<ReturnType<typeof parseCanonicalCkg>, { ok: true }>): SafeLimitation[] {
  const files = graph.value.ccm.files;
  const excluded = files.filter(file => file.status === "excluded").length;
  const failed = files.filter(file => file.status === "failed").length;
  // Source-policy exclusions are surfaced with their own safe code below. They
  // also appear in CCM's general limitation list, so exclude those exact entries
  // from the model count to avoid reporting the same limitation twice.
  const excludedPaths = new Set(files.filter(file => file.status === "excluded").map(file => file.path));
  const model = graph.value.ccm.limitations.filter(limitation =>
    !(limitation.stage === "language detection" &&
      typeof limitation.path === "string" && excludedPaths.has(limitation.path) &&
      limitation.reason.startsWith("Source policy excluded this file (")),
  ).length + graph.value.counts.unresolvedEdges;
  const result: SafeLimitation[] = [];
  if (excluded > 0) result.push({ code: "SOURCE_FILES_EXCLUDED", stageKey: "LANGUAGE_DETECTION", affectedPartCount: excluded, safeExplanation: LIMITATION_EXPLANATIONS.SOURCE_FILES_EXCLUDED });
  if (failed > 0) result.push({ code: "SOURCE_FILES_FAILED", stageKey: "STATIC_ANALYSIS", affectedPartCount: failed, safeExplanation: LIMITATION_EXPLANATIONS.SOURCE_FILES_FAILED });
  if (model > 0) result.push({ code: "MODEL_LIMITATIONS", stageKey: "KNOWLEDGE_GRAPH", affectedPartCount: model, safeExplanation: LIMITATION_EXPLANATIONS.MODEL_LIMITATIONS });
  return result;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  const result = JSON.stringify(value);
  if (typeof result !== "string") throw new Error("Canonical result identity is not serializable.");
  return result;
}

function resultHash(
  target: AnalysisStageTargetContext,
  graph: Extract<ReturnType<typeof parseCanonicalCkg>, { ok: true }>,
  document: Extract<ReturnType<typeof projectArchitectureDocument>, { ok: true }>,
  limitations: readonly SafeLimitation[],
): string {
  const sourceFiles = graph.value.ccm.files.map(file => ({
    path: file.path,
    language: file.language,
    sha256: file.sha256,
    sizeBytes: file.sizeBytes,
    status: file.status,
  })).sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const payload = {
    schemaVersion: "sage-analysis-result-v1",
    target: {
      repositoryFullName: target.repositoryFullName,
      branchName: target.branchName,
      commitSha: target.commitSha.toLowerCase(),
      configurationHash: target.configurationHash,
      analyzerVersion: target.analyzerVersion,
      schemaVersion: target.schemaVersion,
    },
    sourceFiles,
    ckgSha256: graph.sha256,
    architectureDocumentSha256: document.sha256,
    limitations: limitations.map(({ code, stageKey, affectedPartCount }) => ({ code, stageKey, affectedPartCount })),
  };
  return sha256(stableJson(payload));
}

function assertSignal(signal: AbortSignal | undefined): void {
  signal?.throwIfAborted();
}

/** Atomically publish the immutable graph/document/source mirrors and finish the fenced job. */
export async function publishAnalysisResult(db: PrismaClient, input: PublishAnalysisResultInput): Promise<boolean> {
  const safe = snapshotInput(input);
  assertSignal(safe.signal);
  const graph = parseCanonicalCkg(safe.canonicalCkgJson, safe.sourceBytes, safe.expectedCkgSha256);
  if (!graph.ok || graph.sha256 !== safe.expectedCkgSha256 || graph.value.configurationHash !== safe.target.configurationHash ||
      graph.value.ccm.snapshot.repository !== safe.target.repositoryFullName ||
      graph.value.ccm.snapshot.branch !== safe.target.branchName ||
      graph.value.ccm.snapshot.commitSha.toLowerCase() !== safe.target.commitSha.toLowerCase()) {
    throw new Error("Canonical graph does not match its source or queued target.");
  }
  const document = projectArchitectureDocument(graph.json, safe.sourceBytes, graph.sha256);
  if (!document.ok || document.json !== safe.canonicalDocumentJson || document.sha256 !== safe.expectedDocumentSha256) {
    throw new Error("Canonical architecture document does not match its graph and source.");
  }
  if (safe.snapshot.files !== graph.value.ccm.files.length || safe.snapshot.extractedBytes !== graph.value.ccm.files.reduce((sum, file) => sum + file.sizeBytes, 0)) {
    throw new Error("Source archive manifest does not match canonical source files.");
  }
  const limitations = safeLimitations(graph);
  const terminalStatus = limitations.length === 0 ? "COMPLETED" : "COMPLETED_WITH_LIMITATIONS";
  const digest = resultHash(safe.target, graph, document, limitations);
  const tokenHash = sha256(safe.claim.leaseToken);

  try {
    return await db.$transaction(async tx => {
      assertSignal(safe.signal);
      const locked = await tx.$queryRaw<Array<{ slotKey: string }>>`
        SELECT "slotKey" FROM "WorkerSlot" WHERE "slotKey" = ${ANALYSIS_SLOT} FOR UPDATE
      `;
      if (locked.length !== 1) throw new AnalysisQueueInvariantError();
      if (!await hasCurrentLease(tx, safe.claim, tokenHash)) return false;

      const analysis = await tx.analysis.findFirst({
        where: { id: safe.claim.analysisId, ownerUserId: safe.claim.ownerUserId },
        select: {
          id: true, repositoryId: true, repositoryFullNameSnapshot: true, branchName: true, commitSha: true,
          configuration: true, configurationHash: true, analyzerVersion: true, schemaVersion: true, status: true,
          errorCode: true, resultHash: true,
        },
      });
      if (!analysis || analysis.status !== "RUNNING" || analysis.errorCode !== null || analysis.resultHash !== null ||
          analysis.id !== safe.target.analysisId || analysis.repositoryId !== safe.target.repositoryId ||
          analysis.repositoryFullNameSnapshot !== safe.target.repositoryFullName ||
          analysis.branchName !== safe.target.branchName || analysis.commitSha.toLowerCase() !== safe.target.commitSha.toLowerCase() ||
          analysis.configurationHash !== safe.target.configurationHash ||
          sha256(canonicalJson(analysis.configuration)) !== analysis.configurationHash ||
          canonicalJson(analysis.configuration) !== safe.configurationJson ||
          analysis.analyzerVersion !== safe.target.analyzerVersion || analysis.schemaVersion !== safe.target.schemaVersion) {
        throw new Error("Analysis target or configuration changed before publication.");
      }

      const stages = await tx.analysisStage.findMany({
        where: { analysisId: safe.claim.analysisId, ownerUserId: safe.claim.ownerUserId },
        orderBy: { sequence: "asc" },
        select: { sequence: true, key: true, status: true },
      });
      if (stages.length !== ANALYSIS_STAGE_DEFINITIONS.length || stages.some((stage, index) =>
        stage.sequence !== ANALYSIS_STAGE_DEFINITIONS[index]?.sequence ||
        stage.key !== ANALYSIS_STAGE_DEFINITIONS[index]?.key || stage.status !== "COMPLETED")) {
        throw new Error("All nine trusted analysis stages must complete before publication.");
      }

      const archive = await tx.storageObject.findFirst({
        where: {
          id: safe.snapshot.storageObjectId,
          ownerUserId: safe.claim.ownerUserId,
          analysisId: safe.claim.analysisId,
          type: "SOURCE_ARCHIVE",
          status: "ACTIVE",
        },
        select: { id: true, sha256: true, byteLength: true },
      });
      if (!archive || archive.sha256 !== safe.snapshot.archiveSha256 || archive.byteLength !== BigInt(safe.snapshot.archiveBytes)) {
        throw new Error("Stored source archive does not match the analyzed snapshot.");
      }

      const graphBundle = await tx.graphBundle.findUnique({
        where: { analysisId_ownerUserId: { analysisId: safe.claim.analysisId, ownerUserId: safe.claim.ownerUserId } },
        select: {
          id: true, ownerUserId: true, analysisId: true, schemaVersion: true, configurationHash: true,
          canonicalContent: true, nodes: true, edges: true, nodeCount: true, edgeCount: true, contentHash: true,
        },
      });
      if (!graphBundle || !matchesGraphBundle(graphBundle, graph, safe.claim.ownerUserId, safe.claim.analysisId, safe.graphBundleId)) {
        throw new Error("Stored graph bundle does not match the canonical result.");
      }

      const documentRow = await tx.architectureDocument.findUnique({
        where: { analysisId_ownerUserId: { analysisId: safe.claim.analysisId, ownerUserId: safe.claim.ownerUserId } },
        select: {
          id: true, ownerUserId: true, analysisId: true, title: true, documentModelVersion: true,
          interfaceCatalog: true, softwareEngineeringDiagram: true, umlClassDiagram: true,
          canonicalContent: true, contentHash: true,
        },
      });
      if (!documentRow || !matchesDocument(documentRow, document, safe.claim.ownerUserId, safe.claim.analysisId, safe.architectureDocumentId)) {
        throw new Error("Stored architecture document does not match the canonical result.");
      }

      const sourceFiles = graph.value.ccm.files.map(file => ({
        ownerUserId: safe.claim.ownerUserId,
        analysisId: safe.claim.analysisId,
        storageObjectId: archive.id,
        path: file.path,
        language: file.language,
        byteLength: BigInt(file.sizeBytes),
        sha256: file.sha256,
        processingStatus: file.status,
      }));
      const existingSourceFiles = await tx.sourceFile.findMany({
        where: { analysisId: safe.claim.analysisId, ownerUserId: safe.claim.ownerUserId },
        orderBy: { path: "asc" },
        select: { storageObjectId: true, path: true, language: true, byteLength: true, sha256: true, processingStatus: true },
      });
      if (existingSourceFiles.length > 0 && (existingSourceFiles.length !== sourceFiles.length || existingSourceFiles.some((row, index) => {
        const expected = sourceFiles[index];
        return !expected || row.storageObjectId !== expected.storageObjectId || row.path !== expected.path ||
          row.language !== expected.language || row.byteLength !== expected.byteLength ||
          row.sha256 !== expected.sha256 || row.processingStatus !== expected.processingStatus;
      }))) throw new Error("Stored source-file mirrors are immutable and do not match the canonical result.");

      const existingLimitations = await tx.analysisLimitation.findMany({
        where: { analysisId: safe.claim.analysisId, ownerUserId: safe.claim.ownerUserId },
        orderBy: { code: "asc" },
        select: { path: true, stageKey: true, code: true, safeExplanation: true, affectedPartCount: true },
      });
      const expectedLimitations = [...limitations].sort((left, right) => left.code.localeCompare(right.code));
      if (existingLimitations.length > 0 && (existingLimitations.length !== expectedLimitations.length || existingLimitations.some((row, index) => {
        const expected = expectedLimitations[index];
        return !expected || row.path !== null || row.stageKey !== expected.stageKey || row.code !== expected.code ||
          row.safeExplanation !== expected.safeExplanation || row.affectedPartCount !== expected.affectedPartCount;
      }))) throw new Error("Stored safe limitations do not match the canonical result.");

      assertSignal(safe.signal);
      if (existingSourceFiles.length === 0 && sourceFiles.length > 0) await tx.sourceFile.createMany({ data: sourceFiles });
      if (existingLimitations.length === 0 && expectedLimitations.length > 0) {
        await tx.analysisLimitation.createMany({
          data: expectedLimitations.map(item => ({
            ownerUserId: safe.claim.ownerUserId,
            analysisId: safe.claim.analysisId,
            path: null,
            stageKey: item.stageKey,
            code: item.code,
            safeExplanation: item.safeExplanation,
            affectedPartCount: item.affectedPartCount,
          })),
        });
      }
      assertSignal(safe.signal);
      if (!await hasCurrentLease(tx, safe.claim, tokenHash)) throw new PublicationLeaseLostError();

      const jobRows = await tx.$queryRaw<Array<{ id: string }>>`
        UPDATE "Job" AS job
        SET "status" = 'COMPLETED', "finishedAt" = clock_timestamp(), "errorCode" = NULL, "updatedAt" = clock_timestamp()
        WHERE job."id" = ${safe.claim.jobId} AND job."ownerUserId" = ${safe.claim.ownerUserId}
          AND job."analysisId" = ${safe.claim.analysisId} AND job."type" = 'ANALYSIS'
          AND job."status" = 'RUNNING' AND job."attempt" = ${safe.claim.attempt}
          AND job."leaseExpiresAt" > clock_timestamp()
          AND EXISTS (
            SELECT 1 FROM "WorkerSlot" AS slot
            WHERE slot."slotKey" = ${ANALYSIS_SLOT} AND slot."jobId" = job."id"
              AND slot."ownerUserId" = job."ownerUserId" AND slot."leaseTokenHash" = ${tokenHash}
              AND slot."leaseUntil" > clock_timestamp()
          )
        RETURNING job."id"
      `;
      if (jobRows.length !== 1) throw new PublicationLeaseLostError();

      const analysisRows = await tx.$queryRaw<Array<{ id: string }>>`
        UPDATE "Analysis" AS analysis
        SET "status" = ${terminalStatus}::"AnalysisStatus", "resultHash" = ${digest},
            "errorCode" = NULL, "completedAt" = clock_timestamp(), "updatedAt" = clock_timestamp()
        WHERE analysis."id" = ${safe.claim.analysisId} AND analysis."ownerUserId" = ${safe.claim.ownerUserId}
          AND analysis."status" = 'RUNNING' AND analysis."resultHash" IS NULL AND analysis."errorCode" IS NULL
          AND analysis."configurationHash" = ${safe.target.configurationHash}
          AND EXISTS (
            SELECT 1 FROM "Job" AS job
            JOIN "WorkerSlot" AS slot ON slot."jobId" = job."id" AND slot."ownerUserId" = job."ownerUserId"
            WHERE job."id" = ${safe.claim.jobId} AND job."ownerUserId" = ${safe.claim.ownerUserId}
              AND job."analysisId" = analysis."id" AND job."type" = 'ANALYSIS'
              AND job."status" = 'COMPLETED' AND job."attempt" = ${safe.claim.attempt}
              AND job."leaseExpiresAt" > clock_timestamp() AND slot."slotKey" = ${ANALYSIS_SLOT}
              AND slot."leaseTokenHash" = ${tokenHash} AND slot."leaseUntil" > clock_timestamp()
          )
        RETURNING analysis."id"
      `;
      if (analysisRows.length !== 1) throw new PublicationLeaseLostError();

      assertSignal(safe.signal);
      const released = await tx.$queryRaw<Array<{ slotKey: string }>>`
        UPDATE "WorkerSlot" AS slot
        SET "jobId" = NULL, "ownerUserId" = NULL, "leaseUntil" = NULL, "heartbeatAt" = NULL,
            "leaseTokenHash" = NULL, "updatedAt" = clock_timestamp()
        WHERE slot."slotKey" = ${ANALYSIS_SLOT} AND slot."jobId" = ${safe.claim.jobId}
          AND slot."ownerUserId" = ${safe.claim.ownerUserId} AND slot."leaseTokenHash" = ${tokenHash}
          AND slot."leaseUntil" > clock_timestamp()
          AND EXISTS (
            SELECT 1 FROM "Job" AS job
            JOIN "Analysis" AS analysis ON analysis."id" = job."analysisId" AND analysis."ownerUserId" = job."ownerUserId"
            WHERE job."id" = ${safe.claim.jobId} AND job."ownerUserId" = ${safe.claim.ownerUserId}
              AND job."analysisId" = ${safe.claim.analysisId} AND job."type" = 'ANALYSIS'
              AND job."status" = 'COMPLETED' AND job."attempt" = ${safe.claim.attempt}
              AND job."leaseExpiresAt" > clock_timestamp() AND analysis."status" = ${terminalStatus}
              AND analysis."resultHash" = ${digest}
          )
        RETURNING slot."slotKey"
      `;
      if (released.length !== 1) throw new PublicationLeaseLostError();
      return true;
    });
  } catch (error) {
    if (error instanceof PublicationLeaseLostError) return false;
    throw error;
  }
}
