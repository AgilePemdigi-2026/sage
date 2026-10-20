import assert from "node:assert/strict";
import test from "node:test";
import { analyzeReferences } from "@sage/analyzer-js";
import { validateCcm, type CcmEdge, type CcmSnapshot } from "@sage/contracts";

const snapshot: CcmSnapshot = {
  repository: "AgilePemdigi-2026/sage",
  branch: "codex/12-js-ts-resolver",
  commitSha: "d".repeat(40),
};
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const bytes = (value: string) => encoder.encode(value);

function edgeBetween(result: Awaited<ReturnType<typeof analyzeReferences>>, fromName: string, toName: string, kind: CcmEdge["kind"]): CcmEdge | undefined {
  assert.ok(result.ccm);
  const from = result.ccm.nodes.find(node => node.qualifiedName === fromName && node.origin === "source");
  const to = result.ccm.nodes.find(node => node.qualifiedName === toName && node.origin === "source");
  if (!from || !to) return undefined;
  return result.ccm.edges.find(edge => edge.sourceId === from.id && edge.targetId === to.id && edge.kind === kind);
}
function unresolvedEdge(result: Awaited<ReturnType<typeof analyzeReferences>>, fromName: string, observed: string, kind: CcmEdge["kind"], reason: CcmEdge["unresolvedReason"]): CcmEdge | undefined {
  assert.ok(result.ccm);
  const from = result.ccm.nodes.find(node => node.qualifiedName === fromName && node.origin === "source");
  if (!from) return undefined;
  return result.ccm.edges.find(edge => {
    const target = result.ccm!.nodes.find(node => node.id === edge.targetId);
    return edge.sourceId === from.id && edge.kind === kind && edge.resolution === "Unresolved" &&
      edge.unresolvedReason === reason && target?.kind === "UnresolvedReference" && target.attributes.observedExpression?.toString().includes(observed);
  });
}
function assertEvidence(result: Awaited<ReturnType<typeof analyzeReferences>>, edge: CcmEdge, snippet: string, sourcePath: string): void {
  assert.ok(result.ccm);
  const evidence = edge.evidence[0];
  assert.ok(evidence);
  assert.equal(evidence.filePath, sourcePath);
  const source = result.ccm.files.find(file => file.path === sourcePath);
  assert.ok(source);
  const text = sourcesForResult.get(sourcePath);
  assert.ok(text);
  assert.ok(decoder.decode(text.subarray(evidence.startByte, evidence.endByte)).includes(snippet));
}

let sourcesForResult = new Map<string, Uint8Array>();
function analyze(sources: Record<string, Uint8Array>, configurationSources?: Record<string, Uint8Array>) {
  sourcesForResult = new Map(Object.entries(sources));
  return analyzeReferences({ snapshot, sources, ...(configurationSources ? { configurationSources } : {}) });
}

test("ESM imports, named calls, shadowing, dynamic loads, and missing modules carry conservative evidence", () => {
  const sources = {
    "src/format.js": bytes([
      "export function normalize(value) { return value.trim(); }",
      "export function exercise(target) { return target.run(); }",
    ].join("\r\n")),
    "src/app.js": bytes([
      "import { normalize, exercise } from './format.js';",
      "import { unavailable } from './missing-module.js';",
      "export function render(value) { return normalize(value); }",
      "export function invoke(target) { return exercise(target); }",
      "export function shadowed(normalize) { return normalize('local'); }",
      "export function useUnavailable() { return unavailable(); }",
      "export async function load(name) { return import(name); }",
      "export function escape() { return require('../../../etc/passwd'); }",
      "throw new Error('source must never execute');",
    ].join("\r\n")),
  };
  const result = analyze(sources);
  assert.ok(result.ccm, result.errorCode ?? "missing CCM");
  assert.equal(validateCcm(result.ccm, sources).ok, true);

  const renderCall = edgeBetween(result, "src/app.js.render", "src/format.js.normalize", "CALLS");
  const invokeCall = edgeBetween(result, "src/app.js.invoke", "src/format.js.exercise", "CALLS");
  assert.equal(renderCall?.resolution, "Exact");
  assert.equal(invokeCall?.resolution, "Exact");
  assert.ok(edgeBetween(result, "src/app.js", "src/format.js", "IMPORTS"));
  assert.ok(unresolvedEdge(result, "src/format.js.exercise", "target.run", "CALLS", "UNKNOWN_RECEIVER"));
  assert.ok(unresolvedEdge(result, "src/app.js.shadowed", "normalize", "CALLS", "UNKNOWN_RECEIVER"));
  assert.ok(unresolvedEdge(result, "src/app.js.load", "import(name)", "IMPORTS", "DYNAMIC_LOAD"));
  assert.ok(unresolvedEdge(result, "src/app.js.useUnavailable", "unavailable", "CALLS", "EXTERNAL_DEPENDENCY"));
  const missingModule = unresolvedEdge(result, "src/app.js", "missing-module.js", "IMPORTS", "EXTERNAL_DEPENDENCY");
  assert.ok(missingModule);
  assert.ok(unresolvedEdge(result, "src/app.js.escape", "../../../etc/passwd", "IMPORTS", "UNSUPPORTED_CONSTRUCT"));
  assertEvidence(result, renderCall!, "normalize", "src/app.js");
  assertEvidence(result, missingModule, "missing", "src/app.js");
  assert.equal((globalThis as Record<string, unknown>).__SAGE_SOURCE_CANARY__, undefined);
  assert.equal(result.status, "partial");
});

