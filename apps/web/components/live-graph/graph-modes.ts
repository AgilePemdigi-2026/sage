import type { GraphEdgeView, GraphNodeView, GraphViewModel } from "../graph-foundation/graph-projection.ts";

export type GraphMode = "overview" | "focus" | "all-references";

export const GRAPH_RENDER_LIMITS = { nodes: 200, edges: 500 } as const;

export interface GraphModeProjection {
  mode: GraphMode;
  anchorId: string | null;
  graph: GraphViewModel;
  filteredCounts: ModeCounts;
  visibleCounts: ModeCounts;
  omittedCounts: { nodes: number; edges: number };
  moduleParentByNodeId: Readonly<Record<string, string>>;
}

export interface ModeCounts {
  nodes: number;
  edges: number;
  containmentEdges: number;
  referenceEdges: number;
  exactEdges: number;
  unresolvedEdges: number;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function countsFor(nodes: readonly GraphNodeView[], edges: readonly GraphEdgeView[]): ModeCounts {
  const containmentEdges = edges.filter((edge) => edge.kind === "CONTAINS").length;
  const exactEdges = edges.filter((edge) => edge.resolution === "Exact").length;
  return {
    nodes: nodes.length,
    edges: edges.length,
    containmentEdges,
    referenceEdges: edges.length - containmentEdges,
    exactEdges,
    unresolvedEdges: edges.length - exactEdges,
  };
}

function byId<T extends { id: string }>(left: T, right: T): number {
  return compareText(left.id, right.id);
}

function defaultAnchor(nodes: readonly GraphNodeView[]): GraphNodeView | null {
  return [...nodes].sort((left, right) => {
    const leftModule = left.kind === "Module" ? 0 : 1;
    const rightModule = right.kind === "Module" ? 0 : 1;
    return leftModule - rightModule || compareText(left.name, right.name) || byId(left, right);
  })[0] ?? null;
}

function nearestModuleId(node: GraphNodeView, nodesById: ReadonlyMap<string, GraphNodeView>): string | null {
  const visited = new Set([node.id]);
  let parentId = node.parentId ?? null;
  while (parentId && !visited.has(parentId)) {
    visited.add(parentId);
    const parent = nodesById.get(parentId);
    if (!parent) return null;
    if (parent.kind === "Module") return parent.id;
    parentId = parent.parentId ?? null;
  }
  return null;
}

function edgeEndpointsPresent(edge: GraphEdgeView, ids: ReadonlySet<string>): boolean {
  return ids.has(edge.source) && ids.has(edge.target);
}

/**
 * Produce one deterministic, bounded display view without changing the canonical graph.
 * Counts distinguish the semantic mode subset from the elements sent to Cytoscape.
 */
export function projectGraphMode(
  source: GraphViewModel,
  mode: GraphMode,
  selectedId: string | null = null,
): GraphModeProjection {
  const nodesById = new Map<string, GraphNodeView>();
  for (const node of source.nodes) nodesById.set(node.id, node);
  const nearestModuleByNodeId = new Map<string, string | null>();
  for (const node of source.nodes) nearestModuleByNodeId.set(node.id, nearestModuleId(node, nodesById));
  const edges = [...source.edges].sort(byId);
  const chosen = selectedId ? nodesById.get(selectedId) : undefined;
  const anchor = chosen ?? defaultAnchor(source.nodes);
  const anchorId = anchor?.id ?? null;

  let filteredNodes: GraphNodeView[];
  let filteredEdges: GraphEdgeView[];
  if (mode === "focus" && anchor) {
    const neighbors = new Set([anchor.id]);
    for (const edge of edges) {
      if (edge.source === anchor.id) neighbors.add(edge.target);
      if (edge.target === anchor.id) neighbors.add(edge.source);
    }
    filteredNodes = [...neighbors].map((id) => nodesById.get(id)).filter((node): node is GraphNodeView => !!node);
    // Focus shows only incident edges, including self-loops and parallel edges.
    filteredEdges = edges.filter((edge) => edge.source === anchor.id || edge.target === anchor.id);
  } else if (mode === "all-references") {
    filteredEdges = edges.filter((edge) => edge.kind !== "CONTAINS");
    const endpoints = new Set(filteredEdges.flatMap((edge) => [edge.source, edge.target]));
    filteredNodes = [...endpoints].map((id) => nodesById.get(id)).filter((node): node is GraphNodeView => !!node);
  } else {
    filteredNodes = [...source.nodes];
    filteredEdges = edges;
  }

  const moduleById = (left: GraphNodeView, right: GraphNodeView) => {
    const leftModule = left.kind === "Module" ? 0 : 1;
    const rightModule = right.kind === "Module" ? 0 : 1;
    if (leftModule !== rightModule) return leftModule - rightModule;
    const leftParent = nearestModuleByNodeId.get(left.id) ?? "";
    const rightParent = nearestModuleByNodeId.get(right.id) ?? "";
    return compareText(leftParent, rightParent) || compareText(left.qualifiedName, right.qualifiedName) || byId(left, right);
  };
  const nodeOrder = mode === "focus"
    ? [...filteredNodes].sort((left, right) => (left.id === anchorId ? -1 : right.id === anchorId ? 1 : byId(left, right)))
    : [...filteredNodes].sort(moduleById);
  const visibleNodes = nodeOrder.slice(0, GRAPH_RENDER_LIMITS.nodes);
  const visibleNodeIds = new Set(visibleNodes.map((node) => node.id));
  const visibleEdges = filteredEdges
    .filter((edge) => edgeEndpointsPresent(edge, visibleNodeIds))
    .sort(byId)
    .slice(0, GRAPH_RENDER_LIMITS.edges);
  const moduleParentByNodeId: Record<string, string> = {};
  if (mode === "overview") {
    for (const node of visibleNodes) {
      const moduleId = nearestModuleByNodeId.get(node.id) ?? null;
      if (moduleId && moduleId !== node.id && visibleNodeIds.has(moduleId)) moduleParentByNodeId[node.id] = moduleId;
    }
  }

  return {
    mode,
    anchorId,
    graph: { ...source, nodes: visibleNodes, edges: visibleEdges },
    filteredCounts: countsFor(filteredNodes, filteredEdges),
    visibleCounts: countsFor(visibleNodes, visibleEdges),
    omittedCounts: {
      nodes: filteredNodes.length - visibleNodes.length,
      edges: filteredEdges.length - visibleEdges.length,
    },
    moduleParentByNodeId,
  };
}
