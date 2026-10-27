import assert from "node:assert/strict";
import test from "node:test";
import { AnalysisDeletionActiveError, AnalysisDeletionNotFoundError } from "@sage/database";
import type { CleanupSnapshot } from "@sage/database";
import { createCleanupHandlers } from "../apps/web/lib/analyses/cleanup-handlers.ts";

const analysisId = "analysis-owner-23";
const jobId = "cleanup-owner-23";
const snapshot: CleanupSnapshot = { jobId, analysisId, status: "QUEUED", errorCode: null };
function request(body = "{}", headers: Record<string, string> = {}, suffix = "") {
  return new Request(`http://localhost:3000/api/analyses/${analysisId}${suffix}`, {
    method: "DELETE", headers: { "Content-Type": "application/json", Origin: "http://localhost:3000", "X-SAGE-Account": "github-owner", ...headers }, body,
  });
}
function harness() {
  let owner: { userId: string; githubUserId: string } | null = { userId: "owner", githubUserId: "github-owner" };
  let calls = 0;
  let result = snapshot;
  let failure: Error | null = null;
  const handlers = createCleanupHandlers({
    env: { AUTH_BASE_URL: "http://localhost:3000" }, readSession: async () => owner,
    requestDeletion: async (userId, id) => { calls++; assert.equal(userId, "owner"); assert.equal(id, analysisId); if (failure) throw failure; return result; },
    findJob: async (userId, id) => userId === "owner" && id === jobId ? result : null,
  });
  return { handlers, calls: () => calls, owner: (value: typeof owner) => { owner = value; }, result: (value: CleanupSnapshot) => { result = value; }, fail: (value: Error) => { failure = value; } };
}

test("delete requires a matching session, same origin and empty bounded JSON before a mutation", async () => {
  const h = harness();
  for (const body of ['{"owner":"foreign"}', "[]", "null", "{" , '"' + "a".repeat(513) + '"']) assert.equal((await h.handlers.remove(request(body), analysisId)).status, 400);
  assert.equal((await h.handlers.remove(request("{}", {}, "?owner=foreign"), analysisId)).status, 400);
  assert.equal((await h.handlers.remove(request("{}", { Origin: "https://foreign.example" }), analysisId)).status, 403);
  assert.equal((await h.handlers.remove(request("{}", { "X-SAGE-Account": "foreign" }), analysisId)).status, 401);
  h.owner(null); assert.equal((await h.handlers.remove(request(), analysisId)).status, 401);
  assert.equal(h.calls(), 0);
});

test("delete and job status expose only owner-bound public cleanup metadata", async () => {
  const h = harness();
  h.result({ ...snapshot, cleanupManifest: "PRIVATE_STORAGE_CANARY" } as CleanupSnapshot);
  const accepted = await h.handlers.remove(request(), analysisId);
  assert.equal(accepted.status, 202);
  assert.equal(accepted.headers.get("cache-control"), "private, no-store");
  const text = await accepted.text(); assert.equal(text.includes("PRIVATE_STORAGE_CANARY"), false);
  assert.deepEqual(JSON.parse(text).data, { analysisId, accountKey: "github-owner", deletion: snapshot });
  const get = new Request(`http://localhost:3000/api/jobs/${jobId}`, { headers: { "X-SAGE-Account": "github-owner" } });
  assert.equal((await h.handlers.job(get, jobId)).status, 200);
  assert.equal((await h.handlers.job(get, "foreign-job-23")).status, 404);
  h.result({ ...snapshot, status: "COMPLETED" });
  const done = await h.handlers.remove(request(), analysisId);
  assert.equal(done.status, 204); assert.equal(await done.text(), "");
});

test("cleanup maps owner absence and active work to stable safe errors", async () => {
  const h = harness();
  h.fail(new AnalysisDeletionNotFoundError()); assert.equal((await h.handlers.remove(request(), analysisId)).status, 404);
  for (const code of ["ANALYSIS_ACTIVE", "EXPORT_ACTIVE"] as const) {
    h.fail(new AnalysisDeletionActiveError(code));
    const response = await h.handlers.remove(request(), analysisId);
    assert.equal(response.status, 409); assert.equal((await response.json()).error.code, code);
  }
  h.fail(new Error("PRIVATE_SQL_OR_SOURCE_CANARY"));
  const failed = await h.handlers.remove(request(), analysisId);
  assert.equal(failed.status, 503); assert.equal((await failed.text()).includes("PRIVATE_SQL_OR_SOURCE_CANARY"), false);
});
