import test from "node:test";
import assert from "node:assert/strict";
import { applyHistoryPatch, createHistoryData } from "../apps/web/components/history/history-data.ts";
import type { HistoryDataPatch, HistoryDeletion, HistoryDeletionAction, HistoryFetch, HistoryItem, HistoryPatchTarget } from "../apps/web/components/history/history-data.ts";
import { presentHistoryList } from "../apps/web/lib/analyses/presenters.ts";
import type { HistoryListResult } from "@sage/database";

function drain(): Promise<void> {
  return new Promise(setImmediate);
}

function historyItem(id: string, deletion?: HistoryDeletion | null): HistoryItem {
  return {
    id, repository: { fullName: `acme/${id}` }, branch: "main", commitSha: `sha-${id}`,
    status: "COMPLETED", errorCode: null, queuedAt: "2026-10-20T00:00:00Z", startedAt: null,
    completedAt: "2026-10-20T00:01:00Z", retryOfAnalysisId: null, ...(deletion ? { deletion } : {}),
  };
}

type PendingRequest = { input: string; init: RequestInit; resolve: (response: Response) => void };

function response(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
  });
}

function historyHarness(options: { maxDeletionPolls?: number; waitForDeletionPoll?: (signal: AbortSignal, ms: number) => Promise<void> } = {}) {
  const requests: PendingRequest[] = [];
  const fetch: HistoryFetch = (input, init) => new Promise(resolve => requests.push({ input, init, resolve }));
  const state: { items: HistoryItem[] | null; cursor: string | null; error: boolean; loaded: boolean; actions: Record<string, HistoryDeletionAction> } = {
    items: null, cursor: null, error: false, loaded: false, actions: {},
  };
  const target: HistoryPatchTarget = {
    updateItems: updater => { state.items = updater(state.items); },
    setItems: value => { state.items = value; },
    setNextCursor: value => { state.cursor = value; },
    setError: value => { state.error = value; },
    setLoaded: value => { state.loaded = value; },
    setDeletion: (analysisId, deletion) => {
      state.items = state.items?.map(item => item.id === analysisId ? { ...item, deletion } : item) ?? state.items;
    },
    setDeletionAction: (analysisId, action) => {
      if (action) state.actions[analysisId] = action;
      else delete state.actions[analysisId];
    },
    clearDeletionActions: () => { state.actions = {}; },
  };
  let deletedCount = 0;
  const patches: HistoryDataPatch[] = [];
  const data = createHistoryData({
    fetch,
    apply: patch => { patches.push(patch); applyHistoryPatch(target, patch); },
    onAnalysisDeleted: () => { deletedCount += 1; },
    ...options,
  });
  function resolve(index: number, status: number, body?: unknown): void {
    requests[index]?.resolve(response(status, body));
  }
  return { data, state, requests, resolve, patches, get deletedCount() { return deletedCount; } };
}

function listedIds(harness: ReturnType<typeof historyHarness>): string[] | null {
  const items = harness.state.items;
  return items === null ? null : items.map(item => item.id);
}

async function loadHistory(harness: ReturnType<typeof historyHarness>, accountKey: string, item: HistoryItem | HistoryItem[]): Promise<void> {
  harness.data.reload(accountKey, "", "", new AbortController().signal);
  await drain();
  harness.resolve(harness.requests.length - 1, 200, { data: { analyses: Array.isArray(item) ? item : [item], nextCursor: null } });
  await drain();
}

const cleanupEnvelope = (analysisId: string, jobId: string, status: HistoryDeletion["status"], errorCode: string | null = null) => ({
  data: { analysisId, accountKey: "account-a", deletion: { jobId, analysisId, status, errorCode } },
});

test("history presenter only adds a deletion field when cleanup metadata exists", () => {
  const base = {
    id: "analysis-123456", repositoryFullName: "acme/demo", branchName: "main", commitSha: "abcdef123",
    status: "COMPLETED", errorCode: null, queuedAt: new Date("2026-10-20T00:00:00Z"), startedAt: null,
    completedAt: new Date("2026-10-20T00:01:00Z"), retryOfAnalysisId: null,
  };
  const legacyResult = { items: [base], nextCursor: null, pageSize: 20 } as HistoryListResult;
  const cleanup: HistoryDeletion = { jobId: "cleanup-123456", analysisId: base.id, status: "RUNNING", errorCode: null };
  const currentResult = {
    items: [{ ...base, deletion: cleanup }], nextCursor: null, pageSize: 20,
  } as unknown as HistoryListResult;

  assert.deepEqual(presentHistoryList(legacyResult).analyses[0], {
    id: base.id, repository: { fullName: "acme/demo" }, branch: "main", commitSha: "abcdef123",
    status: "COMPLETED", errorCode: null, queuedAt: "2026-10-20T00:00:00.000Z", startedAt: null,
    completedAt: "2026-10-20T00:01:00.000Z", retryOfAnalysisId: null,
  });
  assert.deepEqual(presentHistoryList(currentResult).analyses[0]?.deletion, cleanup);
});

