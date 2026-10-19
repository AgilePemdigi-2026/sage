import assert from "node:assert/strict";
import test from "node:test";
import { createSubmissionHandler, type SubmissionDependencies } from "../apps/web/lib/github/submission-handlers.ts";
import { AnalysisIdempotencyConflictError } from "@sage/database";
const sha = "a".repeat(40);
function fixture() {
  const calls: string[] = [];
  const receipt = { analysisId: "analysis", jobId: "job", configurationHash: "b".repeat(64), commitSha: sha, status: "QUEUED" as const };
  const deps: SubmissionDependencies = {
    env: { AUTH_BASE_URL: "http://localhost:3000" }, readSession: async () => ({ userId: "owner", accessToken: "private-token" }),
    replay: async owner => { calls.push(`replay:${owner}`); return null; },
    resolve: async () => { calls.push("resolve"); return { repository: { id: "1", owner: "x", name: "y", fullName: "x/y", private: false, defaultBranch: "main", archived: false, installationId: null }, branch: "main", commitSha: sha, branchHeadSha: sha }; },
    enqueue: async (owner, target, keys) => { calls.push(`enqueue:${owner}`); assert.equal(target.commitSha, sha); assert.match(keys.keyHash, /^[a-f0-9]{64}$/); return receipt; },
  }; return { deps, calls, receipt };
}
function post(body = '{"repository":"x/y","branch":"main"}', key = "fixture-key-00001", origin = "http://localhost:3000") { return new Request("http://localhost:3000/api/analyses", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json", "Idempotency-Key": key }, body }); }
test("submission validates fresh provider target before atomic enqueue and exposes no token", async () => {
  const { deps, calls } = fixture(); const response = await createSubmissionHandler(deps)(post()); assert.equal(response.status, 202);
  const body = await response.text(); assert.ok(body.includes(sha)); assert.ok(!body.includes("private-token")); assert.deepEqual(calls, ["replay:owner", "resolve", "enqueue:owner"]);
});
test("submission replay returns original persisted SHA without resolving moving HEAD", async () => {
  const { deps, calls, receipt } = fixture(); deps.replay = async () => receipt;
  const response = await createSubmissionHandler(deps)(post()); assert.equal(response.status, 200); assert.equal((await response.json()).data.commitSha, sha); assert.deepEqual(calls, []);
  deps.replay = async () => { throw new AnalysisIdempotencyConflictError(); }; assert.equal((await createSubmissionHandler(deps)(post())).status, 409);
});
test("submission rejects missing session, forged owner, bad key, CSRF and invalid JSON before enqueue", async () => {
  const { deps, calls } = fixture(); const handler = createSubmissionHandler(deps);
  for (const body of ['{}', '[]', 'null', '{', '{"repository":"x/y","branch":"main","ownerUserId":"foreign"}', 'x'.repeat(2049)]) assert.equal((await handler(post(body))).status, 400);
  assert.equal((await handler(post(undefined, "short"))).status, 400); assert.equal((await handler(post(undefined, undefined, "https://foreign.test"))).status, 403);
  deps.readSession = async () => null; assert.equal((await handler(post())).status, 401); assert.deepEqual(calls, []);
});
