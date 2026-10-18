import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { analyzeDeclarations, parseSource } from "@sage/analyzer-js";
import { validateCcm, type CcmSnapshot } from "@sage/contracts";

const snapshot: CcmSnapshot = {
  repository: "AgilePemdigi-2026/sage",
  branch: "feat/33-js-ts-declarations",
  commitSha: "c".repeat(40),
};
const utf8 = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function mapSource(path: string, text: string): Record<string, Uint8Array> {
  return { [path]: utf8.encode(text) };
}

test("JS/TS declaration adapter keeps the probe API and emits nodes matching oracle evidence", async () => {
  const manifest = JSON.parse(await readFile(new URL("./fixtures/manifest.json", import.meta.url), "utf8")) as {
    files: Array<{ path: string; language: string | null; syntaxValid: boolean | null }>;
    oracles: Array<{
      path: string;
      kind: string;
      target: string;
      snippet: string;
      evidence: { startByte: number; endByte: number };
      role: string;
    }>;
  };
  const sourceEntries = await Promise.all(manifest.files
    .filter((file) => file.language === "javascript" || file.language === "typescript")
    .map(async (file) => [`tests/fixtures/${file.path}`, new Uint8Array(await readFile(new URL(`./fixtures/${file.path}`, import.meta.url)))] as const));
  const sources = Object.fromEntries(sourceEntries);
  const result = analyzeDeclarations({ snapshot, sources });

  assert.equal(result.status, "partial", "the fixtures include invalid syntax and explicitly unsupported dynamic constructs");
  assert.equal(result.errorCode, null);
  assert.ok(result.ccm);
  assert.ok(result.canonicalJson);
  assert.ok(result.contentSha256);
  assert.equal(result.ccm.edges.length, 0, "declaration extraction must not invent resolver edges");
  assert.equal(validateCcm(result.ccm, sources).ok, true);

  for (const oracle of manifest.oracles.filter((item) =>
    item.role === "declaration" && ["Class", "Interface", "Function"].includes(item.kind) && sources[`tests/fixtures/${item.path}`] !== undefined)) {
    const path = `tests/fixtures/${oracle.path}`;
    const node = result.ccm.nodes.find((item) => item.filePath === path && item.kind === oracle.kind && item.name === oracle.target);
    assert.ok(node?.location, `missing ${oracle.kind} ${oracle.target} from ${oracle.path}`);
    assert.ok(node.location.startByte <= oracle.evidence.startByte, `${oracle.target} node must contain oracle start`);
    assert.ok(node.location.endByte >= oracle.evidence.endByte, `${oracle.target} node must contain oracle end`);
    const declaration = decoder.decode(sources[path]!.subarray(node.location.startByte, node.location.endByte));
    assert.ok(declaration.includes(oracle.snippet), `${oracle.target} node evidence must include the source oracle snippet`);
  }

  const reversed = analyzeDeclarations({ snapshot, sources: Object.fromEntries([...sourceEntries].reverse()) });
  assert.equal(reversed.canonicalJson, result.canonicalJson, "source map enumeration order must not affect canonical CCM");
  assert.equal(reversed.contentSha256, result.contentSha256);

  const probe = parseSource('throw new Error("MUST_NOT_EXECUTE"); export class Example {}', "example.ts");
  assert.equal(probe.valid, true);
  assert.ok(probe.statementKinds.includes("ClassDeclaration"));
});

