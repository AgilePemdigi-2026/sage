import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";
import {
  claimAnalysisJob,
  database,
  disconnectDatabase,
  enqueueAnalysis,
  failAnalysisJob,
  getOwnerAnalysisProgress,
  renewAnalysisLease,
} from "../packages/database/src/index.ts";
import type { AnalysisJobClaim } from "../packages/database/src/queue.ts";
import type { PrismaClient } from "../packages/database/generated/client.ts";

const allowedDatabases = new Set(["sage_queue01", "sage_queue01_fresh"]);

function assertIsolatedQueueDatabase(): void {
  if (process.env.SAGE_QUEUE_TESTS !== "1") throw new Error("Set SAGE_QUEUE_TESTS=1 to run destructive ANA-01 integration fixtures.");
  const rawUrl = process.env.DATABASE_URL;
  if (!rawUrl) throw new Error("DATABASE_URL is required for ANA-01 integration tests.");
  let databaseName: string;
  try {
    databaseName = decodeURIComponent(new URL(rawUrl).pathname.slice(1));
  } catch {
    throw new Error("DATABASE_URL is invalid; it was not logged.");
  }
  if (!allowedDatabases.has(databaseName)) throw new Error("ANA-01 integration tests only allow the isolated queue databases.");
}

function queueWorker(mode: "claim" | "renew", claim?: AnalysisJobClaim): Promise<AnalysisJobClaim | { leaseExpiresAt: string | null } | null> {
  const helper = resolve(process.cwd(), "tests/helpers/queue-worker.ts");
  const args = ["--import", "tsx", helper, mode];
  if (claim) args.push(JSON.stringify(claim));
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => child.kill("SIGKILL"), 20_000);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(`Queue test worker exited with code ${code}: ${stderr.slice(0, 1_000)}`));
        return;
      }
      try {
        const line = stdout.trim().split("\n").at(-1);
        if (!line) throw new Error("Queue test worker returned no result.");
        resolveResult(JSON.parse(line) as AnalysisJobClaim | { leaseExpiresAt: string | null } | null);
      } catch (error) {
        reject(error);
      }
    });
  });
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
    await tx.repository.deleteMany({ where: { id: repositoryId } });
  });
}

