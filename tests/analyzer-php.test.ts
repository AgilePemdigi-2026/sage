import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { analyzeDeclarations, parsePhp } from "@sage/analyzer-php";
import { validateCcm, type CcmSnapshot } from "@sage/contracts";

const snapshot: CcmSnapshot = {
  repository: "AgilePemdigi-2026/sage",
  branch: "feat/34-php-declarations",
  commitSha: "d".repeat(40),
};
const utf8 = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

type ImportFact = {
  name: string;
  alias: string;
  kind: string;
  startByte: number;
  endByte: number;
};

function mapSource(path: string, text: string): Record<string, Uint8Array> {
  return { [path]: utf8.encode(text) };
}

function importFacts(attributes: Record<string, unknown>): ImportFact[] {
  assert.ok(Array.isArray(attributes.useImports));
  return attributes.useImports as ImportFact[];
}

test("PHP declarations produce CCM v1 nodes with oracle-contained byte spans and no resolver edges", async () => {
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
  const entries = await Promise.all(manifest.files
    .filter((file) => file.language === "php")
    .map(async (file) => [`tests/fixtures/${file.path}`, new Uint8Array(await readFile(new URL(`./fixtures/${file.path}`, import.meta.url)))] as const));
  const sources = Object.fromEntries(entries);
  const result = await analyzeDeclarations({ snapshot, sources });

  assert.equal(result.status, "partial", "the PHP fixtures contain invalid syntax and parser limitations");
  assert.equal(result.errorCode, null);
  assert.ok(result.ccm);
  assert.ok(result.canonicalJson);
  assert.ok(result.contentSha256);
  assert.equal(result.ccm.edges.length, 0, "the declaration adapter must not invent resolver edges");
  assert.match(result.ccm.provenance.analyzer.version, /nikic-php-parser-v5\.9\.0/);
  assert.equal(validateCcm(result.ccm, sources).ok, true);

  for (const oracle of manifest.oracles.filter((item) =>
    item.path === "php-namespaces/service.php" && item.role === "declaration" && item.kind === "Class")) {
    const path = `tests/fixtures/${oracle.path}`;
    const node = result.ccm.nodes.find((item) => item.filePath === path && item.kind === oracle.kind && item.qualifiedName === oracle.target);
    assert.ok(node?.location, `missing PHP ${oracle.kind} ${oracle.target}`);
    assert.ok(node.location.startByte <= oracle.evidence.startByte, `${oracle.target} must contain the class-header oracle start`);
    assert.ok(node.location.endByte >= oracle.evidence.endByte, `${oracle.target} must contain the class-header oracle end`);
    const declaration = decoder.decode(sources[path]!.subarray(node.location.startByte, node.location.endByte));
    assert.ok(declaration.includes(oracle.snippet));
  }

  const servicePath = "tests/fixtures/php-namespaces/service.php";
  const service = result.ccm.nodes.find((node) => node.kind === "Class" && node.qualifiedName === "App\\Service");
  const render = result.ccm.nodes.find((node) => node.kind === "Method" && node.qualifiedName === "App\\Service::render");
  const callUnknown = result.ccm.nodes.find((node) => node.kind === "Function" && node.qualifiedName === "App\\callUnknown");
  const namespace = result.ccm.nodes.find((node) => node.kind === "Module" && node.attributes.namespace === "App");
  assert.ok(service && render && callUnknown && namespace);
  assert.equal(render.parentId, service.id);
  assert.equal(service.parentId, namespace.id);
  const imports = importFacts(namespace.attributes);
  assert.deepEqual(imports.map(({ name, alias, kind }) => ({ name, alias, kind })), [
    { name: "Contracts\\Base", alias: "Base", kind: "class" },
    { name: "Contracts\\Renderable", alias: "Renderable", kind: "class" },
  ]);
  const serviceBytes = sources[servicePath]!;
  for (const item of imports) {
    assert.ok(item.startByte < item.endByte && item.endByte <= serviceBytes.byteLength);
    const fragment = decoder.decode(serviceBytes.subarray(item.startByte, item.endByte));
    assert.ok(fragment.includes(item.name.split("\\").at(-1)!));
  }

  const reversed = await analyzeDeclarations({ snapshot, sources: Object.fromEntries([...entries].reverse()) });
  assert.equal(reversed.canonicalJson, result.canonicalJson, "source map order must not change canonical CCM");
  assert.equal(reversed.contentSha256, result.contentSha256);
});

