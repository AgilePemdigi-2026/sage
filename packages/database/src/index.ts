import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/client.ts";

const state = globalThis as typeof globalThis & { sageDatabase?: PrismaClient };

export function database(): PrismaClient {
  if (!state.sageDatabase) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL wajib diisi.");
    const adapter = new PrismaPg({ connectionString, max: 5, connectionTimeoutMillis: 5000, idleTimeoutMillis: 10000 });
    state.sageDatabase = new PrismaClient({ adapter });
  }
  return state.sageDatabase;
}

export async function disconnectDatabase() {
  await state.sageDatabase?.$disconnect();
  delete state.sageDatabase;
}

export {
  findAnalysisForUser,
  findArchitectureDocumentForUser,
  findExportForUser,
  findGitHubConnectionForUser,
  findGitHubInstallationForUser,
  findGraphBundleForUser,
  findJobForUser,
  findSourceFileForUser,
  findStorageObjectForUser,
} from "./access.ts";
export { CanonicalGraphIntegrityError, persistCanonicalGraph, readCanonicalGraphForUser } from "./graphs.ts";
export {
  decryptCredential,
  encryptCredential,
  readGitHubCredential,
  replaceGitHubCredential,
  revokeGitHubCredentialForUser,
  storeGitHubCredential,
} from "./credentials.ts";
export { createSession, hashSessionToken, resolveSession, revokeSession } from "./session.ts";
export { completeGitHubLogin, consumeGitHubOAuthAttempt, createGitHubOAuthAttempt } from "./oauth.ts";
export {
  AnalysisIdempotencyConflictError,
  AnalysisRetryConflictError,
  AnalysisQueueInvariantError,
  claimAnalysisJob,
  enqueueAnalysis,
  findEnqueuedAnalysisRequest,
  failAnalysisJob,
  getOwnerAnalysisProgress,
  renewAnalysisLease,
} from "./queue.ts";
export type {
  AnalysisJobClaim,
  ClaimAnalysisJobOptions,
  EnqueuedAnalysis,
  EnqueueAnalysisInput,
  RenewAnalysisLeaseOptions,
} from "./queue.ts";
export {
  completeAnalysisStage,
  failAnalysisStage,
  initializeAnalysisStages,
  readAnalysisStages,
  startAnalysisStage,
} from "./stages.ts";
export type {
  AnalysisStageFailureCode,
  AnalysisStageTargetContext,
  PersistedAnalysisStageInput,
  ReadonlyJsonValue,
} from "./stages.ts";
export type { EncryptedCredential } from "./credentials.ts";
export {
  encodeHistoryCursor,
  getAnalysisDetailForUser,
  HistoryQueryError,
  listAnalysesForUser,
  parseHistoryCursor,
} from "./history.ts";
export type {
  AnalysisDetailRecord,
  AnalysisStageRecord,
  HistoryListItem,
  HistoryListOptions,
  HistoryListResult,
  HistoryStatusFilter,
} from "./history.ts";
export type { ResolvedSession } from "./session.ts";

export { AnalysisRetryNotAllowedError, AnalysisRetryNotFoundError, enqueueAnalysisRetry, getAnalysisRetryTargetForUser } from "./retry.ts";
export type { AnalysisRetryTarget } from "./retry.ts";

export { CanonicalDocumentIntegrityError, persistCanonicalDocument, readCanonicalDocumentForUser } from "./documents.ts";
export {
  completeExportJob,
  claimExportJob,
  enqueueExport,
  enqueueMarkdownExport,
  findExportSnapshotForUser,
  failExportJob,
  findMarkdownExportForUser,
  renewExportLease,
  retryExport,
  retryMarkdownExport,
  snapshotExportJobClaim,
  ExportAnalysisNotFoundError,
  ExportDocumentChangedError,
  ExportQueueInvariantError,
  ExportResultNotReadyError,
  ExportRetryConflictError,
} from "./exports.ts";
export type { EnqueueExportInput, ExportFormat, ExportJobClaim, ExportLeaseOptions, ExportSnapshot } from "./exports.ts";
export { ANALYSIS_RUNTIME_LEASE_DURATION_MS } from "./analysis-timing.ts";
