import { createHash, randomUUID } from "node:crypto";
import { Prisma } from "../generated/client.ts";
import { ANALYSIS_STAGE_DEFINITIONS } from "../../contracts/src/stages.ts";
import type { AnalysisStageKey, AnalysisStageProgress, AnalysisStageStatus } from "../../contracts/src/stages.ts";
import { AnalysisQueueInvariantError, snapshotAnalysisJobClaim, type AnalysisJobClaim } from "./queue.ts";
import type { PrismaClient } from "../generated/client.ts";

const ANALYSIS_SLOT_KEY = "analysis";
const STAGE_FAILURE_CODES = ["STAGE_HANDLER_FAILED", "STAGE_CANCELLED"] as const;
export type AnalysisStageFailureCode = (typeof STAGE_FAILURE_CODES)[number];

export interface AnalysisStageTargetContext {
  readonly analysisId: string;
  readonly repositoryId: string;
  readonly repositoryFullName: string;
  readonly repositoryVisibility: "PUBLIC" | "PRIVATE" | "INTERNAL" | "UNKNOWN";
  readonly branchName: string;
  readonly commitSha: string;
  readonly configurationHash: string;
  readonly analyzerVersion: string;
  readonly schemaVersion: string;
}

export type ReadonlyJsonValue =
  | string
  | number
  | boolean
  | null
  | readonly ReadonlyJsonValue[]
  | { readonly [key: string]: ReadonlyJsonValue };

export interface PersistedAnalysisStageInput {
  readonly target: AnalysisStageTargetContext;
  readonly configuration: ReadonlyJsonValue;
}

interface StageRow {
  sequence: number;
  key: string;
  status: string;
  startedAt: Date | null;
  finishedAt: Date | null;
  errorCode: string | null;
}

function leaseTokenHash(claim: AnalysisJobClaim): string {
  return createHash("sha256").update(claim.leaseToken, "utf8").digest("hex");
}

function activeLeasePredicate(claim: AnalysisJobClaim, tokenHash: string): Prisma.Sql {
  return Prisma.sql`
    EXISTS (
      SELECT 1
      FROM "WorkerSlot" AS slot
      JOIN "Job" AS job ON job."id" = slot."jobId" AND job."ownerUserId" = slot."ownerUserId"
      JOIN "Analysis" AS analysis ON analysis."id" = job."analysisId" AND analysis."ownerUserId" = job."ownerUserId"
      WHERE slot."slotKey" = ${ANALYSIS_SLOT_KEY}
        AND slot."jobId" = ${claim.jobId} AND slot."ownerUserId" = ${claim.ownerUserId}
        AND slot."leaseTokenHash" = ${tokenHash} AND slot."leaseUntil" > clock_timestamp()
        AND job."id" = ${claim.jobId} AND job."analysisId" = ${claim.analysisId}
        AND job."ownerUserId" = ${claim.ownerUserId} AND job."type" = 'ANALYSIS'
        AND job."status" = 'RUNNING' AND job."attempt" = ${claim.attempt}
        AND job."leaseExpiresAt" > clock_timestamp()
        AND analysis."id" = ${claim.analysisId} AND analysis."ownerUserId" = ${claim.ownerUserId}
        AND analysis."status" = 'RUNNING'
    )
  `;
}

async function withCurrentLease<T>(
  db: PrismaClient,
  inputClaim: AnalysisJobClaim,
  work: (tx: Prisma.TransactionClient, tokenHash: string) => Promise<T>,
): Promise<T | null> {
  const claim = snapshotAnalysisJobClaim(inputClaim);
  const tokenHash = leaseTokenHash(claim);
  return db.$transaction(async (tx) => {
    const lockedRows = await tx.$queryRaw<Array<{ slotKey: string }>>`
      SELECT "slotKey" FROM "WorkerSlot" WHERE "slotKey" = ${ANALYSIS_SLOT_KEY} FOR UPDATE
    `;
    if (lockedRows.length !== 1) throw new AnalysisQueueInvariantError();

    const currentRows = await tx.$queryRaw<Array<{ active: boolean }>>`
      SELECT ${activeLeasePredicate(claim, tokenHash)} AS "active"
    `;
    if (currentRows.length !== 1) throw new AnalysisQueueInvariantError();
    if (!currentRows[0].active) return null;
    return work(tx, tokenHash);
  });
}

function stageValues(): Prisma.Sql {
  return Prisma.join(ANALYSIS_STAGE_DEFINITIONS.map(({ sequence, key }) => Prisma.sql`(${randomUUID()}::text, ${sequence}::integer, ${key}::text)`));
}

class StageInitializationLeaseLostError extends Error {}

function validateStageRows(rows: readonly StageRow[]): readonly AnalysisStageProgress[] {
  if (rows.length !== ANALYSIS_STAGE_DEFINITIONS.length) throw new AnalysisQueueInvariantError();
  return rows.map((row, index) => {
    const expected = ANALYSIS_STAGE_DEFINITIONS[index];
    if (
      row.sequence !== expected.sequence || row.key !== expected.key ||
      !(row.status === "PENDING" || row.status === "RUNNING" || row.status === "COMPLETED" || row.status === "FAILED")
    ) {
      throw new AnalysisQueueInvariantError();
    }
    return {
      sequence: row.sequence,
      key: row.key as AnalysisStageKey,
      status: row.status as AnalysisStageStatus,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt,
      errorCode: row.errorCode,
    };
  });
}

