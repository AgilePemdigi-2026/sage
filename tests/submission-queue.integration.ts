import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import {
  AnalysisIdempotencyConflictError,
  database,
  disconnectDatabase,
  enqueueAnalysis,
  findEnqueuedAnalysisRequest,
} from "../packages/database/src/index.ts";
import type { PrismaClient } from "../packages/database/generated/client.ts";

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function assertIsolatedSnapshotDatabase(): void {
  if (process.env.SAGE_SNAPSHOT_TESTS !== "1") throw new Error("Set SAGE_SNAPSHOT_TESTS=1 to run destructive REP-02 integration fixtures.");
  const rawUrl = process.env.DATABASE_URL;
  if (!rawUrl) throw new Error("DATABASE_URL is required for REP-02 integration tests.");
  let databaseName: string;
  try {
    databaseName = decodeURIComponent(new URL(rawUrl).pathname.slice(1));
  } catch {
    throw new Error("DATABASE_URL is invalid; it was not logged.");
  }
  if (databaseName !== "sage_snapshot08") throw new Error("REP-02 integration tests only allow the isolated sage_snapshot08 database.");
}

async function cleanup(db: PrismaClient, userIds: string[], repositoryId: string, jobIds: string[]): Promise<void> {
  await db.$transaction(async (tx) => {
    if (jobIds.length > 0) {
      await tx.workerSlot.updateMany({
        where: { jobId: { in: jobIds } },
        data: { jobId: null, ownerUserId: null, leaseUntil: null, heartbeatAt: null, leaseTokenHash: null },
      });
      await tx.job.deleteMany({ where: { id: { in: jobIds }, ownerUserId: { in: userIds } } });
    }
    await tx.analysis.deleteMany({ where: { ownerUserId: { in: userIds } } });
    await tx.user.deleteMany({ where: { id: { in: userIds } } });
    if (repositoryId) await tx.repository.deleteMany({ where: { id: repositoryId } });
  });
}

