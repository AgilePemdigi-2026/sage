import type { CcmEdge, CcmNode } from "@sage/contracts";
import type { DiagramProjection } from "./diagrams.ts";
import { humanNodeName, projectHumanDiagram } from "./human-diagrams.ts";

export const PDF_PROJECTION_LIMITS = {
  structureNodes: 8,
  umlClassifiers: 6,
  umlSourceClassifiers: 4,
  relationGroups: 12,
  membersPerClassifier: 3,
  labelCharacters: 72,
  relationRecords: 500,
} as const;

export interface PdfDiagramSummary {
  totalNodes: number;
  shownNodes: number;
  totalEdges: number;
  shownEdges: number;
  totalRelations: number;
  shownRelations: number;
  totalMembers: number;
  shownMembers: number;
  clippedValues: number;
}

export interface CompactPdfDiagrams {
  software: DiagramProjection;
  uml: DiagramProjection;
  softwareSummary: PdfDiagramSummary;
  umlSummary: PdfDiagramSummary;
}

type RelationGroup = { key: string; source: string; target: string; kind: CcmEdge["kind"]; resolution: CcmEdge["resolution"]; edges: CcmEdge[] };
const memberKinds = new Set<CcmNode["kind"]>(["Method", "Property"]);
const classifierKinds = new Set<CcmNode["kind"]>(["Class", "Interface", "UnresolvedReference"]);
const sourceClassifierKinds = new Set<CcmNode["kind"]>(["Class", "Interface"]);

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareNodes(left: CcmNode, right: CcmNode): number {
  return compareText(left.filePath ?? "", right.filePath ?? "") ||
    (left.location?.startLine ?? 0) - (right.location?.startLine ?? 0) ||
    compareText(humanNodeName(left), humanNodeName(right)) || compareText(left.id, right.id);
}

function clipMiddle(value: string | null, maximum: number, countClipped: () => void): string | null {
  if (value === null) return null;
  const characters = Array.from(value);
  if (characters.length <= maximum) return value;
  countClipped();
  const available = maximum - 1;
  const head = Math.ceil(available / 2);
  const tail = available - head;
  return `${characters.slice(0, head).join("")}…${tail ? characters.slice(-tail).join("") : ""}`;
}

function boundedNode(node: CcmNode, countClipped: () => void): CcmNode {
  return {
    ...node,
    name: clipMiddle(node.name, 52, countClipped) ?? "",
    qualifiedName: clipMiddle(humanNodeName(node), 52, countClipped)!,
    filePath: clipMiddle(node.filePath, 18, countClipped),
    signature: clipMiddle(node.signature, PDF_PROJECTION_LIMITS.labelCharacters, countClipped),
  };
}

function ownerId(nodeId: string, byId: ReadonlyMap<string, CcmNode>, visibleIds: ReadonlySet<string>): string | null {
  const visited = new Set<string>();
  let current: string | null = nodeId;
  while (current !== null && !visibleIds.has(current)) {
    if (visited.has(current)) return null;
    visited.add(current);
    current = byId.get(current)?.parentId ?? null;
  }
  return current;
}

function groupRelations(edges: readonly CcmEdge[], sourceFor: (edge: CcmEdge) => string | null,
  targetFor: (edge: CcmEdge) => string | null): RelationGroup[] {
  const grouped = new Map<string, RelationGroup>();
  for (const edge of edges) {
    const source = sourceFor(edge), target = targetFor(edge);
    if (!source || !target || source === target) continue;
    const key = JSON.stringify([source, target, edge.kind, edge.resolution]);
    const found = grouped.get(key);
    if (found) found.edges.push(edge);
    else grouped.set(key, { key, source, target, kind: edge.kind, resolution: edge.resolution, edges: [edge] });
  }
  return [...grouped.values()].sort((left, right) => compareText(left.key, right.key));
}

function groupDegrees(groups: readonly RelationGroup[]): Map<string, number> {
  const degree = new Map<string, number>();
  for (const group of groups) {
    degree.set(group.source, (degree.get(group.source) ?? 0) + 1);
    degree.set(group.target, (degree.get(group.target) ?? 0) + 1);
  }
  return degree;
}

function compareByDegree(left: CcmNode, right: CcmNode, degree: ReadonlyMap<string, number>): number {
  return (degree.get(right.id) ?? 0) - (degree.get(left.id) ?? 0) || compareNodes(left, right);
}

