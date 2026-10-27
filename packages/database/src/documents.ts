import { createHash } from "node:crypto";
import { parseCanonicalCkg } from "@sage/contracts";
import {
  parseCanonicalArchitectureDocument,
  projectArchitectureDocument,
} from "@sage/documents/model";
import type { ArchitectureDocumentV1 } from "@sage/documents/model";
import type { Prisma, PrismaClient } from "../generated/client.ts";
import { snapshotAnalysisJobClaim } from "./queue.ts";
import type { AnalysisJobClaim } from "./queue.ts";
import { ANALYSIS_DOCUMENT_TRANSACTION_OPTIONS } from "./analysis-timing.ts";

const ANALYSIS_SLOT = "analysis";
const DOCUMENT_STAGE_KEYS = [
  "KNOWLEDGE_GRAPH",
  "INTERFACE_CATALOG",
  "SOFTWARE_ENGINEERING_DIAGRAM",
  "UML_CLASS_DIAGRAM",
] as const;

class PersistLeaseLostError extends Error {}

interface PersistCanonicalDocumentInput {
  claim: AnalysisJobClaim;
  canonicalCkgJson: string;
  sourceBytes: Readonly<Record<string, Uint8Array>>;
  expectedCkgSha256?: string;
}

interface CanonicalGraphBundle {
  id: string;
  ownerUserId: string;
  analysisId: string;
  schemaVersion: string;
  configurationHash: string;
  canonicalContent: string | null;
  nodes: unknown;
  edges: unknown;
  nodeCount: number;
  edgeCount: number;
  contentHash: string;
}

interface CanonicalDocumentRow {
  id: string;
  ownerUserId: string;
  analysisId: string;
  title: string;
  documentModelVersion: string;
  interfaceCatalog: unknown;
  softwareEngineeringDiagram: unknown;
  umlClassDiagram: unknown;
  canonicalContent: string | null;
  contentHash: string;
}

/** Safe integrity failure for a published document that cannot be replayed from its CKG. */
export class CanonicalDocumentIntegrityError extends Error {
  constructor() {
    super("Dokumen arsitektur tidak konsisten dengan CKG canonical yang tersimpan.");
    this.name = "CanonicalDocumentIntegrityError";
  }
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

/** Snapshot exactly the trusted persistence inputs without evaluating caller-supplied getters. */
function snapshotDocumentInput(input: PersistCanonicalDocumentInput): {
  claim: AnalysisJobClaim;
  canonicalCkgJson: string;
  sourceBytes: Record<string, Uint8Array>;
  expectedCkgSha256: string | undefined;
} {
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new Error("Input dokumen canonical tidak valid.");
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) throw new Error("Input dokumen canonical tidak valid.");
  const fields = ["claim", "canonicalCkgJson", "sourceBytes", "expectedCkgSha256"] as const;
  const keys = Reflect.ownKeys(input);
  if (keys.some(key => typeof key !== "string" || !fields.includes(key as typeof fields[number])) ||
      !keys.includes("claim") || !keys.includes("canonicalCkgJson") || !keys.includes("sourceBytes")) {
    throw new Error("Input dokumen canonical memiliki field yang tidak valid.");
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  for (const field of keys as (typeof fields[number])[]) {
    const descriptor = descriptors[field];
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      throw new Error("Input dokumen canonical harus memakai properti data biasa.");
    }
  }
  const canonicalCkgJson = descriptors.canonicalCkgJson.value;
  if (typeof canonicalCkgJson !== "string") throw new Error("CKG canonical tidak valid.");
  const expectedCkgSha256 = descriptors.expectedCkgSha256?.value;
  if (expectedCkgSha256 !== undefined && typeof expectedCkgSha256 !== "string") {
    throw new Error("Hash CKG canonical tidak valid.");
  }
  return {
    claim: snapshotAnalysisJobClaim(descriptors.claim.value as AnalysisJobClaim),
    canonicalCkgJson,
    sourceBytes: snapshotSourceBytes(descriptors.sourceBytes.value),
    expectedCkgSha256: expectedCkgSha256 as string | undefined,
  };
}

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

