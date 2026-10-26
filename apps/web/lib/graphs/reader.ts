import { createHash } from "node:crypto";
import { readCanonicalGraphForUser } from "@sage/database";
import type { CkgV1 } from "@sage/contracts";
import { projectCcmForGraph } from "../../components/graph-foundation/graph-projection.ts";
import type { GraphReadState } from "./types.ts";
import type {
  NodeInspectorFile,
  NodeInspectorNode,
  NodeInspectorPayload,
  NodeInspectorReadState,
  NodeInspectorRelation,
  SourceReadState,
} from "./inspector-types.ts";
import { SOURCE_PREVIEW_MAX_BYTES, SOURCE_PREVIEW_MAX_LINES } from "./inspector-types.ts";
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

export type VerifiedGraphReadState =
  | {
      kind: "ready";
      value: {
        analysisId: string;
        ckgSha256: string;
        configurationHash: string;
        graph: CkgV1;
        sourceBytes: Readonly<Record<string, Uint8Array>>;
      };
    }
  | { kind: "not-found" }
  | { kind: "not-ready" };

/**
 * Reload a published graph only after an owner-bound status check, then replay
 * its canonical CKG against the latest active immutable source archive.
 */
export async function loadVerifiedGraphForUser(
  db: GraphReadDatabase,
  ownerUserId: string,
  analysisId: string,
  storageRoot: string,
): Promise<VerifiedGraphReadState> {
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

  return {
    kind: "ready",
    value: {
      analysisId,
      ckgSha256: canonical.contentHash,
      configurationHash: canonical.graph.configurationHash,
      graph: canonical.graph,
      sourceBytes,
    },
  };
}

/** Read one user's published graph from its canonical CKG and immutable source archive. */
export async function loadGraphForUser(
  db: GraphReadDatabase,
  ownerUserId: string,
  analysisId: string,
  storageRoot: string,
): Promise<GraphReadState> {
  const verified = await loadVerifiedGraphForUser(db, ownerUserId, analysisId, storageRoot);
  if (verified.kind !== "ready") return verified;

  const canonical = verified.value.graph;
  const counts = canonical.counts;
  return {
    kind: "ready",
    value: {
      analysisId,
      ckgSha256: verified.value.ckgSha256,
      configurationHash: canonical.configurationHash,
      snapshot: canonical.ccm.snapshot,
      provenance: canonical.ccm.provenance,
      canonicalCounts: counts,
      filteredCounts: { nodes: counts.nodes, edges: counts.edges },
      returnedCounts: { nodes: counts.nodes, edges: counts.edges },
      paginated: false,
      limitations: canonical.ccm.limitations,
      graph: projectCcmForGraph(canonical.ccm),
    },
  };
}

function fileId(path: string, sha256: string): string {
  return `file-${createHash("sha256").update(`${path}\0${sha256}`, "utf8").digest("hex")}`;
}

function fileRef(file: CkgV1["ccm"]["files"][number]): NodeInspectorFile {
  return { id: fileId(file.path, file.sha256), path: file.path, sha256: file.sha256, sizeBytes: file.sizeBytes };
}

function inspectorNode(node: CkgV1["ccm"]["nodes"][number]): NodeInspectorNode {
  return {
    id: node.id,
    kind: node.kind,
    name: node.name,
    qualifiedName: node.qualifiedName,
    language: node.language,
    filePath: node.filePath,
    location: node.location,
    parentId: node.parentId,
    origin: node.origin,
    signature: node.signature,
  };
}

function referencedProcessedFiles(graph: CkgV1): NodeInspectorFile[] {
  const referencedPaths = new Set<string>();
  for (const node of graph.ccm.nodes) {
    if (node.location) referencedPaths.add(node.location.filePath);
  }
  for (const edge of graph.ccm.edges) {
    for (const evidence of edge.evidence) referencedPaths.add(evidence.filePath);
  }
  return graph.ccm.files
    .filter(file => file.status === "processed" && referencedPaths.has(file.path))
    .map(fileRef)
    .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}

function inspectorBindings(analysisId: string, ckgSha256: string, configurationHash: string, graph: CkgV1) {
  return {
    analysisId,
    ckgSha256,
    configurationHash,
    snapshot: graph.ccm.snapshot,
  };
}

