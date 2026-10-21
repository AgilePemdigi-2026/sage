import assert from "node:assert/strict";
import test from "node:test";
import { createGraphHandlers } from "../apps/web/lib/graphs/handlers.ts";
import type { GraphReadState } from "../apps/web/lib/graphs/types.ts";

const ANALYSIS_ID = "analysis-graph-17";
const readyState = {
  kind: "ready",
  value: {
    analysisId: ANALYSIS_ID,
    ckgSha256: "a".repeat(64),
    configurationHash: "b".repeat(64),
    snapshot: { repository: "acme/service", branch: "main", commitSha: "c".repeat(40) },
    provenance: {
      analyzer: { name: "sage", version: "1" },
      resolver: { name: "sage", version: "1" },
      configHash: "d".repeat(64),
    },
    canonicalCounts: { nodes: 1, edges: 0, containmentEdges: 0, referenceEdges: 0, exactEdges: 0, unresolvedEdges: 0 },
    filteredCounts: { nodes: 1, edges: 0 },
    returnedCounts: { nodes: 1, edges: 0 },
    paginated: false,
    limitations: [],
    graph: {
      repository: "acme/service",
      branch: "main",
      commitSha: "c".repeat(40),
      nodes: [],
      edges: [],
    },
  },
} satisfies GraphReadState;

function fixture(overrides: {
  readSession?: (request: Request) => Promise<{ userId: string; githubUserId: string } | null>;
  readGraph?: (ownerUserId: string, analysisId: string) => Promise<GraphReadState>;
} = {}) {
  const calls: string[] = [];
  const handlers = createGraphHandlers({
    readSession: overrides.readSession ?? (async () => ({ userId: "owner-1", githubUserId: "github-1" })),
    readGraph: overrides.readGraph ?? (async (ownerUserId, analysisId) => {
      calls.push(`${ownerUserId}:${analysisId}`);
      return readyState;
    }),
  });
  return { handlers, calls };
}

function get(url: string, headers?: HeadersInit) {
  return new Request(url, { headers });
}

const graphUrl = `http://localhost/api/analyses/${ANALYSIS_ID}/graph`;

test("graph handler authenticates and binds account header before reading graph data", async () => {
  let reads = 0;
  const handlers = createGraphHandlers({
    readSession: async request => request.headers.get("cookie") === "sage_session=valid"
      ? { userId: "owner-1", githubUserId: "github-1" }
      : null,
    readGraph: async () => { reads += 1; return readyState; },
  });

  const anonymous = await handlers.get(get(graphUrl), ANALYSIS_ID);
  assert.equal(anonymous.status, 401);
  assert.equal((await anonymous.json()).error.code, "AUTH_REQUIRED");
  assert.equal(reads, 0);

  const staleAccount = await handlers.get(get(graphUrl, {
    cookie: "sage_session=valid",
    "x-sage-account": "github-old",
  }), ANALYSIS_ID);
  assert.equal(staleAccount.status, 401);
  assert.equal((await staleAccount.json()).error.code, "AUTH_REQUIRED");
  assert.equal(reads, 0);

  const valid = await handlers.get(get(graphUrl, {
    cookie: "sage_session=valid",
    "x-sage-account": "github-1",
  }), ANALYSIS_ID);
  assert.equal(valid.status, 200);
  assert.equal(reads, 1);
});

test("graph handler rejects malformed ids and every query parameter", async () => {
  let sessions = 0;
  let reads = 0;
  const handlers = createGraphHandlers({
    readSession: async () => { sessions += 1; return { userId: "owner-1", githubUserId: "github-1" }; },
    readGraph: async () => { reads += 1; return readyState; },
  });
  const invalidRequests = [
    ["http://localhost/api/analyses/short/graph", "short"],
    [`${graphUrl}?mode=client`, ANALYSIS_ID],
    [`${graphUrl}?mode=client&mode=client`, ANALYSIS_ID],
    [`${graphUrl}?mode=client&kind=Class`, ANALYSIS_ID],
    [`${graphUrl}?mode=inspector`, ANALYSIS_ID],
    [`${graphUrl}?limit=10`, ANALYSIS_ID],
  ] as const;

  for (const [url, id] of invalidRequests) {
    const response = await handlers.get(get(url), id);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, "INVALID_INPUT");
  }
  assert.equal(sessions, 0);
  assert.equal(reads, 0);
});

test("graph handler envelopes the ready payload with the authenticated account and safe headers", async () => {
  const { handlers, calls } = fixture();
  const response = await handlers.get(get(graphUrl), ANALYSIS_ID);

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(response.headers.get("vary"), "Cookie, X-SAGE-Account");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(calls, [`owner-1:${ANALYSIS_ID}`]);
  const body = await response.json();
  assert.deepEqual(Object.keys(body), ["data"]);
  assert.deepEqual(body.data, { ...readyState.value, accountKey: "github-1" });
});

test("graph handler distinguishes absent analyses and preterminal or non-success results", async () => {
  for (const [state, expectedStatus, expectedCode] of [
    [{ kind: "not-found" }, 404, "ANALYSIS_NOT_FOUND"],
    [{ kind: "not-ready" }, 409, "RESULT_NOT_READY"],
  ] as const) {
    const handlers = createGraphHandlers({
      readSession: async () => ({ userId: "owner-1", githubUserId: "github-1" }),
      readGraph: async () => state as GraphReadState,
    });
    const response = await handlers.get(get(graphUrl), ANALYSIS_ID);
    assert.equal(response.status, expectedStatus);
    assert.equal((await response.json()).error.code, expectedCode);
  }
});

test("session and graph integrity failures stay generic and do not disclose server details", async () => {
  for (const readSession of [
    async () => { throw new Error("database password or private session detail"); },
    async () => ({ userId: "owner-1", githubUserId: "github-1" }),
  ]) {
    const handlers = createGraphHandlers({
      readSession,
      readGraph: async () => { throw new Error("Published graph result is unavailable: /private/storage/snapshot.tar.gz"); },
    });
    const response = await handlers.get(get(graphUrl), ANALYSIS_ID);
    assert.equal(response.status, 503);
    const text = await response.text();
    assert.match(text, /GRAPH_UNAVAILABLE/);
    assert.doesNotMatch(text, /password|private session|Published graph|snapshot\.tar\.gz|storage/);
    assert.match(response.headers.get("cache-control")!, /no-store/);
  }
});
