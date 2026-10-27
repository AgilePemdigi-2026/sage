import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { gzipSync } from "node:zlib";
import { pack } from "tar-stream";
import test from "node:test";
import { canonicalizeCkg } from "@sage/contracts";
import { analyzeReferences } from "@sage/analyzer-js";
import { projectArchitectureDocument } from "@sage/documents/model";
import { MARKDOWN_RENDERER_VERSION } from "../packages/documents/src/markdown.ts";
import {
  claimExportJob,
  claimCleanupJob,
  database,
  disconnectDatabase,
  enqueueAnalysis,
  enqueueMarkdownExport,
  failExportJob,
  findMarkdownExportForUser,
  retryMarkdownExport,
  requestAnalysisDeletion,
  findCleanupJobForUser,
} from "../packages/database/src/index.ts";
import { createExportWorker } from "../apps/worker/src/export-handlers.ts";
import { createCleanupWorker } from "../apps/worker/src/cleanup-handlers.ts";
import { loadExportDownloadForUser } from "../apps/web/lib/exports/reader.ts";
import type { PrismaClient } from "../packages/database/generated/client.ts";

function assertIsolatedExportDatabase(): void {
  if (process.env.SAGE_EXPORT_TESTS !== "1") throw new Error("Set SAGE_EXPORT_TESTS=1 to run destructive EXP-01 integration tests.");
  const rawUrl = process.env.DATABASE_URL;
  if (!rawUrl) throw new Error("DATABASE_URL is required for EXP-01 integration tests.");
  let databaseName: string;
  try { databaseName = decodeURIComponent(new URL(rawUrl).pathname.slice(1)); }
  catch { throw new Error("DATABASE_URL is invalid; it was not logged."); }
  if (databaseName !== "sage_export20") throw new Error("EXP-01 integration tests only allow the isolated sage_export20 database.");
}

function digest(value: Uint8Array | string): string { return createHash("sha256").update(value).digest("hex"); }

async function tarArchive(path: string, bytes: Uint8Array): Promise<Uint8Array> {
  const stream = pack();
  const chunks: Buffer[] = [];
  const collecting = (async () => { for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array)); })();
  await new Promise<void>((resolve, reject) => stream.entry({ name: "snapshot/", type: "directory", mtime: new Date(0) }, error => error ? reject(error) : resolve()));
  await new Promise<void>((resolve, reject) => stream.entry({ name: `snapshot/${path}`, size: bytes.byteLength, type: "file", mtime: new Date(0) }, Buffer.from(bytes), error => error ? reject(error) : resolve()));
  stream.finalize();
  await collecting;
  return gzipSync(Buffer.concat(chunks));
}