test("failed deletion can be retried; accepted cleanup is polled and completion removes its row", async () => {
  const harness = historyHarness({ waitForDeletionPoll: async () => undefined });
  const item = historyItem("analysis-123456");
  await loadHistory(harness, "account-a", item);

  harness.data.deleteAnalysis("account-a", item.id);
  await drain();
  assert.equal(harness.requests[1]?.input, `/api/analyses/${item.id}`);
  assert.equal(harness.requests[1]?.init.method, "DELETE");
  assert.equal(new Headers(harness.requests[1]?.init.headers).get("X-SAGE-Account"), "account-a");
  assert.equal(harness.requests[1]?.init.body, "{}");
  harness.resolve(1, 409, { error: { code: "EXPORT_ACTIVE", message: "export running" } });
  await drain();
  assert.equal(harness.state.actions[item.id]?.phase, "failed");
  assert.match(harness.state.actions[item.id]?.message ?? "", /Ekspor/);

  harness.data.deleteAnalysis("account-a", item.id);
  await drain();
  harness.resolve(2, 202, cleanupEnvelope(item.id, "cleanup-123456", "QUEUED"));
  await drain();
  assert.equal(harness.state.items?.[0]?.deletion?.status, "QUEUED");
  assert.equal(harness.requests[3]?.input, "/api/jobs/cleanup-123456");
  assert.equal(new Headers(harness.requests[3]?.init.headers).get("X-SAGE-Account"), "account-a");

  harness.resolve(3, 200, cleanupEnvelope(item.id, "cleanup-123456", "COMPLETED"));
  await drain();
  assert.deepEqual(harness.state.items, []);
  assert.equal(harness.deletedCount, 1);
});

test("late delete 204 after account switch cannot remove data or leave old-account feedback", async () => {
  const harness = historyHarness();
  const oldItem = historyItem("analysis-old-123");
  await loadHistory(harness, "account-a", oldItem);

  harness.data.deleteAnalysis("account-a", oldItem.id);
  await drain();
  assert.equal(harness.state.actions[oldItem.id]?.phase, "submitting");

  harness.data.reload("account-b", "", "", new AbortController().signal);
  assert.equal(harness.state.items, null, "rows owned by the previous account are cleared immediately");
  assert.deepEqual(harness.state.actions, {}, "the account switch clears deletion feedback");
  await drain();
  harness.resolve(1, 204);
  await drain();

  assert.equal(harness.state.items, null, "the old account's delayed 204 does not update the new account list");
  assert.equal(harness.deletedCount, 0, "the stale response does not trigger a reload toast or callback");
  harness.resolve(2, 200, { data: { analyses: [historyItem("analysis-new-123")], nextCursor: null } });
  await drain();
  assert.deepEqual(listedIds(harness), ["analysis-new-123"]);
});

test("a FAILED poll stays in history after reload and can retry the same analysis", async () => {
  const harness = historyHarness({ waitForDeletionPoll: async () => undefined });
  const item = historyItem("analysis-retry-123");
  const neighbor = historyItem("analysis-keep-123");
  await loadHistory(harness, "account-a", [item, neighbor]);

  harness.data.deleteAnalysis("account-a", item.id);
  await drain();
  harness.resolve(1, 202, cleanupEnvelope(item.id, "cleanup-retry-123", "QUEUED"));
  await drain();
  harness.resolve(2, 200, cleanupEnvelope(item.id, "cleanup-retry-123", "FAILED", "CLEANUP_FAILED"));
  await drain();
  assert.equal(harness.state.items?.length, 2, "failed cleanup keeps its history row beside unrelated analyses");
  assert.equal(harness.state.items?.find(entry => entry.id === item.id)?.deletion?.status, "FAILED");
  assert.equal(harness.state.actions[item.id]?.phase, "failed");

  harness.data.reload("account-a", "", "", new AbortController().signal);
  await drain();
  harness.resolve(3, 200, { data: { analyses: [historyItem(item.id, {
    jobId: "cleanup-retry-123", analysisId: item.id, status: "FAILED", errorCode: "CLEANUP_FAILED",
  }), neighbor], nextCursor: null } });
  await drain();
  assert.equal(harness.state.items?.[0]?.deletion?.status, "FAILED", "reload preserves the retryable failed row");

  harness.data.deleteAnalysis("account-a", item.id);
  await drain();
  assert.equal(harness.requests[4]?.input, `/api/analyses/${item.id}`, "retry uses the same owner-scoped delete endpoint");
  harness.resolve(4, 204);
  await drain();
  assert.deepEqual(harness.state.items?.map(entry => entry.id), [neighbor.id], "completion removes only the selected row");
  assert.equal(harness.deletedCount, 1);
});
