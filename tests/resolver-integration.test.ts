import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { analyzeReferences as analyzeJs } from "@sage/analyzer-js";
import { analyzeReferences as analyzePhp } from "@sage/analyzer-php";
import { canonicalizeCcm, validateCcm, type CcmSnapshot, type CcmV1 } from "@sage/contracts";
import { resolverOracleRoot, verifyResolverOracles, type ResolverLanguage, type ResolverOracleEdge } from "../scripts/verify-resolver-oracles.ts";

const snapshot: CcmSnapshot = { repository: "fixture/resolver-oracles", branch: "test", commitSha: "e".repeat(40) };

function assertOracle(model: CcmV1, expected: ResolverOracleEdge): void {
  const nodes = new Map(model.nodes.map(node => [node.id, node]));
  const matchingSite = model.edges.filter(edge => edge.kind === expected.kind &&
    nodes.get(edge.sourceId)?.qualifiedName === expected.source.qualifiedName &&
    nodes.get(edge.sourceId)?.filePath === expected.source.path &&
    edge.evidence.some(span => span.filePath === expected.evidence.path &&
      span.role === "reference" && span.startByte === expected.evidence.startByte && span.endByte === expected.evidence.endByte));
  assert.ok(matchingSite.length > 0, `${expected.id}: missing ${expected.kind} at the hand-authored reference span`);
  const matchingResolution = matchingSite.filter(edge => edge.resolution === expected.resolution);
  assert.ok(matchingResolution.length > 0, `${expected.id}: wrong resolution`);
  assert.equal(matchingResolution.length, matchingSite.length, `${expected.id}: contradictory resolutions at one reference site`);
  if (expected.resolution === "Exact") {
    assert.ok(matchingResolution.every(edge => nodes.get(edge.targetId)?.qualifiedName === expected.target!.qualifiedName &&
      nodes.get(edge.targetId)?.filePath === expected.target!.path), `${expected.id}: wrong declaration target`);
  } else {
    assert.equal(matchingSite.some(edge => edge.resolution === "Exact"), false, `${expected.id}: unresolved site must never acquire an Exact target`);
    assert.ok(matchingResolution.every(edge => edge.unresolvedReason === expected.unresolved!.reason &&
      nodes.get(edge.targetId)?.kind === "UnresolvedReference" && nodes.get(edge.targetId)?.origin === "unresolved"),
    `${expected.id}: missing placeholder or wrong unresolved reason`);
  }
}

for (const language of ["javascript", "typescript", "php"] as const satisfies readonly ResolverLanguage[]) {
  test(`${language} resolver matches independent source oracles and replays canonically`, async () => {
    const manifest = await verifyResolverOracles();
    const entries = await Promise.all(manifest.files.filter(file => file.language === language).map(async file =>
      [file.path, new Uint8Array(await readFile(new URL(file.path, resolverOracleRoot)))] as const));
    const sources = Object.fromEntries(entries);
    const analyze = language === "php" ? analyzePhp : analyzeJs;
    const result = await analyze({ snapshot, sources });
    assert.equal(result.errorCode, null);
    assert.ok(result.ccm, `${language} resolver must return a usable CCM`);
    assert.equal(result.status, "partial", "oracle includes explicit dynamic/external/unknown references");
    assert.equal(validateCcm(result.ccm, sources).ok, true);
    const paths = new Set(manifest.files.filter(file => file.language === language).map(file => file.path));
    for (const expected of manifest.expectedEdges.filter(edge => paths.has(edge.source.path))) assertOracle(result.ccm, expected);
    const serialized: unknown = JSON.parse(JSON.stringify(result.ccm));
    const canonical = canonicalizeCcm(serialized, sources);
    assert.equal(canonical.ok, true);
    if (canonical.ok) {
      assert.equal(canonical.json, result.canonicalJson);
      assert.equal(canonical.sha256, result.contentSha256);
    }
    const replay = await analyze({ snapshot, sources: Object.fromEntries([...entries].reverse()) });
    assert.equal(replay.canonicalJson, result.canonicalJson);
    assert.equal(replay.contentSha256, result.contentSha256);
  });
}
