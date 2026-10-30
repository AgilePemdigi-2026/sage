import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import {
  AnalysisDeletionActiveError,
  AnalysisDeletionNotFoundError,
  AnalysisRetryConflictError,
  claimCleanupJob,
  completeCleanupJob,
  database,
  disconnectDatabase,
  enqueueAnalysisRetry,
  failCleanupJob,
  findAnalysisForUser,
  findCleanupJobForUser,
  findStorageObjectForUser,
  getAnalysisDetailForUser,
  getAnalysisRetryTargetForUser,
  listAnalysesForUser,
  markCleanupObjectDeleted,
  requestAnalysisDeletion,
  renewCleanupLease,
  reserveJobStorage,
} from "../packages/database/src/index.ts";
import type { PrismaClient } from "../packages/database/generated/client.ts";

interface FixtureOwner { id: string; repositoryId: string; suffix: string; }

let sequence = 0n;
function queueSequence(): bigint { sequence += 1n; return BigInt(Date.now()) * 10_000n + sequence; }

function assertIsolatedCleanupDatabase(): void {
  if (process.env.SAGE_CLEANUP_TESTS !== "1") throw new Error("Set SAGE_CLEANUP_TESTS=1 to run destructive cleanup database integration tests.");
  const rawUrl = process.env.DATABASE_URL;
  if (!rawUrl) throw new Error("DATABASE_URL is required for cleanup database integration tests.");
  let databaseName: string;
  try { databaseName = decodeURIComponent(new URL(rawUrl).pathname.slice(1)); }
  catch { throw new Error("DATABASE_URL is invalid; it was not logged."); }
  if (databaseName !== "sage_cleanup23") throw new Error("Cleanup database integration tests only allow the isolated sage_cleanup23 database.");
}

async function createOwner(db: PrismaClient, suffix: string): Promise<FixtureOwner> {
  const owner = await db.user.create({ data: { githubUserId: `cleanup-${suffix}`, login: `cleanup-${suffix}` } });
  const repository = await db.repository.create({
    data: {
      githubRepositoryId: `cleanup-repository-${suffix}`,
      ownerLogin: "sage-cleanup-test",
      name: suffix,
      fullName: `sage-cleanup-test/${suffix}`,
      visibility: "PRIVATE",
    },
  });
  return { id: owner.id, repositoryId: repository.id, suffix };
}

async function createAnalysis(
  db: PrismaClient,
  owner: FixtureOwner,
  status: "QUEUED" | "RUNNING" | "FAILED" | "COMPLETED" = "FAILED",
  retryParentId: string | null = null,
) {
  return db.analysis.create({
    data: {
      ownerUserId: owner.id,
      repositoryId: owner.repositoryId,
      branchName: "main",
      commitSha: "a".repeat(40),
      configuration: { sourcePolicyVersion: "test", maxSourceFileBytes: 1024 },
      configurationHash: "b".repeat(64),
      analyzerVersion: "cleanup-test-v1",
      schemaVersion: "1",
      status,
      retryParentId,
    },
  });
}

async function cleanupFixtures(db: PrismaClient, owners: readonly FixtureOwner[]): Promise<void> {
  const ownerIds = owners.map(owner => owner.id);
  const repoIds = owners.map(owner => owner.repositoryId);
  await db.$transaction(async tx => {
    await tx.workerSlot.updateMany({
      where: { ownerUserId: { in: ownerIds } },
      data: { jobId: null, ownerUserId: null, leaseUntil: null, heartbeatAt: null, leaseTokenHash: null },
    });
    await tx.job.deleteMany({ where: { ownerUserId: { in: ownerIds } } });
    await tx.export.deleteMany({ where: { ownerUserId: { in: ownerIds } } });
    await tx.sourceFile.deleteMany({ where: { ownerUserId: { in: ownerIds } } });
    await tx.analysis.updateMany({ where: { ownerUserId: { in: ownerIds } }, data: { retryParentId: null } });
    await tx.analysisStage.deleteMany({ where: { ownerUserId: { in: ownerIds } } });
    await tx.analysisLimitation.deleteMany({ where: { ownerUserId: { in: ownerIds } } });
    await tx.graphBundle.deleteMany({ where: { ownerUserId: { in: ownerIds } } });
    await tx.architectureDocument.deleteMany({ where: { ownerUserId: { in: ownerIds } } });
    await tx.storageObject.deleteMany({ where: { ownerUserId: { in: ownerIds } } });
    await tx.analysis.deleteMany({ where: { ownerUserId: { in: ownerIds } } });
    await tx.user.deleteMany({ where: { id: { in: ownerIds } } });
    await tx.repository.deleteMany({ where: { id: { in: repoIds } } });
  });
}

