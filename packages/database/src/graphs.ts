import { createHash } from "node:crypto";
import { CKG_SCHEMA_VERSION, canonicalizeCkg, parseCanonicalCkg } from "@sage/contracts";
import type { CkgV1 } from "@sage/contracts";
import { Prisma, type PrismaClient } from "../generated/client.ts";
import { snapshotAnalysisJobClaim } from "./queue.ts";
import type { AnalysisJobClaim } from "./queue.ts";
import { CANONICAL_STORAGE_LAYOUT_VERSION, storageMirrorsMatchLayout } from "./storage-layout.ts";

const ANALYSIS_SLOT = "analysis";

class PersistLeaseLostError extends Error {}

async function hasCurrentAnalysisLease(
  tx: Prisma.TransactionClient,
  claim: AnalysisJobClaim,
  tokenHash: string,
): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ active: boolean }>>`
    SELECT EXISTS (
      SELECT 1 FROM "WorkerSlot" AS slot
      JOIN "Job" AS job ON job."id" = slot."jobId" AND job."ownerUserId" = slot."ownerUserId"
      JOIN "Analysis" AS analysis ON analysis."id" = job."analysisId" AND analysis."ownerUserId" = job."ownerUserId"
      WHERE slot."slotKey" = ${ANALYSIS_SLOT}
        AND slot."jobId" = ${claim.jobId} AND slot."ownerUserId" = ${claim.ownerUserId}
        AND slot."leaseTokenHash" = ${tokenHash} AND slot."leaseUntil" > clock_timestamp()
        AND job."id" = ${claim.jobId} AND job."analysisId" = ${claim.analysisId}
        AND job."ownerUserId" = ${claim.ownerUserId} AND job."type" = 'ANALYSIS'
        AND job."status" = 'RUNNING' AND job."attempt" = ${claim.attempt}
        AND job."leaseExpiresAt" > clock_timestamp()
        AND analysis."id" = ${claim.analysisId} AND analysis."ownerUserId" = ${claim.ownerUserId}
        AND analysis."status" = 'RUNNING'
    ) AS "active"
  `;
  if (rows.length !== 1) throw new Error("Invariant lease antrean tidak valid.");
  return rows[0].active;
}

/** Copy byte inputs without invoking accessor properties, before the first database await. */
function snapshotSourceBytes(input: unknown): Record<string, Uint8Array> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new Error("Source canonical tidak valid.");
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) throw new Error("Source canonical tidak valid.");
  const keys = Reflect.ownKeys(input);
  if (keys.some(key => typeof key !== "string")) throw new Error("Source canonical tidak valid.");
  const result: Record<string, Uint8Array> = Object.create(null) as Record<string, Uint8Array>;
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor) || !(descriptor.value instanceof Uint8Array)) {
      throw new Error("Source canonical tidak valid.");
    }
    result[key] = new Uint8Array(descriptor.value);
  }
  return result;
}

function bundleMatchesCanonical(
  bundle: {
    schemaVersion: string;
    configurationHash: string;
    storageLayoutVersion: number;
    canonicalContent: string | null;
    nodes: unknown;
    edges: unknown;
    nodeCount: number;
    edgeCount: number;
    contentHash: string;
  },
  canonical: Extract<ReturnType<typeof canonicalizeCkg>, { ok: true }>,
  legacySerializedMirrors?: readonly string[],
): boolean {
  if (bundle.schemaVersion !== CKG_SCHEMA_VERSION ||
      bundle.configurationHash !== canonical.value.configurationHash ||
      bundle.canonicalContent !== canonical.json || bundle.contentHash !== canonical.sha256 ||
      bundle.nodeCount !== canonical.value.counts.nodes || bundle.edgeCount !== canonical.value.counts.edges) return false;
  return storageMirrorsMatchLayout(
    bundle.storageLayoutVersion,
    bundle.canonicalContent,
    [bundle.nodes, bundle.edges],
    legacySerializedMirrors,
  );
}

export class CanonicalGraphIntegrityError extends Error {
  constructor() {
    super("Graph bundle tidak konsisten dengan CKG canonical yang tersimpan.");
    this.name = "CanonicalGraphIntegrityError";
  }
}

