import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access } from "node:fs/promises";
import test from "node:test";
import { canonicalizeCcm, validateCcm, type CcmNode, type CcmSnapshot } from "@sage/contracts";
import { analyzeSnapshotSources, scanSnapshotSources, SOURCE_POLICY_VERSION } from "../apps/worker/src/source-analysis.ts";
import type { SnapshotFile } from "../apps/worker/src/snapshot/archive.ts";

const snapshot: CcmSnapshot = {
  repository: "AgilePemdigi-2026/sage",
  branch: "feat/10-source-detection",
  commitSha: "a".repeat(40),
};
const encoder = new TextEncoder();

function snapshotFile(path: string, value: string | Uint8Array): SnapshotFile {
  const bytes = typeof value === "string" ? encoder.encode(value) : new Uint8Array(value);
  return {
    relativePath: path,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    byteLength: bytes.byteLength,
    bytes,
  };
}

function byPath(result: ReturnType<typeof scanSnapshotSources>, path: string) {
  return result.files.find((file) => file.path === path);
}

test("source policy recognizes JS, TS and PHP and records conservative exclusions distinctly", () => {
  const files = [
    snapshotFile("src/app.JS", "export class App {}"),
    snapshotFile("src/types.TSX", "export interface View {}"),
    snapshotFile("src/lib.PHp", "<?php class Service {}"),
    snapshotFile(".git/config.js", "export class GitData {}"),
    snapshotFile("node_modules/pkg/index.js", "export class Dependency {}"),
    snapshotFile("vendor/legacy.php", "<?php class Legacy {}"),
    snapshotFile("dist/output.ts", "export class Built {}"),
    snapshotFile("build/output.js", "export class Built {}"),
    snapshotFile("coverage/report.js", "export class Coverage {}"),
    snapshotFile(".next/server.js", "export class Generated {}"),
    snapshotFile("src/app.min.js", "minified"),
    snapshotFile("src/module.min.mjs", "minified"),
    snapshotFile("src/module.min.cjs", "minified"),
    snapshotFile("src/app.js.map", "{}"),
    snapshotFile("package.json", '{"scripts":{"test":"throw new Error(\"must not run\")"}}'),
    snapshotFile(".gitmodules", '[submodule "private"]\nurl = https://example.invalid/private.git\n'),
    snapshotFile("src/too-large.ts", "0".repeat(40)),
    snapshotFile("src/nul.php", new Uint8Array([0x3c, 0x3f, 0, 0x3e])),
    snapshotFile("src/binary.js", new Uint8Array([0x01, 0x02, 0x03])),
    snapshotFile("src/invalid-utf8.ts", new Uint8Array([0x65, 0x78, 0x70, 0x6f, 0x72, 0x74, 0x20, 0xff])),
  ];
  const report = scanSnapshotSources(files, { maxSourceFileBytes: 32 });

  assert.equal(SOURCE_POLICY_VERSION, report.policyVersion);
  assert.equal(report.status, "ready");
  assert.equal(report.errorCode, null);
  assert.equal(report.counts.total, files.length);
  assert.equal(report.counts.recognized, 17);
  assert.equal(report.counts.eligible, 3);
  assert.equal(report.counts.excluded, files.length - 3);
  assert.deepEqual(report.counts.languages, {
    javascript: { recognized: 10, eligible: 1, processed: 0, failed: 0 },
    typescript: { recognized: 4, eligible: 1, processed: 0, failed: 0 },
    php: { recognized: 3, eligible: 1, processed: 0, failed: 0 },
  });
  assert.equal(byPath(report, "src/app.min.js")?.reason, "MINIFIED_SOURCE");
  assert.equal(byPath(report, "src/module.min.mjs")?.reason, "MINIFIED_SOURCE");
  assert.equal(byPath(report, "src/module.min.cjs")?.reason, "MINIFIED_SOURCE");
  assert.equal(byPath(report, "src/app.js.map")?.reason, "SOURCE_MAP");
  assert.equal(byPath(report, "package.json")?.reason, "UNSUPPORTED_EXTENSION");
  assert.equal(byPath(report, ".gitmodules")?.reason, "SUBMODULE_METADATA");
  assert.equal(byPath(report, "src/too-large.ts")?.reason, "SOURCE_FILE_TOO_LARGE");
  assert.equal(byPath(report, "src/nul.php")?.reason, "NUL_BYTE");
  assert.equal(byPath(report, "src/binary.js")?.reason, "BINARY_FILE");
  assert.equal(byPath(report, "src/invalid-utf8.ts")?.reason, "INVALID_UTF8");
  assert.ok(report.limitations.some((item) => item.code === "SUBMODULE_CONTENTS_NOT_INCLUDED" && item.path === ".gitmodules"));
  assert.equal("sources" in report, false, "the compact policy report must not expose source bytes");
});