function selectConnectedNodes(nodes: readonly CcmNode[], groups: readonly RelationGroup[], limit: number): CcmNode[] {
  if (nodes.length <= limit) return [...nodes].sort(compareNodes);
  const byId = new Map(nodes.map(node => [node.id, node]));
  const degree = groupDegrees(groups);
  const neighbors = new Map<string, Set<string>>();
  for (const group of groups) {
    const source = neighbors.get(group.source) ?? new Set<string>();
    const target = neighbors.get(group.target) ?? new Set<string>();
    source.add(group.target);
    target.add(group.source);
    neighbors.set(group.source, source);
    neighbors.set(group.target, target);
  }

  // Pick the largest source component, then expand by connected neighbors from its most
  // central node. This avoids filling a compact page with unrelated isolated boxes.
  const visited = new Set<string>();
  const components: string[][] = [];
  for (const node of [...nodes].sort(compareNodes)) {
    if (visited.has(node.id)) continue;
    const component: string[] = [];
    const queue = [node.id];
    visited.add(node.id);
    for (let index = 0; index < queue.length; index += 1) {
      const current = queue[index]!;
      component.push(current);
      for (const neighbor of neighbors.get(current) ?? []) {
        if (byId.has(neighbor) && !visited.has(neighbor)) {
          visited.add(neighbor);
          queue.push(neighbor);
        }
      }
    }
    components.push(component);
  }
  const componentIndex = new Map<string, number>();
  const relationCounts = components.map(() => 0);
  const firstIds = components.map(ids => [...ids].sort()[0] ?? "");
  for (const [index, ids] of components.entries()) for (const id of ids) componentIndex.set(id, index);
  for (const group of groups) {
    const sourceComponent = componentIndex.get(group.source);
    if (sourceComponent !== undefined && sourceComponent === componentIndex.get(group.target)) relationCounts[sourceComponent] += 1;
  }
  const scoredComponents = components.map((ids, index) => {
    return { ids, relationCount: relationCounts[index]!, firstId: firstIds[index]! };
  });
  scoredComponents.sort((left, right) => right.ids.length - left.ids.length || right.relationCount - left.relationCount ||
    compareText(left.firstId, right.firstId));
  const component = new Set(scoredComponents[0]?.ids ?? []);
  const candidates = nodes.filter(node => component.has(node.id)).sort((left, right) => compareByDegree(left, right, degree));
  if (!candidates.length) return [];
  const selected = new Set<string>([candidates[0]!.id]);
  while (selected.size < limit) {
    const frontier = new Set<string>();
    for (const id of selected) for (const neighbor of neighbors.get(id) ?? []) if (!selected.has(neighbor)) frontier.add(neighbor);
    const next = [...frontier].map(id => byId.get(id)).filter((node): node is CcmNode => node !== undefined)
      .sort((left, right) => compareByDegree(left, right, degree))[0];
    if (!next) break;
    selected.add(next.id);
  }
  return nodes.filter(node => selected.has(node.id)).sort(compareNodes);
}

function groupRank(left: RelationGroup, right: RelationGroup, degree: ReadonlyMap<string, number>): number {
  const leftScore = (degree.get(left.source) ?? 0) + (degree.get(left.target) ?? 0);
  const rightScore = (degree.get(right.source) ?? 0) + (degree.get(right.target) ?? 0);
  return rightScore - leftScore || compareText(left.key, right.key);
}

function selectGroups(groups: readonly RelationGroup[], selectedIds: ReadonlySet<string>, limit: number, maxRecords: number): RelationGroup[] {
  const degree = groupDegrees(groups);
  const candidates = groups.filter(group => selectedIds.has(group.source) && selectedIds.has(group.target))
    .filter(group => group.edges.length <= maxRecords).sort((left, right) => groupRank(left, right, degree));
  const selected = new Map<string, RelationGroup>();
  let records = 0;
  for (const resolution of ["Exact", "Unresolved"] as const) {
    const group = candidates.find(item => item.resolution === resolution && records + item.edges.length <= maxRecords);
    if (group && selected.size < limit) {
      selected.set(group.key, group);
      records += group.edges.length;
    }
  }
  for (const group of candidates) {
    if (selected.size >= limit) break;
    if (selected.has(group.key) || records + group.edges.length > maxRecords) continue;
    selected.set(group.key, group);
    records += group.edges.length;
  }
  return [...selected.values()].sort((left, right) => compareText(left.key, right.key));
}

