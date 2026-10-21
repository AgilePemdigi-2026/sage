import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { pack } from "tar-stream";
import test from "node:test";
import { ANALYSIS_STAGE_DEFINITIONS, type AnalysisStageKey, canonicalizeCcm, parseCanonicalCkg } from "../packages/contracts/src/index.ts";
import { database, disconnectDatabase, enqueueAnalysis, claimAnalysisJob, failAnalysisJob } from "../packages/database/src/index.ts";
import { createCkgStageHandlers } from "../apps/worker/src/ckg-handlers.ts";
import { createSourceStageHandlers } from "../apps/worker/src/source-handlers.ts";
import { runAnalysisStages, type AnalysisStageHandlers, type AnalysisStageHandler } from "../apps/worker/src/stage-runner.ts";
import { writeSnapshotArchive } from "../apps/worker/src/snapshot/storage.ts";
import type { AnalysisJobClaim } from "../packages/database/src/queue.ts";

async function archive(files: Record<string, Uint8Array>) {
  const stream = pack();
  const chunks: Buffer[] = [];
  const collecting = (async () => { for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array)); })();
  await new Promise<void>((resolve, reject) => stream.entry({ name: "snapshot/", type: "directory", mtime: new Date(0) }, error => error ? reject(error) : resolve()));
  for (const [path, bytes] of Object.entries(files)) {
    await new Promise<void>((resolve, reject) => stream.entry({ name: `snapshot/${path}`, size: bytes.byteLength, type: "file", mtime: new Date(0) }, Buffer.from(bytes), error => error ? reject(error) : resolve()));
  }
  stream.finalize();
  await collecting;
  return gzipSync(Buffer.concat(chunks));
}

test("real snapshot and mixed-language handlers persist canonical CKG without publishing a completed analysis", {
  skip: process.env.SAGE_CKG_TESTS !== "1",
}, async () => {
  assert.equal(new URL(process.env.DATABASE_URL!).pathname, "/sage_ckg14", "only isolated test DB is allowed");
  const db = database();
  const suffix = randomUUID();
  let ownerId = "";
  let repositoryId = "";
  let claim: AnalysisJobClaim | null = null;
  const storageRoot = await mkdtemp(join(tmpdir(), "sage-ckg14-"));
  try {
    const owner = await db.user.create({ data: { githubUserId: `ckg-stage-${suffix}`, login: `ckg-stage-${suffix}` } });
    ownerId = owner.id;
    const repository = await db.repository.create({ data: { githubRepositoryId: `ckg-stage-${suffix}`, ownerLogin: "fixture", name: suffix, fullName: `fixture/${suffix}`, visibility: "PUBLIC" } });
    repositoryId = repository.id;
    const enqueued = await enqueueAnalysis(db, { ownerUserId: owner.id, repositoryId, branchName: "main", commitSha: "a".repeat(40), configuration: {}, analyzerVersion: "ckg14-integration", schemaVersion: "1" });
    claim = await claimAnalysisJob(db, { leaseDurationMs: 300000 });
    assert.ok(claim);
    assert.equal(claim.analysisId, enqueued.analysisId);
    const currentClaim = claim;
    const sources = {
      "src/app.ts": new TextEncoder().encode('\ufeffexport class Café { run(): void {} }\r\nconst app = new Café(); app.run(); external.run();\r\n'),
      "src/app.php": new TextEncoder().encode('<?php\nclass Worker { public function run(): void {} }\n$worker = new Worker(); $worker->run();\n'),
      "src/canary.js": new TextEncoder().encode('throw new Error("SOURCE_MUST_NEVER_EXECUTE"); export function ready() { return true; }\n'),
      "README.md": new TextEncoder().encode('fixture only'),
    };
    const bytes = await archive(sources);
    let observedGraphHash = "";
    const partial: Partial<Record<AnalysisStageKey, AnalysisStageHandler>> = {
      SNAPSHOT: async (context, signal) => {
        const stored = await writeSnapshotArchive(db, { claim: currentClaim, storageRoot, archive: bytes, sha256: createHash("sha256").update(bytes).digest("hex"), signal });
        return { ...stored, commitSha: context.target.commitSha };
      },
      ...createSourceStageHandlers({ claim: currentClaim, storageRoot, db }),
      ...createCkgStageHandlers({ claim: currentClaim, storageRoot, db }),
      INTERFACE_CATALOG: async context => {
        const artifact = context.previousStages.KNOWLEDGE_GRAPH as { graph: unknown; contentSha256: string; graphBundleId: string };
        const row = await db.graphBundle.findUniqueOrThrow({ where: { id: artifact.graphBundleId } });
        assert.equal(row.ownerUserId, ownerId);
        assert.equal(row.analysisId, currentClaim.analysisId);
        assert.ok(row.canonicalContent);
        const replay = parseCanonicalCkg(row.canonicalContent, sources, row.contentHash);
        assert.ok(replay.ok);
        assert.deepEqual(replay.value, JSON.parse(JSON.stringify(artifact.graph)));
        assert.equal(replay.sha256, artifact.contentSha256);
        observedGraphHash = replay.sha256;
        assert.equal(replay.value.ccm.files.length, 4);
        assert.ok(replay.value.ccm.nodes.some(node => node.language === "php"));
        assert.ok(replay.value.ccm.nodes.some(node => node.language === "typescript"));
        assert.ok(replay.value.counts.unresolvedEdges > 0);
        assert.equal(replay.value.counts.referenceEdges + replay.value.counts.containmentEdges, row.edgeCount);
        const ccm = canonicalizeCcm(replay.value.ccm, sources);
        assert.ok(ccm.ok);
        const previous = context.previousStages.COMMON_CODE_MODEL as { contentSha256: string };
        assert.equal(ccm.sha256, previous.contentSha256, "CKG does not rewrite CCM facts");
        return { testOnlyPlaceholder: true };
      },
    };
    for (const { key } of ANALYSIS_STAGE_DEFINITIONS) {
      if (!partial[key]) partial[key] = async () => ({ testOnlyPlaceholder: true });
    }
    const result = await runAnalysisStages(db, currentClaim, partial as AnalysisStageHandlers, { leaseDurationMs: 300000 });
    assert.equal(result.stagesFinished, true, JSON.stringify(result.stages));
    assert.equal(result.stages.length, 9);
    assert.equal(observedGraphHash.length, 64);
    const persisted = await db.analysis.findUniqueOrThrow({ where: { id: currentClaim.analysisId } });
    assert.equal(persisted.status, "RUNNING", "placeholders after stage 5 do not publish a completed result");
    assert.equal(await db.architectureDocument.count({ where: { analysisId: currentClaim.analysisId } }), 0);
  } finally {
    if (claim) await failAnalysisJob(db, claim, "CKG_TEST_CLEANUP").catch(() => false);
    if (ownerId) {
      await db.workerSlot.updateMany({ where: { ownerUserId: ownerId }, data: { jobId: null, ownerUserId: null, leaseUntil: null, heartbeatAt: null, leaseTokenHash: null } });
      await db.job.deleteMany({ where: { ownerUserId: ownerId } });
      await db.storageObject.deleteMany({ where: { ownerUserId: ownerId } });
      await db.analysis.deleteMany({ where: { ownerUserId: ownerId } });
      await db.user.delete({ where: { id: ownerId } });
    }
    if (repositoryId) await db.repository.delete({ where: { id: repositoryId } });
    await rm(storageRoot, { recursive: true, force: true });
    await disconnectDatabase();
  }
});