/** Persist a canonical graph only while this exact analysis job still owns the worker lease. */
export async function persistCanonicalGraph(
  db: PrismaClient,
  input: {
    claim: AnalysisJobClaim;
    ccm: unknown;
    sourceBytes: Readonly<Record<string, Uint8Array>>;
    configurationHash: string;
  },
): Promise<{ id: string; contentHash: string } | null> {
  // Contract validation and canonicalization consume source bytes synchronously before a DB await.
  const claim = snapshotAnalysisJobClaim(input.claim);
  const canonical = canonicalizeCkg(input.ccm, input.sourceBytes, input.configurationHash);
  if (!canonical.ok) throw new Error("CCM tidak valid untuk persistensi CKG.");
  const graph = canonical.value;
  const where = { analysisId_ownerUserId: { analysisId: claim.analysisId, ownerUserId: claim.ownerUserId } };
  const existingLayout = await db.graphBundle.findUnique({ where, select: { storageLayoutVersion: true } });
  // Legacy replay needs the historical string mirrors. Build them before acquiring
  // the lease lock; v2 writes and replays never serialize those large arrays.
  const legacySerializedMirrors = existingLayout?.storageLayoutVersion === 1
    ? [JSON.stringify(graph.ccm.nodes), JSON.stringify(graph.ccm.edges)]
    : undefined;

  const tokenHash = createHash("sha256").update(claim.leaseToken, "utf8").digest("hex");
  try {
    return await db.$transaction(async tx => {
      const locked = await tx.$queryRaw<Array<{ slotKey: string }>>`
        SELECT "slotKey" FROM "WorkerSlot" WHERE "slotKey" = ${ANALYSIS_SLOT} FOR UPDATE
      `;
      if (locked.length !== 1) throw new Error("Invariant slot antrean tidak valid.");

      if (!await hasCurrentAnalysisLease(tx, claim, tokenHash)) return null;

      const analysis = await tx.analysis.findFirst({
        where: { id: claim.analysisId, ownerUserId: claim.ownerUserId },
        select: {
          configurationHash: true,
          repositoryFullNameSnapshot: true,
          branchName: true,
          commitSha: true,
          status: true,
        },
      });
      if (!analysis) return null;
      if (analysis.status !== "RUNNING" || analysis.configurationHash !== graph.configurationHash ||
          analysis.repositoryFullNameSnapshot !== graph.ccm.snapshot.repository || analysis.branchName !== graph.ccm.snapshot.branch ||
          analysis.commitSha !== graph.ccm.snapshot.commitSha) {
        throw new Error("CKG tidak cocok dengan target analisis yang terdaftar.");
      }

      const stages = await tx.analysisStage.findMany({
        where: { analysisId: claim.analysisId, ownerUserId: claim.ownerUserId, key: { in: ["COMMON_CODE_MODEL", "KNOWLEDGE_GRAPH"] } },
        select: { key: true, status: true },
      });
      if (stages.length !== 2 || !stages.some(stage => stage.key === "COMMON_CODE_MODEL" && stage.status === "COMPLETED") ||
          !stages.some(stage => stage.key === "KNOWLEDGE_GRAPH" && stage.status === "RUNNING")) {
        throw new Error("CKG hanya dapat disimpan pada tahap graph yang aktif.");
      }

      const existing = await tx.graphBundle.findUnique({ where });
      let result: { id: string; contentHash: string };
      if (existing) {
        if (!bundleMatchesCanonical(existing, canonical, legacySerializedMirrors)) {
          throw new Error("CKG analisis bersifat immutable dan tidak cocok dengan hasil tersimpan.");
        }
        result = { id: existing.id, contentHash: existing.contentHash };
      } else {
        result = await tx.graphBundle.create({
          data: {
            ownerUserId: claim.ownerUserId,
            analysisId: claim.analysisId,
            schemaVersion: CKG_SCHEMA_VERSION,
            configurationHash: graph.configurationHash,
            storageLayoutVersion: CANONICAL_STORAGE_LAYOUT_VERSION,
            canonicalContent: canonical.json,
            nodes: Prisma.DbNull,
            edges: Prisma.DbNull,
            nodeCount: graph.counts.nodes,
            edgeCount: graph.counts.edges,
            contentHash: canonical.sha256,
          },
          select: { id: true, contentHash: true },
        });
      }
      // Slot lock prevents a new claimant from taking over, but the DB-clock lease can still
      // expire while reads/writes are in this transaction. Force rollback if it did.
      if (!await hasCurrentAnalysisLease(tx, claim, tokenHash)) throw new PersistLeaseLostError();
      return result;
    });
  } catch (error) {
    if (error instanceof PersistLeaseLostError) return null;
    throw error;
  }
}

/** Read only published owner-owned bundles; in-progress CKG rows remain worker-internal. */
export async function readCanonicalGraphForUser(
  db: PrismaClient,
  ownerUserId: string,
  analysisId: string,
  sourceBytes: Readonly<Record<string, Uint8Array>>,
): Promise<{ id: string; contentHash: string; graph: CkgV1 } | null> {
  if (typeof ownerUserId !== "string" || !ownerUserId.trim()) throw new Error("Pemilik analisis wajib diisi.");
  if (typeof analysisId !== "string" || !analysisId.trim()) throw new Error("ID analisis wajib diisi.");
  const safeSourceBytes = snapshotSourceBytes(sourceBytes);
  const record = await db.analysis.findFirst({
    where: {
      id: analysisId,
      ownerUserId,
      deletionRequestedAt: null,
      status: { in: ["COMPLETED", "COMPLETED_WITH_LIMITATIONS"] },
    },
    select: {
      configurationHash: true,
      repositoryFullNameSnapshot: true,
      branchName: true,
      commitSha: true,
      graphBundle: {
        select: {
          id: true,
          schemaVersion: true,
          configurationHash: true,
          storageLayoutVersion: true,
          canonicalContent: true,
          nodes: true,
          edges: true,
          nodeCount: true,
          edgeCount: true,
          contentHash: true,
        },
      },
    },
  });
  const bundle = record?.graphBundle;
  if (!bundle) return null;
  if (bundle.canonicalContent === null) {
    if (bundle.storageLayoutVersion === 1) return null;
    throw new CanonicalGraphIntegrityError();
  }
  const parsed = parseCanonicalCkg(bundle.canonicalContent, safeSourceBytes, bundle.contentHash);
  const legacySerializedMirrors = bundle.storageLayoutVersion === 1 && parsed.ok
    ? [JSON.stringify(parsed.value.ccm.nodes), JSON.stringify(parsed.value.ccm.edges)]
    : undefined;
  if (!parsed.ok || !bundleMatchesCanonical(bundle, parsed, legacySerializedMirrors) ||
      record.configurationHash !== parsed.value.configurationHash ||
      record.repositoryFullNameSnapshot !== parsed.value.ccm.snapshot.repository ||
      record.branchName !== parsed.value.ccm.snapshot.branch ||
      record.commitSha !== parsed.value.ccm.snapshot.commitSha) {
    throw new CanonicalGraphIntegrityError();
  }
  return { id: bundle.id, contentHash: bundle.contentHash, graph: parsed.value };
}
