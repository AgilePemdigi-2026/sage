import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { SCHEMA_VERSION, type CcmV1 } from "@sage/contracts";
import { extractNodeHttp } from "../packages/documents/src/semantic/node-http.ts";
import type { SemanticInput } from "../packages/documents/src/semantic/model.ts";
import { isSemanticModel } from "../packages/documents/src/semantic/validation.ts";

const ROUTES = "src/http/routes.ts";
function fixture(source: string): SemanticInput {
  const bytes = new TextEncoder().encode(source);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const ccm = {
    schemaVersion: SCHEMA_VERSION,
    snapshot: { repository: "fixture/node-http", branch: "main", commitSha: "a".repeat(40) },
    provenance: { analyzer: { name: "fixture", version: "1" }, resolver: { name: "fixture", version: "1" }, configHash: "b".repeat(64) },
    files: [{ path: ROUTES, language: "typescript", sha256, sizeBytes: bytes.length, status: "processed" }],
    nodes: [], edges: [], limitations: [],
  } as unknown as CcmV1;
  return { ccm, sourceCkgHash: "c".repeat(64), sources: { [ROUTES]: bytes } };
}

test("Node HTTP extracts explicit method/path routes, branch evidence, and labels unknown segments as indicated", () => {
  const source = `
function pathParts(request: Request) { return new URL(request.url).pathname.split("/").filter(Boolean); }
function send(response: Response) { response.end(); }
async function handleBackendRequest(request: Request, response: Response) {
  const method = request.method ?? "GET";
  let parts: string[] = [];
  parts = pathParts(request);
  if (method === "GET" && parts.length === 3 && parts[0] === "api" && parts[1] === "v1" && parts[2] === "health") {
    return send(response);
  }
  if (method === "GET" && parts.length === 3 && parts[0] === "api" && parts[1] === "v1" && (parts[2] === "graph" || parts[2] === "document")) {
    return send(response);
  }
  if (method === "POST" && parts.length === 4 && parts[0] === "api" && parts[1] === "v1" && parts[2] === "analyses") {
    if (!request.body) throw new Error("VALIDATION_ERROR");
    return send(response);
  }
  if (method === "GET" && parts.length === 2 && parts[0] === "public") {
    return send(response);
  }
}
`;
  const input = fixture(source);
  const fragment = extractNodeHttp(input);
  const routes = fragment.nodes.filter(node => node.kind === "step");
  assert.deepEqual(routes.map(node => node.label).sort(), ["GET /api/v1/document", "GET /api/v1/graph", "GET /api/v1/health", "GET /public/:param", "POST /api/v1/analyses/:param"].sort());
  const methodRoutes = new Map(routes.map(node => [node.label, node]));
  assert.equal(methodRoutes.get("GET /api/v1/health")?.confidence, "indicated", "a method/path branch does not establish runtime registration or reachability");
  assert.equal(methodRoutes.get("POST /api/v1/analyses/:param")?.confidence, "indicated");
  assert.equal(fragment.nodes.some(node => node.kind === "actor"), false, "HTTP route source alone does not identify an actor");
  assert.ok(fragment.nodes.some(node => node.kind === "decision" && node.label === "Request validation"));
  assert.ok(fragment.nodes.some(node => node.kind === "outcome" && node.label === "Request rejected"));
  assert.ok(fragment.edges.length > routes.length);
  for (const node of fragment.nodes) for (const span of node.evidence) {
    assert.equal(span.fileSha256, createHash("sha256").update(input.sources[ROUTES]!).digest("hex"));
    assert.ok(span.endByte > span.startByte);
    assert.equal(span.startLine, source.slice(0, Buffer.from(input.sources[ROUTES]!).subarray(0, span.startByte).length).split("\n").length);
  }
  const model = { schemaVersion: "sage-semantic-v1", extractorVersion: "test", sourceCkgHash: input.sourceCkgHash, snapshot: input.ccm.snapshot, ...fragment };
  assert.equal(isSemanticModel(model), true);
  assert.deepEqual(extractNodeHttp(input), fragment, "same source produces stable output");
});

test("Node HTTP ignores unsupported dynamic dispatch and reports the limitation", () => {
  const input = fixture(`
function pathParts(request: Request) { return new URL(request.url).pathname.split("/").filter(Boolean); }
async function handleRequest(request: Request, response: Response) {
  const unrelated = () => { return 1; };
  const method = request.method;
  let parts: string[] = [];
  parts = pathParts(request);
  if (method === lookupMethod(request) && parts.length > 0) response.end();
}
`);
  const fragment = extractNodeHttp(input);
  assert.equal(fragment.nodes.some(node => node.kind === "step"), false);
  assert.deepEqual(fragment.limitations, [{ filePath: ROUTES, reason: "Node HTTP handler detected, but no static method and path guard was recognized; dynamic dispatch is not inferred." }]);
  assert.deepEqual(fragment.frameworks, []);
});

test("Node HTTP does not claim uncalled, unreachable, nested, or contradictory route guards", () => {
  const input = fixture(`
function pathParts(request: Request) { return new URL(request.url).pathname.split("/").filter(Boolean); }
function unrelated(request: Request, response: Response) {
  const method = request.method;
  let parts: string[] = [];
  parts = pathParts(request);
  if (method === "GET" && parts.length === 1 && parts[0] === "unregistered") response.end();
}
async function handleRequest(request: Request, response: Response) {
  const method = request.method;
  const parts = pathParts(request);
  if (method === "GET" && method === "POST" && parts.length === 1 && parts[0] === "conflict") response.end();
  if (method === "GET" && parts.length === 2 && parts[0] === "api" && parts[1] === "safe") {
    return response.end();
    if (!request.body) throw new Error("unreachable decision");
  }
  if (true) {
    if (method === "GET" && parts.length === 1 && parts[0] === "nested") response.end();
  }
  return;
  if (method === "GET" && parts.length === 1 && parts[0] === "after-return") response.end();
}
`);
  const fragment = extractNodeHttp(input);
  assert.deepEqual(fragment.nodes.filter(node => node.kind === "step").map(node => node.label), ["GET /api/safe"]);
  assert.equal(fragment.nodes.some(node => node.kind === "decision" || node.kind === "outcome"), false,
    "unreachable branch details are excluded after an unconditional return");
  assert.ok(fragment.nodes.filter(node => node.kind === "step").every(node => node.confidence === "indicated"));
});

test("unreachable try blocks do not produce routes and redirects are not errors", () => {
  const helper = 'function pathParts(request: Request) { return new URL(request.url).pathname.split("/").filter(Boolean); }';
  const dead = extractNodeHttp(fixture(`${helper}
function handleRequest(request: Request, response: Response) {
  const method = request.method; const parts = pathParts(request);
  return;
  try { if (method === "GET" && parts.length === 1 && parts[0] === "admin") { if (!request.user) throw Error("no"); } } catch {}
}`));
  assert.equal(dead.nodes.length, 0);
  const live = extractNodeHttp(fixture(`${helper}
function handleRequest(request: Request, response: Response) {
  const method = request.method; const parts = pathParts(request);
  if (method === "GET" && parts.length === 1 && parts[0] === "login") {
    if (request.user) return writeRedirect(response, "/home");
  }
}`));
  assert.ok(live.nodes.some(node => node.kind === "outcome" && node.label === "Redirect response"));
  assert.equal(live.nodes.some(node => node.kind === "outcome" && node.label === "Error response"), false);
});
