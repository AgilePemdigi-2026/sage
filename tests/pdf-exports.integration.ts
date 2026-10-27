import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { pack } from "tar-stream";
import test from "node:test";
import { canonicalizeCkg } from "@sage/contracts";
import { analyzeReferences } from "@sage/analyzer-js";
import { projectArchitectureDocument } from "@sage/documents/model";
import { MARKDOWN_RENDERER_VERSION } from "../packages/documents/src/markdown.ts";
import { PDF_RENDERER_VERSION } from "../packages/documents/src/pdf-version.ts";
import {
  claimExportJob,
  completeExportJob,
  database,
  disconnectDatabase,
  enqueueExport,
  failExportJob,
  findExportSnapshotForUser,
  renewExportLease,
  retryExport,
} from "../packages/database/src/index.ts";
import { createExportWorker } from "../apps/worker/src/export-handlers.ts";
import { loadAnyExportDownloadForUser, loadExportDownloadForUser } from "../apps/web/lib/exports/reader.ts";
import type { PrismaClient } from "../packages/database/generated/client.ts";

function assertIsolatedPdfDatabase(): void {
  if (process.env.SAGE_PDF_TESTS !== "1") throw new Error("Set SAGE_PDF_TESTS=1 to run destructive PDF export integration tests.");
  const rawUrl = process.env.DATABASE_URL;
  if (!rawUrl) throw new Error("DATABASE_URL is required for PDF export integration tests.");
  let databaseName: string;
  try { databaseName = decodeURIComponent(new URL(rawUrl).pathname.slice(1)); }
  catch { throw new Error("DATABASE_URL is invalid; it was not logged."); }
  if (databaseName !== "sage_pdf21") throw new Error("PDF export integration tests only allow the isolated sage_pdf21 database.");
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
    analyzerVersion: "pdf21-integration",
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
  await db.storageObject.create({ data: {
    ownerUserId: input.ownerUserId,
    analysisId: analysis.id,
    type: "SOURCE_ARCHIVE",
    storageKey: `${archiveFolder}/archive.tar.gz`,
    sha256: digest(archive),
    byteLength: BigInt(archive.byteLength),
  } });
  return { analysisId: analysis.id, documentHash: canonicalDocument.sha256, archive, archivePath };
}

