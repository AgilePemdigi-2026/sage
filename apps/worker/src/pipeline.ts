import { readFileSync } from "node:fs";
import { canonicalizeCcm, parseCanonicalCkg } from "@sage/contracts";
import { projectArchitectureDocument } from "@sage/documents/model";
import { buildSemanticModel } from "@sage/documents/semantic";
import type { PrismaClient } from "../../../packages/database/generated/client.ts";
import { publishAnalysisResult } from "../../../packages/database/src/publication.ts";
import type { AnalysisJobClaim } from "../../../packages/database/src/queue.ts";
import { ANALYSIS_STAGE_DEFINITIONS } from "../../../packages/contracts/src/stages.ts";
import type { AnalysisStageKey, AnalysisStagesResult } from "../../../packages/contracts/src/stages.ts";
import { fetchRepositoryArchive } from "../../../packages/github/archive.ts";
import type { RepositoryArchiveInput } from "../../../packages/github/archive.ts";
import { createCkgStageHandlers } from "./ckg-handlers.ts";
import { createDocumentStageHandlers } from "./document-handlers.ts";
import { createSnapshotHandler } from "./snapshot/handler.ts";
import { parseSnapshotArchive } from "./snapshot/archive.ts";
import type { SnapshotFile } from "./snapshot/archive.ts";
import { readSnapshotArchive } from "./snapshot/storage.ts";
import { DEFAULT_MAX_SOURCE_FILE_BYTES, SOURCE_POLICY_VERSION, scanSnapshotSources } from "./source-analysis.ts";
import { createSourceStageHandlers } from "./source-handlers.ts";
import { runAnalysisStages } from "./stage-runner.ts";
import type { AnalysisStageArtifact, AnalysisStageContext, AnalysisStageHandler, AnalysisStageHandlers } from "./stage-runner.ts";

const analysisLimits = JSON.parse(readFileSync(new URL("../../../config/analysis-limits.json", import.meta.url), "utf8")) as unknown;
const ANALYSIS_TIMEOUT_MS = configuredAnalysisTimeout(analysisLimits);
const DOCUMENT_CONTEXT_FIELDS = [
  "analysisId", "repositoryId", "repositoryFullName", "repositoryVisibility", "branchName", "commitSha",
  "configurationHash", "analyzerVersion", "schemaVersion",
] as const;
const DOCUMENT_PARTS = {
  INTERFACE_CATALOG: "interfaceCatalog",
  SOFTWARE_ENGINEERING_DIAGRAM: "softwareEngineeringDiagram",
  UML_CLASS_DIAGRAM: "umlClassDiagram",
} as const;

export interface AnalysisPipelineOptions {
  readonly db: PrismaClient;
  readonly storageRoot: string;
  /** Trusted test seam for supplying a provider snapshot; production leaves this undefined. */
  readonly fetchArchive?: typeof fetchRepositoryArchive;
  readonly leaseDurationMs?: number;
}

export type AnalysisPipeline = (claim: AnalysisJobClaim, signal?: AbortSignal) => Promise<AnalysisStagesResult>;

function configuredAnalysisTimeout(input: unknown): number {
  if (typeof input !== "object" || input === null || Array.isArray(input) ||
      !("analysisTimeoutSeconds" in input) ||
      !Number.isSafeInteger(input.analysisTimeoutSeconds) ||
      (input.analysisTimeoutSeconds as number) < 1 || (input.analysisTimeoutSeconds as number) > 300) {
    throw new Error("config/analysis-limits.json contains an invalid whole-job deadline.");
  }
  return (input.analysisTimeoutSeconds as number) * 1_000;
}

function safeRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null) && Reflect.ownKeys(value).every(key => {
    if (typeof key !== "string") return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return !!descriptor && descriptor.enumerable && "value" in descriptor;
  });
}

function hasExactFields(value: unknown, fields: readonly string[]): value is Record<string, unknown> {
  if (!safeRecord(value)) return false;
  const keys = Reflect.ownKeys(value);
  return keys.length === fields.length && keys.every(key => typeof key === "string" && fields.includes(key));
}

