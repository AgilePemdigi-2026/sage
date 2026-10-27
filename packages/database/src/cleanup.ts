import { createHash, randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "../generated/client.ts";
import type { AnalysisJobClaim } from "./queue.ts";
import type { ExportJobClaim } from "./exports.ts";

const EXPORT_SLOT = "export";
const CLEANUP_SLOT = "cleanup";
const DEFAULT_LEASE_DURATION_MS = 30_000;
const MIN_LEASE_DURATION_MS = 1_000;
const MAX_LEASE_DURATION_MS = 300_000;
const MAX_STORAGE_RESERVATIONS = 32;

export type CleanupStatus = "QUEUED" | "RUNNING" | "FAILED" | "COMPLETED";
export interface CleanupSnapshot {
  jobId: string;
  analysisId: string;
  status: CleanupStatus;
  errorCode: string | null;
}
export interface CleanupManifestItem {
  readonly storageObjectId: string | null;
  readonly storageKey: string;
}
export interface CleanupJobClaim {
  jobId: string;
  analysisId: string;
  ownerUserId: string;
  attempt: number;
  leaseToken: string;
  leaseExpiresAt: Date;
  manifest: readonly CleanupManifestItem[];
}
export type JobStorageReservationClaim = Pick<AnalysisJobClaim, "jobId" | "analysisId" | "ownerUserId" | "attempt" | "leaseToken">
  | Pick<ExportJobClaim, "jobId" | "analysisId" | "ownerUserId" | "attempt" | "leaseToken">;

export class AnalysisDeletionNotFoundError extends Error {
  constructor() {
    super("Analysis was not found for this owner.");
    this.name = "AnalysisDeletionNotFoundError";
  }
}

export class AnalysisDeletionActiveError extends Error {
  readonly code: "ANALYSIS_ACTIVE" | "EXPORT_ACTIVE";
  constructor(code: "ANALYSIS_ACTIVE" | "EXPORT_ACTIVE") {
    super(code === "ANALYSIS_ACTIVE" ? "Analysis is still active." : "An export is still active.");
    this.name = "AnalysisDeletionActiveError";
    this.code = code;
  }
}

export class CleanupQueueInvariantError extends Error {
  constructor() {
    super("Cleanup queue state is inconsistent.");
    this.name = "CleanupQueueInvariantError";
  }
}

class CleanupLeaseLostError extends Error {}

function requireNonEmpty(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required.`);
}

function validateLeaseDuration(value: unknown): number {
  if (value === undefined) return DEFAULT_LEASE_DURATION_MS;
  if (!Number.isSafeInteger(value) || (value as number) < MIN_LEASE_DURATION_MS || (value as number) > MAX_LEASE_DURATION_MS) {
    throw new Error(`Lease duration must be ${MIN_LEASE_DURATION_MS}–${MAX_LEASE_DURATION_MS} milliseconds.`);
  }
  return value as number;
}

function validStorageKey(value: unknown): value is string {
  return typeof value === "string" && (
    /^snapshot-[A-Za-z0-9]{6}\/archive\.tar\.gz$/.test(value) ||
    /^export-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/document\.(?:md|pdf)(?:\.pending)?$/.test(value)
  );
}

function parseManifest(value: unknown): CleanupManifestItem[] {
  if (!Array.isArray(value)) throw new CleanupQueueInvariantError();
  const manifest: CleanupManifestItem[] = [];
  const keys = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw new CleanupQueueInvariantError();
    const record = entry as Record<string, unknown>;
    if (Reflect.ownKeys(record).length !== 2 || !Object.hasOwn(record, "storageObjectId") || !Object.hasOwn(record, "storageKey") ||
        (record.storageObjectId !== null && (typeof record.storageObjectId !== "string" || !record.storageObjectId.trim())) ||
        !validStorageKey(record.storageKey) || keys.has(record.storageKey)) throw new CleanupQueueInvariantError();
    keys.add(record.storageKey);
    manifest.push({ storageObjectId: record.storageObjectId as string | null, storageKey: record.storageKey });
  }
  return manifest.sort((left, right) => left.storageKey.localeCompare(right.storageKey));
}

function manifestJson(manifest: readonly CleanupManifestItem[]): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(manifest)) as Prisma.InputJsonValue;
}

function snapshot(row: { id: string; analysisId: string | null; cleanupAnalysisId: string | null; status: string; errorCode: string | null }): CleanupSnapshot {
  const analysisId = row.analysisId ?? row.cleanupAnalysisId;
  if (!analysisId || !["QUEUED", "RUNNING", "FAILED", "COMPLETED"].includes(row.status)) throw new CleanupQueueInvariantError();
  return { jobId: row.id, analysisId, status: row.status as CleanupStatus, errorCode: row.errorCode };
}

async function ensureAndLockExportSlot(tx: Prisma.TransactionClient): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO "WorkerSlot" ("slotKey", "updatedAt", "lastEnqueueSequence")
    VALUES (${EXPORT_SLOT}, clock_timestamp(), COALESCE((SELECT MAX("queueSequence") FROM "Job" WHERE "type" = 'EXPORT'), 0))
    ON CONFLICT ("slotKey") DO NOTHING
  `;
  const rows = await tx.$queryRaw<Array<{ slotKey: string }>>`
    SELECT "slotKey" FROM "WorkerSlot" WHERE "slotKey" = ${EXPORT_SLOT} FOR UPDATE
  `;
  if (rows.length !== 1) throw new CleanupQueueInvariantError();
}

async function ensureAndLockCleanupSlot(tx: Prisma.TransactionClient): Promise<{
  jobId: string | null; ownerUserId: string | null; leaseUntil: Date | null; leaseTokenHash: string | null;
}> {
  await tx.$executeRaw`
    INSERT INTO "WorkerSlot" ("slotKey", "updatedAt", "lastEnqueueSequence")
    VALUES (${CLEANUP_SLOT}, clock_timestamp(), 0)
    ON CONFLICT ("slotKey") DO NOTHING
  `;
  const rows = await tx.$queryRaw<Array<{
    jobId: string | null; ownerUserId: string | null; leaseUntil: Date | null; leaseTokenHash: string | null;
  }>>`
    SELECT "jobId", "ownerUserId", "leaseUntil", "leaseTokenHash"
    FROM "WorkerSlot" WHERE "slotKey" = ${CLEANUP_SLOT} FOR UPDATE
  `;
  if (rows.length !== 1) throw new CleanupQueueInvariantError();
  return rows[0];
}

async function findCleanupJob(tx: Prisma.TransactionClient, ownerUserId: string, analysisId: string) {
  return tx.job.findFirst({
    where: { ownerUserId, type: "CLEANUP", cleanupAnalysisId: analysisId },
    select: { id: true, analysisId: true, cleanupAnalysisId: true, status: true, errorCode: true, cleanupManifest: true },
  });
}

function reservationList(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_STORAGE_RESERVATIONS ||
      value.some(item => !validStorageKey(item)) || new Set(value).size !== value.length) throw new CleanupQueueInvariantError();
  return [...value] as string[];
}

