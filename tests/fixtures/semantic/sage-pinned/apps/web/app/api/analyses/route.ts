import { database, enqueueAnalysis, findEnqueuedAnalysisRequest } from "@sage/database";
import { GitHubRepositoryClient } from "../../../lib/github/client.ts";
import { readRepositorySession } from "../../../lib/github/session.ts";
import { createSubmissionHandler } from "../../../lib/github/submission-handlers.ts";
import { analysisHandlers } from "../../../lib/analyses/server-handlers.ts";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = analysisHandlers.list;
export const POST = createSubmissionHandler({
  env: process.env,
  readSession: readRepositorySession,
  replay: (owner, key, hash) => findEnqueuedAnalysisRequest(database(), owner, key, hash),
  resolve: (token, input) => new GitHubRepositoryClient({ accessToken: token }).resolveTarget(input),
  async enqueue(ownerUserId, target, idempotency) {
    const db = database(); const value = target.repository;
    const metadata = { ownerLogin: value.owner, name: value.name, fullName: value.fullName, visibility: value.private ? "PRIVATE" as const : "PUBLIC" as const, defaultBranch: value.defaultBranch, archived: value.archived };
    const repository = await db.repository.upsert({ where: { githubRepositoryId: value.id }, create: { githubRepositoryId: value.id, ...metadata }, update: metadata, select: { id: true } });
    return enqueueAnalysis(db, { ownerUserId, repositoryId: repository.id, branchName: target.branch, commitSha: target.commitSha, configuration: { version: 1, limitsVersion: 1, sourcePolicyVersion: "sage-source-policy-v1", maxSourceFileBytes: 1048576 }, analyzerVersion: "static-resolver-v0.3.0", schemaVersion: "1", idempotency });
  },
});
