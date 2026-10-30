import assert from "node:assert/strict";
import test from "node:test";
import { MARKDOWN_RENDERER_VERSION } from "../packages/documents/src/markdown.ts";
import { PDF_RENDERER_VERSION } from "../packages/documents/src/pdf-version.ts";
import { createExportHandlers } from "../apps/web/lib/exports/handlers.ts";
import type { ExportHandlerDependencies } from "../apps/web/lib/exports/handlers.ts";
import type { ExportSnapshot } from "../packages/database/src/exports.ts";

const analysisId = "analysis_export_01";
const exportId = "export_record_001";
const account = { userId: "user-export-01", githubUserId: "github-export-01" };
const documentHash = "a".repeat(64);
const contentHash = "b".repeat(64);
const queued: ExportSnapshot = {
  id: exportId,
  format: "MARKDOWN",
  status: "QUEUED",
  documentHash,
  rendererVersion: MARKDOWN_RENDERER_VERSION,
  contentHash: null,
  errorCode: null,
};

function dependencies(overrides: Partial<ExportHandlerDependencies> = {}) {
  const calls: { enqueue: unknown[]; find: unknown[]; retry: unknown[]; download: unknown[]; readDocument: unknown[] } = {
    enqueue: [], find: [], retry: [], download: [], readDocument: [],
  };
  const base: ExportHandlerDependencies = {
    env: { AUTH_BASE_URL: "http://localhost:3000" },
    readSession: async () => account,
    readDocument: async (ownerUserId, id) => {
      calls.readDocument.push([ownerUserId, id]);
      return { kind: "ready", value: { analysisId: id, contentHash: documentHash, document: {} as never } };
    },
    enqueue: async input => { calls.enqueue.push(input); return { export: queued, created: true }; },
    find: async (ownerUserId, id, recordId) => { calls.find.push([ownerUserId, id, recordId]); return queued; },
    retry: async input => { calls.retry.push(input); return queued; },
    readDownload: async (ownerUserId, id, recordId) => {
      calls.download.push([ownerUserId, id, recordId]);
      return { kind: "ready", value: { bytes: Buffer.from("# Canonical export\n"), filename: "sage-repo-a1b2c3d.md", format: "MARKDOWN" } };
    },
  };
  return { handlers: createExportHandlers({ ...base, ...overrides }), calls };
}

function post(url = `http://localhost:3000/api/analyses/${analysisId}/exports`, body = '{"format":"MARKDOWN"}', accountKey = account.githubUserId, origin = "http://localhost:3000") {
  const headers: Record<string, string> = { "Content-Type": "application/json", Origin: origin, Cookie: "sage_session=opaque-session-token" };
  if (accountKey !== null) headers["X-SAGE-Account"] = accountKey;
  return new Request(url, { method: "POST", headers, body });
}

function get(url: string, accountKey = account.githubUserId) {
  return new Request(url, { headers: { Cookie: "sage_session=opaque-session-token", "X-SAGE-Account": accountKey } });
}

function assertPrivateHeaders(response: Response, jsonContent = true) {
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(response.headers.get("vary"), "Cookie, X-SAGE-Account");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  if (jsonContent) assert.match(response.headers.get("content-type") ?? "", /^application\/json/);
}

test("export POST accepts Markdown and binds the queue request to canonical document hash", async () => {
  const { handlers, calls } = dependencies();
  const response = await handlers.post(post(), analysisId);
  assert.equal(response.status, 202);
  assertPrivateHeaders(response);
  assert.deepEqual(await response.json(), { data: { analysisId, accountKey: account.githubUserId, export: queued } });
  assert.deepEqual(calls.readDocument, [[account.userId, analysisId]]);
  assert.deepEqual(calls.enqueue, [{ ownerUserId: account.userId, analysisId, format: "MARKDOWN", documentHash, rendererVersion: MARKDOWN_RENDERER_VERSION }]);

  const replay = dependencies({ enqueue: async () => ({ export: { ...queued, status: "READY", contentHash }, created: false }) });
  const replayResponse = await replay.handlers.post(post(), analysisId);
  assert.equal(replayResponse.status, 200);
  assert.deepEqual((await replayResponse.json() as { data: { export: ExportSnapshot } }).data.export.status, "READY");
});

