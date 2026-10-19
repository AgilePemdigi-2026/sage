import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { pack, type Header } from "tar-stream";
import test from "node:test";
import {
  claimAnalysisJob,
  database,
  disconnectDatabase,
  enqueueAnalysis,
  failAnalysisJob,
  renewAnalysisLease,
  storeGitHubCredential,
} from "../packages/database/src/index.ts";
import { completeAnalysisStage, initializeAnalysisStages, startAnalysisStage } from "../packages/database/src/stages.ts";
import type { AnalysisJobClaim } from "../packages/database/src/queue.ts";
import type { AnalysisStageContext } from "../apps/worker/src/stage-runner.ts";
import { createSnapshotHandler } from "../apps/worker/src/snapshot/handler.ts";
import { readSnapshotArchive, writeSnapshotArchive } from "../apps/worker/src/snapshot/storage.ts";
import { SnapshotArchiveError } from "../apps/worker/src/snapshot/archive.ts";
import type { RepositoryArchiveInput } from "../packages/github/archive.ts";
import type { PrismaClient } from "../packages/database/generated/client.ts";

function assertIsolatedSnapshotDatabase(): void {
  if (process.env.SAGE_SNAPSHOT_TESTS !== "1") throw new Error("Set SAGE_SNAPSHOT_TESTS=1 to run destructive REP-02 integration fixtures.");
  const rawUrl = process.env.DATABASE_URL;
  if (!rawUrl) throw new Error("DATABASE_URL is required for REP-02 snapshot integration tests.");
  let databaseName: string;
  try {
    databaseName = decodeURIComponent(new URL(rawUrl).pathname.slice(1));
  } catch {
    throw new Error("DATABASE_URL is invalid; it was not logged.");
  }
  if (databaseName !== "sage_snapshot08") throw new Error("REP-02 snapshot tests only allow the isolated sage_snapshot08 database.");
}

async function makeArchive(rootName: string, content: Uint8Array): Promise<Buffer> {
  const tar = pack();
  const entries: Array<{ name: string; type: "directory" | "file"; bytes?: Uint8Array }> = [
    { name: `${rootName}/`, type: "directory" },
    { name: `${rootName}/src/`, type: "directory" },
    { name: `${rootName}/src/index.ts`, type: "file", bytes: content },
  ];
  for (const entry of entries) {
    const bytes = entry.bytes ?? Buffer.alloc(0);
    const header: Partial<Header> & Pick<Header, "name"> = {
      name: entry.name,
      type: entry.type,
      size: bytes.byteLength,
      mode: 0o644,
      mtime: new Date(0),
      linkname: "",
      uid: 0,
      gid: 0,
      uname: "",
      gname: "",
      devmajor: 0,
      devminor: 0,
    };
    await new Promise<void>((resolve, reject) => {
      tar.entry(header, bytes, (error) => (error ? reject(error) : resolve()));
    });
  }
  tar.finalize();
  const chunks: Buffer[] = [];
  for await (const chunk of tar) chunks.push(Buffer.from(chunk as Uint8Array));
  return gzipSync(Buffer.concat(chunks));
}

async function cleanup(
  db: PrismaClient,
  userIds: string[],
  repositoryId: string,
  jobIds: string[],
  claims: AnalysisJobClaim[],
): Promise<void> {
  for (const claim of claims) await failAnalysisJob(db, claim, "SNAPSHOT_TEST_CLEANUP").catch(() => false);
  await db.$transaction(async (tx) => {
    if (jobIds.length > 0) {
      await tx.workerSlot.updateMany({
        where: { jobId: { in: jobIds } },
        data: { jobId: null, ownerUserId: null, leaseUntil: null, heartbeatAt: null, leaseTokenHash: null },
      });
      await tx.job.deleteMany({ where: { id: { in: jobIds }, ownerUserId: { in: userIds } } });
    }
    await tx.storageObject.deleteMany({ where: { ownerUserId: { in: userIds } } });
    await tx.analysisStage.deleteMany({ where: { ownerUserId: { in: userIds } } });
    await tx.analysis.deleteMany({ where: { ownerUserId: { in: userIds } } });
    await tx.gitHubConnection.deleteMany({ where: { userId: { in: userIds } } });
    await tx.user.deleteMany({ where: { id: { in: userIds } } });
    if (repositoryId) await tx.repository.deleteMany({ where: { id: repositoryId } });
  });
}