function graphBundleMatchesCanonical(
  bundle: CanonicalGraphBundle,
  canonical: Extract<ReturnType<typeof parseCanonicalCkg>, { ok: true }>,
  serializedMirrors = {
    nodes: JSON.stringify(canonical.value.ccm.nodes),
    edges: JSON.stringify(canonical.value.ccm.edges),
  },
): boolean {
  return bundle.schemaVersion === "sage-ckg-v1" &&
    bundle.configurationHash === canonical.value.configurationHash &&
    bundle.canonicalContent === canonical.json &&
    bundle.contentHash === canonical.sha256 &&
    bundle.nodeCount === canonical.value.counts.nodes &&
    bundle.edgeCount === canonical.value.counts.edges &&
    bundle.nodes === serializedMirrors.nodes &&
    bundle.edges === serializedMirrors.edges;
}

function documentRowMatchesCanonical(
  row: CanonicalDocumentRow,
  ownerUserId: string,
  analysisId: string,
  canonical: Extract<ReturnType<typeof projectArchitectureDocument>, { ok: true }>,
  serializedMirrors: { interfaceCatalog: string; softwareEngineeringDiagram: string; umlClassDiagram: string },
): boolean {
  return row.ownerUserId === ownerUserId && row.analysisId === analysisId &&
    row.canonicalContent === canonical.json && row.contentHash === canonical.sha256 &&
    row.title === canonical.value.title && row.documentModelVersion === canonical.value.schemaVersion &&
    row.interfaceCatalog === serializedMirrors.interfaceCatalog &&
    row.softwareEngineeringDiagram === serializedMirrors.softwareEngineeringDiagram &&
    row.umlClassDiagram === serializedMirrors.umlClassDiagram;
}

