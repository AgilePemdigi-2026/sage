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
import { readAnalysisStages } from "../packages/database/src/stages.ts";
import type { AnalysisJobClaim } from "../packages/database/src/queue.ts";
import { runAnalysisStages, type AnalysisStageContext, type AnalysisStageHandlers } from "../apps/worker/src/stage-runner.ts";
import type { PrismaClient } from "../packages/database/generated/client.ts";

const allowedDatabases = new Set(["sage_queue01", "sage_queue01_fresh"]);

function assertIsolatedQueueDatabase(): void {
  if (process.env.SAGE_QUEUE_TESTS !== "1") throw new Error("Set SAGE_QUEUE_TESTS=1 to run destructive ANA-07-S1 integration fixtures.");
  const rawUrl = process.env.DATABASE_URL;
  if (!rawUrl) throw new Error("DATABASE_URL is required for ANA-07-S1 integration tests.");
  let databaseName: string;
  try {
    databaseName = decodeURIComponent(new URL(rawUrl).pathname.slice(1));
  } catch {
    throw new Error("DATABASE_URL is invalid; it was not logged.");
  }
  if (!allowedDatabases.has(databaseName)) throw new Error("ANA-07-S1 only allows the isolated queue databases.");
}

function testOnlyHandlers(
  onStage: (key: AnalysisStageKey, context: AnalysisStageContext) => Promise<unknown> | unknown,
): AnalysisStageHandlers {
  // These deterministic stubs exist only in this integration test, never as product handlers.
  const handlers: Partial<Record<AnalysisStageKey, (context: AnalysisStageContext, signal: AbortSignal) => Promise<unknown>>> = {};
  for (const { key } of ANALYSIS_STAGE_DEFINITIONS) {
    handlers[key] = async (context, signal) => {
      assert.equal(signal.aborted, false);
      return onStage(key, context);
    };
  }
  return handlers as AnalysisStageHandlers;
}