test("PHP use imports preserve class, function, constant, alias, and grouped-use syntax", async () => {
  const source = `<?php\nnamespace Demo;\nuse function Tools\\fnA as aliasFn;\nuse const Tools\\FLAG;\nuse Vendor\\Group\\{A, B as Renamed, function helper, const LIMIT};\nclass App { public function go(): void {} }\n`;
  const path = "src/imports.php";
  const result = await analyzeDeclarations({ snapshot, sources: mapSource(path, source) });
  assert.equal(result.status, "complete");
  assert.ok(result.ccm);
  const namespace = result.ccm.nodes.find((node) => node.kind === "Module" && node.attributes.namespace === "Demo");
  assert.ok(namespace);
  assert.deepEqual(importFacts(namespace.attributes).map(({ name, alias, kind }) => ({ name, alias, kind })), [
    { name: "Tools\\fnA", alias: "aliasFn", kind: "function" },
    { name: "Tools\\FLAG", alias: "FLAG", kind: "const" },
    { name: "Vendor\\Group\\A", alias: "A", kind: "class" },
    { name: "Vendor\\Group\\B", alias: "Renamed", kind: "class" },
    { name: "Vendor\\Group\\helper", alias: "helper", kind: "function" },
    { name: "Vendor\\Group\\LIMIT", alias: "LIMIT", kind: "const" },
  ]);
  assert.equal(validateCcm(result.ccm, { [path]: utf8.encode(source) }).ok, true);
});

test("PHP evidence uses original UTF-8 bytes across BOM, CRLF, and Unicode identifiers", async () => {
  const source = "\uFEFF<?php\r\nclass Référence {\r\n  public function résumé(): string { return \"é 😀\"; }\r\n}\r\nfunction café(): void {}\r\n";
  const bytes = utf8.encode(source);
  const path = "src/unicode.php";
  const result = await analyzeDeclarations({ snapshot, sources: { [path]: bytes } });
  assert.equal(result.status, "complete");
  assert.ok(result.ccm);
  assert.equal(validateCcm(result.ccm, { [path]: bytes }).ok, true);
  const moduleNode = result.ccm.nodes.find((node) => node.kind === "Module" && node.attributes.moduleKind === "file");
  const classNode = result.ccm.nodes.find((node) => node.kind === "Class" && node.name === "Référence");
  const methodNode = result.ccm.nodes.find((node) => node.kind === "Method" && node.name === "résumé");
  const functionNode = result.ccm.nodes.find((node) => node.kind === "Function" && node.name === "café");
  assert.ok(moduleNode && classNode && methodNode && functionNode);
  assert.equal(moduleNode.location?.startByte, 0, "the file module includes UTF-8 BOM bytes");
  assert.equal(moduleNode.location?.endByte, bytes.byteLength);
  assert.equal(methodNode.parentId, classNode.id);
  assert.ok(methodNode.location);
  const methodSource = decoder.decode(bytes.subarray(methodNode.location.startByte, methodNode.location.endByte));
  assert.ok(methodSource.includes("résumé"));
  assert.ok(methodSource.includes("😀"));
});

test("inline HTML and short opening tags are explicit limitations", async () => {
  for (const source of ["plain text outside PHP", "<? echo 'short tag'; ?>"]) {
    const result = await analyzeDeclarations({ snapshot, sources: mapSource("src/template.php", source) });
    assert.equal(result.status, "partial");
    assert.ok(result.ccm);
    assert.ok(result.ccm.limitations.some((item) => /Inline HTML|Short opening tags/.test(item.reason)));
    assert.equal(validateCcm(result.ccm, mapSource("src/template.php", source)).ok, true);
  }
});

test("invalid PHP syntax and invalid UTF-8 fail closed while valid sibling files are retained", async () => {
  const sources = {
    "src/invalid.php": utf8.encode("<?php\nclass Broken {\n"),
    "src/invalid-utf8.php": new Uint8Array([0x3c, 0x3f, 0x70, 0x68, 0x70, 0x0a, 0xff]),
    "src/valid.php": utf8.encode("<?php namespace Healthy; class Ready {}\n"),
  };
  const result = await analyzeDeclarations({ snapshot, sources });
  assert.equal(result.status, "partial");
  assert.ok(result.ccm);
  assert.equal(result.ccm.files.find((file) => file.path === "src/invalid.php")?.status, "failed");
  assert.equal(result.ccm.files.find((file) => file.path === "src/invalid-utf8.php")?.status, "failed");
  assert.equal(result.ccm.files.find((file) => file.path === "src/valid.php")?.status, "processed");
  assert.ok(result.diagnostics.some((item) => item.path === "src/invalid.php" && item.code === "PHP_PARSE_ERROR"));
  assert.ok(result.diagnostics.some((item) => item.path === "src/invalid-utf8.php" && item.code === "INVALID_UTF8"));
  assert.ok(result.ccm.nodes.some((node) => node.kind === "Class" && node.name === "Ready"));
  assert.ok(!result.ccm.nodes.some((node) => node.filePath === "src/invalid.php"));
  assert.equal(validateCcm(result.ccm, sources).ok, true);
});