test("TS relative .js mapping, inheritance, implementation, type references, calls, construction, and members resolve", () => {
  const sources = {
    "src/model.ts": bytes([
      "export interface Payload { value: string; }",
      "export class Base { label = 'base'; }",
      "export function describe(value: string): string { return value; }",
    ].join("\n")),
    "src/endpoint.ts": bytes([
      "import { Payload, Base, describe } from './model.js';",
      "export class Endpoint extends Base implements Payload {",
      "  value = '';",
      "  static make() { return new Endpoint(); }",
      "  handle(input: Payload): string { this.value = input.value; return describe(input.value); }",
      "}",
      "export function create() { return Endpoint.make(); }",
    ].join("\r\n")),
  };
  const result = analyze(sources);
  assert.ok(result.ccm, result.errorCode ?? "missing CCM");
  assert.equal(validateCcm(result.ccm, sources).ok, true);
  assert.ok(edgeBetween(result, "src/endpoint.ts.Endpoint", "src/model.ts.Base", "EXTENDS"));
  assert.ok(edgeBetween(result, "src/endpoint.ts.Endpoint", "src/model.ts.Payload", "IMPLEMENTS"));
  assert.ok(edgeBetween(result, "src/endpoint.ts.Endpoint.handle", "src/model.ts.Payload", "TYPE_REFERENCES"));
  const call = edgeBetween(result, "src/endpoint.ts.Endpoint.handle", "src/model.ts.describe", "CALLS");
  assert.equal(call?.resolution, "Exact");
  assert.ok(edgeBetween(result, "src/endpoint.ts.Endpoint.handle", "src/endpoint.ts.Endpoint.value", "WRITES"));
  assert.ok(edgeBetween(result, "src/endpoint.ts.Endpoint.handle", "src/model.ts.Payload.value", "READS"));
  assert.ok(edgeBetween(result, "src/endpoint.ts.Endpoint.make", "src/endpoint.ts.Endpoint", "INSTANTIATES"));
  assert.ok(edgeBetween(result, "src/endpoint.ts.create", "src/endpoint.ts.Endpoint.make", "CALLS"));
  assert.ok(edgeBetween(result, "src/endpoint.ts", "src/model.ts", "IMPORTS"));
  assertEvidence(result, call!, "describe", "src/endpoint.ts");
});

test("CommonJS static require and exports connect only declarations named by source", () => {
  const sources = {
    "src/legacy.cjs": bytes([
      "function parse(value) { return value; }",
      "exports.parse = parse;",
    ].join("\n")),
    "src/main.cjs": bytes([
      "const { parse } = require('./legacy.cjs');",
      "function run(value) { return parse(value); }",
      "module.exports = { run };",
    ].join("\n")),
  };
  const result = analyze(sources);
  assert.ok(result.ccm, result.errorCode ?? "missing CCM");
  assert.equal(validateCcm(result.ccm, sources).ok, true);
  assert.ok(edgeBetween(result, "src/main.cjs", "src/legacy.cjs", "IMPORTS"));
  assert.ok(edgeBetween(result, "src/main.cjs", "src/legacy.cjs.parse", "IMPORTS"));
  assert.ok(edgeBetween(result, "src/main.cjs.run", "src/legacy.cjs.parse", "CALLS"));
  assert.ok(edgeBetween(result, "src/legacy.cjs", "src/legacy.cjs.parse", "EXPORTS"));
  assert.ok(edgeBetween(result, "src/main.cjs", "src/main.cjs.run", "EXPORTS"));
});