async function cleanup(db: PrismaClient, userIds: string[], repositoryId: string, jobIds: string[], claims: AnalysisJobClaim[]): Promise<void> {
  for (const claim of claims) {
    await failAnalysisJob(db, claim, "STAGE_TEST_CLEANUP").catch(() => false);
  }
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

test("ANA-07-S1 persists sequential stage progress and fails the analysis without publishing partial artifacts", async () => {
  assertIsolatedQueueDatabase();
  const db = database();
  const suffix = randomUUID();
  const userIds: string[] = [];
  const jobIds: string[] = [];
  const claims: AnalysisJobClaim[] = [];
  let repositoryId = "";

  try {
    const owner = await db.user.create({ data: { githubUserId: `stage-runner-${suffix}`, login: `stage-runner-${suffix}` } });
    userIds.push(owner.id);
    const otherOwner = await db.user.create({ data: { githubUserId: `stage-runner-other-${suffix}`, login: `stage-runner-other-${suffix}` } });
    userIds.push(otherOwner.id);
    const repository = await db.repository.create({
      data: {
        githubRepositoryId: `stage-runner-repo-${suffix}`,
        ownerLogin: "sage-stage-test",
        name: suffix,
        fullName: `sage-stage-test/${suffix}`,
        visibility: "PUBLIC",
      },
    });
    repositoryId = repository.id;
    const common = {
      ownerUserId: owner.id,
      repositoryId: repository.id,
      branchName: "main",
      configuration: { includeTests: true, depth: { max: 5 } },
      analyzerVersion: "stage-test-1",
      schemaVersion: "1",
    };

    const successEnqueued = await enqueueAnalysis(db, { ...common, commitSha: "A".repeat(40) });
    jobIds.push(successEnqueued.jobId);
    assert.deepEqual(await readAnalysisStages(db, owner.id, successEnqueued.analysisId), []);
    assert.equal(await readAnalysisStages(db, otherOwner.id, successEnqueued.analysisId), null);
    const successClaim = await claimAnalysisJob(db);
    assert.ok(successClaim);
    claims.push(successClaim);

    const called: AnalysisStageKey[] = [];
    let activeHandlers = 0;
    let maximumConcurrentHandlers = 0;
    const successHandlers = testOnlyHandlers(async (key, context) => {
      activeHandlers += 1;
      maximumConcurrentHandlers = Math.max(maximumConcurrentHandlers, activeHandlers);
      try {
        called.push(key);
        assert.equal(context.target.repositoryFullName, repository.fullName);
        assert.equal(context.target.branchName, "main");
        assert.equal(context.target.commitSha, "a".repeat(40));
        assert.deepEqual(structuredClone(context.configuration), common.configuration);
        assert.ok(Object.isFrozen(context));
        assert.ok(Object.isFrozen(context.configuration));
        if (key === "SNAPSHOT") return { files: { "src/index.ts": new Uint8Array([1, 2, 3]) } };
        if (key === "LANGUAGE_DETECTION") {
          const files = (context.sourceSnapshot as { files: Record<string, Uint8Array> }).files;
          files["src/index.ts"]![0] = 99;
          return { languages: ["typescript"] };
        }
        if (key === "STATIC_ANALYSIS") {
          const files = (context.sourceSnapshot as { files: Record<string, Uint8Array> }).files;
          assert.deepEqual([...files["src/index.ts"]!], [1, 2, 3], "later handlers receive a fresh copy of snapshot source bytes");
        }
        return { stage: key, observed: true };
      } finally {
        activeHandlers -= 1;
      }
    });

    const success = await runAnalysisStages(db, successClaim, successHandlers);
    assert.equal(success.stagesFinished, true);
    assert.deepEqual(called, ANALYSIS_STAGE_DEFINITIONS.map(({ key }) => key));
    assert.equal(maximumConcurrentHandlers, 1);
    assert.deepEqual(success.stages.map(({ status }) => status), Array(9).fill("COMPLETED"));
    const stillRunning = await db.analysis.findUniqueOrThrow({
      where: { id: successEnqueued.analysisId },
      select: { status: true, graphBundle: { select: { id: true } }, architectureDocument: { select: { id: true } } },
    });
    assert.equal(stillRunning.status, "RUNNING");
    assert.equal(stillRunning.graphBundle, null);
    assert.equal(stillRunning.architectureDocument, null);
    assert.equal(await failAnalysisJob(db, successClaim, "STAGE_TEST_CLEANUP"), true);

    const failedEnqueued = await enqueueAnalysis(db, { ...common, commitSha: "B".repeat(40) });
    jobIds.push(failedEnqueued.jobId);
    const failedClaim = await claimAnalysisJob(db);
    assert.ok(failedClaim);
    claims.push(failedClaim);
    const failingHandlers = testOnlyHandlers(async (key) => {
      if (key === "STATIC_ANALYSIS") throw new Error("raw source detail must never be persisted");
      return { stage: key };
    });
    const failed = await runAnalysisStages(db, failedClaim, failingHandlers);
    assert.equal(failed.stagesFinished, false);
    assert.deepEqual(failed.stages.map(({ status }) => status), ["COMPLETED", "COMPLETED", "FAILED", ...Array(6).fill("PENDING")]);
    assert.equal(failed.stages[2]?.errorCode, "STAGE_HANDLER_FAILED");
    assert.ok(!JSON.stringify(failed).includes("raw source detail"));
    const failedProgress = await getOwnerAnalysisProgress(db, owner.id, failedEnqueued.analysisId);
    assert.equal(failedProgress?.status, "FAILED");
    assert.equal(failedProgress?.jobs[0]?.status, "FAILED");
    assert.equal(failedProgress?.errorCode, "STAGE_HANDLER_FAILED");
    assert.equal(failedProgress?.stages.slice(3).every((stage) => stage.status === "PENDING"), true);
    const unpublished = await db.analysis.findUniqueOrThrow({
      where: { id: failedEnqueued.analysisId },
      select: { graphBundle: { select: { id: true } }, architectureDocument: { select: { id: true } } },
    });
    assert.equal(unpublished.graphBundle, null);
    assert.equal(unpublished.architectureDocument, null);
  } finally {
    try {
      await cleanup(db, userIds, repositoryId, jobIds, claims);
    } finally {
      await disconnectDatabase();
    }
  }
});