async function collectManifest(tx: Prisma.TransactionClient, ownerUserId: string, analysisId: string): Promise<CleanupManifestItem[]> {
  const objects = await tx.storageObject.findMany({
    where: { ownerUserId, analysisId },
    select: { id: true, storageKey: true },
  });
  const byKey = new Map<string, string | null>();
  for (const object of objects) {
    if (!validStorageKey(object.storageKey)) throw new CleanupQueueInvariantError();
    if (byKey.has(object.storageKey)) throw new CleanupQueueInvariantError();
    byKey.set(object.storageKey, object.id);
  }
  const jobs = await tx.job.findMany({
    where: { ownerUserId, analysisId, type: { in: ["ANALYSIS", "EXPORT"] } },
    select: { storageReservations: true },
  });
  for (const job of jobs) {
    for (const key of reservationList(job.storageReservations)) if (!byKey.has(key)) byKey.set(key, null);
  }
  return [...byKey].map(([storageKey, storageObjectId]) => ({ storageObjectId, storageKey }))
    .sort((left, right) => left.storageKey.localeCompare(right.storageKey));
}

/** Tombstone an inactive analysis and enqueue its owner-scoped durable cleanup job atomically. */
export async function requestAnalysisDeletion(db: PrismaClient, ownerUserId: string, analysisId: string): Promise<CleanupSnapshot> {
  requireNonEmpty(ownerUserId, "Owner ID");
  requireNonEmpty(analysisId, "Analysis ID");
  return db.$transaction(async tx => {
    // Export enqueue/retry locks this slot before it locks the Analysis row.
    await ensureAndLockExportSlot(tx);
    const analyses = await tx.$queryRaw<Array<{ id: string; status: string; deletionRequestedAt: Date | null }>>`
      SELECT "id", "status"::text AS "status", "deletionRequestedAt"
      FROM "Analysis" WHERE "id" = ${analysisId} AND "ownerUserId" = ${ownerUserId} FOR UPDATE
    `;
    const analysis = analyses[0];
    if (!analysis) {
      const completed = await findCleanupJob(tx, ownerUserId, analysisId);
      if (completed?.status === "COMPLETED") return snapshot(completed);
      throw new AnalysisDeletionNotFoundError();
    }

    const existing = await findCleanupJob(tx, ownerUserId, analysisId);
    if (analysis.deletionRequestedAt) {
      if (!existing) throw new CleanupQueueInvariantError();
      if (existing.status === "FAILED") {
        parseManifest(existing.cleanupManifest);
        const changed = await tx.$executeRaw`
          UPDATE "Job" SET "status" = 'QUEUED', "errorCode" = NULL, "finishedAt" = NULL,
            "startedAt" = NULL, "leaseExpiresAt" = NULL, "heartbeatAt" = NULL,
            "enqueuedAt" = clock_timestamp(), "updatedAt" = clock_timestamp()
          WHERE "id" = ${existing.id} AND "ownerUserId" = ${ownerUserId} AND "type" = 'CLEANUP' AND "status" = 'FAILED'
        `;
        if (changed !== 1) {
          const current = await findCleanupJob(tx, ownerUserId, analysisId);
          if (!current) throw new CleanupQueueInvariantError();
          return snapshot(current);
        }
        await tx.$executeRaw`
          UPDATE "StorageObject" SET "status" = 'DELETION_PENDING', "updatedAt" = clock_timestamp()
          WHERE "ownerUserId" = ${ownerUserId} AND "analysisId" = ${analysisId} AND "status" <> 'DELETED'
        `;
        return { jobId: existing.id, analysisId, status: "QUEUED", errorCode: null };
      }
      return snapshot(existing);
    }

    if (analysis.status === "QUEUED" || analysis.status === "RUNNING") throw new AnalysisDeletionActiveError("ANALYSIS_ACTIVE");
    const active = await tx.$queryRaw<Array<{ analysisActive: boolean; exportActive: boolean }>>`
      SELECT
        EXISTS (SELECT 1 FROM "Job" WHERE "ownerUserId" = ${ownerUserId} AND "analysisId" = ${analysisId}
          AND "type" = 'ANALYSIS' AND "status" IN ('QUEUED', 'RUNNING')) AS "analysisActive",
        (EXISTS (SELECT 1 FROM "Job" WHERE "ownerUserId" = ${ownerUserId} AND "analysisId" = ${analysisId}
          AND "type" = 'EXPORT' AND "status" IN ('QUEUED', 'RUNNING'))
        OR EXISTS (SELECT 1 FROM "Export" WHERE "ownerUserId" = ${ownerUserId} AND "analysisId" = ${analysisId}
          AND "status" IN ('QUEUED', 'GENERATING'))) AS "exportActive"
    `;
    if (active[0]?.analysisActive) throw new AnalysisDeletionActiveError("ANALYSIS_ACTIVE");
    if (active[0]?.exportActive) throw new AnalysisDeletionActiveError("EXPORT_ACTIVE");
    if (existing) throw new CleanupQueueInvariantError();

    const manifest = await collectManifest(tx, ownerUserId, analysisId);
    const job = await tx.job.create({
      data: {
        ownerUserId,
        analysisId,
        cleanupAnalysisId: analysisId,
        cleanupManifest: manifestJson(manifest),
        type: "CLEANUP",
      },
      select: { id: true, analysisId: true, cleanupAnalysisId: true, status: true, errorCode: true },
    });
    await tx.$executeRaw`
      UPDATE "StorageObject" SET "status" = 'DELETION_PENDING', "updatedAt" = clock_timestamp()
      WHERE "ownerUserId" = ${ownerUserId} AND "analysisId" = ${analysisId} AND "status" <> 'DELETED'
    `;
    const tombstone = await tx.$executeRaw`
      UPDATE "Analysis" SET "deletionRequestedAt" = clock_timestamp(), "updatedAt" = clock_timestamp()
      WHERE "id" = ${analysisId} AND "ownerUserId" = ${ownerUserId} AND "deletionRequestedAt" IS NULL
    `;
    if (tombstone !== 1) throw new CleanupQueueInvariantError();
    await tx.$executeRaw`UPDATE "Job" SET "enqueuedAt" = clock_timestamp() WHERE "id" = ${job.id}`;
    return snapshot(job);
  });
}