test("DEL-01 rejects active work and completes an owner-scoped, reservation-aware deletion", async () => {
  assertIsolatedCleanupDatabase();
  const db = database();
  const suffix = randomUUID().replaceAll("-", "");
  const owners: FixtureOwner[] = [];
  try {
    const owner = await createOwner(db, `${suffix}-a`); owners.push(owner);
    const otherOwner = await createOwner(db, `${suffix}-b`); owners.push(otherOwner);

    const activeAnalysis = await createAnalysis(db, owner, "QUEUED");
    await db.job.create({
      data: { ownerUserId: owner.id, analysisId: activeAnalysis.id, type: "ANALYSIS", status: "QUEUED", queueSequence: queueSequence() },
    });
    await assert.rejects(requestAnalysisDeletion(db, owner.id, activeAnalysis.id), error =>
      error instanceof AnalysisDeletionActiveError && error.code === "ANALYSIS_ACTIVE");
    assert.equal((await db.analysis.findUniqueOrThrow({ where: { id: activeAnalysis.id } })).deletionRequestedAt, null);

    const activeExportAnalysis = await createAnalysis(db, owner, "COMPLETED");
    const document = await db.architectureDocument.create({
      data: {
        ownerUserId: owner.id, analysisId: activeExportAnalysis.id, title: "Cleanup test", documentModelVersion: "1",
        interfaceCatalog: {}, softwareEngineeringDiagram: {}, umlClassDiagram: {}, contentHash: "c".repeat(64),
      },
    });
    const exportRecord = await db.export.create({
      data: {
        ownerUserId: owner.id, analysisId: activeExportAnalysis.id, architectureDocumentId: document.id,
        format: "PDF", documentHash: "c".repeat(64), rendererVersion: "test-v1", status: "QUEUED",
      },
    });
    await db.job.create({
      data: {
        ownerUserId: owner.id, analysisId: activeExportAnalysis.id, exportId: exportRecord.id,
        type: "EXPORT", status: "QUEUED", queueSequence: queueSequence(),
      },
    });
    await assert.rejects(requestAnalysisDeletion(db, owner.id, activeExportAnalysis.id), error =>
      error instanceof AnalysisDeletionActiveError && error.code === "EXPORT_ACTIVE");
    assert.equal((await db.analysis.findUniqueOrThrow({ where: { id: activeExportAnalysis.id } })).deletionRequestedAt, null);

    await db.export.update({ where: { id: exportRecord.id }, data: { status: "FAILED" } });
    await db.job.updateMany({ where: { analysisId: activeExportAnalysis.id }, data: { status: "FAILED" } });
    const terminalExportDeletion = await requestAnalysisDeletion(db, owner.id, activeExportAnalysis.id);
    assert.equal(terminalExportDeletion.status, "QUEUED");
    const terminalExportClaim = await claimCleanupJob(db);
    assert.ok(terminalExportClaim);
    await failCleanupJob(db, terminalExportClaim);
    // Remove the terminal-export fixture without leaving a queued cleanup operation behind.
    await db.job.deleteMany({ where: { ownerUserId: owner.id, analysisId: activeExportAnalysis.id } });
    await db.export.deleteMany({ where: { analysisId: activeExportAnalysis.id } });
    await db.architectureDocument.deleteMany({ where: { analysisId: activeExportAnalysis.id } });
    await db.analysis.delete({ where: { id: activeExportAnalysis.id } });

    const analysis = await createAnalysis(db, owner, "FAILED");
    const semanticModel = await db.semanticModel.create({
      data: {
        ownerUserId: owner.id,
        analysisId: analysis.id,
        sourceCkgHash: "1".repeat(64),
        modelHash: "2".repeat(64),
        schemaVersion: "sage-semantic-v1",
        extractorVersion: "cleanup-test-v1",
        canonicalContent: "{}",
      },
      select: { id: true },
    });
    await db.presentationRevision.create({
      data: {
        ownerUserId: owner.id,
        analysisId: analysis.id,
        semanticModelId: semanticModel.id,
        revision: 1,
        overlay: { labels: {}, groups: {} },
        contentHash: "3".repeat(64),
      },
    });
    const retryChild = await createAnalysis(db, owner, "FAILED", analysis.id);
    const registeredKey = `snapshot-${suffix.slice(0, 6)}/archive.tar.gz`;
    const reservedKey = `export-${randomUUID()}/document.pdf.pending`;
    const storageObject = await db.storageObject.create({
      data: {
        ownerUserId: owner.id, analysisId: analysis.id, type: "SOURCE_ARCHIVE", storageKey: registeredKey,
        sha256: "d".repeat(64), byteLength: 12n,
      },
    });
    await db.sourceFile.create({
      data: {
        ownerUserId: owner.id, analysisId: analysis.id, storageObjectId: storageObject.id,
        path: "src/index.ts", language: "TypeScript", byteLength: 12n, sha256: "d".repeat(64), processingStatus: "COMPLETED",
      },
    });
    await db.job.create({
      data: {
        ownerUserId: owner.id, analysisId: analysis.id, type: "ANALYSIS", status: "FAILED",
        queueSequence: queueSequence(), storageReservations: [registeredKey, reservedKey],
      },
    });
    const staleRetryTarget = await getAnalysisRetryTargetForUser(db, owner.id, analysis.id);
    assert.ok(staleRetryTarget);
    assert.equal(await findCleanupJobForUser(db, otherOwner.id, "does-not-exist"), null);
    await assert.rejects(requestAnalysisDeletion(db, otherOwner.id, analysis.id), error => error instanceof AnalysisDeletionNotFoundError);

    const pending = await requestAnalysisDeletion(db, owner.id, analysis.id);
    assert.equal(pending.status, "QUEUED");
    assert.equal((await requestAnalysisDeletion(db, owner.id, analysis.id)).jobId, pending.jobId);
    assert.equal((await db.storageObject.findUniqueOrThrow({ where: { id: storageObject.id } })).status, "DELETION_PENDING");
    assert.equal(await findAnalysisForUser(db, owner.id, analysis.id), null);
    assert.equal(await findStorageObjectForUser(db, owner.id, storageObject.id), null);
    assert.equal(await getAnalysisDetailForUser(db, owner.id, analysis.id), null);
    assert.equal(await getAnalysisRetryTargetForUser(db, owner.id, analysis.id), null);
    await assert.rejects(enqueueAnalysisRetry(db, staleRetryTarget, { keyHash: "e".repeat(64), requestHash: "f".repeat(64) }),
      error => error instanceof AnalysisRetryConflictError);
    const historyItem = (await listAnalysesForUser(db, owner.id)).items.find(item => item.id === analysis.id);
    assert.equal(historyItem?.deletion?.jobId, pending.jobId);
    assert.equal(historyItem?.deletion?.status, "QUEUED");

    const claim = await claimCleanupJob(db);
    assert.ok(claim);
    assert.deepEqual(claim.manifest, [
      { storageObjectId: null, storageKey: reservedKey },
      { storageObjectId: storageObject.id, storageKey: registeredKey },
    ].sort((left, right) => left.storageKey.localeCompare(right.storageKey)));
    assert.equal(await findCleanupJobForUser(db, otherOwner.id, pending.jobId), null);
    assert.equal(await markCleanupObjectDeleted(db, claim, storageObject.id), true);
    assert.equal(await completeCleanupJob(db, claim, [registeredKey]), false);

    const tableName = `CleanupRollbackBlock_${suffix}`;
    let blockerCreated = false;
    try {
      await db.$executeRawUnsafe(`CREATE TABLE "${tableName}" ("analysisId" TEXT NOT NULL REFERENCES "Analysis"("id") ON DELETE RESTRICT)`);
      blockerCreated = true;
      await db.$executeRawUnsafe(`INSERT INTO "${tableName}" ("analysisId") VALUES ($1)`, analysis.id);
      await assert.rejects(completeCleanupJob(db, claim, [registeredKey, reservedKey]));
      assert.ok(await db.analysis.findUnique({ where: { id: analysis.id } }));
      assert.equal((await db.job.findUniqueOrThrow({ where: { id: pending.jobId } })).status, "RUNNING");
      assert.equal((await db.analysis.findUniqueOrThrow({ where: { id: retryChild.id } })).retryParentId, analysis.id);
    } finally {
      if (blockerCreated) await db.$executeRawUnsafe(`DROP TABLE "${tableName}"`);
    }

    assert.ok(await renewCleanupLease(db, claim));
    assert.equal(await completeCleanupJob(db, claim, [registeredKey, reservedKey]), true);
    assert.equal(await db.analysis.findUnique({ where: { id: analysis.id } }), null);
    assert.equal((await db.analysis.findUniqueOrThrow({ where: { id: retryChild.id } })).retryParentId, null);
    const completedJob = await db.job.findUniqueOrThrow({ where: { id: pending.jobId } });
    assert.equal(completedJob.analysisId, null);
    assert.equal(completedJob.cleanupManifest, null);
    assert.equal((await findCleanupJobForUser(db, owner.id, pending.jobId))?.status, "COMPLETED");
    assert.equal((await requestAnalysisDeletion(db, owner.id, analysis.id)).status, "COMPLETED");
  } finally {
    await cleanupFixtures(db, owners);
    await disconnectDatabase();
  }
});

