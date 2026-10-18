import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { fixtureRoot, verifyFixtures, type FixtureManifest } from "../scripts/verify-fixtures.ts";

async function mutableManifest(): Promise<FixtureManifest> {
  return structuredClone(await verifyFixtures());
}

async function rejectsWith(manifest: FixtureManifest, code: string): Promise<void> {
  await assert.rejects(verifyFixtures({ manifest }), new RegExp(code));
}

async function copyFixtureTree(manifest: FixtureManifest, root: string): Promise<void> {
  for (const file of manifest.files) {
    const destination = join(root, ...file.path.split("/"));
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(new URL(file.path, fixtureRoot), destination);
  }
}

test("manifest memuat oracle declaration/reference minimum dan limitations untuk tiap bahasa", async () => {
  const manifest = await verifyFixtures();
  const languages = ["javascript", "typescript", "php"] as const;
  assert.deepEqual(manifest.languageCoverage?.map((item) => item.language), [...languages]);
  for (const coverage of manifest.languageCoverage ?? []) {
    const languageFiles = new Set(manifest.files.filter((file) => file.language === coverage.language).map((file) => file.path));
    const languageOracles = manifest.oracles.filter((oracle) => languageFiles.has(oracle.path));
    assert.ok(languageOracles.filter((oracle) => oracle.role === "declaration").length >= coverage.minimumOracles.declarations);
    assert.ok(languageOracles.filter((oracle) => oracle.role === "reference").length >= coverage.minimumOracles.references);
    assert.ok(coverage.limitations.length > 0);
    for (const limitation of coverage.limitations) {
      assert.ok(languageOracles.some((oracle) => oracle.path === limitation.path && oracle.target === limitation.target &&
        oracle.role === "reference" && oracle.resolution === "unresolved" && oracle.reason === limitation.reason));
    }
  }
  assert.equal(manifest.reviewStatus, "DRAFT_AWAITING_TEAM_REVIEW");
  assert.equal(manifest.reviewedBy, null);
});

test("manifest fixture dan evidence Unicode/CRLF cocok dengan source asli", async () => {
  const manifest = await verifyFixtures();
  assert.ok(manifest.files.some((file) => file.language === "php"));
  assert.ok(manifest.files.some((file) => file.language === "javascript"));
  assert.ok(manifest.files.some((file) => file.language === "typescript"));
  const source = await readFile(new URL("source-bounds/a/same.ts", fixtureRoot), "utf8");
  assert.ok(source.includes("\r\n"));
  assert.ok(source.includes("😀"));
});

test("verifier menolak hash dan snippet yang berubah", async () => {
  const badHash = await mutableManifest();
  badHash.files[0]!.sha256 = "0".repeat(64);
  await rejectsWith(badHash, "FIXTURE_HASH_MISMATCH");

  const badSnippet = await mutableManifest();
  badSnippet.oracles[0]!.snippet += " corrupted";
  await rejectsWith(badSnippet, "ORACLE_SNIPPET_MISMATCH");
});

test("verifier menolak bounds dan posisi evidence yang tidak cocok", async () => {
  const badBounds = await mutableManifest();
  badBounds.oracles[0]!.evidence.endByte = Number.MAX_SAFE_INTEGER;
  await rejectsWith(badBounds, "ORACLE_BOUNDS_INVALID");

  const badPosition = await mutableManifest();
  badPosition.oracles[0]!.evidence.startColumn += 1;
  await rejectsWith(badPosition, "ORACLE_POSITION_MISMATCH");

  const splitUtf8 = await mutableManifest();
  const unicodeOracle = splitUtf8.oracles.find((oracle) => oracle.path === "source-bounds/b/same.ts")!;
  const unicodeSource = await readFile(new URL(unicodeOracle.path, fixtureRoot));
  unicodeOracle.evidence.endByte = unicodeSource.indexOf(Buffer.from("😀")) + 1;
  await rejectsWith(splitUtf8, "ORACLE_UTF8_BOUNDARY_INVALID");

  const nonFiniteCoordinate = await mutableManifest();
  nonFiniteCoordinate.oracles[0]!.evidence.startByte = Number.NaN;
  await rejectsWith(nonFiniteCoordinate, "ORACLE_EVIDENCE_INVALID");

  const nonIntegerCoordinate = await mutableManifest();
  nonIntegerCoordinate.oracles[0]!.evidence.startLine = 1.5;
  await rejectsWith(nonIntegerCoordinate, "ORACLE_EVIDENCE_INVALID");
});

