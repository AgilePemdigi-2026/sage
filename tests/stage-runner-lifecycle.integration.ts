import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { ANALYSIS_STAGE_DEFINITIONS, type AnalysisStageKey } from "../packages/contracts/src/stages.ts";
import {
  claimAnalysisJob,
  database,
  disconnectDatabase,
  enqueueAnalysis,
  failAnalysisJob,
  getOwnerAnalysisProgress,
} from "../packages/database/src/index.ts";
import type { AnalysisJobClaim } from "../packages/database/src/queue.ts";
import {
  AnalysisStageTransitionConflictError,
  runAnalysisStages,
  type AnalysisStageArtifact,
  type AnalysisStageContext,
  type AnalysisStageHandlers,
} from "../apps/worker/src/stage-runner.ts";
import type { PrismaClient } from "../packages/database/generated/client.ts";

const allowedDatabases = new Set(["sage_queue01", "sage_queue01_fresh"]);

function assertIsolatedQueueDatabase(): void {
  if (process.env.SAGE_QUEUE_TESTS !== "1") throw new Error("Set SAGE_QUEUE_TESTS=1 to run destructive ANA-07-S1 lifecycle fixtures.");
  const rawUrl = process.env.DATABASE_URL;
  if (!rawUrl) throw new Error("DATABASE_URL is required for ANA-07-S1 lifecycle tests.");
  let databaseName: string;
  try {
    databaseName = decodeURIComponent(new URL(rawUrl).pathname.slice(1));
  } catch {
    throw new Error("DATABASE_URL is invalid; it was not logged.");
  }
  if (!allowedDatabases.has(databaseName)) throw new Error("ANA-07-S1 lifecycle tests only allow sage_queue01 or sage_queue01_fresh.");
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function testOnlyHandlers(
  onStage: (key: AnalysisStageKey, context: AnalysisStageContext, signal: AbortSignal) => Promise<AnalysisStageArtifact | void> | AnalysisStageArtifact | void,
): AnalysisStageHandlers {
  const handlers: Partial<Record<AnalysisStageKey, AnalysisStageHandlers[AnalysisStageKey]>> = {};
  for (const { key } of ANALYSIS_STAGE_DEFINITIONS) {
    handlers[key] = async (context, signal) => onStage(key, context, signal);
  }
  return handlers as AnalysisStageHandlers;
}

async function cleanup(
  db: PrismaClient,
  userIds: string[],
  repositoryId: string,
  jobIds: string[],
  claims: AnalysisJobClaim[],
): Promise<void> {
  for (const claim of claims) {
    await failAnalysisJob(db, claim, "STAGE_TEST_CLEANUP").catch(() => false);
  }
  await db.$transaction(async (tx) => {
    if (jobIds.length > 0) {
      // A stale or expired test claim cannot release its slot through failAnalysisJob.
      // Limit this fallback to the exact fixture jobs and owner IDs created here.
      await tx.workerSlot.updateMany({
        where: { slotKey: "analysis", jobId: { in: jobIds }, ownerUserId: { in: userIds } },
        data: { jobId: null, ownerUserId: null, leaseUntil: null, heartbeatAt: null, leaseTokenHash: null },
      });
      await tx.job.deleteMany({ where: { id: { in: jobIds }, ownerUserId: { in: userIds } } });
    }
    await tx.analysis.deleteMany({ where: { ownerUserId: { in: userIds } } });
    await tx.user.deleteMany({ where: { id: { in: userIds } } });
    if (repositoryId) await tx.repository.deleteMany({ where: { id: repositoryId } });
  });
}

test("ANA-07-S1 stage runner heartbeats, fences duplicate and stale claims, and handles cancellation and lease loss", async () => {
  assertIsolatedQueueDatabase();
  const db = database();
  const suffix = randomUUID();
  const userIds: string[] = [];
  const jobIds: string[] = [];
  const claims: AnalysisJobClaim[] = [];
  let repositoryId = "";

  try {
    const owner = await db.user.create({ data: { githubUserId: `stage-life-${suffix}`, login: `stage-life-${suffix}` } });
    userIds.push(owner.id);
    const repository = await db.repository.create({
      data: {
        githubRepositoryId: `stage-life-repo-${suffix}`,
        ownerLogin: "sage-stage-lifecycle-test",
        name: suffix,
        fullName: `sage-stage-lifecycle-test/${suffix}`,
        visibility: "PUBLIC",
      },
    });
    repositoryId = repository.id;
    const common = {
      ownerUserId: owner.id,
      repositoryId: repository.id,
      branchName: "main",
      configuration: { includeTests: true },
      analyzerVersion: "stage-lifecycle-test-1",
      schemaVersion: "1",
    };
    let commitNumber = 0;
    const enqueueAndClaim = async (leaseDurationMs = 1_000): Promise<AnalysisJobClaim> => {
      commitNumber += 1;
      const commit = String.fromCharCode(64 + commitNumber).repeat(40);
      const enqueued = await enqueueAnalysis(db, { ...common, commitSha: commit });
      jobIds.push(enqueued.jobId);
      const claim = await claimAnalysisJob(db, { leaseDurationMs });
      assert.ok(claim, "the fixture analysis should be claimable");
      claims.push(claim);
      return claim;
    };

    // Keep SNAPSHOT blocked for longer than its one-second lease and prove the
    // runner heartbeat renews it while no stage handler can finish.
    const heartbeatClaim = await enqueueAndClaim();
    const handlerStarted = deferred<void>();
    const releaseHandler = deferred<void>();
    const heartbeatCalls: AnalysisStageKey[] = [];
    const heartbeatHandlers = testOnlyHandlers(async (key) => {
      heartbeatCalls.push(key);
      if (key === "SNAPSHOT") {
        handlerStarted.resolve(undefined);
        await releaseHandler.promise;
      }
      return { stage: key };
    });
    const originalHeartbeat = await db.workerSlot.findUniqueOrThrow({ where: { slotKey: "analysis" }, select: { heartbeatAt: true } });
    assert.ok(originalHeartbeat.heartbeatAt);
    const legitimateRun = runAnalysisStages(db, heartbeatClaim, heartbeatHandlers, { leaseDurationMs: 1_000 });
    await handlerStarted.promise;
    await delay(1_200);
    const leaseRows = await db.$queryRaw<Array<{ heartbeatAt: Date | null; leaseUntil: Date | null; dbNow: Date }>>`
      SELECT slot."heartbeatAt", slot."leaseUntil", clock_timestamp() AS "dbNow"
      FROM "WorkerSlot" AS slot
      WHERE slot."slotKey" = 'analysis' AND slot."jobId" = ${heartbeatClaim.jobId}
        AND slot."ownerUserId" = ${heartbeatClaim.ownerUserId}
    `;
    assert.equal(leaseRows.length, 1, "the active runner retains the global analysis slot");
    assert.ok(leaseRows[0].heartbeatAt && leaseRows[0].heartbeatAt > originalHeartbeat.heartbeatAt, "the heartbeat advances during a handler longer than the lease");
    assert.ok(leaseRows[0].leaseUntil && leaseRows[0].leaseUntil > leaseRows[0].dbNow, "the lease is still live after more than one second");
    assert.equal(await claimAnalysisJob(db, { leaseDurationMs: 1_000 }), null, "a second job cannot recover a heartbeat-protected lease");

    releaseHandler.resolve(undefined);
    const heartbeatResult = await legitimateRun;
    assert.equal(heartbeatResult.stagesFinished, true);
    assert.deepEqual(heartbeatCalls, ANALYSIS_STAGE_DEFINITIONS.map(({ key }) => key), "the legitimate runner completes each handler exactly once");
    assert.deepEqual(heartbeatResult.stages.map(({ status }) => status), Array(9).fill("COMPLETED"));
    assert.equal(await failAnalysisJob(db, heartbeatClaim, "STAGE_TEST_CLEANUP"), true);

    // A duplicate invocation with an already-aborted signal cannot fail the live
    // claim. A second duplicate asks for a shorter lease while the original runner
    // is blocked; its CAS conflict must preserve that original lease deadline.
    const duplicateClaim = await enqueueAndClaim(30_000);
    const duplicateStarted = deferred<void>();
    const releaseDuplicateHandler = deferred<void>();
    const duplicateCalls: AnalysisStageKey[] = [];
    let legitimateHandlerSignal: AbortSignal | undefined;
    const duplicateHandlers = testOnlyHandlers(async (key, _context, signal) => {
      duplicateCalls.push(key);
      if (key === "SNAPSHOT") {
        legitimateHandlerSignal = signal;
        duplicateStarted.resolve(undefined);
        await releaseDuplicateHandler.promise;
      }
      return { stage: key };
    });
    const duplicateRun = runAnalysisStages(db, duplicateClaim, duplicateHandlers);
    await duplicateStarted.promise;
    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    let abortedDuplicateReturned = false;
    try {
      await runAnalysisStages(db, duplicateClaim, duplicateHandlers, {
        signal: alreadyAborted.signal,
        leaseDurationMs: 1_000,
      });
      abortedDuplicateReturned = true;
    } catch (error) {
      assert.ok(error instanceof AnalysisStageTransitionConflictError, "an already-aborted duplicate may only observe the active stage conflict");
    }
    const duplicateProgress = await getOwnerAnalysisProgress(db, duplicateClaim.ownerUserId, duplicateClaim.analysisId);
    assert.equal(duplicateProgress?.status, "RUNNING", "an already-aborted duplicate cannot fail the legitimate analysis");
    assert.equal(duplicateProgress?.jobs[0]?.status, "RUNNING", "the legitimate job remains active after a duplicate invocation");
    assert.equal(duplicateProgress?.stages[0]?.status, "RUNNING", "the legitimate SNAPSHOT transition remains intact");
    assert.equal(legitimateHandlerSignal?.aborted, false, "an already-aborted duplicate cannot abort the legitimate handler");
    if (abortedDuplicateReturned) assert.equal(duplicateProgress?.jobs[0]?.errorCode, null);

    const leaseBeforeShortDuplicate = await db.$queryRaw<Array<{ leaseUntil: Date }>>`
      SELECT "leaseUntil" FROM "WorkerSlot"
      WHERE "slotKey" = 'analysis' AND "jobId" = ${duplicateClaim.jobId} AND "ownerUserId" = ${duplicateClaim.ownerUserId}
    `;
    assert.equal(leaseBeforeShortDuplicate.length, 1);
    await assert.rejects(
      runAnalysisStages(db, duplicateClaim, duplicateHandlers, { leaseDurationMs: 1_000 }),
      (error: unknown) => error instanceof AnalysisStageTransitionConflictError,
    );
    assert.deepEqual(duplicateCalls, ["SNAPSHOT"], "neither duplicate runner invokes the active handler again");
    const afterShortDuplicate = await db.$queryRaw<Array<{ leaseUntil: Date; dbNow: Date }>>`
      SELECT slot."leaseUntil", clock_timestamp() AS "dbNow"
      FROM "WorkerSlot" AS slot
      WHERE slot."slotKey" = 'analysis' AND slot."jobId" = ${duplicateClaim.jobId}
        AND slot."ownerUserId" = ${duplicateClaim.ownerUserId}
    `;
    assert.equal(afterShortDuplicate.length, 1);
    assert.ok(afterShortDuplicate[0].leaseUntil >= leaseBeforeShortDuplicate[0].leaseUntil, "a shorter duplicate renewal cannot shorten the current lease");
    assert.ok(afterShortDuplicate[0].leaseUntil > afterShortDuplicate[0].dbNow);
    await delay(1_200);
    const stillLiveAfterDuplicate = await db.$queryRaw<Array<{ leaseUntil: Date; dbNow: Date }>>`
      SELECT slot."leaseUntil", clock_timestamp() AS "dbNow"
      FROM "WorkerSlot" AS slot
      WHERE slot."slotKey" = 'analysis' AND slot."jobId" = ${duplicateClaim.jobId}
        AND slot."ownerUserId" = ${duplicateClaim.ownerUserId}
    `;
    assert.equal(stillLiveAfterDuplicate.length, 1);
    assert.ok(stillLiveAfterDuplicate[0].leaseUntil > stillLiveAfterDuplicate[0].dbNow, "the original long lease remains valid beyond the duplicate's requested one-second lease");
    assert.equal(await claimAnalysisJob(db), null);
    releaseDuplicateHandler.resolve(undefined);
    const duplicateResult = await duplicateRun;
    assert.equal(duplicateResult.stagesFinished, true, "the blocked legitimate runner completes after both duplicates exit");
    assert.deepEqual(duplicateCalls, ANALYSIS_STAGE_DEFINITIONS.map(({ key }) => key), "the legitimate runner completes every handler exactly once");
    assert.equal(await failAnalysisJob(db, duplicateClaim, "STAGE_TEST_CLEANUP"), true);

    // External cancellation reaches the active handler, persists a safe terminal
    // failure, leaves downstream stages pending, and releases only this claim's slot.
    const cancellationClaim = await enqueueAndClaim();
    const cancellation = new AbortController();
    const cancellationStarted = deferred<void>();
    const cancellationObserved = deferred<void>();
    const cancellationCalls: AnalysisStageKey[] = [];
    let cancellationHandlerSignal: AbortSignal | undefined;
    const cancellationHandlers = testOnlyHandlers(async (key, _context, signal) => {
      cancellationCalls.push(key);
      if (key === "SNAPSHOT") {
        cancellationHandlerSignal = signal;
        signal.addEventListener("abort", () => cancellationObserved.resolve(undefined), { once: true });
        cancellationStarted.resolve(undefined);
        await cancellationObserved.promise;
      }
      return { stage: key };
    });
    const cancellationRun = runAnalysisStages(db, cancellationClaim, cancellationHandlers, { signal: cancellation.signal });
    await cancellationStarted.promise;
    cancellation.abort();
    const cancellationResult = await cancellationRun;
    assert.equal(cancellationHandlerSignal?.aborted, true, "the active handler receives the external abort");
    assert.deepEqual(cancellationCalls, ["SNAPSHOT"], "cancellation prevents every later handler invocation");
    assert.equal(cancellationResult.stagesFinished, false);
    assert.deepEqual(cancellationResult.stages.map(({ status }) => status), ["FAILED", ...Array(8).fill("PENDING")]);
    assert.equal(cancellationResult.stages[0]?.errorCode, "STAGE_CANCELLED");
    const cancellationProgress = await getOwnerAnalysisProgress(db, owner.id, cancellationClaim.analysisId);
    assert.equal(cancellationProgress?.status, "FAILED");
    assert.equal(cancellationProgress?.jobs[0]?.status, "FAILED");
    assert.equal(cancellationProgress?.errorCode, "STAGE_CANCELLED");
    const releasedSlot = await db.workerSlot.findUniqueOrThrow({ where: { slotKey: "analysis" }, select: { jobId: true } });
    assert.equal(releasedSlot.jobId, null, "terminal cancellation releases the global slot");

    // A forged stale token performs no initialization or handler writes. The valid
    // runner is then allowed to start, after which database lease expiry/recovery
    // must abort its handler before the pipeline can write downstream stages.
    const leaseLossClaim = await enqueueAndClaim();
    let staleHandlerCalls = 0;
    const staleHandlers = testOnlyHandlers(() => { staleHandlerCalls += 1; return { ignored: true }; });
    const staleResult = await runAnalysisStages(
      db,
      { ...leaseLossClaim, leaseToken: randomUUID() },
      staleHandlers,
      { leaseDurationMs: 1_000 },
    );
    assert.deepEqual(staleResult.stages, [], "a stale token cannot initialize stage rows");
    assert.equal(staleHandlerCalls, 0, "a stale token cannot invoke test handlers");

    const leaseLossStarted = deferred<void>();
    const leaseLossObserved = deferred<void>();
    const leaseLossCalls: AnalysisStageKey[] = [];
    let leaseLossHandlerSignal: AbortSignal | undefined;
    const leaseLossHandlers = testOnlyHandlers(async (key, _context, signal) => {
      leaseLossCalls.push(key);
      if (key === "SNAPSHOT") {
        leaseLossHandlerSignal = signal;
        signal.addEventListener("abort", () => leaseLossObserved.resolve(undefined), { once: true });
        leaseLossStarted.resolve(undefined);
        await leaseLossObserved.promise;
      }
      return { stage: key };
    });
    const leaseLossRun = runAnalysisStages(db, leaseLossClaim, leaseLossHandlers, { leaseDurationMs: 1_000 });
    await leaseLossStarted.promise;
    const expiredRows = await db.$transaction(async (tx) => {
      const slotRows = await tx.$executeRaw`
        UPDATE "WorkerSlot"
        SET "leaseUntil" = clock_timestamp() - INTERVAL '1 millisecond'
        WHERE "slotKey" = 'analysis' AND "jobId" = ${leaseLossClaim.jobId}
          AND "ownerUserId" = ${leaseLossClaim.ownerUserId}
      `;
      const jobRows = await tx.$executeRaw`
        UPDATE "Job"
        SET "leaseExpiresAt" = clock_timestamp() - INTERVAL '1 millisecond'
        WHERE "id" = ${leaseLossClaim.jobId} AND "ownerUserId" = ${leaseLossClaim.ownerUserId}
          AND "analysisId" = ${leaseLossClaim.analysisId} AND "attempt" = ${leaseLossClaim.attempt}
      `;
      return { slotRows, jobRows };
    });
    assert.deepEqual(expiredRows, { slotRows: 1, jobRows: 1 }, "the test expires only its own active lease");
    assert.equal(await claimAnalysisJob(db, { leaseDurationMs: 1_000 }), null, "queue recovery terminally fails the expired fixture when no later job is queued");
    const leaseLossResult = await leaseLossRun;
    assert.equal(leaseLossHandlerSignal?.aborted, true, "lease loss aborts the active handler signal");
    assert.deepEqual(leaseLossCalls, ["SNAPSHOT"], "lease loss prevents every downstream handler invocation");
    assert.equal(leaseLossResult.stagesFinished, false);
    assert.deepEqual(leaseLossResult.stages.map(({ status }) => status), ["FAILED", ...Array(8).fill("PENDING")]);
    assert.ok(leaseLossResult.stages.slice(1).every(({ status }) => status === "PENDING"));
    const leaseLossProgress = await getOwnerAnalysisProgress(db, owner.id, leaseLossClaim.analysisId);
    assert.equal(leaseLossProgress?.status, "FAILED");
    assert.equal(leaseLossProgress?.errorCode, "WORKER_INTERRUPTED");
    assert.equal(leaseLossProgress?.jobs[0]?.status, "FAILED");
    assert.equal(leaseLossProgress?.jobs[0]?.errorCode, "WORKER_INTERRUPTED");
    const finalSlot = await db.workerSlot.findUniqueOrThrow({ where: { slotKey: "analysis" }, select: { jobId: true } });
    assert.equal(finalSlot.jobId, null, "expired-lease recovery releases the fixture slot");

  } finally {
    try {
      await cleanup(db, userIds, repositoryId, jobIds, claims);
    } finally {
      await disconnectDatabase();
    }
  }
});