/** Read a cleanup job by both owner and job ID; cleanupAnalysisId survives analysis removal. */
export async function findCleanupJobForUser(db: PrismaClient, ownerUserId: string, jobId: string): Promise<CleanupSnapshot | null> {
  requireNonEmpty(ownerUserId, "Owner ID");
  requireNonEmpty(jobId, "Job ID");
  const row = await db.job.findFirst({
    where: { id: jobId, ownerUserId, type: "CLEANUP" },
    select: { id: true, analysisId: true, cleanupAnalysisId: true, status: true, errorCode: true },
  });
  return row ? snapshot(row) : null;
}

function snapshotReservationClaim(input: JobStorageReservationClaim): JobStorageReservationClaim {
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new Error("Worker claim is invalid.");
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) throw new Error("Worker claim must be a plain object.");
  const descriptors = Object.getOwnPropertyDescriptors(input);
  for (const field of ["jobId", "analysisId", "ownerUserId", "attempt", "leaseToken"] as const) {
    const descriptor = descriptors[field];
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) throw new Error("Worker claim must contain plain data properties.");
  }
  const claim = {
    jobId: descriptors.jobId.value,
    analysisId: descriptors.analysisId.value,
    ownerUserId: descriptors.ownerUserId.value,
    attempt: descriptors.attempt.value,
    leaseToken: descriptors.leaseToken.value,
  };
  requireNonEmpty(claim.jobId, "Job ID");
  requireNonEmpty(claim.analysisId, "Analysis ID");
  requireNonEmpty(claim.ownerUserId, "Owner ID");
  if (!Number.isSafeInteger(claim.attempt) || (claim.attempt as number) < 1 ||
      typeof claim.leaseToken !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(claim.leaseToken)) {
    throw new Error("Worker claim is invalid.");
  }
  return claim as JobStorageReservationClaim;
}

