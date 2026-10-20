import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { resolverOracleRoot, verifyResolverOracles, type ResolverOracleManifest } from "../scripts/verify-resolver-oracles.ts";

async function mutableManifest(): Promise<ResolverOracleManifest> {
  return structuredClone(await verifyResolverOracles());
}

async function rejectsWith(manifest: ResolverOracleManifest, code: string): Promise<void> {
  await assert.rejects(verifyResolverOracles({ manifest }), new RegExp(code));
}

async function copyFixtureTree(manifest: ResolverOracleManifest, root: string): Promise<void> {
  for (const file of manifest.files) {
    const destination = join(root, ...file.path.split("/"));
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(new URL(file.path, resolverOracleRoot), destination);
  }
}

test("oracle manifest integrity covers JS, TS, PHP, unresolved cases, and draft status", async () => {
  const manifest = await verifyResolverOracles();
  assert.ok(manifest.files.length > 0);
  assert.ok(manifest.expectedEdges.length > 0);
  assert.deepEqual(manifest.languageCoverage.map((item) => item.language), ["javascript", "typescript", "php"]);
  assert.equal(manifest.reviewStatus, "DRAFT_AWAITING_TEAM_REVIEW");
  assert.equal(manifest.reviewedBy, null);
  for (const coverage of manifest.languageCoverage) {
    const paths = new Set(manifest.files.filter((file) => file.language === coverage.language).map((file) => file.path));
    const edges = manifest.expectedEdges.filter((edge) => paths.has(edge.source.path));
    assert.ok(edges.filter((edge) => edge.resolution === "Exact").length >= coverage.minimumExactEdges);
    assert.ok(edges.filter((edge) => edge.resolution === "Unresolved").length >= coverage.minimumUnresolvedEdges);
    for (const scenario of coverage.requiredScenarios) assert.ok(edges.some((edge) => edge.scenario === scenario), `${coverage.language}:${scenario}`);
  }
});

test("verifier rejects fixture hashes, canaries, and literal markers that drift", async () => {
  const badHash = await mutableManifest();
  badHash.files[0]!.sha256 = "0".repeat(64);
  await assert.rejects(verifyResolverOracles({ manifest: badHash }), /RESOLVER_FIXTURE_HASH_MISMATCH/);

  const badCanary = await mutableManifest();
  badCanary.files.find((file) => file.canary !== undefined)!.canary = "RESOLVER_WRONG_CANARY";
  await assert.rejects(verifyResolverOracles({ manifest: badCanary }), /RESOLVER_FIXTURE_CANARY_MISSING/);

  const badLiteral = await mutableManifest();
  badLiteral.expectedEdges[0]!.evidence.snippet += " drift";
  await assert.rejects(verifyResolverOracles({ manifest: badLiteral }), /RESOLVER_ORACLE_LITERAL_MISMATCH/);
});

test("verifier rejects byte bounds, split UTF-8 characters, and incorrect CRLF positions", async () => {
  const badBounds = await mutableManifest();
  badBounds.expectedEdges[0]!.evidence.endByte = Number.MAX_SAFE_INTEGER;
  await assert.rejects(verifyResolverOracles({ manifest: badBounds }), /RESOLVER_ORACLE_BOUNDS_INVALID/);

  const splitUtf8 = await mutableManifest();
  const unicodeFile = splitUtf8.files.find((file) => file.path.endsWith("typescript/src/endpoint.ts"))!;
  const bytes = await readFile(new URL(unicodeFile.path, resolverOracleRoot));
  const cafeStart = bytes.indexOf(Buffer.from("café", "utf8"));
  assert.ok(cafeStart >= 0);
  splitUtf8.expectedEdges.find((edge) => edge.id === "ts-call-describe")!.evidence.startByte = cafeStart + 4;
  await assert.rejects(verifyResolverOracles({ manifest: splitUtf8 }), /RESOLVER_ORACLE_UTF8_BOUNDARY_INVALID/);

  const badPosition = await mutableManifest();
  badPosition.expectedEdges.find((edge) => edge.id === "php-call-describe")!.evidence.startColumn += 1;
  await assert.rejects(verifyResolverOracles({ manifest: badPosition }), /RESOLVER_ORACLE_POSITION_MISMATCH/);
});

test("verifier rejects unsafe paths, duplicate files and malformed unresolved semantics", async () => {
  const unsafePath = await mutableManifest();
  unsafePath.files[0]!.path = "../outside.js";
  await rejectsWith(unsafePath, "RESOLVER_FIXTURE_FILE_METADATA_INVALID");

  const duplicateFile = await mutableManifest();
  duplicateFile.files[1]!.path = duplicateFile.files[0]!.path;
  await rejectsWith(duplicateFile, "RESOLVER_FIXTURE_PATH_DUPLICATE");

  const badReason = await mutableManifest();
  badReason.expectedEdges.find((edge) => edge.resolution === "Unresolved")!.unresolved!.reason = "INFERRED_TARGET";
  await rejectsWith(badReason, "RESOLVER_ORACLE_UNRESOLVED_INVALID");

  const missingPhpCoverage = await mutableManifest();
  missingPhpCoverage.expectedEdges = missingPhpCoverage.expectedEdges.filter((edge) => !edge.source.path.endsWith("php/src/endpoint.php"));
  await rejectsWith(missingPhpCoverage, "RESOLVER_ORACLE_LANGUAGE_EDGE_MINIMUM_MISSING");
});

test("verifier rejects fixture symlinks that escape the fixture root", async () => {
  const manifest = await mutableManifest();
  const parent = await mkdtemp(join(tmpdir(), "sage-resolver-oracle-symlink-"));
  const root = join(parent, "fixtures");
  try {
    await mkdir(root);
    await copyFixtureTree(manifest, root);
    const fixturePath = join(root, ...manifest.files[0]!.path.split("/"));
    const outsidePath = join(parent, "outside.js");
    await copyFile(fixturePath, outsidePath);
    await unlink(fixturePath);
    await symlink(outsidePath, fixturePath);
    await assert.rejects(verifyResolverOracles({ root, manifest }), /RESOLVER_FIXTURE_PATH_INVALID/);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
