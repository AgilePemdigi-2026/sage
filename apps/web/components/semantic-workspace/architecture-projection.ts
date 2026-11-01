import type { SemanticEdge, SemanticKind, SemanticNode, SemanticPayload } from "@sage/documents/semantic/model";

/** A source-backed overview node. Feature nodes describe ownership; source nodes retain canonical identities. */
export interface ArchitectureNode {
  id: string;
  label: string;
  kind: SemanticKind;
  confidence: "proven" | "indicated";
  reason: string;
  evidence: SemanticNode["evidence"];
  sourceNodeIds: string[];
  featureIds: string[];
  routeLabels: string[];
  componentLabels: string[];
  decisionCount: number;
  sourceFileCount: number;
  isReferenceGroup?: boolean;
  referenceCount?: number;
}

/** Aggregated visual edge. Each member is an actual semantic source edge with its original endpoint IDs. */
export interface ArchitectureEdge {
  id: string;
  source: string;
  target: string;
  label: string;
  labels: string[];
  confidence: "proven" | "indicated";
  reason: string;
  sourceEdgeIds: string[];
  originalEndpoints: Array<{ source: string; target: string }>;
  evidence: SemanticEdge["evidence"];
}

export interface ArchitectureProjection {
  nodes: ArchitectureNode[];
  edges: ArchitectureEdge[];
  featureIds: string[];
  representedNodeIds: string[];
  representedEdgeIds: string[];
  hiddenNodeCount: number;
  hiddenEdgeCount: number;
}

const GROUPABLE_REFERENCE_KINDS = new Set<SemanticKind>(["actor", "store", "concept"]);

export interface ArchitectureProjectionOptions {
  featureIds?: string[];
  showIndications?: boolean;
  query?: string;
}

const EVIDENCE_LIMIT = 2_000;
const GLOBAL_KINDS = new Set<SemanticKind>(["actor", "store", "concept"]);

function uniqueEvidence(items: SemanticNode["evidence"]): SemanticNode["evidence"] {
  const unique = new Map<string, SemanticNode["evidence"][number]>();
  for (const item of items) {
    const key = `${item.filePath}\0${item.fileSha256}\0${item.startByte}\0${item.endByte}\0${item.role}`;
    if (!unique.has(key)) unique.set(key, item);
  }
  return [...unique.values()].sort((a, b) => a.filePath.localeCompare(b.filePath) || a.startByte - b.startByte || a.endByte - b.endByte || a.role.localeCompare(b.role)).slice(0, EVIDENCE_LIMIT);
}

/**
 * Build the initial architecture canvas from actual source relationships.
 * It keeps shared actors/data and the entry/controller boundary visible while
 * leaving branch details in the evidence panel. It never draws membership or
 * inferred-order edges.
 */