function boundedSummary(totalNodes: number, shownNodes: number, totalGroups: readonly RelationGroup[], shownGroups: readonly RelationGroup[], totalMembers: number, shownMembers: number, clippedValues: number): PdfDiagramSummary {
  return {
    totalNodes, shownNodes,
    totalEdges: totalGroups.reduce((sum, group) => sum + group.edges.length, 0),
    shownEdges: shownGroups.reduce((sum, group) => sum + group.edges.length, 0),
    totalRelations: totalGroups.length, shownRelations: shownGroups.length,
    totalMembers, shownMembers, clippedValues,
  };
}

/**
 * Build small source-backed PDF reading views. Relations are grouped by original endpoints,
 * kind, and resolution; full canonical data remains in the ADD and Markdown export.
 */
export function projectCompactPdfDiagrams(software: DiagramProjection, uml: DiagramProjection): CompactPdfDiagrams {
  let clippedValues = 0;
  const countClipped = () => { clippedValues += 1; };

  const softwareById = new Map(software.nodes.map(node => [node.id, node]));
  const softwareVisible = software.nodes.filter(node => !memberKinds.has(node.kind));
  const softwareVisibleIds = new Set(softwareVisible.map(node => node.id));
  const softwareOwners = new Map<string, string>();
  for (const node of software.nodes) {
    const owner = ownerId(node.id, softwareById, softwareVisibleIds);
    if (owner) softwareOwners.set(node.id, owner);
  }
  const softwareGroups = groupRelations(software.edges,
    edge => softwareOwners.get(edge.sourceId) ?? null,
    edge => softwareOwners.get(edge.targetId) ?? null);
  const softwareSelectedNodes = selectConnectedNodes(softwareVisible, softwareGroups, PDF_PROJECTION_LIMITS.structureNodes);
  const softwareSelectedIds = new Set(softwareSelectedNodes.map(node => node.id));
  const softwareSelectedGroups = selectGroups(softwareGroups, softwareSelectedIds, PDF_PROJECTION_LIMITS.relationGroups,
    PDF_PROJECTION_LIMITS.relationRecords);
  const softwareSelectedEdges = softwareSelectedGroups.flatMap(group => group.edges).sort((left, right) => compareText(left.id, right.id));
  const softwareRequiredIds = new Set(softwareSelectedIds);
  for (const edge of softwareSelectedEdges) {
    softwareRequiredIds.add(edge.sourceId);
    softwareRequiredIds.add(edge.targetId);
  }
  const softwareNodes = software.nodes.filter(node => softwareRequiredIds.has(node.id)).sort(compareNodes).map(node => {
    const owner = softwareOwners.get(node.id);
    // Flatten display ownership for nested members while retaining the original node and edge IDs.
    const projected = owner && owner !== node.id ? { ...node, parentId: owner } : node;
    return boundedNode(projected, countClipped);
  });
  const softwareView = projectHumanDiagram({ ...software, nodes: softwareNodes, edges: softwareSelectedEdges });
  const softwareClippedValues = clippedValues;

  const umlClassifiers = uml.nodes.filter(node => classifierKinds.has(node.kind));
  const umlSourceClassifiers = umlClassifiers.filter(node => sourceClassifierKinds.has(node.kind));
  const umlClassifierIds = new Set(umlClassifiers.map(node => node.id));
  const umlGroups = groupRelations(uml.edges,
    edge => umlClassifierIds.has(edge.sourceId) ? edge.sourceId : null,
    edge => umlClassifierIds.has(edge.targetId) ? edge.targetId : null);
  const sourceIds = new Set(umlSourceClassifiers.map(node => node.id));
  const sourceGroups = umlGroups.filter(group => sourceIds.has(group.source) && sourceIds.has(group.target));
  const sourceDegree = groupDegrees(sourceGroups);
  const rankedSources = [...umlSourceClassifiers].sort((left, right) => compareByDegree(left, right, sourceDegree));
  const linkedUnresolvedSources = new Map<string, Set<string>>();
  const sourcesWithUnresolved = new Set<string>();
  for (const group of umlGroups) {
    if (group.resolution !== "Unresolved") continue;
    if (sourceIds.has(group.source) && !sourceIds.has(group.target)) {
      const sources = linkedUnresolvedSources.get(group.target) ?? new Set<string>();
      sources.add(group.source);
      linkedUnresolvedSources.set(group.target, sources);
      sourcesWithUnresolved.add(group.source);
    }
    if (sourceIds.has(group.target) && !sourceIds.has(group.source)) {
      const sources = linkedUnresolvedSources.get(group.source) ?? new Set<string>();
      sources.add(group.target);
      linkedUnresolvedSources.set(group.source, sources);
      sourcesWithUnresolved.add(group.target);
    }
  }
  const hasLinkedUnresolved = linkedUnresolvedSources.size > 0;
  const sourceLimit = Math.min(rankedSources.length, hasLinkedUnresolved ? PDF_PROJECTION_LIMITS.umlSourceClassifiers : PDF_PROJECTION_LIMITS.umlClassifiers);
  const unresolvedLinkedSources = umlSourceClassifiers.filter(node => sourcesWithUnresolved.has(node.id))
    .sort((left, right) => (sourceDegree.get(right.id) ?? 0) - (sourceDegree.get(left.id) ?? 0) || compareNodes(left, right));
  const preferredLinkedSource = unresolvedLinkedSources[0];
  const sourcePriority = preferredLinkedSource
    ? [preferredLinkedSource, ...rankedSources.filter(node => node.id !== preferredLinkedSource.id)]
    : rankedSources;
  const selectedSources = sourcePriority.slice(0, sourceLimit);
  const selectedSourceIds = new Set(selectedSources.map(node => node.id));
  const umlDegree = groupDegrees(umlGroups);
  const linkedUnresolved = umlClassifiers.filter(node => node.kind === "UnresolvedReference" &&
    [...(linkedUnresolvedSources.get(node.id) ?? [])].some(sourceId => selectedSourceIds.has(sourceId)))
    .sort((left, right) => (umlDegree.get(right.id) ?? 0) - (umlDegree.get(left.id) ?? 0) || compareNodes(left, right));
  const unresolvedSlots = Math.min(2, PDF_PROJECTION_LIMITS.umlClassifiers - selectedSources.length);
  const selectedClassifierNodes = [...selectedSources, ...linkedUnresolved.slice(0, unresolvedSlots)];
  if (selectedClassifierNodes.length < PDF_PROJECTION_LIMITS.umlClassifiers) {
    const selected = new Set(selectedClassifierNodes.map(node => node.id));
    for (const node of rankedSources) {
      if (selectedClassifierNodes.length >= PDF_PROJECTION_LIMITS.umlClassifiers) break;
      if (!selected.has(node.id)) {
        selected.add(node.id);
        selectedClassifierNodes.push(node);
      }
    }
  }
  if (!selectedClassifierNodes.length) {
    selectedClassifierNodes.push(...umlClassifiers.sort((left, right) => compareNodes(left, right)).slice(0, PDF_PROJECTION_LIMITS.umlClassifiers));
  }
  const selectedClassifierIds = new Set(selectedClassifierNodes.map(node => node.id));
  const umlSelectedGroups = selectGroups(umlGroups, selectedClassifierIds, PDF_PROJECTION_LIMITS.relationGroups,
    PDF_PROJECTION_LIMITS.relationRecords);
  // UML uses one source edge as the representative for each selected relation group.
  const umlSelectedEdges = umlSelectedGroups.map(group => [...group.edges].sort((left, right) => compareText(left.id, right.id))[0]!);
  const membersByParent = new Map<string, CcmNode[]>();
  for (const node of uml.nodes) {
    if (!memberKinds.has(node.kind) || !node.parentId || !sourceIds.has(node.parentId)) continue;
    const members = membersByParent.get(node.parentId) ?? [];
    members.push(node);
    membersByParent.set(node.parentId, members);
  }
  let totalUmlMembers = 0;
  for (const members of membersByParent.values()) totalUmlMembers += members.length;
  const selectedMembers: CcmNode[] = [];
  for (const classifier of selectedClassifierNodes) {
    if (!sourceClassifierKinds.has(classifier.kind)) continue;
    selectedMembers.push(...[...(membersByParent.get(classifier.id) ?? [])].sort(compareNodes).slice(0, PDF_PROJECTION_LIMITS.membersPerClassifier));
  }
  const umlRequiredIds = new Set(selectedClassifierIds);
  for (const member of selectedMembers) umlRequiredIds.add(member.id);
  const umlNodes = uml.nodes.filter(node => umlRequiredIds.has(node.id)).sort(compareNodes).map(node => boundedNode(node, countClipped));
  const umlView = projectHumanDiagram({ ...uml, nodes: umlNodes, edges: umlSelectedEdges });
  const umlClippedValues = clippedValues - softwareClippedValues;

  return {
    software: softwareView,
    uml: umlView,
    softwareSummary: boundedSummary(softwareVisible.length, softwareSelectedNodes.length, softwareGroups, softwareSelectedGroups, 0, 0, softwareClippedValues),
    umlSummary: boundedSummary(umlClassifiers.length, selectedClassifierNodes.length, umlGroups, umlSelectedGroups,
      totalUmlMembers, selectedMembers.length, umlClippedValues),
  };
}