function sameJson(left: unknown, right: unknown): boolean {
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

function requiredArtifact(context: AnalysisStageContext, key: AnalysisStageKey): AnalysisStageArtifact {
  const value = context.previousStages[key];
  if (value === undefined) throw new Error(`Required trusted output ${key} is missing.`);
  return value;
}

function sourceLimit(configuration: unknown): number {
  if (!safeRecord(configuration)) throw new Error("Queued source configuration is invalid.");
  const version = configuration.sourcePolicyVersion;
  const limit = configuration.maxSourceFileBytes;
  if (version === undefined && limit === undefined) return DEFAULT_MAX_SOURCE_FILE_BYTES;
  if (version !== SOURCE_POLICY_VERSION || typeof limit !== "number" || !Number.isSafeInteger(limit) ||
      limit <= 0 || limit > DEFAULT_MAX_SOURCE_FILE_BYTES) throw new Error("Queued source configuration is invalid.");
  return limit;
}

function sourceBytes(files: readonly SnapshotFile[]): Record<string, Uint8Array> {
  return Object.fromEntries(files.map(file => [file.relativePath, new Uint8Array(file.bytes)]));
}

function verifiedSourceReport(
  files: readonly SnapshotFile[],
  maxSourceFileBytes: number,
  ccm: Extract<ReturnType<typeof canonicalizeCcm>, { ok: true }>,
): ReturnType<typeof scanSnapshotSources> {
  const report = scanSnapshotSources(files, { maxSourceFileBytes });
  const byPath = new Map(ccm.value.files.map(file => [file.path, file] as const));
  for (const language of Object.keys(report.counts.languages) as Array<keyof typeof report.counts.languages>) {
    report.counts.languages[language].processed = 0;
    report.counts.languages[language].failed = 0;
  }
  report.counts.processed = 0;
  report.counts.failed = 0;
  for (const file of report.files) {
    if (file.status !== "eligible" || !file.language) continue;
    const ccmFile = byPath.get(file.path);
    if (!ccmFile || ccmFile.language !== file.language) throw new Error("Canonical source file does not match the source policy.");
    if (ccmFile?.status === "processed") {
      report.counts.processed += 1;
      report.counts.languages[file.language].processed += 1;
    } else if (ccmFile?.status === "failed") {
      report.counts.failed += 1;
      report.counts.languages[file.language].failed += 1;
    } else {
      throw new Error("Canonical source status does not match the source policy.");
    }
  }
  return report;
}

function expectedStaticStatus(
  report: ReturnType<typeof scanSnapshotSources>,
  ccm: Extract<ReturnType<typeof canonicalizeCcm>, { ok: true }>,
): "complete" | "partial" {
  if (report.counts.processed < 1) throw new Error("No source file was processed successfully.");
  return report.counts.failed > 0 || report.counts.excluded > 0 || ccm.value.limitations.length > 0 ||
    ccm.value.edges.some(edge => edge.resolution === "Unresolved") ? "partial" : "complete";
}

function documentContext(context: AnalysisStageContext): Record<string, unknown> {
  const target = context.target as unknown as Record<string, unknown>;
  return Object.fromEntries(DOCUMENT_CONTEXT_FIELDS.map(key => [key, target[key]]));
}

function verifyDocumentStageArtifacts(
  context: AnalysisStageContext,
  ckgSha256: string,
  document: Extract<ReturnType<typeof projectArchitectureDocument>, { ok: true }>,
): void {
  const stageContext = documentContext(context);
  for (const key of Object.keys(DOCUMENT_PARTS) as Array<keyof typeof DOCUMENT_PARTS>) {
    const value = requiredArtifact(context, key);
    const expectedFields = ["kind", "artifact", "ckgSha256", "documentSha256", "context"];
    if (!hasExactFields(value, expectedFields) || value.kind !== key || value.ckgSha256 !== ckgSha256 ||
        value.documentSha256 !== document.sha256 || !sameJson(value.context, stageContext) ||
        !sameJson(value.artifact, document.value[DOCUMENT_PARTS[key]])) {
      throw new Error(`Trusted ${key} output does not match the canonical document.`);
    }
  }
}

async function publishFromStages(
  db: PrismaClient,
  storageRoot: string,
  claim: AnalysisJobClaim,
  context: AnalysisStageContext,
  signal: AbortSignal,
): Promise<boolean> {
  signal.throwIfAborted();
  const snapshot = context.sourceSnapshot;
  if (!hasExactFields(snapshot, ["storageObjectId", "archiveSha256", "archiveBytes", "commitSha", "files", "extractedBytes"]) ||
      typeof snapshot.storageObjectId !== "string" || typeof snapshot.archiveSha256 !== "string" ||
      typeof snapshot.archiveBytes !== "number" || typeof snapshot.files !== "number" ||
      typeof snapshot.extractedBytes !== "number" || snapshot.commitSha !== context.target.commitSha) {
    throw new Error("Trusted source snapshot output is invalid.");
  }
  const archive = await readSnapshotArchive(db, {
    storageRoot,
    ownerUserId: claim.ownerUserId,
    analysisId: claim.analysisId,
    storageObjectId: snapshot.storageObjectId,
  });
  signal.throwIfAborted();
  const parsed = await parseSnapshotArchive(archive, { signal });
  if (parsed.archiveSha256 !== snapshot.archiveSha256 || parsed.byteLength !== snapshot.archiveBytes ||
      parsed.files.length !== snapshot.files || parsed.extractedBytes !== snapshot.extractedBytes) {
    throw new Error("Trusted source snapshot metadata does not match the stored archive.");
  }
  const bytes = sourceBytes(parsed.files);
  const maxSourceFileBytes = sourceLimit(context.configuration);
  const languageArtifact = requiredArtifact(context, "LANGUAGE_DETECTION");
  const staticArtifact = requiredArtifact(context, "STATIC_ANALYSIS");
  const commonArtifact = requiredArtifact(context, "COMMON_CODE_MODEL");
  const graphArtifact = requiredArtifact(context, "KNOWLEDGE_GRAPH");
  const documentArtifact = requiredArtifact(context, "ARCHITECTURE_DOCUMENT");

  const sourceReport = scanSnapshotSources(parsed.files, { maxSourceFileBytes });
  if (!sameJson(sourceReport, languageArtifact)) throw new Error("Language-detection output does not match the stored source snapshot.");
  if (!hasExactFields(staticArtifact, ["status", "report", "ccm", "contentSha256", "diagnostics"]) ||
      typeof staticArtifact.contentSha256 !== "string" || typeof staticArtifact.status !== "string") {
    throw new Error("Trusted static-analysis output is invalid.");
  }
  const staticCcm = canonicalizeCcm(staticArtifact.ccm, bytes);
  if (!staticCcm.ok || staticCcm.sha256 !== staticArtifact.contentSha256) throw new Error("Static-analysis CCM is not canonical for the stored source.");
  const staticReport = verifiedSourceReport(parsed.files, maxSourceFileBytes, staticCcm);
  const staticStatus = expectedStaticStatus(staticReport, staticCcm);
  if (!sameJson(staticReport, staticArtifact.report) || staticArtifact.status !== staticStatus) {
    throw new Error("Static-analysis report does not match its canonical source model.");
  }

  if (!hasExactFields(commonArtifact, ["ccm", "contentSha256"]) || typeof commonArtifact.contentSha256 !== "string") {
    throw new Error("Trusted common-code-model output is invalid.");
  }
  const commonCcm = canonicalizeCcm(commonArtifact.ccm, bytes);
  if (!commonCcm.ok || commonCcm.sha256 !== commonArtifact.contentSha256 ||
      commonCcm.json !== staticCcm.json || commonCcm.sha256 !== staticCcm.sha256) {
    throw new Error("Common code model does not match the static-analysis result.");
  }

  if (!hasExactFields(graphArtifact, ["graph", "contentSha256", "graphBundleId"]) ||
      typeof graphArtifact.contentSha256 !== "string" || typeof graphArtifact.graphBundleId !== "string") {
    throw new Error("Trusted knowledge-graph output is invalid.");
  }
  const graphJson = JSON.stringify(graphArtifact.graph);
  if (typeof graphJson !== "string") throw new Error("Trusted knowledge-graph output is not serializable.");
  const graph = parseCanonicalCkg(graphJson, bytes, graphArtifact.contentSha256);
  if (!graph.ok) throw new Error("Knowledge graph is not canonical for the source snapshot.");
  const graphCcm = canonicalizeCcm(graph.value.ccm, bytes);
  if (graph.value.ccm.snapshot.repository !== context.target.repositoryFullName ||
      graph.value.ccm.snapshot.branch !== context.target.branchName ||
      graph.value.ccm.snapshot.commitSha.toLowerCase() !== context.target.commitSha.toLowerCase() ||
      graph.value.configurationHash !== context.target.configurationHash ||
      !graphCcm.ok || graphCcm.sha256 !== commonCcm.sha256 || graphCcm.json !== commonCcm.json) {
    throw new Error("Knowledge graph does not match its common code model or queued target.");
  }

  const document = projectArchitectureDocument(graph.json, bytes, graph.sha256);
  if (!document.ok) throw new Error("Architecture document cannot be projected from the canonical graph.");
  verifyDocumentStageArtifacts(context, graph.sha256, document);
  if (!hasExactFields(documentArtifact, ["document", "canonicalJson", "documentId", "contentHash", "ckgSha256", "documentSha256", "context"]) ||
      typeof documentArtifact.documentId !== "string" || typeof documentArtifact.canonicalJson !== "string" ||
      documentArtifact.canonicalJson !== document.json || documentArtifact.contentHash !== document.sha256 ||
      documentArtifact.documentSha256 !== document.sha256 || documentArtifact.ckgSha256 !== graph.sha256 ||
      !sameJson(documentArtifact.document, document.value) || !sameJson(documentArtifact.context, documentContext(context))) {
    throw new Error("Trusted architecture-document output does not match its canonical graph.");
  }
  const semanticModel = buildSemanticModel({ ccm: graph.value.ccm, sourceCkgHash: graph.sha256, sources: bytes });
  signal.throwIfAborted();
  return publishAnalysisResult(db, {
    claim,
    target: context.target,
    configuration: context.configuration,
    snapshot: snapshot as unknown as {
      storageObjectId: string;
      archiveSha256: string;
      archiveBytes: number;
      commitSha: string;
      files: number;
      extractedBytes: number;
    },
    sourceBytes: bytes,
    canonicalCkgJson: graph.json,
    expectedCkgSha256: graph.sha256,
    graphBundleId: graphArtifact.graphBundleId,
    canonicalDocumentJson: document.json,
    expectedDocumentSha256: document.sha256,
    architectureDocumentId: documentArtifact.documentId,
    semanticModel,
    signal,
  });
}

/** Compose the fixed nine trusted production stages and terminal publisher for a claimed job. */
export function createAnalysisPipeline(options: AnalysisPipelineOptions): AnalysisPipeline {
  if (!options || typeof options !== "object" || !options.db || typeof options.storageRoot !== "string" || !options.storageRoot.trim()) {
    throw new Error("Analysis pipeline requires a database and private snapshot storage root.");
  }
  if (options.fetchArchive !== undefined && typeof options.fetchArchive !== "function") throw new Error("Trusted archive provider is invalid.");
  return async (claim, signal) => {
    const snapshotOptions = {
      claim,
      storageRoot: options.storageRoot,
      db: options.db,
      ...(options.fetchArchive ? { fetchArchive: options.fetchArchive as typeof fetchRepositoryArchive } : {}),
    };
    const handlers: AnalysisStageHandlers = {
      SNAPSHOT: createSnapshotHandler(snapshotOptions),
      ...createSourceStageHandlers({ claim, storageRoot: options.storageRoot, db: options.db }),
      ...createCkgStageHandlers({ claim, storageRoot: options.storageRoot, db: options.db }),
      ...createDocumentStageHandlers({ claim, storageRoot: options.storageRoot, db: options.db }),
    } as Readonly<Record<AnalysisStageKey, AnalysisStageHandler>>;
    if (Object.keys(handlers).length !== ANALYSIS_STAGE_DEFINITIONS.length) throw new Error("Trusted stage composition is incomplete.");
    return runAnalysisStages(options.db, claim, handlers, {
      signal,
      leaseDurationMs: options.leaseDurationMs,
      executionTimeoutMs: ANALYSIS_TIMEOUT_MS,
      externalAbortFailureCode: "WORKER_INTERRUPTED",
      publish: (context, publishSignal) => publishFromStages(options.db, options.storageRoot, claim, context, publishSignal),
    });
  };
}

export type { RepositoryArchiveInput };