test("export POST accepts PDF and deduplicates through the format-specific renderer version", async () => {
  const { handlers, calls } = dependencies();
  const response = await handlers.post(post(undefined, '{"format":"PDF"}'), analysisId);
  assert.equal(response.status, 202);
  assertPrivateHeaders(response);
  assert.deepEqual(calls.enqueue, [{ ownerUserId: account.userId, analysisId, format: "PDF", documentHash, rendererVersion: PDF_RENDERER_VERSION }]);
});

test("export POST validates IDs, query, body, format, origin and account before touching private data", async () => {
  const { handlers, calls } = dependencies();
  assert.equal((await handlers.post(post(), "bad")).status, 400);
  assert.equal((await handlers.post(post(`http://localhost:3000/api/analyses/${analysisId}/exports?format=MARKDOWN`), analysisId)).status, 400);
  assert.equal((await handlers.post(post(undefined, '{"format":"MARKDOWN","extra":true}'), analysisId)).status, 400);
  assert.equal((await handlers.post(post(undefined, '{"format":"HTML"}'), analysisId)).status, 422);
  assert.equal((await handlers.post(post(undefined, '{"format":"MARKDOWN"}', account.githubUserId, "https://attacker.test"), analysisId)).status, 403);
  assert.equal((await handlers.post(post(undefined, '{"format":"MARKDOWN"}', "github-other-account"), analysisId)).status, 401);
  assert.deepEqual(calls.readDocument, []);
  assert.deepEqual(calls.enqueue, []);
});

test("export POST reports missing and incomplete analysis results without enqueueing", async () => {
  const missing = dependencies({ readDocument: async () => ({ kind: "not-found" }) });
  const missingResponse = await missing.handlers.post(post(), analysisId);
  assert.equal(missingResponse.status, 404);
  assert.match(await missingResponse.text(), /ANALYSIS_NOT_FOUND/);

  const pending = dependencies({ readDocument: async () => ({ kind: "not-ready" }) });
  const pendingResponse = await pending.handlers.post(post(), analysisId);
  assert.equal(pendingResponse.status, 409);
  assert.match(await pendingResponse.text(), /RESULT_NOT_READY/);
  assert.deepEqual(pending.calls.enqueue, []);
});

test("export status is owner and account scoped and rejects unsupported query parameters", async () => {
  const { handlers, calls } = dependencies();
  const response = await handlers.get(get(`http://localhost:3000/api/analyses/${analysisId}/exports/${exportId}`), analysisId, exportId);
  assert.equal(response.status, 200);
  assertPrivateHeaders(response);
  assert.deepEqual(await response.json(), { data: { analysisId, accountKey: account.githubUserId, export: queued } });
  assert.equal((await handlers.get(get(`http://localhost:3000/api/analyses/${analysisId}/exports/${exportId}?x=1`), analysisId, exportId)).status, 400);
  assert.equal((await handlers.get(get(`http://localhost:3000/api/analyses/${analysisId}/exports/${exportId}`, "other-account"), analysisId, exportId)).status, 401);
  assert.deepEqual(calls.find, [[account.userId, analysisId, exportId]]);

  const hidden = dependencies({ find: async () => null });
  const hiddenResponse = await hidden.handlers.get(get(`http://localhost:3000/api/analyses/${analysisId}/exports/${exportId}`), analysisId, exportId);
  assert.equal(hiddenResponse.status, 404);
  assert.match(await hiddenResponse.text(), /EXPORT_NOT_FOUND/);

  const pdf = dependencies({ find: async () => ({ ...queued, format: "PDF" }) });
  const pdfResponse = await pdf.handlers.get(get(`http://localhost:3000/api/analyses/${analysisId}/exports/${exportId}`), analysisId, exportId);
  assert.equal((await pdfResponse.json() as { data: { export: ExportSnapshot } }).data.export.format, "PDF");
});

