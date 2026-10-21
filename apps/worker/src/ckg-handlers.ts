import { canonicalizeCcm, canonicalizeCkg, type CanonicalCcmResult } from "@sage/contracts";
import { database, persistCanonicalGraph } from "@sage/database";
import type { PrismaClient } from "../../../packages/database/generated/client.ts";
import { snapshotAnalysisJobClaim, type AnalysisJobClaim } from "../../../packages/database/src/queue.ts";
import type { AnalysisStageTargetContext } from "../../../packages/database/src/stages.ts";
import { parseSnapshotArchive } from "./snapshot/archive.ts";
import { readSnapshotArchive } from "./snapshot/storage.ts";
import { AnalysisStageExecutionError, type AnalysisStageArtifact, type AnalysisStageContext, type AnalysisStageHandler } from "./stage-runner.ts";

/** Revalidate the serialized adapter artifact against immutable source and its queued target. */
export function canonicalizeStageCcm(
  artifact: unknown,
  sourceBytes: Readonly<Record<string, Uint8Array>>,
  target: AnalysisStageTargetContext,
): Extract<CanonicalCcmResult, { ok: true }> {
  if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) throw new AnalysisStageExecutionError("SNAPSHOT_INVALID");
  const fields = artifact as Record<string, unknown>;
  const canonical = canonicalizeCcm(fields.ccm, sourceBytes);
  if (!canonical.ok || canonical.sha256 !== fields.contentSha256 ||
      canonical.value.snapshot.repository !== target.repositoryFullName ||
      canonical.value.snapshot.branch !== target.branchName || canonical.value.snapshot.commitSha !== target.commitSha) {
    throw new AnalysisStageExecutionError("SNAPSHOT_INVALID");
  }
  return canonical;
}

/** Adds stages 4/5 only; later handlers and atomic result publication belong to ANA-07. */
export function createCkgStageHandlers(options: {
  claim: AnalysisJobClaim; storageRoot: string; db?: PrismaClient;
}): { COMMON_CODE_MODEL: AnalysisStageHandler; KNOWLEDGE_GRAPH: AnalysisStageHandler } {
  const claim = snapshotAnalysisJobClaim(options.claim);
  async function sources(context: AnalysisStageContext, signal: AbortSignal) {
    signal.throwIfAborted();
    const snapshot = context.sourceSnapshot;
    if (context.target.analysisId !== claim.analysisId || !snapshot || typeof snapshot !== "object" ||
        !("storageObjectId" in snapshot) || typeof snapshot.storageObjectId !== "string" ||
        !("commitSha" in snapshot) || snapshot.commitSha !== context.target.commitSha) {
      throw new AnalysisStageExecutionError("SNAPSHOT_INVALID");
    }
    try {
      const archive = await readSnapshotArchive(options.db ?? database(), {
        storageRoot: options.storageRoot, ownerUserId: claim.ownerUserId,
        analysisId: claim.analysisId, storageObjectId: snapshot.storageObjectId,
      });
      const parsed = await parseSnapshotArchive(archive, { signal });
      signal.throwIfAborted();
      return Object.fromEntries(parsed.files.map(file => [file.relativePath, file.bytes]));
    } catch {
      signal.throwIfAborted();
      throw new AnalysisStageExecutionError("SNAPSHOT_INVALID");
    }
  }
  return {
    async COMMON_CODE_MODEL(context, signal) {
      const bytes = await sources(context, signal);
      const canonical = canonicalizeStageCcm(context.previousStages.STATIC_ANALYSIS, bytes, context.target);
      signal.throwIfAborted();
      return JSON.parse(JSON.stringify({ ccm: canonical.value, contentSha256: canonical.sha256 })) as AnalysisStageArtifact;
    },
    async KNOWLEDGE_GRAPH(context, signal) {
      const bytes = await sources(context, signal);
      const canonical = canonicalizeStageCcm(context.previousStages.COMMON_CODE_MODEL, bytes, context.target);
      const graph = canonicalizeCkg(canonical.value, bytes, context.target.configurationHash);
      if (!graph.ok) throw new AnalysisStageExecutionError("SNAPSHOT_INVALID");
      signal.throwIfAborted();
      const stored = await persistCanonicalGraph(options.db ?? database(), {
        claim, ccm: canonical.value, sourceBytes: bytes, configurationHash: context.target.configurationHash,
      });
      signal.throwIfAborted();
      if (!stored || stored.contentHash !== graph.sha256) throw new Error("Persistensi graph tidak dikonfirmasi.");
      return JSON.parse(JSON.stringify({ graph: graph.value, contentSha256: graph.sha256, graphBundleId: stored.id })) as AnalysisStageArtifact;
    },
  };
}
