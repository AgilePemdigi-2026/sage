import type { CcmEdge, CcmNode } from "@sage/contracts";
import type { DiagramEdgeMapping, DiagramNodeMapping, DiagramProjection } from "./diagrams.ts";

const REFERENCE_KINDS = new Set<CcmEdge["kind"]>([
  "IMPORTS", "EXPORTS", "EXTENDS", "IMPLEMENTS", "TYPE_REFERENCES", "CALLS", "INSTANTIATES", "READS", "WRITES", "THROWS", "INCLUDES",
]);
const OVERVIEW_GROUP_LIMIT = 12;
const FOCUS_FILE_LIMIT = 12;
const MAX_RELATIONS = 100;
const MAX_EDGE_RECORDS = 500;
type PendingRelation = { sourceGroupId: string; targetGroupId: string; sourceFilePath: string | null; targetFilePath: string | null; edges: CcmEdge[] };
const compareText = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;

export interface SoftwareOverviewGroup {
  /** Stable display key derived from the directory, not a CCM node ID. */
  id: string;
  label: string;
  filePaths: string[];
  /** Original CCM IDs grouped under this directory. */
  nodeIds: string[];
  moduleNodeIds: string[];
  fileCount: number;
  referenceCount: number;
}

export interface SoftwareOverviewRelation {
  /** Mermaid aliases in the returned display projection. */
  sourceId: string;
  targetId: string;
  kinds: Array<{ kind: CcmEdge["kind"]; count: number }>;
  resolution: "Exact";
  sourceEdgeIds: string[];
  evidence: CcmEdge["evidence"];
  sourceEdges: CcmEdge[];
  omittedSourceEdgeCount: number;
}

export interface SoftwareOverviewSummary {
  totalGroups: number;
  shownGroups: number;
  omittedGroups: number;
  totalFiles: number;
  shownFiles: number;
  totalExactRelations: number;
  shownExactRelations: number;
  unresolvedReferences: number;
  omittedUnresolvedReferences: number;
  omittedFocusFiles: number;
  omittedSourceEdgeRecords: number;
  focusGroupId: string | null;
}

export interface SoftwareOverviewOptions {
  focusGroupId?: string;
  maxGroups?: number;
  maxFiles?: number;
}

export interface SoftwareOverviewResult {
  diagram: DiagramProjection;
  /** All source-backed directory groups, including groups outside the default view. */
  groups: SoftwareOverviewGroup[];
  /** Exact reference edges represented by the rendered arrows. */
  relations: SoftwareOverviewRelation[];
  /** Unresolved source references remain diagnostics, never graph arrows. */
  unresolved: Array<{ groupId: string; reason: string; count: number; edgeIds: string[]; omittedEdgeCount: number }>;
  summary: SoftwareOverviewSummary;
  /** True when Mermaid boxes represent directory summaries rather than individual CCM nodes. */
  groupedDisplay: true;
}

function stableId(prefix: string, value: string): string {
  const encoded = Array.from({ length: value.length }, (_, index) => value.charCodeAt(index).toString(16).padStart(4, "0")).join("");
  return `${prefix}_${encoded || "00"}`;
}

function fileCountLabel(count: number): string {
  return `${count} ${count === 1 ? "file" : "files"}`;
}