/** Reserve a generated snapshot/export key before writing it, fenced by its current worker lease. */
export async function reserveJobStorage(db: PrismaClient, inputClaim: JobStorageReservationClaim, storageKey: string): Promise<boolean> {
  const claim = snapshotReservationClaim(inputClaim);
  if (!validStorageKey(storageKey)) throw new Error("Storage key is invalid.");
  const tokenHash = createHash("sha256").update(claim.leaseToken, "utf8").digest("hex");
  return db.$transaction(async tx => {
    const leaseRows = await tx.$queryRaw<Array<{ slotKey: string; jobType: string; reservations: unknown }>>`
      SELECT slot."slotKey", job."type"::text AS "jobType", job."storageReservations" AS "reservations"
      FROM "WorkerSlot" AS slot
      JOIN "Job" AS job ON job."id" = slot."jobId" AND job."ownerUserId" = slot."ownerUserId"
      JOIN "Analysis" AS analysis ON analysis."id" = job."analysisId" AND analysis."ownerUserId" = job."ownerUserId"
      WHERE slot."slotKey" IN ('analysis', 'export') AND slot."jobId" = ${claim.jobId}
        AND slot."ownerUserId" = ${claim.ownerUserId} AND slot."leaseTokenHash" = ${tokenHash}
        AND slot."leaseUntil" > clock_timestamp()
        AND job."analysisId" = ${claim.analysisId} AND job."attempt" = ${claim.attempt}
        AND job."status" = 'RUNNING' AND job."leaseExpiresAt" > clock_timestamp()
        AND job."type" IN ('ANALYSIS', 'EXPORT') AND analysis."deletionRequestedAt" IS NULL
        AND slot."slotKey" = CASE job."type" WHEN 'ANALYSIS' THEN 'analysis' ELSE 'export' END
      FOR UPDATE OF slot
    `;
    if (leaseRows.length !== 1) return false;
    const { slotKey, jobType } = leaseRows[0];
    const analysisRows = await tx.$queryRaw<Array<{ deletionRequestedAt: Date | null }>>`
      SELECT "deletionRequestedAt" FROM "Analysis" WHERE "id" = ${claim.analysisId}
        AND "ownerUserId" = ${claim.ownerUserId} FOR SHARE
    `;
    if (analysisRows.length !== 1 || analysisRows[0].deletionRequestedAt !== null) return false;
    if ((jobType === "ANALYSIS" && slotKey !== "analysis") || (jobType === "EXPORT" && slotKey !== "export")) return false;

    const current = reservationList(leaseRows[0].reservations);
    if (current.includes(storageKey)) return true;
    if (current.length >= MAX_STORAGE_RESERVATIONS) throw new CleanupQueueInvariantError();
    const updated = await tx.job.updateMany({
      where: { id: claim.jobId, ownerUserId: claim.ownerUserId, analysisId: claim.analysisId, type: jobType as "ANALYSIS" | "EXPORT", status: "RUNNING", attempt: claim.attempt },
      data: { storageReservations: [...current, storageKey] },
    });
    if (updated.count !== 1) return false;
    const stillActive = await tx.$queryRaw<Array<{ active: boolean }>>`
      SELECT EXISTS (SELECT 1 FROM "WorkerSlot" AS slot JOIN "Job" AS job
        ON job."id" = slot."jobId" AND job."ownerUserId" = slot."ownerUserId"
        JOIN "Analysis" AS analysis ON analysis."id" = job."analysisId" AND analysis."ownerUserId" = job."ownerUserId"
        WHERE slot."slotKey" = ${slotKey} AND slot."jobId" = ${claim.jobId} AND slot."ownerUserId" = ${claim.ownerUserId}
          AND slot."leaseTokenHash" = ${tokenHash} AND slot."leaseUntil" > clock_timestamp()
          AND job."status" = 'RUNNING' AND job."attempt" = ${claim.attempt} AND job."leaseExpiresAt" > clock_timestamp()
          AND analysis."deletionRequestedAt" IS NULL) AS "active"
    `;
    if (stillActive[0]?.active !== true) throw new CleanupLeaseLostError();
    return true;
  }).catch(error => {
    if (error instanceof CleanupLeaseLostError) return false;
    throw error;
  });
}

type CleanupClaimInput = Pick<CleanupJobClaim, "jobId" | "analysisId" | "ownerUserId" | "attempt" | "leaseToken" | "leaseExpiresAt"> & { manifest?: unknown };