test("verifier menghitung posisi span yang diawali UTF-8 BOM secara konsisten", async () => {
  const manifest = await mutableManifest();
  const parent = await mkdtemp(join(tmpdir(), "sage-fixture-bom-"));
  const root = join(parent, "fixtures");
  try {
    await mkdir(root);
    await copyFixtureTree(manifest, root);
    const file = manifest.files.find((item) => item.path === "js-static/base.js")!;
    const filePath = join(root, ...file.path.split("/"));
    const content = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), await readFile(filePath)]);
    await writeFile(filePath, content);
    file.sha256 = createHash("sha256").update(content).digest("hex");
    file.sizeBytes = content.length;
    manifest.oracles.push({
      path: file.path,
      kind: "SourceSpan",
      target: "UTF8_BOM",
      snippet: "\uFEFFexport",
      evidence: { startByte: 0, endByte: 9, startLine: 1, startColumn: 1, endLine: 1, endColumn: 8 },
      role: "context",
    });
    await verifyFixtures({ root, manifest });
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("verifier menolak symlink fixture yang keluar dari root", async () => {
  const manifest = await mutableManifest();
  const parent = await mkdtemp(join(tmpdir(), "sage-fixture-symlink-"));
  const root = join(parent, "fixtures");
  try {
    await mkdir(root);
    await copyFixtureTree(manifest, root);
    const filePath = join(root, "js-static", "base.js");
    const outsidePath = join(parent, "outside.js");
    await copyFile(filePath, outsidePath);
    await unlink(filePath);
    await symlink(outsidePath, filePath);
    await assert.rejects(verifyFixtures({ root, manifest }), /FIXTURE_PATH_INVALID/);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("verifier menolak path traversal, URL encoding, duplikat, dan oracle tanpa file", async () => {
  for (const unsafePath of ["../outside.js", "%2e%2e/outside.js", "js-static%2fmain.js", "js-static\\main.js"]) {
    const manifest = await mutableManifest();
    manifest.files[0]!.path = unsafePath;
    await rejectsWith(manifest, "FIXTURE_PATH_INVALID");
  }

  const duplicateFile = await mutableManifest();
  duplicateFile.files[1]!.path = duplicateFile.files[0]!.path;
  await rejectsWith(duplicateFile, "FIXTURE_PATH_DUPLICATE");

  const unknownOracle = await mutableManifest();
  unknownOracle.oracles[0]!.path = "js-static/missing.js";
  await rejectsWith(unknownOracle, "ORACLE_FILE_UNKNOWN");
});

test("verifier menolak metadata oracle dan bahasa yang tidak memenuhi kontrak", async () => {
  const missingReason = await mutableManifest();
  missingReason.oracles.find((oracle) => oracle.resolution === "unresolved")!.reason = "";
  await rejectsWith(missingReason, "ORACLE_REASON_REQUIRED");

  const insufficientReferences = await mutableManifest();
  insufficientReferences.languageCoverage!.find((item) => item.language === "php")!.minimumOracles.references = 100;
  await rejectsWith(insufficientReferences, "FIXTURE_LANGUAGE_ORACLE_MINIMUM_MISSING");

  const falseReview = await mutableManifest();
  falseReview.reviewedBy = "Ilzam";
  await rejectsWith(falseReview, "FIXTURE_REVIEW_METADATA_INVALID");
});
