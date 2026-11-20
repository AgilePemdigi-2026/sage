import type { AddBaselineModel, AddElement, AddRelationship } from "./baseline-add-model.ts";

export type BaselineViewName = "dataStructure" | "applicationCooperation";

export interface CoreBaselineView {
  elements: AddElement[];
  relationships: AddRelationship[];
  sourceElementCount: number;
  sourceRelationshipCount: number;
  omittedElementCount: number;
  omittedRelationshipCount: number;
}

const MAX_CORE_ELEMENTS = 8;
const MAX_CORE_RELATIONSHIPS = 7;
const MAX_CORE_DEPTH = 2;

function viewElementIds(model: AddBaselineModel, view: BaselineViewName): string[] {
  return model.views[view].elementIds;
}

function viewRelationshipIds(model: AddBaselineModel, view: BaselineViewName): string[] {
  return model.views[view].relationshipIds;
}

function isCoreRelationship(view: BaselineViewName, edge: AddRelationship, byId: ReadonlyMap<string, AddElement>): boolean {
  const source = byId.get(edge.sourceId);
  const target = byId.get(edge.targetId);
  if (!source || !target) return false;

  if (view === "dataStructure") {
    return edge.type === "AssociationRelationship" && source.type === "DataObject" && target.type === "DataObject";
  }

  const applicationStructure = new Set(["ApplicationComponent", "ApplicationService"]);
  if (!applicationStructure.has(source.type) || !applicationStructure.has(target.type)) return false;
  return edge.type === "CompositionRelationship" ||
    edge.type === "FlowRelationship" || edge.type === "ServingRelationship" || edge.type === "RealizationRelationship";
}

function relationPriority(edge: AddRelationship): number {
  switch (edge.type) {
    case "CompositionRelationship": return 0;
    case "FlowRelationship": return 1;
    case "ServingRelationship": return 2;
    case "RealizationRelationship": return 3;
    case "AssociationRelationship": return 0;
    default: return 5;
  }
}

/** Remove repeated extractor wording from compact stakeholder relationship tables. */
export function coreRelationshipLabel(edge: AddRelationship): string | null {
  const label = edge.label.trim();
  if ((edge.type === "AssociationRelationship" && /^(?:references?|links?) data object$/iu.test(label)) ||
      (edge.type === "CompositionRelationship" && /^(?:contains?|includes?) (?:configured )?(?:application )?(?:service|component)$/iu.test(label))) return null;
  if (edge.type === "FlowRelationship") {
    if (/https?/iu.test(label)) return "HTTP";
    if (/graphql/iu.test(label)) return "GraphQL";
    if (/grpc/iu.test(label)) return "gRPC";
    if (/rest/iu.test(label)) return "REST API";
    if (/api/iu.test(label)) return "API";
    if (/queue/iu.test(label)) return "Message queue";
    if (/event/iu.test(label)) return "Event";
    if (/batch/iu.test(label)) return "Batch";
  }
  return label || null;
}

