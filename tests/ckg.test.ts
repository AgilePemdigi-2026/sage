import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { analyzeReferences } from "@sage/analyzer-js";
import {
  CKG_SCHEMA_VERSION,
  canonicalizeCkg,
  parseCanonicalCkg,
  type CcmV1,
} from "../packages/contracts/src/index.ts";

const configHash = "c".repeat(64);
const snapshot = { repository: "fixture/resolver-oracles", branch: "test", commitSha: "e".repeat(40) };
const sourcePaths = [
  "tests/fixtures/resolver/javascript/src/app.js",
  "tests/fixtures/resolver/javascript/src/format.js",
];
let fixtureResult: Promise<{ ccm: CcmV1; sources: Record<string, Uint8Array> }> | undefined;

async function fixture(): Promise<{ ccm: CcmV1; sources: Record<string, Uint8Array> }> {
  fixtureResult ??= (async () => {
    const entries = await Promise.all(sourcePaths.map(async path =>
      [path, new Uint8Array(await readFile(new URL(`../${path}`, import.meta.url)))] as const));
    const sources = Object.fromEntries(entries);
    const analysis = analyzeReferences({ snapshot, sources });
    assert.ok(analysis.ccm, `real resolver fixture should produce CCM; got ${analysis.errorCode}`);
    return { ccm: analysis.ccm, sources };
  })();
  const { ccm, sources } = await fixtureResult;
  return { ccm: structuredClone(ccm), sources };
}

test("canonical CKG keeps source-backed CCM and derives category counts", async () => {
  const { ccm, sources } = await fixture();
  const result = canonicalizeCkg(ccm, sources, configHash);
  assert.equal(result.ok, true, result.ok ? undefined : `CCM validation failed: ${result.errorCode}`);
  if (!result.ok) return;
  assert.equal(result.value.schemaVersion, CKG_SCHEMA_VERSION);
  assert.deepEqual(result.value.ccm.nodes.map(node => node.id), ccm.nodes.map(node => node.id).sort());
  assert.deepEqual(result.value.ccm.edges.map(edge => edge.id), ccm.edges.map(edge => edge.id).sort());
  assert.deepEqual(result.value.counts, {
    nodes: ccm.nodes.length,
    edges: ccm.edges.length,
    containmentEdges: ccm.edges.filter(edge => edge.kind === "CONTAINS").length,
    referenceEdges: ccm.edges.filter(edge => edge.kind !== "CONTAINS").length,
    exactEdges: ccm.edges.filter(edge => edge.resolution === "Exact").length,
    unresolvedEdges: ccm.edges.filter(edge => edge.resolution === "Unresolved").length,
  });
  assert.ok(result.value.counts.containmentEdges > 0, "fixture must contain source-backed containment");
  assert.ok(result.value.counts.referenceEdges > 0, "fixture must contain references read from actual source");
  assert.ok(result.value.counts.unresolvedEdges > 0, "fixture includes dynamic/unknown references");
  assert.equal(result.value.ccm.provenance.configHash, ccm.provenance.configHash);
  assert.equal(result.value.ccm.nodes.find(node => node.kind === "UnresolvedReference")?.origin, "unresolved");
});

test("canonical CKG is stable when source model arrays arrive in another order", async () => {
  const { ccm, sources } = await fixture();
  const original = canonicalizeCkg(ccm, sources, configHash);
  const reversed = canonicalizeCkg({ ...ccm, files: [...ccm.files].reverse(), nodes: [...ccm.nodes].reverse(), edges: [...ccm.edges].reverse() }, sources, configHash);
  assert.equal(original.ok, true, original.ok ? undefined : `CCM validation failed: ${original.errorCode}`);
  assert.equal(reversed.ok, true, reversed.ok ? undefined : `CCM validation failed: ${reversed.errorCode}`);
  if (!original.ok || !reversed.ok) return;
  assert.equal(reversed.json, original.json);
  assert.equal(reversed.sha256, original.sha256);
});

test("canonical CKG replay checks bytes, counts, canonical encoding, and content hash", async () => {
  const { ccm, sources } = await fixture();
  const result = canonicalizeCkg(ccm, sources, configHash);
  assert.equal(result.ok, true, result.ok ? undefined : `CCM validation failed: ${result.errorCode}`);
  if (!result.ok) return;
  const replay = parseCanonicalCkg(result.json, sources, result.sha256);
  assert.deepEqual(replay, result);
  assert.equal(parseCanonicalCkg(result.json, sources, "0".repeat(64)).ok, false);
  const changedCounts = JSON.parse(result.json) as { counts: { nodes: number } };
  changedCounts.counts.nodes += 1;
  assert.equal(parseCanonicalCkg(JSON.stringify(changedCounts), sources).ok, false);
  assert.equal(parseCanonicalCkg(`${result.json.slice(0, -1)},"extra":true}`, sources).ok, false);
  assert.equal(parseCanonicalCkg(` ${result.json}`, sources).ok, false);
  const tamperedSources = Object.fromEntries(Object.entries(sources).map(([path, bytes]) => [path, new Uint8Array(bytes)]));
  tamperedSources[sourcePaths[0]]![0] ^= 1;
  assert.equal(parseCanonicalCkg(result.json, tamperedSources).ok, false);
});

test("canonical CKG rejects a malformed queue configuration fingerprint", async () => {
  const { ccm, sources } = await fixture();
  assert.deepEqual(canonicalizeCkg(ccm, sources, "not-a-hash"), { ok: false, errorCode: "CKG_CONFIGURATION_HASH_INVALID" });
});