test("mutated, shadowed, nested-this, and replaced CommonJS references never become Exact", () => {
  const sources = {
    "src/lib.ts": bytes([
      "export function work() { return 1; }",
      "export function mutable() { return 1; }",
      "mutable = replacement;",
      "export class A { work() { return 1; } static go() { return 1; } nestedThis() { function inner() { return this.work(); } return inner(); } objectThis() { const obj = { f() { this.work(); } }; return obj; } objectArrowThis() { const obj = { f: () => this.work() }; return obj; } }",
      "export class Mutated { static run() {} }",
      "Mutated.run = replacement;",
    ].join("\n")),
    "src/app.ts": bytes([
      "import { work, mutable, A, Mutated } from './lib.js';",
      "import * as ns from './lib.js';",
      "const instance = new A();",
      "export function shadowed(work: unknown) { return work(); }",
      "export function nested() { function work() { return 2; } return work(); }",
      "export function shadowedNamespace(ns: unknown) { return ns.work(); }",
      "export function shadowedInstance(instance: unknown) { return instance.work(); }",
      "export function reassignedParameter(value: A) { value = replacement; return value.work(); }",
      "export function changedStatic() { A.go = replacement; return A.go(); }",
      "export function changedImport() { return mutable(); }",
      "export function destructuredMutation() { [work] = [replacement]; return work(); }",
      "export function changedNamespace() { const local = require('./lib.js'); local.work = replacement; return local.work(); }",
      "export function useNamespace() { return ns.work(); }",
      "export function useInstance() { return instance.work(); }",
      "export function useMutatedRemoteStatic() { return Mutated.run(); }",
    ].join("\n")),
    "src/legacy.cjs": bytes([
      "function stale() { return true; }",
      "module.exports = { stale };",
      "module.exports = {};",
      "function local() {}",
      "function fakeRequire(require) { return require('./lib.ts'); }",
      "function fakeExports(exports) { exports.local = local; }",
    ].join("\n")),
    "src/overwritten.cjs": bytes([
      "function work() {}",
      "exports.work = work;",
      "exports.work = unknown;",
    ].join("\n")),
    "src/use-legacy.cjs": bytes([
      "const { stale } = require('./legacy.cjs');",
      "const overwritten = require('./overwritten.cjs');",
      "function run() { return stale(); }",
      "function callOverwritten() { return overwritten.work(); }",
    ].join("\n")),
  };
  const result = analyze(sources);
  assert.ok(result.ccm, result.errorCode ?? "missing CCM");
  assert.equal(validateCcm(result.ccm, sources).ok, true);
  const unresolved = (from: string, observed: string, kind: CcmEdge["kind"] = "CALLS") =>
    unresolvedEdge(result, from, observed, kind, "UNKNOWN_RECEIVER");
  assert.ok(unresolved("src/app.ts.shadowed", "work"));
  assert.ok(unresolved("src/app.ts.nested", "work"));
  assert.ok(unresolved("src/app.ts.shadowedNamespace", "ns.work"));
  assert.ok(unresolved("src/app.ts.shadowedInstance", "instance.work"));
  assert.ok(unresolved("src/app.ts.reassignedParameter", "value.work"));
  assert.ok(unresolved("src/app.ts.changedStatic", "A.go"));
  assert.ok(unresolved("src/app.ts.changedImport", "mutable"));
  assert.ok(unresolved("src/app.ts.destructuredMutation", "work"));
  assert.ok(unresolved("src/app.ts.changedNamespace", "local.work"));
  assert.ok(unresolved("src/lib.ts.A.nestedThis", "this.work"));
  assert.ok(unresolved("src/lib.ts.A.objectThis", "this.work"));
  assert.ok(unresolved("src/app.ts.useMutatedRemoteStatic", "Mutated.run"));
  assert.ok(unresolved("src/use-legacy.cjs.callOverwritten", "overwritten.work"));
  assert.ok(!edgeBetween(result, "src/use-legacy.cjs.run", "src/legacy.cjs.stale", "CALLS"));
  assert.ok(unresolvedEdge(result, "src/use-legacy.cjs", "stale", "IMPORTS", "UNKNOWN_RECEIVER"));
  assert.ok(unresolvedEdge(result, "src/legacy.cjs.fakeRequire", "require", "CALLS", "UNKNOWN_RECEIVER"));
  assert.ok(!edgeBetween(result, "src/legacy.cjs", "src/legacy.cjs.local", "EXPORTS"));
  assert.ok(edgeBetween(result, "src/app.ts.useNamespace", "src/lib.ts.work", "CALLS"));
  assert.ok(edgeBetween(result, "src/app.ts.useInstance", "src/lib.ts.A.work", "CALLS"));
  assert.ok(edgeBetween(result, "src/lib.ts.A.objectArrowThis", "src/lib.ts.A.work", "CALLS"));
});

