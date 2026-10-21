import { createHash } from "node:crypto";
import { canonicalizeCcm, parseCanonicalCkg } from "@sage/contracts";
import { database, persistCanonicalDocument } from "@sage/database";
import type { PrismaClient } from "../../../packages/database/generated/client.ts";
import { snapshotAnalysisJobClaim, type AnalysisJobClaim } from "../../../packages/database/src/queue.ts";
import type { AnalysisStageTargetContext } from "../../../packages/database/src/stages.ts";
import { projectArchitectureDocument } from "@sage/documents/model";
import { parseSnapshotArchive } from "./snapshot/archive.ts";
import { readSnapshotArchive } from "./snapshot/storage.ts";
import {
  AnalysisStageExecutionError,
  type AnalysisStageArtifact,
  type AnalysisStageContext,
  type AnalysisStageHandler,
} from "./stage-runner.ts";

type DocumentPartKey = "interfaceCatalog" | "softwareEngineeringDiagram" | "umlClassDiagram";
type DocumentStageKey = "INTERFACE_CATALOG" | "SOFTWARE_ENGINEERING_DIAGRAM" | "UML_CLASS_DIAGRAM";

interface DocumentArtifactContext {
  analysisId: string;
  repositoryId: string;
  repositoryFullName: string;
  repositoryVisibility: AnalysisStageTargetContext["repositoryVisibility"];
  branchName: string;
  commitSha: string;
  configurationHash: string;
  analyzerVersion: string;
  schemaVersion: string;
}

const SHA256 = /^[a-f0-9]{64}$/;
const MAX_CONFIGURATION_BYTES = 1_048_576;
type CanonicalJsonValue = null | string | boolean | number | CanonicalJsonValue[] | { [key: string]: CanonicalJsonValue };
const DOCUMENT_PARTS: Readonly<Record<DocumentStageKey, DocumentPartKey>> = {
  INTERFACE_CATALOG: "interfaceCatalog",
  SOFTWARE_ENGINEERING_DIAGRAM: "softwareEngineeringDiagram",
  UML_CLASS_DIAGRAM: "umlClassDiagram",
};

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isRecordWithExactFields(value: unknown, fields: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const keys = Reflect.ownKeys(value);
  return keys.length === fields.length && keys.every(key => typeof key === "string" && fields.includes(key)) &&
    keys.every(key => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return !!descriptor && descriptor.enumerable && "value" in descriptor;
    });
}

function canonicalConfigurationHash(configuration: unknown): string | null {
  if (typeof configuration !== "object" || configuration === null || Array.isArray(configuration)) return null;
  try {
    const active = new Set<object>();
    let nodeCount = 0;
    const normalize = (value: unknown, depth: number): CanonicalJsonValue => {
      nodeCount += 1;
      if (nodeCount > 20_000 || depth > 64) throw new Error("Konfigurasi tahap terlalu kompleks.");
      if (value === null || typeof value === "string" || typeof value === "boolean") return value;
      if (typeof value === "number") {
        if (!Number.isFinite(value)) throw new Error("Konfigurasi tahap memuat angka yang tidak valid.");
        return Object.is(value, -0) ? 0 : value;
      }
      if (typeof value !== "object" || active.has(value)) throw new Error("Konfigurasi tahap tidak valid.");
      active.add(value);
      try {
        if (Array.isArray(value)) {
          if (Object.getPrototypeOf(value) !== Array.prototype || value.length > 20_000) throw new Error("Array konfigurasi tahap tidak valid.");
          const keys = Reflect.ownKeys(value);
          if (keys.some(key => typeof key !== "string" || (key !== "length" && !/^(0|[1-9]\d*)$/.test(key)))) {
            throw new Error("Array konfigurasi tahap tidak valid.");
          }
          const result: CanonicalJsonValue[] = [];
          for (let index = 0; index < value.length; index += 1) {
            const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
            if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) throw new Error("Array konfigurasi tahap tidak valid.");
            result.push(normalize(descriptor.value, depth + 1));
          }
          return result;
        }
        const prototype = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null) throw new Error("Object konfigurasi tahap tidak valid.");
        const keys = Reflect.ownKeys(value);
        if (keys.some(key => typeof key !== "string")) throw new Error("Konfigurasi tahap tidak valid.");
        const result: Record<string, CanonicalJsonValue> = Object.create(null) as Record<string, CanonicalJsonValue>;
        for (const key of (keys as string[]).sort()) {
          const descriptor = Object.getOwnPropertyDescriptor(value, key);
          if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) throw new Error("Object konfigurasi tahap tidak valid.");
          result[key] = normalize(descriptor.value, depth + 1);
        }
        return result;
      } finally {
        active.delete(value);
      }
    };
    const json = JSON.stringify(normalize(configuration, 0));
    if (typeof json !== "string") return null;
    if (Buffer.byteLength(json, "utf8") > MAX_CONFIGURATION_BYTES) return null;
    return sha256(json);
  } catch {
    return null;
  }
}

