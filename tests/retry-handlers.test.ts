import assert from "node:assert/strict";
import test from "node:test";
import { AnalysisIdempotencyConflictError, AnalysisRetryConflictError, type AnalysisRetryTarget, type EnqueuedAnalysis } from "@sage/database";
import { createAnalysisRetryHandler, type AnalysisRetryHandlerDependencies } from "../apps/web/lib/analyses/retry-handlers.ts";

const sha = "a".repeat(40);
const parent: AnalysisRetryTarget = {
  ownerUserId: "owner",
  analysisId: "analysis-parent-01",
  status: "FAILED",
  repositoryId: "repository-db-1",
  repositoryGitHubId: "7001",
  repositoryFullNameSnapshot: "acme/report-service",
  repositoryFullName: "acme/report-service",
  branchName: "release/2.x",
  commitSha: sha,
  configuration: { version: 1, nested: { flag: true } },
  configurationHash: "b".repeat(64),
  analyzerVersion: "analyzer-v2",
  schemaVersion: "3",
};
const receipt: EnqueuedAnalysis = {
  analysisId: "analysis-retry-001",
  jobId: "job-retry-001",
  configurationHash: parent.configurationHash,
  commitSha: sha,
  status: "QUEUED",
};

function fixture() {
  const calls: string[] = [];
  const deps: AnalysisRetryHandlerDependencies = {
    env: { AUTH_BASE_URL: "http://localhost:3000" },
    readSession: async () => ({ userId: "owner", accessToken: "private-token" }),
    findParent: async (owner, id) => { calls.push(`parent:${owner}:${id}`); return parent; },
    replay: async (owner, keyHash, requestHash) => { calls.push(`replay:${owner}`); assert.match(keyHash, /^[a-f0-9]{64}$/); assert.match(requestHash, /^[a-f0-9]{64}$/); return null; },
    resolve: async (token, input) => {
      calls.push(`resolve:${token}`);
      assert.deepEqual(input, { repository: parent.repositoryFullName, branch: parent.branchName, commit: parent.commitSha });
      return {
        repository: { id: parent.repositoryGitHubId, owner: "acme", name: "report-service", fullName: parent.repositoryFullName, private: true, defaultBranch: "main", archived: false, installationId: "123" },
        branch: parent.branchName,
        commitSha: sha,
        branchHeadSha: "c".repeat(40),
      };
    },
    enqueue: async (owner, retryParent, idempotency) => {
      calls.push(`enqueue:${owner}`);
      assert.equal(retryParent, parent);
      assert.equal(idempotency.requestHash.length, 64);
      return receipt;
    },
  };
  return { calls, deps };
}

function post(body = "{}", key = "retry-key-00000001", origin = "http://localhost:3000", account = "github-owner") {
  return new Request("http://localhost:3000/api/analyses/analysis-parent-01/retry", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json", "Idempotency-Key": key, "X-SAGE-Account": account },
    body,
  });
}

test("retry resolves current GitHub access and repository identity before creating an immutable retry", async () => {
  const { calls, deps } = fixture();
  const response = await createAnalysisRetryHandler(deps)(post(), parent.analysisId);
  assert.equal(response.status, 202);
  const text = await response.text();
  assert.ok(text.includes(receipt.analysisId));
  assert.ok(text.includes(sha));
  assert.ok(!text.includes("private-token"));
  assert.deepEqual(calls, ["parent:owner:analysis-parent-01", "resolve:private-token", "replay:owner", "enqueue:owner"]);
});

test("retry rechecks GitHub on idempotent replay and returns the persisted analysis", async () => {
  const { calls, deps } = fixture();
  deps.replay = async () => { calls.push("replay-hit"); return receipt; };
  const response = await createAnalysisRetryHandler(deps)(post(), parent.analysisId);
  assert.equal(response.status, 200);
  assert.equal((await response.json() as { data: { analysisId: string; replayed: boolean } }).data.analysisId, receipt.analysisId);
  assert.deepEqual(calls, ["parent:owner:analysis-parent-01", "resolve:private-token", "replay-hit"]);
});

test("retry hides foreign parents and rejects a non-failed parent before GitHub lookup", async () => {
  const { calls, deps } = fixture();
  deps.findParent = async owner => { calls.push(`parent:${owner}`); return null; };
  const handler = createAnalysisRetryHandler(deps);
  assert.equal((await handler(post(), parent.analysisId)).status, 404);
  assert.deepEqual(calls, ["parent:owner"]);

  calls.length = 0;
  deps.findParent = async (owner, id) => { calls.push(`parent:${owner}:${id}`); return { ...parent, status: "RUNNING" }; };
  assert.equal((await handler(post(), parent.analysisId)).status, 409);
  assert.deepEqual(calls, ["parent:owner:analysis-parent-01"]);
});

test("retry rejects changed repository identity, changed SHA, and concurrent parent invalidation", async () => {
  const { calls, deps } = fixture();
  const handler = createAnalysisRetryHandler(deps);
  deps.resolve = async () => ({
    repository: { id: "a different GitHub repository", owner: "acme", name: "report-service", fullName: parent.repositoryFullName, private: true, defaultBranch: "main", archived: false, installationId: "123" },
    branch: parent.branchName, commitSha: sha, branchHeadSha: sha,
  });
  assert.equal((await handler(post(), parent.analysisId)).status, 409);
  assert.deepEqual(calls, ["parent:owner:analysis-parent-01"]);

  calls.length = 0;
  deps.resolve = async () => ({
    repository: { id: parent.repositoryGitHubId, owner: "acme", name: "report-service", fullName: parent.repositoryFullName, private: true, defaultBranch: "main", archived: false, installationId: "123" },
    branch: parent.branchName, commitSha: "d".repeat(40), branchHeadSha: "d".repeat(40),
  });
  assert.equal((await handler(post(), parent.analysisId)).status, 409);

  deps.resolve = async () => ({
    repository: { id: parent.repositoryGitHubId, owner: "acme", name: "report-service", fullName: parent.repositoryFullName, private: true, defaultBranch: "main", archived: false, installationId: "123" },
    branch: parent.branchName, commitSha: sha, branchHeadSha: sha,
  });
  deps.enqueue = async () => { throw new AnalysisRetryConflictError(); };
  const race = await handler(post(), parent.analysisId);
  assert.equal(race.status, 409);
  assert.equal((await race.json() as { error: { code: string } }).error.code, "ANALYSIS_NOT_RETRYABLE");
});

test("retry validates session, origin, request body and idempotency key", async () => {
  const { calls, deps } = fixture();
  const handler = createAnalysisRetryHandler(deps);
  assert.equal((await handler(post(undefined, undefined, "https://outside.test"), parent.analysisId)).status, 403);
  assert.equal((await handler(post("{\"branch\":\"main\"}"), parent.analysisId)).status, 400);
  assert.equal((await handler(post("{}", "short"), parent.analysisId)).status, 400);
  assert.equal((await handler(post(), "bad id!")).status, 400);
  deps.readSession = async () => null;
  assert.equal((await handler(post(), parent.analysisId)).status, 401);
  assert.deepEqual(calls, []);
});

test("retry maps reused idempotency keys with a different request to conflict", async () => {
  const { deps } = fixture();
  deps.replay = async () => { throw new AnalysisIdempotencyConflictError(); };
  const response = await createAnalysisRetryHandler(deps)(post(), parent.analysisId);
  assert.equal(response.status, 409);
  assert.equal((await response.json() as { error: { code: string } }).error.code, "IDEMPOTENCY_CONFLICT");
});
