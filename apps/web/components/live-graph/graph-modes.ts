import type { GraphEdgeView, GraphNodeView, GraphViewModel } from "../graph-foundation/graph-projection.ts";

export type GraphMode = "essential" | "overview" | "focus" | "all-references";

export const GRAPH_RENDER_LIMITS = { nodes: 200, edges: 500 } as const;
export const ESSENTIAL_RENDER_LIMITS = { nodes: 60, edges: 150 } as const;

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

function hasNoisyPath(node: GraphNodeView): boolean {
  const noisySegment = /(?:^|[/\\])(?:__tests__|tests?|__fixtures__|fixtures?|generated|vendor|node_modules|dist|build|coverage|__mocks__|mocks?)(?:[/\\]|$)/i;
  const noisyFileName = /(?:^|[/\\])[^/\\]+\.(?:test|spec|fixture|generated|mock)\.[^./\\]+$/i;
  return noisySegment.test(node.filePath ?? "") || noisyFileName.test(node.filePath ?? "") || noisySegment.test(node.qualifiedName);
}

function isTopLevelFunction(node: GraphNodeView, nodesById: ReadonlyMap<string, GraphNodeView>): boolean {
  if (node.kind !== "Function") return false;
  const visited = new Set([node.id]);
  let parentId = node.parentId ?? null;
  while (parentId && !visited.has(parentId)) {
    visited.add(parentId);
    const parent = nodesById.get(parentId);
    if (!parent || parent.kind !== "Module") return false;
    parentId = parent.parentId ?? null;
  }
  return parentId === null;
}

function isEssentialNode(node: GraphNodeView, nodesById: ReadonlyMap<string, GraphNodeView>): boolean {
  if (node.origin !== "source" || hasNoisyPath(node)) return false;
  return node.kind === "Module" || node.kind === "Class" || node.kind === "Interface" || isTopLevelFunction(node, nodesById);
}

/** Map implementation details to the nearest visible architectural owner. */
function essentialOwnerId(
  node: GraphNodeView,
  nodesById: ReadonlyMap<string, GraphNodeView>,
  essentialIds: ReadonlySet<string>,
): string | null {
  if (essentialIds.has(node.id)) return node.id;
  if (node.origin !== "source" || node.kind === "UnresolvedReference") return null;

  const visited = new Set([node.id]);
  let parentId = node.parentId ?? null;
  while (parentId && !visited.has(parentId)) {
    visited.add(parentId);
    const parent = nodesById.get(parentId);
    if (!parent) return null;
    if ((parent.kind === "Class" || parent.kind === "Interface" || parent.kind === "Module") && essentialIds.has(parent.id)) {
      return parent.id;
    }
    parentId = parent.parentId ?? null;
  }
  return null;
}

function essentialNodeOrder(
  left: GraphNodeView,
  right: GraphNodeView,
  connectionCountByNodeId: ReadonlyMap<string, number>,
): number {
  const leftConnections = connectionCountByNodeId.get(left.id) ?? 0;
  const rightConnections = connectionCountByNodeId.get(right.id) ?? 0;
  const kindPriority = (node: GraphNodeView) => node.kind === "Class" || node.kind === "Interface" ? 0 : node.kind === "Function" ? 1 : 2;
  return rightConnections - leftConnections || kindPriority(left) - kindPriority(right) ||
    compareText(left.qualifiedName, right.qualifiedName) || byId(left, right);
}

interface EssentialEdgeGroup {
  edge: GraphEdgeView;
  count: number;
}

