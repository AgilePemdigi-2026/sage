import { database, findCleanupJobForUser, requestAnalysisDeletion } from "@sage/database";
import { createCleanupHandlers } from "./cleanup-handlers.ts";
import { readAnalysisSession } from "./session.ts";

export const cleanupHandlers = createCleanupHandlers({
  env: process.env,
  readSession: readAnalysisSession,
  requestDeletion: (owner, analysisId) => requestAnalysisDeletion(database(), owner, analysisId),
  findJob: (owner, jobId) => findCleanupJobForUser(database(), owner, jobId),
});
