import { createHash, randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "../generated/client.ts";

const ANALYSIS_SLOT = "analysis";
const DEFAULT_LEASE_DURATION_MS = 30_000;
const MIN_LEASE_DURATION_MS = 1_000;
const MAX_LEASE_DURATION_MS = 300_000;
const MAX_CONFIGURATION_BYTES = 1_048_576;

export interface EnqueueAnalysisInput {
  ownerUserId: string;
  repositoryId: string;
  branchName: string;
  commitSha: string;
  configuration: unknown;
  analyzerVersion: string;
  schemaVersion: string;
  retryParentId?: string | null;
}

export interface EnqueuedAnalysis {
  analysisId: string;
  jobId: string;
  configurationHash: string;
}

/** Internal worker claim handle. Never expose this object through an HTTP response. */
export interface AnalysisJobClaim {
  jobId: string;
  analysisId: string;
  ownerUserId: string;
  attempt: number;
  leaseToken: string;
  leaseExpiresAt: Date;
}

export interface ClaimAnalysisJobOptions {
  leaseDurationMs?: number;
}

export interface RenewAnalysisLeaseOptions {
  leaseDurationMs?: number;
}

export class AnalysisQueueInvariantError extends Error {
  constructor() {
    super("Invariant antrean analisis tidak valid; claim baru ditolak agar status tidak rusak.");
    this.name = "AnalysisQueueInvariantError";
  }
}

type SlotRow = {
  jobId: string | null;
  ownerUserId: string | null;
  leaseUntil: Date | null;
  heartbeatAt: Date | null;
  leaseTokenHash: string | null;
  lastEnqueueSequence: bigint;
};

type SlotStateRow = SlotRow & {
  jobType: string | null;
  jobStatus: string | null;
  analysisId: string | null;
  jobOwnerUserId: string | null;
  analysisStatus: string | null;
  analysisOwnerUserId: string | null;
  attempt: number | null;
  jobLeaseExpiresAt: Date | null;
};

type QueueItemRow = {
  jobId: string;
  analysisId: string;
  ownerUserId: string;
  attempt: number;
};

type CanonicalJsonValue = string | number | boolean | null | CanonicalJsonValue[] | { [key: string]: CanonicalJsonValue };

function requireNonEmpty(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${field} wajib diisi.`);
}

function requireLeaseDuration(value: unknown): number {
  if (value === undefined) return DEFAULT_LEASE_DURATION_MS;
  if (!Number.isSafeInteger(value) || (value as number) < MIN_LEASE_DURATION_MS || (value as number) > MAX_LEASE_DURATION_MS) {
    throw new Error(`Durasi lease harus bilangan bulat ${MIN_LEASE_DURATION_MS}–${MAX_LEASE_DURATION_MS} milidetik.`);
  }
  return value as number;
}

function requireClaim(claim: AnalysisJobClaim): void {
  if (!claim || typeof claim !== "object") throw new Error("Claim analisis tidak valid.");
  requireNonEmpty(claim.jobId, "ID job");
  requireNonEmpty(claim.analysisId, "ID analisis");
  requireNonEmpty(claim.ownerUserId, "Pemilik job");
  if (!Number.isSafeInteger(claim.attempt) || claim.attempt < 1) throw new Error("Percobaan claim tidak valid.");
  if (typeof claim.leaseToken !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(claim.leaseToken)) {
    throw new Error("Token lease tidak valid.");
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalizeConfiguration(input: unknown): { value: Prisma.InputJsonObject; hash: string } {
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new Error("Konfigurasi analisis harus berupa object JSON.");

  const active = new Set<object>();
  let nodeCount = 0;
  const normalize = (value: unknown, depth: number): CanonicalJsonValue => {
    nodeCount += 1;
    if (nodeCount > 20_000 || depth > 64) throw new Error("Konfigurasi analisis terlalu kompleks.");
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw new Error("Konfigurasi analisis memuat angka yang tidak valid.");
      return Object.is(value, -0) ? 0 : value;
    }
    if (typeof value !== "object") throw new Error("Konfigurasi analisis harus JSON tanpa fungsi atau nilai khusus.");
    if (active.has(value)) throw new Error("Konfigurasi analisis tidak boleh memiliki referensi melingkar.");

    active.add(value);
    try {
      if (Array.isArray(value)) {
        if (Object.getPrototypeOf(value) !== Array.prototype || value.length > 20_000) throw new Error("Array konfigurasi analisis tidak valid.");
        const keys = Reflect.ownKeys(value);
        if (keys.some((key) => typeof key !== "string" || (key !== "length" && !/^(0|[1-9]\d*)$/.test(key)))) {
          throw new Error("Array konfigurasi analisis memuat properti tambahan.");
        }
        const result: CanonicalJsonValue[] = [];
        for (let index = 0; index < value.length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
          if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) throw new Error("Array konfigurasi analisis harus padat dan tanpa getter.");
          result.push(normalize(descriptor.value, depth + 1));
        }
        return result;
      }

      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) throw new Error("Object konfigurasi analisis tidak valid.");
      const keys = Reflect.ownKeys(value);
      if (keys.some((key) => typeof key !== "string")) throw new Error("Konfigurasi analisis tidak boleh memakai symbol key.");
      const result: Record<string, CanonicalJsonValue> = Object.create(null) as Record<string, CanonicalJsonValue>;
      for (const key of (keys as string[]).sort()) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) throw new Error("Object konfigurasi analisis harus memakai properti JSON biasa.");
        result[key] = normalize(descriptor.value, depth + 1);
      }
      return result;
    } finally {
      active.delete(value);
    }
  };

  const normalized = normalize(input, 0);
  const canonicalJson = JSON.stringify(normalized);
  if (Buffer.byteLength(canonicalJson, "utf8") > MAX_CONFIGURATION_BYTES) throw new Error("Konfigurasi analisis terlalu besar.");
  // Parse the canonical serialization to sever all references to caller-owned objects.
  const value = JSON.parse(canonicalJson) as Prisma.InputJsonObject;
  return { value, hash: sha256(canonicalJson) };
}

async function ensureAndLockSlot(tx: Prisma.TransactionClient): Promise<SlotRow> {
  await tx.$executeRaw`
    INSERT INTO "WorkerSlot" ("slotKey", "updatedAt", "lastEnqueueSequence")
    VALUES (
      ${ANALYSIS_SLOT}, clock_timestamp(),
      COALESCE((SELECT MAX("queueSequence") FROM "Job" WHERE "type" = 'ANALYSIS'), 0)
    )
    ON CONFLICT ("slotKey") DO NOTHING
  `;
  const rows = await tx.$queryRaw<SlotRow[]>`
    SELECT "jobId", "ownerUserId", "leaseUntil", "heartbeatAt", "leaseTokenHash", "lastEnqueueSequence"
    FROM "WorkerSlot"
    WHERE "slotKey" = ${ANALYSIS_SLOT}
    FOR UPDATE
  `;
  if (rows.length !== 1) throw new AnalysisQueueInvariantError();
  return rows[0];
}

async function readSlotState(tx: Prisma.TransactionClient): Promise<SlotStateRow> {
  const rows = await tx.$queryRaw<SlotStateRow[]>`
    SELECT
      slot."jobId", slot."ownerUserId", slot."leaseUntil", slot."heartbeatAt", slot."leaseTokenHash", slot."lastEnqueueSequence",
      job."type"::text AS "jobType", job."status"::text AS "jobStatus", job."analysisId",
      job."ownerUserId" AS "jobOwnerUserId", job."attempt", job."leaseExpiresAt" AS "jobLeaseExpiresAt",
      analysis."status"::text AS "analysisStatus", analysis."ownerUserId" AS "analysisOwnerUserId"
    FROM "WorkerSlot" AS slot
    LEFT JOIN "Job" AS job ON job."id" = slot."jobId" AND job."ownerUserId" = slot."ownerUserId"
    LEFT JOIN "Analysis" AS analysis ON analysis."id" = job."analysisId" AND analysis."ownerUserId" = job."ownerUserId"
    WHERE slot."slotKey" = ${ANALYSIS_SLOT}
  `;
  if (rows.length !== 1) throw new AnalysisQueueInvariantError();
  return rows[0];
}

function requireEmptySlot(slot: SlotStateRow): void {
  if (slot.jobId !== null || slot.ownerUserId !== null || slot.leaseUntil !== null || slot.heartbeatAt !== null || slot.leaseTokenHash !== null) {
    throw new AnalysisQueueInvariantError();
  }
}

function requireValidOccupiedSlot(slot: SlotStateRow): asserts slot is SlotStateRow & {
  jobId: string;
  ownerUserId: string;
  leaseUntil: Date;
  leaseTokenHash: string;
  jobType: string;
  jobStatus: string;
  analysisId: string;
  jobOwnerUserId: string;
  analysisStatus: string;
  analysisOwnerUserId: string;
  attempt: number;
  jobLeaseExpiresAt: Date;
} {
  if (
    !slot.jobId || !slot.ownerUserId || !slot.leaseUntil || !slot.heartbeatAt || !slot.leaseTokenHash ||
    slot.jobType !== "ANALYSIS" || slot.jobStatus !== "RUNNING" || !slot.analysisId ||
    slot.jobOwnerUserId !== slot.ownerUserId || slot.analysisStatus !== "RUNNING" || slot.analysisOwnerUserId !== slot.ownerUserId ||
    !Number.isSafeInteger(slot.attempt) || !slot.jobLeaseExpiresAt
  ) {
    throw new AnalysisQueueInvariantError();
  }
}

async function requireNoOrphanRunningAnalysis(tx: Prisma.TransactionClient): Promise<void> {
  const rows = await tx.$queryRaw<Array<{ orphanAnalysis: boolean; orphanJob: boolean }>>`
    SELECT
      EXISTS (SELECT 1 FROM "Analysis" WHERE "status" = 'RUNNING') AS "orphanAnalysis",
      EXISTS (SELECT 1 FROM "Job" WHERE "type" = 'ANALYSIS' AND "status" = 'RUNNING') AS "orphanJob"
  `;
  if (rows[0]?.orphanAnalysis || rows[0]?.orphanJob) throw new AnalysisQueueInvariantError();
}

async function slotIsExpired(tx: Prisma.TransactionClient): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ expired: boolean }>>`
    SELECT (
      slot."leaseUntil" <= clock_timestamp() OR job."leaseExpiresAt" <= clock_timestamp()
    ) AS "expired"
    FROM "WorkerSlot" AS slot
    JOIN "Job" AS job ON job."id" = slot."jobId" AND job."ownerUserId" = slot."ownerUserId"
    WHERE slot."slotKey" = ${ANALYSIS_SLOT}
  `;
  if (rows.length !== 1) throw new AnalysisQueueInvariantError();
  return rows[0].expired;
}

async function recoverExpiredAnalysis(tx: Prisma.TransactionClient, slot: SlotStateRow & {
  jobId: string;
  ownerUserId: string;
  leaseTokenHash: string;
  analysisId: string;
  attempt: number;
}): Promise<void> {
  const jobRows = await tx.$queryRaw<Array<{ id: string }>>`
    UPDATE "Job" AS job
    SET "status" = 'FAILED', "finishedAt" = clock_timestamp(), "errorCode" = 'WORKER_INTERRUPTED', "updatedAt" = clock_timestamp()
    WHERE job."id" = ${slot.jobId} AND job."ownerUserId" = ${slot.ownerUserId}
      AND job."type" = 'ANALYSIS' AND job."analysisId" = ${slot.analysisId}
      AND job."status" = 'RUNNING' AND job."attempt" = ${slot.attempt}
      AND EXISTS (
        SELECT 1 FROM "WorkerSlot" AS current_slot
        WHERE current_slot."slotKey" = ${ANALYSIS_SLOT}
          AND current_slot."jobId" = job."id" AND current_slot."ownerUserId" = job."ownerUserId"
          AND current_slot."leaseTokenHash" = ${slot.leaseTokenHash}
          AND (current_slot."leaseUntil" <= clock_timestamp() OR job."leaseExpiresAt" <= clock_timestamp())
      )
    RETURNING job."id"
  `;
  if (jobRows.length !== 1) throw new AnalysisQueueInvariantError();

  const analysisRows = await tx.$queryRaw<Array<{ id: string }>>`
    UPDATE "Analysis" AS analysis
    SET "status" = 'FAILED', "errorCode" = 'WORKER_INTERRUPTED', "completedAt" = clock_timestamp(), "updatedAt" = clock_timestamp()
    WHERE analysis."id" = ${slot.analysisId} AND analysis."ownerUserId" = ${slot.ownerUserId} AND analysis."status" = 'RUNNING'
      AND EXISTS (
        SELECT 1 FROM "Job" AS job
        JOIN "WorkerSlot" AS current_slot ON current_slot."jobId" = job."id" AND current_slot."ownerUserId" = job."ownerUserId"
        WHERE job."id" = ${slot.jobId} AND job."ownerUserId" = ${slot.ownerUserId}
          AND job."analysisId" = analysis."id" AND job."type" = 'ANALYSIS'
          AND job."status" = 'FAILED' AND job."attempt" = ${slot.attempt}
          AND current_slot."slotKey" = ${ANALYSIS_SLOT} AND current_slot."leaseTokenHash" = ${slot.leaseTokenHash}
          AND (current_slot."leaseUntil" <= clock_timestamp() OR job."leaseExpiresAt" <= clock_timestamp())
      )
    RETURNING analysis."id"
  `;
  if (analysisRows.length !== 1) throw new AnalysisQueueInvariantError();

  await tx.$executeRaw`
    UPDATE "AnalysisStage" AS stage
    SET "status" = 'FAILED', "errorCode" = 'WORKER_INTERRUPTED', "finishedAt" = clock_timestamp(), "updatedAt" = clock_timestamp()
    WHERE stage."analysisId" = ${slot.analysisId} AND stage."ownerUserId" = ${slot.ownerUserId} AND stage."status" = 'RUNNING'
      AND EXISTS (
        SELECT 1 FROM "Job" AS job
        JOIN "WorkerSlot" AS current_slot ON current_slot."jobId" = job."id" AND current_slot."ownerUserId" = job."ownerUserId"
        WHERE job."id" = ${slot.jobId} AND job."ownerUserId" = ${slot.ownerUserId}
          AND job."analysisId" = stage."analysisId" AND job."type" = 'ANALYSIS'
          AND job."status" = 'FAILED' AND job."attempt" = ${slot.attempt}
          AND current_slot."slotKey" = ${ANALYSIS_SLOT} AND current_slot."leaseTokenHash" = ${slot.leaseTokenHash}
          AND (current_slot."leaseUntil" <= clock_timestamp() OR job."leaseExpiresAt" <= clock_timestamp())
      )
  `;

  const releasedRows = await tx.$queryRaw<Array<{ slotKey: string }>>`
    UPDATE "WorkerSlot" AS current_slot
    SET "jobId" = NULL, "ownerUserId" = NULL, "leaseUntil" = NULL, "heartbeatAt" = NULL,
        "leaseTokenHash" = NULL, "updatedAt" = clock_timestamp()
    WHERE current_slot."slotKey" = ${ANALYSIS_SLOT} AND current_slot."jobId" = ${slot.jobId}
      AND current_slot."ownerUserId" = ${slot.ownerUserId} AND current_slot."leaseTokenHash" = ${slot.leaseTokenHash}
      AND (current_slot."leaseUntil" <= clock_timestamp() OR EXISTS (
        SELECT 1 FROM "Job" AS job
        WHERE job."id" = ${slot.jobId} AND job."ownerUserId" = ${slot.ownerUserId}
          AND job."attempt" = ${slot.attempt} AND job."leaseExpiresAt" <= clock_timestamp()
      ))
    RETURNING current_slot."slotKey"
  `;
  if (releasedRows.length !== 1) throw new AnalysisQueueInvariantError();
}

/**
 * Persist an immutable analysis snapshot and its ANALYSIS job as one operation.
 * Callers must authenticate the owner and create/verify the repository snapshot before enqueueing.
 */
export async function enqueueAnalysis(db: PrismaClient, input: EnqueueAnalysisInput): Promise<EnqueuedAnalysis> {
  if (!input || typeof input !== "object") throw new Error("Snapshot analisis tidak valid.");
  const ownerUserId = input.ownerUserId;
  const repositoryId = input.repositoryId;
  const branchName = input.branchName;
  const originalCommitSha = input.commitSha;
  const rawConfiguration = input.configuration;
  const analyzerVersion = input.analyzerVersion;
  const schemaVersion = input.schemaVersion;
  const retryParentId = input.retryParentId;
  requireNonEmpty(ownerUserId, "Pemilik analisis");
  requireNonEmpty(repositoryId, "Repository");
  requireNonEmpty(branchName, "Branch");
  requireNonEmpty(originalCommitSha, "Commit SHA");
  requireNonEmpty(analyzerVersion, "Versi analyzer");
  requireNonEmpty(schemaVersion, "Versi schema");
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(originalCommitSha)) throw new Error("Commit SHA harus full SHA Git sepanjang 40 atau 64 karakter hex.");
  if (retryParentId !== undefined && retryParentId !== null) requireNonEmpty(retryParentId, "ID analisis sebelumnya");
  const configuration = canonicalizeConfiguration(rawConfiguration);
  const commitSha = originalCommitSha.toLowerCase();

  return db.$transaction(async (tx) => {
    const slot = await ensureAndLockSlot(tx);
    // The singleton lock serializes enqueue and claim; its counter defines FIFO order
    // without relying on timestamp precision or caller clocks.
    if (slot.lastEnqueueSequence < 0n) throw new AnalysisQueueInvariantError();
    const nextRows = await tx.$queryRaw<Array<{ sequence: bigint }>>`
      UPDATE "WorkerSlot"
      SET "lastEnqueueSequence" = "lastEnqueueSequence" + 1, "updatedAt" = clock_timestamp()
      WHERE "slotKey" = ${ANALYSIS_SLOT}
      RETURNING "lastEnqueueSequence" AS "sequence"
    `;
    if (nextRows.length !== 1 || nextRows[0].sequence <= 0n) throw new AnalysisQueueInvariantError();

    const analysis = await tx.analysis.create({
      data: {
        ownerUserId,
        repositoryId,
        retryParentId: retryParentId ?? null,
        branchName,
        commitSha,
        configuration: configuration.value,
        configurationHash: configuration.hash,
        analyzerVersion,
        schemaVersion,
      },
      select: { id: true },
    });
    const job = await tx.job.create({
      data: {
        ownerUserId,
        analysisId: analysis.id,
        type: "ANALYSIS",
        queueSequence: nextRows[0].sequence,
      },
      select: { id: true },
    });
    await tx.$executeRaw`UPDATE "Analysis" SET "queuedAt" = clock_timestamp() WHERE "id" = ${analysis.id} AND "ownerUserId" = ${ownerUserId}`;
    await tx.$executeRaw`UPDATE "Job" SET "enqueuedAt" = clock_timestamp() WHERE "id" = ${job.id} AND "ownerUserId" = ${ownerUserId}`;
    return { analysisId: analysis.id, jobId: job.id, configurationHash: configuration.hash };
  });
}

/** Atomically claims the oldest queued analysis, or recovers an expired lease first. */
export async function claimAnalysisJob(db: PrismaClient, options: ClaimAnalysisJobOptions = {}): Promise<AnalysisJobClaim | null> {
  const leaseDurationMs = requireLeaseDuration(options.leaseDurationMs);
  return db.$transaction(async (tx) => {
    await ensureAndLockSlot(tx);
    let slot = await readSlotState(tx);

    if (slot.jobId === null) {
      requireEmptySlot(slot);
      await requireNoOrphanRunningAnalysis(tx);
    } else {
      requireValidOccupiedSlot(slot);
      if (!(await slotIsExpired(tx))) return null;
      await recoverExpiredAnalysis(tx, slot);
      slot = await readSlotState(tx);
      requireEmptySlot(slot);
    }

    const candidates = await tx.$queryRaw<QueueItemRow[]>`
      SELECT job."id" AS "jobId", analysis."id" AS "analysisId", job."ownerUserId", job."attempt"
      FROM "Job" AS job
      JOIN "Analysis" AS analysis ON analysis."id" = job."analysisId" AND analysis."ownerUserId" = job."ownerUserId"
      WHERE job."type" = 'ANALYSIS' AND job."status" = 'QUEUED' AND analysis."status" = 'QUEUED'
      ORDER BY job."queueSequence" ASC
      LIMIT 1
      FOR UPDATE OF job, analysis
    `;
    const next = candidates[0];
    if (!next) return null;

    const leaseToken = randomUUID();
    const leaseTokenHash = sha256(leaseToken);
    const jobRows = await tx.$queryRaw<Array<{ attempt: number; leaseExpiresAt: Date }>>`
      UPDATE "Job"
      SET "status" = 'RUNNING', "startedAt" = clock_timestamp(), "finishedAt" = NULL,
          "heartbeatAt" = clock_timestamp(), "leaseExpiresAt" = clock_timestamp() + (${leaseDurationMs} * INTERVAL '1 millisecond'),
          "attempt" = "attempt" + 1, "errorCode" = NULL, "updatedAt" = clock_timestamp()
      WHERE "id" = ${next.jobId} AND "ownerUserId" = ${next.ownerUserId} AND "analysisId" = ${next.analysisId}
        AND "type" = 'ANALYSIS' AND "status" = 'QUEUED' AND "attempt" = ${next.attempt}
      RETURNING "attempt", "leaseExpiresAt"
    `;
    if (jobRows.length !== 1) throw new AnalysisQueueInvariantError();
    const attempt = jobRows[0].attempt;

    const slotRows = await tx.$queryRaw<Array<{ jobId: string }>>`
      UPDATE "WorkerSlot" AS slot
      SET "jobId" = ${next.jobId}, "ownerUserId" = ${next.ownerUserId}, "leaseUntil" = job."leaseExpiresAt",
          "heartbeatAt" = clock_timestamp(), "leaseTokenHash" = ${leaseTokenHash}, "updatedAt" = clock_timestamp()
      FROM "Job" AS job
      WHERE slot."slotKey" = ${ANALYSIS_SLOT} AND slot."jobId" IS NULL AND slot."ownerUserId" IS NULL
        AND slot."leaseUntil" IS NULL AND slot."leaseTokenHash" IS NULL
        AND job."id" = ${next.jobId} AND job."ownerUserId" = ${next.ownerUserId}
        AND job."status" = 'RUNNING' AND job."attempt" = ${attempt}
        AND job."leaseExpiresAt" > clock_timestamp()
      RETURNING slot."jobId"
    `;
    if (slotRows.length !== 1) throw new AnalysisQueueInvariantError();

    const analysisRows = await tx.$queryRaw<Array<{ id: string }>>`
      UPDATE "Analysis" AS analysis
      SET "status" = 'RUNNING', "startedAt" = clock_timestamp(), "updatedAt" = clock_timestamp()
      WHERE analysis."id" = ${next.analysisId} AND analysis."ownerUserId" = ${next.ownerUserId} AND analysis."status" = 'QUEUED'
        AND EXISTS (
          SELECT 1 FROM "Job" AS job
          JOIN "WorkerSlot" AS slot ON slot."jobId" = job."id" AND slot."ownerUserId" = job."ownerUserId"
          WHERE job."id" = ${next.jobId} AND job."ownerUserId" = ${next.ownerUserId}
            AND job."analysisId" = analysis."id" AND job."status" = 'RUNNING' AND job."attempt" = ${attempt}
            AND job."leaseExpiresAt" > clock_timestamp() AND slot."slotKey" = ${ANALYSIS_SLOT}
            AND slot."leaseTokenHash" = ${leaseTokenHash} AND slot."leaseUntil" > clock_timestamp()
        )
      RETURNING analysis."id"
    `;
    if (analysisRows.length !== 1) throw new AnalysisQueueInvariantError();

    return {
      jobId: next.jobId,
      analysisId: next.analysisId,
      ownerUserId: next.ownerUserId,
      attempt,
      leaseToken,
      leaseExpiresAt: jobRows[0].leaseExpiresAt,
    };
  });
}

/** Renews only the current, unexpired lease; stale workers cannot revive it. */
export async function renewAnalysisLease(
  db: PrismaClient,
  claim: AnalysisJobClaim,
  options: RenewAnalysisLeaseOptions = {},
): Promise<Date | null> {
  requireClaim(claim);
  const leaseDurationMs = requireLeaseDuration(options.leaseDurationMs);
  const leaseTokenHash = sha256(claim.leaseToken);
  return db.$transaction(async (tx) => {
    await ensureAndLockSlot(tx);
    const rows = await tx.$queryRaw<Array<{ slotUpdated: boolean; jobUpdated: boolean; leaseExpiresAt: Date | null }>>`
      WITH renewed_slot AS (
        UPDATE "WorkerSlot" AS slot
        SET "leaseUntil" = clock_timestamp() + (${leaseDurationMs} * INTERVAL '1 millisecond'),
            "heartbeatAt" = clock_timestamp(), "updatedAt" = clock_timestamp()
        WHERE slot."slotKey" = ${ANALYSIS_SLOT} AND slot."jobId" = ${claim.jobId}
          AND slot."ownerUserId" = ${claim.ownerUserId} AND slot."leaseTokenHash" = ${leaseTokenHash}
          AND slot."leaseUntil" > clock_timestamp()
          AND EXISTS (
            SELECT 1 FROM "Job" AS job
            WHERE job."id" = slot."jobId" AND job."ownerUserId" = slot."ownerUserId"
              AND job."analysisId" = ${claim.analysisId} AND job."type" = 'ANALYSIS'
              AND job."status" = 'RUNNING' AND job."attempt" = ${claim.attempt}
              AND job."leaseExpiresAt" > clock_timestamp()
          )
        RETURNING slot."jobId", slot."ownerUserId", slot."leaseUntil", slot."heartbeatAt"
      ), updated_job AS (
        UPDATE "Job" AS job
        SET "leaseExpiresAt" = renewed_slot."leaseUntil", "heartbeatAt" = renewed_slot."heartbeatAt", "updatedAt" = clock_timestamp()
        FROM renewed_slot
        WHERE job."id" = renewed_slot."jobId" AND job."ownerUserId" = renewed_slot."ownerUserId"
          AND job."analysisId" = ${claim.analysisId} AND job."type" = 'ANALYSIS'
          AND job."status" = 'RUNNING' AND job."attempt" = ${claim.attempt}
        RETURNING job."leaseExpiresAt"
      )
      SELECT EXISTS (SELECT 1 FROM renewed_slot) AS "slotUpdated",
             EXISTS (SELECT 1 FROM updated_job) AS "jobUpdated",
             (SELECT "leaseExpiresAt" FROM updated_job) AS "leaseExpiresAt"
    `;
    const result = rows[0];
    if (result.slotUpdated !== result.jobUpdated) throw new AnalysisQueueInvariantError();
    return result.slotUpdated ? result.leaseExpiresAt : null;
  });
}

/** Fails a running analysis only while its matching lease remains current. */
export async function failAnalysisJob(
  db: PrismaClient,
  claim: AnalysisJobClaim,
  errorCode = "ANALYSIS_FAILED",
): Promise<boolean> {
  requireClaim(claim);
  if (typeof errorCode !== "string" || !/^[A-Z][A-Z0-9_]{0,63}$/.test(errorCode)) throw new Error("Kode error analisis tidak valid.");
  const leaseTokenHash = sha256(claim.leaseToken);

  return db.$transaction(async (tx) => {
    await ensureAndLockSlot(tx);
    const jobRows = await tx.$queryRaw<Array<{ id: string }>>`
      UPDATE "Job" AS job
      SET "status" = 'FAILED', "finishedAt" = clock_timestamp(), "errorCode" = ${errorCode}, "updatedAt" = clock_timestamp()
      WHERE job."id" = ${claim.jobId} AND job."ownerUserId" = ${claim.ownerUserId}
        AND job."analysisId" = ${claim.analysisId} AND job."type" = 'ANALYSIS'
        AND job."status" = 'RUNNING' AND job."attempt" = ${claim.attempt}
        AND job."leaseExpiresAt" > clock_timestamp()
        AND EXISTS (
          SELECT 1 FROM "WorkerSlot" AS slot
          WHERE slot."slotKey" = ${ANALYSIS_SLOT} AND slot."jobId" = job."id"
            AND slot."ownerUserId" = job."ownerUserId" AND slot."leaseTokenHash" = ${leaseTokenHash}
            AND slot."leaseUntil" > clock_timestamp()
        )
      RETURNING job."id"
    `;
    if (jobRows.length === 0) return false;
    if (jobRows.length !== 1) throw new AnalysisQueueInvariantError();

    const analysisRows = await tx.$queryRaw<Array<{ id: string }>>`
      UPDATE "Analysis" AS analysis
      SET "status" = 'FAILED', "errorCode" = ${errorCode}, "completedAt" = clock_timestamp(), "updatedAt" = clock_timestamp()
      WHERE analysis."id" = ${claim.analysisId} AND analysis."ownerUserId" = ${claim.ownerUserId} AND analysis."status" = 'RUNNING'
        AND EXISTS (
          SELECT 1 FROM "Job" AS job
          JOIN "WorkerSlot" AS slot ON slot."jobId" = job."id" AND slot."ownerUserId" = job."ownerUserId"
          WHERE job."id" = ${claim.jobId} AND job."ownerUserId" = ${claim.ownerUserId}
            AND job."analysisId" = analysis."id" AND job."type" = 'ANALYSIS'
            AND job."status" = 'FAILED' AND job."errorCode" = ${errorCode} AND job."attempt" = ${claim.attempt}
            AND job."leaseExpiresAt" > clock_timestamp() AND slot."slotKey" = ${ANALYSIS_SLOT}
            AND slot."leaseTokenHash" = ${leaseTokenHash} AND slot."leaseUntil" > clock_timestamp()
        )
      RETURNING analysis."id"
    `;
    if (analysisRows.length !== 1) throw new AnalysisQueueInvariantError();

    await tx.$executeRaw`
      UPDATE "AnalysisStage" AS stage
      SET "status" = 'FAILED', "errorCode" = ${errorCode}, "finishedAt" = clock_timestamp(), "updatedAt" = clock_timestamp()
      WHERE stage."analysisId" = ${claim.analysisId} AND stage."ownerUserId" = ${claim.ownerUserId} AND stage."status" = 'RUNNING'
        AND EXISTS (
          SELECT 1 FROM "Job" AS job
          JOIN "WorkerSlot" AS slot ON slot."jobId" = job."id" AND slot."ownerUserId" = job."ownerUserId"
          WHERE job."id" = ${claim.jobId} AND job."ownerUserId" = ${claim.ownerUserId}
            AND job."analysisId" = stage."analysisId" AND job."type" = 'ANALYSIS'
            AND job."status" = 'FAILED' AND job."attempt" = ${claim.attempt}
            AND job."leaseExpiresAt" > clock_timestamp() AND slot."slotKey" = ${ANALYSIS_SLOT}
            AND slot."leaseTokenHash" = ${leaseTokenHash} AND slot."leaseUntil" > clock_timestamp()
        )
    `;

    const releaseRows = await tx.$queryRaw<Array<{ slotKey: string }>>`
      UPDATE "WorkerSlot" AS slot
      SET "jobId" = NULL, "ownerUserId" = NULL, "leaseUntil" = NULL, "heartbeatAt" = NULL,
          "leaseTokenHash" = NULL, "updatedAt" = clock_timestamp()
      WHERE slot."slotKey" = ${ANALYSIS_SLOT} AND slot."jobId" = ${claim.jobId}
        AND slot."ownerUserId" = ${claim.ownerUserId} AND slot."leaseTokenHash" = ${leaseTokenHash}
        AND slot."leaseUntil" > clock_timestamp()
        AND EXISTS (
          SELECT 1 FROM "Job" AS job
          WHERE job."id" = ${claim.jobId} AND job."ownerUserId" = ${claim.ownerUserId}
            AND job."analysisId" = ${claim.analysisId} AND job."type" = 'ANALYSIS'
            AND job."status" = 'FAILED' AND job."attempt" = ${claim.attempt} AND job."leaseExpiresAt" > clock_timestamp()
        )
      RETURNING slot."slotKey"
    `;
    if (releaseRows.length !== 1) throw new AnalysisQueueInvariantError();
    return true;
  });
}

/** Owner-scoped progress read. Claim tokens and queue counters are never returned. */
export async function getOwnerAnalysisProgress(db: PrismaClient, ownerUserId: string, analysisId: string) {
  requireNonEmpty(ownerUserId, "Pemilik analisis");
  requireNonEmpty(analysisId, "ID analisis");
  return db.analysis.findFirst({
    where: { id: analysisId, ownerUserId },
    select: {
      id: true,
      branchName: true,
      commitSha: true,
      status: true,
      errorCode: true,
      queuedAt: true,
      startedAt: true,
      completedAt: true,
      stages: { orderBy: { sequence: "asc" }, select: { sequence: true, key: true, status: true, startedAt: true, finishedAt: true, errorCode: true } },
      jobs: { where: { type: "ANALYSIS" }, take: 1, select: { id: true, status: true, startedAt: true, finishedAt: true, attempt: true, errorCode: true } },
    },
  });
}