test("traits, enums, anonymous code, properties, and dynamic include/eval are explicit limitations", async () => {
  const source = `<?php
trait Writes {}
enum State: string { case Ready = 'ready'; }
class Host {
    use Writes;
    public int $id = 1;
    public function __construct(public string $label) {}
    public function make(): object { return new class {}; }
}
$loader = function (): void { include __DIR__ . '/runtime.php'; };
eval('echo "never";');
`;
  const path = "src/unsupported.php";
  const result = await analyzeDeclarations({ snapshot, sources: mapSource(path, source) });
  assert.equal(result.status, "partial");
  assert.ok(result.ccm);
  assert.ok(result.ccm.nodes.some((node) => node.kind === "Class" && node.name === "Host"));
  assert.ok(result.ccm.nodes.some((node) => node.kind === "Method" && node.name === "make"));
  assert.ok(result.ccm.nodes.some((node) => node.kind === "Method" && node.name === "__construct"));
  assert.ok(!result.ccm.nodes.some((node) => node.name === "Writes" || node.name === "State"));
  const reasons = result.ccm.limitations.map((item) => item.reason).join("\n");
  assert.match(reasons, /Trait declarations/);
  assert.match(reasons, /Enum declarations/);
  assert.match(reasons, /Anonymous classes/);
  assert.match(reasons, /closures/);
  assert.match(reasons, /Trait composition/);
  assert.match(reasons, /Property declarations/);
  assert.match(reasons, /Constructor-promoted properties/);
  assert.match(reasons, /Include and require targets/);
  assert.match(reasons, /eval code/);
  assert.equal(validateCcm(result.ccm, { [path]: utf8.encode(source) }).ok, true);
});

test("repeated namespace declarations bind each method to its exact class span and conditional declarations are limited", async () => {
  const source = `<?php
namespace Dup;
class Repeated { public function first(): void {} }
namespace Dup;
class Repeated { public function second(): void {} }
if (true) { class Conditional { public function nested(): void {} } }
`;
  const path = "src/repeated.php";
  const result = await analyzeDeclarations({ snapshot, sources: mapSource(path, source) });
  assert.equal(result.status, "partial");
  assert.ok(result.ccm);
  const repeatedClasses = result.ccm.nodes.filter((node) => node.kind === "Class" && node.qualifiedName === "Dup\\Repeated")
    .sort((left, right) => left.location!.startByte - right.location!.startByte);
  const methods = result.ccm.nodes.filter((node) => node.kind === "Method" && node.qualifiedName.startsWith("Dup\\Repeated::"));
  assert.equal(repeatedClasses.length, 2);
  assert.equal(methods.length, 2);
  assert.notEqual(repeatedClasses[0]!.id, repeatedClasses[1]!.id);
  assert.equal(methods.find((node) => node.name === "first")?.parentId, repeatedClasses[0]!.id);
  assert.equal(methods.find((node) => node.name === "second")?.parentId, repeatedClasses[1]!.id);
  assert.ok(!result.ccm.nodes.some((node) => node.name === "Conditional" || node.name === "nested"));
  assert.ok(result.ccm.limitations.some((item) => item.reason.includes("conditional declarations")));
  assert.equal(validateCcm(result.ccm, { [path]: utf8.encode(source) }).ok, true);
});

test("PHP analyzer keeps parsePhp compatibility and never executes fixture source", async () => {
  const source = await readFile(new URL("./fixtures/php-namespaces/service.php", import.meta.url), "utf8");
  const probe = await parsePhp(source);
  assert.equal(probe.valid, true);
  assert.match(probe.parserVersion ?? "", /5\.9\.0/);
  assert.ok(probe.statementKinds?.includes("Stmt_Namespace"));

  const result = await analyzeDeclarations({ snapshot, sources: mapSource("src/canary.php", source) });
  assert.ok(result.ccm?.nodes.some((node) => node.kind === "Class" && node.qualifiedName === "App\\Service"));
  assert.equal(result.errorCode, null, "the fixture's top-level throw expression is parsed as data, never executed");
});