async function waitForSnapshotInsertSleep(db: PrismaClient): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const rows = await db.$queryRaw<Array<{ active: boolean }>>`
      SELECT EXISTS (
        SELECT 1 FROM pg_stat_activity
        WHERE datname = current_database() AND pid <> pg_backend_pid()
          AND wait_event = 'PgSleep' AND query ILIKE '%StorageObject%'
      ) AS active
    `;
    if (rows[0]?.active === true) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for the delayed StorageObject insert trigger.");
}

test("REP-02 stores only a hash-checked owner snapshot under the current SNAPSHOT lease", {
  skip: process.env.SAGE_SNAPSHOT_TESTS !== "1",
}, async () => {
  assertIsolatedSnapshotDatabase();
  const db = database();
  const suffix = randomUUID();
  const previousEncryptionKey = process.env.CREDENTIAL_ENCRYPTION_KEY;
  process.env.CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  const userIds: string[] = [];
  const jobIds: string[] = [];
  const claims: AnalysisJobClaim[] = [];
  let repositoryId = "";
  let storageRoot = "";
  let delayTriggerInstalled = false;
  try {
    const owner = await db.user.create({ data: { githubUserId: `snapshot-owner-${suffix}`, login: `snapshot-owner-${suffix}` } });
    userIds.push(owner.id);
    const otherOwner = await db.user.create({ data: { githubUserId: `snapshot-other-${suffix}`, login: `snapshot-other-${suffix}` } });
    userIds.push(otherOwner.id);
    const repository = await db.repository.create({
      data: {
        githubRepositoryId: String(8_000_000_000 + Math.floor(Math.random() * 1_000_000)),
        ownerLogin: "sage-snapshot-test",
        name: suffix,
        fullName: `sage-snapshot-test/${suffix}`,
        visibility: "PRIVATE",
        defaultBranch: "main",
      },
    });
    repositoryId = repository.id;
    const accessToken = `snapshot-token-${suffix}`;
    await storeGitHubCredential(db, owner.id, {
      githubUserId: `snapshot-gh-${suffix}`,
      githubLogin: `snapshot-user-${suffix}`,
      accessToken,
    });
    const pinnedCommitSha = "a".repeat(40);
    const enqueued = await enqueueAnalysis(db, {
      ownerUserId: owner.id,
      repositoryId: repository.id,
      branchName: "main",
      commitSha: pinnedCommitSha,
      configuration: { includeTests: false },
      analyzerVersion: "rep02-snapshot-test-1",
      schemaVersion: "1",
    });
    jobIds.push(enqueued.jobId);
    const claim = await claimAnalysisJob(db, { leaseDurationMs: 300_000 });
    assert.ok(claim);
    claims.push(claim);
    assert.equal(claim.analysisId, enqueued.analysisId);
    const initialized = await initializeAnalysisStages(db, claim);
    assert.ok(initialized);
    assert.equal(initialized.target.commitSha, pinnedCommitSha);
    assert.equal(await startAnalysisStage(db, claim, "SNAPSHOT"), true);

    storageRoot = await mkdtemp(join(tmpdir(), "sage-snapshot-handler-"));
    const sourceBytes = Buffer.from(`export const suffix = ${JSON.stringify(suffix)};\n`);
    const archive = await makeArchive(`source-${suffix.replaceAll("-", "").slice(0, 12)}`, sourceBytes);
    const archiveSha256 = createHash("sha256").update(archive).digest("hex");
    const context: AnalysisStageContext = {
      target: initialized.target,
      configuration: initialized.configuration,
      previousStages: {},
      sourceSnapshot: null,
    };

    const cancellation = new AbortController();
    const cancelledHandler = createSnapshotHandler({
      claim,
      storageRoot,
      db,
      fetchArchive: async (request: RepositoryArchiveInput) => {
        assert.equal(request.commitSha, pinnedCommitSha);
        cancellation.abort();
        return archive;
      },
    });
    await assert.rejects(cancelledHandler(context, cancellation.signal));
    assert.equal(await db.storageObject.count({ where: { analysisId: enqueued.analysisId } }), 0);
    assert.deepEqual(await readdir(storageRoot), [], "cancellation before storage must leave no archive directory");

    // The live branch metadata may move after enqueue; the fetch remains pinned to Analysis.commitSha.
    await db.repository.update({ where: { id: repository.id }, data: { defaultBranch: "release" } });
    const observedFetches: RepositoryArchiveInput[] = [];
    const handler = createSnapshotHandler({
      claim,
      storageRoot,
      db,
      fetchArchive: async (request: RepositoryArchiveInput) => {
        observedFetches.push(request);
        return archive;
      },
    });
    const handlerResult = await handler(context, new AbortController().signal);
    assert.deepEqual(observedFetches.map(({ commitSha, repository, githubRepositoryId, accessToken }) => ({ commitSha, repository, githubRepositoryId, accessToken })), [{
      commitSha: pinnedCommitSha,
      repository: repository.fullName,
      githubRepositoryId: repository.githubRepositoryId,
      accessToken,
    }]);
    assert.ok(typeof handlerResult === "object" && handlerResult !== null && !Array.isArray(handlerResult));
    const snapshotResult = handlerResult as {
      storageObjectId: string;
      archiveSha256: string;
      archiveBytes: number;
      commitSha: string;
      files: number;
      extractedBytes: number;
    };
    assert.deepEqual(handlerResult, {
      storageObjectId: snapshotResult.storageObjectId,
      archiveSha256,
      archiveBytes: archive.byteLength,
      commitSha: pinnedCommitSha,
      files: 1,
      extractedBytes: sourceBytes.byteLength,
    });

    const storageObjectId = snapshotResult.storageObjectId;
    const stored = await db.storageObject.findUniqueOrThrow({ where: { id: storageObjectId } });
    assert.equal(stored.ownerUserId, owner.id);
    assert.equal(stored.analysisId, enqueued.analysisId);
    assert.equal(stored.type, "SOURCE_ARCHIVE");
    assert.equal(stored.sha256, archiveSha256);
    assert.equal(stored.byteLength, BigInt(archive.byteLength));
    assert.equal(stored.status, "ACTIVE");
    assert.match(stored.storageKey, /^snapshot-[A-Za-z0-9]{6}\/archive\.tar\.gz$/);
    assert.deepEqual(Buffer.from(await readSnapshotArchive(db, { storageRoot, ownerUserId: owner.id, analysisId: enqueued.analysisId, storageObjectId })), archive);
    await assert.rejects(readSnapshotArchive(db, { storageRoot, ownerUserId: otherOwner.id, analysisId: enqueued.analysisId, storageObjectId }));
    await assert.rejects(readSnapshotArchive(db, { storageRoot, ownerUserId: owner.id, analysisId: `foreign-${suffix}`, storageObjectId }));

    const storageFile = join(storageRoot, stored.storageKey);
    await writeFile(storageFile, Buffer.from(archive).reverse());
    await assert.rejects(
      readSnapshotArchive(db, { storageRoot, ownerUserId: owner.id, analysisId: enqueued.analysisId, storageObjectId }),
      (error: unknown) => error instanceof SnapshotArchiveError && error.code === "SNAPSHOT_INVALID",
    );
    await writeFile(storageFile, archive);

    const assertFailedRegistrationCleansTemporaryFolder = async (candidate: AnalysisJobClaim): Promise<void> => {
      const before = (await readdir(storageRoot)).sort();
      await assert.rejects(writeSnapshotArchive(db, { storageRoot, claim: candidate, archive, sha256: archiveSha256 }), /Snapshot lease tidak aktif/);
      assert.deepEqual((await readdir(storageRoot)).sort(), before, "rejected registration must remove its temporary directory");
      assert.equal(await db.storageObject.count({ where: { analysisId: enqueued.analysisId } }), 1);
    };

    await assertFailedRegistrationCleansTemporaryFolder({ ...claim, leaseToken: randomUUID() });
    await assertFailedRegistrationCleansTemporaryFolder({ ...claim, attempt: claim.attempt + 1 });
    assert.equal(await completeAnalysisStage(db, claim, "SNAPSHOT"), true);
    await assertFailedRegistrationCleansTemporaryFolder(claim);
    assert.equal(await failAnalysisJob(db, claim, "SNAPSHOT_TEST_FAILURE"), true);
    await assertFailedRegistrationCleansTemporaryFolder(claim);

    const shortLeaseEnqueue = await enqueueAnalysis(db, {
      ownerUserId: owner.id,
      repositoryId: repository.id,
      branchName: "main",
      commitSha: "b".repeat(40),
      configuration: { includeTests: false },
      analyzerVersion: "rep02-snapshot-test-1",
      schemaVersion: "1",
    });
    jobIds.push(shortLeaseEnqueue.jobId);
    const shortLeaseClaim = await claimAnalysisJob(db, { leaseDurationMs: 5_000 });
    assert.ok(shortLeaseClaim);
    claims.push(shortLeaseClaim);
    assert.equal(shortLeaseClaim.analysisId, shortLeaseEnqueue.analysisId);
    assert.ok(await initializeAnalysisStages(db, shortLeaseClaim));
    assert.equal(await startAnalysisStage(db, shortLeaseClaim, "SNAPSHOT"), true);
    await db.$transaction(async (tx) => {
      const slotRows = await tx.$queryRaw<Array<{ leaseUntil: Date }>>`
        UPDATE "WorkerSlot"
        SET "leaseUntil" = clock_timestamp() + INTERVAL '1 second', "updatedAt" = clock_timestamp()
        WHERE "slotKey" = 'analysis' AND "jobId" = ${shortLeaseClaim.jobId} AND "ownerUserId" = ${owner.id}
        RETURNING "leaseUntil"
      `;
      assert.equal(slotRows.length, 1);
      const jobRows = await tx.$queryRaw<Array<{ id: string }>>`
        UPDATE "Job" SET "leaseExpiresAt" = ${slotRows[0].leaseUntil}, "updatedAt" = clock_timestamp()
        WHERE "id" = ${shortLeaseClaim.jobId} AND "ownerUserId" = ${owner.id} AND "attempt" = ${shortLeaseClaim.attempt} AND "status" = 'RUNNING'
        RETURNING "id"
      `;
      assert.equal(jobRows.length, 1);
    });

    await db.$executeRaw`DROP TRIGGER IF EXISTS "rep02_delay_snapshot_insert_trigger" ON "StorageObject"`;
    await db.$executeRaw`DROP FUNCTION IF EXISTS "rep02_delay_snapshot_insert"()`;
    await db.$executeRaw`
      CREATE FUNCTION "rep02_delay_snapshot_insert"() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN
        PERFORM pg_sleep(1.5);
        RETURN NEW;
      END; $$
    `;
    await db.$executeRaw`
      CREATE TRIGGER "rep02_delay_snapshot_insert_trigger"
      BEFORE INSERT ON "StorageObject" FOR EACH ROW EXECUTE FUNCTION "rep02_delay_snapshot_insert"()
    `;
    delayTriggerInstalled = true;
    const foldersBeforeDelayedInsert = (await readdir(storageRoot)).sort();
    const delayedRegistration = writeSnapshotArchive(db, {
      storageRoot,
      claim: shortLeaseClaim,
      archive,
      sha256: archiveSha256,
    });
    let blockedRenewal: Promise<Date | null> | undefined;
    try {
      await waitForSnapshotInsertSleep(db);
      blockedRenewal = renewAnalysisLease(db, shortLeaseClaim, { leaseDurationMs: 30_000 });
      await assert.rejects(delayedRegistration, /Snapshot lease tidak aktif/);
      assert.equal(await blockedRenewal, null, "a heartbeat blocked behind registration cannot revive an expired lease");
    } finally {
      await delayedRegistration.catch(() => undefined);
      await blockedRenewal?.catch(() => null);
      await db.$executeRaw`DROP TRIGGER IF EXISTS "rep02_delay_snapshot_insert_trigger" ON "StorageObject"`;
      await db.$executeRaw`DROP FUNCTION IF EXISTS "rep02_delay_snapshot_insert"()`;
      delayTriggerInstalled = false;
    }
    assert.equal(await db.storageObject.count({ where: { analysisId: shortLeaseEnqueue.analysisId } }), 0, "the expired registration transaction must roll back");
    assert.deepEqual((await readdir(storageRoot)).sort(), foldersBeforeDelayedInsert, "an expired lease must remove the temporary archive directory");
  } finally {
    try {
      if (delayTriggerInstalled) {
        await db.$executeRaw`DROP TRIGGER IF EXISTS "rep02_delay_snapshot_insert_trigger" ON "StorageObject"`;
        await db.$executeRaw`DROP FUNCTION IF EXISTS "rep02_delay_snapshot_insert"()`;
      }
      await cleanup(db, userIds, repositoryId, jobIds, claims);
    } finally {
      if (storageRoot) await rm(storageRoot, { recursive: true, force: true });
      if (previousEncryptionKey === undefined) delete process.env.CREDENTIAL_ENCRYPTION_KEY;
      else process.env.CREDENTIAL_ENCRYPTION_KEY = previousEncryptionKey;
      await disconnectDatabase();
    }
  }
});