/** Seed and verify the fixed nine stages while holding the fenced global queue slot. */
export async function initializeAnalysisStages(
  db: PrismaClient,
  inputClaim: AnalysisJobClaim,
): Promise<PersistedAnalysisStageInput | null> {
  const claim = snapshotAnalysisJobClaim(inputClaim);
  try {
    return await withCurrentLease(db, claim, async (tx, tokenHash) => {
      await tx.$queryRaw<Array<{ id: string }>>`
        WITH current_lease AS MATERIALIZED (
          SELECT ${activeLeasePredicate(claim, tokenHash)} AS "active"
        )
        INSERT INTO "AnalysisStage" ("id", "ownerUserId", "analysisId", "sequence", "key", "status", "createdAt", "updatedAt")
        SELECT stage."id", ${claim.ownerUserId}, ${claim.analysisId}, stage."sequence", stage."key", 'PENDING', clock_timestamp(), clock_timestamp()
        FROM (VALUES ${stageValues()}) AS stage("id", "sequence", "key")
        CROSS JOIN current_lease
        WHERE current_lease."active"
        ON CONFLICT ("analysisId", "key") DO NOTHING
        RETURNING "id"
      `;

      const currentRows = await tx.$queryRaw<Array<{ active: boolean }>>`
        SELECT ${activeLeasePredicate(claim, tokenHash)} AS "active"
      `;
      if (currentRows.length !== 1) throw new AnalysisQueueInvariantError();
      if (!currentRows[0].active) throw new StageInitializationLeaseLostError();

      const analysis = await tx.analysis.findFirst({
        where: { id: claim.analysisId, ownerUserId: claim.ownerUserId, status: "RUNNING" },
        select: {
          id: true,
          repositoryId: true,
          repositoryFullNameSnapshot: true,
          branchName: true,
          commitSha: true,
          configuration: true,
          configurationHash: true,
          analyzerVersion: true,
          schemaVersion: true,
          repository: { select: { visibility: true } },
        },
      });
      if (!analysis || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(analysis.commitSha)) throw new AnalysisQueueInvariantError();

      let repositoryFullNameSnapshot = analysis.repositoryFullNameSnapshot;
      if (repositoryFullNameSnapshot === null) {
        // Legacy rows did not save the submission-time name. Capture today's name once while
        // holding the worker lease and a shared repository row lock; this cannot reconstruct
        // historical truth if that repository was renamed before this migration was deployed.
        const repositoryRows = await tx.$queryRaw<Array<{ fullName: string }>>`
          SELECT repository."fullName"
          FROM "Repository" AS repository
          JOIN "Analysis" AS analysis ON analysis."repositoryId" = repository."id"
          WHERE analysis."id" = ${claim.analysisId} AND analysis."ownerUserId" = ${claim.ownerUserId}
          FOR SHARE OF repository
        `;
        if (repositoryRows.length !== 1 || !repositoryRows[0].fullName) throw new AnalysisQueueInvariantError();
        const capturedRows = await tx.$queryRaw<Array<{ fullName: string }>>`
          UPDATE "Analysis"
          SET "repositoryFullNameSnapshot" = ${repositoryRows[0].fullName}, "updatedAt" = clock_timestamp()
          WHERE "id" = ${claim.analysisId} AND "ownerUserId" = ${claim.ownerUserId}
            AND "repositoryFullNameSnapshot" IS NULL
          RETURNING "repositoryFullNameSnapshot" AS "fullName"
        `;
        if (capturedRows.length !== 1) throw new AnalysisQueueInvariantError();
        repositoryFullNameSnapshot = capturedRows[0].fullName;
      }
      if (!repositoryFullNameSnapshot) throw new AnalysisQueueInvariantError();

      const stageRows = await tx.analysisStage.findMany({
        where: { analysisId: claim.analysisId, ownerUserId: claim.ownerUserId },
        orderBy: { sequence: "asc" },
        select: { sequence: true, key: true, status: true, startedAt: true, finishedAt: true, errorCode: true },
      });
      validateStageRows(stageRows);

      return {
        target: {
          analysisId: analysis.id,
          repositoryId: analysis.repositoryId,
          repositoryFullName: repositoryFullNameSnapshot,
          repositoryVisibility: analysis.repository.visibility,
          branchName: analysis.branchName,
          commitSha: analysis.commitSha,
          configurationHash: analysis.configurationHash,
          analyzerVersion: analysis.analyzerVersion,
          schemaVersion: analysis.schemaVersion,
        },
        configuration: analysis.configuration as unknown as ReadonlyJsonValue,
      };
    });
  } catch (error) {
    if (error instanceof StageInitializationLeaseLostError) return null;
    throw error;
  }
}

