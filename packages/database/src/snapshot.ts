import { createHash } from "node:crypto";
import type { PrismaClient } from "../generated/client.ts";
import { snapshotAnalysisJobClaim, type AnalysisJobClaim } from "./queue.ts";

/** Register only while the exact worker attempt still owns RUNNING SNAPSHOT. */
export async function registerSnapshotArchive(db: PrismaClient, inputClaim: AnalysisJobClaim, input: { storageKey: string; sha256: string; byteLength: number; signal?: AbortSignal }) {
  const claim = snapshotAnalysisJobClaim(inputClaim);
  if (!/^snapshot-[A-Za-z0-9]{6}\/archive\.tar\.gz$/.test(input.storageKey) || !/^[a-f0-9]{64}$/.test(input.sha256) || !Number.isSafeInteger(input.byteLength) || input.byteLength < 1 || input.byteLength > 26214400) throw new Error("Snapshot metadata tidak valid.");
  const tokenHash = createHash("sha256").update(claim.leaseToken).digest("hex");
  return db.$transaction(async tx => {
    input.signal?.throwIfAborted();
    await tx.$queryRaw`SELECT "slotKey" FROM "WorkerSlot" WHERE "slotKey" = 'analysis' FOR UPDATE`;
    const readActive = () => tx.$queryRaw<Array<{ active: boolean }>>`
      SELECT EXISTS (
        SELECT 1 FROM "WorkerSlot" slot
        JOIN "Job" job ON job."id" = slot."jobId" AND job."ownerUserId" = slot."ownerUserId"
        JOIN "Analysis" analysis ON analysis."id" = job."analysisId" AND analysis."ownerUserId" = job."ownerUserId"
        JOIN "AnalysisStage" stage ON stage."analysisId" = analysis."id" AND stage."ownerUserId" = analysis."ownerUserId"
        WHERE slot."slotKey" = 'analysis' AND slot."jobId" = ${claim.jobId} AND slot."ownerUserId" = ${claim.ownerUserId}
          AND slot."leaseTokenHash" = ${tokenHash} AND slot."leaseUntil" > clock_timestamp()
          AND job."analysisId" = ${claim.analysisId} AND job."status" = 'RUNNING' AND job."type" = 'ANALYSIS'
          AND job."attempt" = ${claim.attempt} AND job."leaseExpiresAt" > clock_timestamp()
          AND analysis."status" = 'RUNNING' AND stage."key" = 'SNAPSHOT' AND stage."status" = 'RUNNING'
      ) AS active`;
    if ((await readActive())[0]?.active !== true) throw new Error("Snapshot lease tidak aktif.");
    input.signal?.throwIfAborted();
    const record = await tx.storageObject.create({ data: { ownerUserId: claim.ownerUserId, analysisId: claim.analysisId, type: "SOURCE_ARCHIVE", storageKey: input.storageKey, sha256: input.sha256, byteLength: BigInt(input.byteLength) }, select: { id: true, sha256: true } });
    if ((await readActive())[0]?.active !== true) throw new Error("Snapshot lease tidak aktif.");
    input.signal?.throwIfAborted(); return record;
  });
}
