import { createHash } from "node:crypto";
import { parseCanonicalCkg } from "@sage/contracts";
import { parseCanonicalArchitectureDocument } from "@sage/documents/model";
import { Prisma, type PrismaClient } from "../generated/client.ts";

const MAX_CANONICAL_BYTES = 128 * 1024 * 1024;
const TRANSACTION_OPTIONS = { maxWait: 10_000, timeout: 60_000 };

type JsonObject = Record<string, unknown>;
type GraphRow = {
  id: string; ownerUserId: string; analysisId: string; storageLayoutVersion: number;
  canonicalContent: string | null; contentHash: string; schemaVersion: string; configurationHash: string;
  nodes: unknown; edges: unknown; nodeCount: number; edgeCount: number;
};
type DocumentRow = {
  id: string; ownerUserId: string; analysisId: string; storageLayoutVersion: number;
  canonicalContent: string | null; contentHash: string; title: string; documentModelVersion: string;
  interfaceCatalog: unknown; softwareEngineeringDiagram: unknown; umlClassDiagram: unknown;
};
type Target = { id: string; ownerUserId: string; configurationHash: string; repositoryFullNameSnapshot: string | null; branchName: string; commitSha: string };
export type StorageCompactionResult = {
  status: "eligible" | "compacted" | "unchanged" | "skipped";
  reason: "NOT_FOUND" | "ACTIVE_ANALYSIS" | "DELETION_PENDING" | "LEGACY_UNVERIFIABLE" | "INTEGRITY_ERROR" | "PAYLOAD_TOO_LARGE" | null;
  graphs: number; documents: number; canonicalBytes: number; removableMirrorBytes: number;
};

class InvalidStorage extends Error {
  constructor(readonly reason: NonNullable<StorageCompactionResult["reason"]>) { super(reason); }
}
function object(value: unknown): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new InvalidStorage("INTEGRITY_ERROR");
  return value as JsonObject;
}
function canonical(value: string | null, hash: string): JsonObject {
  if (value === null) throw new InvalidStorage("LEGACY_UNVERIFIABLE");
  if (Buffer.byteLength(value, "utf8") > MAX_CANONICAL_BYTES) throw new InvalidStorage("PAYLOAD_TOO_LARGE");
  if (!/^[a-f0-9]{64}$/.test(hash) || createHash("sha256").update(value).digest("hex") !== hash) throw new InvalidStorage("INTEGRITY_ERROR");
  try { return object(JSON.parse(value)); } catch { throw new InvalidStorage("INTEGRITY_ERROR"); }
}
function snapshotMatches(value: unknown, target: Target): boolean {
  const snapshot = object(value);
  return target.repositoryFullNameSnapshot !== null && snapshot.repository === target.repositoryFullNameSnapshot &&
    snapshot.branch === target.branchName && snapshot.commitSha === target.commitSha;
}
function mirrors(version: number, values: unknown[], expected: (() => unknown)[]): number {
  if (version === 2) {
    if (values.some(value => value !== null)) throw new InvalidStorage("INTEGRITY_ERROR");
    return 0;
  }
  if (version !== 1) throw new InvalidStorage("INTEGRITY_ERROR");
  let bytes = 0;
  for (let i = 0; i < values.length; i += 1) {
    const value = values[i];
    if (typeof value !== "string" || value !== JSON.stringify(expected[i]())) throw new InvalidStorage("INTEGRITY_ERROR");
    bytes += Buffer.byteLength(value, "utf8");
  }
  return bytes;
}

/** Storage consistency only: canonical bytes/hashes are never regenerated or changed. */
export function inspectCanonicalStorage(target: Target, graph: GraphRow | null, document: DocumentRow | null): {
  graphs: number; documents: number; canonicalBytes: number; removableMirrorBytes: number;
} {
  let canonicalBytes = 0;
  let removableMirrorBytes = 0;
  if (graph) {
    const parsed = canonical(graph.canonicalContent, graph.contentHash);
    const ccm = object(parsed.ccm);
    const counts = object(parsed.counts);
    if (graph.ownerUserId !== target.ownerUserId || graph.analysisId !== target.id ||
        parsed.schemaVersion !== "sage-ckg-v1" || graph.schemaVersion !== parsed.schemaVersion ||
        graph.configurationHash !== target.configurationHash || parsed.configurationHash !== target.configurationHash ||
        !snapshotMatches(ccm.snapshot, target) || !Array.isArray(ccm.nodes) || !Array.isArray(ccm.edges) ||
        counts.nodes !== graph.nodeCount || counts.edges !== graph.edgeCount ||
        graph.nodeCount !== ccm.nodes.length || graph.edgeCount !== ccm.edges.length) throw new InvalidStorage("INTEGRITY_ERROR");
    removableMirrorBytes += mirrors(graph.storageLayoutVersion, [graph.nodes, graph.edges], [() => ccm.nodes, () => ccm.edges]);
    canonicalBytes += Buffer.byteLength(graph.canonicalContent!, "utf8");
  }
  if (document) {
    if (!graph) throw new InvalidStorage("INTEGRITY_ERROR");
    const parsed = canonical(document.canonicalContent, document.contentHash);
    if (document.ownerUserId !== target.ownerUserId || document.analysisId !== target.id ||
        parsed.schemaVersion !== "sage-add-v1" || document.documentModelVersion !== parsed.schemaVersion ||
        document.title !== parsed.title || parsed.ckgSha256 !== graph.contentHash || parsed.configurationHash !== target.configurationHash ||
        !snapshotMatches(parsed.snapshot, target) || parsed.interfaceCatalog === undefined ||
        parsed.softwareEngineeringDiagram === undefined || parsed.umlClassDiagram === undefined) throw new InvalidStorage("INTEGRITY_ERROR");
    removableMirrorBytes += mirrors(document.storageLayoutVersion,
      [document.interfaceCatalog, document.softwareEngineeringDiagram, document.umlClassDiagram],
      [() => parsed.interfaceCatalog, () => parsed.softwareEngineeringDiagram, () => parsed.umlClassDiagram]);
    canonicalBytes += Buffer.byteLength(document.canonicalContent!, "utf8");
  }
  return {
    graphs: graph?.storageLayoutVersion === 1 ? 1 : 0,
    documents: document?.storageLayoutVersion === 1 ? 1 : 0,
    canonicalBytes,
    removableMirrorBytes,
  };
}