export function snapshotCleanupJobClaim(input: CleanupClaimInput): CleanupJobClaim {
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new Error("Cleanup claim is invalid.");
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) throw new Error("Cleanup claim must be a plain object.");
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const fields = ["jobId", "analysisId", "ownerUserId", "attempt", "leaseToken", "leaseExpiresAt", "manifest"] as const;
  if (Reflect.ownKeys(input).length !== fields.length || Reflect.ownKeys(input).some(key => typeof key !== "string" || !fields.includes(key as typeof fields[number]))) throw new Error("Cleanup claim contains invalid fields.");
  for (const field of fields) {
    const descriptor = descriptors[field];
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) throw new Error("Cleanup claim must contain plain data properties.");
  }
  const rawExpiry = descriptors.leaseExpiresAt.value;
  const milliseconds = rawExpiry instanceof Date ? Date.prototype.getTime.call(rawExpiry) as number : typeof rawExpiry === "string" ? Date.parse(rawExpiry) : Number.NaN;
  if (!Number.isFinite(milliseconds)) throw new Error("Cleanup lease expiry is invalid.");
  const manifest = parseManifest((descriptors.manifest as PropertyDescriptor).value).map(entry => Object.freeze(entry));
  const claim = Object.freeze({
    jobId: descriptors.jobId.value as string,
    analysisId: descriptors.analysisId.value as string,
    ownerUserId: descriptors.ownerUserId.value as string,
    attempt: descriptors.attempt.value as number,
    leaseToken: descriptors.leaseToken.value as string,
    leaseExpiresAt: new Date(milliseconds),
    manifest: Object.freeze(manifest),
  });
  requireNonEmpty(claim.jobId, "Job ID");
  requireNonEmpty(claim.analysisId, "Analysis ID");
  requireNonEmpty(claim.ownerUserId, "Owner ID");
  if (!Number.isSafeInteger(claim.attempt) || claim.attempt < 1 || typeof claim.leaseToken !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(claim.leaseToken)) throw new Error("Cleanup claim is invalid.");
  return claim;
}

async function currentCleanupClaim(tx: Prisma.TransactionClient, claim: CleanupJobClaim, tokenHash: string, lock: boolean): Promise<boolean> {
  const suffix = lock ? Prisma.sql`FOR UPDATE OF slot` : Prisma.empty;
  const rows = await tx.$queryRaw<Array<{ manifest: unknown }>>`
    SELECT job."cleanupManifest" AS "manifest" FROM "WorkerSlot" AS slot JOIN "Job" AS job
        ON job."id" = slot."jobId" AND job."ownerUserId" = slot."ownerUserId"
      JOIN "Analysis" AS analysis ON analysis."id" = job."analysisId" AND analysis."ownerUserId" = job."ownerUserId"
      WHERE slot."slotKey" = ${CLEANUP_SLOT} AND slot."jobId" = ${claim.jobId} AND slot."ownerUserId" = ${claim.ownerUserId}
        AND slot."leaseTokenHash" = ${tokenHash} AND slot."leaseUntil" > clock_timestamp()
        AND job."id" = ${claim.jobId} AND job."analysisId" = ${claim.analysisId} AND job."cleanupAnalysisId" = ${claim.analysisId}
        AND job."ownerUserId" = ${claim.ownerUserId} AND job."type" = 'CLEANUP' AND job."status" = 'RUNNING'
        AND job."attempt" = ${claim.attempt} AND job."leaseExpiresAt" > clock_timestamp()
        AND analysis."deletionRequestedAt" IS NOT NULL
    ${suffix}
  `;
  if (rows.length !== 1) return false;
  const persisted = parseManifest(rows[0].manifest);
  return persisted.length === claim.manifest.length && persisted.every((entry, index) =>
    entry.storageObjectId === claim.manifest[index].storageObjectId && entry.storageKey === claim.manifest[index].storageKey);
}

async function releaseCleanupSlot(tx: Prisma.TransactionClient, claim: CleanupJobClaim, tokenHash: string, completed: boolean): Promise<void> {
  const rows = await tx.$queryRaw<Array<{ slotKey: string }>>`
    UPDATE "WorkerSlot" AS slot
    SET "jobId" = NULL, "ownerUserId" = NULL, "leaseUntil" = NULL, "heartbeatAt" = NULL,
        "leaseTokenHash" = NULL, "updatedAt" = clock_timestamp()
    WHERE slot."slotKey" = ${CLEANUP_SLOT} AND slot."jobId" = ${claim.jobId} AND slot."ownerUserId" = ${claim.ownerUserId}
      AND slot."leaseTokenHash" = ${tokenHash} AND slot."leaseUntil" > clock_timestamp()
      AND EXISTS (SELECT 1 FROM "Job" AS job WHERE job."id" = ${claim.jobId} AND job."ownerUserId" = ${claim.ownerUserId}
        AND job."type" = 'CLEANUP' AND job."attempt" = ${claim.attempt}
        AND job."status" = ${completed ? "COMPLETED" : "FAILED"}
        AND job."leaseExpiresAt" > clock_timestamp())
    RETURNING slot."slotKey"
  `;
  if (rows.length !== 1) throw new CleanupLeaseLostError();
}

