import { database } from "@sage/database";
import type { PrismaClient } from "../../../packages/database/generated/client.ts";
import { snapshotAnalysisJobClaim, type AnalysisJobClaim } from "../../../packages/database/src/queue.ts";
import { parseSnapshotArchive } from "./snapshot/archive.ts";
import { readSnapshotArchive } from "./snapshot/storage.ts";
import { AnalysisStageExecutionError, type AnalysisStageContext, type AnalysisStageHandler, type AnalysisStageArtifact } from "./stage-runner.ts";
import { scanSnapshotSources, analyzeSnapshotSources, SOURCE_POLICY_VERSION, DEFAULT_MAX_SOURCE_FILE_BYTES } from "./source-analysis.ts";

/** These handlers consume an owner-bound stored snapshot; the full consumer is composed separately. */
export function createSourceStageHandlers(options: { claim: AnalysisJobClaim; storageRoot: string; db?: PrismaClient }): { LANGUAGE_DETECTION: AnalysisStageHandler; STATIC_ANALYSIS: AnalysisStageHandler } {
  const claim = snapshotAnalysisJobClaim(options.claim);
  function sourceLimit(context: AnalysisStageContext): number {
    const configuration = context.configuration;
    if (!configuration || typeof configuration !== "object" || Array.isArray(configuration)) throw new AnalysisStageExecutionError("SNAPSHOT_INVALID");
    const fields = configuration as Readonly<Record<string, unknown>>;
    const version = fields.sourcePolicyVersion;
    const limit = fields.maxSourceFileBytes;
    // Records queued before ANA-02 have neither policy field and retain the original ceiling.
    if (version === undefined && limit === undefined) return DEFAULT_MAX_SOURCE_FILE_BYTES;
    if (version !== SOURCE_POLICY_VERSION || typeof limit !== "number" || !Number.isSafeInteger(limit) || limit <= 0 || limit > DEFAULT_MAX_SOURCE_FILE_BYTES) throw new AnalysisStageExecutionError("SNAPSHOT_INVALID");
    return limit;
  }
  async function load(context: AnalysisStageContext, signal: AbortSignal) {
    signal.throwIfAborted();
    const snapshot = context.sourceSnapshot;
    if (context.target.analysisId !== claim.analysisId || !snapshot || typeof snapshot !== "object" || !("storageObjectId" in snapshot) || typeof snapshot.storageObjectId !== "string" || !("commitSha" in snapshot) || snapshot.commitSha !== context.target.commitSha) throw new AnalysisStageExecutionError("SNAPSHOT_INVALID");
    try {
      const bytes = await readSnapshotArchive(options.db ?? database(), { storageRoot: options.storageRoot, ownerUserId: claim.ownerUserId, analysisId: claim.analysisId, storageObjectId: snapshot.storageObjectId });
      return await parseSnapshotArchive(bytes, { signal });
    } catch { signal.throwIfAborted(); throw new AnalysisStageExecutionError("SNAPSHOT_INVALID"); }
  }
  return {
    async LANGUAGE_DETECTION(context, signal) {
      const maxSourceFileBytes = sourceLimit(context);
      const parsed = await load(context, signal);
      const result = scanSnapshotSources(parsed.files, { maxSourceFileBytes });
      signal.throwIfAborted();
      if (result.status === "failed") throw new AnalysisStageExecutionError(result.errorCode === "NO_SUPPORTED_SOURCE" ? "NO_SUPPORTED_SOURCE" : "SNAPSHOT_INVALID");
      return JSON.parse(JSON.stringify(result)) as AnalysisStageArtifact;
    },
    async STATIC_ANALYSIS(context, signal) {
      const maxSourceFileBytes = sourceLimit(context);
      const parsed = await load(context, signal);
      const result = await analyzeSnapshotSources({ snapshot: { repository: context.target.repositoryFullName, branch: context.target.branchName, commitSha: context.target.commitSha }, files: parsed.files, signal, maxSourceFileBytes });
      signal.throwIfAborted();
      if (result.status === "failed") throw new AnalysisStageExecutionError(result.errorCode === "NO_SUPPORTED_SOURCE" ? "NO_SUPPORTED_SOURCE" : result.errorCode === "SNAPSHOT_INVALID" || result.errorCode === "INVALID_LIMITS" ? "SNAPSHOT_INVALID" : "PARSE_FAILED");
      return JSON.parse(JSON.stringify({ status: result.status, report: result.report, ccm: result.ccm, contentSha256: result.contentSha256, diagnostics: result.diagnostics })) as AnalysisStageArtifact;
    },
  };
}
