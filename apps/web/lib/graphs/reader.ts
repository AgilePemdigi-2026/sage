import { readCanonicalGraphForUser } from "@sage/database";
import { projectCcmForGraph } from "../../components/graph-foundation/graph-projection.ts";
import type { GraphReadState } from "./types.ts";
import { parseSnapshotArchive } from "../../../worker/src/snapshot/archive.ts";
import { readSnapshotArchive } from "../../../worker/src/snapshot/storage.ts";

const PUBLISHED_ANALYSIS_STATUSES = ["COMPLETED", "COMPLETED_WITH_LIMITATIONS"] as const;

class GraphReadUnavailableError extends Error {
  constructor() {
    super("Published graph result is unavailable.");
    this.name = "GraphReadUnavailableError";
  }
}

export interface GraphReadDatabase {
  analysis: {
    findFirst(args: { where: { id: string; ownerUserId: string }; select: { status: true } }): Promise<{ status: string } | null>;
  };
  storageObject: {
    findFirst(args: {
      where: { ownerUserId: string; analysisId: string; type: "SOURCE_ARCHIVE"; status: "ACTIVE" };
      orderBy: [{ createdAt: "desc" }, { id: "desc" }];
      select: { id: true };
    }): Promise<{ id: string } | null>;
  };
}

/**
 * Read one user's published graph from the canonical CKG and its immutable source archive.
 * The owner-bound analysis check deliberately precedes any lookup that can lead to disk I/O.
 */
export async function loadGraphForUser(
  db: GraphReadDatabase,
  ownerUserId: string,
  analysisId: string,
  storageRoot: string,
): Promise<GraphReadState> {
  const analysis = await db.analysis.findFirst({
    where: { id: analysisId, ownerUserId },
    select: { status: true },
  });
  if (!analysis) return { kind: "not-found" };
  if (!(PUBLISHED_ANALYSIS_STATUSES as readonly string[]).includes(analysis.status)) return { kind: "not-ready" };

  const snapshot = await db.storageObject.findFirst({
    where: { ownerUserId, analysisId, type: "SOURCE_ARCHIVE", status: "ACTIVE" },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { id: true },
  });
  if (!snapshot) throw new GraphReadUnavailableError();

  const storageDb = db as unknown as Parameters<typeof readSnapshotArchive>[0];
  const archive = await readSnapshotArchive(storageDb, {
    storageRoot,
    ownerUserId,
    analysisId,
    storageObjectId: snapshot.id,
  });
  const parsed = await parseSnapshotArchive(archive);
  const sourceBytes = Object.fromEntries(parsed.files.map(file => [file.relativePath, file.bytes]));
  const canonicalDb = db as unknown as Parameters<typeof readCanonicalGraphForUser>[0];
  const canonical = await readCanonicalGraphForUser(canonicalDb, ownerUserId, analysisId, sourceBytes);
  if (!canonical) throw new GraphReadUnavailableError();

  const counts = canonical.graph.counts;
  return {
    kind: "ready",
    value: {
      analysisId,
      ckgSha256: canonical.contentHash,
      configurationHash: canonical.graph.configurationHash,
      snapshot: canonical.graph.ccm.snapshot,
      provenance: canonical.graph.ccm.provenance,
      canonicalCounts: counts,
      filteredCounts: { nodes: counts.nodes, edges: counts.edges },
      returnedCounts: { nodes: counts.nodes, edges: counts.edges },
      paginated: false,
      limitations: canonical.graph.ccm.limitations,
      graph: projectCcmForGraph(canonical.graph.ccm),
    },
  };
}