export function buildArchitectureProjection(payload: SemanticPayload, options: ArchitectureProjectionOptions = {}): ArchitectureProjection {
  const { model, overlay } = payload;
  const featureById = new Map(model.features.map(feature => [feature.id, feature]));
  const requested = options.featureIds ? new Set(options.featureIds.filter(id => featureById.has(id))) : null;
  const features = model.features.filter(feature => !requested || requested.has(feature.id)).sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
  const featureIds = new Set(features.map(feature => feature.id));
  const nodeById = new Map(model.nodes.map(node => [node.id, node]));
  const membershipsByNode = new Map<string, Set<string>>();

  for (const feature of features) {
    const members = new Set<string>(feature.nodeIds);
    members.add(feature.id);
    for (const nodeId of members) {
      const memberships = membershipsByNode.get(nodeId) ?? new Set<string>();
      memberships.add(feature.id);
      membershipsByNode.set(nodeId, memberships);
    }
  }
  // Canonical single ownership supplements feature membership lists. Explicit
  // user grouping has precedence and moves a node out of its prior frame.
  for (const node of model.nodes) {
    const corrected = overlay.groups[node.id];
    const memberships = membershipsByNode.get(node.id) ?? new Set<string>();
    if (corrected) {
      memberships.clear();
      if (featureIds.has(corrected)) memberships.add(corrected);
    } else if (node.featureId && featureIds.has(node.featureId)) memberships.add(node.featureId);
    membershipsByNode.set(node.id, memberships);
  }

  const query = options.query?.trim().toLocaleLowerCase() ?? "";
  const entryIds = new Set<string>();
  for (const feature of features) for (const id of feature.entryNodeIds) entryIds.add(id);
  const sourceEdges = model.edges.filter(edge => options.showIndications !== false || edge.confidence === "proven");
  const scopedEdgeIds = new Set(sourceEdges.map(edge => edge.id));
  const edgeScopesById = new Map<string, string[]>();
  for (const feature of features) for (const edgeId of feature.edgeIds) {
    if (!scopedEdgeIds.has(edgeId)) continue;
    const scopes = edgeScopesById.get(edgeId) ?? [];
    if (scopes.length <= 64) scopes.push(feature.id);
    edgeScopesById.set(edgeId, scopes);
  }
  const incident = new Map<string, SemanticEdge[]>();
  for (const edge of sourceEdges) {
    for (const nodeId of [edge.source, edge.target]) {
      const rows = incident.get(nodeId) ?? [];
      rows.push(edge);
      incident.set(nodeId, rows);
    }
  }

  const visibleIds = new Set<string>();
  for (const node of model.nodes) {
    const memberships = membershipsByNode.get(node.id) ?? new Set<string>();
    const global = GLOBAL_KINDS.has(node.kind) || (node.kind === "component" && memberships.size > 1);
    if (memberships.size > 0 && (options.showIndications !== false || node.confidence === "proven") && global && (incident.get(node.id)?.length ?? 0) > 0 &&
      (!query || [overlay.labels[node.id] ?? node.label, node.kind, ...node.evidence.map(item => item.filePath)].join(" ").toLocaleLowerCase().includes(query))) {
      visibleIds.add(node.id);
    }
  }
  const nodes: ArchitectureNode[] = [];
  const representedNodeIds = new Set<string>();
  for (const feature of features) {
    const relevant = model.nodes.filter(node => membershipsByNode.get(node.id)?.has(feature.id));
    const included = relevant.filter(node => options.showIndications !== false || node.confidence === "proven");
    const routeNodes = included.filter(node => entryIds.has(node.id));
    const componentNodes = included.filter(node => node.kind === "component" && (incident.get(node.id) ?? []).some(edge => {
      const other = nodeById.get(edge.source === node.id ? edge.target : edge.source);
      return other?.kind === "store" || (other !== undefined && entryIds.has(other.id));
    }));
    const decisions = included.filter(node => node.kind === "decision" && (incident.get(node.id)?.length ?? 0) > 0);
    const routes = [...new Set(routeNodes.map(node => overlay.labels[node.id] ?? node.label))].sort((a, b) => a.localeCompare(b));
    const components = [...new Set(componentNodes.map(node => overlay.labels[node.id] ?? node.label))].sort((a, b) => a.localeCompare(b));
    const label = overlay.labels[feature.id] ?? feature.label;
    if (query && ![label, ...routes, ...components].join(" ").toLocaleLowerCase().includes(query)) continue;
    const summarySourceNodeIds = [...new Set([feature.id, ...routeNodes.map(node => node.id), ...componentNodes.map(node => node.id), ...decisions.map(node => node.id)])].sort((a, b) => a.localeCompare(b));
    summarySourceNodeIds.forEach(id => representedNodeIds.add(id));
    const summaryEvidence = uniqueEvidence([...feature.evidence, ...summarySourceNodeIds.flatMap(id => nodeById.get(id)?.evidence ?? [])]);
    const evidenceFiles = new Set([...feature.evidence, ...included.flatMap(node => node.evidence)].map(item => item.filePath));
    const featureSource = nodeById.get(feature.id);
    nodes.push({
      id: feature.id, label, kind: "feature", confidence: featureSource?.confidence ?? "proven", reason: featureSource?.reason ?? "Source-backed feature responsibility group",
      evidence: summaryEvidence, sourceNodeIds: summarySourceNodeIds, featureIds: [feature.id],
      routeLabels: routes, componentLabels: components,
      decisionCount: decisions.length, sourceFileCount: evidenceFiles.size,
    });
  }
  for (const node of model.nodes) {
    if (!visibleIds.has(node.id)) continue;
    const memberships = [...(membershipsByNode.get(node.id) ?? [])].filter(id => featureIds.has(id));
    const confidence = node.confidence;
    representedNodeIds.add(node.id);
    nodes.push({
      id: node.id, label: overlay.labels[node.id] ?? node.label, kind: node.kind, confidence, reason: node.reason,
      evidence: uniqueEvidence(node.evidence), sourceNodeIds: [node.id], featureIds: memberships.sort((a, b) => a.localeCompare(b)),
      routeLabels: [], componentLabels: [], decisionCount: 0,
      sourceFileCount: new Set(node.evidence.slice(0, EVIDENCE_LIMIT).map(item => item.filePath)).size,
    });
  }
  const rendered = new Set(nodes.map(node => node.id));
  const visibleFeaturesById = new Map(features.map(feature => [feature.id, feature]));
  const globallyRendered = new Set([...visibleIds]);
  function endpoint(edge: SemanticEdge, nodeId: string): string | null {
    if (globallyRendered.has(nodeId)) return nodeId;
    const memberships = [...(membershipsByNode.get(nodeId) ?? [])].filter(id => featureIds.has(id));
    const edgeScopes = edgeScopesById.get(edge.id) ?? [];
    const scopes = edgeScopes.filter(id => memberships.includes(id) && rendered.has(id));
    if (scopes.length !== 1) return null;
    return scopes[0]!;
  }
  const edgeGroups = new Map<string, ArchitectureEdge>();
  const representedEdgeIds = new Set<string>();
  for (const edge of sourceEdges) {
    let source = endpoint(edge, edge.source);
    let target = endpoint(edge, edge.target);
    const edgeScopes = edgeScopesById.get(edge.id) ?? [];
    // A user's explicit group correction moves a local endpoint with its
    // source relationship. Remap only a uniquely scoped source edge; a shared
    // edge with competing feature scopes stays out of the overview.
    if (edgeScopes.length === 1) {
      if (!globallyRendered.has(edge.source) && overlay.groups[edge.source] && rendered.has(overlay.groups[edge.source])) source = overlay.groups[edge.source]!;
      if (!globallyRendered.has(edge.target) && overlay.groups[edge.target] && rendered.has(overlay.groups[edge.target])) target = overlay.groups[edge.target]!;
    }
    if (!source || !target || source === target || !rendered.has(source) || !rendered.has(target)) continue;
    const sourceNode = nodeById.get(edge.source);
    const targetNode = nodeById.get(edge.target);
    if (!sourceNode || !targetNode) continue;
    const endpointConfidence = sourceNode.confidence === "indicated" || targetNode.confidence === "indicated" ? "indicated" : edge.confidence;
    if (options.showIndications === false && endpointConfidence === "indicated") continue;
    const sourceFeature = visibleFeaturesById.get(source);
    const targetFeature = visibleFeaturesById.get(target);
    const routeLabel = sourceFeature && entryIds.has(edge.source) ? overlay.labels[edge.source] ?? sourceNode.label
      : targetFeature && entryIds.has(edge.target) ? overlay.labels[edge.target] ?? targetNode.label : null;
    const displayLabel = routeLabel ? `${edge.label} · ${routeLabel}` : edge.label;
    const key = `${source}\0${target}\0${endpointConfidence}`;
    const current = edgeGroups.get(key);
    if (current) {
      current.sourceEdgeIds.push(edge.id);
      current.labels.push(displayLabel);
      current.originalEndpoints.push({ source: edge.source, target: edge.target });
      current.evidence = uniqueEvidence([...current.evidence, ...edge.evidence]);
      representedNodeIds.add(edge.source);
      representedNodeIds.add(edge.target);
      representedEdgeIds.add(edge.id);
      continue;
    }
    // The drawn feature boundary represents the original endpoint as a grouped
    // source fact; preserve its canonical ID in the edge metadata as well.
    representedNodeIds.add(edge.source);
    representedNodeIds.add(edge.target);
    edgeGroups.set(key, {
      id: `source:${edge.id}`, source, target, label: displayLabel, labels: [displayLabel],
      confidence: endpointConfidence, reason: edge.reason, sourceEdgeIds: [edge.id],
      originalEndpoints: [{ source: edge.source, target: edge.target }], evidence: uniqueEvidence(edge.evidence),
    });
    representedEdgeIds.add(edge.id);
  }

  const nodeOrder: Record<SemanticKind, number> = { actor: 0, component: 1, feature: 2, store: 3, concept: 4, step: 5, decision: 6, outcome: 7 };
  const orderedNodes = [...nodes].sort((a, b) => nodeOrder[a.kind] - nodeOrder[b.kind] || a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
  return {
    nodes: orderedNodes,
    edges: [...edgeGroups.values()].map(edge => ({
      ...edge,
      labels: [...new Set(edge.labels)].sort((a, b) => a.localeCompare(b)),
      sourceEdgeIds: [...new Set(edge.sourceEdgeIds)].sort((a, b) => a.localeCompare(b)),
      originalEndpoints: [...edge.originalEndpoints].sort((a, b) => a.source.localeCompare(b.source) || a.target.localeCompare(b.target)),
      evidence: uniqueEvidence(edge.evidence),
    })).sort((a, b) => a.source.localeCompare(b.source) || a.target.localeCompare(b.target) || a.id.localeCompare(b.id)),
    featureIds: orderedNodes.filter(node => node.kind === "feature").map(node => node.id),
    representedNodeIds: [...representedNodeIds].sort((a, b) => a.localeCompare(b)),
    representedEdgeIds: [...representedEdgeIds],
    hiddenNodeCount: Math.max(0, model.nodes.length - representedNodeIds.size),
    hiddenEdgeCount: Math.max(0, model.edges.length - representedEdgeIds.size),
  };
}

/**
 * Compress repeated display references in the canvas only. A reference bucket
 * preserves the distinct source IDs and explicitly avoids asserting identity.
 */
export function aggregateArchitectureReferences(projection: ArchitectureProjection): ArchitectureProjection {
  const buckets = new Map<string, ArchitectureNode[]>();
  for (const node of projection.nodes) {
    if (!GROUPABLE_REFERENCE_KINDS.has(node.kind)) continue;
    const key = `${node.kind}\0${node.label}\0${node.confidence}`;
    const rows = buckets.get(key) ?? [];
    rows.push(node);
    buckets.set(key, rows);
  }

  const replacements = new Map<string, ArchitectureNode>();
  for (const [key, rows] of buckets) {
    if (rows.length < 2) continue;
    const [kind, label, confidence] = key.split("\0") as [SemanticKind, string, "proven" | "indicated"];
    const sourceNodeIds = [...new Set(rows.flatMap(node => node.sourceNodeIds))].sort((a, b) => a.localeCompare(b));
    const featureIds = [...new Set(rows.flatMap(node => node.featureIds))].sort((a, b) => a.localeCompare(b));
    const evidence = uniqueEvidence(rows.flatMap(node => node.evidence));
    const id = `__reference_group__:${kind}:${confidence}:${encodeURIComponent(label)}`;
    const group: ArchitectureNode = {
      id,
      label: `${label} references (${sourceNodeIds.length})`,
      kind,
      confidence,
      reason: "Presentation-only bucket: separate source references are grouped by displayed label; this does not prove one identity or datastore.",
      evidence,
      sourceNodeIds,
      featureIds,
      routeLabels: [...new Set(rows.flatMap(node => node.routeLabels))].sort((a, b) => a.localeCompare(b)),
      componentLabels: [...new Set(rows.flatMap(node => node.componentLabels))].sort((a, b) => a.localeCompare(b)),
      decisionCount: rows.reduce((total, node) => total + node.decisionCount, 0),
      sourceFileCount: new Set(rows.flatMap(node => node.evidence.map(item => item.filePath))).size,
      isReferenceGroup: true,
      referenceCount: sourceNodeIds.length,
    };
    for (const node of rows) replacements.set(node.id, group);
  }

  const nodesById = new Map<string, ArchitectureNode>();
  for (const node of projection.nodes) {
    const replacement = replacements.get(node.id) ?? node;
    nodesById.set(replacement.id, replacement);
  }

  const edges = new Map<string, ArchitectureEdge>();
  for (const edge of projection.edges) {
    const source = replacements.get(edge.source)?.id ?? edge.source;
    const target = replacements.get(edge.target)?.id ?? edge.target;
    const key = `${source}\0${target}\0${edge.confidence}`;
    const current = edges.get(key);
    if (current) {
      current.sourceEdgeIds.push(...edge.sourceEdgeIds);
      current.labels.push(...edge.labels);
      current.originalEndpoints.push(...edge.originalEndpoints);
      current.evidence = uniqueEvidence([...current.evidence, ...edge.evidence]);
      continue;
    }
    edges.set(key, { ...edge, source, target, sourceEdgeIds: [...edge.sourceEdgeIds], labels: [...edge.labels], originalEndpoints: [...edge.originalEndpoints], evidence: uniqueEvidence(edge.evidence) });
  }
  const outputEdges = [...edges.values()].map(edge => ({
    ...edge,
    id: `presentation:${edge.source}:${edge.target}:${edge.confidence}`,
    labels: [...new Set(edge.labels)].sort((a, b) => a.localeCompare(b)),
    sourceEdgeIds: [...new Set(edge.sourceEdgeIds)].sort((a, b) => a.localeCompare(b)),
    originalEndpoints: [...new Map(edge.originalEndpoints.map(pair => [`${pair.source}\0${pair.target}`, pair])).values()].sort((a, b) => a.source.localeCompare(b.source) || a.target.localeCompare(b.target)),
    evidence: uniqueEvidence(edge.evidence),
  })).sort((a, b) => a.source.localeCompare(b.source) || a.target.localeCompare(b.target) || a.id.localeCompare(b.id));
  const outputNodes = [...nodesById.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.label.localeCompare(b.label) || a.id.localeCompare(b.id));

  return {
    ...projection,
    nodes: outputNodes,
    edges: outputEdges,
    representedNodeIds: [...new Set(projection.representedNodeIds)].sort((a, b) => a.localeCompare(b)),
    representedEdgeIds: [...new Set(projection.representedEdgeIds)].sort((a, b) => a.localeCompare(b)),
  };
}
