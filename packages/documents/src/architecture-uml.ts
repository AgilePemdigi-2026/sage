import type { CcmEdge, CcmNode } from "@sage/contracts";
import type { DiagramProjection } from "./diagrams.ts";
import {
  projectHumanDiagram,
  type HumanUmlDependencyMetadata,
  type HumanUmlProjection,
  type HumanUmlRole,
  type HumanUmlRoleMetadata,
} from "./human-diagrams.ts";

function withoutGroupKey<T extends { key: string }>(group: T): Omit<T, "key"> {
  const { key, ...value } = group;
  void key;
  return value;
}

const CLASSIFIER_KINDS = new Set<CcmNode["kind"]>(["Class", "Interface"]);
const MEMBER_KINDS = new Set<CcmNode["kind"]>(["Method", "Property"]);
const DEPENDENCY_KINDS = new Set<CcmEdge["kind"]>(["CALLS", "TYPE_REFERENCES", "INSTANTIATES", "READS", "WRITES"]);

export interface ArchitectureUmlOptions {
  maxClassifiers?: number;
  maxMembersPerClassifier?: number;
  maxRelations?: number;
  maxSourceRecords?: number;
}

export interface ArchitectureUmlSummary {
  /** Source classes and interfaces, excluding synthetic unresolved placeholders. */
  totalNodes: number;
  shownNodes: number;
  /** Source edge records in owner-resolved dependency and inheritance groups. */
  totalEdges: number;
  shownEdges: number;
  totalInheritanceEdges: number;
  shownInheritanceEdges: number;
  totalRelations: number;
  shownRelations: number;
  totalMembers: number;
  shownMembers: number;
  /** No source labels or signatures are truncated by this projection. */
  clippedValues: number;
  /** Unresolved source edges that are not rendered in the selected reading view. */
  omittedUnresolved: number;
  unresolvedReferences: number;
  unownedDependencyEdges: number;
  internalDependencyEdges: number;
  unownedInheritanceEdges: number;
  internalInheritanceEdges: number;
  omittedClassifiers: number;
  omittedMembers: number;
  omittedRelations: number;
  /** Count of classifiers by the display convention used to assign their BCE role. */
  classificationBasis: {
    nameConvention: number;
    pathConvention: number;
    nameAndPath: number;
    ambiguous: number;
    none: number;
  };
}

export interface ArchitectureUmlResult {
  projection: HumanUmlProjection & { humanMetadata: NonNullable<HumanUmlProjection["humanMetadata"]> };
  summary: ArchitectureUmlSummary;
  /** Includes a record for every source class/interface, including unselected classifiers. */
  roles: Record<string, HumanUmlRoleMetadata>;
  /** All owner-resolved groups, including groups omitted from Mermaid by a display cap. */
  dependencies: HumanUmlDependencyMetadata[];
  inheritanceRelations: HumanUmlDependencyMetadata[];
  /** All relevant original CCM edges, including omitted/unresolved records. */
  sourceEdges: CcmEdge[];
  unresolvedSourceEdgeIds: string[];
}

interface DependencyGroup extends HumanUmlDependencyMetadata {
  key: string;
}

const ROLE_SUFFIXES: readonly { suffix: string; role: HumanUmlRole }[] = [
  { suffix: "View", role: "boundary" },
  { suffix: "Page", role: "boundary" },
  { suffix: "Screen", role: "boundary" },
  { suffix: "Form", role: "boundary" },
  { suffix: "Handler", role: "boundary" },
  { suffix: "Client", role: "boundary" },
  { suffix: "Gateway", role: "boundary" },
  { suffix: "Controller", role: "control" },
  { suffix: "Service", role: "control" },
  { suffix: "UseCase", role: "control" },
  { suffix: "Manager", role: "control" },
  { suffix: "Entity", role: "entity" },
  { suffix: "Model", role: "entity" },
  { suffix: "Record", role: "entity" },
];

const PATH_SEGMENTS: readonly { segment: string; role: HumanUmlRole }[] = [
  { segment: "boundary", role: "boundary" },
  { segment: "ui", role: "boundary" },
  { segment: "view", role: "boundary" },
  { segment: "views", role: "boundary" },
  { segment: "controller", role: "control" },
  { segment: "controllers", role: "control" },
  { segment: "service", role: "control" },
  { segment: "services", role: "control" },
  { segment: "usecase", role: "control" },
  { segment: "usecases", role: "control" },
  { segment: "entity", role: "entity" },
  { segment: "entities", role: "entity" },
  { segment: "domain", role: "entity" },
  { segment: "model", role: "entity" },
  { segment: "models", role: "entity" },
];

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function displayName(node: CcmNode): string {
  return node.qualifiedName || node.name || node.filePath || "Declaration without name";
}