test("source scanning is deterministic and rejects unsafe, duplicate, or tampered snapshots", () => {
  const first = snapshotFile("src/a.js", "export class A {}\r\n");
  const second = snapshotFile("src/b.php", "<?php class B {}\r\n");
  const forward = scanSnapshotSources([first, second]);
  const reverse = scanSnapshotSources([second, first]);
  assert.deepEqual(forward, reverse);

  assert.equal(scanSnapshotSources([first, { ...second, relativePath: "src/a.js" }]).errorCode, "SNAPSHOT_INVALID");
  assert.equal(scanSnapshotSources([first, { ...second, sha256: "0".repeat(64) }]).errorCode, "SNAPSHOT_INVALID");
  assert.equal(scanSnapshotSources([first, { ...second, byteLength: second.byteLength + 1 }]).errorCode, "SNAPSHOT_INVALID");
  assert.equal(scanSnapshotSources([first, { ...second, relativePath: "../outside.php" }]).errorCode, "SNAPSHOT_INVALID");
  assert.equal(scanSnapshotSources([first, snapshotFile("src/a.js/child.ts", "export class Child {}")]).errorCode, "SNAPSHOT_INVALID");
  assert.equal(scanSnapshotSources([first], { maxSourceFileBytes: DEFAULT_LIMIT_FOR_TEST }).errorCode, "INVALID_LIMITS");
});

const DEFAULT_LIMIT_FOR_TEST = 1024 * 1024 + 1;

test("mixed JS/TS and PHP sources produce one validated, canonical CCM", async () => {
  const files = [
    snapshotFile("src/app.js", "export class App {}\n"),
    snapshotFile("src/types.ts", "export interface User { name: string }\n"),
    snapshotFile("src/Service.php", "<?php\nclass Service { public function run(): void {} }\n"),
    snapshotFile("package.json", '{"scripts":{"postinstall":"throw new Error(\"never execute\")"}}'),
  ];
  const result = await analyzeSnapshotSources({ snapshot, files });

  assert.equal(result.status, "partial", "unsupported metadata is reported while supported sources are analyzed");
  assert.equal(result.errorCode, null);
  assert.equal(result.report.counts.eligible, 3);
  assert.equal(result.report.counts.processed, 3);
  assert.equal(result.report.counts.failed, 0);
  assert.equal(result.report.counts.languages.javascript.processed, 1);
  assert.equal(result.report.counts.languages.typescript.processed, 1);
  assert.equal(result.report.counts.languages.php.processed, 1);
  assert.ok(result.ccm);
  assert.ok(result.canonicalJson);
  assert.ok(result.contentSha256);
  assert.ok(result.ccm.edges.some(edge => edge.kind === "CONTAINS"));
  assert.ok(result.ccm.edges.every(edge => edge.kind === "CONTAINS"), "declaration-only source must not invent call or import relationships");
  assert.ok(result.ccm.nodes.some((node) => node.language === "javascript" && node.name === "App"));
  assert.ok(result.ccm.nodes.some((node) => node.language === "typescript" && node.name === "User"));
  assert.ok(result.ccm.nodes.some((node) => node.language === "php" && node.name === "Service"));
  const sourceBytes = Object.fromEntries(files.map((file) => [file.relativePath, file.bytes] as const));
  assert.equal(validateCcm(result.ccm, sourceBytes).ok, true);
  const canonical = canonicalizeCcm(result.ccm, sourceBytes);
  assert.equal(canonical.ok, true);
  if (canonical.ok) {
    assert.equal(canonical.json, result.canonicalJson);
    assert.equal(canonical.sha256, result.contentSha256);
  }
  assert.equal(result.ccm.files.find((file) => file.path === "package.json")?.status, "excluded");
  assert.ok(result.ccm.limitations.some((item) => item.path === "package.json" && item.stage === "language detection"));
});