test("export retry requires a strict same-origin empty JSON object and a failed owner-bound export", async () => {
  const { handlers, calls } = dependencies();
  const url = `http://localhost:3000/api/analyses/${analysisId}/exports/${exportId}/retry`;
  const retryRequest = (body = "{}", origin = "http://localhost:3000") => new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin, Cookie: "sage_session=opaque-session-token", "X-SAGE-Account": account.githubUserId },
    body,
  });
  const response = await handlers.retry(retryRequest(), analysisId, exportId);
  assert.equal(response.status, 202);
  assertPrivateHeaders(response);
  assert.deepEqual(calls.retry, [{ ownerUserId: account.userId, analysisId, exportId }]);
  assert.equal((await handlers.retry(retryRequest('{"force":true}'), analysisId, exportId)).status, 400);
  assert.equal((await handlers.retry(retryRequest("{}", "https://attacker.test"), analysisId, exportId)).status, 403);

  const pdf = dependencies({ retry: async () => ({ ...queued, format: "PDF" }) });
  const pdfResponse = await pdf.handlers.retry(retryRequest(), analysisId, exportId);
  assert.equal((await pdfResponse.json() as { data: { export: ExportSnapshot } }).data.export.format, "PDF");

  const conflict = dependencies({ retry: async () => { const error = new Error("conflict"); error.name = "ExportRetryConflictError"; throw error; } });
  const conflictResponse = await conflict.handlers.retry(retryRequest(), analysisId, exportId);
  assert.equal(conflictResponse.status, 409);
  assert.match(await conflictResponse.text(), /EXPORT_RETRY_CONFLICT/);
});

test("export download returns private attachment headers or distinct not-ready and missing errors", async () => {
  const { handlers, calls } = dependencies();
  const url = `http://localhost:3000/api/analyses/${analysisId}/exports/${exportId}/download`;
  const response = await handlers.download(get(url), analysisId, exportId);
  assert.equal(response.status, 200);
  assertPrivateHeaders(response, false);
  assert.equal(response.headers.get("content-type"), "text/markdown; charset=utf-8");
  assert.equal(response.headers.get("content-disposition"), 'attachment; filename="sage-repo-a1b2c3d.md"');
  assert.equal(await response.text(), "# Canonical export\n");
  assert.deepEqual(calls.download, [[account.userId, analysisId, exportId]]);

  const pending = dependencies({ readDownload: async () => ({ kind: "not-ready" }) });
  const pendingResponse = await pending.handlers.download(get(url), analysisId, exportId);
  assert.equal(pendingResponse.status, 409);
  assert.match(await pendingResponse.text(), /EXPORT_NOT_READY/);
  const missing = dependencies({ readDownload: async () => ({ kind: "not-found" }) });
  const missingResponse = await missing.handlers.download(get(url), analysisId, exportId);
  assert.equal(missingResponse.status, 404);
  assert.match(await missingResponse.text(), /EXPORT_NOT_FOUND/);

  const pdf = dependencies({ readDownload: async () => ({
    kind: "ready", value: { bytes: Buffer.from("%PDF-1.7\n"), filename: "sage-repo-a1b2c3d.pdf", format: "PDF" },
  }) });
  const pdfResponse = await pdf.handlers.download(get(url), analysisId, exportId);
  assert.equal(pdfResponse.status, 200);
  assert.equal(pdfResponse.headers.get("content-type"), "application/pdf");
  assert.equal(pdfResponse.headers.get("content-disposition"), 'attachment; filename="sage-repo-a1b2c3d.pdf"');
});


test("semantic export pins the displayed revision and rejects a stale or unavailable presentation", async () => {
  const semanticModelHash = "c".repeat(64);
  const semantic = { model: {} as never, modelHash: semanticModelHash, revision: 4, overlay: {labels: {}, groups: {}} };
  const {handlers, calls} = dependencies({readSemantic: async () => semantic});
  const response = await handlers.post(post(undefined, JSON.stringify({format:"MARKDOWN",presentationRevision:4})),analysisId);
  assert.equal(response.status,202);
  const queuedInput = calls.enqueue[0] as Record<string, unknown>;
  assert.equal(queuedInput.semanticModelHash,semanticModelHash);
  assert.equal(queuedInput.presentationRevision,4);
  assert.notEqual(queuedInput.rendererVersion,MARKDOWN_RENDERER_VERSION);
  assert.equal((await handlers.post(post(undefined, JSON.stringify({format:"PDF",presentationRevision:3})),analysisId)).status,409);
  assert.equal(calls.enqueue.length,1,"stale revision never enqueues");
  const legacy = dependencies({readSemantic: async () => null});
  assert.equal((await legacy.handlers.post(post(undefined, JSON.stringify({format:"MARKDOWN",presentationRevision:0})),analysisId)).status,409);
  assert.equal((await legacy.handlers.post(post(),analysisId)).status,202,"legacy export remains supported");
});