/** Persist one canonical architecture document while this exact analysis job owns the worker lease. */
export async function persistCanonicalDocument(
  db: PrismaClient,
  input: PersistCanonicalDocumentInput,
): Promise<{ id: string; contentHash: string } | null> {
  // Snapshot and derive every source-backed artifact synchronously before the first database await.
  const safeInput = snapshotDocumentInput(input);
  const parsedGraph = parseCanonicalCkg(safeInput.canonicalCkgJson, safeInput.sourceBytes, safeInput.expectedCkgSha256);
  if (!parsedGraph.ok) throw new Error("CKG canonical tidak valid untuk persistensi dokumen.");
  const canonical = projectArchitectureDocument(
    safeInput.canonicalCkgJson,
    safeInput.sourceBytes,
    safeInput.expectedCkgSha256,
  );
  if (!canonical.ok) throw new Error("Dokumen arsitektur tidak dapat dibentuk dari CKG canonical.");
  // Serialize each large JSON mirror before opening the transaction so CPU work does
  // not consume the lease while the WorkerSlot row is locked.
  const serializedGraphMirrors = {
    nodes: JSON.stringify(parsedGraph.value.ccm.nodes),
    edges: JSON.stringify(parsedGraph.value.ccm.edges),
  };
  const serializedDocumentMirrors = {
    interfaceCatalog: JSON.stringify(canonical.value.interfaceCatalog),
    softwareEngineeringDiagram: JSON.stringify(canonical.value.softwareEngineeringDiagram),
    umlClassDiagram: JSON.stringify(canonical.value.umlClassDiagram),
  };
  const claim = safeInput.claim;
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
      if (analysis.status !== "RUNNING" ||
          analysis.configurationHash !== parsedGraph.value.configurationHash ||
          analysis.configurationHash !== canonical.value.configurationHash ||
          analysis.repositoryFullNameSnapshot !== parsedGraph.value.ccm.snapshot.repository ||
          analysis.branchName !== parsedGraph.value.ccm.snapshot.branch ||
          analysis.commitSha !== parsedGraph.value.ccm.snapshot.commitSha) {
        throw new Error("CKG tidak cocok dengan target analisis yang terdaftar.");
      }

      const stages = await tx.analysisStage.findMany({
        where: { analysisId: claim.analysisId, ownerUserId: claim.ownerUserId, key: { in: [...DOCUMENT_STAGE_KEYS, "ARCHITECTURE_DOCUMENT"] } },
        select: { key: true, status: true },
      });
      const statuses = new Map(stages.map(stage => [stage.key, stage.status]));
      if (stages.length !== DOCUMENT_STAGE_KEYS.length + 1 ||
          DOCUMENT_STAGE_KEYS.some(key => statuses.get(key) !== "COMPLETED") ||
          statuses.get("ARCHITECTURE_DOCUMENT") !== "RUNNING") {
        throw new Error("Dokumen hanya dapat disimpan pada tahap architecture document yang aktif.");
      }

      const graphBundle = await tx.graphBundle.findUnique({
        where: { analysisId_ownerUserId: { analysisId: claim.analysisId, ownerUserId: claim.ownerUserId } },
        select: {
          id: true,
          ownerUserId: true,
          analysisId: true,
          schemaVersion: true,
          configurationHash: true,
          canonicalContent: true,
          nodes: true,
          edges: true,
          nodeCount: true,
          edgeCount: true,
          contentHash: true,
        },
      });
      if (!graphBundle || graphBundle.ownerUserId !== claim.ownerUserId || graphBundle.analysisId !== claim.analysisId ||
          graphBundle.canonicalContent === null || !graphBundleMatchesCanonical(graphBundle, parsedGraph, serializedGraphMirrors)) {
        throw new Error("Graph bundle tidak konsisten dengan CKG canonical yang diberikan.");
      }

      const where = { analysisId_ownerUserId: { analysisId: claim.analysisId, ownerUserId: claim.ownerUserId } };
      const existing = await tx.architectureDocument.findUnique({
        where,
        select: {
          id: true,
          ownerUserId: true,
          analysisId: true,
          title: true,
          documentModelVersion: true,
          interfaceCatalog: true,
          softwareEngineeringDiagram: true,
          umlClassDiagram: true,
          canonicalContent: true,
          contentHash: true,
        },
      });
      let result: { id: string; contentHash: string };
      if (existing) {
        if (!documentRowMatchesCanonical(existing, claim.ownerUserId, claim.analysisId, canonical, serializedDocumentMirrors)) {
          throw new Error("Dokumen arsitektur bersifat immutable dan tidak cocok dengan hasil tersimpan.");
        }
        result = { id: existing.id, contentHash: existing.contentHash };
      } else {
        result = await tx.architectureDocument.create({
          data: {
            ownerUserId: claim.ownerUserId,
            analysisId: claim.analysisId,
            title: canonical.value.title,
            documentModelVersion: canonical.value.schemaVersion,
            interfaceCatalog: serializedDocumentMirrors.interfaceCatalog,
            softwareEngineeringDiagram: serializedDocumentMirrors.softwareEngineeringDiagram,
            umlClassDiagram: serializedDocumentMirrors.umlClassDiagram,
            canonicalContent: canonical.json,
            contentHash: canonical.sha256,
          },
          select: { id: true, contentHash: true },
        });
      }

      // The slot lock prevents takeover; the final DB-clock check also rejects an insert that
      // ran past the lease deadline. Throwing aborts the transaction and rolls the write back.
      if (!await hasCurrentAnalysisLease(tx, claim, tokenHash)) throw new PersistLeaseLostError();
      return result;
    }, ANALYSIS_DOCUMENT_TRANSACTION_OPTIONS);
  } catch (error) {
    if (error instanceof PersistLeaseLostError) return null;
    throw error;
  }
}

