import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { enqueueAnalysis, claimAnalysisJob, failAnalysisJob, database, disconnectDatabase } from "../packages/database/src/index.ts";
import { initializeAnalysisStages, startAnalysisStage, completeAnalysisStage } from "../packages/database/src/stages.ts";
import { persistCanonicalGraph, readCanonicalGraphForUser } from "../packages/database/src/graphs.ts";
import type { AnalysisJobClaim } from "../packages/database/src/queue.ts";

function assertIsolatedDatabase(): void {
  if (process.env.SAGE_CKG_TESTS !== "1") throw new Error("Set SAGE_CKG_TESTS=1 to run destructive CKG persistence integration tests.");
  const rawUrl = process.env.DATABASE_URL;
  if (!rawUrl) throw new Error("DATABASE_URL is required for CKG persistence integration tests.");
  let databaseName: string;
  try { databaseName = decodeURIComponent(new URL(rawUrl).pathname.slice(1)); }
  catch { throw new Error("DATABASE_URL is invalid; it was not logged."); }
  if (databaseName !== "sage_ckg14") throw new Error("CKG persistence tests only allow the isolated sage_ckg14 database.");
}

test("CKG persistence is owner and lease fenced, immutable, canonical and hidden before publication", {
  skip: process.env.SAGE_CKG_TESTS !== "1",
}, async () => {
  assertIsolatedDatabase();
  const db = database();
  const suffix = randomUUID();
  const users: string[] = [];
  const jobs: string[] = [];
  const claims: AnalysisJobClaim[] = [];
  let repositoryId = "";
  try {
    const owner = await db.user.create({ data: { githubUserId: `ckg-owner-${suffix}`, login: `ckg-owner-${suffix}` } });
    users.push(owner.id);
    const other = await db.user.create({ data: { githubUserId: `ckg-other-${suffix}`, login: `ckg-other-${suffix}` } });
    users.push(other.id);
    const repository = await db.repository.create({ data: {
      githubRepositoryId: `ckg-repo-${suffix}`,
      ownerLogin: "sage-ckg-test", name: suffix, fullName: `sage-ckg-test/${suffix}`, visibility: "PUBLIC",
    } });
    repositoryId = repository.id;
    const enqueued = await enqueueAnalysis(db, {
      ownerUserId: owner.id, repositoryId: repository.id, branchName: "main",
      commitSha: "a".repeat(40), configuration: { includeTests: false },
      analyzerVersion: "ckg-test", schemaVersion: "1",
    });
    const submittedRepositoryName = repository.fullName;
    await db.repository.update({
      where: { id: repository.id },
      data: { ownerLogin: "sage-ckg-renamed", fullName: `sage-ckg-renamed/${suffix}` },
    });
    jobs.push(enqueued.jobId);
    const claim = await claimAnalysisJob(db, { leaseDurationMs: 300_000 });
    assert.ok(claim);
    claims.push(claim);
    assert.equal(claim.analysisId, enqueued.analysisId);
    const stageInput = await initializeAnalysisStages(db, claim);
    assert.equal(stageInput?.target.repositoryFullName, submittedRepositoryName, "worker target keeps the name captured at enqueue");
    for (const key of ["SNAPSHOT", "LANGUAGE_DETECTION", "STATIC_ANALYSIS", "COMMON_CODE_MODEL"] as const) {
      assert.equal(await startAnalysisStage(db, claim, key), true);
      assert.equal(await completeAnalysisStage(db, claim, key), true);
    }
    assert.equal(await startAnalysisStage(db, claim, "KNOWLEDGE_GRAPH"), true);

    const [sourceText, payloadText] = await Promise.all([
      readFile(new URL("../packages/contracts/examples/minimum-ccm.source.ts", import.meta.url), "utf8"),
      readFile(new URL("../packages/contracts/examples/minimum-ccm.json", import.meta.url), "utf8"),
    ]);
    const ccm = JSON.parse(payloadText) as Record<string, unknown>;
    ccm.snapshot = { repository: submittedRepositoryName, branch: "main", commitSha: "a".repeat(40) };
    const sourceBytes = { "examples/minimum-ccm.source.ts": new TextEncoder().encode(sourceText) };
    const persistInput = { claim, ccm, sourceBytes, configurationHash: enqueued.configurationHash };

    // A stale attempt/token and a forged owner cannot write this analysis.
    assert.equal(await persistCanonicalGraph(db, {
      ...persistInput,
      claim: { ...claim, leaseToken: "22222222-2222-4222-8222-222222222222" },
    }), null);
    assert.equal(await persistCanonicalGraph(db, {
      ...persistInput,
      claim: { ...claim, ownerUserId: other.id },
    }), null);

    // A real PostgreSQL trigger delays INSERT past the lease deadline. The final
    // fence must roll back the row, rather than merely report a stale lease.
    await db.$executeRawUnsafe(`CREATE FUNCTION ckg14_delay_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.4); RETURN NEW; END $$`);
    await db.$executeRawUnsafe(`CREATE TRIGGER ckg14_delay BEFORE INSERT ON "GraphBundle" FOR EACH ROW EXECUTE FUNCTION ckg14_delay_insert()`);
    try {
      await db.$executeRaw`UPDATE "WorkerSlot" SET "leaseUntil" = clock_timestamp() + interval '200 milliseconds' WHERE "jobId" = ${claim.jobId}`;
      await db.$executeRaw`UPDATE "Job" SET "leaseExpiresAt" = clock_timestamp() + interval '200 milliseconds' WHERE "id" = ${claim.jobId}`;
      assert.equal(await persistCanonicalGraph(db, persistInput), null, "expired lease rolls back the graph insertion");
      assert.equal(await db.graphBundle.count({ where: { analysisId: enqueued.analysisId } }), 0);
    } finally {
      await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ckg14_delay ON "GraphBundle"`);
      await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ckg14_delay_insert()`);
      await db.$executeRaw`UPDATE "WorkerSlot" SET "leaseUntil" = clock_timestamp() + interval '300 seconds' WHERE "jobId" = ${claim.jobId}`;
      await db.$executeRaw`UPDATE "Job" SET "leaseExpiresAt" = clock_timestamp() + interval '300 seconds' WHERE "id" = ${claim.jobId}`;
    }

    const stored = await persistCanonicalGraph(db, persistInput);
    assert.ok(stored);
    assert.equal(await persistCanonicalGraph(db, persistInput).then(value => value?.id), stored.id);
    assert.equal(await readCanonicalGraphForUser(db, owner.id, enqueued.analysisId, sourceBytes), null, "draft stays private until analysis is terminal");
    assert.equal(await readCanonicalGraphForUser(db, other.id, enqueued.analysisId, sourceBytes), null, "another user cannot read the analysis");

    const first = await db.graphBundle.findUniqueOrThrow({ where: { analysisId_ownerUserId: { analysisId: enqueued.analysisId, ownerUserId: owner.id } } });
    const altered = structuredClone(ccm);
    (altered.provenance as Record<string, unknown>).configHash = "d".repeat(64);
    await assert.rejects(persistCanonicalGraph(db, { ...persistInput, ccm: altered }), /immutable/);
    const afterConflict = await db.graphBundle.findUniqueOrThrow({ where: { id: first.id } });
    assert.equal(afterConflict.canonicalContent, first.canonicalContent, "conflicting replay rolls back without overwriting the canonical payload");
    assert.equal(afterConflict.contentHash, stored.contentHash);

    await db.analysis.update({ where: { id: enqueued.analysisId }, data: { status: "COMPLETED", completedAt: new Date() } });
    await db.repository.update({
      where: { id: repository.id },
      data: { ownerLogin: "sage-ckg-renamed-final", fullName: `sage-ckg-renamed-final/${suffix}` },
    });
    const visible = await readCanonicalGraphForUser(db, owner.id, enqueued.analysisId, sourceBytes);
    assert.equal(visible?.id, stored.id);
    assert.equal(visible?.contentHash, stored.contentHash);
    assert.equal(visible?.graph.ccm.snapshot.commitSha, "a".repeat(40));
    assert.equal(visible?.graph.ccm.snapshot.repository, submittedRepositoryName, "later repository renames do not change the result target");
  } finally {
    for (const claim of claims) await failAnalysisJob(db, claim, "CKG_TEST_CLEANUP").catch(() => false);
    await db.$transaction(async tx => {
      if (jobs.length) {
        await tx.workerSlot.updateMany({
          where: { jobId: { in: jobs } },
          data: { jobId: null, ownerUserId: null, leaseUntil: null, heartbeatAt: null, leaseTokenHash: null },
        });
        await tx.job.deleteMany({ where: { id: { in: jobs }, ownerUserId: { in: users } } });
      }
      await tx.analysis.deleteMany({ where: { ownerUserId: { in: users } } });
      await tx.user.deleteMany({ where: { id: { in: users } } });
      if (repositoryId) await tx.repository.deleteMany({ where: { id: repositoryId } });
    });
    await disconnectDatabase();
  }
});