/** Claim the oldest deletion job, recovering an expired cleanup lease before starting new work. */
export async function claimCleanupJob(db: PrismaClient, options: { leaseDurationMs?: number } = {}): Promise<CleanupJobClaim | null> {
  const leaseDurationMs = validateLeaseDuration(options.leaseDurationMs);
  return db.$transaction(async tx => {
    const slot = await ensureAndLockCleanupSlot(tx);
    if (slot.jobId !== null) {
      if (!slot.ownerUserId || !slot.leaseUntil || !slot.leaseTokenHash) throw new CleanupQueueInvariantError();
      const occupied = await tx.$queryRaw<Array<{ type: string; status: string; attempt: number; leaseExpiresAt: Date | null }>>`
        SELECT job."type"::text AS "type", job."status"::text AS "status", job."attempt", job."leaseExpiresAt"
        FROM "Job" AS job WHERE job."id" = ${slot.jobId} AND job."ownerUserId" = ${slot.ownerUserId}
      `;
      if (occupied.length !== 1 || occupied[0].type !== "CLEANUP" || occupied[0].status !== "RUNNING" || !occupied[0].leaseExpiresAt) throw new CleanupQueueInvariantError();
      const expired = await tx.$queryRaw<Array<{ expired: boolean }>>`
        SELECT (${slot.leaseUntil} <= clock_timestamp() OR ${occupied[0].leaseExpiresAt} <= clock_timestamp()) AS "expired"
      `;
      if (expired[0]?.expired !== true) return null;
      const failed = await tx.$executeRaw`
        UPDATE "Job" SET "status" = 'FAILED', "finishedAt" = clock_timestamp(), "errorCode" = 'WORKER_INTERRUPTED',
          "leaseExpiresAt" = NULL, "heartbeatAt" = NULL, "updatedAt" = clock_timestamp()
        WHERE "id" = ${slot.jobId} AND "ownerUserId" = ${slot.ownerUserId} AND "type" = 'CLEANUP'
          AND "status" = 'RUNNING' AND "attempt" = ${occupied[0].attempt}
          AND EXISTS (SELECT 1 FROM "WorkerSlot" AS current_slot JOIN "Job" AS current_job
            ON current_job."id" = current_slot."jobId" AND current_job."ownerUserId" = current_slot."ownerUserId"
            WHERE current_slot."slotKey" = ${CLEANUP_SLOT}
            AND current_slot."jobId" = ${slot.jobId} AND current_slot."ownerUserId" = ${slot.ownerUserId}
            AND current_slot."leaseTokenHash" = ${slot.leaseTokenHash}
            AND current_job."id" = ${slot.jobId} AND current_job."ownerUserId" = ${slot.ownerUserId}
            AND (current_slot."leaseUntil" <= clock_timestamp() OR current_job."leaseExpiresAt" <= clock_timestamp()))
      `;
      if (failed !== 1) throw new CleanupQueueInvariantError();
      await tx.$executeRaw`
        UPDATE "WorkerSlot" SET "jobId" = NULL, "ownerUserId" = NULL, "leaseUntil" = NULL,
          "heartbeatAt" = NULL, "leaseTokenHash" = NULL, "updatedAt" = clock_timestamp()
        WHERE "slotKey" = ${CLEANUP_SLOT} AND "jobId" = ${slot.jobId} AND "ownerUserId" = ${slot.ownerUserId}
          AND "leaseTokenHash" = ${slot.leaseTokenHash}
      `;
    } else {
      const orphan = await tx.$queryRaw<Array<{ exists: boolean }>>`
        SELECT EXISTS (SELECT 1 FROM "Job" WHERE "type" = 'CLEANUP' AND "status" = 'RUNNING') AS "exists"
      `;
      if (orphan[0]?.exists) throw new CleanupQueueInvariantError();
    }

    const candidates = await tx.$queryRaw<Array<{ id: string; analysisId: string; ownerUserId: string; attempt: number; cleanupManifest: unknown }>>`
      SELECT job."id", job."analysisId", job."ownerUserId", job."attempt", job."cleanupManifest"
      FROM "Job" AS job JOIN "Analysis" AS analysis ON analysis."id" = job."analysisId" AND analysis."ownerUserId" = job."ownerUserId"
      WHERE job."type" = 'CLEANUP' AND job."status" = 'QUEUED' AND job."analysisId" IS NOT NULL
        AND job."cleanupAnalysisId" = job."analysisId" AND job."cleanupManifest" IS NOT NULL
        AND analysis."deletionRequestedAt" IS NOT NULL
      ORDER BY job."enqueuedAt", job."id" FOR UPDATE OF job SKIP LOCKED LIMIT 1
    `;
    const next = candidates[0];
    if (!next) return null;
    const manifest = parseManifest(next.cleanupManifest);
    const claimToken = randomUUID();
    const tokenHash = createHash("sha256").update(claimToken, "utf8").digest("hex");
    const jobs = await tx.$queryRaw<Array<{ attempt: number; leaseExpiresAt: Date }>>`
      UPDATE "Job" SET "status" = 'RUNNING', "startedAt" = COALESCE("startedAt", clock_timestamp()),
        "finishedAt" = NULL, "leaseExpiresAt" = clock_timestamp() + (${leaseDurationMs} * interval '1 millisecond'),
        "heartbeatAt" = clock_timestamp(), "attempt" = "attempt" + 1, "errorCode" = NULL, "updatedAt" = clock_timestamp()
      WHERE "id" = ${next.id} AND "ownerUserId" = ${next.ownerUserId} AND "type" = 'CLEANUP' AND "status" = 'QUEUED'
      RETURNING "attempt", "leaseExpiresAt" AS "leaseExpiresAt"
    `;
    if (jobs.length !== 1) throw new CleanupQueueInvariantError();
    const slots = await tx.$queryRaw<Array<{ jobId: string }>>`
      UPDATE "WorkerSlot" SET "jobId" = ${next.id}, "ownerUserId" = ${next.ownerUserId},
        "leaseUntil" = ${jobs[0].leaseExpiresAt}, "heartbeatAt" = clock_timestamp(),
        "leaseTokenHash" = ${tokenHash}, "updatedAt" = clock_timestamp()
      WHERE "slotKey" = ${CLEANUP_SLOT} AND "jobId" IS NULL AND "ownerUserId" IS NULL
        AND "leaseUntil" IS NULL AND "heartbeatAt" IS NULL AND "leaseTokenHash" IS NULL
      RETURNING "jobId"
    `;
    if (slots.length !== 1) throw new CleanupQueueInvariantError();
    return snapshotCleanupJobClaim({
      jobId: next.id,
      analysisId: next.analysisId,
      ownerUserId: next.ownerUserId,
      attempt: jobs[0].attempt,
      leaseToken: claimToken,
      leaseExpiresAt: jobs[0].leaseExpiresAt,
      manifest,
    });
  });
}

