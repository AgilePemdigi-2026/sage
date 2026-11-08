import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { SCHEMA_VERSION, type CcmNode, type CcmV1 } from "@sage/contracts";
import { evidenceSpan } from "../packages/documents/src/semantic/builder.ts";
import { extractNodeHttp } from "../packages/documents/src/semantic/node-http.ts";
import type { SemanticInput } from "../packages/documents/src/semantic/model.ts";
import { isSemanticModel } from "../packages/documents/src/semantic/validation.ts";

const ROUTES = "src/http/routes.ts";
function fixture(source: string | Record<string, string>): SemanticInput {
  const sourceFiles = typeof source === "string" ? { [ROUTES]: source } : source;
  const sources = Object.fromEntries(Object.entries(sourceFiles).map(([path, text]) => [path, new TextEncoder().encode(text)]));
  const files = Object.entries(sources).map(([path, bytes]) => ({ path, language: "typescript" as const,
    sha256: createHash("sha256").update(bytes).digest("hex"), sizeBytes: bytes.length, status: "processed" as const }));
  const ccm = {
    schemaVersion: SCHEMA_VERSION,
    snapshot: { repository: "fixture/node-http", branch: "main", commitSha: "a".repeat(40) },
    provenance: { analyzer: { name: "fixture", version: "1" }, resolver: { name: "fixture", version: "1" }, configHash: "b".repeat(64) },
    files,
    nodes: [], edges: [], limitations: [],
  } as unknown as CcmV1;
  return { ccm, sourceCkgHash: "c".repeat(64), sources };
}

function declarationRange(source: string, marker: string): { start: number; end: number } {
  const start = source.indexOf(marker), open = source.indexOf("{", start);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}" && --depth === 0) return { start, end: index + 1 };
  }
  throw new Error(`Unclosed test function marker: ${marker}`);
}