/** Build a direct-neighborhood detail view using only canonical graph relations. */
export async function loadNodeInspectorForUser(
  db: GraphReadDatabase,
  ownerUserId: string,
  analysisId: string,
  nodeId: string,
  storageRoot: string,
): Promise<NodeInspectorReadState> {
  const verified = await loadVerifiedGraphForUser(db, ownerUserId, analysisId, storageRoot);
  if (verified.kind !== "ready") return verified;

  const { graph } = verified.value;
  const node = graph.ccm.nodes.find(item => item.id === nodeId);
  if (!node) return { kind: "item-not-found" };

  const nodes = new Map(graph.ccm.nodes.map(item => [item.id, item]));
  const incoming: NodeInspectorRelation[] = [];
  const outgoing: NodeInspectorRelation[] = [];
  const visiblePaths = new Set<string>();
  if (node.location) visiblePaths.add(node.location.filePath);
  for (const edge of graph.ccm.edges) {
    if (edge.targetId === node.id) {
      const peer = nodes.get(edge.sourceId);
      if (peer) incoming.push({ edge, peer: inspectorNode(peer) });
      for (const evidence of edge.evidence) visiblePaths.add(evidence.filePath);
    }
    if (edge.sourceId === node.id) {
      const peer = nodes.get(edge.targetId);
      if (peer) outgoing.push({ edge, peer: inspectorNode(peer) });
      for (const evidence of edge.evidence) visiblePaths.add(evidence.filePath);
    }
  }
  const files = graph.ccm.files
    .filter(file => file.status === "processed" && visiblePaths.has(file.path))
    .map(fileRef)
    .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);

  const value: Omit<NodeInspectorPayload, "accountKey"> = {
    ...inspectorBindings(analysisId, verified.value.ckgSha256, graph.configurationHash, graph),
    node: inspectorNode(node),
    incoming,
    outgoing,
    files,
  };
  return { kind: "ready", value };
}

/**
 * Read only processed files cited by canonical node/edge evidence. Hashes are
 * replayed before a small, inclusive line window is decoded for the client.
 */
export async function loadSourceForUser(
  db: GraphReadDatabase,
  ownerUserId: string,
  analysisId: string,
  requestedFileId: string,
  startLine: number,
  requestedEndLine: number,
  storageRoot: string,
): Promise<SourceReadState> {
  const verified = await loadVerifiedGraphForUser(db, ownerUserId, analysisId, storageRoot);
  if (verified.kind !== "ready") return verified;

  const { graph, sourceBytes } = verified.value;
  const file = referencedProcessedFiles(graph).find(item => item.id === requestedFileId);
  if (!file) return { kind: "item-not-found" };

  const source = sourceBytes[file.path];
  if (!source || source.byteLength !== file.sizeBytes || createHash("sha256").update(source).digest("hex") !== file.sha256) {
    throw new GraphReadUnavailableError();
  }
  try {
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(source);
  } catch {
    throw new GraphReadUnavailableError();
  }

  const lineStarts = [0];
  for (let index = 0; index < source.byteLength; index += 1) {
    if (source[index] === 0x0a) lineStarts.push(index + 1);
  }
  const totalLines = lineStarts.length;
  if (startLine > totalLines) return { kind: "range-invalid" };
  const endLine = Math.min(requestedEndLine, totalLines);
  if (endLine - startLine + 1 > SOURCE_PREVIEW_MAX_LINES) return { kind: "range-too-large" };

  const byteStart = lineStarts[startLine - 1]!;
  const byteEnd = lineStarts[endLine] ?? source.byteLength;
  const selected = source.subarray(byteStart, byteEnd);
  if (selected.byteLength > SOURCE_PREVIEW_MAX_BYTES) return { kind: "range-too-large" };

  return {
    kind: "ready",
    value: {
      ...inspectorBindings(analysisId, verified.value.ckgSha256, graph.configurationHash, graph),
      file,
      startLine,
      endLine,
      totalLines,
      // Buffer decoding keeps an initial UTF-8 BOM and retains CRLF bytes as text.
      text: Buffer.from(selected).toString("utf8"),
    },
  };
}