test("valid siblings survive syntax failures and all-parse-failed snapshots fail clearly", async () => {
  const valid = snapshotFile("src/good.ts", "export function good() {}\n");
  const invalid = snapshotFile("src/bad.ts", "export class {\n");
  const mixed = await analyzeSnapshotSources({ snapshot, files: [invalid, valid] });
  assert.equal(mixed.status, "partial");
  assert.equal(mixed.errorCode, null);
  assert.equal(mixed.report.counts.processed, 1);
  assert.equal(mixed.report.counts.failed, 1);
  assert.ok(mixed.diagnostics.some((item) => item.path === "src/bad.ts"));
  assert.ok(mixed.ccm?.nodes.some((node) => node.name === "good"));
  assert.ok(mixed.ccm?.files.some((file) => file.path === "src/bad.ts" && file.status === "failed"));

  const allBad = await analyzeSnapshotSources({ snapshot, files: [
    invalid,
    snapshotFile("src/bad.php", "<?php class {"),
  ] });
  assert.equal(allBad.status, "failed");
  assert.equal(allBad.errorCode, "PARSE_FAILED");
  assert.equal(allBad.report.counts.processed, 0);
  assert.equal(allBad.report.counts.failed, 2);
  assert.ok(allBad.ccm, "the failed CCM retains safe file status and diagnostics for the stage report");
});

test("no supported files returns NO_SUPPORTED_SOURCE before invoking adapters", async () => {
  const result = await analyzeSnapshotSources({ snapshot, files: [
    snapshotFile("README.md", "Documentation only."),
    snapshotFile("package.json", '{"private":true}'),
    snapshotFile("src/binary.js", new Uint8Array([0x00, 0xff])),
  ] });
  assert.equal(result.status, "failed");
  assert.equal(result.errorCode, "NO_SUPPORTED_SOURCE");
  assert.equal(result.report.errorCode, "NO_SUPPORTED_SOURCE");
  assert.equal(result.report.counts.eligible, 0);
  assert.equal(result.ccm, null);
});

test("original bytes preserve BOM and CRLF evidence across JS/TS and PHP", async () => {
  const jsBytes = encoder.encode("\uFEFFexport class Café {\r\n  run(): string { return \"😀\"; }\r\n}\r\n");
  const phpBytes = encoder.encode("\uFEFF<?php\r\nclass Café { public function run(): string { return '😀'; } }\r\n");
  const files = [snapshotFile("src/unicode.ts", jsBytes), snapshotFile("src/Unicode.php", phpBytes)];
  const result = await analyzeSnapshotSources({ snapshot, files });

  assert.equal(result.status, "complete");
  assert.ok(result.ccm);
  assert.equal(result.ccm.files.find((file) => file.path === "src/unicode.ts")?.sha256, createHash("sha256").update(jsBytes).digest("hex"));
  assert.equal(result.ccm.files.find((file) => file.path === "src/Unicode.php")?.sha256, createHash("sha256").update(phpBytes).digest("hex"));
  assert.equal(validateCcm(result.ccm, Object.fromEntries(files.map((file) => [file.relativePath, file.bytes]))).ok, true);
  for (const path of ["src/unicode.ts", "src/Unicode.php"]) {
    const node = result.ccm.nodes.find((item) => item.filePath === path && item.name === "Café");
    assert.ok(node?.location);
    const bytes = path.endsWith(".php") ? phpBytes : jsBytes;
    const declaration = new TextDecoder().decode(bytes.subarray(node.location.startByte, node.location.endByte));
    assert.ok(declaration.includes("Café"));
  }
});

test("input order does not change combined CCM provenance or content hash", async () => {
  const files = [
    snapshotFile("src/z.ts", "export class Z {}\n"),
    snapshotFile("src/a.php", "<?php class A {}\n"),
    snapshotFile("src/b.js", "export function B() {}\n"),
  ];
  const first = await analyzeSnapshotSources({ snapshot, files });
  const second = await analyzeSnapshotSources({ snapshot, files: [...files].reverse() });
  assert.equal(first.status, "complete");
  assert.equal(second.status, "complete");
  assert.equal(first.canonicalJson, second.canonicalJson);
  assert.equal(first.contentSha256, second.contentSha256);
  assert.deepEqual(first.report, second.report);
});

test("source analysis does not execute excluded repository configuration", async () => {
  const marker = "/tmp/sage-source-analysis-config-canary";
  try {
    await access(marker);
    assert.fail("unexpected stale canary marker");
  } catch (error) {
    assert.equal((error as NodeJS.ErrnoException).code, "ENOENT");
  }
  const result = await analyzeSnapshotSources({ snapshot, files: [snapshotFile(
    "composer.json",
    `<?php file_put_contents(${JSON.stringify(marker)}, "executed"); throw new RuntimeException("must not run");`,
  )] });
  assert.equal(result.errorCode, "NO_SUPPORTED_SOURCE");
  try {
    await access(marker);
    assert.fail("source policy must not execute unsupported configuration content");
  } catch (error) {
    assert.equal((error as NodeJS.ErrnoException).code, "ENOENT");
  }
});