function stageContext(target: AnalysisStageTargetContext): DocumentArtifactContext {
  return {
    analysisId: target.analysisId,
    repositoryId: target.repositoryId,
    repositoryFullName: target.repositoryFullName,
    repositoryVisibility: target.repositoryVisibility,
    branchName: target.branchName,
    commitSha: target.commitSha,
    configurationHash: target.configurationHash,
    analyzerVersion: target.analyzerVersion,
    schemaVersion: target.schemaVersion,
  };
}

function sameJson(left: unknown, right: unknown): boolean {
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

function invalidSnapshot(): never {
  throw new AnalysisStageExecutionError("SNAPSHOT_INVALID");
}

/** Re-read the owner-bound stored snapshot for every document stage invocation. */
async function readSourceBytes(
  context: AnalysisStageContext,
  signal: AbortSignal,
  claim: AnalysisJobClaim,
  db: PrismaClient,
  storageRoot: string,
): Promise<Readonly<Record<string, Uint8Array>>> {
  signal.throwIfAborted();
  const snapshot = context.sourceSnapshot;
  if (context.target.analysisId !== claim.analysisId ||
      !snapshot || !isRecordWithExactFields(snapshot, ["storageObjectId", "archiveSha256", "archiveBytes", "commitSha", "files", "extractedBytes"]) ||
      typeof snapshot.storageObjectId !== "string" || snapshot.storageObjectId.length === 0 ||
      typeof snapshot.archiveSha256 !== "string" || !SHA256.test(snapshot.archiveSha256) ||
      typeof snapshot.archiveBytes !== "number" || !Number.isSafeInteger(snapshot.archiveBytes) || snapshot.archiveBytes <= 0 ||
      typeof snapshot.files !== "number" || !Number.isSafeInteger(snapshot.files) || snapshot.files < 0 ||
      typeof snapshot.extractedBytes !== "number" || !Number.isSafeInteger(snapshot.extractedBytes) || snapshot.extractedBytes < 0 ||
      typeof snapshot.commitSha !== "string" || snapshot.commitSha !== context.target.commitSha) {
    invalidSnapshot();
  }
  try {
    const archive = await readSnapshotArchive(db, {
      storageRoot,
      ownerUserId: claim.ownerUserId,
      analysisId: claim.analysisId,
      storageObjectId: snapshot.storageObjectId,
    });
    if (snapshot.archiveBytes !== archive.byteLength || createHash("sha256").update(archive).digest("hex") !== snapshot.archiveSha256) {
      invalidSnapshot();
    }
    const parsed = await parseSnapshotArchive(archive, { signal });
    if (parsed.files.length !== snapshot.files || parsed.extractedBytes !== snapshot.extractedBytes) invalidSnapshot();
    signal.throwIfAborted();
    return Object.fromEntries(parsed.files.map(file => [file.relativePath, file.bytes]));
  } catch {
    signal.throwIfAborted();
    invalidSnapshot();
  }
}

interface ValidatedDocumentInput {
  readonly ckgJson: string;
  readonly ckgSha256: string;
  readonly sourceBytes: Readonly<Record<string, Uint8Array>>;
  readonly document: Extract<ReturnType<typeof projectArchitectureDocument>, { ok: true }>;
  readonly context: DocumentArtifactContext;
}

/** Revalidate the complete stage-5 graph and project the same canonical document on every stage. */
async function validateDocumentInput(
  context: AnalysisStageContext,
  signal: AbortSignal,
  claim: AnalysisJobClaim,
  db: PrismaClient,
  storageRoot: string,
): Promise<ValidatedDocumentInput> {
  const sourceBytes = await readSourceBytes(context, signal, claim, db, storageRoot);
  signal.throwIfAborted();
  const target = context.target;
  const configurationHash = canonicalConfigurationHash(context.configuration);
  if (!configurationHash || !SHA256.test(target.configurationHash) || configurationHash !== target.configurationHash) {
    invalidSnapshot();
  }

  const commonArtifact = context.previousStages.COMMON_CODE_MODEL;
  if (!isRecordWithExactFields(commonArtifact, ["ccm", "contentSha256"]) || typeof commonArtifact.contentSha256 !== "string") {
    invalidSnapshot();
  }
  const canonicalCcm = canonicalizeCcm(commonArtifact.ccm, sourceBytes);
  if (!canonicalCcm.ok || canonicalCcm.sha256 !== commonArtifact.contentSha256 ||
      canonicalCcm.value.snapshot.repository !== target.repositoryFullName ||
      canonicalCcm.value.snapshot.branch !== target.branchName ||
      canonicalCcm.value.snapshot.commitSha !== target.commitSha) {
    invalidSnapshot();
  }

  const graphArtifact = context.previousStages.KNOWLEDGE_GRAPH;
  if (!isRecordWithExactFields(graphArtifact, ["graph", "contentSha256", "graphBundleId"]) ||
      typeof graphArtifact.contentSha256 !== "string" || !SHA256.test(graphArtifact.contentSha256) ||
      typeof graphArtifact.graphBundleId !== "string" || graphArtifact.graphBundleId.trim().length === 0) {
    invalidSnapshot();
  }
  let ckgJson: string;
  try {
    ckgJson = JSON.stringify(graphArtifact.graph);
  } catch {
    invalidSnapshot();
  }
  if (typeof ckgJson !== "string") invalidSnapshot();
  const ckg = parseCanonicalCkg(ckgJson, sourceBytes, graphArtifact.contentSha256);
  const graphCcm = ckg.ok ? canonicalizeCcm(ckg.value.ccm, sourceBytes) : null;
  if (!ckg.ok || ckg.value.configurationHash !== target.configurationHash ||
      ckg.value.ccm.snapshot.repository !== target.repositoryFullName ||
      ckg.value.ccm.snapshot.branch !== target.branchName ||
      ckg.value.ccm.snapshot.commitSha !== target.commitSha ||
      !graphCcm?.ok || canonicalCcm.sha256 !== graphCcm.sha256 ||
      !sameJson(canonicalCcm.value, ckg.value.ccm)) {
    invalidSnapshot();
  }

  const document = projectArchitectureDocument(ckg.json, sourceBytes, ckg.sha256);
  if (!document.ok || document.value.configurationHash !== target.configurationHash ||
      document.value.snapshot.repository !== target.repositoryFullName ||
      document.value.snapshot.branch !== target.branchName ||
      document.value.snapshot.commitSha !== target.commitSha ||
      document.value.ckgSha256 !== ckg.sha256) {
    invalidSnapshot();
  }
  signal.throwIfAborted();
  return { ckgJson: ckg.json, ckgSha256: ckg.sha256, sourceBytes, document, context: stageContext(target) };
}

function stageArtifact(
  key: DocumentStageKey,
  input: ValidatedDocumentInput,
): AnalysisStageArtifact {
  const part = DOCUMENT_PARTS[key];
  return JSON.parse(JSON.stringify({
    kind: key,
    artifact: input.document.value[part],
    ckgSha256: input.ckgSha256,
    documentSha256: input.document.sha256,
    context: input.context,
  })) as AnalysisStageArtifact;
}

function verifyStageArtifact(
  input: ValidatedDocumentInput,
  key: DocumentStageKey,
  candidate: unknown,
): void {
  if (!isRecordWithExactFields(candidate, ["kind", "artifact", "ckgSha256", "documentSha256", "context"]) ||
      candidate.kind !== key || candidate.ckgSha256 !== input.ckgSha256 ||
      candidate.documentSha256 !== input.document.sha256 ||
      !sameJson(candidate.context, input.context) ||
      !sameJson(candidate.artifact, input.document.value[DOCUMENT_PARTS[key]])) {
    invalidSnapshot();
  }
}

function verifyPriorArtifacts(input: ValidatedDocumentInput, context: AnalysisStageContext, keys: readonly DocumentStageKey[]): void {
  for (const key of keys) {
    const candidate = context.previousStages[key];
    verifyStageArtifact(input, key, candidate);
  }
}

/** Adds document projection stages 6–9; terminal analysis/job publication remains separate. */
export function createDocumentStageHandlers(options: {
  claim: AnalysisJobClaim;
  storageRoot: string;
  db?: PrismaClient;
}): {
  INTERFACE_CATALOG: AnalysisStageHandler;
  SOFTWARE_ENGINEERING_DIAGRAM: AnalysisStageHandler;
  UML_CLASS_DIAGRAM: AnalysisStageHandler;
  ARCHITECTURE_DOCUMENT: AnalysisStageHandler;
} {
  const claim = snapshotAnalysisJobClaim(options.claim);
  const db = options.db;
  async function load(context: AnalysisStageContext, signal: AbortSignal) {
    return validateDocumentInput(context, signal, claim, db ?? database(), options.storageRoot);
  }

  return {
    async INTERFACE_CATALOG(context, signal) {
      const input = await load(context, signal);
      signal.throwIfAborted();
      return stageArtifact("INTERFACE_CATALOG", input);
    },
    async SOFTWARE_ENGINEERING_DIAGRAM(context, signal) {
      const input = await load(context, signal);
      verifyPriorArtifacts(input, context, ["INTERFACE_CATALOG"]);
      signal.throwIfAborted();
      return stageArtifact("SOFTWARE_ENGINEERING_DIAGRAM", input);
    },
    async UML_CLASS_DIAGRAM(context, signal) {
      const input = await load(context, signal);
      verifyPriorArtifacts(input, context, ["INTERFACE_CATALOG", "SOFTWARE_ENGINEERING_DIAGRAM"]);
      signal.throwIfAborted();
      return stageArtifact("UML_CLASS_DIAGRAM", input);
    },
    async ARCHITECTURE_DOCUMENT(context, signal) {
      const input = await load(context, signal);
      verifyPriorArtifacts(input, context, ["INTERFACE_CATALOG", "SOFTWARE_ENGINEERING_DIAGRAM", "UML_CLASS_DIAGRAM"]);
      signal.throwIfAborted();
      const stored = await persistCanonicalDocument(db ?? database(), {
        claim,
        canonicalCkgJson: input.ckgJson,
        sourceBytes: input.sourceBytes,
        expectedCkgSha256: input.ckgSha256,
      });
      signal.throwIfAborted();
      if (!stored || typeof stored.id !== "string" || stored.id.trim().length === 0 || stored.contentHash !== input.document.sha256) {
        throw new Error("Persistensi architecture document tidak dikonfirmasi.");
      }
      return JSON.parse(JSON.stringify({
        document: input.document.value,
        canonicalJson: input.document.json,
        documentId: stored.id,
        contentHash: stored.contentHash,
        ckgSha256: input.ckgSha256,
        documentSha256: input.document.sha256,
        context: input.context,
      })) as AnalysisStageArtifact;
    },
  };
}
