import {
  database,
  enqueueAnalysisRetry,
  findEnqueuedAnalysisRequest,
  getAnalysisDetailForUser,
  getAnalysisRetryTargetForUser,
  listAnalysesForUser,
} from "@sage/database";
import { GitHubRepositoryClient } from "../github/client.ts";
import { readRepositorySession } from "../github/session.ts";
import { readAnalysisSession } from "./session.ts";
import { createHistoryHandlers } from "./handlers.ts";
import { createAnalysisRetryHandler } from "./retry-handlers.ts";

/** Wiring produksi. Unit test mengganti deps; objek ini hanya mengikat database nyata. */
export const analysisHandlers = createHistoryHandlers({
  readSession: readAnalysisSession,
  list: (userId, options) => listAnalysesForUser(database(), userId, options),
  detail: (userId, analysisId) => getAnalysisDetailForUser(database(), userId, analysisId),
});

/** Retry keeps authorization, fresh provider resolution, and the parent snapshot owner-scoped. */
export const retryAnalysisHandler = createAnalysisRetryHandler({
  env: process.env,
  readSession: readRepositorySession,
  findParent: (ownerUserId, analysisId) => getAnalysisRetryTargetForUser(database(), ownerUserId, analysisId),
  replay: (ownerUserId, keyHash, requestHash) => findEnqueuedAnalysisRequest(database(), ownerUserId, keyHash, requestHash),
  resolve: (token, input) => new GitHubRepositoryClient({ accessToken: token }).resolveTarget(input),
  enqueue: (ownerUserId, parent, idempotency) => enqueueAnalysisRetry(database(), { ...parent, ownerUserId }, idempotency),
});
