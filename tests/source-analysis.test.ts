import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access } from "node:fs/promises";
import test from "node:test";
import { canonicalizeCcm, validateCcm, type CcmSnapshot } from "@sage/contracts";
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
  assert.equal(result.ccm.edges.length, 0);
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