/** Read only published documents, replaying the document and graph against the supplied source bytes. */
export async function readCanonicalDocumentForUser(
  db: PrismaClient,
  ownerUserId: string,
  analysisId: string,
  sourceBytes: Readonly<Record<string, Uint8Array>>,
): Promise<{ id: string; contentHash: string; document: ArchitectureDocumentV1 } | null> {
  if (typeof ownerUserId !== "string" || !ownerUserId.trim()) throw new Error("Pemilik analisis wajib diisi.");
  if (typeof analysisId !== "string" || !analysisId.trim()) throw new Error("ID analisis wajib diisi.");
  const safeSourceBytes = snapshotSourceBytes(sourceBytes);
  const record = await db.analysis.findFirst({
    where: { id: analysisId, ownerUserId, deletionRequestedAt: null, status: { in: ["COMPLETED", "COMPLETED_WITH_LIMITATIONS"] } },
    select: {
      configurationHash: true,
      repositoryFullNameSnapshot: true,
      branchName: true,
      commitSha: true,
      graphBundle: {
        select: {
          id: true,
          ownerUserId: true,
          analysisId: true,
          schemaVersion: true,
          configurationHash: true,
          canonicalContent: true,
          nodes: true,
          edges: true,
          nodeCount: true,
          edgeCount: true,
          contentHash: true,
        },
      },
      architectureDocument: {
        select: {
          id: true,
          ownerUserId: true,
          analysisId: true,
          title: true,
          documentModelVersion: true,
          interfaceCatalog: true,
          softwareEngineeringDiagram: true,
          umlClassDiagram: true,
          canonicalContent: true,
          contentHash: true,
        },
      },
    },
  });
  const row = record?.architectureDocument;
  // Pre-DOC01 documents did not retain a canonical replay payload; keep them absent to callers.
  if (!record || !row || row.canonicalContent === null) return null;

  const bundle = record.graphBundle;
  if (!bundle || bundle.canonicalContent === null) throw new CanonicalDocumentIntegrityError();
  const parsedGraph = parseCanonicalCkg(bundle.canonicalContent, safeSourceBytes, bundle.contentHash);
  if (!parsedGraph.ok || !graphBundleMatchesCanonical(bundle, parsedGraph) ||
      bundle.ownerUserId !== ownerUserId || bundle.analysisId !== analysisId ||
      record.configurationHash !== parsedGraph.value.configurationHash ||
      record.repositoryFullNameSnapshot !== parsedGraph.value.ccm.snapshot.repository ||
      record.branchName !== parsedGraph.value.ccm.snapshot.branch ||
      record.commitSha !== parsedGraph.value.ccm.snapshot.commitSha) {
    throw new CanonicalDocumentIntegrityError();
  }

  const parsedDocument = parseCanonicalArchitectureDocument(
    row.canonicalContent,
    bundle.canonicalContent,
    safeSourceBytes,
    row.contentHash,
    bundle.contentHash,
  );
  if (!parsedDocument.ok || row.ownerUserId !== ownerUserId || row.analysisId !== analysisId ||
      row.title !== parsedDocument.value.title || row.documentModelVersion !== parsedDocument.value.schemaVersion ||
      row.interfaceCatalog !== JSON.stringify(parsedDocument.value.interfaceCatalog) ||
      row.softwareEngineeringDiagram !== JSON.stringify(parsedDocument.value.softwareEngineeringDiagram) ||
      row.umlClassDiagram !== JSON.stringify(parsedDocument.value.umlClassDiagram) ||
      parsedDocument.value.configurationHash !== record.configurationHash ||
      parsedDocument.value.snapshot.repository !== record.repositoryFullNameSnapshot ||
      parsedDocument.value.snapshot.branch !== record.branchName ||
      parsedDocument.value.snapshot.commitSha !== record.commitSha) {
    throw new CanonicalDocumentIntegrityError();
  }
  return { id: row.id, contentHash: row.contentHash, document: parsedDocument.value };
}