test("DEL-01 recovers expired cleanup leases and retries the same durable job", async () => {
  assertIsolatedCleanupDatabase();
  const db = database();
  const suffix = randomUUID().replaceAll("-", "");
  const owners: FixtureOwner[] = [];
  try {
    const owner = await createOwner(db, suffix); owners.push(owner);
    const analysis = await createAnalysis(db, owner, "FAILED");
    const reservedKey = `snapshot-${suffix.slice(0, 6)}/archive.tar.gz`;
    await db.job.create({
      data: {
        ownerUserId: owner.id, analysisId: analysis.id, type: "ANALYSIS", status: "FAILED",
        queueSequence: queueSequence(), storageReservations: [reservedKey],
      },
    });
    const firstSnapshot = await requestAnalysisDeletion(db, owner.id, analysis.id);
    const firstClaim = await claimCleanupJob(db, { leaseDurationMs: 1_000 });
    assert.ok(firstClaim);
    assert.equal(firstClaim.attempt, 1);
    await db.$executeRaw`
      UPDATE "Job" SET "leaseExpiresAt" = clock_timestamp() - interval '1 second'
      WHERE "id" = ${firstClaim.jobId} AND "ownerUserId" = ${owner.id}
    `;
    await db.$executeRaw`
      UPDATE "WorkerSlot" SET "leaseUntil" = clock_timestamp() - interval '1 second'
      WHERE "slotKey" = 'cleanup' AND "jobId" = ${firstClaim.jobId} AND "ownerUserId" = ${owner.id}
    `;
    assert.equal(await claimCleanupJob(db), null);
    assert.equal((await findCleanupJobForUser(db, owner.id, firstSnapshot.jobId))?.errorCode, "WORKER_INTERRUPTED");
    assert.equal(await failCleanupJob(db, firstClaim), false);

    const retried = await requestAnalysisDeletion(db, owner.id, analysis.id);
    assert.equal(retried.jobId, firstSnapshot.jobId);
    assert.equal(retried.status, "QUEUED");
    const secondClaim = await claimCleanupJob(db);
    assert.ok(secondClaim);
    assert.equal(secondClaim.jobId, firstClaim.jobId);
    assert.equal(secondClaim.attempt, firstClaim.attempt + 1);
    assert.equal(await failCleanupJob(db, firstClaim), false);
    assert.ok(await renewCleanupLease(db, secondClaim));
    assert.equal(await failCleanupJob(db, secondClaim), true);

    const retryAgain = await requestAnalysisDeletion(db, owner.id, analysis.id);
    assert.equal(retryAgain.jobId, firstSnapshot.jobId);
    const finalClaim = await claimCleanupJob(db);
    assert.ok(finalClaim);
    assert.equal(finalClaim.attempt, 3);
    assert.equal(await completeCleanupJob(db, finalClaim, [reservedKey]), true);
  } finally {
    await cleanupFixtures(db, owners);
    await disconnectDatabase();
  }
});