function compareNodes(left: CcmNode, right: CcmNode): number {
  return compareText(left.filePath ?? "", right.filePath ?? "") ||
    (left.location?.startLine ?? 0) - (right.location?.startLine ?? 0) ||
    compareText(displayName(left), displayName(right)) || compareText(left.id, right.id);
}

function positiveLimit(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative integer`);
  return value;
}

function suffixConvention(node: CcmNode): { role: HumanUmlRole; suffix: string } | null {
  const name = (node.qualifiedName || node.name).trim();
  const matches = ROLE_SUFFIXES.filter(({ suffix }) => name.toLowerCase().endsWith(suffix.toLowerCase()));
  if (matches.length !== 1) return null;
  const { role, suffix } = matches[0]!;
  // Require an actual token boundary: Preview ends in the letters "view", but is not a View.
  const markerIndex = name.length - suffix.length;
  if (markerIndex > 0) {
    const marker = name[markerIndex]!;
    const preceding = name[markerIndex - 1]!;
    const camelCaseBoundary = /[A-Z]/.test(marker) && /[a-z0-9]/.test(preceding);
    const separatedBoundary = /[_-]/.test(preceding);
    if (!camelCaseBoundary && !separatedBoundary) return null;
  }
  return { role, suffix };
}

function pathConvention(node: CcmNode): { role: HumanUmlRole; segment: string } | null {
  const segments = (node.filePath ?? "").replaceAll("\\", "/").split("/").filter(Boolean);
  const matches = PATH_SEGMENTS.filter(({ segment }) => segments.some(item => item.toLowerCase() === segment));
  const roles = new Set(matches.map(match => match.role));
  if (roles.size !== 1) return null;
  const selectedRole = [...roles][0]!;
  const first = matches.find(match => match.role === selectedRole)!;
  return { role: selectedRole, segment: first.segment };
}

function classify(node: CcmNode): HumanUmlRoleMetadata {
  const name = suffixConvention(node);
  const path = pathConvention(node);
  const nameMatches = ROLE_SUFFIXES.filter(({ suffix }) => (node.qualifiedName || node.name).toLowerCase().endsWith(suffix.toLowerCase()));
  const pathSegments = (node.filePath ?? "").replaceAll("\\", "/").split("/").filter(Boolean).map(value => value.toLowerCase());
  const pathMatches = PATH_SEGMENTS.filter(({ segment }) => pathSegments.includes(segment));
  const hasNameAmbiguity = nameMatches.length > 1;
  const hasPathAmbiguity = new Set(pathMatches.map(match => match.role)).size > 1;
  if (hasNameAmbiguity || hasPathAmbiguity || (name && path && name.role !== path.role)) {
    return { role: null, basis: "ambiguous", nameConvention: name?.suffix ?? null, pathConvention: path?.segment ?? null };
  }
  if (name && path) {
    return { role: name.role, basis: "name-and-path", nameConvention: name.suffix, pathConvention: path.segment };
  }
  if (name) return { role: name.role, basis: "name-convention", nameConvention: name.suffix, pathConvention: null };
  if (path) return { role: path.role, basis: "path-convention", nameConvention: null, pathConvention: path.segment };
  return { role: null, basis: "none", nameConvention: null, pathConvention: null };
}

function optionRoleRank(role: HumanUmlRole | null): number {
  switch (role) {
    case "boundary": return 0;
    case "control": return 1;
    case "entity": return 2;
    default: return 3;
  }
}

function optionBasisCounts(roles: Readonly<Record<string, HumanUmlRoleMetadata>>): ArchitectureUmlSummary["classificationBasis"] {
  const counts = { nameConvention: 0, pathConvention: 0, nameAndPath: 0, ambiguous: 0, none: 0 };
  for (const metadata of Object.values(roles)) {
    switch (metadata.basis) {
      case "name-convention": counts.nameConvention += 1; break;
      case "path-convention": counts.pathConvention += 1; break;
      case "name-and-path": counts.nameAndPath += 1; break;
      case "ambiguous": counts.ambiguous += 1; break;
      case "none": counts.none += 1; break;
    }
  }
  return counts;
}

function edgeMetadata(edges: readonly CcmEdge[]): Pick<HumanUmlDependencyMetadata, "representativeEdgeId" | "sourceEdgeIds" | "evidence" | "sourceEdges"> {
  const sourceEdges = [...edges].sort((left, right) => compareText(left.id, right.id));
  return {
    representativeEdgeId: sourceEdges[0]!.id,
    sourceEdgeIds: sourceEdges.map(edge => edge.id),
    evidence: sourceEdges.flatMap(edge => edge.evidence),
    sourceEdges,
  };
}

function relationGroups(edges: readonly CcmEdge[], ownerById: ReadonlyMap<string, string>): {
  groups: DependencyGroup[];
  unownedEdges: number;
  internalEdges: number;
} {
  const grouped = new Map<string, { sourceId: string; targetId: string; kind: CcmEdge["kind"]; resolution: CcmEdge["resolution"]; edges: CcmEdge[] }>();
  let unownedEdges = 0;
  let internalEdges = 0;
  for (const edge of edges) {
    const sourceId = ownerById.get(edge.sourceId), targetId = ownerById.get(edge.targetId);
    if (!sourceId || !targetId) {
      unownedEdges += 1;
      continue;
    }
    if (sourceId === targetId) {
      internalEdges += 1;
      continue;
    }
    const key = JSON.stringify([sourceId, targetId, edge.kind, edge.resolution]);
    const group = grouped.get(key);
    if (group) group.edges.push(edge);
    else grouped.set(key, { sourceId, targetId, kind: edge.kind, resolution: edge.resolution, edges: [edge] });
  }
  const groups = [...grouped.entries()].map(([key, group]) => ({
    key,
    sourceId: group.sourceId,
    targetId: group.targetId,
    kind: group.kind,
    resolution: group.resolution,
    ...edgeMetadata(group.edges),
  })).sort((left, right) => compareText(left.key, right.key));
  return { groups, unownedEdges, internalEdges };
}

function groupDegrees(groups: readonly DependencyGroup[]): Map<string, number> {
  const degrees = new Map<string, number>();
  for (const group of groups) {
    degrees.set(group.sourceId, (degrees.get(group.sourceId) ?? 0) + 1);
    degrees.set(group.targetId, (degrees.get(group.targetId) ?? 0) + 1);
  }
  return degrees;
}

function selectClassifiers(classifiers: readonly CcmNode[], groups: readonly DependencyGroup[], roles: Readonly<Record<string, HumanUmlRoleMetadata>>, limit: number): CcmNode[] {
  if (classifiers.length <= limit) return [...classifiers].sort(compareNodes);
  const byId = new Map(classifiers.map(node => [node.id, node]));
  const degree = groupDegrees(groups);
  const neighbors = new Map<string, Set<string>>();
  for (const group of groups) {
    const sourceNeighbors = neighbors.get(group.sourceId) ?? new Set<string>();
    const targetNeighbors = neighbors.get(group.targetId) ?? new Set<string>();
    sourceNeighbors.add(group.targetId);
    targetNeighbors.add(group.sourceId);
    neighbors.set(group.sourceId, sourceNeighbors);
    neighbors.set(group.targetId, targetNeighbors);
  }
  const compareCandidate = (left: CcmNode, right: CcmNode) =>
    (degree.get(right.id) ?? 0) - (degree.get(left.id) ?? 0) ||
    optionRoleRank(roles[left.id]?.role ?? null) - optionRoleRank(roles[right.id]?.role ?? null) || compareNodes(left, right);

  const visited = new Set<string>();
  const components: { ids: string[]; relationCount: number; roleRank: number; first: CcmNode }[] = [];
  for (const node of [...classifiers].sort(compareNodes)) {
    if (visited.has(node.id)) continue;
    const ids: string[] = [];
    const queue = [node.id];
    visited.add(node.id);
    for (let index = 0; index < queue.length; index += 1) {
      const current = queue[index]!;
      ids.push(current);
      for (const next of neighbors.get(current) ?? []) {
        if (byId.has(next) && !visited.has(next)) {
          visited.add(next);
          queue.push(next);
        }
      }
    }
    const componentNodes = ids.map(id => byId.get(id)!);
    components.push({
      ids,
      relationCount: 0,
      roleRank: componentNodes.reduce((minimum, item) => Math.min(minimum, optionRoleRank(roles[item.id]?.role ?? null)), 3),
      first: [...componentNodes].sort(compareNodes)[0]!,
    });
  }
  const componentById = new Map<string, number>();
  for (const [index, component] of components.entries()) for (const id of component.ids) componentById.set(id, index);
  for (const group of groups) {
    const index = componentById.get(group.sourceId);
    if (index !== undefined && index === componentById.get(group.targetId)) components[index]!.relationCount += 1;
  }
  components.sort((left, right) => right.ids.length - left.ids.length || right.relationCount - left.relationCount ||
    left.roleRank - right.roleRank || compareNodes(left.first, right.first));

  const selected = new Set<string>();
  for (const component of components) {
    const componentIds = new Set(component.ids);
    const remaining = new Set(component.ids);
    while (selected.size < limit && remaining.size > 0) {
      const frontier = new Set<string>();
      for (const id of componentIds) {
        if (!selected.has(id)) continue;
        for (const next of neighbors.get(id) ?? []) if (componentIds.has(next) && remaining.has(next)) frontier.add(next);
      }
      const candidates = (frontier.size ? [...frontier] : [...remaining])
        .map(id => byId.get(id)!).sort(compareCandidate);
      if (!candidates.length) break;
      selected.add(candidates[0]!.id);
      remaining.delete(candidates[0]!.id);
    }
    if (selected.size >= limit) break;
  }
  return classifiers.filter(node => selected.has(node.id)).sort(compareNodes);
}

function selectGroups(dependencies: readonly DependencyGroup[], inheritance: readonly DependencyGroup[], selected: ReadonlySet<string>, limit: number, maxSourceRecords: number): {
  dependencies: DependencyGroup[];
  inheritance: DependencyGroup[];
} {
  const candidates = [
    ...dependencies.filter(group => selected.has(group.sourceId) && selected.has(group.targetId)).map(group => ({ type: "dependency" as const, group })),
    ...inheritance.filter(group => selected.has(group.sourceId) && selected.has(group.targetId)).map(group => ({ type: "inheritance" as const, group })),
  ];
  const relationDegrees = groupDegrees([...dependencies, ...inheritance]);
  const ranked = [...candidates].sort((left, right) =>
    (relationDegrees.get(right.group.sourceId)! + relationDegrees.get(right.group.targetId)!) -
      (relationDegrees.get(left.group.sourceId)! + relationDegrees.get(left.group.targetId)!) ||
    compareText(left.group.key, right.group.key));
  const selectedGroups = new Map<string, typeof candidates[number]>();
  let selectedRecords = 0;
  const add = (candidate: typeof candidates[number] | undefined) => {
    if (!candidate || selectedGroups.size >= limit || selectedGroups.has(`${candidate.type}:${candidate.group.key}`) ||
      selectedRecords + candidate.group.sourceEdgeIds.length > maxSourceRecords) return;
    selectedGroups.set(`${candidate.type}:${candidate.group.key}`, candidate);
    selectedRecords += candidate.group.sourceEdgeIds.length;
  };
  // Preserve exact/unresolved dependency examples and an inheritance example before filling by connectivity.
  for (const resolution of ["Exact", "Unresolved"] as const) add(ranked.find(item => item.type === "dependency" && item.group.resolution === resolution));
  add(ranked.find(item => item.type === "inheritance"));
  for (const candidate of ranked) add(candidate);
  const selectedItems = [...selectedGroups.values()].sort((left, right) => compareText(left.group.key, right.group.key));
  return {
    dependencies: selectedItems.filter(item => item.type === "dependency").map(item => item.group),
    inheritance: selectedItems.filter(item => item.type === "inheritance").map(item => item.group),
  };
}

function nearestSourceClassifier(id: string, byId: ReadonlyMap<string, CcmNode>, sourceClassifiers: ReadonlySet<string>): string | null {
  const visited = new Set<string>();
  let current: string | null = id;
  while (current) {
    if (visited.has(current)) return null;
    visited.add(current);
    if (sourceClassifiers.has(current)) return current;
    current = byId.get(current)?.parentId ?? null;
  }
  return null;
}

function validateKind(projection: DiagramProjection, expected: DiagramProjection["kind"], name: string): void {
  if (projection.kind !== expected) throw new TypeError(`${name} must be a ${expected} diagram projection`);
}

/**
 * Build a bounded human/PDF UML reading view. BCE roles are display heuristics based on
 * classifier names and paths; the canonical CCM facts, IDs, endpoints, and Markdown are untouched.
 */
export function buildArchitectureUml(
  software: DiagramProjection,
  originalUml: DiagramProjection,
  options: ArchitectureUmlOptions = {},
): ArchitectureUmlResult {
  validateKind(software, "software-structure", "software");
  validateKind(originalUml, "uml-class", "originalUml");
  const maxClassifiers = positiveLimit(options.maxClassifiers, 40, "maxClassifiers");
  const maxMembersPerClassifier = positiveLimit(options.maxMembersPerClassifier, 4, "maxMembersPerClassifier");
  const maxRelations = positiveLimit(options.maxRelations, 100, "maxRelations");
  const maxSourceRecords = positiveLimit(options.maxSourceRecords, 500, "maxSourceRecords");

  // Prefer the full graph's node records, then fill classifier/member omissions from the original UML.
  const byId = new Map<string, CcmNode>();
  for (const node of software.nodes) byId.set(node.id, node);
  for (const node of originalUml.nodes) byId.set(node.id, node);
  const allNodes = [...byId.values()];
  const classifiers = allNodes.filter(node => CLASSIFIER_KINDS.has(node.kind) && node.origin === "source").sort(compareNodes);
  const classifierIds = new Set(classifiers.map(node => node.id));
  const roles: Record<string, HumanUmlRoleMetadata> = Object.fromEntries(classifiers.map(node => [node.id, classify(node)]));
  const dependencyEdges = software.edges.filter(edge => DEPENDENCY_KINDS.has(edge.kind));
  const sourceUmlEdges = originalUml.edges.filter(edge => edge.kind === "EXTENDS" || edge.kind === "IMPLEMENTS");
  const ownerById = new Map<string, string>();
  for (const node of allNodes) {
    const owner = nearestSourceClassifier(node.id, byId, classifierIds);
    if (owner) ownerById.set(node.id, owner);
  }
  const { groups, unownedEdges, internalEdges } = relationGroups(dependencyEdges, ownerById);
  const inheritanceEdges = sourceUmlEdges.filter(edge => edge.resolution === "Exact");
  const inheritanceGrouping = relationGroups(inheritanceEdges, ownerById);
  const inheritanceGroups = inheritanceGrouping.groups;
  const connectivityGroups = [...groups, ...inheritanceGroups];
  const selectedClassifiers = selectClassifiers(classifiers, connectivityGroups, roles, maxClassifiers);
  const selectedIds = new Set(selectedClassifiers.map(node => node.id));
  const displayedRelations = selectGroups(groups, inheritanceGroups, selectedIds, maxRelations, maxSourceRecords);
  const displayedGroups = displayedRelations.dependencies;
  const displayedInheritance = displayedRelations.inheritance;

  const allMembersByOwner = new Map<string, CcmNode[]>();
  for (const node of allNodes) {
    if (!MEMBER_KINDS.has(node.kind)) continue;
    const owner = ownerById.get(node.id);
    if (!owner) continue;
    const members = allMembersByOwner.get(owner) ?? [];
    members.push(node);
    allMembersByOwner.set(owner, members);
  }
  for (const members of allMembersByOwner.values()) members.sort(compareNodes);
  const allMembers = [...allMembersByOwner.values()].flat();
  const selectedMembers = selectedClassifiers.flatMap(classifier => (allMembersByOwner.get(classifier.id) ?? []).slice(0, maxMembersPerClassifier));
  // Flatten ownership only in this display projection so the human renderer can keep members inside their class.
  const displayMembers = selectedMembers.map(member => {
    const ownerId = ownerById.get(member.id)!;
    return member.parentId === ownerId ? member : { ...member, parentId: ownerId };
  });
  const displayNodes = [...selectedClassifiers, ...displayMembers];
  const displayNodeIds = new Set(displayNodes.map(node => node.id));
  const allSourceEdges = [...sourceUmlEdges, ...dependencyEdges].sort((left, right) => compareText(left.id, right.id));
  const sourceEdges = [...new Map(allSourceEdges.map(edge => [edge.id, edge])).values()];
  const displayedRelationGroups = [...displayedGroups, ...displayedInheritance];
  const uniqueEdges = [...new Map(displayedRelationGroups.flatMap(group => group.sourceEdges).map(edge => [edge.id, edge])).values()]
    .sort((left, right) => compareText(left.id, right.id));
  const displayedSourceEdgeIds = new Set(uniqueEdges.map(edge => edge.id));
  const unresolvedReferenceIds = allNodes.filter(node => node.kind === "UnresolvedReference").map(node => node.id).sort(compareText);
  const unresolvedSourceEdgeIds = [...new Set([
    ...dependencyEdges.filter(edge => edge.resolution === "Unresolved" ||
      byId.get(edge.sourceId)?.kind === "UnresolvedReference" || byId.get(edge.targetId)?.kind === "UnresolvedReference").map(edge => edge.id),
    ...sourceUmlEdges.filter(edge => edge.resolution === "Unresolved" ||
      byId.get(edge.sourceId)?.kind === "UnresolvedReference" || byId.get(edge.targetId)?.kind === "UnresolvedReference").map(edge => edge.id),
  ])].sort(compareText);
  const renderedUnresolvedEdgeIds = new Set(displayedGroups.filter(group => group.resolution === "Unresolved").flatMap(group => group.sourceEdgeIds));
  const omittedUnresolved = unresolvedSourceEdgeIds.filter(edgeId => !renderedUnresolvedEdgeIds.has(edgeId)).length;

  const totalEdges = connectivityGroups.reduce((sum, group) => sum + group.sourceEdgeIds.length, 0);
  const shownEdges = displayedRelationGroups.reduce((sum, group) => sum + group.sourceEdgeIds.length, 0);
  const totalInheritanceEdges = inheritanceGroups.reduce((sum, group) => sum + group.sourceEdgeIds.length, 0);
  const shownInheritanceEdges = displayedInheritance.reduce((sum, group) => sum + group.sourceEdgeIds.length, 0);
  const totalMembers = allMembers.length;
  const shownMembers = selectedMembers.length;
  const summary: ArchitectureUmlSummary = {
    totalNodes: classifiers.length,
    shownNodes: selectedClassifiers.length,
    totalEdges,
    shownEdges,
    totalInheritanceEdges,
    shownInheritanceEdges,
    totalRelations: connectivityGroups.length,
    shownRelations: displayedRelationGroups.length,
    totalMembers,
    shownMembers,
    clippedValues: 0,
    omittedUnresolved,
    unresolvedReferences: unresolvedReferenceIds.length,
    unownedDependencyEdges: unownedEdges,
    internalDependencyEdges: internalEdges,
    unownedInheritanceEdges: inheritanceGrouping.unownedEdges,
    internalInheritanceEdges: inheritanceGrouping.internalEdges,
    omittedClassifiers: classifiers.length - selectedClassifiers.length,
    omittedMembers: totalMembers - shownMembers,
    omittedRelations: connectivityGroups.length - displayedRelationGroups.length,
    classificationBasis: optionBasisCounts(roles),
  };

  const humanMetadata = {
    direction: "TB" as const,
    roles,
    dependencies: displayedGroups.map(withoutGroupKey),
    inheritanceRelations: displayedInheritance.map(withoutGroupKey),
    unresolvedReferenceCount: unresolvedReferenceIds.length,
    unresolvedSourceEdgeIds,
    omittedUnresolved,
  };
  const projection: HumanUmlProjection & { humanMetadata: typeof humanMetadata } = projectHumanDiagram({
    ...originalUml,
    title: "Architecture Class Diagram",
    mermaid: "classDiagram",
    nodes: displayNodes,
    // Retain original source edge records/endpoints, but bound the renderer input by whole relation groups.
    edges: uniqueEdges,
    nodeMappings: [],
    edgeMappings: [],
    excludedNodeIds: [...new Set([...originalUml.excludedNodeIds, ...software.excludedNodeIds,
      ...allNodes.filter(node => !displayNodeIds.has(node.id)).map(node => node.id)])].sort(compareText),
    excludedEdgeIds: [...new Set([...originalUml.excludedEdgeIds, ...software.excludedEdgeIds,
      ...software.edges.filter(edge => !DEPENDENCY_KINDS.has(edge.kind)).map(edge => edge.id),
      ...originalUml.edges.filter(edge => edge.kind !== "EXTENDS" && edge.kind !== "IMPLEMENTS").map(edge => edge.id),
      ...sourceEdges.filter(edge => !displayedSourceEdgeIds.has(edge.id)).map(edge => edge.id)])],
    humanMetadata,
  });
  const renderedEdgeIds = new Set(projection.edgeMappings.map(mapping => mapping.edgeId));
  projection.excludedEdgeIds = [...new Set([...projection.excludedEdgeIds,
    ...uniqueEdges.filter(edge => !renderedEdgeIds.has(edge.id)).map(edge => edge.id)])].sort(compareText);

  return {
    projection,
    summary,
    roles,
    dependencies: groups.map(withoutGroupKey),
    inheritanceRelations: inheritanceGroups.map(withoutGroupKey),
    sourceEdges,
    unresolvedSourceEdgeIds,
  };
}