test("declaration evidence is byte-accurate across BOM, CRLF, and multibyte Unicode", () => {
  const source = "\uFEFFexport class Café {\r\n  [\"judul\"] = \"arsitektur 😀\";\r\n  résumé(): string { return \"é\"; }\r\n}\r\n" +
    "export interface Visitável {\r\n  nama: string;\r\n  kunjungi(id: number): void;\r\n}\r\n" +
    "export function café() { return \"é\"; }\r\n";
  const bytes = utf8.encode(source);
  const path = "src/unicode.ts";
  const result = analyzeDeclarations({ snapshot, sources: { [path]: bytes } });

  assert.equal(result.status, "complete");
  assert.ok(result.ccm);
  assert.equal(validateCcm(result.ccm, { [path]: bytes }).ok, true);
  const moduleNode = result.ccm.nodes.find((node) => node.kind === "Module");
  assert.equal(moduleNode?.location?.startByte, 0, "the module evidence includes BOM bytes");
  assert.equal(moduleNode?.location?.endByte, bytes.byteLength);

  const classNode = result.ccm.nodes.find((node) => node.kind === "Class" && node.name === "Café");
  const propertyNode = result.ccm.nodes.find((node) => node.kind === "Property" && node.name === "judul");
  const methodNode = result.ccm.nodes.find((node) => node.kind === "Method" && node.name === "résumé");
  const interfaceNode = result.ccm.nodes.find((node) => node.kind === "Interface" && node.name === "Visitável");
  const functionNode = result.ccm.nodes.find((node) => node.kind === "Function" && node.name === "café");
  assert.ok(classNode && propertyNode && methodNode && interfaceNode && functionNode);
  assert.equal(propertyNode.parentId, classNode.id);
  assert.equal(methodNode.parentId, classNode.id);
  assert.equal(propertyNode.attributes.computed, true, "literal computed property names are supported explicitly");
  assert.ok(propertyNode.location);
  assert.ok(methodNode.location);
  assert.ok(decoder.decode(bytes.subarray(propertyNode.location.startByte, propertyNode.location.endByte)).includes("😀"));
  assert.ok(decoder.decode(bytes.subarray(methodNode.location.startByte, methodNode.location.endByte)).includes("return \"é\""));
});

test("unsupported anonymous and runtime-computed declarations are explicit limitations", () => {
  const source = [
    "export default class {}",
    "export default function () {}",
    "export class Supported { [makeName()]() {} [\"stable\"] = true; }",
    "export enum State { Ready }",
    "export type Alias = string;",
    "export const arrow = () => 1;",
    "export async function load(name: string) { return import(name); }",
    "export function call(receiver: unknown) { return receiver.run(); }",
  ].join("\n");
  const path = "src/dynamic.ts";
  const result = analyzeDeclarations({ snapshot, sources: mapSource(path, source) });

  assert.equal(result.status, "partial");
  assert.ok(result.ccm);
  assert.deepEqual(result.ccm.edges, []);
  assert.ok(result.ccm.nodes.some((node) => node.kind === "Class" && node.name === "Supported"));
  assert.ok(result.ccm.nodes.some((node) => node.kind === "Property" && node.name === "stable"));
  assert.ok(!result.ccm.nodes.some((node) => node.name === "enum" || node.name === "Alias" || node.name === "arrow"));
  assert.ok(result.ccm.limitations.some((item) => item.stage === "dynamic" && item.reason.includes("dynamic import")));
  assert.ok(result.ccm.limitations.some((item) => item.reason.includes("computed method name")));
  assert.ok(result.ccm.limitations.some((item) => item.reason.includes("Anonymous class")));
  assert.ok(result.ccm.limitations.some((item) => item.reason.includes("Anonymous function")));
  assert.ok(result.ccm.limitations.some((item) => item.reason.includes("Enum declarations")));
  assert.ok(result.ccm.limitations.some((item) => item.reason.includes("Type alias declarations")));
  assert.ok(result.ccm.limitations.some((item) => item.reason.includes("arrow functions")));
  assert.ok(result.ccm.limitations.some((item) => item.reason.includes("Call expressions are deferred")));
  assert.equal(validateCcm(result.ccm, { [path]: utf8.encode(source) }).ok, true);
});

test("invalid syntax becomes a failed file with diagnostics while valid files still produce CCM", () => {
  const sources = {
    "src/invalid.ts": utf8.encode("export class {\n"),
    "src/valid.ts": utf8.encode("export function ok() {}\n"),
  };
  const result = analyzeDeclarations({ snapshot, sources });

  assert.equal(result.status, "partial");
  assert.equal(result.errorCode, null);
  assert.ok(result.ccm);
  assert.equal(result.ccm.files.find((file) => file.path === "src/invalid.ts")?.status, "failed");
  assert.equal(result.ccm.files.find((file) => file.path === "src/valid.ts")?.status, "processed");
  assert.ok(result.diagnostics.some((item) => item.path === "src/invalid.ts" && typeof item.code === "number"));
  assert.ok(result.ccm.limitations.some((item) => item.path === "src/invalid.ts" && item.stage === "parse"));
  assert.ok(!result.ccm.nodes.some((node) => node.filePath === "src/invalid.ts"));
  assert.ok(result.ccm.nodes.some((node) => node.kind === "Function" && node.name === "ok"));
  assert.equal(validateCcm(result.ccm, sources).ok, true);
});