test("REP-02 idempotency replays immutable targets, isolates owners, serializes concurrency and rolls back atomically", {
  skip: process.env.SAGE_SNAPSHOT_TESTS !== "1",
}, async () => {
  assertIsolatedSnapshotDatabase();
  const db = database();
  const suffix = randomUUID();
  const userIds: string[] = [];
  const jobIds: string[] = [];
  let repositoryId = "";
  let triggerInstalled = false;
  try {
    const owner = await db.user.create({ data: { githubUserId: `rep02-owner-${suffix}`, login: `rep02-owner-${suffix}` } });
    userIds.push(owner.id);
    const otherOwner = await db.user.create({ data: { githubUserId: `rep02-other-${suffix}`, login: `rep02-other-${suffix}` } });
    userIds.push(otherOwner.id);
    const repository = await db.repository.create({
      data: {
        githubRepositoryId: `rep02-repo-${suffix}`,
        ownerLogin: "sage-rep02-test",
        name: suffix,
        fullName: `sage-rep02-test/${suffix}`,
        visibility: "PUBLIC",
      },
    });
    repositoryId = repository.id;
    const base = {
      ownerUserId: owner.id,
      repositoryId: repository.id,
      branchName: "main",
      configuration: { includeTests: false },
      analyzerVersion: "rep02-test-1",
      schemaVersion: "1",
    };

    const keyHash = sha256(`key-${suffix}`);
    const requestHash = sha256(`request-${suffix}`);
    const idempotency = { keyHash, requestHash };
    const first = await enqueueAnalysis(db, { ...base, commitSha: "A".repeat(40), idempotency });
    jobIds.push(first.jobId);
    assert.equal(first.commitSha, "a".repeat(40));
    assert.equal(first.status, "QUEUED");
    assert.equal(first.replayed, undefined);

    const sequenceAfterFirst = (await db.workerSlot.findUniqueOrThrow({ where: { slotKey: "analysis" }, select: { lastEnqueueSequence: true } })).lastEnqueueSequence;
    const preResolvedReplay = await findEnqueuedAnalysisRequest(db, owner.id, keyHash, requestHash);
    assert.deepEqual(preResolvedReplay, { ...first, replayed: true });

    // A retry after main advances must still point to the first request's persisted commit.
    const movedHeadReplay = await enqueueAnalysis(db, { ...base, commitSha: "B".repeat(40), idempotency });
    assert.equal(movedHeadReplay.analysisId, first.analysisId);
    assert.equal(movedHeadReplay.jobId, first.jobId);
    assert.equal(movedHeadReplay.commitSha, "a".repeat(40));
    assert.equal(movedHeadReplay.status, "QUEUED");
    assert.equal(movedHeadReplay.replayed, true);
    assert.equal((await db.workerSlot.findUniqueOrThrow({ where: { slotKey: "analysis" }, select: { lastEnqueueSequence: true } })).lastEnqueueSequence, sequenceAfterFirst);

    const otherOwnerReplay = await findEnqueuedAnalysisRequest(db, otherOwner.id, keyHash, requestHash);
    assert.equal(otherOwnerReplay, null, "the same hashed key is scoped to its owner");
    const otherOwnerEnqueue = await enqueueAnalysis(db, { ...base, ownerUserId: otherOwner.id, commitSha: "C".repeat(40), idempotency });
    jobIds.push(otherOwnerEnqueue.jobId);
    assert.notEqual(otherOwnerEnqueue.analysisId, first.analysisId);

    const conflictHash = sha256(`different-request-${suffix}`);
    await assert.rejects(
      enqueueAnalysis(db, { ...base, commitSha: "D".repeat(40), idempotency: { keyHash, requestHash: conflictHash } }),
      (error: unknown) => error instanceof AnalysisIdempotencyConflictError,
    );
    await assert.rejects(
      findEnqueuedAnalysisRequest(db, owner.id, keyHash, conflictHash),
      (error: unknown) => error instanceof AnalysisIdempotencyConflictError,
    );
    assert.equal(await db.analysis.count({ where: { ownerUserId: owner.id, idempotencyKeyHash: keyHash } }), 1);

    const concurrentIdempotency = { keyHash: sha256(`concurrent-key-${suffix}`), requestHash: sha256(`concurrent-request-${suffix}`) };
    const concurrent = await Promise.all([
      enqueueAnalysis(db, { ...base, commitSha: "E".repeat(40), idempotency: concurrentIdempotency }),
      enqueueAnalysis(db, { ...base, commitSha: "F".repeat(40), idempotency: concurrentIdempotency }),
    ]);
    jobIds.push(...concurrent.map(({ jobId }) => jobId));
    assert.equal(concurrent[0].analysisId, concurrent[1].analysisId);
    assert.equal(concurrent[0].jobId, concurrent[1].jobId);
    assert.equal(concurrent.filter(({ replayed }) => replayed === true).length, 1);
    assert.equal(concurrent.filter(({ replayed }) => replayed === undefined).length, 1);
    assert.ok(["e".repeat(40), "f".repeat(40)].includes(concurrent[0].commitSha ?? ""));
    assert.equal(await db.analysis.count({ where: { ownerUserId: owner.id, idempotencyKeyHash: concurrentIdempotency.keyHash } }), 1);

    const rollbackIdempotency = { keyHash: sha256(`rollback-key-${suffix}`), requestHash: sha256(`rollback-request-${suffix}`) };
    await db.$executeRaw`
      CREATE OR REPLACE FUNCTION "rep02_fail_analysis_job_insert"() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN
        IF NEW."type" = 'ANALYSIS' THEN RAISE EXCEPTION 'REP-02 rollback fixture'; END IF;
        RETURN NEW;
      END; $$
    `;
    await db.$executeRaw`DROP TRIGGER IF EXISTS "rep02_fail_analysis_job_insert_trigger" ON "Job"`;
    await db.$executeRaw`
      CREATE TRIGGER "rep02_fail_analysis_job_insert_trigger"
      BEFORE INSERT ON "Job" FOR EACH ROW EXECUTE FUNCTION "rep02_fail_analysis_job_insert"()
    `;
    triggerInstalled = true;
    await assert.rejects(
      enqueueAnalysis(db, { ...base, commitSha: "9".repeat(40), idempotency: rollbackIdempotency }),
      /REP-02 rollback fixture/,
    );
    await db.$executeRaw`DROP TRIGGER IF EXISTS "rep02_fail_analysis_job_insert_trigger" ON "Job"`;
    await db.$executeRaw`DROP FUNCTION IF EXISTS "rep02_fail_analysis_job_insert"()`;
    triggerInstalled = false;
    assert.equal(await findEnqueuedAnalysisRequest(db, owner.id, rollbackIdempotency.keyHash, rollbackIdempotency.requestHash), null);
    const afterRollback = await enqueueAnalysis(db, { ...base, commitSha: "9".repeat(40), idempotency: rollbackIdempotency });
    jobIds.push(afterRollback.jobId);
    assert.equal(afterRollback.replayed, undefined);
    assert.equal(await db.analysis.count({ where: { ownerUserId: owner.id, idempotencyKeyHash: rollbackIdempotency.keyHash } }), 1);
  } finally {
    if (triggerInstalled) {
      await db.$executeRaw`DROP TRIGGER IF EXISTS "rep02_fail_analysis_job_insert_trigger" ON "Job"`;
      await db.$executeRaw`DROP FUNCTION IF EXISTS "rep02_fail_analysis_job_insert"()`;
    }
    try {
      await cleanup(db, userIds, repositoryId, jobIds);
    } finally {
      await disconnectDatabase();
    }
  }
});