test("ANA-01 PostgreSQL queue is atomic, FIFO, globally fenced and recoverable across processes", async () => {
  assertIsolatedQueueDatabase();
  const db = database();
  const suffix = randomUUID();
  const userIds: string[] = [];
  const jobIds: string[] = [];
  let repositoryId = "";
  try {
    const owner = await db.user.create({ data: { githubUserId: `queue01-owner-${suffix}`, login: `queue01-owner-${suffix}` } });
    userIds.push(owner.id);
    const otherOwner = await db.user.create({ data: { githubUserId: `queue01-other-${suffix}`, login: `queue01-other-${suffix}` } });
    userIds.push(otherOwner.id);
    const repository = await db.repository.create({
      data: {
        githubRepositoryId: `queue01-repo-${suffix}`,
        ownerLogin: "sage-queue-test",
        name: suffix,
        fullName: `sage-queue-test/${suffix}`,
        visibility: "PUBLIC",
      },
    });
    repositoryId = repository.id;

    const base = {
      ownerUserId: owner.id,
      repositoryId: repository.id,
      branchName: "main",
      configuration: { z: 1, a: { y: true, x: null } },
      analyzerVersion: "queue-test-1",
      schemaVersion: "1",
    };
    const first = await enqueueAnalysis(db, { ...base, commitSha: "A".repeat(40) });
    jobIds.push(first.jobId);
    const second = await enqueueAnalysis(db, { ...base, commitSha: "b".repeat(64) });
    jobIds.push(second.jobId);

    const expectedConfigurationHash = createHash("sha256").update('{"a":{"x":null,"y":true},"z":1}', "utf8").digest("hex");
    const firstAnalysis = await db.analysis.findUniqueOrThrow({ where: { id: first.analysisId } });
    assert.equal(firstAnalysis.commitSha, "a".repeat(40));
    assert.equal(firstAnalysis.configurationHash, expectedConfigurationHash);
    assert.deepEqual(firstAnalysis.configuration, { a: { x: null, y: true }, z: 1 });
    assert.equal(first.configurationHash, expectedConfigurationHash);
    const [firstJob, secondJob] = await Promise.all([
      db.job.findUniqueOrThrow({ where: { id: first.jobId }, select: { queueSequence: true } }),
      db.job.findUniqueOrThrow({ where: { id: second.jobId }, select: { queueSequence: true } }),
    ]);
    assert.ok(firstJob.queueSequence !== null && secondJob.queueSequence !== null && firstJob.queueSequence < secondJob.queueSequence);

    const analysisCountBeforeInvalidEnqueue = await db.analysis.count({ where: { ownerUserId: owner.id } });
    await assert.rejects(enqueueAnalysis(db, { ...base, repositoryId: `missing-${suffix}`, commitSha: "c".repeat(40) }));
    assert.equal(await db.analysis.count({ where: { ownerUserId: owner.id } }), analysisCountBeforeInvalidEnqueue);

    const concurrentClaims = await Promise.all([queueWorker("claim"), queueWorker("claim")]);
    const claims = concurrentClaims.filter((value): value is AnalysisJobClaim => value !== null && "leaseToken" in value);
    assert.equal(claims.length, 1, "exactly one separate worker process must claim the global slot");
    const firstClaim = claims[0];
    assert.equal(firstClaim.analysisId, first.analysisId, "the oldest enqueued analysis must be claimed first");
    assert.equal(await db.analysis.count({ where: { status: "RUNNING" } }), 1);
    assert.equal(await db.job.count({ where: { type: "ANALYSIS", status: "RUNNING" } }), 1);

    await assert.rejects(db.analysis.update({ where: { id: second.analysisId }, data: { status: "RUNNING" } }));
    await assert.rejects(db.job.update({ where: { id: second.jobId }, data: { status: "RUNNING" } }));

    const heartbeat = await renewAnalysisLease(db, firstClaim, { leaseDurationMs: 60_000 });
    assert.ok(heartbeat instanceof Date);
    const heartbeatRows = await db.$queryRaw<Array<{ slotLease: Date; jobLease: Date }>>`
      SELECT slot."leaseUntil" AS "slotLease", job."leaseExpiresAt" AS "jobLease"
      FROM "WorkerSlot" AS slot JOIN "Job" AS job ON job."id" = slot."jobId" AND job."ownerUserId" = slot."ownerUserId"
      WHERE slot."slotKey" = 'analysis' AND job."id" = ${firstClaim.jobId}
    `;
    assert.equal(heartbeatRows.length, 1);
    assert.equal(heartbeatRows[0].slotLease.getTime(), heartbeatRows[0].jobLease.getTime());

    await db.analysisStage.createMany({
      data: [
        { ownerUserId: owner.id, analysisId: first.analysisId, sequence: 1, key: "snapshot", status: "RUNNING", startedAt: new Date() },
        { ownerUserId: owner.id, analysisId: first.analysisId, sequence: 2, key: "parse", status: "PENDING" },
      ],
    });

    const firstTokenHash = createHash("sha256").update(firstClaim.leaseToken, "utf8").digest("hex");
    await db.$executeRaw`
      UPDATE "WorkerSlot"
      SET "leaseUntil" = clock_timestamp() - INTERVAL '1 second'
      WHERE "slotKey" = 'analysis' AND "jobId" = ${firstClaim.jobId} AND "ownerUserId" = ${owner.id}
        AND "leaseTokenHash" = ${firstTokenHash}
    `;
    await db.$executeRaw`
      UPDATE "Job"
      SET "leaseExpiresAt" = clock_timestamp() - INTERVAL '1 second'
      WHERE "id" = ${firstClaim.jobId} AND "ownerUserId" = ${owner.id} AND "attempt" = ${firstClaim.attempt}
    `;
    assert.equal(await renewAnalysisLease(db, firstClaim), null, "an expired lease cannot be revived");
    assert.equal(await failAnalysisJob(db, firstClaim, "STALE_WORKER"), false, "an expired lease cannot write failure state");

    try {
      await db.$executeRaw`
        CREATE OR REPLACE FUNCTION "queue01_fail_stage_recovery"() RETURNS trigger
        LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'ANA-01 recovery rollback fixture'; END; $$
      `;
      await db.$executeRaw`
        CREATE TRIGGER "queue01_fail_stage_recovery_trigger"
        BEFORE UPDATE ON "AnalysisStage"
        FOR EACH ROW
        WHEN (OLD."status" = 'RUNNING' AND NEW."status" = 'FAILED' AND NEW."errorCode" = 'WORKER_INTERRUPTED')
        EXECUTE FUNCTION "queue01_fail_stage_recovery"()
      `;
      await assert.rejects(claimAnalysisJob(db), /ANA-01 recovery rollback fixture/);
    } finally {
      await db.$executeRaw`DROP TRIGGER IF EXISTS "queue01_fail_stage_recovery_trigger" ON "AnalysisStage"`;
      await db.$executeRaw`DROP FUNCTION IF EXISTS "queue01_fail_stage_recovery"()`;
    }
    const rollbackAnalysis = await db.analysis.findUniqueOrThrow({ where: { id: first.analysisId }, select: { status: true, errorCode: true } });
    const rollbackJob = await db.job.findUniqueOrThrow({ where: { id: first.jobId }, select: { status: true, errorCode: true } });
    const rollbackSlot = await db.workerSlot.findUniqueOrThrow({ where: { slotKey: "analysis" }, select: { jobId: true, leaseTokenHash: true } });
    assert.deepEqual(rollbackAnalysis, { status: "RUNNING", errorCode: null });
    assert.deepEqual(rollbackJob, { status: "RUNNING", errorCode: null });
    assert.equal(rollbackSlot.jobId, firstClaim.jobId);
    assert.equal(rollbackSlot.leaseTokenHash, firstTokenHash);

    const recoveryClaimResult = await queueWorker("claim");
    if (!recoveryClaimResult || !("leaseToken" in recoveryClaimResult)) throw new Error("Fresh worker failed to claim the next analysis.");
    const secondClaim = recoveryClaimResult;
    assert.equal(secondClaim.analysisId, second.analysisId, "a new process must recover the expired head and claim the next FIFO job");

    const recoveredAnalysis = await db.analysis.findUniqueOrThrow({ where: { id: first.analysisId }, select: { status: true, errorCode: true } });
    const recoveredJob = await db.job.findUniqueOrThrow({ where: { id: first.jobId }, select: { status: true, errorCode: true } });
    const recoveredStages = await db.analysisStage.findMany({ where: { analysisId: first.analysisId }, orderBy: { sequence: "asc" }, select: { status: true, errorCode: true } });
    assert.deepEqual(recoveredAnalysis, { status: "FAILED", errorCode: "WORKER_INTERRUPTED" });
    assert.deepEqual(recoveredJob, { status: "FAILED", errorCode: "WORKER_INTERRUPTED" });
    assert.deepEqual(recoveredStages, [
      { status: "FAILED", errorCode: "WORKER_INTERRUPTED" },
      { status: "PENDING", errorCode: null },
    ]);
    assert.equal(await db.analysis.count({ where: { status: "RUNNING" } }), 1);
    assert.equal(await failAnalysisJob(db, firstClaim, "STALE_WORKER"), false, "the old token cannot release the second worker's slot");
    const activeSlot = await db.workerSlot.findUniqueOrThrow({ where: { slotKey: "analysis" }, select: { jobId: true } });
    assert.equal(activeSlot.jobId, secondClaim.jobId);

    assert.equal(await getOwnerAnalysisProgress(db, otherOwner.id, first.analysisId), null);
    const ownerProgress = await getOwnerAnalysisProgress(db, owner.id, second.analysisId);
    assert.equal(ownerProgress?.status, "RUNNING");
    assert.ok(!JSON.stringify(ownerProgress).includes("leaseToken"));
    assert.equal(await failAnalysisJob(db, secondClaim, "TEST_FAILURE"), true);
    assert.equal(await failAnalysisJob(db, secondClaim, "TEST_FAILURE"), false);
    const failedAnalysis = await db.analysis.findUniqueOrThrow({ where: { id: second.analysisId }, select: { status: true, errorCode: true } });
    assert.deepEqual(failedAnalysis, { status: "FAILED", errorCode: "TEST_FAILURE" });
  } finally {
    try {
      await cleanup(db, userIds, repositoryId, jobIds);
    } finally {
      await disconnectDatabase();
    }
  }
});