function selectConnectedCore(candidates: AddRelationship[], byId: ReadonlyMap<string, AddElement>, view: BaselineViewName): AddRelationship[] {
  const adjacency = new Map<string, AddRelationship[]>();
  for (const edge of candidates) {
    adjacency.set(edge.sourceId, [...(adjacency.get(edge.sourceId) ?? []), edge]);
    adjacency.set(edge.targetId, [...(adjacency.get(edge.targetId) ?? []), edge]);
  }
  const components: Array<{ nodeIds: Set<string>; edges: AddRelationship[] }> = [];
  const visited = new Set<string>();
  for (const start of adjacency.keys()) {
    if (visited.has(start)) continue;
    const nodeIds = new Set<string>();
    const edgeIds = new Set<string>();
    const queue = [start];
    visited.add(start);
    while (queue.length) {
      const id = queue.shift()!;
      nodeIds.add(id);
      for (const edge of adjacency.get(id) ?? []) {
        edgeIds.add(edge.id);
        const next = edge.sourceId === id ? edge.targetId : edge.sourceId;
        if (!visited.has(next)) { visited.add(next); queue.push(next); }
      }
    }
    components.push({ nodeIds, edges: candidates.filter(edge => edgeIds.has(edge.id)) });
  }

  const degree = (id: string) => adjacency.get(id)?.length ?? 0;
  const elementName = (id: string) => byId.get(id)?.name ?? id;
  components.sort((left, right) => right.edges.length - left.edges.length || right.nodeIds.size - left.nodeIds.size ||
    [...left.nodeIds].map(elementName).sort()[0]!.localeCompare([...right.nodeIds].map(elementName).sort()[0]!));

  const selectedNodes = new Set<string>();
  const selectedEdges = new Map<string, AddRelationship>();
  for (const component of components) {
    const remainingNodes = MAX_CORE_ELEMENTS - selectedNodes.size;
    const remainingEdges = MAX_CORE_RELATIONSHIPS - selectedEdges.size;
    if (remainingNodes < 2 || remainingEdges < 1) break;
    const fullRoot = [...component.nodeIds].sort((a, b) => degree(b) - degree(a) || elementName(a).localeCompare(elementName(b)) || a.localeCompare(b))[0]!;
    const distances = new Map<string, number>([[fullRoot, 0]]);
    const distanceQueue = [fullRoot];
    while (distanceQueue.length) {
      const current = distanceQueue.shift()!;
      for (const edge of adjacency.get(current) ?? []) {
        const next = edge.sourceId === current ? edge.targetId : edge.sourceId;
        if (!component.nodeIds.has(next) || distances.has(next)) continue;
        distances.set(next, distances.get(current)! + 1);
        distanceQueue.push(next);
      }
    }
    const fitsWhole = component.nodeIds.size <= remainingNodes && component.edges.length <= remainingEdges &&
      [...distances.values()].every(distance => distance <= MAX_CORE_DEPTH);
    if (fitsWhole) {
      for (const id of component.nodeIds) selectedNodes.add(id);
      for (const edge of component.edges) selectedEdges.set(edge.id, edge);
      if (view === "applicationCooperation") break;
      continue;
    }

    // Keep a large component connected: choose a central node and grow a
    // breadth-first spanning core before admitting any extra links.
    const root = fullRoot;
    const localNodes = new Set([root]);
    const localEdges = new Map<string, AddRelationship>();
    const queue: Array<{ id: string; depth: number }> = [{ id: root, depth: 0 }];
    while (queue.length && localNodes.size < remainingNodes && localEdges.size < remainingEdges) {
      const { id: current, depth } = queue.shift()!;
      if (depth >= MAX_CORE_DEPTH) continue;
      const incident = (adjacency.get(current) ?? []).filter(edge => component.nodeIds.has(edge.sourceId) && component.nodeIds.has(edge.targetId))
        .sort((a, b) => relationPriority(a) - relationPriority(b) || a.id.localeCompare(b.id));
      for (const edge of incident) {
        if (localEdges.size >= remainingEdges) break;
        const next = edge.sourceId === current ? edge.targetId : edge.sourceId;
        if (localNodes.has(next)) continue;
        localNodes.add(next);
        localEdges.set(edge.id, edge);
        queue.push({ id: next, depth: depth + 1 });
        if (localNodes.size >= remainingNodes) break;
      }
    }
    for (const id of localNodes) selectedNodes.add(id);
    for (const [id, edge] of localEdges) selectedEdges.set(id, edge);
    for (const edge of component.edges.sort((a, b) => relationPriority(a) - relationPriority(b) || a.id.localeCompare(b.id))) {
      if (selectedEdges.size >= MAX_CORE_RELATIONSHIPS) break;
      if (localNodes.has(edge.sourceId) && localNodes.has(edge.targetId)) selectedEdges.set(edge.id, edge);
    }
    if (view === "applicationCooperation") break;
  }
  return [...selectedEdges.values()].sort((left, right) => relationPriority(left) - relationPriority(right) || left.id.localeCompare(right.id));
}

/**
 * Produce a stakeholder-facing view from existing ADD facts. It never creates
 * relationships: it only filters to the principal ArchiMate structures and
 * direct information flows, leaving endpoint/function detail to the catalogs.
 */
export function projectCoreBaselineView(model: AddBaselineModel, view: BaselineViewName): CoreBaselineView {
  const viewIds = new Set(viewElementIds(model, view));
  const relationshipIds = new Set(viewRelationshipIds(model, view));
  const sourceElements = model.elements.filter(element => viewIds.has(element.id));
  const sourceRelationships = model.relationships.filter(edge => relationshipIds.has(edge.id));
  const byId = new Map(model.elements.map(element => [element.id, element]));
  const candidates = sourceRelationships.filter(edge => viewIds.has(edge.sourceId) && viewIds.has(edge.targetId) && isCoreRelationship(view, edge, byId));
  const relationships = selectConnectedCore(candidates, byId, view);
  const connectedIds = new Set(relationships.flatMap(edge => [edge.sourceId, edge.targetId]));
  const elements = sourceElements.filter(element => connectedIds.has(element.id));
  return {
    elements,
    relationships,
    sourceElementCount: sourceElements.length,
    sourceRelationshipCount: sourceRelationships.length,
    omittedElementCount: Math.max(0, sourceElements.length - elements.length),
    omittedRelationshipCount: Math.max(0, sourceRelationships.length - relationships.length),
  };
}
