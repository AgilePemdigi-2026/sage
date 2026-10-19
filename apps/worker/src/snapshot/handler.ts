import { database, readGitHubCredential } from "@sage/database";
import type { PrismaClient } from "../../../../packages/database/generated/client.ts";
import { fetchRepositoryArchive } from "../../../../packages/github/archive.ts";
import { snapshotAnalysisJobClaim, type AnalysisJobClaim } from "../../../../packages/database/src/queue.ts";
import type { AnalysisStageHandler } from "../stage-runner.ts";
import { parseSnapshotArchive, SnapshotArchiveError } from "./archive.ts";
import { writeSnapshotArchive } from "./storage.ts";
export function createSnapshotHandler(options: { claim: AnalysisJobClaim; storageRoot: string; db?: PrismaClient; fetchArchive?: typeof fetchRepositoryArchive }): AnalysisStageHandler {
  const claim = snapshotAnalysisJobClaim(options.claim);
  return async (context, signal) => {
    if (context.target.analysisId !== claim.analysisId) throw new SnapshotArchiveError("SNAPSHOT_INVALID");
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(60_000)]);
    deadline.throwIfAborted();
    const db = options.db ?? database();
    const analysis = await db.analysis.findFirst({ where: { id: context.target.analysisId, ownerUserId: claim.ownerUserId, repositoryId: context.target.repositoryId, commitSha: context.target.commitSha }, select: { id: true, commitSha: true, repository: { select: { githubRepositoryId: true, fullName: true } } } });
    if (!analysis) throw new SnapshotArchiveError("SNAPSHOT_INVALID");
    const now = new Date();
    const connection = await db.gitHubConnection.findFirst({ where: { userId: claim.ownerUserId, status: "ACTIVE", revokedAt: null, OR: [{ tokenExpiresAt: null }, { tokenExpiresAt: { gt: now } }] }, orderBy: { updatedAt: "desc" }, select: { id: true } });
    if (!connection) throw new SnapshotArchiveError("AUTH_REQUIRED");
    const credential = await readGitHubCredential(db, claim.ownerUserId, connection.id, now);
    if (!credential) throw new SnapshotArchiveError("AUTH_REQUIRED");
    deadline.throwIfAborted();
    const archive = await (options.fetchArchive ?? fetchRepositoryArchive)({ repository: analysis.repository.fullName, githubRepositoryId: analysis.repository.githubRepositoryId, commitSha: analysis.commitSha, accessToken: credential.accessToken, signal: deadline });
    const verified = await parseSnapshotArchive(archive, { signal: deadline });
    deadline.throwIfAborted();
    const stored = await writeSnapshotArchive(db, { storageRoot: options.storageRoot, claim, signal: deadline, archive, sha256: verified.archiveSha256 });
    return { ...stored, commitSha: analysis.commitSha, files: verified.files.length, extractedBytes: verified.extractedBytes };
  };
}