test("default source limit accepts exactly 1 MiB and excludes the next byte", () => {
  const atLimit = snapshotFile("src/limit.js", new Uint8Array(1_048_576).fill(32));
  const overLimit = snapshotFile("src/over.js", new Uint8Array(1_048_577).fill(32));
  const report = scanSnapshotSources([atLimit, overLimit]);
  assert.equal(byPath(report, "src/limit.js")?.status, "eligible");
  assert.equal(byPath(report, "src/over.js")?.reason, "SOURCE_FILE_TOO_LARGE");
  assert.equal(report.counts.eligible, 1);
  assert.equal(report.counts.excluded, 1);
});

test("serialized mixed-language CCM retains declaration evidence and rejects tampering at the consumer boundary", async () => {
  const declarations = [
    { path: "src/Cafe.js", name: "Café", language: "javascript", kind: "Class", text: "export class Café { run() { return '😀'; } }" },
    { path: "src/Visit.ts", name: "Visitável", language: "typescript", kind: "Interface", text: "export interface Visitável { visitar(): void; }" },
    { path: "src/Service.php", name: "Service", language: "php", kind: "Class", text: "class Service { public function run(): string { return 'é'; } }" },
  ];
  const files = [
    ...declarations.map(item => snapshotFile(item.path, `\uFEFF${item.language === "php" ? "<?php\r\n" : ""}${item.text}\r\n`)),
    snapshotFile("src/broken.ts", "export class Broken {"),
    snapshotFile("assets/binary.dat", new Uint8Array([0xff, 0x00, 0x80])),
  ];
  const result = await analyzeSnapshotSources({ snapshot, files });
  assert.equal(result.status, "partial");
  assert.equal(result.errorCode, null);
  assert.deepEqual([result.report.counts.processed, result.report.counts.failed, result.report.counts.excluded], [3, 1, 1]);
  assert.ok(result.ccm);
  const sources = Object.fromEntries(files.map(file => [file.relativePath, file.bytes]));
  const restored: unknown = JSON.parse(JSON.stringify(result.ccm));
  const validated = validateCcm(restored, sources);
  assert.equal(validated.ok, true, "a persisted JSON payload must validate against the original immutable bytes");
  if (!validated.ok) return;
  for (const expected of declarations) {
    const node: CcmNode | undefined = validated.value.nodes.find(item => item.filePath === expected.path && item.name === expected.name && item.kind === expected.kind);
    assert.ok(node?.location, `missing declaration ${expected.name}`);
    assert.equal(node.language, expected.language);
    const actual = new TextDecoder("utf-8", { fatal: true }).decode(sources[expected.path]!.subarray(node.location.startByte, node.location.endByte));
    assert.equal(actual, expected.text, "evidence must recover the independently specified declaration exactly");
  }
  const replay = canonicalizeCcm(restored, sources);
  assert.equal(replay.ok, true);
  if (replay.ok) {
    assert.equal(replay.json, result.canonicalJson);
    assert.equal(replay.sha256, result.contentSha256);
  }
  const file = files[0]!;
  const changedBytes = new Uint8Array(file.bytes);
  changedBytes[changedBytes.length - 1] = 32;
  assert.deepEqual(validateCcm(restored, { ...sources, [file.relativePath]: changedBytes }), { ok: false, errorCode: "CCM_FILE_HASH_MISMATCH" });
  const badId = structuredClone(validated.value);
  badId.nodes[0]!.id = `node_${"0".repeat(64)}`;
  assert.deepEqual(validateCcm(badId, sources), { ok: false, errorCode: "CCM_NODE_ID_INVALID" });
  const badBounds = structuredClone(validated.value);
  const location = badBounds.nodes.find(node => node.filePath === file.relativePath)!.location!;
  location.endByte = file.bytes.byteLength + 1;
  assert.deepEqual(validateCcm(badBounds, sources), { ok: false, errorCode: "CCM_EVIDENCE_BOUNDS_INVALID" });
});