function addExactCall(input: SemanticInput, sourcePath: string, sourceMarker: string, sourceName: string,
  targetPath: string, targetMarker: string, targetName: string, callOccurrence = 0): void {
  const source = new TextDecoder().decode(input.sources[sourcePath]!);
  const target = new TextDecoder().decode(input.sources[targetPath]!);
  const sourceRange = declarationRange(source, sourceMarker), targetRange = declarationRange(target, targetMarker);
  const sourceNodeId = `function:${sourcePath}:${sourceName}`, targetNodeId = `function:${targetPath}:${targetName}`;
  const node = (id: string, path: string, name: string, range: { start: number; end: number }): CcmNode => ({
    id, kind: "Function", name, qualifiedName: name, language: "typescript", filePath: path,
    location: evidenceSpan(path, input.sources[path]!, range.start, range.end, "declaration"), parentId: null, origin: "source", signature: null, attributes: {},
  });
  if (!input.ccm.nodes.some(item => item.id === sourceNodeId)) input.ccm.nodes.push(node(sourceNodeId, sourcePath, sourceName, sourceRange));
  if (!input.ccm.nodes.some(item => item.id === targetNodeId)) input.ccm.nodes.push(node(targetNodeId, targetPath, targetName, targetRange));
  const functionStart = source.indexOf(sourceMarker), firstCall = source.indexOf(targetName, functionStart);
  let callAt = firstCall;
  for (let index = 0; index < callOccurrence; index += 1) callAt = source.indexOf(targetName, callAt + targetName.length);
  input.ccm.edges.push({ id: `call:${sourcePath}:${targetPath}:${callAt}`, sourceId: sourceNodeId, targetId: targetNodeId, kind: "CALLS", resolution: "Exact",
    evidence: [evidenceSpan(sourcePath, input.sources[sourcePath]!, callAt, callAt + targetName.length, "reference")], unresolvedReason: null });
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
  const actor = fragment.nodes.find(node => node.kind === "actor");
  assert.equal(actor?.label, "API client", "an explicit HTTP request handler provides a source-backed client boundary");
  assert.ok(fragment.edges.some(edge => edge.source === actor?.id && edge.target === methodRoutes.get("GET /api/v1/health")?.id && edge.label === "sends request"));
  assert.ok(fragment.edges.some(edge => edge.source === methodRoutes.get("GET /api/v1/health")?.id && fragment.nodes.some(node => node.id === edge.target && node.kind === "outcome") && edge.label === "returns"));
  assert.ok(fragment.edges.filter(edge => edge.source === actor?.id).every(edge => edge.confidence === "indicated"), "route mounting uncertainty stays explicit");
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

test("Node HTTP links a statically imported handler to its createServer callback without claiming listen reachability", () => {
  const routes = `
function pathParts(request: Request) { return new URL(request.url).pathname.split("/").filter(Boolean); }
export async function handleRequest(request: Request, response: Response) {
  const method = request.method;
  const parts = pathParts(request);
  if (method === "GET" && parts.length === 2 && parts[0] === "api" && parts[1] === "health") return response.end();
}
`;
  const server = `
import { createServer as makeServer } from "node:http";
import { handleRequest as dispatch } from "./routes.js";
export function createApi() { return makeServer((request, response) => { void dispatch(request, response); }); }
`;
  const result = extractNodeHttp(fixture({ [ROUTES]: routes, "src/http/server.ts": server }));
  const actor = result.nodes.find(node => node.kind === "actor");
  const route = result.nodes.find(node => node.kind === "step" && node.label === "GET /api/health");
  const boundary = result.edges.find(edge => edge.source === actor?.id && edge.target === route?.id);
  assert.ok(boundary);
  assert.ok(boundary.evidence.some(span => span.filePath === "src/http/server.ts"), "the createServer registration is traceable");
  assert.equal(boundary.confidence, "indicated", "server.listen execution and application reachability remain unverified");
  assert.match(boundary.reason, /listener execution.*unverified/u);
  assert.ok(result.limitations.some(item => /server\.listen execution/u.test(item.reason)));

  const wrongParameters = server.replace("dispatch(request, response)", "dispatch(response, request)");
  const unmatched = extractNodeHttp(fixture({ [ROUTES]: routes, "src/http/server.ts": wrongParameters }));
  const unmatchedActor = unmatched.nodes.find(node => node.kind === "actor");
  assert.ok(unmatchedActor?.evidence.every(span => span.filePath !== "src/http/server.ts"),
    "a mismatched callback argument order is not treated as handler registration evidence");
});

test("Node HTTP composes nested route guards, retains every guard span, and rejects contradicted else paths", () => {
  const source = `
function pathParts(request: Request) { return new URL(request.url).pathname.split("/").filter(Boolean); }
async function handleRequest(request: Request, response: Response) {
  const method = request.method;
  const parts = pathParts(request);
  if (method === "GET") {
    if (parts.length === 2 && parts[0] === "api") {
      if (parts[1] === "profile") return response.end();
      if (method === "POST" && parts[1] === "conflict") return response.end();
    }
  }
  if (method === "GET") {
    response.end();
  } else {
    if (method === "GET" && parts.length === 2 && parts[0] === "api" && parts[1] === "excluded") response.end();
  }
}
`;
  const result = extractNodeHttp(fixture(source));
  const routes = result.nodes.filter(node => node.kind === "step");
  assert.deepEqual(routes.map(node => node.label), ["GET /api/profile"]);
  assert.equal(routes[0]!.confidence, "indicated", "method/path source does not prove the handler is registered at runtime");
  const routeEvidence = routes[0]!.evidence[0]!;
  const citedSource = new TextDecoder().decode(new TextEncoder().encode(source).subarray(routeEvidence.startByte, routeEvidence.endByte));
  assert.match(citedSource, /method === "GET"[\s\S]*parts\.length === 2[\s\S]*parts\[1\] === "profile"/u,
    "the route evidence covers each guard needed to establish its method and path");
  assert.ok(result.limitations.some(item => /runtime mounting/u.test(item.reason)));
});

test("Node HTTP follows exact cross-file calls only inside the matched branch and assigns writes to each writer", () => {
  const routePath = ROUTES, submissionPath = "src/services/submission.ts", auditPath = "src/services/audit.ts";
  const fixtureInput = fixture({
    [routePath]: `
function pathParts(request: Request) { return new URL(request.url).pathname.split("/").filter(Boolean); }
async function handleRequest(request: Request, response: Response) {
  const method = request.method;
  const parts = pathParts(request);
  if (method === "POST" && parts.length === 2 && parts[0] === "api" && parts[1] === "submissions") {
    if (request.user) await saveSubmission();
    await auditSubmission();
    return response.end();
  }
}
`,
    [submissionPath]: `export async function saveSubmission() { await db.submissions.create({}); }`,
    [auditPath]: `export async function auditSubmission() { await db.auditLogs.insert({}); }`,
  });
  addExactCall(fixtureInput, routePath, "async function handleRequest", "handleRequest", submissionPath, "export async function saveSubmission", "saveSubmission");
  addExactCall(fixtureInput, routePath, "async function handleRequest", "handleRequest", auditPath, "export async function auditSubmission", "auditSubmission");

  const result = extractNodeHttp(fixtureInput);
  const route = result.nodes.find(node => node.kind === "step" && node.label === "POST /api/submissions");
  const caller = result.nodes.find(node => node.kind === "component" && node.label === "Handle Request Handler");
  const submission = result.nodes.find(node => node.kind === "component" && node.label === "Save Submission");
  const audit = result.nodes.find(node => node.kind === "component" && node.label === "Audit Submission");
  const submissionStore = result.nodes.find(node => node.kind === "store" && node.label === "Submissions");
  const auditStore = result.nodes.find(node => node.kind === "store" && node.label === "Audit Logs");
  assert.ok(route && caller && submission && audit && submissionStore && auditStore);
  const callEdges = result.edges.filter(edge => edge.source === caller.id && edge.label === "memanggil fungsi");
  assert.equal(callEdges.length, 2);
  assert.ok(callEdges.every(edge => edge.confidence === "indicated"), "runtime mounting remains unverified");
  assert.ok(callEdges.find(edge => edge.target === submission.id)?.evidence.some(span => span.filePath === routePath && span.role === "context"),
    "the route condition guarding the service call remains cited");
  const edgeDetails = JSON.stringify({ nodes: result.nodes.map(node => ({ id: node.id, label: node.label, kind: node.kind })), edges: result.edges.map(edge => ({ source: edge.source, target: edge.target, label: edge.label })) });
  assert.ok(result.edges.some(edge => edge.source === submission.id && edge.target === submissionStore.id && edge.label === "menyimpan"), edgeDetails);
  assert.ok(result.edges.some(edge => edge.source === audit.id && edge.target === auditStore.id && edge.label === "menyimpan"), edgeDetails);
  assert.equal(result.edges.some(edge => edge.source === submission.id && edge.target === auditStore.id), false, "sibling helpers are not chained together");
  assert.equal(result.edges.some(edge => edge.source === audit.id && edge.target === submissionStore.id), false, "each writer owns only its own direct store operation");
  assert.equal(result.edges.some(edge => edge.source === route.id && edge.target === submissionStore.id), false, "the route caller does not own a helper's store write");
});

test("Node HTTP omits cross-file effects from false branches, ternaries, callbacks, and terminal tails", () => {
  const routePath = ROUTES, servicePath = "src/services/catalog.ts";
  const sources = {
    [routePath]: `
function pathParts(request: Request) { return new URL(request.url).pathname.split("/").filter(Boolean); }
async function handleRequest(request: Request, response: Response) {
  const method = request.method;
  const parts = pathParts(request);
  if (method === "POST" && parts.length === 2 && parts[0] === "api" && parts[1] === "catalog") {
    if (false) await writeCatalog();
    const skipped = false ? writeCatalog() : null;
    const unused = () => writeCatalog();
    return response.end();
    await writeCatalog();
  }
}
`,
    [servicePath]: `export async function writeCatalog() { if (true) { return; } await db.catalog.create({}); }`,
  };
  const fixtureInput = fixture(sources);
  addExactCall(fixtureInput, routePath, "async function handleRequest", "handleRequest", servicePath, "export async function writeCatalog", "writeCatalog", 0);
  addExactCall(fixtureInput, routePath, "async function handleRequest", "handleRequest", servicePath, "export async function writeCatalog", "writeCatalog", 1);
  addExactCall(fixtureInput, routePath, "async function handleRequest", "handleRequest", servicePath, "export async function writeCatalog", "writeCatalog", 2);
  addExactCall(fixtureInput, routePath, "async function handleRequest", "handleRequest", servicePath, "export async function writeCatalog", "writeCatalog", 3);
  const result = extractNodeHttp(fixtureInput);
  assert.ok(result.nodes.some(node => node.kind === "step" && node.label === "POST /api/catalog"));
  assert.equal(result.nodes.some(node => node.kind === "component" && node.label === "Write Catalog"), false,
    "false branches, callback values and code after a terminal return are never treated as calls");
  assert.equal(result.nodes.some(node => node.kind === "store" && node.label === "Catalog"), false,
    "a store call after an unconditional return in the helper is unreachable");
});

test("Node HTTP omits false-loop calls and writes in unreachable for-loop increments", () => {
  const routePath = ROUTES, servicePath = "src/services/catalog.ts";
  const source = fixture({
    [routePath]: `
function pathParts(request: Request) { return new URL(request.url).pathname.split("/").filter(Boolean); }
async function handleRequest(request: Request, response: Response) {
  const method = request.method;
  const parts = pathParts(request);
  if (method === "POST" && parts.length === 2 && parts[0] === "api" && parts[1] === "catalog") {
    while (false) await writeCatalog();
    await writeCatalog();
    return response.end();
  }
}
`,
    [servicePath]: `export async function writeCatalog() {
  for (; true; await db.catalog.create({})) { return; }
}`,
  });
  addExactCall(source, routePath, "async function handleRequest", "handleRequest", servicePath, "export async function writeCatalog", "writeCatalog", 0);
  addExactCall(source, routePath, "async function handleRequest", "handleRequest", servicePath, "export async function writeCatalog", "writeCatalog", 1);
  const result = extractNodeHttp(source);
  assert.ok(result.nodes.some(node => node.kind === "component" && node.label === "Write Catalog"),
    "the direct call after the false loop is still followed");
  assert.equal(result.nodes.some(node => node.kind === "store" && node.label === "Catalog"), false,
    "the service write in a for-loop increment is unreachable because its body returns");
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

test("Node HTTP does not claim uncalled, unreachable, or contradictory route guards", () => {
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
  assert.deepEqual(fragment.nodes.filter(node => node.kind === "step").map(node => node.label).sort(), ["GET /api/safe", "GET /nested"].sort(),
    "a nested method/path guard is recognized when its branch is reachable");
  assert.equal(fragment.nodes.some(node => node.kind === "decision"), false,
    "unreachable branch decisions are excluded after an unconditional return");
  assert.equal(fragment.nodes.some(node => node.kind === "outcome" && node.label === "Request rejected"), false,
    "the unreachable rejection branch is not presented as a route outcome");
  assert.ok(fragment.nodes.some(node => node.kind === "outcome" && node.label === "Response returned"),
    "a reachable direct response is included in the route flow");
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
