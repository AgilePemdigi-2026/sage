import type { CcmV1, CcmEdge, CcmNode, EdgeResolution, NodeKind } from "@sage/contracts";

export type GraphCategory = "Berkas" | "Struktur" | "Simbol" | "Belum terpecahkan";

export interface GraphNodeView {
  id: string;
  name: string;
  label: string;
  kind: NodeKind;
  category: GraphCategory;
  origin: CcmNode["origin"];
  qualifiedName: string;
  filePath: string | null;
  line: number | null;
}

export interface GraphEdgeView {
  id: string;
  source: string;
  target: string;
  kind: CcmEdge["kind"];
  resolution: EdgeResolution;
  label: string;
  unresolvedReason: CcmEdge["unresolvedReason"];
}

export interface GraphViewModel {
  repository: string;
  branch: string | null;
  commitSha: string;
  nodes: GraphNodeView[];
  edges: GraphEdgeView[];
}

function categoryFor(kind: NodeKind): GraphCategory {
  if (kind === "Module") return "Berkas";
  if (kind === "Class" || kind === "Interface") return "Struktur";
  if (kind === "UnresolvedReference") return "Belum terpecahkan";
  return "Simbol";
}

/** Projects validated CCM facts into display data without rewriting the model. */
export function projectCcmForGraph(model: CcmV1): GraphViewModel {
  return {
    repository: model.snapshot.repository,
    branch: model.snapshot.branch,
    commitSha: model.snapshot.commitSha,
    nodes: model.nodes.map((node) => ({
      id: node.id,
      name: node.name,
      label: `${node.name}\n${node.kind}`,
      kind: node.kind,
      category: categoryFor(node.kind),
      origin: node.origin,
      qualifiedName: node.qualifiedName,
      filePath: node.filePath,
      line: node.location?.startLine ?? null,
    })),
    edges: model.edges.map((edge) => ({
      id: edge.id,
      source: edge.sourceId,
      target: edge.targetId,
      kind: edge.kind,
      resolution: edge.resolution,
      label: `${edge.kind} · ${edge.resolution}`,
      unresolvedReason: edge.unresolvedReason,
    })),
  };
}
