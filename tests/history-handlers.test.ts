import test from "node:test";
import assert from "node:assert/strict";
import { createHistoryHandlers, ANALYSIS_STATUSES, presentAnalysisDetail } from "../apps/web/lib/analyses/handlers.ts";
import type { HistoryHandlerDependencies } from "../apps/web/lib/analyses/handlers.ts";

function fixture() {
  const calls: string[] = [];
  const deps: HistoryHandlerDependencies = {
    readSession: async () => ({ userId: "owner", githubUserId: "git-1" }),
    list: async (userId) => { calls.push(`list:${userId}`); return { items: [], nextCursor: null, pageSize: 20 }; },
    detail: async () => { calls.push("detail"); return null; },
  };
  return { deps, calls };
}
function get(url: string) {
  return new Request(url);
}
const LIST_URL = "http://localhost:3000/api/analyses";

test("list requires session, validates query/status/cursor strictly, and never leaks without it", async () => {
  const { deps, calls } = fixture();
  const handlers = createHistoryHandlers(deps);
  assert.equal((await handlers.list(get(`${LIST_URL}?status=GONE`))).status, 400);
  assert.equal((await handlers.list(get(`${LIST_URL}?cursor=!!`))).status, 400);
  assert.equal((await handlers.list(get(`${LIST_URL}?query=${"x".repeat(201)}`))).status, 400);
  assert.equal((await handlers.list(get(`${LIST_URL}?page=1`))).status, 400);
  assert.equal((await handlers.list(get(`${LIST_URL}?status=QUEUED&status=FAILED`))).status, 400);
  assert.deepEqual(calls, []);
  deps.readSession = async () => null;
  assert.equal((await handlers.list(get(LIST_URL))).status, 401);
  assert.deepEqual(calls, []);
});

test("list passes owner from server session only and marks response no-store", async () => {
  const { deps, calls } = fixture();
  const handlers = createHistoryHandlers(deps);
  const response = await handlers.list(get(`${LIST_URL}?query=acme&status=QUEUED`));
  assert.equal(response.status, 200);
  assert.deepEqual(calls, ["list:owner"]);
  assert.match(response.headers.get("cache-control")!, /no-store/);
  const body = await response.json();
  assert.deepEqual(Object.keys(body), ["data"]);
  assert.deepEqual(body.data, { analyses: [], nextCursor: null });
});

test("detail returns 404 for missing/foreign analyses and 400 for malformed ids", async () => {
  const { deps, calls } = fixture();
  const handlers = createHistoryHandlers(deps);
  assert.equal((await handlers.detail(get(`${LIST_URL}/hist-detail-0001x`), "hist-detail-0001x")).status, 404);
  assert.deepEqual(calls, ["detail"]);
  for (const id of ["short", "x".repeat(65), "bad id!"]) {
    assert.equal((await handlers.detail(get(`${LIST_URL}/${id}`), id)).status, 400);
  }
  assert.equal(calls.some(call => call.includes("x".repeat(65))), false);
});

test("presentAnalysisDetail shapes payload with context, nine labelled stages, canonical links", () => {
  assert.ok(ANALYSIS_STATUSES.includes("COMPLETED_WITH_LIMITATIONS"));
  const base = {
    id: "hist-detail-0001x", repositoryFullName: "acme/r", branchName: "main", commitSha: "a", status: "COMPLETED",
    errorCode: null, retryOfAnalysisId: null, queuedAt: new Date("2026-01-01T00:00:00Z"), startedAt: null,
    completedAt: new Date("2026-01-01T01:00:00Z"), updatedAt: new Date("2026-01-01T01:00:00Z"), stateVersion: 1767229200000,
    stages: [{ sequence: 1, key: "SNAPSHOT", status: "COMPLETED", errorCode: null, startedAt: null, finishedAt: null }],
    limitations: [], results: { graphUrl: "/analyses/hist-detail-0001x/graph", documentUrl: "/analyses/hist-detail-0001x/document" },
  };
  const detail = presentAnalysisDetail(base);
  assert.equal(detail.stateVersion, 1767229200000);
  assert.deepEqual(detail.context, { repositoryFullName: "acme/r", branchName: "main", commitSha: "a" });
  assert.equal(detail.stages.length, 9);
  assert.deepEqual(detail.results, { graphUrl: "/analyses/hist-detail-0001x/graph", documentUrl: "/analyses/hist-detail-0001x/document" });
  assert.equal(detail.limitations.length, 0);
  const failed = presentAnalysisDetail({ ...base, status: "FAILED", results: null });
  assert.equal(failed.results, null);
});

test("kegagalan infrastruktur saat membaca sesi tetap dalam batas error: 503 HISTORY_UNAVAILABLE", async () => {
  const calls: string[] = [];
  const deps: HistoryHandlerDependencies = {
    readSession: async () => { throw new Error("db down saat resolveSession"); },
    list: async userId => { calls.push(`list:${userId}`); return { items: [], nextCursor: null, pageSize: 20 }; },
    detail: async () => { calls.push("detail"); return null; },
  };
  const handlers = createHistoryHandlers(deps);

  const listResponse = await handlers.list(get(LIST_URL));
  assert.equal(listResponse.status, 503);
  const listBody = await listResponse.json() as { error: { code: string; message: string; details?: unknown }; requestId: unknown };
  assert.equal(listBody.error.code, "HISTORY_UNAVAILABLE");
  assert.equal(typeof listBody.error.message, "string");
  assert.equal(typeof listBody.requestId, "string");
  assert.deepEqual(calls, [], "query riwayat tidak jalan bila sesi gagal dibaca");

  const detailResponse = await handlers.detail(get(`${LIST_URL}/hist-detail-0001x`), "hist-detail-0001x");
  assert.equal(detailResponse.status, 503);
  const detailBody = await detailResponse.json() as { error: { code: string } };
  assert.equal(detailBody.error.code, "HISTORY_UNAVAILABLE");
  assert.deepEqual(calls, []);
  assert.match(detailResponse.headers.get("cache-control")!, /no-store/);
});