test("empty files omit zero-width module evidence and document the limitation", () => {
  const result = analyzeDeclarations({ snapshot, sources: { "src/empty.ts": new Uint8Array() } });
  assert.equal(result.status, "partial");
  assert.ok(result.ccm);
  assert.ok(!result.ccm.nodes.some((node) => node.filePath === "src/empty.ts"));
  assert.ok(result.ccm.limitations.some((item) => item.path === "src/empty.ts" && item.reason.includes("empty source")));
  assert.equal(validateCcm(result.ccm, { "src/empty.ts": new Uint8Array() }).ok, true);
});

test("JavaScript and JSX files reject TypeScript-only syntax using an in-memory syntax host", () => {
  const sources = {
    "src/typed.js": utf8.encode("export interface User { name: string }\n"),
    "src/typed.jsx": utf8.encode("function render(value: string): string { return value; }\n"),
    "src/valid.js": utf8.encode("export class Plain { label = \"ok\"; }\n"),
  };
  const result = analyzeDeclarations({ snapshot, sources });

  assert.equal(result.status, "partial");
  assert.ok(result.ccm);
  assert.equal(result.ccm.files.find((file) => file.path === "src/typed.js")?.status, "failed");
  assert.equal(result.ccm.files.find((file) => file.path === "src/typed.jsx")?.status, "failed");
  assert.equal(result.ccm.files.find((file) => file.path === "src/valid.js")?.status, "processed");
  assert.ok(result.diagnostics.some((item) => item.path === "src/typed.js"));
  assert.ok(result.diagnostics.some((item) => item.path === "src/typed.jsx"));
  assert.ok(result.ccm.nodes.some((node) => node.kind === "Class" && node.name === "Plain"));
  assert.ok(!result.ccm.nodes.some((node) => node.name === "User" || node.name === "render"));
  assert.equal(validateCcm(result.ccm, sources).ok, true);
});

test("blank computed member names become limitations without invalidating sibling declarations", () => {
  const source = "export class BlankNames { \"\"() {} \" \" = 1; good() {} }\n";
  const path = "src/blank-names.js";
  const result = analyzeDeclarations({ snapshot, sources: mapSource(path, source) });

  assert.equal(result.status, "partial");
  assert.ok(result.ccm);
  assert.ok(result.ccm.nodes.some((node) => node.kind === "Method" && node.name === "good"));
  assert.ok(!result.ccm.nodes.some((node) => node.name === "" || node.name === " "));
  assert.ok(result.ccm.limitations.some((item) => item.path === path && item.stage === "declarations"));
  assert.equal(validateCcm(result.ccm, { [path]: utf8.encode(source) }).ok, true);
});

test("trivia-only files retain valid module byte bounds and an empty source set fails", () => {
  for (const text of [" \r\n\t", "/* only a comment */\r\n", "\uFEFF"]) {
    const sources = mapSource("src/trivia.ts", text);
    const result = analyzeDeclarations({ snapshot, sources });
    assert.equal(result.status, "complete");
    assert.ok(result.ccm);
    assert.equal(result.ccm.nodes.length, 1);
    assert.equal(result.ccm.nodes[0]!.location!.startByte, 0);
    assert.equal(result.ccm.nodes[0]!.location!.endByte, utf8.encode(text).byteLength);
    assert.equal(validateCcm(result.ccm, sources).ok, true);
  }
  assert.equal(analyzeDeclarations({ snapshot, sources: {} }).status, "failed");
});

test("invalid UTF-8 and unsafe paths fail without accepting corrupted source facts", () => {
  const result = analyzeDeclarations({ snapshot, sources: {
    "src/bad.ts": new Uint8Array([0xff, 0xfe]),
    "src/good.ts": utf8.encode("export class Good {}"),
  } });
  assert.equal(result.status, "partial");
  assert.ok(result.ccm);
  assert.equal(result.ccm.files.find((file) => file.path === "src/bad.ts")!.status, "failed");
  assert.ok(result.diagnostics.some((item) => item.code === "INVALID_UTF8"));
  assert.ok(result.ccm.nodes.some((node) => node.name === "Good"));
  assert.equal(analyzeDeclarations({ snapshot, sources: mapSource("../bad.ts", "class Bad {}") }).status, "failed");
});