test("worker retains static references from both adapters and marks unknown receivers as partial", async () => {
  const files = [
    snapshotFile("src/lib.ts", "export function format(value: string) { return value; }\n"),
    snapshotFile("src/app.ts", "import { format as render } from './lib';\nexport function run(value: string) { return render(value); }\n"),
    snapshotFile("src/service.php", "<?php\nnamespace Service;\nfunction helper(): string { return 'ok'; }\nfunction run(): string { return helper(); }\n"),
    snapshotFile("src/dynamic.js", "export function invoke(target) { return target.run(); }\n"),
  ];
  const result = await analyzeSnapshotSources({ snapshot, files });
  assert.equal(result.status, "partial");
  assert.equal(result.errorCode, null);
  assert.ok(result.ccm);
  const model = result.ccm;
  const nodes = new Map(model.nodes.map(node => [node.id, node]));
  assert.ok(model.edges.some(edge => edge.kind === "CALLS" && edge.resolution === "Exact" &&
    nodes.get(edge.sourceId)?.filePath === "src/app.ts" && nodes.get(edge.targetId)?.name === "format"));
  assert.ok(model.edges.some(edge => edge.kind === "CALLS" && edge.resolution === "Exact" &&
    nodes.get(edge.sourceId)?.language === "php" && nodes.get(edge.targetId)?.qualifiedName === "Service\\helper"));
  assert.ok(model.edges.some(edge => edge.kind === "CALLS" && edge.resolution === "Unresolved" &&
    nodes.get(edge.sourceId)?.filePath === "src/dynamic.js" && edge.unresolvedReason === "UNKNOWN_RECEIVER"));
  assert.equal(model.provenance.resolver.name, "sage-static-adapters");
  const sources = Object.fromEntries(files.map(file => [file.relativePath, file.bytes]));
  assert.equal(validateCcm(model, sources).ok, true);
  const replay = await analyzeSnapshotSources({ snapshot, files: [...files].reverse() });
  assert.equal(replay.canonicalJson, result.canonicalJson);
  assert.equal(replay.contentSha256, result.contentSha256);
});

test("worker passes snapshot configuration bytes to the resolver and fingerprints mapping changes", async () => {
  const sources = [
    snapshotFile("src/first.ts", "export function format() { return 'first'; }\n"),
    snapshotFile("src/second.ts", "export function format() { return 'second'; }\n"),
    snapshotFile("src/main.ts", "import { format } from '@chosen';\nexport function run() { return format(); }\n"),
  ];
  const analyze = (target: string) => analyzeSnapshotSources({ snapshot, files: [...sources,
    snapshotFile("tsconfig.json", JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@chosen": [target] } } })),
  ] });
  const first = await analyze("src/first.ts");
  const second = await analyze("src/second.ts");
  assert.ok(first.ccm && second.ccm);
  const targetPath = (model: NonNullable<typeof first.ccm>) => {
    const call = model.edges.find(edge => edge.kind === "CALLS" && edge.resolution === "Exact" &&
      model.nodes.find(node => node.id === edge.sourceId)?.name === "run");
    assert.ok(call, "configured import must resolve to a supplied declaration");
    return model.nodes.find(node => node.id === call.targetId)?.filePath;
  };
  assert.equal(targetPath(first.ccm), "src/first.ts");
  assert.equal(targetPath(second.ccm), "src/second.ts");
  assert.notEqual(first.ccm.provenance.configHash, second.ccm.provenance.configHash);
  assert.notEqual(first.contentSha256, second.contentSha256);
});


test("worker captures source and snapshot identity before asynchronous PHP parsing", async () => {
  const mutableSnapshot = { ...snapshot };
  const files = [
    snapshotFile("src/run.php", "<?php\nfunction helper(): string { return 'ok'; }\nfunction run(): string { return helper(); }\n"),
    snapshotFile("src/main.ts", "export function run() { return true; }\n"),
  ];
  const frozenFiles = files.map(file => ({ ...file, bytes: new Uint8Array(file.bytes) }));
  const pending = analyzeSnapshotSources({ snapshot: mutableSnapshot, files });
  mutableSnapshot.commitSha = "f".repeat(40);
  mutableSnapshot.repository = "changed/identity";
  files[0]!.bytes.fill(0);
  const result = await pending;
  const replay = await analyzeSnapshotSources({ snapshot, files: frozenFiles });
  assert.ok(result.ccm);
  assert.equal(result.ccm.snapshot.commitSha, snapshot.commitSha);
  assert.equal(result.ccm.snapshot.repository, snapshot.repository);
  assert.equal(result.canonicalJson, replay.canonicalJson);
});