/** Renew a cleanup lease using the database clock; caller timestamps are informational only. */
export async function renewCleanupLease(db: PrismaClient, inputClaim: CleanupJobClaim): Promise<Date | null> {
  const claim = snapshotCleanupJobClaim(inputClaim);
  const tokenHash = createHash("sha256").update(claim.leaseToken, "utf8").digest("hex");
  try {
    return await db.$transaction(async tx => {
      if (!await currentCleanupClaim(tx, claim, tokenHash, true)) return null;
      const jobs = await tx.$queryRaw<Array<{ leaseExpiresAt: Date }>>`
        UPDATE "Job" SET "leaseExpiresAt" = clock_timestamp() + (${DEFAULT_LEASE_DURATION_MS} * interval '1 millisecond'),
          "heartbeatAt" = clock_timestamp(), "updatedAt" = clock_timestamp()
        WHERE "id" = ${claim.jobId} AND "ownerUserId" = ${claim.ownerUserId} AND "analysisId" = ${claim.analysisId}
          AND "type" = 'CLEANUP' AND "status" = 'RUNNING' AND "attempt" = ${claim.attempt}
          AND "leaseExpiresAt" > clock_timestamp() RETURNING "leaseExpiresAt"
      `;
      if (jobs.length !== 1) throw new CleanupLeaseLostError();
      const slots = await tx.$queryRaw<Array<{ leaseUntil: Date }>>`
        UPDATE "WorkerSlot" SET "leaseUntil" = ${jobs[0].leaseExpiresAt}, "heartbeatAt" = clock_timestamp(), "updatedAt" = clock_timestamp()
        WHERE "slotKey" = ${CLEANUP_SLOT} AND "jobId" = ${claim.jobId} AND "ownerUserId" = ${claim.ownerUserId}
          AND "leaseTokenHash" = ${tokenHash} AND "leaseUntil" > clock_timestamp() RETURNING "leaseUntil"
      `;
      if (slots.length !== 1) throw new CleanupLeaseLostError();
      return slots[0].leaseUntil;
    });
  } catch (error) {
    if (error instanceof CleanupLeaseLostError) return null;
    throw error;
  }
}

/** Mark a reserved object row deleted only while this exact cleanup attempt owns the lease. */
export async function markCleanupObjectDeleted(db: PrismaClient, inputClaim: CleanupJobClaim, storageObjectId: string): Promise<boolean> {
  const claim = snapshotCleanupJobClaim(inputClaim);
  requireNonEmpty(storageObjectId, "Storage object ID");
  if (!claim.manifest.some(entry => entry.storageObjectId === storageObjectId)) return false;
  const tokenHash = createHash("sha256").update(claim.leaseToken, "utf8").digest("hex");
  try {
    return await db.$transaction(async tx => {
      if (!await currentCleanupClaim(tx, claim, tokenHash, true)) return false;
      const rows = await tx.$queryRaw<Array<{ id: string }>>`
        UPDATE "StorageObject" SET "status" = 'DELETED', "deletedAt" = COALESCE("deletedAt", clock_timestamp()), "updatedAt" = clock_timestamp()
        WHERE "id" = ${storageObjectId} AND "analysisId" = ${claim.analysisId} AND "ownerUserId" = ${claim.ownerUserId}
          AND "status" IN ('DELETION_PENDING', 'DELETED') RETURNING "id"
      `;
      return rows.length === 1;
    });
  } catch (error) {
    if (error instanceof CleanupLeaseLostError) return false;
    throw error;
  }
}