async function createPublishedAnalysis(db: PrismaClient, input: {
  ownerUserId: string; repositoryId: string; repositoryFullName: string; suffix: string; storageRoot: string;
  sourceBytes: Uint8Array;
}) {
  const commitSha = input.suffix.replaceAll("-", "").slice(0, 40).padEnd(40, "a").toLowerCase();
  const branchName = "main";
  const configurationHash = "b".repeat(64);
  const sourcePath = "examples/minimum-ccm.source.ts";
  const analyzed = await analyzeReferences({
    snapshot: { repository: input.repositoryFullName, branch: branchName, commitSha },
    sources: { [sourcePath]: input.sourceBytes },
  });
  assert.ok(analyzed.ccm, `Fixture analyzer failed: ${analyzed.errorCode}`);
  const canonicalGraph = canonicalizeCkg(analyzed.ccm, { [sourcePath]: input.sourceBytes }, configurationHash);
  if (!canonicalGraph.ok) throw new Error(`Invalid test CKG: ${canonicalGraph.errorCode}`);
  const canonicalDocument = projectArchitectureDocument(canonicalGraph.json, { [sourcePath]: input.sourceBytes }, canonicalGraph.sha256);
  if (!canonicalDocument.ok) throw new Error(`Invalid test document: ${canonicalDocument.errorCode}`);

  const analysis = await db.analysis.create({ data: {
    ownerUserId: input.ownerUserId,
    repositoryId: input.repositoryId,
    repositoryFullNameSnapshot: input.repositoryFullName,
    branchName,
    commitSha,
    configuration: { includeTests: false },
    configurationHash,
    analyzerVersion: "exp01-integration",
    schemaVersion: "1",
    status: "COMPLETED",
    completedAt: new Date(),
  } });
  const bundle = canonicalGraph.value;
  await db.graphBundle.create({ data: {
    ownerUserId: input.ownerUserId,
    analysisId: analysis.id,
    schemaVersion: bundle.schemaVersion,
    configurationHash: bundle.configurationHash,
    canonicalContent: canonicalGraph.json,
    nodes: JSON.stringify(bundle.ccm.nodes),
    edges: JSON.stringify(bundle.ccm.edges),
    nodeCount: bundle.counts.nodes,
    edgeCount: bundle.counts.edges,
    contentHash: canonicalGraph.sha256,
  } });
  const documentValue = canonicalDocument.value;
  await db.architectureDocument.create({ data: {
    ownerUserId: input.ownerUserId,
    analysisId: analysis.id,
    title: documentValue.title,
    documentModelVersion: documentValue.schemaVersion,
    canonicalContent: canonicalDocument.json,
    interfaceCatalog: JSON.stringify(documentValue.interfaceCatalog),
    softwareEngineeringDiagram: JSON.stringify(documentValue.softwareEngineeringDiagram),
    umlClassDiagram: JSON.stringify(documentValue.umlClassDiagram),
    contentHash: canonicalDocument.sha256,
  } });

  const archive = await tarArchive(sourcePath, input.sourceBytes);
  const archiveFolder = `snapshot-${randomUUID().replaceAll("-", "").slice(0, 6)}`;
  const absoluteFolder = join(input.storageRoot, archiveFolder);
  await mkdir(absoluteFolder, { recursive: true, mode: 0o700 });
  const archivePath = join(absoluteFolder, "archive.tar.gz");
  await writeFile(archivePath, archive, { flag: "wx", mode: 0o600 });
  const storageObject = await db.storageObject.create({ data: {
    ownerUserId: input.ownerUserId,
    analysisId: analysis.id,
    type: "SOURCE_ARCHIVE",
    storageKey: `${archiveFolder}/archive.tar.gz`,
    sha256: digest(archive),
    byteLength: BigInt(archive.byteLength),
  } });
  return { analysisId: analysis.id, documentHash: canonicalDocument.sha256, archive, archivePath, sourceStorageObjectId: storageObject.id };
}

