import assert from "node:assert/strict";
import test from "node:test";
import { createInspectorHandlers } from "../apps/web/lib/graphs/inspector-handlers.ts";
import type { NodeInspectorReadState, SourceReadState } from "../apps/web/lib/graphs/inspector-types.ts";

const analysisId = "analysis-node-19";
const nodeId = `node_${"a".repeat(64)}`;
const fileId = `file-${"b".repeat(64)}`;
const bindings = {
  analysisId,
  ckgSha256: "c".repeat(64),
  configurationHash: "d".repeat(64),
  snapshot: { repository: "acme/service", branch: "main", commitSha: "e".repeat(40) },
};
const nodeState: NodeInspectorReadState = {
  kind: "ready",
  value: {
    ...bindings,
    node: {
      id: nodeId,
      kind: "Function",
      name: "run",
      qualifiedName: "run",
      language: "typescript",
      filePath: "src/run.ts",
      location: null,
      parentId: null,
      origin: "source",
      signature: "run(): void",
    },
    incoming: [],
    outgoing: [],
    files: [{ id: fileId, path: "src/run.ts", sha256: "f".repeat(64), sizeBytes: 10 }],
  },
};
const sourceState: SourceReadState = {
  kind: "ready",
  value: {
    ...bindings,
    file: { id: fileId, path: "src/run.ts", sha256: "f".repeat(64), sizeBytes: 10 },
    startLine: 1,
    endLine: 2,
    totalLines: 3,
    text: "one\r\ntwo\r\n",
  },
};

function fixture(options: {
  session?: { userId: string; githubUserId: string } | null;
  node?: NodeInspectorReadState;
  source?: SourceReadState;
  throwNode?: Error;
  throwSource?: Error;
} = {}) {
  const sessions: string[] = [];
  const reads: Array<{ kind: string; values: string[] }> = [];
  const handlers = createInspectorHandlers({
    readSession: async request => {
      sessions.push(request.url);
      return options.session === undefined ? { userId: "owner-19", githubUserId: "github-19" } : options.session;
    },
    readNode: async (owner, analysis, node) => {
      reads.push({ kind: "node", values: [owner, analysis, node] });
      if (options.throwNode) throw options.throwNode;
      return options.node ?? nodeState;
    },
    readSource: async (owner, analysis, file, start, end) => {
      reads.push({ kind: "source", values: [owner, analysis, file, String(start), String(end)] });
      if (options.throwSource) throw options.throwSource;
      return options.source ?? sourceState;
    },
  });
  return { handlers, sessions, reads };
}

function request(path: string, query = "", account = "github-19") {
  return new Request(`https://sage.test/api/analyses/${analysisId}${path}${query}`, {
    headers: account ? { "X-SAGE-Account": account, cookie: "sage_session=opaque-session-token" } : {},
  });
}

function assertPrivateHeaders(response: Response) {
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(response.headers.get("vary"), "Cookie, X-SAGE-Account");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.match(response.headers.get("content-type") ?? "", /^application\/json/);
}

test("inspector handlers bind authenticated account identity and reject stale accounts before storage reads", async () => {
  const noSession = fixture({ session: null });
  const anonymous = await noSession.handlers.getNode(request(`/nodes/${nodeId}`, "", ""), analysisId, nodeId);
  assert.equal(anonymous.status, 401);
  assert.deepEqual(noSession.reads, []);

  const stale = fixture();
  const staleResponse = await stale.handlers.getSource(request(`/files/${fileId}/source`, "?startLine=1&endLine=2", "github-old"), analysisId, fileId);
  assert.equal(staleResponse.status, 401);
  assert.deepEqual(stale.reads, []);

  const current = fixture();
  const nodeResponse = await current.handlers.getNode(request(`/nodes/${nodeId}`), analysisId, nodeId);
  assert.equal(nodeResponse.status, 200);
  assertPrivateHeaders(nodeResponse);
  assert.deepEqual((await nodeResponse.json()).data, { ...nodeState.value, accountKey: "github-19" });
  assert.deepEqual(current.reads, [{ kind: "node", values: ["owner-19", analysisId, nodeId] }]);

  const sourceResponse = await current.handlers.getSource(request(`/files/${fileId}/source`, "?startLine=1&endLine=2"), analysisId, fileId);
  assert.equal(sourceResponse.status, 200);
  assertPrivateHeaders(sourceResponse);
  assert.deepEqual((await sourceResponse.json()).data, { ...sourceState.value, accountKey: "github-19" });
  assert.deepEqual(current.reads.at(-1), { kind: "source", values: ["owner-19", analysisId, fileId, "1", "2"] });
});