function essentialEdges(
  edges: readonly GraphEdgeView[],
  ownerByNodeId: ReadonlyMap<string, string | null>,
): EssentialEdgeGroup[] {
  const groups = new Map<string, EssentialEdgeGroup>();
  for (const edge of edges) {
    if (edge.kind === "CONTAINS" || edge.resolution !== "Exact") continue;
    const source = ownerByNodeId.get(edge.source) ?? null;
    const target = ownerByNodeId.get(edge.target) ?? null;
    if (!source || !target || source === target) continue;

    const key = JSON.stringify([source, target, edge.kind]);
    const group = groups.get(key);
    if (group) {
      group.count += 1;
      if (compareText(edge.id, group.edge.id) < 0) group.edge.id = edge.id;
    } else {
      groups.set(key, {
        count: 1,
        edge: { ...edge, source, target },
      });
    }
  }

  return [...groups.values()].map((group) => ({
    ...group,
    // The projected edge id is the id of a real canonical edge representing this aggregate.
    edge: { ...group.edge, label: `${group.edge.kind} · Exact${group.count > 1 ? ` ×${group.count}` : ""}` },
  }));
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
  let anchor = chosen ?? defaultAnchor(source.nodes);
  let essentialEdgesValue: EssentialEdgeGroup[] = [];
  let essentialOwnerByNodeId = new Map<string, string | null>();
  const connectionCountByNodeId = new Map<string, number>();

  let filteredNodes: GraphNodeView[];
  let filteredEdges: GraphEdgeView[];
  if (mode === "essential") {
    const essentialNodes = source.nodes.filter((node) => isEssentialNode(node, nodesById));
    const essentialIds = new Set(essentialNodes.map((node) => node.id));
    essentialOwnerByNodeId = new Map<string, string | null>();
    for (const node of source.nodes) {
      essentialOwnerByNodeId.set(node.id, essentialOwnerId(node, nodesById, essentialIds));
    }
    essentialEdgesValue = essentialEdges(edges, essentialOwnerByNodeId);
    for (const group of essentialEdgesValue) {
      connectionCountByNodeId.set(group.edge.source, (connectionCountByNodeId.get(group.edge.source) ?? 0) + group.count);
      connectionCountByNodeId.set(group.edge.target, (connectionCountByNodeId.get(group.edge.target) ?? 0) + group.count);
    }
    filteredNodes = [...essentialNodes].sort((left, right) => essentialNodeOrder(left, right, connectionCountByNodeId));
    essentialEdgesValue.sort((left, right) => right.count - left.count || byId(left.edge, right.edge));
    filteredEdges = essentialEdgesValue.map((group) => group.edge);
    const chosenOwner = chosen ? essentialOwnerByNodeId.get(chosen.id) ?? null : null;
    anchor = (chosenOwner ? nodesById.get(chosenOwner) : undefined) ?? filteredNodes[0] ?? null;
  } else if (mode === "focus" && anchor) {
    const neighbors = new Set([anchor.id]);
    for (const edge of edges) {
      if (edge.source === anchor.id) neighbors.add(edge.target);
      if (edge.target === anchor.id) neighbors.add(edge.source);
    }
    filteredNodes = [...neighbors].map((id) => nodesById.get(id)).filter((node): node is GraphNodeView => !!node);
    // Focus shows only incident edges, including self-loops and parallel edges.
    const focusId = anchor.id;
    filteredEdges = edges.filter((edge) => edge.source === focusId || edge.target === focusId);
  } else if (mode === "all-references") {
    filteredEdges = edges.filter((edge) => edge.kind !== "CONTAINS");
    const endpoints = new Set(filteredEdges.flatMap((edge) => [edge.source, edge.target]));
    filteredNodes = [...endpoints].map((id) => nodesById.get(id)).filter((node): node is GraphNodeView => !!node);
  } else {
    filteredNodes = [...source.nodes];
    filteredEdges = edges;
  }
  const anchorId = anchor?.id ?? null;

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
    : mode === "essential"
      ? [...filteredNodes].sort((left, right) => essentialNodeOrder(left, right, connectionCountByNodeId))
      : [...filteredNodes].sort(moduleById);
  const limits = mode === "essential" ? ESSENTIAL_RENDER_LIMITS : GRAPH_RENDER_LIMITS;
  const visibleNodes = nodeOrder.slice(0, limits.nodes);
  const visibleNodeIds = new Set(visibleNodes.map((node) => node.id));
  const visibleEdgeCandidates = filteredEdges.filter((edge) => edgeEndpointsPresent(edge, visibleNodeIds));
  const visibleEdges = (mode === "essential" ? visibleEdgeCandidates : visibleEdgeCandidates.sort(byId))
    .slice(0, limits.edges);
  const moduleParentByNodeId: Record<string, string> = {};
  if (mode === "overview" || mode === "essential") {
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