test("legacy analysis captures current repository name once without reconstructing an unknown historical name", {
  skip: process.env.SAGE_CKG_TESTS !== "1",
}, async () => {
  assertIsolatedDatabase();
  const db = database();
  const suffix = randomUUID();
  let ownerId = "";
  let repositoryId = "";
  let claim: AnalysisJobClaim | null = null;
  try {
    const owner = await db.user.create({ data: { githubUserId: `legacy-${suffix}`, login: `legacy-${suffix}` } });
    ownerId = owner.id;
    const repository = await db.repository.create({ data: { githubRepositoryId: `legacy-${suffix}`, ownerLogin: "legacy", name: suffix, fullName: `legacy/${suffix}`, visibility: "PUBLIC" } });
    repositoryId = repository.id;
    const queued = await enqueueAnalysis(db, { ownerUserId: ownerId, repositoryId, branchName: "main", commitSha: "a".repeat(40), configuration: {}, analyzerVersion: "test", schemaVersion: "1" });
    await db.analysis.update({ where: { id: queued.analysisId }, data: { repositoryFullNameSnapshot: null } });
    await db.repository.update({ where: { id: repositoryId }, data: { fullName: `legacy-renamed/${suffix}` } });
    claim = await claimAnalysisJob(db, { leaseDurationMs: 300000 });
    assert.ok(claim);
    assert.equal(claim.analysisId, queued.analysisId);
    const first = await initializeAnalysisStages(db, claim);
    assert.equal(first?.target.repositoryFullName, `legacy-renamed/${suffix}`);
    await db.repository.update({ where: { id: repositoryId }, data: { fullName: `legacy-renamed-again/${suffix}` } });
    const second = await initializeAnalysisStages(db, claim);
    assert.equal(second?.target.repositoryFullName, first?.target.repositoryFullName, "legacy name is captured only once");
  } finally {
    if (claim) await failAnalysisJob(db, claim, "CKG_TEST_CLEANUP").catch(() => false);
    if (ownerId) {
      await db.workerSlot.updateMany({ where: { ownerUserId: ownerId }, data: { jobId: null, ownerUserId: null, leaseUntil: null, heartbeatAt: null, leaseTokenHash: null } });
      await db.job.deleteMany({ where: { ownerUserId: ownerId } });
      await db.analysis.deleteMany({ where: { ownerUserId: ownerId } });
      await db.user.delete({ where: { id: ownerId } });
    }
    if (repositoryId) await db.repository.delete({ where: { id: repositoryId } });
    await disconnectDatabase();
  }
});