async function transitionStage(
  db: PrismaClient,
  inputClaim: AnalysisJobClaim,
  key: AnalysisStageKey,
  from: AnalysisStageStatus,
  to: AnalysisStageStatus,
  failureCode?: AnalysisStageFailureCode,
): Promise<boolean | null> {
  const claim = snapshotAnalysisJobClaim(inputClaim);
  const definition = ANALYSIS_STAGE_DEFINITIONS.find((stage) => stage.key === key);
  if (!definition) throw new Error("Tahap analisis tidak dikenal.");
  if (from === "PENDING" && to === "RUNNING") {
    if (failureCode !== undefined) throw new Error("Kode kegagalan tidak berlaku saat memulai tahap.");
  } else if (from === "RUNNING" && to === "COMPLETED") {
    if (failureCode !== undefined) throw new Error("Kode kegagalan tidak berlaku saat menyelesaikan tahap.");
  } else if (from === "RUNNING" && to === "FAILED") {
    if (!STAGE_FAILURE_CODES.includes(failureCode as AnalysisStageFailureCode)) throw new Error("Kode kegagalan tahap tidak valid.");
  } else {
    throw new Error("Transisi status tahap tidak valid.");
  }

  return withCurrentLease(db, claim, async (tx, tokenHash) => {
    const statusRows = await tx.$queryRaw<Array<{ id: string }>>`
      UPDATE "AnalysisStage" AS stage
      SET "status" = ${to}::"AnalysisStageStatus",
          "startedAt" = CASE WHEN ${to} = 'RUNNING' THEN clock_timestamp() ELSE stage."startedAt" END,
          "finishedAt" = CASE WHEN ${to} IN ('COMPLETED', 'FAILED') THEN clock_timestamp() ELSE NULL END,
          "errorCode" = CASE WHEN ${to} = 'FAILED' THEN ${failureCode ?? null} ELSE NULL END,
          "updatedAt" = clock_timestamp()
      WHERE stage."analysisId" = ${claim.analysisId} AND stage."ownerUserId" = ${claim.ownerUserId}
        AND stage."sequence" = ${definition.sequence} AND stage."key" = ${definition.key}
        AND stage."status" = ${from}::"AnalysisStageStatus"
        AND NOT EXISTS (
          SELECT 1 FROM "AnalysisStage" AS prior
          WHERE prior."analysisId" = stage."analysisId" AND prior."ownerUserId" = stage."ownerUserId"
            AND prior."sequence" < stage."sequence" AND prior."status" <> 'COMPLETED'
        )
        AND NOT EXISTS (
          SELECT 1 FROM "AnalysisStage" AS later
          WHERE later."analysisId" = stage."analysisId" AND later."ownerUserId" = stage."ownerUserId"
            AND later."sequence" > stage."sequence" AND later."status" <> 'PENDING'
        )
        AND ${activeLeasePredicate(claim, tokenHash)}
      RETURNING stage."id"
    `;
    if (statusRows.length > 1) throw new AnalysisQueueInvariantError();
    if (statusRows.length === 1) return true;
    const currentRows = await tx.$queryRaw<Array<{ active: boolean }>>`
      SELECT ${activeLeasePredicate(claim, tokenHash)} AS "active"
    `;
    if (currentRows.length !== 1) throw new AnalysisQueueInvariantError();
    return currentRows[0].active ? false : null;
  });
}

/** PENDING→RUNNING is an atomic CAS; another invocation cannot start the same stage twice. */
export async function startAnalysisStage(db: PrismaClient, claim: AnalysisJobClaim, key: AnalysisStageKey): Promise<boolean | null> {
  return transitionStage(db, claim, key, "PENDING", "RUNNING");
}

export async function completeAnalysisStage(db: PrismaClient, claim: AnalysisJobClaim, key: AnalysisStageKey): Promise<boolean | null> {
  return transitionStage(db, claim, key, "RUNNING", "COMPLETED");
}

export async function failAnalysisStage(
  db: PrismaClient,
  claim: AnalysisJobClaim,
  key: AnalysisStageKey,
  failureCode: AnalysisStageFailureCode,
): Promise<boolean | null> {
  return transitionStage(db, claim, key, "RUNNING", "FAILED", failureCode);
}

/** Read stage progress only; this never marks the analysis or job complete. */
export async function readAnalysisStages(
  db: PrismaClient,
  ownerUserId: string,
  analysisId: string,
): Promise<readonly AnalysisStageProgress[] | null> {
  if (typeof ownerUserId !== "string" || !ownerUserId.trim()) throw new Error("Pemilik analisis wajib diisi.");
  if (typeof analysisId !== "string" || !analysisId.trim()) throw new Error("ID analisis wajib diisi.");
  const ownedAnalysis = await db.analysis.findFirst({ where: { id: analysisId, ownerUserId, deletionRequestedAt: null }, select: { id: true } });
  if (!ownedAnalysis) return null;
  const rows = await db.analysisStage.findMany({
    where: { ownerUserId, analysisId },
    orderBy: { sequence: "asc" },
    select: { sequence: true, key: true, status: true, startedAt: true, finishedAt: true, errorCode: true },
  });
  if (rows.length === 0) return [];
  return validateStageRows(rows);
}
