import type { PrismaClient } from "../generated/client.ts";
import { enqueueAnalysis, type EnqueuedAnalysis } from "./queue.ts";

export type AnalysisRetryTarget = {
  ownerUserId: string;
  analysisId: string;
  status: string;
  repositoryId: string;
  repositoryGitHubId: string;
  repositoryFullNameSnapshot: string | null;
  repositoryFullName: string;
  branchName: string;
  commitSha: string;
  configuration: unknown;
  configurationHash: string;
  analyzerVersion: string;
  schemaVersion: string;
};

export class AnalysisRetryNotFoundError extends Error {
  constructor() {
    super("Analisis tidak ditemukan.");
    this.name = "AnalysisRetryNotFoundError";
  }
}

export class AnalysisRetryNotAllowedError extends Error {
  constructor() {
    super("Analisis hanya dapat diulang setelah gagal.");
    this.name = "AnalysisRetryNotAllowedError";
  }
}

/** Reads only the immutable retry context for an analysis owned by this user. */
export async function getAnalysisRetryTargetForUser(
  db: PrismaClient,
  ownerUserId: string,
  analysisId: string,
): Promise<AnalysisRetryTarget | null> {
  if (typeof ownerUserId !== "string" || ownerUserId.trim().length === 0) throw new Error("Pemilik analisis tidak valid.");
  if (typeof analysisId !== "string" || analysisId.trim().length === 0) throw new Error("ID analisis tidak valid.");
  const row = await db.analysis.findFirst({
    where: { id: analysisId, ownerUserId, deletionRequestedAt: null },
    select: {
      id: true,
      ownerUserId: true,
      status: true,
      repositoryId: true,
      repositoryFullNameSnapshot: true,
      branchName: true,
      commitSha: true,
      configuration: true,
      configurationHash: true,
      analyzerVersion: true,
      schemaVersion: true,
      repository: { select: { githubRepositoryId: true, fullName: true } },
    },
  });
  if (!row) return null;
  return {
    ownerUserId: row.ownerUserId,
    analysisId: row.id,
    status: row.status,
    repositoryId: row.repositoryId,
    repositoryGitHubId: row.repository.githubRepositoryId,
    repositoryFullNameSnapshot: row.repositoryFullNameSnapshot,
    repositoryFullName: row.repositoryFullNameSnapshot ?? row.repository.fullName,
    branchName: row.branchName,
    commitSha: row.commitSha,
    configuration: row.configuration,
    configurationHash: row.configurationHash,
    analyzerVersion: row.analyzerVersion,
    schemaVersion: row.schemaVersion,
  };
}

/** Enqueues a new analysis from the exact parent snapshot. queue.ts locks and revalidates the parent in the insert transaction. */
export async function enqueueAnalysisRetry(
  db: PrismaClient,
  parent: AnalysisRetryTarget,
  idempotency: { keyHash: string; requestHash: string },
): Promise<EnqueuedAnalysis> {
  if (!parent || typeof parent !== "object") throw new AnalysisRetryNotFoundError();
  if (parent.status !== "FAILED") throw new AnalysisRetryNotAllowedError();
  return enqueueAnalysis(db, {
    ownerUserId: parent.ownerUserId,
    repositoryId: parent.repositoryId,
    branchName: parent.branchName,
    commitSha: parent.commitSha,
    configuration: parent.configuration,
    analyzerVersion: parent.analyzerVersion,
    schemaVersion: parent.schemaVersion,
    retryParentId: parent.analysisId,
    retryParentRepositoryFullNameSnapshot: parent.repositoryFullNameSnapshot,
    idempotency,
  });
}