test("DEL-01 reservation writes require the current analysis lease", async () => {
  assertIsolatedCleanupDatabase();
  const db = database();
  const suffix = randomUUID().replaceAll("-", "");
  const owners: FixtureOwner[] = [];
  try {
    const owner = await createOwner(db, suffix); owners.push(owner);
    const analysis = await createAnalysis(db, owner, "RUNNING");
    const job = await db.job.create({
      data: { ownerUserId: owner.id, analysisId: analysis.id, type: "ANALYSIS", status: "RUNNING", queueSequence: queueSequence(), attempt: 1 },
    });
    await db.$executeRaw`
      UPDATE "Job" SET "leaseExpiresAt" = clock_timestamp() + interval '1 minute'
      WHERE "id" = ${job.id} AND "ownerUserId" = ${owner.id}
    `;
    const token = randomUUID();
    const tokenHash = createHash("sha256").update(token).digest("hex");
    await db.$executeRaw`
      INSERT INTO "WorkerSlot" ("slotKey", "jobId", "ownerUserId", "leaseUntil", "heartbeatAt", "leaseTokenHash", "lastEnqueueSequence", "updatedAt")
      VALUES ('analysis', ${job.id}, ${owner.id}, clock_timestamp() + interval '1 minute', clock_timestamp(), ${tokenHash}, ${job.queueSequence}, clock_timestamp())
      ON CONFLICT ("slotKey") DO UPDATE SET "jobId" = EXCLUDED."jobId", "ownerUserId" = EXCLUDED."ownerUserId",
        "leaseUntil" = EXCLUDED."leaseUntil", "heartbeatAt" = EXCLUDED."heartbeatAt", "leaseTokenHash" = EXCLUDED."leaseTokenHash",
        "updatedAt" = clock_timestamp()
    `;
    const claim = { jobId: job.id, analysisId: analysis.id, ownerUserId: owner.id, attempt: 1, leaseToken: token };
    const key = `snapshot-${suffix.slice(0, 6)}/archive.tar.gz`;
    assert.equal(await reserveJobStorage(db, claim, key), true);
    assert.deepEqual((await db.job.findUniqueOrThrow({ where: { id: job.id } })).storageReservations, [key]);
    assert.equal(await requestAnalysisDeletion(db, owner.id, analysis.id).catch(error =>
      error instanceof AnalysisDeletionActiveError ? error.code : null), "ANALYSIS_ACTIVE");
    await db.$executeRaw`
      UPDATE "WorkerSlot" SET "jobId" = NULL, "ownerUserId" = NULL, "leaseUntil" = NULL, "heartbeatAt" = NULL, "leaseTokenHash" = NULL
      WHERE "slotKey" = 'analysis' AND "jobId" = ${job.id} AND "ownerUserId" = ${owner.id}
    `;
    assert.equal(await reserveJobStorage(db, claim, `snapshot-${suffix.slice(0, 6)}/archive.tar.gz`), false);
    await db.job.update({ where: { id: job.id }, data: { status: "FAILED" } });
    await db.analysis.update({ where: { id: analysis.id }, data: { status: "FAILED" } });
    const pending = await requestAnalysisDeletion(db, owner.id, analysis.id);
    const cleanupClaim = await claimCleanupJob(db);
    assert.ok(cleanupClaim);
    assert.deepEqual(cleanupClaim.manifest, [{ storageObjectId: null, storageKey: key }]);
    assert.equal(await completeCleanupJob(db, cleanupClaim, [key]), true);
    assert.equal((await findCleanupJobForUser(db, owner.id, pending.jobId))?.status, "COMPLETED");
    assert.equal(await db.semanticModel.count({ where: { analysisId: analysis.id } }), 0, "semantic models must cascade with analysis deletion");
    assert.equal(await db.presentationRevision.count({ where: { analysisId: analysis.id } }), 0, "presentation revisions must cascade with analysis deletion");
  } finally {
    await cleanupFixtures(db, owners);
    await disconnectDatabase();
  }
});