/** Finalize cleanup only after every reserved path was removed and every registered object is DELETED. */
export async function completeCleanupJob(db: PrismaClient, inputClaim: CleanupJobClaim, removedKeys: readonly string[]): Promise<boolean> {
  const claim = snapshotCleanupJobClaim(inputClaim);
  if (!Array.isArray(removedKeys) || removedKeys.some(key => typeof key !== "string") ||
      new Set(removedKeys).size !== removedKeys.length) throw new Error("Removed storage keys are invalid.");
  const expectedKeys = claim.manifest.map(entry => entry.storageKey).sort();
  const actualKeys = [...removedKeys].sort();
  if (expectedKeys.length !== actualKeys.length || expectedKeys.some((key, index) => key !== actualKeys[index])) return false;
  const tokenHash = createHash("sha256").update(claim.leaseToken, "utf8").digest("hex");
  try {
    return await db.$transaction(async tx => {
      if (!await currentCleanupClaim(tx, claim, tokenHash, true)) return false;
      const pending = await tx.storageObject.count({
        where: { ownerUserId: claim.ownerUserId, analysisId: claim.analysisId, status: { not: "DELETED" } },
      });
      if (pending !== 0) return false;

      await tx.analysis.updateMany({ where: { ownerUserId: claim.ownerUserId, retryParentId: claim.analysisId }, data: { retryParentId: null } });
      await tx.job.deleteMany({
        where: { ownerUserId: claim.ownerUserId, analysisId: claim.analysisId, type: { not: "CLEANUP" } },
      });
      await tx.export.deleteMany({ where: { ownerUserId: claim.ownerUserId, analysisId: claim.analysisId } });
      await tx.sourceFile.deleteMany({ where: { ownerUserId: claim.ownerUserId, analysisId: claim.analysisId } });
      await tx.analysisStage.deleteMany({ where: { ownerUserId: claim.ownerUserId, analysisId: claim.analysisId } });
      await tx.analysisLimitation.deleteMany({ where: { ownerUserId: claim.ownerUserId, analysisId: claim.analysisId } });
      await tx.graphBundle.deleteMany({ where: { ownerUserId: claim.ownerUserId, analysisId: claim.analysisId } });
      await tx.architectureDocument.deleteMany({ where: { ownerUserId: claim.ownerUserId, analysisId: claim.analysisId } });
      await tx.storageObject.deleteMany({ where: { ownerUserId: claim.ownerUserId, analysisId: claim.analysisId, status: "DELETED" } });

      const completed = await tx.$queryRaw<Array<{ id: string }>>`
        UPDATE "Job" SET "analysisId" = NULL, "cleanupManifest" = NULL, "status" = 'COMPLETED',
          "errorCode" = NULL, "finishedAt" = clock_timestamp(), "updatedAt" = clock_timestamp()
        WHERE "id" = ${claim.jobId} AND "ownerUserId" = ${claim.ownerUserId} AND "analysisId" = ${claim.analysisId}
          AND "cleanupAnalysisId" = ${claim.analysisId} AND "type" = 'CLEANUP' AND "status" = 'RUNNING'
          AND "attempt" = ${claim.attempt} AND "leaseExpiresAt" > clock_timestamp()
          AND EXISTS (SELECT 1 FROM "WorkerSlot" WHERE "slotKey" = ${CLEANUP_SLOT} AND "jobId" = ${claim.jobId}
            AND "ownerUserId" = ${claim.ownerUserId} AND "leaseTokenHash" = ${tokenHash} AND "leaseUntil" > clock_timestamp())
        RETURNING "id"
      `;
      if (completed.length !== 1) throw new CleanupLeaseLostError();
      const deleted = await tx.$executeRaw`
        DELETE FROM "Analysis" WHERE "id" = ${claim.analysisId} AND "ownerUserId" = ${claim.ownerUserId}
          AND "deletionRequestedAt" IS NOT NULL
      `;
      if (deleted !== 1) throw new CleanupQueueInvariantError();
      await releaseCleanupSlot(tx, claim, tokenHash, true);
      return true;
    });
  } catch (error) {
    if (error instanceof CleanupLeaseLostError) return false;
    throw error;
  }
}

/** Fail the current attempt and release its lease; a later DELETE can requeue this same row. */
export async function failCleanupJob(db: PrismaClient, inputClaim: CleanupJobClaim): Promise<boolean> {
  const claim = snapshotCleanupJobClaim(inputClaim);
  const tokenHash = createHash("sha256").update(claim.leaseToken, "utf8").digest("hex");
  try {
    return await db.$transaction(async tx => {
      if (!await currentCleanupClaim(tx, claim, tokenHash, true)) return false;
      const rows = await tx.$queryRaw<Array<{ id: string }>>`
        UPDATE "Job" SET "status" = 'FAILED', "errorCode" = 'CLEANUP_FAILED', "finishedAt" = clock_timestamp(),
          "heartbeatAt" = NULL, "updatedAt" = clock_timestamp()
        WHERE "id" = ${claim.jobId} AND "ownerUserId" = ${claim.ownerUserId} AND "analysisId" = ${claim.analysisId}
          AND "type" = 'CLEANUP' AND "status" = 'RUNNING' AND "attempt" = ${claim.attempt}
          AND "leaseExpiresAt" > clock_timestamp() RETURNING "id"
      `;
      if (rows.length !== 1) throw new CleanupLeaseLostError();
      await releaseCleanupSlot(tx, claim, tokenHash, false);
      return true;
    });
  } catch (error) {
    if (error instanceof CleanupLeaseLostError) return false;
    throw error;
  }
}