test("EXP-01 Markdown export deduplicates, persists private checksummed files, retries failures and recovers stale leases without touching analysis jobs", {
  skip: process.env.SAGE_EXPORT_TESTS !== "1",
}, async () => {
  assertIsolatedExportDatabase();
  const db = database();
  const suffix = randomUUID();
  const ownerIds: string[] = [];
  let repositoryId = "";
  let storageRoot = "";
  let analysisSlotInitiallyExisted = false;
  let exportSlotInitiallyExisted = false;
  try {
    storageRoot = await mkdtemp(join(tmpdir(), "sage-export20-"));
    const sourceBytes = new Uint8Array(await readFile(new URL("../packages/contracts/examples/minimum-ccm.source.ts", import.meta.url)));
    const owner = await db.user.create({ data: { githubUserId: `exp20-owner-${suffix}`, login: `exp20-owner-${suffix}` } });
    ownerIds.push(owner.id);
    const outsider = await db.user.create({ data: { githubUserId: `exp20-outsider-${suffix}`, login: `exp20-outsider-${suffix}` } });
    ownerIds.push(outsider.id);
    const repository = await db.repository.create({ data: {
      githubRepositoryId: `exp20-repo-${suffix}`,
      ownerLogin: "sage-export-test",
      name: suffix,
      fullName: `sage-export-test/${suffix}`,
      visibility: "PUBLIC",
    } });
    repositoryId = repository.id;

    analysisSlotInitiallyExisted = Boolean(await db.workerSlot.findUnique({ where: { slotKey: "analysis" }, select: { slotKey: true } }));
    exportSlotInitiallyExisted = Boolean(await db.workerSlot.findUnique({ where: { slotKey: "export" }, select: { slotKey: true } }));
    const pendingAnalysis = await enqueueAnalysis(db, {
      ownerUserId: owner.id,
      repositoryId,
      branchName: "queued-control",
      commitSha: "c".repeat(40),
      configuration: { exportIsolation: true },
      analyzerVersion: "exp01-control",
      schemaVersion: "1",
    });
    const analysisSlotBefore = await db.workerSlot.findUnique({ where: { slotKey: "analysis" }, select: { jobId: true, ownerUserId: true, lastEnqueueSequence: true } });
    const analysisJobBefore = await db.job.findUniqueOrThrow({ where: { id: pendingAnalysis.jobId }, select: { status: true, attempt: true, errorCode: true } });
    const worker = createExportWorker({ db, storageRoot });

    const first = await createPublishedAnalysis(db, {
      ownerUserId: owner.id, repositoryId, repositoryFullName: repository.fullName, suffix: `${suffix}a`, storageRoot, sourceBytes,
    });
    const firstRequest = { ownerUserId: owner.id, analysisId: first.analysisId, documentHash: first.documentHash, rendererVersion: MARKDOWN_RENDERER_VERSION };
    const enqueueResults = await Promise.all([enqueueMarkdownExport(db, firstRequest), enqueueMarkdownExport(db, firstRequest)]);
    assert.equal(enqueueResults.filter(result => result.created).length, 1, "concurrent requests create one deduplicated export");
    assert.equal(enqueueResults.filter(result => !result.created).length, 1);
    const firstEnqueue = enqueueResults.find(result => result.created)!;
    assert.equal(enqueueResults[0].export.id, enqueueResults[1].export.id);
    assert.equal(await db.job.count({ where: { type: "EXPORT", exportId: firstEnqueue.export.id } }), 1);
    assert.equal(await findMarkdownExportForUser(db, { ownerUserId: outsider.id, analysisId: first.analysisId, exportId: firstEnqueue.export.id }), null);

    // Tampering after enqueue proves the worker re-reads and validates the active source archive.
    await writeFile(first.archivePath, Buffer.from("tampered archive"));
    const initialClaims = await Promise.all([claimExportJob(db, { leaseDurationMs: 120_000 }), claimExportJob(db, { leaseDurationMs: 120_000 })]);
    assert.equal(initialClaims.filter(Boolean).length, 1, "parallel workers cannot claim the same export slot");
    const firstClaim = initialClaims.find(Boolean);
    assert.ok(firstClaim);
    await worker.process(firstClaim);
    const failed = await findMarkdownExportForUser(db, { ownerUserId: owner.id, analysisId: first.analysisId, exportId: firstEnqueue.export.id });
    assert.equal(failed?.status, "FAILED");
    assert.equal(failed?.errorCode, "EXPORT_FAILED");
    assert.equal((await db.analysis.findUniqueOrThrow({ where: { id: first.analysisId }, select: { status: true } })).status, "COMPLETED");

    await writeFile(first.archivePath, first.archive);
    const retried = await retryMarkdownExport(db, { ownerUserId: owner.id, analysisId: first.analysisId, exportId: firstEnqueue.export.id });
    assert.equal(retried.status, "QUEUED");
    const retryClaim = await claimExportJob(db, { leaseDurationMs: 120_000 });
    assert.ok(retryClaim);
    await worker.process(retryClaim);
    const ready = await findMarkdownExportForUser(db, { ownerUserId: owner.id, analysisId: first.analysisId, exportId: firstEnqueue.export.id });
    assert.equal(ready?.status, "READY");
    assert.match(ready?.contentHash ?? "", /^[a-f0-9]{64}$/);
    const download = await loadExportDownloadForUser(db, storageRoot, owner.id, first.analysisId, firstEnqueue.export.id);
    assert.equal(download.kind, "ready");
    if (download.kind === "ready") {
      assert.match(Buffer.from(download.value.bytes).toString("utf8"), /Architecture Definition Document/);
      assert.match(download.value.filename, /^sage-[a-z0-9_-]+-[a-f0-9]{7}\.md$/);
    }

    const second = await createPublishedAnalysis(db, {
      ownerUserId: owner.id, repositoryId, repositoryFullName: repository.fullName, suffix: `${suffix}b`, storageRoot, sourceBytes,
    });
    const secondEnqueue = await enqueueMarkdownExport(db, {
      ownerUserId: owner.id, analysisId: second.analysisId, documentHash: second.documentHash, rendererVersion: MARKDOWN_RENDERER_VERSION,
    });
    const staleClaim = await claimExportJob(db, { leaseDurationMs: 120_000 });
    assert.ok(staleClaim);
    await db.$executeRaw`UPDATE "WorkerSlot" SET "leaseUntil" = clock_timestamp() - INTERVAL '1 second' WHERE "slotKey" = 'export' AND "jobId" = ${staleClaim.jobId}`;
    await db.$executeRaw`UPDATE "Job" SET "leaseExpiresAt" = clock_timestamp() - INTERVAL '1 second' WHERE "id" = ${staleClaim.jobId}`;
    assert.equal(await claimExportJob(db, { leaseDurationMs: 120_000 }), null, "expired claim is recovered before any new queued export is claimed");
    const recovered = await findMarkdownExportForUser(db, { ownerUserId: owner.id, analysisId: second.analysisId, exportId: secondEnqueue.export.id });
    assert.equal(recovered?.status, "FAILED");
    assert.equal(recovered?.errorCode, "WORKER_INTERRUPTED");
    assert.equal(await failExportJob(db, staleClaim, "STALE_WORKER"), false, "the expired claim cannot overwrite recovered state");
    const staleRetry = await retryMarkdownExport(db, { ownerUserId: owner.id, analysisId: second.analysisId, exportId: secondEnqueue.export.id });
    assert.equal(staleRetry.status, "QUEUED");
    const recoveredRetryClaim = await claimExportJob(db, { leaseDurationMs: 120_000 });
    assert.ok(recoveredRetryClaim);
    await worker.process(recoveredRetryClaim);
    assert.equal((await findMarkdownExportForUser(db, { ownerUserId: owner.id, analysisId: second.analysisId, exportId: secondEnqueue.export.id }))?.status, "READY");

    const analysisSlotAfter = await db.workerSlot.findUnique({ where: { slotKey: "analysis" }, select: { jobId: true, ownerUserId: true, lastEnqueueSequence: true } });
    const analysisJobAfter = await db.job.findUniqueOrThrow({ where: { id: pendingAnalysis.jobId }, select: { status: true, attempt: true, errorCode: true } });
    assert.deepEqual(analysisSlotAfter, analysisSlotBefore);
    assert.deepEqual(analysisJobAfter, analysisJobBefore);
    assert.equal((await db.analysis.findUniqueOrThrow({ where: { id: pendingAnalysis.analysisId }, select: { status: true } })).status, "QUEUED");
  } finally {
    try {
      await db.$transaction(async tx => {
        const jobs = await tx.job.findMany({ where: { ownerUserId: { in: ownerIds } }, select: { id: true } });
        await tx.workerSlot.updateMany({ where: { jobId: { in: jobs.map(job => job.id) } }, data: { jobId: null, ownerUserId: null, leaseUntil: null, heartbeatAt: null, leaseTokenHash: null } });
        await tx.job.deleteMany({ where: { ownerUserId: { in: ownerIds } } });
        await tx.export.deleteMany({ where: { ownerUserId: { in: ownerIds } } });
        await tx.storageObject.deleteMany({ where: { ownerUserId: { in: ownerIds } } });
        await tx.graphBundle.deleteMany({ where: { ownerUserId: { in: ownerIds } } });
        await tx.architectureDocument.deleteMany({ where: { ownerUserId: { in: ownerIds } } });
        await tx.analysis.deleteMany({ where: { ownerUserId: { in: ownerIds } } });
        await tx.user.deleteMany({ where: { id: { in: ownerIds } } });
        if (repositoryId) await tx.repository.deleteMany({ where: { id: repositoryId } });
        if (!exportSlotInitiallyExisted) await tx.workerSlot.deleteMany({ where: { slotKey: "export", jobId: null } });
        if (!analysisSlotInitiallyExisted) await tx.workerSlot.deleteMany({ where: { slotKey: "analysis", jobId: null } });
      });
    } finally {
      if (storageRoot) await rm(storageRoot, { recursive: true, force: true });
      await disconnectDatabase();
    }
  }
});

