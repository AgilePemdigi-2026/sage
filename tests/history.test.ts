import test from "node:test";
import assert from "node:assert/strict";
import {
  encodeHistoryCursor, parseHistoryCursor, HistoryQueryError,
  listAnalysesForUser, getAnalysisDetailForUser,
} from "../packages/database/src/history.ts";
import { ANALYSIS_STAGE_DEFINITIONS } from "../packages/contracts/src/index.ts";

function fakeDb(rows: Record<string, unknown>[], findFirst: (args: unknown) => Promise<unknown> = async () => null) {
  return {
    analysis: {
      findMany: async (args: { where: Record<string, unknown> }) => { void args; return rows; },
      findFirst,
    },
  } as unknown as Parameters<typeof listAnalysesForUser>[0];
}
function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "hist-row-0001-0001", repository: { fullName: "acme/report-service" }, branchName: "main",
    commitSha: "a".repeat(40), status: "COMPLETED", errorCode: null, queuedAt: new Date("2026-10-19T01:00:00Z"),
    startedAt: new Date("2026-10-19T01:01:00Z"), completedAt: new Date("2026-10-19T01:05:00Z"),
    retryOfAnalysisId: null, createdAt: new Date("2026-10-19T01:00:00Z"), ...overrides,
  };
}

test("cursor encode/parse round-trip and reject garbage", () => {
  const cursor = encodeHistoryCursor({ createdAt: new Date("2026-10-19T02:00:00.000Z"), id: "hist-row-0002-0002" });
  assert.match(cursor, /^[A-Za-z0-9_-]+$/);
  assert.deepEqual(parseHistoryCursor(cursor), { createdAt: new Date("2026-10-19T02:00:00.000Z"), id: "hist-row-0002-0002" });
  const epochZero = Buffer.from(JSON.stringify({ c: "1970-01-01T00:00:00.000Z", i: "hist-row-0002-0002" })).toString("base64url");
  for (const bad of ["", "###", "!!", "eyJiYWQiOjF9", epochZero]) assert.equal(parseHistoryCursor(bad), null);
});

test("list filters status, query substring, and applies keyset where clause", async () => {
  let captured: { where: Record<string, unknown>; orderBy: unknown; take: number } | undefined;
  const db = fakeDb([]);
  (db as { analysis: { findMany: (args: never) => Promise<Record<string, unknown>[]> } }).analysis.findMany = (async (args: never) => {
    captured = args as typeof captured; return [];
  }) as never;
  await listAnalysesForUser(db, "owner", {
    status: "FAILED", query: "  report-service  ",
    cursor: encodeHistoryCursor({ createdAt: new Date("2026-10-18T00:00:00.000Z"), id: "hist-row-0000-0000" }),
  });
  const where = captured?.where;
  assert.equal(where?.ownerUserId, "owner");
  assert.equal(where?.status, "FAILED");
  assert.ok(Array.isArray(where?.OR));
  assert.ok(Array.isArray(where?.AND));
  await assert.rejects(listAnalysesForUser(db, "owner", { status: "GONE" }), HistoryQueryError);
  await assert.rejects(listAnalysesForUser(db, "owner", { cursor: "!!" }), HistoryQueryError);
  await assert.rejects(listAnalysesForUser(db, "owner", { query: "x".repeat(201) }), HistoryQueryError);
  await assert.rejects(listAnalysesForUser(db, "   ", undefined), HistoryQueryError);
});

test("list maps rows and closes pagination after pageSize items", async () => {
  const rows = Array.from({ length: 21 }, (_, index) => row({ id: `hist-row-${String(index).padStart(4, "0")}-0001`, createdAt: new Date(Date.UTC(2026, 9, 19, 1, 0, index)) }));
  const result = await listAnalysesForUser(fakeDb(rows), "owner");
  assert.equal(result.items.length, 20);
  assert.equal(result.nextCursor, encodeHistoryCursor({ createdAt: new Date(Date.UTC(2026, 9, 19, 1, 0, 19)), id: "hist-row-0019-0001" }));
  assert.deepEqual(result.items[0], {
    id: "hist-row-0000-0001", repositoryFullName: "acme/report-service", branchName: "main", commitSha: "a".repeat(40),
    status: "COMPLETED", errorCode: null, queuedAt: row().queuedAt, startedAt: row().startedAt,
    completedAt: row().completedAt, retryOfAnalysisId: null,
  });
});

test("detail returns stages filled to nine, limitations, and result links only for terminal success", async () => {
  const detailRow = {
    id: "hist-detail-0001x", branchName: "main", commitSha: "a".repeat(40), status: "COMPLETED", errorCode: null,
    retryOfAnalysisId: null, queuedAt: row().queuedAt, startedAt: row().startedAt, completedAt: row().completedAt,
    updatedAt: new Date("2026-10-19T01:05:00Z"), repository: { fullName: "acme/report-service" },
    stages: [{ sequence: 1, key: "SNAPSHOT", status: "RUNNING", errorCode: null, startedAt: row().startedAt, finishedAt: null }],
    limitations: [{ stageKey: "STATIC_ANALYSIS", code: "FILE_SKIPPED", safeExplanation: "Satu file dilewati." }],
  };
  const detail = await getAnalysisDetailForUser(fakeDb([], async () => detailRow), "owner", "hist-detail-0001x");
  assert.ok(detail);
  assert.equal(detail.stateVersion, new Date("2026-10-19T01:05:00Z").getTime());
  assert.equal(detail.stages.length, 9);
  assert.equal(ANALYSIS_STAGE_DEFINITIONS.length, 9);
  for (const [index, stage] of detail.stages.entries()) {
    assert.equal(stage.sequence, index + 1);
    assert.equal(stage.key, ANALYSIS_STAGE_DEFINITIONS[index].key);
  }
  assert.deepEqual(detail.results, { graphUrl: `/analyses/${detail.id}/graph`, documentUrl: `/analyses/${detail.id}/document` });
  const queued = await getAnalysisDetailForUser(fakeDb([], async () => ({ ...detailRow, status: "QUEUED" })), "owner", "hist-detail-0001x");
  assert.equal(queued?.results, null);
  for (const stage of queued?.stages ?? []) {
    assert.ok(stage.status === "PENDING" || stage.status === "RUNNING");
  }
});

test("detail is null across users and rejects empty ids", async () => {
  await assert.equal(await getAnalysisDetailForUser(fakeDb([]), "owner", "hist-detail-0001x"), null);
  await assert.rejects(getAnalysisDetailForUser(fakeDb([]), "owner", ""), HistoryQueryError);
});