test("PDF exports deduplicate by format, publish private PDF bytes, and retry under lease fencing", {
  skip: process.env.SAGE_PDF_TESTS !== "1",
}, async () => {
  assertIsolatedPdfDatabase();
  const db = database();
  const suffix = randomUUID();
  const ownerIds: string[] = [];
  let repositoryId = "";
  let storageRoot = "";
  let exportSlotInitiallyExisted = false;
  try {
    storageRoot = await mkdtemp(join(tmpdir(), "sage-pdf21-"));
    const sourceBytes = new Uint8Array(await readFile(new URL("../packages/contracts/examples/minimum-ccm.source.ts", import.meta.url)));
    const owner = await db.user.create({ data: { githubUserId: `pdf21-owner-${suffix}`, login: `pdf21-owner-${suffix}` } });
    ownerIds.push(owner.id);
    const repository = await db.repository.create({ data: {
      githubRepositoryId: `pdf21-repo-${suffix}`,
      ownerLogin: "sage-pdf-test",
      name: suffix,
      fullName: `sage-pdf-test/${suffix}`,
      visibility: "PUBLIC",
    } });
    repositoryId = repository.id;
    exportSlotInitiallyExisted = Boolean(await db.workerSlot.findUnique({ where: { slotKey: "export" }, select: { slotKey: true } }));

    const first = await createPublishedAnalysis(db, {
      ownerUserId: owner.id, repositoryId, repositoryFullName: repository.fullName, suffix: `${suffix}a`, storageRoot, sourceBytes,
    });
    const pdfRequest = { ownerUserId: owner.id, analysisId: first.analysisId, format: "PDF" as const, documentHash: first.documentHash, rendererVersion: PDF_RENDERER_VERSION };
    const pdfEnqueues = await Promise.all([enqueueExport(db, pdfRequest), enqueueExport(db, pdfRequest)]);
    assert.equal(pdfEnqueues.filter(result => result.created).length, 1);
    assert.equal(pdfEnqueues.filter(result => !result.created).length, 1);
    const pdfExport = pdfEnqueues.find(result => result.created)!.export;
    assert.equal(pdfExport.format, "PDF");

    const markdown = await enqueueExport(db, {
      ownerUserId: owner.id, analysisId: first.analysisId, format: "MARKDOWN",
      documentHash: first.documentHash, rendererVersion: MARKDOWN_RENDERER_VERSION,
    });
    assert.equal(markdown.created, true, "the other format gets a distinct export for the same document");
    assert.notEqual(markdown.export.id, pdfExport.id);
    assert.equal(await db.job.count({ where: { type: "EXPORT", exportId: pdfExport.id } }), 1);

    const worker = createExportWorker({ db, storageRoot });
    const pdfClaim = await claimExportJob(db, { leaseDurationMs: 120_000 });
    assert.ok(pdfClaim);
    assert.equal(pdfClaim.format, "PDF");
    assert.equal(await renewExportLease(db, { ...pdfClaim, format: "MARKDOWN" }), null, "format is part of the lease fence");
    await assert.rejects(completeExportJob(db, pdfClaim, {
      storageKey: `export-${randomUUID()}/document.md`, contentHash: digest("%PDF-"), byteLength: 5,
    }), /Export storage key is invalid/);
    await worker.process(pdfClaim);
    const readyPdf = await findExportSnapshotForUser(db, { ownerUserId: owner.id, analysisId: first.analysisId, exportId: pdfExport.id });
    assert.equal(readyPdf?.status, "READY");
    assert.equal(readyPdf?.format, "PDF");
    assert.match(readyPdf?.contentHash ?? "", /^[a-f0-9]{64}$/);
    const pdfRecord = await db.export.findUniqueOrThrow({ where: { id: pdfExport.id }, select: { storageObject: { select: { storageKey: true } } } });
    assert.match(pdfRecord.storageObject?.storageKey ?? "", /\/document\.pdf$/);
    const pdfDownload = await loadAnyExportDownloadForUser(db, storageRoot, owner.id, first.analysisId, pdfExport.id);
    assert.equal(pdfDownload.kind, "ready");
    if (pdfDownload.kind === "ready") {
      assert.equal(pdfDownload.value.format, "PDF");
      assert.match(pdfDownload.value.filename, /\.pdf$/);
      assert.match(Buffer.from(pdfDownload.value.bytes).toString("latin1"), /^%PDF-/);
      assert.equal(digest(pdfDownload.value.bytes), readyPdf?.contentHash);
    }
    assert.equal((await loadExportDownloadForUser(db, storageRoot, owner.id, first.analysisId, pdfExport.id)).kind, "not-found",
      "the legacy Markdown reader will not serve a PDF record");

    const markdownClaim = await claimExportJob(db, { leaseDurationMs: 120_000 });
    assert.ok(markdownClaim);
    assert.equal(markdownClaim.format, "MARKDOWN");
    await worker.process(markdownClaim);
    const markdownDownload = await loadExportDownloadForUser(db, storageRoot, owner.id, first.analysisId, markdown.export.id);
    assert.equal(markdownDownload.kind, "ready");
    if (markdownDownload.kind === "ready") {
      assert.equal(markdownDownload.value.format, "MARKDOWN");
      assert.match(markdownDownload.value.filename, /\.md$/);
    }

    const second = await createPublishedAnalysis(db, {
      ownerUserId: owner.id, repositoryId, repositoryFullName: repository.fullName, suffix: `${suffix}b`, storageRoot, sourceBytes,
    });
    const secondPdf = await enqueueExport(db, {
      ownerUserId: owner.id, analysisId: second.analysisId, format: "PDF",
      documentHash: second.documentHash, rendererVersion: PDF_RENDERER_VERSION,
    });
    const staleClaim = await claimExportJob(db, { leaseDurationMs: 120_000 });
    assert.ok(staleClaim);
    assert.equal(staleClaim.format, "PDF");
    await db.$executeRaw`UPDATE "WorkerSlot" SET "leaseUntil" = clock_timestamp() - INTERVAL '1 second' WHERE "slotKey" = 'export' AND "jobId" = ${staleClaim.jobId}`;
    await db.$executeRaw`UPDATE "Job" SET "leaseExpiresAt" = clock_timestamp() - INTERVAL '1 second' WHERE "id" = ${staleClaim.jobId}`;
    assert.equal(await claimExportJob(db, { leaseDurationMs: 120_000 }), null, "expired PDF claim is recovered before new work is claimed");
    const failed = await findExportSnapshotForUser(db, { ownerUserId: owner.id, analysisId: second.analysisId, exportId: secondPdf.export.id });
    assert.equal(failed?.status, "FAILED");
    assert.equal(failed?.errorCode, "WORKER_INTERRUPTED");
    assert.equal(await failExportJob(db, staleClaim, "STALE_WORKER"), false, "the expired PDF worker cannot overwrite recovery");
    const retried = await retryExport(db, { ownerUserId: owner.id, analysisId: second.analysisId, exportId: secondPdf.export.id });
    assert.equal(retried.status, "QUEUED");
    assert.equal(retried.format, "PDF");
    assert.equal(retried.documentHash, second.documentHash);
    assert.equal(retried.rendererVersion, PDF_RENDERER_VERSION);
    const retryClaim = await claimExportJob(db, { leaseDurationMs: 120_000 });
    assert.ok(retryClaim);
    assert.equal(retryClaim.format, "PDF");
    await worker.process(retryClaim);
    const retriedPdf = await loadAnyExportDownloadForUser(db, storageRoot, owner.id, second.analysisId, secondPdf.export.id);
    assert.equal(retriedPdf.kind, "ready");
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
      });
    } finally {
      if (storageRoot) await rm(storageRoot, { recursive: true, force: true });
      await disconnectDatabase();
    }
  }
});