test("EXP-01 reserved export paths are removed before a paused stale writer resumes", {
  skip: process.env.SAGE_EXPORT_TESTS !== "1",
  timeout: 90_000,
}, async () => {
  assertIsolatedExportDatabase();
  const db = database();
  const suffix = randomUUID();
  const ownerIds: string[] = [];
  let repositoryId = "";
  let storageRoot = "";
  let exportSlotInitiallyExisted = false;
  let analysisSlotInitiallyExisted = false;
  let cleanupSlotInitiallyExisted = false;
  let continueWriter: (() => void) | undefined;
  let writerPromise: Promise<void> | undefined;

  try {
    storageRoot = await mkdtemp(join(tmpdir(), "sage-export20-stale-writer-"));
    const sourceBytes = new Uint8Array(await readFile(new URL("../packages/contracts/examples/minimum-ccm.source.ts", import.meta.url)));
    const owner = await db.user.create({ data: { githubUserId: `exp20-race-owner-${suffix}`, login: `exp20-race-owner-${suffix}` } });
    ownerIds.push(owner.id);
    const repository = await db.repository.create({ data: {
      githubRepositoryId: `exp20-race-repo-${suffix}`,
      ownerLogin: "sage-export-test",
      name: suffix,
      fullName: `sage-export-race-test/${suffix}`,
      visibility: "PRIVATE",
    } });
    repositoryId = repository.id;
    exportSlotInitiallyExisted = Boolean(await db.workerSlot.findUnique({ where: { slotKey: "export" }, select: { slotKey: true } }));
    analysisSlotInitiallyExisted = Boolean(await db.workerSlot.findUnique({ where: { slotKey: "analysis" }, select: { slotKey: true } }));
    cleanupSlotInitiallyExisted = Boolean(await db.workerSlot.findUnique({ where: { slotKey: "cleanup" }, select: { slotKey: true } }));

    const canaryPath = join(storageRoot, "foreign-canary.txt");
    const canaryContent = Buffer.from("keep this unrelated file");
    await writeFile(canaryPath, canaryContent, { flag: "wx", mode: 0o600 });
    const published = await createPublishedAnalysis(db, {
      ownerUserId: owner.id,
      repositoryId,
      repositoryFullName: repository.fullName,
      suffix: `${suffix}c`,
      storageRoot,
      sourceBytes,
    });
    const enqueued = await enqueueMarkdownExport(db, {
      ownerUserId: owner.id,
      analysisId: published.analysisId,
      documentHash: published.documentHash,
      rendererVersion: MARKDOWN_RENDERER_VERSION,
    });
    const exportClaim = await claimExportJob(db, { leaseDurationMs: 120_000 });
    assert.ok(exportClaim);

    let reservationsPaused = false;
    let signalPaused!: () => void;
    const paused = new Promise<void>(resolve => { signalPaused = resolve; });
    let allowWriterToResume!: () => void;
    const writerMayResume = new Promise<void>(resolve => { allowWriterToResume = resolve; });
    continueWriter = allowWriterToResume;

    // Pause only after reserveJobStorage's second transaction has committed. The
    // worker has recorded both paths but has not yet returned from the reservation.
    const pausingDb = new Proxy(db, {
      get(target, property) {
        if (property === "$transaction") {
          const original = (Reflect.get(target, property, target) as (...args: unknown[]) => Promise<unknown>).bind(target);
          return async (...args: unknown[]) => {
            const result = await original(...args);
            if (!reservationsPaused) {
              const currentJob = await target.job.findUnique({
                where: { id: exportClaim.jobId },
                select: { storageReservations: true },
              });
              const keys = currentJob?.storageReservations;
              if (Array.isArray(keys) && keys.length === 2) {
                reservationsPaused = true;
                signalPaused();
                await writerMayResume;
              }
            }
            return result;
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as unknown as PrismaClient;
    const exportWorker = createExportWorker({ db: pausingDb, storageRoot });
    writerPromise = exportWorker.process(exportClaim);

    const timeout = new AbortController();
    try {
      await Promise.race([
        paused,
        delay(20_000, undefined, { signal: timeout.signal }).then(() => { throw new Error("Export writer did not reserve both paths."); }),
      ]);
    } finally {
      timeout.abort();
    }
    assert.equal(reservationsPaused, true);
    const jobWithReservations = await db.job.findUniqueOrThrow({
      where: { id: exportClaim.jobId },
      select: { storageReservations: true },
    });
    const reservedKeys = jobWithReservations.storageReservations;
    assert.ok(Array.isArray(reservedKeys));
    assert.equal(reservedKeys.length, 2);
    const finalKey = reservedKeys.find(key => typeof key === "string" && key.endsWith("/document.md"));
    const pendingKey = reservedKeys.find(key => typeof key === "string" && key.endsWith("/document.md.pending"));
    assert.equal(typeof finalKey, "string");
    assert.equal(typeof pendingKey, "string");
    const exportFolderName = (finalKey as string).split("/")[0];
    assert.equal((pendingKey as string).split("/")[0], exportFolderName);
    const exportFolder = join(storageRoot, exportFolderName);
    assert.deepEqual(await readdir(exportFolder), [], "the writer creates the directory before committing its reservations");

    await db.$executeRaw`
      UPDATE "WorkerSlot" SET "leaseUntil" = clock_timestamp() - INTERVAL '1 second'
      WHERE "slotKey" = 'export' AND "jobId" = ${exportClaim.jobId} AND "ownerUserId" = ${owner.id}
    `;
    await db.$executeRaw`
      UPDATE "Job" SET "leaseExpiresAt" = clock_timestamp() - INTERVAL '1 second'
      WHERE "id" = ${exportClaim.jobId} AND "ownerUserId" = ${owner.id}
    `;
    assert.equal(await claimExportJob(db, { leaseDurationMs: 120_000 }), null, "claim recovers the expired writer before claiming another export");
    assert.equal((await findMarkdownExportForUser(db, { ownerUserId: owner.id, analysisId: published.analysisId, exportId: enqueued.export.id }))?.status, "FAILED");

    const deletion = await requestAnalysisDeletion(db, owner.id, published.analysisId);
    assert.equal(deletion.status, "QUEUED");
    const cleanupClaim = await claimCleanupJob(db);
    assert.ok(cleanupClaim);
    assert.ok(cleanupClaim.manifest.some(entry => entry.storageKey === finalKey));
    assert.ok(cleanupClaim.manifest.some(entry => entry.storageKey === pendingKey));
    await createCleanupWorker({ db, storageRoot }).process(cleanupClaim);

    assert.equal((await findCleanupJobForUser(db, owner.id, deletion.jobId))?.status, "COMPLETED");
    assert.equal(await db.analysis.findUnique({ where: { id: published.analysisId } }), null);
    for (const path of [
      exportFolder,
      join(storageRoot, finalKey as string),
      join(storageRoot, pendingKey as string),
      published.archivePath,
      dirname(published.archivePath),
    ]) {
      await assert.rejects(lstat(path), error => typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT");
    }
    assert.deepEqual(await readFile(canaryPath), canaryContent);

    continueWriter();
    await writerPromise;
    writerPromise = undefined;
    await assert.rejects(lstat(exportFolder), error => typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT");
    await assert.rejects(lstat(join(storageRoot, finalKey as string)), error => typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT");
    await assert.rejects(lstat(join(storageRoot, pendingKey as string)), error => typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT");
    assert.deepEqual(await readFile(canaryPath), canaryContent);
  } finally {
    continueWriter?.();
    await writerPromise?.catch(() => undefined);
    try {
      await db.$transaction(async tx => {
        const jobs = await tx.job.findMany({ where: { ownerUserId: { in: ownerIds } }, select: { id: true } });
        await tx.workerSlot.updateMany({
          where: { jobId: { in: jobs.map(job => job.id) } },
          data: { jobId: null, ownerUserId: null, leaseUntil: null, heartbeatAt: null, leaseTokenHash: null },
        });
        await tx.job.deleteMany({ where: { ownerUserId: { in: ownerIds } } });
        await tx.export.deleteMany({ where: { ownerUserId: { in: ownerIds } } });
        await tx.storageObject.deleteMany({ where: { ownerUserId: { in: ownerIds } } });
        await tx.graphBundle.deleteMany({ where: { ownerUserId: { in: ownerIds } } });
        await tx.architectureDocument.deleteMany({ where: { ownerUserId: { in: ownerIds } } });
        await tx.analysis.updateMany({ where: { ownerUserId: { in: ownerIds } }, data: { retryParentId: null } });
        await tx.analysis.deleteMany({ where: { ownerUserId: { in: ownerIds } } });
        await tx.user.deleteMany({ where: { id: { in: ownerIds } } });
        if (repositoryId) await tx.repository.deleteMany({ where: { id: repositoryId } });
        if (!exportSlotInitiallyExisted) await tx.workerSlot.deleteMany({ where: { slotKey: "export", jobId: null } });
        if (!analysisSlotInitiallyExisted) await tx.workerSlot.deleteMany({ where: { slotKey: "analysis", jobId: null } });
        if (!cleanupSlotInitiallyExisted) await tx.workerSlot.deleteMany({ where: { slotKey: "cleanup", jobId: null } });
      });
    } finally {
      if (storageRoot) await rm(storageRoot, { recursive: true, force: true });
      await disconnectDatabase();
    }
  }
});
