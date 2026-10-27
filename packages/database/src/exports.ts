import { createHash, randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "../generated/client.ts";

const EXPORT_SLOT = "export";
const DEFAULT_LEASE_DURATION_MS = 30_000;
const MIN_LEASE_DURATION_MS = 1_000;
const MAX_LEASE_DURATION_MS = 300_000;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export type ExportFormat = "MARKDOWN" | "PDF";

export interface ExportJobClaim {
  jobId: string;
  exportId: string;
  format: ExportFormat;
  analysisId: string;
  ownerUserId: string;
  documentHash: string;
  rendererVersion: string;
  attempt: number;
  leaseToken: string;
  leaseExpiresAt: Date;
}

export interface ExportLeaseOptions { leaseDurationMs?: number; }

export interface ExportSnapshot {
  id: string;
  format: ExportFormat;
  status: "QUEUED" | "GENERATING" | "READY" | "FAILED";
  documentHash: string;
  rendererVersion: string;
  contentHash: string | null;
  errorCode: string | null;
}

export class ExportQueueInvariantError extends Error {
  constructor() { super("Export queue state is inconsistent."); this.name = "ExportQueueInvariantError"; }
}

export class ExportAnalysisNotFoundError extends Error {
  constructor() { super("Analysis was not found for this owner."); this.name = "ExportAnalysisNotFoundError"; }
}

export class ExportResultNotReadyError extends Error {
  constructor() { super("Analysis result is not published yet."); this.name = "ExportResultNotReadyError"; }
}

export class ExportDocumentChangedError extends Error {
  constructor() { super("The canonical document changed before export enqueue."); this.name = "ExportDocumentChangedError"; }
}

export class ExportRetryConflictError extends Error {
  constructor() { super("Export is no longer eligible for retry."); this.name = "ExportRetryConflictError"; }
}

function requireNonEmpty(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${field} is required.`);
}

function validateDocumentHash(value: unknown): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) throw new Error("Document hash must be lowercase SHA-256 hex.");
  return value;
}

function validateRendererVersion(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(value)) throw new Error("Renderer version is invalid.");
  return value;
}

function validateExportFormat(value: unknown): ExportFormat {
  if (value !== "MARKDOWN" && value !== "PDF") throw new Error("Export format is invalid.");
  return value;
}

function validateLeaseDuration(value: unknown): number {
  if (value === undefined) return DEFAULT_LEASE_DURATION_MS;
  if (!Number.isSafeInteger(value) || (value as number) < MIN_LEASE_DURATION_MS || (value as number) > MAX_LEASE_DURATION_MS) {
    throw new Error(`Lease duration must be ${MIN_LEASE_DURATION_MS}–${MAX_LEASE_DURATION_MS} milliseconds.`);
  }
  return value as number;
}

function sha256(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }

export function snapshotExportJobClaim(input: ExportJobClaim): ExportJobClaim {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Export claim is invalid.");
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) throw new Error("Export claim must be a plain object.");
  const fields = ["jobId", "exportId", "format", "analysisId", "ownerUserId", "documentHash", "rendererVersion", "attempt", "leaseToken", "leaseExpiresAt"] as const;
  const keys = Reflect.ownKeys(input);
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (keys.length !== fields.length || keys.some(key => typeof key !== "string" || !fields.includes(key as typeof fields[number]))) {
    throw new Error("Export claim contains invalid fields.");
  }
  for (const field of fields) {
    const descriptor = descriptors[field];
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) throw new Error("Export claim must contain plain data properties.");
  }
  const leaseExpiresAtValue = descriptors.leaseExpiresAt.value;
  const milliseconds = leaseExpiresAtValue instanceof Date
    ? Date.prototype.getTime.call(leaseExpiresAtValue) as number
    : typeof leaseExpiresAtValue === "string" ? Date.parse(leaseExpiresAtValue) : Number.NaN;
  if (!Number.isFinite(milliseconds)) throw new Error("Export lease expiry is invalid.");
  const claim = Object.freeze({
    jobId: descriptors.jobId.value as string,
    exportId: descriptors.exportId.value as string,
    format: descriptors.format.value as ExportFormat,
    analysisId: descriptors.analysisId.value as string,
    ownerUserId: descriptors.ownerUserId.value as string,
    documentHash: descriptors.documentHash.value as string,
    rendererVersion: descriptors.rendererVersion.value as string,
    attempt: descriptors.attempt.value as number,
    leaseToken: descriptors.leaseToken.value as string,
    leaseExpiresAt: new Date(milliseconds),
  });
  requireNonEmpty(claim.jobId, "Job ID");
  requireNonEmpty(claim.exportId, "Export ID");
  validateExportFormat(claim.format);
  requireNonEmpty(claim.analysisId, "Analysis ID");
  requireNonEmpty(claim.ownerUserId, "Owner ID");
  validateDocumentHash(claim.documentHash);
  validateRendererVersion(claim.rendererVersion);
  if (!Number.isSafeInteger(claim.attempt) || claim.attempt < 1) throw new Error("Export attempt is invalid.");
  if (typeof claim.leaseToken !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(claim.leaseToken)) {
    throw new Error("Export lease token is invalid.");
  }
  return claim;
}

type ExportSlotRow = {
  jobId: string | null;
  ownerUserId: string | null;
  leaseUntil: Date | null;
  heartbeatAt: Date | null;
  leaseTokenHash: string | null;
  lastEnqueueSequence: bigint;
};

type OccupiedExportSlotRow = ExportSlotRow & {
  jobType: string | null;
  jobStatus: string | null;
  jobExportId: string | null;
  jobAnalysisId: string | null;
  jobOwnerUserId: string | null;
  jobAttempt: number | null;
  jobLeaseExpiresAt: Date | null;
  exportStatus: string | null;
  exportFormat: string | null;
  exportAnalysisId: string | null;
  exportOwnerUserId: string | null;
  documentHash: string | null;
  rendererVersion: string | null;
};

async function ensureAndLockExportSlot(tx: Prisma.TransactionClient): Promise<ExportSlotRow> {
  await tx.$executeRaw`
    INSERT INTO "WorkerSlot" ("slotKey", "updatedAt", "lastEnqueueSequence")
    VALUES (
      ${EXPORT_SLOT}, clock_timestamp(),
      COALESCE((SELECT MAX("queueSequence") FROM "Job" WHERE "type" = 'EXPORT'), 0)
    )
    ON CONFLICT ("slotKey") DO NOTHING
  `;
  const rows = await tx.$queryRaw<ExportSlotRow[]>`
    SELECT "jobId", "ownerUserId", "leaseUntil", "heartbeatAt", "leaseTokenHash", "lastEnqueueSequence"
    FROM "WorkerSlot" WHERE "slotKey" = ${EXPORT_SLOT} FOR UPDATE
  `;
  if (rows.length !== 1) throw new ExportQueueInvariantError();
  return rows[0];
}

async function readExportSlot(tx: Prisma.TransactionClient): Promise<OccupiedExportSlotRow> {
  const rows = await tx.$queryRaw<OccupiedExportSlotRow[]>`
    SELECT slot."jobId", slot."ownerUserId", slot."leaseUntil", slot."heartbeatAt", slot."leaseTokenHash", slot."lastEnqueueSequence",
      job."type"::text AS "jobType", job."status"::text AS "jobStatus", job."exportId" AS "jobExportId",
      job."analysisId" AS "jobAnalysisId", job."ownerUserId" AS "jobOwnerUserId", job."attempt" AS "jobAttempt",
      job."leaseExpiresAt" AS "jobLeaseExpiresAt", export."status"::text AS "exportStatus", export."format"::text AS "exportFormat",
      export."analysisId" AS "exportAnalysisId", export."ownerUserId" AS "exportOwnerUserId",
      export."documentHash", export."rendererVersion"
    FROM "WorkerSlot" AS slot
    LEFT JOIN "Job" AS job ON job."id" = slot."jobId" AND job."ownerUserId" = slot."ownerUserId"
    LEFT JOIN "Export" AS export ON export."id" = job."exportId" AND export."ownerUserId" = job."ownerUserId"
    WHERE slot."slotKey" = ${EXPORT_SLOT}
  `;
  if (rows.length !== 1) throw new ExportQueueInvariantError();
  return rows[0];
}

function requireEmptyExportSlot(slot: ExportSlotRow): void {
  if (slot.jobId !== null || slot.ownerUserId !== null || slot.leaseUntil !== null || slot.heartbeatAt !== null || slot.leaseTokenHash !== null) {
    throw new ExportQueueInvariantError();
  }
}

function requireOccupiedExportSlot(slot: OccupiedExportSlotRow): asserts slot is OccupiedExportSlotRow & {
  jobId: string; ownerUserId: string; leaseUntil: Date; heartbeatAt: Date; leaseTokenHash: string;
  jobExportId: string; jobAnalysisId: string; jobOwnerUserId: string; jobAttempt: number; jobLeaseExpiresAt: Date;
  exportAnalysisId: string; exportOwnerUserId: string; documentHash: string; rendererVersion: string;
  exportFormat: ExportFormat;
} {
  if (!slot.jobId || !slot.ownerUserId || !slot.leaseUntil || !slot.heartbeatAt || !slot.leaseTokenHash
    || slot.jobType !== "EXPORT" || slot.jobStatus !== "RUNNING" || !slot.jobExportId || !slot.jobAnalysisId
    || slot.jobOwnerUserId !== slot.ownerUserId || !Number.isSafeInteger(slot.jobAttempt) || !slot.jobLeaseExpiresAt
    || slot.exportStatus !== "GENERATING" || slot.exportAnalysisId !== slot.jobAnalysisId || slot.exportOwnerUserId !== slot.ownerUserId
    || (slot.exportFormat !== "MARKDOWN" && slot.exportFormat !== "PDF") || !slot.documentHash || !slot.rendererVersion) throw new ExportQueueInvariantError();
}

async function allocateExportSequence(tx: Prisma.TransactionClient): Promise<bigint> {
  const rows = await tx.$queryRaw<Array<{ sequence: bigint }>>`
    UPDATE "WorkerSlot" SET "lastEnqueueSequence" = "lastEnqueueSequence" + 1, "updatedAt" = clock_timestamp()
    WHERE "slotKey" = ${EXPORT_SLOT} RETURNING "lastEnqueueSequence" AS "sequence"
  `;
  if (rows.length !== 1 || rows[0].sequence <= 0n) throw new ExportQueueInvariantError();
  return rows[0].sequence;
}

async function assertPublishedDocument(
  tx: Prisma.TransactionClient,
  ownerUserId: string,
  analysisId: string,
  documentHash: string,
): Promise<string> {
  const rows = await tx.$queryRaw<Array<{ analysisStatus: string; documentId: string; documentHash: string }>>`
    SELECT analysis."status"::text AS "analysisStatus", document."id" AS "documentId", document."contentHash" AS "documentHash"
    FROM "Analysis" AS analysis
    JOIN "ArchitectureDocument" AS document ON document."analysisId" = analysis."id" AND document."ownerUserId" = analysis."ownerUserId"
    WHERE analysis."id" = ${analysisId} AND analysis."ownerUserId" = ${ownerUserId}
      AND analysis."deletionRequestedAt" IS NULL
    FOR UPDATE OF analysis
  `;
  const row = rows[0];
  if (!row) throw new ExportAnalysisNotFoundError();
  if (row.analysisStatus !== "COMPLETED" && row.analysisStatus !== "COMPLETED_WITH_LIMITATIONS") throw new ExportResultNotReadyError();
  if (row.documentHash !== documentHash) throw new ExportDocumentChangedError();
  return row.documentId;
}

function toSnapshot(row: {
  id: string; format: string; status: string; documentHash: string; rendererVersion: string; contentHash: string | null; errorCode: string | null;
}): ExportSnapshot {
  if ((row.format !== "MARKDOWN" && row.format !== "PDF") || !["QUEUED", "GENERATING", "READY", "FAILED"].includes(row.status)) throw new ExportQueueInvariantError();
  return {
    id: row.id,
    format: row.format,
    status: row.status as ExportSnapshot["status"],
    documentHash: row.documentHash,
    rendererVersion: row.rendererVersion,
    contentHash: row.contentHash,
    errorCode: row.errorCode,
  };
}

async function createExportJob(tx: Prisma.TransactionClient, input: {
  ownerUserId: string; analysisId: string; exportId: string;
}): Promise<void> {
  const queueSequence = await allocateExportSequence(tx);
  await tx.job.create({ data: {
    ownerUserId: input.ownerUserId,
    analysisId: input.analysisId,
    exportId: input.exportId,
    type: "EXPORT",
    queueSequence,
  } });
  await tx.$executeRaw`UPDATE "Job" SET "enqueuedAt" = clock_timestamp() WHERE "exportId" = ${input.exportId} AND "ownerUserId" = ${input.ownerUserId} AND "status" = 'QUEUED'`;
}

export interface EnqueueExportInput {
  ownerUserId: string;
  analysisId: string;
  format: ExportFormat;
  documentHash: string;
  rendererVersion: string;
}

export async function enqueueExport(
  db: PrismaClient,
  input: EnqueueExportInput,
): Promise<{ export: ExportSnapshot; created: boolean }> {
  requireNonEmpty(input.ownerUserId, "Owner ID");
  requireNonEmpty(input.analysisId, "Analysis ID");
  const format = validateExportFormat(input.format);
  const documentHash = validateDocumentHash(input.documentHash);
  const rendererVersion = validateRendererVersion(input.rendererVersion);

  return db.$transaction(async tx => {
    await ensureAndLockExportSlot(tx);
    const architectureDocumentId = await assertPublishedDocument(tx, input.ownerUserId, input.analysisId, documentHash);
    const existing = await tx.export.findFirst({
      where: { ownerUserId: input.ownerUserId, analysisId: input.analysisId, format, documentHash, rendererVersion },
      select: { id: true, format: true, status: true, documentHash: true, rendererVersion: true, contentHash: true, errorCode: true },
    });
    if (existing) return { export: toSnapshot(existing), created: false };

    const record = await tx.export.create({ data: {
      ownerUserId: input.ownerUserId,
      analysisId: input.analysisId,
      architectureDocumentId,
      format,
      documentHash,
      rendererVersion,
      status: "QUEUED",
    }, select: { id: true, format: true, status: true, documentHash: true, rendererVersion: true, contentHash: true, errorCode: true } });
    await createExportJob(tx, { ownerUserId: input.ownerUserId, analysisId: input.analysisId, exportId: record.id });
    return { export: toSnapshot(record), created: true };
  });
}

export async function enqueueMarkdownExport(
  db: PrismaClient,
  input: Omit<EnqueueExportInput, "format">,
): Promise<{ export: ExportSnapshot; created: boolean }> {
  return enqueueExport(db, { ...input, format: "MARKDOWN" });
}

export async function retryExport(db: PrismaClient, input: {
  ownerUserId: string; analysisId: string; exportId: string; format?: ExportFormat;
}): Promise<ExportSnapshot> {
  requireNonEmpty(input.ownerUserId, "Owner ID");
  requireNonEmpty(input.analysisId, "Analysis ID");
  requireNonEmpty(input.exportId, "Export ID");
  const requestedFormat = input.format === undefined ? undefined : validateExportFormat(input.format);

  return db.$transaction(async tx => {
    await ensureAndLockExportSlot(tx);
    const found = await tx.export.findFirst({
      where: {
        id: input.exportId, ownerUserId: input.ownerUserId, analysisId: input.analysisId,
        analysis: { is: { deletionRequestedAt: null } },
        ...(requestedFormat ? { format: requestedFormat } : {}),
      },
      select: { id: true, format: true, status: true, documentHash: true, rendererVersion: true },
    });
    if (!found) throw new ExportAnalysisNotFoundError();
    const format = validateExportFormat(found.format);
    if (found.status !== "FAILED") throw new ExportRetryConflictError();
    const architectureDocumentId = await assertPublishedDocument(tx, input.ownerUserId, input.analysisId, found.documentHash);
    const updated = await tx.export.update({
      where: { id: found.id, format },
      data: { status: "QUEUED", contentHash: null, errorCode: null, storageObjectId: null, readyAt: null, architectureDocumentId },
      select: { id: true, format: true, status: true, documentHash: true, rendererVersion: true, contentHash: true, errorCode: true },
    });
    await createExportJob(tx, { ownerUserId: input.ownerUserId, analysisId: input.analysisId, exportId: found.id });
    return toSnapshot(updated);
  });
}

export async function retryMarkdownExport(db: PrismaClient, input: {
  ownerUserId: string; analysisId: string; exportId: string;
}): Promise<ExportSnapshot> {
  return retryExport(db, { ...input, format: "MARKDOWN" });
}

export async function findExportSnapshotForUser(
  db: PrismaClient,
  input: { ownerUserId: string; analysisId: string; exportId: string; format?: ExportFormat },
): Promise<ExportSnapshot | null> {
  requireNonEmpty(input.ownerUserId, "Owner ID");
  requireNonEmpty(input.analysisId, "Analysis ID");
  requireNonEmpty(input.exportId, "Export ID");
  const format = input.format === undefined ? undefined : validateExportFormat(input.format);
  const row = await db.export.findFirst({
    where: {
      id: input.exportId, ownerUserId: input.ownerUserId, analysisId: input.analysisId,
      analysis: { is: { deletionRequestedAt: null } },
      ...(format ? { format } : {}),
    },
    select: { id: true, format: true, status: true, documentHash: true, rendererVersion: true, contentHash: true, errorCode: true },
  });
  return row ? toSnapshot(row) : null;
}

export async function findMarkdownExportForUser(
  db: PrismaClient,
  input: { ownerUserId: string; analysisId: string; exportId: string },
): Promise<ExportSnapshot | null> {
  return findExportSnapshotForUser(db, { ...input, format: "MARKDOWN" });
}

export type ClaimExportJobOptions = ExportLeaseOptions;
export type RenewExportLeaseOptions = ExportLeaseOptions;

async function recoverExpiredExport(tx: Prisma.TransactionClient, slot: OccupiedExportSlotRow & {
  jobId: string; ownerUserId: string; leaseTokenHash: string; jobExportId: string; jobAnalysisId: string; jobAttempt: number;
  exportFormat: ExportFormat;
}): Promise<void> {
  const jobRows = await tx.$queryRaw<Array<{ id: string }>>`
    UPDATE "Job" AS job
    SET "status" = 'FAILED', "finishedAt" = clock_timestamp(), "errorCode" = 'WORKER_INTERRUPTED', "updatedAt" = clock_timestamp()
    WHERE job."id" = ${slot.jobId} AND job."ownerUserId" = ${slot.ownerUserId} AND job."type" = 'EXPORT'
      AND job."exportId" = ${slot.jobExportId} AND job."analysisId" = ${slot.jobAnalysisId}
      AND job."status" = 'RUNNING' AND job."attempt" = ${slot.jobAttempt}
      AND EXISTS (SELECT 1 FROM "Export" AS export WHERE export."id" = job."exportId"
        AND export."ownerUserId" = job."ownerUserId" AND export."analysisId" = job."analysisId"
        AND export."format"::text = ${slot.exportFormat})
      AND EXISTS (SELECT 1 FROM "WorkerSlot" AS current_slot
        WHERE current_slot."slotKey" = ${EXPORT_SLOT} AND current_slot."jobId" = job."id"
          AND current_slot."ownerUserId" = job."ownerUserId" AND current_slot."leaseTokenHash" = ${slot.leaseTokenHash}
          AND (current_slot."leaseUntil" <= clock_timestamp() OR job."leaseExpiresAt" <= clock_timestamp()))
    RETURNING job."id"
  `;
  if (jobRows.length !== 1) throw new ExportQueueInvariantError();

  const exportRows = await tx.$queryRaw<Array<{ id: string }>>`
    UPDATE "Export" AS export
    SET "status" = 'FAILED', "errorCode" = 'WORKER_INTERRUPTED', "updatedAt" = clock_timestamp()
    WHERE export."id" = ${slot.jobExportId} AND export."ownerUserId" = ${slot.ownerUserId}
      AND export."analysisId" = ${slot.jobAnalysisId} AND export."format"::text = ${slot.exportFormat} AND export."status" = 'GENERATING'
      AND EXISTS (SELECT 1 FROM "Job" AS job
        WHERE job."id" = ${slot.jobId} AND job."ownerUserId" = ${slot.ownerUserId}
          AND job."type" = 'EXPORT' AND job."exportId" = export."id" AND job."attempt" = ${slot.jobAttempt}
          AND job."status" = 'FAILED' AND job."errorCode" = 'WORKER_INTERRUPTED')
    RETURNING export."id"
  `;
  if (exportRows.length !== 1) throw new ExportQueueInvariantError();

  const releaseRows = await tx.$queryRaw<Array<{ slotKey: string }>>`
    UPDATE "WorkerSlot" AS slot
    SET "jobId" = NULL, "ownerUserId" = NULL, "leaseUntil" = NULL, "heartbeatAt" = NULL,
        "leaseTokenHash" = NULL, "updatedAt" = clock_timestamp()
    WHERE slot."slotKey" = ${EXPORT_SLOT} AND slot."jobId" = ${slot.jobId}
      AND slot."ownerUserId" = ${slot.ownerUserId} AND slot."leaseTokenHash" = ${slot.leaseTokenHash}
      AND (slot."leaseUntil" <= clock_timestamp() OR EXISTS (
        SELECT 1 FROM "Job" AS job WHERE job."id" = ${slot.jobId} AND job."ownerUserId" = ${slot.ownerUserId}
          AND job."attempt" = ${slot.jobAttempt} AND job."leaseExpiresAt" <= clock_timestamp()
          AND EXISTS (SELECT 1 FROM "Export" AS export WHERE export."id" = job."exportId"
            AND export."ownerUserId" = job."ownerUserId" AND export."format"::text = ${slot.exportFormat})))
    RETURNING slot."slotKey"
  `;
  if (releaseRows.length !== 1) throw new ExportQueueInvariantError();
}

/** Claim the oldest export or recover an expired export lease before claiming new work. */
export async function claimExportJob(db: PrismaClient, options: ClaimExportJobOptions = {}): Promise<ExportJobClaim | null> {
  const leaseDurationMs = validateLeaseDuration(options.leaseDurationMs);
  return db.$transaction(async tx => {
    await ensureAndLockExportSlot(tx);
    let slot = await readExportSlot(tx);
    if (slot.jobId === null) {
      requireEmptyExportSlot(slot);
      const orphan = await tx.$queryRaw<Array<{ exists: boolean }>>`
        SELECT EXISTS (SELECT 1 FROM "Job" WHERE "type" = 'EXPORT' AND "status" = 'RUNNING')
          OR EXISTS (SELECT 1 FROM "Export" WHERE "status" = 'GENERATING') AS "exists"
      `;
      if (orphan[0]?.exists) throw new ExportQueueInvariantError();
    } else {
      requireOccupiedExportSlot(slot);
      const expiredRows = await tx.$queryRaw<Array<{ expired: boolean }>>`
        SELECT (slot."leaseUntil" <= clock_timestamp() OR job."leaseExpiresAt" <= clock_timestamp()) AS "expired"
        FROM "WorkerSlot" AS slot JOIN "Job" AS job ON job."id" = slot."jobId" AND job."ownerUserId" = slot."ownerUserId"
        WHERE slot."slotKey" = ${EXPORT_SLOT}
      `;
      if (expiredRows.length !== 1) throw new ExportQueueInvariantError();
      if (!expiredRows[0].expired) return null;
      await recoverExpiredExport(tx, slot);
      slot = await readExportSlot(tx);
      requireEmptyExportSlot(slot);
    }

    const candidates = await tx.$queryRaw<Array<{
      jobId: string; exportId: string; analysisId: string; ownerUserId: string; attempt: number; documentHash: string; rendererVersion: string;
      format: string;
    }>>`
      SELECT job."id" AS "jobId", export."id" AS "exportId", export."analysisId", export."ownerUserId",
        job."attempt", export."documentHash", export."rendererVersion", export."format"::text AS "format"
      FROM "Job" AS job JOIN "Export" AS export ON export."id" = job."exportId" AND export."ownerUserId" = job."ownerUserId"
      WHERE job."type" = 'EXPORT' AND job."status" = 'QUEUED' AND export."status" = 'QUEUED'
      ORDER BY job."queueSequence" ASC, job."enqueuedAt" ASC, job."id" ASC
      LIMIT 1 FOR UPDATE OF job, export
    `;
    const next = candidates[0];
    if (!next) return null;
    const format = validateExportFormat(next.format);

    const leaseToken = randomUUID();
    const leaseTokenHash = sha256(leaseToken);
    const jobRows = await tx.$queryRaw<Array<{ attempt: number; leaseExpiresAt: Date }>>`
      UPDATE "Job" AS job SET "status" = 'RUNNING', "startedAt" = clock_timestamp(), "finishedAt" = NULL,
        "heartbeatAt" = clock_timestamp(), "leaseExpiresAt" = clock_timestamp() + (${leaseDurationMs} * INTERVAL '1 millisecond'),
        "attempt" = "attempt" + 1, "errorCode" = NULL, "updatedAt" = clock_timestamp()
      WHERE job."id" = ${next.jobId} AND job."ownerUserId" = ${next.ownerUserId} AND job."exportId" = ${next.exportId}
        AND job."analysisId" = ${next.analysisId} AND job."type" = 'EXPORT' AND job."status" = 'QUEUED' AND job."attempt" = ${next.attempt}
        AND EXISTS (SELECT 1 FROM "Export" AS export WHERE export."id" = job."exportId"
          AND export."ownerUserId" = job."ownerUserId" AND export."analysisId" = job."analysisId"
          AND export."format"::text = ${format} AND export."status" = 'QUEUED')
      RETURNING job."attempt", job."leaseExpiresAt"
    `;
    if (jobRows.length !== 1) throw new ExportQueueInvariantError();
    const attempt = jobRows[0].attempt;
    const exportRows = await tx.$queryRaw<Array<{ id: string }>>`
      UPDATE "Export" SET "status" = 'GENERATING', "errorCode" = NULL, "updatedAt" = clock_timestamp()
      WHERE "id" = ${next.exportId} AND "ownerUserId" = ${next.ownerUserId} AND "analysisId" = ${next.analysisId}
        AND "format"::text = ${format} AND "documentHash" = ${next.documentHash}
        AND "rendererVersion" = ${next.rendererVersion} AND "status" = 'QUEUED'
      RETURNING "id"
    `;
    if (exportRows.length !== 1) throw new ExportQueueInvariantError();
    const slotRows = await tx.$queryRaw<Array<{ jobId: string }>>`
      UPDATE "WorkerSlot" AS slot
      SET "jobId" = ${next.jobId}, "ownerUserId" = ${next.ownerUserId}, "leaseUntil" = job."leaseExpiresAt",
        "heartbeatAt" = clock_timestamp(), "leaseTokenHash" = ${leaseTokenHash}, "updatedAt" = clock_timestamp()
      FROM "Job" AS job
      WHERE slot."slotKey" = ${EXPORT_SLOT} AND slot."jobId" IS NULL AND slot."ownerUserId" IS NULL
        AND slot."leaseUntil" IS NULL AND slot."leaseTokenHash" IS NULL
        AND job."id" = ${next.jobId} AND job."ownerUserId" = ${next.ownerUserId} AND job."status" = 'RUNNING'
        AND job."attempt" = ${attempt} AND job."leaseExpiresAt" > clock_timestamp()
        AND EXISTS (SELECT 1 FROM "Export" AS export WHERE export."id" = job."exportId"
          AND export."ownerUserId" = job."ownerUserId" AND export."analysisId" = job."analysisId"
          AND export."format"::text = ${format} AND export."status" = 'GENERATING')
      RETURNING slot."jobId"
    `;
    if (slotRows.length !== 1) throw new ExportQueueInvariantError();
    return {
      jobId: next.jobId,
      exportId: next.exportId,
      format,
      analysisId: next.analysisId,
      ownerUserId: next.ownerUserId,
      documentHash: next.documentHash,
      rendererVersion: next.rendererVersion,
      attempt,
      leaseToken,
      leaseExpiresAt: jobRows[0].leaseExpiresAt,
    };
  });
}

export async function renewExportLease(
  db: PrismaClient,
  inputClaim: ExportJobClaim,
  options: RenewExportLeaseOptions = {},
): Promise<Date | null> {
  const claim = snapshotExportJobClaim(inputClaim);
  const leaseDurationMs = validateLeaseDuration(options.leaseDurationMs);
  const leaseTokenHash = sha256(claim.leaseToken);
  return db.$transaction(async tx => {
    await ensureAndLockExportSlot(tx);
    const rows = await tx.$queryRaw<Array<{ slotUpdated: boolean; jobUpdated: boolean; leaseExpiresAt: Date | null }>>`
      WITH renewed_slot AS (
        UPDATE "WorkerSlot" AS slot
        SET "leaseUntil" = GREATEST(slot."leaseUntil", clock_timestamp() + (${leaseDurationMs} * INTERVAL '1 millisecond')),
          "heartbeatAt" = clock_timestamp(), "updatedAt" = clock_timestamp()
        WHERE slot."slotKey" = ${EXPORT_SLOT} AND slot."jobId" = ${claim.jobId} AND slot."ownerUserId" = ${claim.ownerUserId}
          AND slot."leaseTokenHash" = ${leaseTokenHash} AND slot."leaseUntil" > clock_timestamp()
          AND EXISTS (SELECT 1 FROM "Job" AS job WHERE job."id" = slot."jobId" AND job."ownerUserId" = slot."ownerUserId"
            AND job."analysisId" = ${claim.analysisId} AND job."exportId" = ${claim.exportId} AND job."type" = 'EXPORT'
            AND job."status" = 'RUNNING' AND job."attempt" = ${claim.attempt} AND job."leaseExpiresAt" > clock_timestamp()
            AND EXISTS (SELECT 1 FROM "Export" AS export WHERE export."id" = job."exportId"
              AND export."ownerUserId" = job."ownerUserId" AND export."analysisId" = job."analysisId"
              AND export."format"::text = ${claim.format}))
        RETURNING slot."jobId", slot."ownerUserId", slot."leaseUntil", slot."heartbeatAt"
      ), updated_job AS (
        UPDATE "Job" AS job SET "leaseExpiresAt" = renewed_slot."leaseUntil", "heartbeatAt" = renewed_slot."heartbeatAt", "updatedAt" = clock_timestamp()
        FROM renewed_slot WHERE job."id" = renewed_slot."jobId" AND job."ownerUserId" = renewed_slot."ownerUserId"
          AND job."analysisId" = ${claim.analysisId} AND job."exportId" = ${claim.exportId} AND job."type" = 'EXPORT'
          AND job."status" = 'RUNNING' AND job."attempt" = ${claim.attempt}
        RETURNING job."leaseExpiresAt"
      )
      SELECT EXISTS (SELECT 1 FROM renewed_slot) AS "slotUpdated", EXISTS (SELECT 1 FROM updated_job) AS "jobUpdated",
        (SELECT "leaseExpiresAt" FROM updated_job) AS "leaseExpiresAt"
    `;
    const result = rows[0];
    if (result.slotUpdated !== result.jobUpdated) throw new ExportQueueInvariantError();
    return result.slotUpdated ? result.leaseExpiresAt : null;
  });
}

export async function failExportJob(db: PrismaClient, inputClaim: ExportJobClaim, errorCode = "EXPORT_FAILED"): Promise<boolean> {
  const claim = snapshotExportJobClaim(inputClaim);
  if (typeof errorCode !== "string" || !/^[A-Z][A-Z0-9_]{0,63}$/.test(errorCode)) throw new Error("Export error code is invalid.");
  const leaseTokenHash = sha256(claim.leaseToken);
  return db.$transaction(async tx => {
    await ensureAndLockExportSlot(tx);
    const jobRows = await tx.$queryRaw<Array<{ id: string }>>`
      UPDATE "Job" AS job SET "status" = 'FAILED', "finishedAt" = clock_timestamp(), "errorCode" = ${errorCode}, "updatedAt" = clock_timestamp()
      WHERE job."id" = ${claim.jobId} AND job."ownerUserId" = ${claim.ownerUserId} AND job."analysisId" = ${claim.analysisId}
        AND job."exportId" = ${claim.exportId} AND job."type" = 'EXPORT' AND job."status" = 'RUNNING'
        AND job."attempt" = ${claim.attempt} AND job."leaseExpiresAt" > clock_timestamp()
        AND EXISTS (SELECT 1 FROM "Export" AS export WHERE export."id" = job."exportId"
          AND export."ownerUserId" = job."ownerUserId" AND export."analysisId" = job."analysisId"
          AND export."format"::text = ${claim.format})
        AND EXISTS (SELECT 1 FROM "WorkerSlot" AS slot WHERE slot."slotKey" = ${EXPORT_SLOT} AND slot."jobId" = job."id"
          AND slot."ownerUserId" = job."ownerUserId" AND slot."leaseTokenHash" = ${leaseTokenHash} AND slot."leaseUntil" > clock_timestamp())
      RETURNING job."id"
    `;
    if (jobRows.length === 0) return false;
    if (jobRows.length !== 1) throw new ExportQueueInvariantError();
    const exportRows = await tx.$queryRaw<Array<{ id: string }>>`
      UPDATE "Export" AS export SET "status" = 'FAILED', "errorCode" = ${errorCode}, "updatedAt" = clock_timestamp()
      WHERE export."id" = ${claim.exportId} AND export."ownerUserId" = ${claim.ownerUserId} AND export."analysisId" = ${claim.analysisId}
        AND export."format"::text = ${claim.format} AND export."status" = 'GENERATING'
        AND export."documentHash" = ${claim.documentHash} AND export."rendererVersion" = ${claim.rendererVersion}
        AND EXISTS (SELECT 1 FROM "Job" AS job WHERE job."id" = ${claim.jobId} AND job."ownerUserId" = ${claim.ownerUserId}
          AND job."exportId" = export."id" AND job."status" = 'FAILED' AND job."attempt" = ${claim.attempt}
          AND job."leaseExpiresAt" > clock_timestamp())
      RETURNING export."id"
    `;
    if (exportRows.length !== 1) throw new ExportQueueInvariantError();
    const releaseRows = await tx.$queryRaw<Array<{ slotKey: string }>>`
      UPDATE "WorkerSlot" AS slot SET "jobId" = NULL, "ownerUserId" = NULL, "leaseUntil" = NULL, "heartbeatAt" = NULL,
        "leaseTokenHash" = NULL, "updatedAt" = clock_timestamp()
      WHERE slot."slotKey" = ${EXPORT_SLOT} AND slot."jobId" = ${claim.jobId} AND slot."ownerUserId" = ${claim.ownerUserId}
        AND slot."leaseTokenHash" = ${leaseTokenHash} AND slot."leaseUntil" > clock_timestamp()
        AND EXISTS (SELECT 1 FROM "Job" AS job WHERE job."id" = ${claim.jobId} AND job."ownerUserId" = ${claim.ownerUserId}
          AND job."exportId" = ${claim.exportId} AND job."attempt" = ${claim.attempt} AND job."leaseExpiresAt" > clock_timestamp()
          AND EXISTS (SELECT 1 FROM "Export" AS export WHERE export."id" = job."exportId"
            AND export."ownerUserId" = job."ownerUserId" AND export."format"::text = ${claim.format}))
      RETURNING slot."slotKey"
    `;
    if (releaseRows.length !== 1) throw new ExportQueueInvariantError();
    return true;
  });
}

/** Publish the checksum-backed file only if this exact lease still owns the export slot. */
export async function completeExportJob(db: PrismaClient, inputClaim: ExportJobClaim, input: {
  storageKey: string; contentHash: string; byteLength: number;
}): Promise<{ storageObjectId: string } | null> {
  const claim = snapshotExportJobClaim(inputClaim);
  const extension = claim.format === "PDF" ? "pdf" : "md";
  const storageKeyPattern = new RegExp(`^export-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\/document\\.${extension}$`);
  if (typeof input.storageKey !== "string" || !storageKeyPattern.test(input.storageKey)) throw new Error("Export storage key is invalid.");
  const contentHash = validateDocumentHash(input.contentHash);
  if (!Number.isSafeInteger(input.byteLength) || input.byteLength < 0) throw new Error("Export file length is invalid.");
  const leaseTokenHash = sha256(claim.leaseToken);

  return db.$transaction(async tx => {
    await ensureAndLockExportSlot(tx);
    const active = await tx.$queryRaw<Array<{ active: boolean }>>`
      SELECT EXISTS (SELECT 1 FROM "WorkerSlot" AS slot JOIN "Job" AS job ON job."id" = slot."jobId" AND job."ownerUserId" = slot."ownerUserId"
        JOIN "Export" AS export ON export."id" = job."exportId" AND export."ownerUserId" = job."ownerUserId"
        WHERE slot."slotKey" = ${EXPORT_SLOT} AND slot."jobId" = ${claim.jobId} AND slot."ownerUserId" = ${claim.ownerUserId}
          AND slot."leaseTokenHash" = ${leaseTokenHash} AND slot."leaseUntil" > clock_timestamp()
          AND job."analysisId" = ${claim.analysisId} AND job."exportId" = ${claim.exportId} AND job."type" = 'EXPORT'
          AND job."status" = 'RUNNING' AND job."attempt" = ${claim.attempt} AND job."leaseExpiresAt" > clock_timestamp()
          AND export."status" = 'GENERATING' AND export."documentHash" = ${claim.documentHash}
          AND export."format"::text = ${claim.format} AND export."rendererVersion" = ${claim.rendererVersion}) AS "active"
    `;
    if (!active[0]?.active) return null;

    const storage = await tx.storageObject.create({ data: {
      ownerUserId: claim.ownerUserId,
      analysisId: claim.analysisId,
      type: "EXPORT",
      storageKey: input.storageKey,
      sha256: contentHash,
      byteLength: BigInt(input.byteLength),
    }, select: { id: true } });
    const exportRows = await tx.$queryRaw<Array<{ id: string }>>`
      UPDATE "Export" AS export SET "status" = 'READY', "storageObjectId" = ${storage.id}, "contentHash" = ${contentHash},
        "errorCode" = NULL, "readyAt" = clock_timestamp(), "updatedAt" = clock_timestamp()
      WHERE export."id" = ${claim.exportId} AND export."ownerUserId" = ${claim.ownerUserId} AND export."analysisId" = ${claim.analysisId}
        AND export."format"::text = ${claim.format} AND export."status" = 'GENERATING'
        AND export."documentHash" = ${claim.documentHash} AND export."rendererVersion" = ${claim.rendererVersion}
      RETURNING export."id"
    `;
    if (exportRows.length !== 1) throw new ExportQueueInvariantError();
    const jobRows = await tx.$queryRaw<Array<{ id: string }>>`
      UPDATE "Job" AS job SET "status" = 'COMPLETED', "finishedAt" = clock_timestamp(), "errorCode" = NULL, "updatedAt" = clock_timestamp()
      WHERE job."id" = ${claim.jobId} AND job."ownerUserId" = ${claim.ownerUserId} AND job."analysisId" = ${claim.analysisId}
        AND job."exportId" = ${claim.exportId} AND job."type" = 'EXPORT' AND job."status" = 'RUNNING' AND job."attempt" = ${claim.attempt}
        AND EXISTS (SELECT 1 FROM "Export" AS export WHERE export."id" = job."exportId"
          AND export."ownerUserId" = job."ownerUserId" AND export."analysisId" = job."analysisId"
          AND export."format"::text = ${claim.format})
        AND job."leaseExpiresAt" > clock_timestamp() AND EXISTS (SELECT 1 FROM "WorkerSlot" AS slot
          WHERE slot."slotKey" = ${EXPORT_SLOT} AND slot."jobId" = job."id" AND slot."ownerUserId" = job."ownerUserId"
            AND slot."leaseTokenHash" = ${leaseTokenHash} AND slot."leaseUntil" > clock_timestamp())
      RETURNING job."id"
    `;
    if (jobRows.length !== 1) throw new ExportQueueInvariantError();
    const releaseRows = await tx.$queryRaw<Array<{ slotKey: string }>>`
      UPDATE "WorkerSlot" AS slot SET "jobId" = NULL, "ownerUserId" = NULL, "leaseUntil" = NULL, "heartbeatAt" = NULL,
        "leaseTokenHash" = NULL, "updatedAt" = clock_timestamp()
      WHERE slot."slotKey" = ${EXPORT_SLOT} AND slot."jobId" = ${claim.jobId} AND slot."ownerUserId" = ${claim.ownerUserId}
        AND slot."leaseTokenHash" = ${leaseTokenHash}
        AND EXISTS (SELECT 1 FROM "Job" AS job WHERE job."id" = ${claim.jobId} AND job."ownerUserId" = ${claim.ownerUserId}
          AND job."exportId" = ${claim.exportId} AND job."attempt" = ${claim.attempt}
          AND EXISTS (SELECT 1 FROM "Export" AS export WHERE export."id" = job."exportId"
            AND export."ownerUserId" = job."ownerUserId" AND export."format"::text = ${claim.format}))
      RETURNING slot."slotKey"
    `;
    if (releaseRows.length !== 1) throw new ExportQueueInvariantError();
    return { storageObjectId: storage.id };
  });
}