test("inspector handlers reject malformed identifiers and source query shapes before session or data access", async () => {
  const { handlers, sessions, reads } = fixture();
  const badNodeId = await handlers.getNode(request(`/nodes/${nodeId}`), analysisId, "../node");
  assert.equal(badNodeId.status, 400);
  assert.equal((await badNodeId.json()).error.code, "INVALID_INPUT");

  const invalidQueries = [
    "?startLine=1&endLine=2&extra=1",
    "?startLine=1&startLine=2&endLine=2",
    "?startLine=0&endLine=2",
    "?startLine=01&endLine=2",
    "?startLine=x&endLine=2",
    "?startLine=3&endLine=2",
    "?startLine=1&endLine=201",
    "?startLine=1e0&endLine=2",
    "?startLine=9007199254740992&endLine=9007199254740992",
  ];
  for (const query of invalidQueries) {
    const response = await handlers.getSource(request(`/files/${fileId}/source`, query), analysisId, fileId);
    assert.equal(response.status, 400, query);
    assert.equal((await response.json()).error.code, "INVALID_INPUT");
  }
  assert.equal(sessions.length, 0);
  assert.deepEqual(reads, []);
});

test("inspector handlers distinguish missing analyses, not-ready results, nodes, files, and bounded-source failures", async () => {
  for (const [state, expectedStatus, expectedCode] of [
    [{ kind: "not-found" }, 404, "ANALYSIS_NOT_FOUND"],
    [{ kind: "not-ready" }, 409, "RESULT_NOT_READY"],
    [{ kind: "item-not-found" }, 404, "NODE_NOT_FOUND"],
  ] as const) {
    const { handlers } = fixture({ node: state as NodeInspectorReadState });
    const response = await handlers.getNode(request(`/nodes/${nodeId}`), analysisId, nodeId);
    assert.equal(response.status, expectedStatus);
    assert.equal((await response.json()).error.code, expectedCode);
    assertPrivateHeaders(response);
  }

  for (const [state, expectedStatus, expectedCode] of [
    [{ kind: "not-found" }, 404, "ANALYSIS_NOT_FOUND"],
    [{ kind: "not-ready" }, 409, "RESULT_NOT_READY"],
    [{ kind: "item-not-found" }, 404, "FILE_NOT_FOUND"],
    [{ kind: "range-invalid" }, 400, "INVALID_INPUT"],
    [{ kind: "range-too-large" }, 413, "SOURCE_RANGE_TOO_LARGE"],
  ] as const) {
    const { handlers } = fixture({ source: state as SourceReadState });
    const response = await handlers.getSource(request(`/files/${fileId}/source`, "?startLine=1&endLine=2"), analysisId, fileId);
    assert.equal(response.status, expectedStatus);
    assert.equal((await response.json()).error.code, expectedCode);
    assertPrivateHeaders(response);
  }
});

test("integrity and storage errors stay generic and never reveal filesystem details", async () => {
  const nodeFailure = fixture({ throwNode: new Error("/private/storage/root and credentials") });
  const nodeResponse = await nodeFailure.handlers.getNode(request(`/nodes/${nodeId}`), analysisId, nodeId);
  assert.equal(nodeResponse.status, 503);
  const nodeBody = await nodeResponse.text();
  assert.match(nodeBody, /NODE_INSPECTOR_UNAVAILABLE/);
  assert.doesNotMatch(nodeBody, /private\/storage|credentials/);
  assertPrivateHeaders(nodeResponse);

  const sourceFailure = fixture({ throwSource: new Error("/private/storage/archive.tar.gz") });
  const sourceResponse = await sourceFailure.handlers.getSource(request(`/files/${fileId}/source`, "?startLine=1&endLine=2"), analysisId, fileId);
  assert.equal(sourceResponse.status, 503);
  const sourceBody = await sourceResponse.text();
  assert.match(sourceBody, /SOURCE_UNAVAILABLE/);
  assert.doesNotMatch(sourceBody, /private\/storage|archive\.tar\.gz/);
  assertPrivateHeaders(sourceResponse);
});