function safeLabel(value: string, max = 64): string {
  const text = Array.from(value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ").replace(/\s+/gu, " ").trim()).slice(0, max).join("");
  let out = "";
  for (const character of text || "source") {
    const codePoint = character.codePointAt(0)!;
    const visible = (codePoint >= 0xd800 && codePoint <= 0xdfff) || codePoint === 0xfffe || codePoint === 0xffff
      ? `\\u${codePoint.toString(16).padStart(4, "0")}`
      : character;
    for (const item of visible) {
      if (/[A-Za-z0-9 .,/:=]/u.test(item)) out += item;
      else out += `#${item.codePointAt(0)};`;
    }
  }
  return out;
}

function directoryGroup(filePath: string): string {
  const parts = filePath.replaceAll("\\", "/").split("/").filter(Boolean);
  if (!parts.length) return "Repository root";
  if (parts[0] === "apps" && parts.length >= 2) {
    const base = parts.slice(0, 2);
    if (parts[2] === "app") {
      base.push("app");
      const routeStart = parts[3] === "api" && parts.length >= 5 ? 4 : 3;
      if (parts[routeStart]) base.push(parts[routeStart]);
      return base.join("/");
    }
    if (parts[2] === "components" && parts[3]) return [...base, "components", parts[3]].join("/");
    if (parts[2] === "lib" && parts[3]) return [...base, "lib", parts[3]].join("/");
    if (parts[2]) return [...base, parts[2]].join("/");
    return base.join("/");
  }
  if (parts[0] === "packages" && parts[1]) return parts.slice(0, 2).join("/");
  if (parts[0] === "src" && parts[1] === "app" && parts[2]) {
    const routeStart = parts[2] === "api" && parts.length >= 4 ? 3 : 2;
    return parts.slice(0, Math.min(parts.length, routeStart + 1)).join("/");
  }
  if (parts[0] === "src" && parts[1]) return parts.slice(0, 2).join("/");
  const directory = parts.slice(0, -1);
  return directory.length ? directory.slice(0, Math.min(directory.length, 2)).join("/") : "Repository root";
}

function limits(options: SoftwareOverviewOptions): { maxGroups: number; maxFiles: number } {
  const maxGroups = options.maxGroups ?? 12;
  const maxFiles = options.maxFiles ?? 12;
  if (!Number.isSafeInteger(maxGroups) || maxGroups < 0 || maxGroups > OVERVIEW_GROUP_LIMIT) {
    throw new RangeError(`maxGroups must be an integer between 0 and ${OVERVIEW_GROUP_LIMIT}`);
  }
  if (!Number.isSafeInteger(maxFiles) || maxFiles < 0 || maxFiles > FOCUS_FILE_LIMIT) {
    throw new RangeError(`maxFiles must be an integer between 0 and ${FOCUS_FILE_LIMIT}`);
  }
  return { maxGroups, maxFiles };
}

function groupSourceNodes(nodes: readonly CcmNode[]): SoftwareOverviewGroup[] {
  const source = nodes.filter(node => node.origin === "source" && typeof node.filePath === "string" && node.filePath.length > 0)
    .sort((a, b) => compareText(a.filePath ?? "", b.filePath ?? "") || compareText(a.id, b.id));
  const filesByGroup = new Map<string, Map<string, CcmNode[]>>();
  for (const node of source) {
    const filePath = node.filePath!;
    const directory = directoryGroup(filePath);
    const files = filesByGroup.get(directory) ?? new Map<string, CcmNode[]>();
    const fileNodes = files.get(filePath) ?? [];
    fileNodes.push(node);
    files.set(filePath, fileNodes);
    filesByGroup.set(directory, files);
  }
  return [...filesByGroup].map(([label, files]) => {
    const filePaths = [...files.keys()].sort(compareText);
    const nodeIds = filePaths.flatMap(path => files.get(path)!.map(node => node.id)).sort(compareText);
    const moduleNodeIds = filePaths.flatMap(path => files.get(path)!.filter(node => node.kind === "Module").map(node => node.id)).sort(compareText);
    return { id: stableId("g", label), label, filePaths, nodeIds, moduleNodeIds, fileCount: filePaths.length, referenceCount: 0 };
  }).sort((left, right) => compareText(left.label, right.label) || compareText(left.id, right.id));
}

function sourceGroupByNode(nodes: readonly CcmNode[], groups: readonly SoftwareOverviewGroup[]): Map<string, string> {
  const groupByFile = new Map(groups.flatMap(group => group.filePaths.map(path => [path, group.id] as const)));
  return new Map(nodes.filter(node => node.origin === "source" && node.filePath && groupByFile.has(node.filePath))
    .map(node => [node.id, groupByFile.get(node.filePath!)!]));
}

function sourceFileByNode(nodes: readonly CcmNode[]): Map<string, string> {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const output = new Map<string, string>();
  for (const node of nodes) {
    if (node.origin !== "source") continue;
    let current: CcmNode | undefined = node;
    const visited = new Set<string>();
    while (current && !visited.has(current.id)) {
      visited.add(current.id);
      if (current.origin === "source" && current.filePath) {
        output.set(node.id, current.filePath);
        break;
      }
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
  }
  return output;
}

function buildArrowLabel(edges: readonly CcmEdge[]): string {
  const counts = new Map<CcmEdge["kind"], number>();
  for (const edge of edges) counts.set(edge.kind, (counts.get(edge.kind) ?? 0) + 1);
  const labels = [...counts].sort((a, b) => b[1] - a[1] || compareText(a[0], b[0])).slice(0, 3)
    .map(([kind, count]) => `${kind.toLowerCase()}${count > 1 ? ` x${count}` : ""}`);
  return safeLabel(labels.join(" · "), 48);
}

function buildProjection(
  software: DiagramProjection,
  groups: SoftwareOverviewGroup[],
  visibleGroups: SoftwareOverviewGroup[],
  focusGroup: SoftwareOverviewGroup | null,
  options: { maxFiles: number },
): { diagram: DiagramProjection; relations: SoftwareOverviewRelation[]; unresolved: SoftwareOverviewResult["unresolved"]; shownFiles: number; omittedSourceEdgeRecords: number; omittedUnresolvedRecords: number } {
  const nodesById = new Map(software.nodes.map(node => [node.id, node]));
  const groupsById = new Map(groups.map(group => [group.id, group]));
  const groupByNodeId = sourceGroupByNode(software.nodes, groups);
  const fileByNodeId = sourceFileByNode(software.nodes);
  const sortedEdges = [...software.edges].sort((a, b) => compareText(a.id, b.id));
  const fileRepresentatives = new Map<string, CcmNode>();
  for (const node of [...software.nodes].sort((a, b) => compareText(a.filePath ?? "", b.filePath ?? "") || compareText(a.id, b.id))) {
    if (node.kind === "Module" && node.origin === "source" && node.filePath && !fileRepresentatives.has(node.filePath)) fileRepresentatives.set(node.filePath, node);
  }
  const maxExpandedFiles = focusGroup ? Math.min(options.maxFiles, 8) : 0;
  const focusFiles = focusGroup ? focusGroup.filePaths
    .map(path => fileRepresentatives.get(path))
    .filter((node): node is CcmNode => Boolean(node))
    .sort((a, b) => compareText(a.filePath ?? "", b.filePath ?? "") || compareText(a.id, b.id))
    .slice(0, maxExpandedFiles) : [];
  const selectedFiles = new Set(focusFiles.map(node => node.filePath!));

  const exactGroups = new Map<string, PendingRelation>();
  const unresolvedCounts = new Map<string, { groupId: string; reason: string; count: number; edges: CcmEdge[] }>();
  let omittedUnresolvedRecords = 0;
  let omittedExactRecords = 0;
  let retainedExactRecords = 0;
  let retainedUnresolvedRecords = 0;
  const candidateNeighborCounts = new Map<string, number>();
  for (const edge of sortedEdges) {
    if (edge.kind === "CONTAINS" || !REFERENCE_KINDS.has(edge.kind)) continue;
    const sourceGroupId = groupByNodeId.get(edge.sourceId), targetGroupId = groupByNodeId.get(edge.targetId);
    if (edge.resolution === "Unresolved") {
      const groupId = sourceGroupId ?? targetGroupId;
      if (!groupId) continue;
      const reason = edge.unresolvedReason ?? "UNKNOWN_RECEIVER";
      const key = `${groupId}\0${reason}`;
      const current = unresolvedCounts.get(key) ?? { groupId, reason, count: 0, edges: [] };
      current.count += 1;
      if (retainedUnresolvedRecords < MAX_EDGE_RECORDS) {
        current.edges.push(edge);
        retainedUnresolvedRecords += 1;
      } else omittedUnresolvedRecords += 1;
      unresolvedCounts.set(key, current);
      continue;
    }
    if (edge.resolution !== "Exact" || !sourceGroupId || !targetGroupId || !focusGroup || sourceGroupId === targetGroupId) continue;
    if (sourceGroupId === focusGroup.id) {
      const sourceFilePath = fileByNodeId.get(edge.sourceId);
      if (sourceFilePath && selectedFiles.has(sourceFilePath)) candidateNeighborCounts.set(targetGroupId, (candidateNeighborCounts.get(targetGroupId) ?? 0) + 1);
    }
    if (targetGroupId === focusGroup.id) {
      const targetFilePath = fileByNodeId.get(edge.targetId);
      if (targetFilePath && selectedFiles.has(targetFilePath)) candidateNeighborCounts.set(sourceGroupId, (candidateNeighborCounts.get(sourceGroupId) ?? 0) + 1);
    }
  }

  const neighborLimit = Math.min(4, Math.max(0, FOCUS_FILE_LIMIT - focusFiles.length));
  const neighborGroupIds = new Set(focusGroup
    ? [...candidateNeighborCounts.keys()].filter(groupId => groupsById.get(groupId)?.moduleNodeIds.length)
      .sort((left, right) => candidateNeighborCounts.get(right)! - candidateNeighborCounts.get(left)! ||
        (groupsById.get(right)?.referenceCount ?? 0) - (groupsById.get(left)?.referenceCount ?? 0) ||
        compareText(groupsById.get(left)?.label ?? left, groupsById.get(right)?.label ?? right))
      .slice(0, neighborLimit)
    : []);
  const visibleGroupIds = new Set(visibleGroups.map(group => group.id));

  for (const edge of sortedEdges) {
    if (edge.kind === "CONTAINS" || edge.resolution !== "Exact" || !REFERENCE_KINDS.has(edge.kind)) continue;
    const sourceGroupId = groupByNodeId.get(edge.sourceId), targetGroupId = groupByNodeId.get(edge.targetId);
    if (!sourceGroupId || !targetGroupId) continue;
    let sourceFilePath: string | null = null;
    let targetFilePath: string | null = null;
    if (focusGroup) {
      if (sourceGroupId === focusGroup.id) {
        sourceFilePath = fileByNodeId.get(edge.sourceId) ?? null;
        if (!sourceFilePath || !selectedFiles.has(sourceFilePath)) continue;
        if (targetGroupId !== focusGroup.id && !neighborGroupIds.has(targetGroupId)) continue;
      }
      if (targetGroupId === focusGroup.id) {
        targetFilePath = fileByNodeId.get(edge.targetId) ?? null;
        if (!targetFilePath || !selectedFiles.has(targetFilePath)) continue;
        if (sourceGroupId !== focusGroup.id && !neighborGroupIds.has(sourceGroupId)) continue;
      }
      if (sourceGroupId !== focusGroup.id && targetGroupId !== focusGroup.id) continue;
    } else if (sourceGroupId === targetGroupId || !visibleGroupIds.has(sourceGroupId) || !visibleGroupIds.has(targetGroupId)) continue;
    const sourceKey = sourceFilePath ? stableId("f", sourceFilePath) : sourceGroupId;
    const targetKey = targetFilePath ? stableId("f", targetFilePath) : targetGroupId;
    const key = `${sourceKey}\0${targetKey}`;
    const current = exactGroups.get(key);
    if (!current && exactGroups.size >= MAX_RELATIONS) {
      omittedExactRecords += 1;
      continue;
    }
    if (retainedExactRecords >= MAX_EDGE_RECORDS) {
      omittedExactRecords += 1;
      continue;
    }
    const relation = current ?? { sourceGroupId, targetGroupId, sourceFilePath, targetFilePath, edges: [] };
    relation.edges.push(edge);
    exactGroups.set(key, relation);
    retainedExactRecords += 1;
  }

  const groupAliasByGroup = new Map(visibleGroups.map(group => [group.id, `G_${group.id.slice(2)}`]));
  const nodes: CcmNode[] = [];
  const displayItems: Array<{ key: string; groupId: string; label: string; node: CcmNode; filePath: string | null }> = [];
  const usedNodeIds = new Set<string>();
  if (focusGroup) {
    for (const node of focusFiles) {
      const alias = stableId("F", node.id);
      nodes.push(node);
      usedNodeIds.add(node.id);
      displayItems.push({ key: alias, groupId: focusGroup.id, label: node.filePath!.split("/").at(-1) ?? focusGroup.label, node, filePath: node.filePath });
    }
    const neighborGroups = groups.filter(group => neighborGroupIds.has(group.id) && group.id !== focusGroup.id)
      .sort((a, b) => (candidateNeighborCounts.get(b.id) ?? 0) - (candidateNeighborCounts.get(a.id) ?? 0) ||
        b.referenceCount - a.referenceCount || compareText(a.label, b.label));
    for (const group of neighborGroups) {
      const representative = group.filePaths.map(path => fileRepresentatives.get(path)).find((item): item is CcmNode => Boolean(item));
      if (!representative) continue;
      const alias = `G_${group.id.slice(2)}`;
      displayItems.push({ key: alias, groupId: group.id, label: `${group.label} · ${fileCountLabel(group.fileCount)}`, node: representative, filePath: null });
      if (!usedNodeIds.has(representative.id)) {
        nodes.push(representative);
        usedNodeIds.add(representative.id);
      }
    }
  } else {
    for (const group of visibleGroups) {
      const representative = group.filePaths.map(path => fileRepresentatives.get(path)).find((item): item is CcmNode => Boolean(item));
      if (!representative) continue;
      const alias = groupAliasByGroup.get(group.id)!;
      displayItems.push({ key: alias, groupId: group.id, label: `${group.label} · ${fileCountLabel(group.fileCount)}`, node: representative, filePath: null });
      nodes.push(representative);
      usedNodeIds.add(representative.id);
    }
  }

  const itemByGroup = new Map(displayItems.filter(item => item.filePath === null).map(item => [item.groupId, item]));
  const itemByFile = new Map(displayItems.filter(item => item.filePath !== null).map(item => [`${item.groupId}\0${item.filePath}`, item]));
  const sourceDisplayAlias = (relation: PendingRelation, side: "source" | "target"): string | null => {
    const groupId = side === "source" ? relation.sourceGroupId : relation.targetGroupId;
    const filePath = side === "source" ? relation.sourceFilePath : relation.targetFilePath;
    if (filePath) return itemByFile.get(`${groupId}\0${filePath}`)?.key ?? null;
    return itemByGroup.get(groupId)?.key ?? null;
  };

  const header = ["flowchart TB"];
  const nodeMappings: DiagramNodeMapping[] = [];
  const category = (label: string) => label.startsWith("apps/") ? "apps" : label.startsWith("packages/") ? "packages" : label === "Repository root" ? "root" : "source";
  const categoryLabel: Record<string, string> = { apps: "Applications", packages: "Packages", root: "Repository root", source: "Source folders" };
  const byCategory = new Map<string, typeof displayItems>();
  for (const item of displayItems) {
    const key = category(groups.find(group => group.id === item.groupId)?.label ?? item.groupId);
    const items = byCategory.get(key) ?? [];
    items.push(item);
    byCategory.set(key, items);
  }
  let currentLine = header.length;
  for (const [categoryKey, items] of [...byCategory].sort(([a], [b]) => compareText(a, b))) {
    const subgraphId = `L_${categoryKey.toUpperCase()}`;
    header.push(`  subgraph ${subgraphId}["${categoryLabel[categoryKey]}"]`);
    currentLine += 1;
    for (const item of items.sort((a, b) => compareText(a.label, b.label) || compareText(a.key, b.key))) {
      const label = safeLabel(item.label);
      header.push(`    ${item.key}["${label}"]`);
      currentLine += 1;
      if (item.filePath) {
        const group = groups.find(value => value.id === item.groupId)!;
        for (const nodeId of group.moduleNodeIds) {
          if (fileByNodeId.get(nodeId) !== item.filePath) continue;
          nodeMappings.push({ nodeId, mermaidId: item.key, mermaidLine: currentLine, evidence: nodesById.get(nodeId)?.location ?? null });
        }
      } else {
        const group = groups.find(value => value.id === item.groupId);
        if (group) for (const nodeId of group.moduleNodeIds) nodeMappings.push({ nodeId, mermaidId: item.key, mermaidLine: currentLine, evidence: nodesById.get(nodeId)?.location ?? null });
      }
      const styles: Record<string, string> = {
        apps: "fill:#ddf4ff,stroke:#0969da,color:#0550ae,stroke-width:2px",
        packages: "fill:#dafbe1,stroke:#1a7f37,color:#116329,stroke-width:2px",
        source: "fill:#fff8c5,stroke:#bf8700,color:#7d4e00,stroke-width:2px",
        root: "fill:#fbefff,stroke:#8250df,color:#6639ba,stroke-width:2px",
      };
      header.push(`    style ${item.key} ${styles[categoryKey]}`);
      currentLine += 1;
    }
    header.push("  end");
    currentLine += 1;
  }

  const renderedRelations = [...exactGroups.values()].filter(group => sourceDisplayAlias(group, "source") && sourceDisplayAlias(group, "target"))
    .sort((a, b) => compareText(sourceDisplayAlias(a, "source")!, sourceDisplayAlias(b, "source")!) || compareText(sourceDisplayAlias(a, "target")!, sourceDisplayAlias(b, "target")!))
    .slice(0, MAX_RELATIONS);
  const relations: SoftwareOverviewRelation[] = [];
  const edgeMappings: DiagramEdgeMapping[] = [];
  const projectedEdges: CcmEdge[] = [];
  let emittedEdgeRecords = 0;
  for (const relation of renderedRelations) {
    const sourceAlias = sourceDisplayAlias(relation, "source"), targetAlias = sourceDisplayAlias(relation, "target");
    if (!sourceAlias || !targetAlias || sourceAlias === targetAlias) continue;
    const edges = [...relation.edges].sort((a, b) => compareText(a.id, b.id));
    const byKind = new Map<CcmEdge["kind"], CcmEdge[]>();
    for (const edge of edges) {
      const items = byKind.get(edge.kind) ?? [];
      items.push(edge);
      byKind.set(edge.kind, items);
    }
    const allKinds = [...byKind].map(([kind, items]) => ({ kind, count: items.length })).sort((a, b) => b.count - a.count || compareText(a.kind, b.kind));
    const remaining = Math.max(0, MAX_EDGE_RECORDS - emittedEdgeRecords);
    const displayEdges = edges.slice(0, remaining);
    const representative = displayEdges[0];
    if (!representative) continue;
    const sourceEdgeIds = displayEdges.map(edge => edge.id);
    const evidence = displayEdges.flatMap(edge => edge.evidence);
    const lineNumber = header.length + 1;
    header.push(`  ${sourceAlias} -->|"${buildArrowLabel(displayEdges)}"| ${targetAlias}`);
    relations.push({ sourceId: sourceAlias, targetId: targetAlias, kinds: allKinds, resolution: "Exact", sourceEdgeIds, evidence, sourceEdges: displayEdges, omittedSourceEdgeCount: Math.max(0, edges.length - displayEdges.length) });
    projectedEdges.push(...displayEdges);
    for (const edge of displayEdges) edgeMappings.push({ edgeId: edge.id, mermaidLine: lineNumber, sourceMermaidId: sourceAlias, targetMermaidId: targetAlias, evidence: edge.evidence });
    emittedEdgeRecords += displayEdges.length;
  }

  // Invisible layout constraints keep fan-in and disconnected areas on a
  // vertical reading spine. They are not source relationships or evidence.
  const readingOrder = [...displayItems].sort((a, b) => compareText(a.label, b.label) || compareText(a.key, b.key));
  for (let index = 1; index < readingOrder.length; index += 1) {
    header.push(`  ${readingOrder[index - 1]!.key} ~~~ ${readingOrder[index]!.key}`);
  }

  const unresolved = [...unresolvedCounts.values()].sort((a, b) => compareText(a.groupId, b.groupId) || compareText(a.reason, b.reason))
    .map(item => ({ groupId: item.groupId, reason: item.reason, count: item.count, edgeIds: item.edges.map(edge => edge.id), omittedEdgeCount: Math.max(0, item.count - item.edges.length) }));
  const nodeIds = new Set(nodes.map(node => node.id));
  const projectedEdgeIds = new Set(projectedEdges.map(edge => edge.id));
  const shownFiles = focusGroup ? focusFiles.length : visibleGroups.reduce((sum, group) => sum + group.fileCount, 0);
  const omittedSourceEdgeRecords = omittedExactRecords;
  if (displayItems.length === 0) header.push("  %% No source-backed directories are available");
  const diagram: DiagramProjection = {
    kind: "software-structure",
    title: focusGroup ? `${focusGroup.label} file connections` : "Software Engineering Diagram",
    mermaid: header.join("\n"),
    nodes,
    edges: projectedEdges,
    nodeMappings,
    edgeMappings,
    excludedNodeIds: software.nodes.filter(node => !nodeIds.has(node.id)).map(node => node.id),
    excludedEdgeIds: software.edges.filter(edge => !projectedEdgeIds.has(edge.id)).map(edge => edge.id),
  };
  return { diagram, relations, unresolved, shownFiles, omittedSourceEdgeRecords, omittedUnresolvedRecords };
}

/** Build a deterministic directory overview and bounded file-level drilldown from CCM source evidence. */
export function buildSoftwareOverview(software: DiagramProjection, options: SoftwareOverviewOptions = {}): SoftwareOverviewResult {
  if (software.kind !== "software-structure") throw new TypeError("software must be a software-structure diagram");
  const { maxGroups, maxFiles } = limits(options);
  const groups = groupSourceNodes(software.nodes);
  const groupByNodeId = sourceGroupByNode(software.nodes, groups);
  const groupsById = new Map(groups.map(group => [group.id, group]));
  for (const edge of software.edges) {
    if (edge.kind === "CONTAINS" || edge.resolution !== "Exact" || !REFERENCE_KINDS.has(edge.kind)) continue;
    const source = groupByNodeId.get(edge.sourceId), target = groupByNodeId.get(edge.targetId);
    if (source && target && source !== target) {
      groupsById.get(source)!.referenceCount += 1;
      groupsById.get(target)!.referenceCount += 1;
    }
  }
  const requestedFocus = options.focusGroupId;
  const focusGroup = requestedFocus ? groups.find(group => group.id === requestedFocus) ?? null : null;
  if (requestedFocus && !focusGroup) throw new RangeError("focusGroupId is not a known source directory group");
  const ranked = [...groups].sort((a, b) => b.referenceCount - a.referenceCount || b.fileCount - a.fileCount || compareText(a.label, b.label));
  const visibleGroups = focusGroup
    ? [focusGroup]
    : ranked.slice(0, maxGroups).sort((a, b) => compareText(a.label, b.label));
  const projection = buildProjection(software, groups, visibleGroups, focusGroup, { maxFiles });
  const totalExactRelations = software.edges.filter(edge => {
    if (edge.kind === "CONTAINS" || edge.resolution !== "Exact" || !REFERENCE_KINDS.has(edge.kind)) return false;
    const source = groupByNodeId.get(edge.sourceId), target = groupByNodeId.get(edge.targetId);
    return Boolean(source && target && source !== target);
  }).length;
  const unresolvedReferences = projection.unresolved.reduce((sum, item) => sum + item.count, 0);
  const shownExactRelations = projection.relations.reduce((sum, relation) => sum + relation.sourceEdgeIds.length, 0);
  return {
    ...projection,
    groups,
    summary: {
      totalGroups: groups.length,
      shownGroups: visibleGroups.length,
      omittedGroups: Math.max(0, groups.length - visibleGroups.length),
      totalFiles: groups.reduce((sum, group) => sum + group.fileCount, 0),
      shownFiles: projection.shownFiles,
      totalExactRelations,
      shownExactRelations,
      unresolvedReferences,
      omittedUnresolvedReferences: projection.omittedUnresolvedRecords,
      omittedFocusFiles: focusGroup ? Math.max(0, focusGroup.fileCount - projection.shownFiles) : 0,
      omittedSourceEdgeRecords: projection.omittedSourceEdgeRecords,
      focusGroupId: focusGroup?.id ?? null,
    },
    groupedDisplay: true,
  };
}
