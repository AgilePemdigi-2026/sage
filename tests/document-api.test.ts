import assert from "node:assert/strict";
import test from "node:test";
import type { ArchitectureDocumentV1 } from "@sage/documents/model";
import { createDocumentHandlers } from "../apps/web/lib/documents/handlers.ts";
import type { DocumentReadState } from "../apps/web/lib/documents/types.ts";

const analysisId = "analysis_doc_123";
const session = { userId: "user-document-15", githubUserId: "github-document-15" };
const contentHash = "a".repeat(64);
const document = { schemaVersion: "sage-add-v1", ckgSha256: "b".repeat(64) } as unknown as ArchitectureDocumentV1;

function handlers(options: {
  session?: typeof session | null;
  state?: DocumentReadState;
  readError?: Error;
} = {}) {
  const readCalls: Array<[string, string]> = [];
  const server = createDocumentHandlers({
    readSession: async () => options.session === undefined ? session : options.session,
    readDocument: async (ownerUserId, id) => {
      readCalls.push([ownerUserId, id]);
      if (options.readError) throw options.readError;
      return options.state ?? { kind: "ready", value: { analysisId, contentHash, document } };
    },
  });
  return { server, readCalls };
}

function request(url = `https://sage.test/api/analyses/${analysisId}/document`, account = session.githubUserId) {
  return new Request(url, { headers: account ? { "X-SAGE-Account": account, cookie: "sage_session=opaque-session-token" } : {} });
}

function assertPrivateHeaders(response: Response) {
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(response.headers.get("vary"), "Cookie, X-SAGE-Account");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.match(response.headers.get("content-type") ?? "", /^application\/json/);
}

test("document API rejects invalid path input and query parameters before reading identity or data", async () => {
  const { server, readCalls } = handlers();
  const invalidId = await server.get(request(), "bad");
  const withQuery = await server.get(request(`https://sage.test/api/analyses/${analysisId}/document?source=1`), analysisId);
  assert.equal(invalidId.status, 400);
  assert.equal(withQuery.status, 400);
  assert.deepEqual(readCalls, []);
});

test("document API requires the cookie session and rejects a mismatched account header", async () => {
  const withoutSession = handlers({ session: null });
  const missing = await withoutSession.server.get(request(), analysisId);
  assert.equal(missing.status, 401);
  assert.deepEqual(withoutSession.readCalls, []);

  const { server, readCalls } = handlers();
  const changedAccount = await server.get(request(undefined, "github-other-account"), analysisId);
  assert.equal(changedAccount.status, 401);
  assert.deepEqual(readCalls, []);
});

test("document API keeps missing and non-success analysis states distinct", async () => {
  const missing = handlers({ state: { kind: "not-found" } });
  const missingResponse = await missing.server.get(request(), analysisId);
  assert.equal(missingResponse.status, 404);
  assert.deepEqual(missing.readCalls, [[session.userId, analysisId]]);

  const pending = handlers({ state: { kind: "not-ready" } });
  const pendingResponse = await pending.server.get(request(), analysisId);
  assert.equal(pendingResponse.status, 409);
  assert.deepEqual(pending.readCalls, [[session.userId, analysisId]]);
});

test("document API returns only canonical data and the active account identity", async () => {
  const { server, readCalls } = handlers();
  const response = await server.get(request(), analysisId);
  assert.equal(response.status, 200);
  assertPrivateHeaders(response);
  assert.deepEqual(await response.json(), {
    data: { analysisId, accountKey: session.githubUserId, contentHash, document },
  });
  assert.deepEqual(readCalls, [[session.userId, analysisId]], "owner comes from the validated cookie session");
});

test("document API converts storage and integrity errors into a safe no-store response", async () => {
  const { server } = handlers({ readError: new Error("/private/storage/root/credentials leaked") });
  const response = await server.get(request(), analysisId);
  assert.equal(response.status, 503);
  assertPrivateHeaders(response);
  const body = await response.text();
  assert.match(body, /DOCUMENT_UNAVAILABLE/);
  assert.doesNotMatch(body, /private\/storage|credentials leaked/);
});
