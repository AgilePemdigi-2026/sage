import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { canonicalizeCcm } from "../packages/contracts/src/index.ts";
import { canonicalizeStageCcm, createCkgStageHandlers } from "../apps/worker/src/ckg-handlers.ts";
import type { AnalysisStageTargetContext } from "../packages/database/src/stages.ts";
import type { AnalysisStageContext } from "../apps/worker/src/stage-runner.ts";

const ccm = JSON.parse(readFileSync(new URL("../packages/contracts/examples/minimum-ccm.json", import.meta.url), "utf8"));
const bytes = { "src/example.ts": new Uint8Array(readFileSync(new URL("../packages/contracts/examples/minimum-ccm.source.ts", import.meta.url))) };
function fixture() {
  // Use the path recorded by the contract fixture instead of assuming a parser-specific path.
  const source = { [ccm.files[0].path]: bytes["src/example.ts"] };
  const canonical = canonicalizeCcm(ccm, source);
  assert.ok(canonical.ok);
  const target: AnalysisStageTargetContext = {
    analysisId: "analysis-ckg14", repositoryId: "repo-ckg14", repositoryFullName: ccm.snapshot.repository,
    repositoryVisibility: "PUBLIC", branchName: ccm.snapshot.branch, commitSha: ccm.snapshot.commitSha,
    configurationHash: "a".repeat(64), analyzerVersion: "test", schemaVersion: "1",
  };
  return { source, canonical, target, artifact: { ccm: canonical.value, contentSha256: canonical.sha256 } };
}

test("CKG stage boundary revalidates serialized CCM bytes, hash and immutable target", () => {
  const { source, canonical, target, artifact } = fixture();
  assert.equal(canonicalizeStageCcm(JSON.parse(JSON.stringify(artifact)), source, target).sha256, canonical.sha256);
  for (const change of [{ repositoryFullName: "other/repo" }, { branchName: "other" }, { commitSha: "b".repeat(40) }]) {
    assert.throws(() => canonicalizeStageCcm(artifact, source, { ...target, ...change }), /Snapshot/);
  }
  assert.throws(() => canonicalizeStageCcm({ ...artifact, contentSha256: "b".repeat(64) }, source, target), /Snapshot/);
  const altered = { [ccm.files[0].path]: new Uint8Array(source[ccm.files[0].path]) };
  altered[ccm.files[0].path][0] ^= 1;
  assert.throws(() => canonicalizeStageCcm(artifact, altered, target), /Snapshot/);
});

test("CKG handlers reject cancellation and missing snapshot before accessing persistence", async () => {
  const handlers = createCkgStageHandlers({
    claim: { jobId: "job-14", analysisId: "analysis-ckg14", ownerUserId: "owner-14", attempt: 1, leaseToken: "11111111-1111-4111-8111-111111111111", leaseExpiresAt: new Date(Date.now() + 30000) },
    storageRoot: "/unused",
  });
  const context = { target: fixture().target, configuration: {}, previousStages: {}, sourceSnapshot: null } satisfies AnalysisStageContext;
  for (const handler of Object.values(handlers)) {
    await assert.rejects(handler(context, AbortSignal.abort()), { name: "AbortError" });
    await assert.rejects(handler(context, new AbortController().signal), /Snapshot/);
  }
});