/** Trusted operator operation; not an HTTP API. Locks one inactive analysis before its result rows. */
export async function compactAnalysisStorage(db: PrismaClient, analysisId: string, options: { apply?: boolean; sourceBytes?: Readonly<Record<string, Uint8Array>> } = {}): Promise<StorageCompactionResult> {
  if (typeof analysisId !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(analysisId)) throw new Error("Invalid analysis ID.");
  if (options.apply !== undefined && typeof options.apply !== "boolean") throw new Error("Invalid apply option.");
  const sourceBytes = options.sourceBytes === undefined ? undefined : Object.fromEntries(Object.entries(options.sourceBytes).map(([path, bytes]) => [path, new Uint8Array(bytes)]));
  const empty = { graphs: 0, documents: 0, canonicalBytes: 0, removableMirrorBytes: 0 };
  try {
    return await db.$transaction(async tx => {
      const targets = await tx.$queryRaw<Array<Target & { status: string; deletionRequestedAt: Date | null }>>`
        SELECT "id", "ownerUserId", "configurationHash", "repositoryFullNameSnapshot", "branchName", "commitSha", "status"::text AS "status", "deletionRequestedAt"
        FROM "Analysis" WHERE "id" = ${analysisId} FOR UPDATE
      `;
      const target = targets[0];
      if (!target) return { status: "skipped", reason: "NOT_FOUND", ...empty };
      if (target.deletionRequestedAt !== null) return { status: "skipped", reason: "DELETION_PENDING", ...empty };
      if (target.status === "QUEUED" || target.status === "RUNNING") return { status: "skipped", reason: "ACTIVE_ANALYSIS", ...empty };
      // Avoid transferring an unexpectedly large payload into this maintenance process.
      const sizes = await tx.$queryRaw<Array<{ tooLarge: boolean }>>`
        SELECT (COALESCE((SELECT COALESCE(octet_length("canonicalContent"), 0)::bigint
            + COALESCE(octet_length("nodes"::text), 0) + COALESCE(octet_length("edges"::text), 0)
          FROM "GraphBundle" WHERE "analysisId" = ${analysisId}), 0)
          + COALESCE((SELECT COALESCE(octet_length("canonicalContent"), 0)::bigint
            + COALESCE(octet_length("interfaceCatalog"::text), 0)
            + COALESCE(octet_length("softwareEngineeringDiagram"::text), 0)
            + COALESCE(octet_length("umlClassDiagram"::text), 0)
          FROM "ArchitectureDocument" WHERE "analysisId" = ${analysisId}), 0) > ${MAX_CANONICAL_BYTES}) AS "tooLarge"
      `;
      if (sizes[0]?.tooLarge) return { status: "skipped", reason: "PAYLOAD_TOO_LARGE", ...empty };
      // Result rows are immutable once terminal; the Analysis lock serializes deletion.
      const where = { analysisId_ownerUserId: { analysisId, ownerUserId: target.ownerUserId } };
      const graph = await tx.graphBundle.findUnique({ where });
      const document = await tx.architectureDocument.findUnique({ where });
      const inspection = inspectCanonicalStorage(target, graph, document);
      if (graph) {
        if (sourceBytes === undefined || graph.canonicalContent === null) throw new InvalidStorage("LEGACY_UNVERIFIABLE");
        const verified = document
          ? parseCanonicalArchitectureDocument(document.canonicalContent!, graph.canonicalContent, sourceBytes, document.contentHash, graph.contentHash)
          : parseCanonicalCkg(graph.canonicalContent, sourceBytes, graph.contentHash);
        if (!verified.ok) throw new InvalidStorage("INTEGRITY_ERROR");
      }
      if (!inspection.graphs && !inspection.documents) return { status: "unchanged", reason: null, ...inspection };
      if (!options.apply) return { status: "eligible", reason: null, ...inspection };
      if (graph && inspection.graphs) await tx.graphBundle.update({
        where, data: { storageLayoutVersion: 2, nodes: Prisma.DbNull, edges: Prisma.DbNull },
        select: { id: true },
      });
      if (document && inspection.documents) await tx.architectureDocument.update({
        where, data: { storageLayoutVersion: 2, interfaceCatalog: Prisma.DbNull, softwareEngineeringDiagram: Prisma.DbNull, umlClassDiagram: Prisma.DbNull },
        select: { id: true },
      });
      return { status: "compacted", reason: null, ...inspection };
    }, TRANSACTION_OPTIONS);
  } catch (error) {
    if (error instanceof InvalidStorage) return { status: "skipped", reason: error.reason, ...empty };
    throw error;
  }
}
