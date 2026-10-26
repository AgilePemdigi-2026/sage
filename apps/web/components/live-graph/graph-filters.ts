import type { NodeKind } from "@sage/contracts";
import type { GraphEdgeView, GraphNodeView, GraphViewModel } from "../graph-foundation/graph-projection.ts";

export interface GraphFilterResult {
  graph: GraphViewModel;
  counts: { nodes: number; edges: number };
}

function matchesQuery(node: GraphNodeView, normalizedQuery: string): boolean {
  if (!normalizedQuery) return true;
  return [node.name, node.kind, node.qualifiedName, node.filePath ?? ""]
    .some((field) => field.toLowerCase().includes(normalizedQuery));
}

/** Return a query and AST kind subset without changing the canonical graph. */
export function filterGraph(
  source: GraphViewModel,
  query: string,
  selectedKinds: readonly NodeKind[] = [],
): GraphFilterResult {
  const normalizedQuery = query.trim().toLowerCase();
  const allowedKinds = new Set(selectedKinds);
  const nodes = source.nodes.filter((node) =>
    (allowedKinds.size === 0 || allowedKinds.has(node.kind)) && matchesQuery(node, normalizedQuery));
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = source.edges.filter((edge: GraphEdgeView) => nodeIds.has(edge.source) && nodeIds.has(edge.target));

  return {
    graph: { ...source, nodes, edges },
    counts: { nodes: nodes.length, edges: edges.length },
  };
}