test("tsconfig baseUrl/paths are resolved from supplied bytes and included in provenance", () => {
  const sources = {
    "src/core.ts": bytes("export function run() { return 'ok'; }\n"),
    "src/app.ts": bytes("import { run } from '@core';\nexport function main() { return run(); }\n"),
  };
  const config = { "tsconfig.json": bytes(JSON.stringify({ extends: "./tsconfig.base.json", compilerOptions: { baseUrl: ".", paths: { "@*": ["src/*"] } } })) };
  const result = analyze(sources, config);
  assert.ok(result.ccm, result.errorCode ?? "missing CCM");
  assert.ok(edgeBetween(result, "src/app.ts", "src/core.ts.run", "IMPORTS"));
  assert.ok(edgeBetween(result, "src/app.ts.main", "src/core.ts.run", "CALLS"));
  assert.ok(result.ccm.limitations.some(item => item.path === null && item.reason.includes("extends")));
  const reordered = analyze(Object.fromEntries(Object.entries(sources).reverse()), config);
  assert.equal(reordered.canonicalJson, result.canonicalJson);
  assert.equal(reordered.contentSha256, result.contentSha256);
  const changed = analyze(sources, { "tsconfig.json": bytes(JSON.stringify({ compilerOptions: { baseUrl: "src", paths: { "@*": ["missing/*"] } } })) });
  assert.notEqual(changed.ccm?.provenance.configHash, result.ccm.provenance.configHash);

  const absolute = analyze(sources, { "tsconfig.json": bytes(JSON.stringify({ compilerOptions: { baseUrl: "/", paths: { "@*": ["/src/*"] } } })) });
  assert.ok(absolute.ccm);
  assert.ok(!edgeBetween(absolute, "src/app.ts", "src/core.ts.run", "IMPORTS"));
  assert.ok(unresolvedEdge(absolute, "src/app.ts", "@core", "IMPORTS", "EXTERNAL_DEPENDENCY"));
  assert.ok(absolute.ccm.limitations.some(item => item.path === null && item.reason.includes("supported JSON/baseUrl/paths")));

  const oversized = analyze(sources, { "tsconfig.json": bytes(" ".repeat(1024 * 1024 + 1)) });
  assert.ok(oversized.ccm);
  assert.ok(oversized.ccm.limitations.some(item => item.path === null && item.reason.includes("1 MiB")));
});

test("ambiguous extensionless modules remain unresolved and evidence keeps BOM/CRLF UTF-8 byte offsets", () => {
  const source = "\uFEFFexport function helper() { return true; }\r\nexport function café() { return helper(); }\r\n";
  const sources = {
    "src/app.ts": bytes(`import './duplicate';\r\n${source}`),
    "src/duplicate.ts": bytes("export class TS {}\n"),
    "src/duplicate.js": bytes("export class JS {}\n"),
  };
  const result = analyze(sources);
  assert.ok(result.ccm, result.errorCode ?? "missing CCM");
  assert.equal(validateCcm(result.ccm, sources).ok, true);
  const ambiguous = unresolvedEdge(result, "src/app.ts", "duplicate", "IMPORTS", "AMBIGUOUS_SYMBOL");
  assert.ok(ambiguous);
  const call = edgeBetween(result, "src/app.ts.café", "src/app.ts.helper", "CALLS");
  assert.ok(call);
  const evidence = call.evidence[0]!;
  const callStart = Buffer.byteLength("import './duplicate';\r\n\uFEFFexport function helper() { return true; }\r\nexport function café() { return ", "utf8");
  assert.equal(evidence.startByte, callStart);
  assertEvidence(result, call, "helper", "src/app.ts");
  const reversed = analyze(Object.fromEntries(Object.entries(sources).reverse()));
  assert.equal(reversed.canonicalJson, result.canonicalJson);
});
