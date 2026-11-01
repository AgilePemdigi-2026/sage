"use client";

import type { CSSProperties, FormEvent, ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PresentationOverlay, SemanticEdge, SemanticFeature, SemanticModel, SemanticNode, SemanticPayload } from "@sage/documents/semantic/model";
import { EvidenceLink } from "../live-document/evidence-links.tsx";
import styles from "./semantic-workspace.module.css";
import { ArchitectureOverview } from "./architecture-overview.tsx";

type Mode = "flow" | "graph";
type Props = { analysisId: string; accountKey: string; repository: string; commitSha: string; mode: Mode; legacyFallback?: ReactNode; onLegacyFallback?: () => void; onRevision?: (detail: { revision: number; modelHash: string }) => void };
type State = { status: "loading" } | { status: "ready"; payload: SemanticPayload } | { status: "legacy"; message: string } | { status: "error"; message: string };
type SessionIdentity = { accountKey?: string };
type FlowEntryOption = { node: SemanticNode; actorNodes: SemanticNode[]; actorConfidence: SemanticEdge["confidence"] | null; isDeclaredEntry: boolean };
const ALL_FEATURE_FACTS = "__all_feature_facts__";
const EMPTY_FEATURES: SemanticFeature[] = [];

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function safeString(value: unknown, max = 1000): value is string { return typeof value === "string" && value.length <= max; }
function isEvidence(value: unknown): value is SemanticNode["evidence"][number] {
  return isRecord(value) && safeString(value.filePath, 2000) && value.filePath.length > 0 &&
    Number.isSafeInteger(value.startLine) && Number(value.startLine) > 0 && Number.isSafeInteger(value.endLine) && Number(value.endLine) >= Number(value.startLine) &&
    ["declaration", "reference", "context"].includes(String(value.role));
}
function validOverlay(value: unknown, model: SemanticModel): value is PresentationOverlay {
  if (!isRecord(value) || !isRecord(value.labels) || !isRecord(value.groups)) return false;
  const ids = new Set(model.nodes.map(node => node.id));
  const featureIds = new Set(model.features.map(feature => feature.id));
  return Object.entries(value.labels).every(([id, label]) => ids.has(id) && safeString(label, 160) && label.trim().length > 0) &&
    Object.entries(value.groups).every(([id, featureId]) => ids.has(id) && safeString(featureId, 256) && featureIds.has(featureId));
}
function parsePayload(value: unknown, analysisId: string, accountKey: string): SemanticPayload {
  if (!isRecord(value) || value.analysisId !== analysisId || value.accountKey !== accountKey ||
      !Number.isSafeInteger(value.revision) || Number(value.revision) < 0 || typeof value.modelHash !== "string" || !/^[a-f0-9]{64}$/u.test(value.modelHash) ||
      !isRecord(value.model) || value.model.schemaVersion !== "sage-semantic-v1" || !safeString(value.model.sourceCkgHash, 64) || !/^[a-f0-9]{64}$/u.test(String(value.model.sourceCkgHash)) ||
      !isRecord(value.model.snapshot) || !safeString(value.model.snapshot.repository, 300) || !safeString(value.model.snapshot.commitSha, 100) ||
      !(value.model.snapshot.branch === null || safeString(value.model.snapshot.branch, 300)) ||
      !Array.isArray(value.model.nodes) || value.model.nodes.length > 30_000 || !Array.isArray(value.model.edges) || value.model.edges.length > 100_000 ||
      !Array.isArray(value.model.features) || value.model.features.length > 10_000 || !Array.isArray(value.model.frameworks) || value.model.frameworks.length > 500 ||
      !Array.isArray(value.model.limitations) || value.model.limitations.length > 30_000) throw new Error("Model semantik tidak sesuai dengan analisis aktif.");
  const model = value.model as unknown as SemanticModel;
  const nodeIds = new Set<string>();
  for (const node of model.nodes) {
    if (!isRecord(node) || !safeString(node.id, 256) || nodeIds.has(node.id) || !safeString(node.label, 1000) ||
        !["actor", "feature", "concept", "component", "store", "step", "decision", "outcome"].includes(String(node.kind)) ||
        !(node.featureId === null || safeString(node.featureId, 256)) || !["proven", "indicated"].includes(String(node.confidence)) || !safeString(node.reason, 1000) ||
        !Array.isArray(node.evidence) || node.evidence.length > 2_000 || node.evidence.some(item => !isEvidence(item)) ||
        !Array.isArray(node.technicalNodeIds) || node.technicalNodeIds.length > 30_000 || node.technicalNodeIds.some(id => !safeString(id, 256))) throw new Error("Model node tidak valid.");
    nodeIds.add(node.id);
  }
  const featureIds = new Set<string>();
  for (const feature of model.features) {
    if (!isRecord(feature) || !safeString(feature.id, 256) || featureIds.has(feature.id) || !safeString(feature.label, 1000) ||
        !Array.isArray(feature.nodeIds) || feature.nodeIds.length > 30_000 || feature.nodeIds.some(id => !safeString(id, 256) || !nodeIds.has(id)) ||
        !Array.isArray(feature.edgeIds) || feature.edgeIds.length > 100_000 || feature.edgeIds.some(id => !safeString(id, 256)) ||
        !Array.isArray(feature.entryNodeIds) || feature.entryNodeIds.length > 30_000 || feature.entryNodeIds.some(id => !safeString(id, 256) || !nodeIds.has(id)) ||
        !Array.isArray(feature.evidence) || feature.evidence.length > 2_000 || feature.evidence.some(item => !isEvidence(item))) throw new Error("Model fitur tidak valid.");
    featureIds.add(feature.id);
  }
  for (const node of model.nodes) if (node.featureId !== null && !featureIds.has(node.featureId)) throw new Error("Kelompok fitur pada node tidak valid.");
  const edgeIds = new Set<string>();
  for (const edge of model.edges) {
    if (!isRecord(edge) || !safeString(edge.id, 256) || edgeIds.has(edge.id) || !safeString(edge.source, 256) || !nodeIds.has(edge.source) || !safeString(edge.target, 256) || !nodeIds.has(edge.target) ||
        !safeString(edge.label, 240) || !["proven", "indicated"].includes(String(edge.confidence)) || !safeString(edge.reason, 1000) || !Array.isArray(edge.evidence) || edge.evidence.length > 2_000 || edge.evidence.some(item => !isEvidence(item))) throw new Error("Model relasi tidak valid.");
    edgeIds.add(edge.id);
  }
  for (const feature of model.features) if (feature.edgeIds.some(id => !edgeIds.has(id))) throw new Error("Daftar relasi fitur tidak valid.");
  if (model.frameworks.some(item => !safeString(item, 100)) || model.limitations.some(item => !isRecord(item) || !safeString(item.filePath, 2000) || !safeString(item.reason, 1000))) throw new Error("Metadata model tidak valid.");
  if (!validOverlay(value.overlay, model)) throw new Error("Koreksi tampilan tidak valid.");
  return value as unknown as SemanticPayload;
}
function statusMessage(value: unknown): string | null {
  if (!isRecord(value) || !isRecord(value.error) || !safeString(value.error.message, 500)) return null;
  return value.error.message;
}
function isAbort(error: unknown): boolean { return error instanceof DOMException && error.name === "AbortError"; }
function analysisIdSafe(value: string): string { return value.replace(/[^a-z0-9]/giu, "") || "graph"; }
function labelFor(node: SemanticNode, payload: SemanticPayload): string { return payload.overlay.labels[node.id] ?? node.label; }
function groupFor(node: SemanticNode, payload: SemanticPayload): string | null { return payload.overlay.groups[node.id] ?? node.featureId; }

function flowEntryOptions(feature: SemanticFeature, nodes: SemanticNode[], edges: SemanticEdge[]): FlowEntryOption[] {
  const nodeById = new Map(nodes.map(node => [node.id, node]));
  const entries = new Map<string, FlowEntryOption>();
  for (const edge of edges) {
    const actor = nodeById.get(edge.source);
    const action = nodeById.get(edge.target);
    if (actor?.kind !== "actor" || action?.kind !== "step") continue;
    const existing = entries.get(action.id) ?? { node: action, actorNodes: [], actorConfidence: null, isDeclaredEntry: feature.entryNodeIds.includes(action.id) };
    if (!existing.actorNodes.some(item => item.id === actor.id)) existing.actorNodes.push(actor);
    if (edge.confidence === "proven" || existing.actorConfidence === null) existing.actorConfidence = edge.confidence;
    entries.set(action.id, existing);
  }
  for (const id of feature.entryNodeIds) {
    const node = nodeById.get(id);
    if (!node || (node.kind !== "step" && node.kind !== "feature")) continue;
    const existing = entries.get(id) ?? { node, actorNodes: [], actorConfidence: null, isDeclaredEntry: true };
    existing.isDeclaredEntry = true;
    entries.set(id, existing);
  }
  const genericAction = /^(?:user action|user activity|action|tindakan pengguna|aksi pengguna|kirim formulir|submit(?: form)?|cancel|batal|continue|lanjutkan)$/iu;
  const endpoint = /^(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+\//iu;
  const pathScore = (entry: FlowEntryOption) => flowScope(entry.node.id, nodes, edges).nodes.reduce((score, node) => score + ({ actor: 0, feature: 0, step: 1, decision: 3, component: 3, outcome: 3, store: 2, concept: 1 }[node.kind]), 0);
  const scores = new Map([...entries.values()].map(entry => [entry.node.id, Math.min(20, pathScore(entry))]));
  return [...entries.values()].sort((left, right) => {
    const rank = (entry: FlowEntryOption) => [
      genericAction.test(entry.node.label) ? 1 : 0,
      entry.actorNodes.length ? 0 : 1,
      entry.actorConfidence === "proven" ? 0 : 1,
      entry.node.confidence === "proven" ? 0 : 1,
      entry.isDeclaredEntry ? 0 : 1,
      endpoint.test(entry.node.label) ? 1 : 0,
      -(scores.get(entry.node.id) ?? 0),
    ];
    const a = rank(left), b = rank(right);
    for (let index = 0; index < a.length; index += 1) if (a[index] !== b[index]) return a[index]! - b[index]!;
    return left.node.label.localeCompare(right.node.label);
  });
}

function flowScope(entryId: string, nodes: SemanticNode[], edges: SemanticEdge[]): { nodes: SemanticNode[]; edges: SemanticEdge[] } {
  if (entryId === ALL_FEATURE_FACTS) return { nodes, edges };
  const nodeById = new Map(nodes.map(node => [node.id, node]));
  if (!nodeById.has(entryId)) return { nodes: [], edges: [] };
  const includedIds = new Set([entryId]);
  const queue = [entryId];
  // Keep actor-to-entry evidence visible, but do not traverse from an actor into unrelated actions.
  for (const edge of edges) {
    const source = nodeById.get(edge.source);
    if (edge.target === entryId && source?.kind === "actor") includedIds.add(source.id);
  }
  const outgoing = new Map<string, SemanticEdge[]>();
  for (const edge of edges) {
    const bucket = outgoing.get(edge.source) ?? [];
    bucket.push(edge);
    outgoing.set(edge.source, bucket);
  }
  for (let index = 0; index < queue.length; index += 1) {
    const sourceId = queue[index]!;
    for (const edge of outgoing.get(sourceId) ?? []) {
      if (includedIds.has(edge.target)) continue;
      includedIds.add(edge.target);
      const target = nodeById.get(edge.target);
      if (target?.kind !== "actor") queue.push(edge.target);
    }
  }
  const scopeNodes = nodes.filter(node => includedIds.has(node.id));
  const scopeEdges = edges.filter(edge => includedIds.has(edge.source) && includedIds.has(edge.target));
  return { nodes: scopeNodes, edges: scopeEdges };
}

function centerFlowViewport(canvas: HTMLDivElement, anchorId: string, positions: Map<string, { x: number; y: number }>, layoutWidth: number, zoom: number) {
  const anchor = positions.get(anchorId);
  if (!anchor) {
    canvas.scrollTo({ top: 0, left: 0, behavior: "auto" });
    return;
  }
  const contentWidth = layoutWidth * zoom / 100;
  const maxScrollLeft = Math.max(0, contentWidth - canvas.clientWidth);
  const left = Math.max(0, Math.min(maxScrollLeft, anchor.x * zoom / 100 - canvas.clientWidth / 2));
  canvas.scrollTo({ top: 0, left, behavior: "auto" });
}

function focusGraphViewport(viewport: HTMLDivElement, featureId: string, positions: Map<string, { x: number; y: number }>, bounds: Map<string, { width: number; height: number }>, canvasWidth: number, canvasHeight: number, zoom: number) {
  const center = positions.get(featureId);
  const size = bounds.get(featureId);
  if (!center || !size) {
    viewport.scrollTo({ top: 0, left: 0, behavior: "auto" });
    return;
  }
  const scale = zoom / 100;
  const frameWidth = size.width * scale;
  const frameLeft = (center.x - size.width / 2) * scale;
  const desiredLeft = frameWidth > viewport.clientWidth ? frameLeft : center.x * scale - viewport.clientWidth / 2;
  const frameTop = center.y - size.height / 2;
  const maxLeft = Math.max(0, canvasWidth * scale - viewport.clientWidth);
  const maxTop = Math.max(0, canvasHeight * scale - viewport.clientHeight);
  const left = Math.max(0, Math.min(maxLeft, desiredLeft));
  const top = Math.max(0, Math.min(maxTop, frameTop * scale - 16));
  viewport.scrollTo({ top, left, behavior: "auto" });
}

function splitLabel(value: string, max = 22, maxLines = 3): string[] {
  const words = value.trim().split(/\s+/u).flatMap(word => {
    const chars = Array.from(word);
    return chars.length <= max ? [word] : Array.from({ length: Math.ceil(chars.length / max) }, (_, index) => chars.slice(index * max, (index + 1) * max).join(""));
  });
  const lines: string[] = [];
  let line = "";
  let overflow = false;
  for (const word of words) {
    if (line && `${line} ${word}`.length > max) { lines.push(line); line = word; }
    else line = line ? `${line} ${word}` : word;
    if (lines.length === maxLines) { overflow = true; break; }
  }
  if (line && lines.length < maxLines) lines.push(line);
  if (overflow) {
    const lastIndex = maxLines - 1;
    const last = Array.from(lines[lastIndex] ?? "");
    lines[lastIndex] = `${last.slice(0, Math.max(1, max - 1)).join("")}…`;
  }
  return lines.slice(0, maxLines);
}

function flowLayout(nodes: SemanticNode[], edges: SemanticEdge[]) {
  // Condense cycles into strongly connected components first. This preserves
  // their actual edges while preventing a cycle from being pushed to a fake
  // "last" layer in the diagram.
  const ids = nodes.map(node => node.id).sort();
  const byId = new Map(nodes.map(node => [node.id, node]));
  const outgoing = new Map(ids.map(id => [id, [] as string[]]));
  const incoming = new Map(ids.map(id => [id, [] as string[]]));
  for (const edge of edges) {
    if (!byId.has(edge.source) || !byId.has(edge.target)) continue;
    outgoing.get(edge.source)!.push(edge.target);
    incoming.get(edge.target)!.push(edge.source);
  }
  for (const rows of [outgoing, incoming]) for (const [id, neighbors] of rows) rows.set(id, [...new Set(neighbors)].sort());

  const visited = new Set<string>();
  const finishOrder: string[] = [];
  for (const root of ids) {
    if (visited.has(root)) continue;
    visited.add(root);
    const stack: Array<{ id: string; next: number }> = [{ id: root, next: 0 }];
    while (stack.length) {
      const frame = stack[stack.length - 1]!;
      const neighbors = outgoing.get(frame.id)!;
      if (frame.next < neighbors.length) {
        const next = neighbors[frame.next++]!;
        if (!visited.has(next)) { visited.add(next); stack.push({ id: next, next: 0 }); }
      } else {
        finishOrder.push(frame.id);
        stack.pop();
      }
    }
  }

  const componentOf = new Map<string, number>();
  const components: string[][] = [];
  for (let index = finishOrder.length - 1; index >= 0; index -= 1) {
    const root = finishOrder[index]!;
    if (componentOf.has(root)) continue;
    const componentIndex = components.length;
    const members: string[] = [];
    const stack = [root]; componentOf.set(root, componentIndex);
    while (stack.length) {
      const id = stack.pop()!; members.push(id);
      for (const next of [...incoming.get(id)!].reverse()) if (!componentOf.has(next)) { componentOf.set(next, componentIndex); stack.push(next); }
    }
    components.push(members.sort());
  }
  const componentEdges = components.map(() => new Set<number>());
  const componentIndegree = components.map(() => 0);
  for (const [source, targets] of outgoing) for (const target of targets) {
    const from = componentOf.get(source)!, to = componentOf.get(target)!;
    if (from !== to && !componentEdges[from]!.has(to)) { componentEdges[from]!.add(to); componentIndegree[to]! += 1; }
  }
  const componentRank = components.map(() => 0);
  const ready = components.map((_, index) => index).filter(index => componentIndegree[index] === 0).sort((a, b) => components[a]![0]!.localeCompare(components[b]![0]!));
  for (let head = 0; head < ready.length; head += 1) {
    const current = ready[head]!;
    for (const target of [...componentEdges[current]!].sort((a, b) => components[a]![0]!.localeCompare(components[b]![0]!))) {
      componentRank[target] = Math.max(componentRank[target]!, componentRank[current]! + 1);
      componentIndegree[target]! -= 1;
      if (componentIndegree[target] === 0) ready.push(target);
    }
  }
  const groups = new Map<number, SemanticNode[]>();
  for (const [componentIndex, members] of components.entries()) {
    const rank = componentRank[componentIndex]!;
    const bucket = groups.get(rank) ?? [];
    for (const id of members) bucket.push(byId.get(id)!);
    groups.set(rank, bucket);
  }
  const sortedLayers = [...groups].sort(([a], [b]) => a - b);
  const positions = new Map<string, { x: number; y: number }>();
  const columns = Math.min(4, Math.max(1, ...sortedLayers.map(([, items]) => items.length)));
  const width = columns * 246 + 10;
  let yOffset = 190;
  for (const [, layerNodes] of sortedLayers) {
    const items = [...layerNodes].sort((left, right) => {
      const predecessorX = (node: SemanticNode) => {
        const values = (incoming.get(node.id) ?? []).map(id => positions.get(id)?.x).filter((value): value is number => value !== undefined);
        return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : Number.POSITIVE_INFINITY;
      };
      return predecessorX(left) - predecessorX(right) || left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id);
    });
    for (let index = 0; index < items.length; index += 1) {
      const row = Math.floor(index / columns);
      const column = index % columns;
      const rowCount = Math.min(columns, items.length - row * columns);
      const startX = (width - (rowCount - 1) * 246) / 2;
      positions.set(items[index]!.id, { x: startX + column * 246, y: yOffset + row * 132 });
    }
    yOffset += Math.max(1, Math.ceil(items.length / columns)) * 132 + 94;
  }
  return { positions, width, height: Math.max(260, yOffset + 24) };
}

function flowEdgeGeometry(source: SemanticNode, target: SemanticNode, from: { x: number; y: number }, to: { x: number; y: number }, routeIndex: number) {
  const sourceHeight = source.kind === "decision" ? 54 : 42;
  const targetHeight = target.kind === "decision" ? 54 : 42;
  const sourceWidth = source.kind === "decision" ? 78 : 100;
  const targetWidth = target.kind === "decision" ? 78 : 100;
  if (to.y > from.y + 8) {
    const startY = from.y + sourceHeight;
    const endY = to.y - targetHeight;
    const span = endY - startY;
    if (span > 330) {
      const gutterX = 8 + (routeIndex % 4) * 5;
      const bend = Math.min(34, Math.max(16, span * 0.12));
      return { path: `M ${from.x} ${startY} C ${from.x} ${startY + bend}, ${gutterX} ${startY + bend}, ${gutterX} ${startY + bend * 2} L ${gutterX} ${endY - bend * 2} C ${gutterX} ${endY - bend}, ${to.x} ${endY - bend}, ${to.x} ${endY}`, labelX: from.x, labelY: startY + 24 + (routeIndex % 4) * 14, sourcePortOffset: sourceHeight, targetPortOffset: targetHeight };
    }
    const bend = Math.min(90, Math.max(22, span * 0.45));
    return { path: `M ${from.x} ${startY} C ${from.x} ${startY + bend}, ${to.x} ${endY - bend}, ${to.x} ${endY}`, labelX: (from.x + to.x) / 2, labelY: (startY + endY) / 2 - 6, sourcePortOffset: sourceHeight, targetPortOffset: targetHeight };
  }
  if (to.y < from.y - 8) {
    const startY = from.y - sourceHeight;
    const endY = to.y + targetHeight;
    const laneY = Math.min(startY, endY) - 78 - (routeIndex % 4) * 12;
    return { path: `M ${from.x} ${startY} C ${from.x} ${laneY}, ${to.x} ${laneY}, ${to.x} ${endY}`, labelX: (from.x + to.x) / 2, labelY: laneY - 6, sourcePortOffset: sourceHeight, targetPortOffset: targetHeight };
  }
  const direction = to.x >= from.x ? 1 : -1;
  const startX = from.x + sourceWidth * direction;
  const endX = to.x - targetWidth * direction;
  const laneY = Math.min(from.y, to.y) - 78 - (routeIndex % 4) * 12;
  return { path: `M ${startX} ${from.y} C ${startX} ${laneY}, ${endX} ${laneY}, ${endX} ${to.y}`, labelX: (startX + endX) / 2, labelY: laneY - 6, sourcePortOffset: sourceWidth, targetPortOffset: targetWidth };
}

function FlowEdge({ edge, source, target, from, to, inlineLabel, markerId, labelForNode, routeIndex }: {
  edge: SemanticEdge; source: SemanticNode; target: SemanticNode;
  from: { x: number; y: number }; to: { x: number; y: number };
  inlineLabel: boolean; markerId: string; labelForNode: (node: SemanticNode) => string; routeIndex: number;
}) {
  const geometry = flowEdgeGeometry(source, target, from, to, routeIndex);
  const confidence = edge.confidence === "proven" ? "Proven" : "Indicated";
  const description = `${labelForNode(source)} — ${edge.label} → ${labelForNode(target)} · ${confidence} · ${edge.reason}`;
  return <g data-edge-id={edge.id} data-source-id={edge.source} data-target-id={edge.target} data-source-kind={source.kind} data-target-kind={target.kind} data-source-port-offset={geometry.sourcePortOffset} data-target-port-offset={geometry.targetPortOffset} data-inline-label={inlineLabel} role="img" aria-label={description} className={`${styles.flowEdge} ${edge.confidence === "indicated" ? styles.indicatedEdge : ""}`}>
    <title>{description}</title>
    <path d={geometry.path} markerEnd={`url(#${markerId})`} />
    {inlineLabel ? <text x={geometry.labelX} y={geometry.labelY}>{edge.label}</text> : null}
  </g>;
}

function EvidenceList({ items, repository, commitSha }: { items: Array<{ filePath: string; startLine: number; endLine: number; role?: string }>; repository: string; commitSha: string }) {
  const unique = [...new Map(items.map(item => [`${item.filePath}:${item.startLine}:${item.endLine}:${item.role ?? ""}`, item])).values()];
  if (!unique.length) return <span className={styles.muted}>Lokasi bukti belum tersedia.</span>;
  return <ul className={styles.evidenceList}>{unique.map((evidence, index) => <li key={`${evidence.filePath}:${evidence.startLine}:${index}`}><EvidenceLink repository={repository} commitSha={commitSha} evidence={evidence} role={evidence.role} /></li>)}</ul>;
}

function FlowStepEvidence({ nodes, repository, commitSha, labelForNode, selectedNodeId, selectNode }: {
  nodes: SemanticNode[]; repository: string; commitSha: string; labelForNode: (node: SemanticNode) => string;
  selectedNodeId: string | null; selectNode: (id: string) => void;
}) {
  const [page, setPage] = useState(0);
  const pageSize = 6;
  const pageCount = Math.max(1, Math.ceil(nodes.length / pageSize));
  const currentPage = Math.min(page, pageCount - 1);
  const visibleNodes = nodes.slice(currentPage * pageSize, currentPage * pageSize + pageSize);
  return <details className={styles.relationshipDisclosure}>
    <summary>Flow nodes and evidence ({nodes.length})</summary>
    <div className={styles.flowStepList} aria-label="Flow nodes and evidence">{visibleNodes.map(node => <article key={node.id}>
      <button type="button" aria-pressed={selectedNodeId === node.id} onClick={() => selectNode(node.id)}>
        <span className={styles.stepNumber}>{node.kind === "decision" ? "◇" : node.kind === "outcome" ? "✓" : "•"}</span>
        <span><strong>{labelForNode(node)}</strong><small>{node.kind} · {node.confidence === "proven" ? "Proven" : `Indicated: ${node.reason}`}</small></span>
      </button>
      <EvidenceList items={node.evidence} repository={repository} commitSha={commitSha} />
    </article>)}</div>
    {pageCount > 1 ? <div className={styles.relationshipPages} role="group" aria-label="Flow step navigation">
      <button type="button" disabled={currentPage === 0} onClick={() => setPage(value => Math.max(0, value - 1))}>Previous</button>
      <span>{currentPage * pageSize + 1}–{Math.min(nodes.length, (currentPage + 1) * pageSize)} of {nodes.length} items</span>
      <button type="button" disabled={currentPage + 1 >= pageCount} onClick={() => setPage(value => Math.min(pageCount - 1, value + 1))}>Next</button>
    </div> : null}
  </details>;
}

function RelationshipEvidence({ edges, nodes, repository, commitSha, labelForNode }: { edges: SemanticEdge[]; nodes: SemanticNode[]; repository: string; commitSha: string; labelForNode: (node: SemanticNode) => string }) {
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState(0);
  const pageSize = 10;
  const pageCount = Math.max(1, Math.ceil(edges.length / pageSize));
  const currentPage = Math.min(page, pageCount - 1);
  const nodeById = new Map(nodes.map(node => [node.id, node]));
  const visibleEdges = edges.slice(currentPage * pageSize, currentPage * pageSize + pageSize);
  return <details className={styles.relationshipDisclosure} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>Relationship evidence ({edges.length})</summary>
    {open ? <>
      <div className={styles.relationshipList}>{visibleEdges.map(edge => <article key={edge.id}>
        <p><strong>{nodeById.get(edge.source) ? labelForNode(nodeById.get(edge.source)!) : "Sumber"}</strong><span aria-hidden="true"> → </span><strong>{nodeById.get(edge.target) ? labelForNode(nodeById.get(edge.target)!) : "Target"}</strong></p>
        <p><code>{edge.label}</code> · {edge.confidence === "proven" ? "Proven" : "Indicated"} · {edge.reason}</p>
        <EvidenceList items={edge.evidence} repository={repository} commitSha={commitSha} />
      </article>)}</div>
      {pageCount > 1 ? <div className={styles.relationshipPages}><button type="button" disabled={currentPage === 0} onClick={() => setPage(value => Math.max(0, value - 1))}>Previous</button><span>Page {currentPage + 1} of {pageCount}</span><button type="button" disabled={currentPage + 1 >= pageCount} onClick={() => setPage(value => Math.min(pageCount - 1, value + 1))}>Next</button></div> : null}
    </> : null}
  </details>;
}

function AnalysisLimitations({ items }: { items: SemanticModel["limitations"] }) {
  const [page, setPage] = useState(0);
  const pageSize = 20;
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
  const currentPage = Math.min(page, pageCount - 1);
  return <details className={styles.relationshipDisclosure}>
    <summary>Extraction limitations ({items.length})</summary>
    {items.length ? <>
      <ul className={styles.limitationList}>{items.slice(currentPage * pageSize, currentPage * pageSize + pageSize).map((item, index) => <li key={`${item.filePath}:${currentPage * pageSize + index}`}><code>{item.filePath}</code><span>{item.reason}</span></li>)}</ul>
      {pageCount > 1 ? <div className={styles.relationshipPages}><button type="button" disabled={currentPage === 0} onClick={() => setPage(value => Math.max(0, value - 1))}>Previous</button><span>Page {currentPage + 1} of {pageCount}</span><button type="button" disabled={currentPage + 1 >= pageCount} onClick={() => setPage(value => Math.min(pageCount - 1, value + 1))}>Next</button></div> : null}
    </> : <p className={styles.emptyLimitations}>Tidak ada batasan yang dicatat oleh extractor pada snapshot ini.</p>}
  </details>;
}

export function SemanticWorkspace({ analysisId, accountKey, repository, commitSha, mode, legacyFallback, onLegacyFallback, onRevision }: Props) {
  const [state, setState] = useState<State>({ status: "loading" });
  const [legacyOpen, setLegacyOpen] = useState(false);
  const [showIndications, setShowIndications] = useState(true);
  const [query, setQuery] = useState("");
  const [flowEntrySelection, setFlowEntrySelection] = useState<{ featureId: string; nodeId: string } | null>(null);
  const [expandedFeatures, setExpandedFeatures] = useState<string[]>([]);
  const [focusedFeatureId, setFocusedFeatureId] = useState<string | null>(null);
  const [graphZoom, setGraphZoom] = useState(100);
  const [flowZoom, setFlowZoom] = useState(100);
  const [selectedFeatureId, setSelectedFeatureId] = useState<string | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [editorValues, setEditorValues] = useState<{ key: string; label: string; group: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState("");
  const [saveError, setSaveError] = useState("");
  const controllerRef = useRef<AbortController | null>(null);
  const generationRef = useRef(0);
  const flowCanvasRef = useRef<HTMLDivElement>(null);

  const identityHeaders = useCallback(() => ({ "X-SAGE-Account": accountKey }), [accountKey]);
  const verifySession = useCallback(async (signal: AbortSignal) => {
    const response = await fetch("/api/auth/session", { headers: identityHeaders(), cache: "no-store", credentials: "same-origin", signal });
    if (response.status === 401) {
      generationRef.current += 1; controllerRef.current?.abort(); controllerRef.current = null;
      setState({ status: "error", message: "Sesi berakhir. Masuk lagi dengan GitHub." });
      window.location.replace("/login?error=session");
      throw new Error("Sesi berakhir. Masuk lagi dengan GitHub.");
    }
    if (!response.ok) throw new Error("Sesi belum dapat diperiksa. Coba lagi.");
    const body = await response.json() as { data?: SessionIdentity };
    if (body.data?.accountKey !== accountKey) {
      generationRef.current += 1; controllerRef.current?.abort(); controllerRef.current = null;
      setState({ status: "error", message: "Akun berubah. Muat ulang halaman." });
      window.location.replace(`${window.location.pathname}${window.location.search}`);
      throw new Error("Akun berubah. Muat ulang halaman.");
    }
  }, [accountKey, identityHeaders]);

  const publishRevision = useCallback((next: SemanticPayload) => {
    const detail = { analysisId, accountKey, revision: next.revision, modelHash: next.modelHash };
    onRevision?.({ revision: detail.revision, modelHash: detail.modelHash });
    window.dispatchEvent(new CustomEvent("sage:semantic-revision", { detail }));
  }, [accountKey, analysisId, onRevision]);

  const reload = useCallback(async (signal?: AbortSignal) => {
    const generation = ++generationRef.current;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const combinedSignal = signal ?? controller.signal;
    setState({ status: "loading" }); setSaveError(""); setSaveMessage(""); setLegacyOpen(false);
    setExpandedFeatures([]); setFocusedFeatureId(null); setGraphZoom(100); setFlowZoom(100); setSelectedFeatureId(null); setFlowEntrySelection(null); setSelectedNodeId(null); setShowIndications(true); setQuery("");
    try {
      await verifySession(combinedSignal);
      const response = await fetch(`/api/analyses/${encodeURIComponent(analysisId)}/semantic`, {
        headers: identityHeaders(), cache: "no-store", credentials: "same-origin", signal: combinedSignal,
      });
      if (generation !== generationRef.current) return;
      if (response.status === 409) { setState({ status: "legacy", message: "Model semantik belum tersedia untuk snapshot ini. Analisis ulang repository untuk membuat user flow." }); return; }
      if (response.status === 401) throw new Error("Sesi berakhir. Masuk lagi dengan GitHub.");
      if (response.status === 404) throw new Error("Analisis tidak ditemukan untuk akun aktif.");
      if (!response.ok) throw new Error(statusMessage(await response.json()) ?? "Diagram semantik belum dapat dimuat. Coba lagi.");
      const body = await response.json() as { data?: unknown };
      if (generation !== generationRef.current) return;
      const next = parsePayload(body.data, analysisId, accountKey);
      await verifySession(combinedSignal);
      if (generation !== generationRef.current) return;
      setState({ status: "ready", payload: next });
      publishRevision(next);
    } catch (error) {
      if (generation !== generationRef.current || isAbort(error)) return;
      setState({ status: "error", message: error instanceof Error ? error.message : "Diagram semantik belum dapat dimuat." });
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null;
    }
  }, [accountKey, analysisId, identityHeaders, publishRevision, verifySession]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => void reload(controller.signal), 0);
    return () => { window.clearTimeout(timer); generationRef.current += 1; controller.abort(); controllerRef.current?.abort(); controllerRef.current = null; };
  }, [reload]);

  const payload = state.status === "ready" ? state.payload : null;
  const features = payload?.model.features ?? EMPTY_FEATURES;
  const membersByFeature = useMemo(() => {
    const grouped = new Map<string, SemanticNode[]>();
    if (!payload) return grouped;
    const nodesById = new Map(payload.model.nodes.map(node => [node.id, node]));
    const append = (featureId: string, node: SemanticNode) => {
      const rows = grouped.get(featureId) ?? [];
      if (!rows.some(row => row.id === node.id)) rows.push(node);
      grouped.set(featureId, rows);
    };
    for (const feature of payload.model.features) {
      for (const id of feature.nodeIds) {
        const node = nodesById.get(id);
        if (!node) continue;
        const correctedGroup = payload.overlay.groups[node.id];
        if (correctedGroup ? correctedGroup === feature.id : !node.featureId || node.featureId === feature.id) append(feature.id, node);
      }
    }
    for (const node of payload.model.nodes) {
      const correctedGroup = payload.overlay.groups[node.id];
      const featureId = correctedGroup ?? node.featureId;
      if (featureId) append(featureId, node);
    }
    return grouped;
  }, [payload]);
  const visibleFeatures = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return features;
    return features.filter(feature => {
      const relatedNodes = membersByFeature.get(feature.id) ?? [];
      return [payload?.overlay.labels[feature.id] ?? feature.label, ...feature.evidence.map(item => item.filePath), ...relatedNodes.map(node => labelFor(node, payload!))].join(" ").toLocaleLowerCase().includes(needle);
    });
  }, [features, membersByFeature, payload, query]);
  const selectedFeature = features.find(feature => feature.id === selectedFeatureId) ?? null;
  const selectedNode = payload?.model.nodes.find(node => node.id === selectedNodeId) ?? null;
  const editorKey = payload && selectedNode ? `${analysisId}:${accountKey}:${selectedNode.id}:${payload.revision}` : null;
  const editedLabel = editorKey && editorValues?.key === editorKey ? editorValues.label : payload && selectedNode ? labelFor(selectedNode, payload) : "";
  const editedGroup = editorKey && editorValues?.key === editorKey ? editorValues.group : payload && selectedNode ? groupFor(selectedNode, payload) ?? "" : "";
  const setEditedLabel = (label: string) => { if (editorKey) setEditorValues({ key: editorKey, label, group: editedGroup }); };
  const setEditedGroup = (group: string) => { if (editorKey) setEditorValues({ key: editorKey, label: editedLabel, group }); };
  const featureLabel = (feature: SemanticFeature) => payload?.overlay.labels[feature.id] ?? feature.label;
  const nodeLabel = (node: SemanticNode) => payload ? labelFor(node, payload) : node.label;

  const evidenceRepository = payload?.model.snapshot.repository ?? repository;
  const evidenceCommitSha = payload?.model.snapshot.commitSha ?? commitSha;
  const overviewFeatureIds = useMemo(() => visibleFeatures.map(feature => feature.id), [visibleFeatures]);

  function toggleExpanded(featureId: string) {
    setExpandedFeatures(current => current.includes(featureId) ? current.filter(id => id !== featureId) : [...current, featureId]);
  }
  function updateSearch(value: string) { setQuery(value); setSelectedNodeId(null); }

  function renderedFeatureNodes(feature: SemanticFeature): SemanticNode[] {
    return (membersByFeature.get(feature.id) ?? []).filter(node => node.kind !== "step" && node.kind !== "decision" && node.kind !== "outcome" && node.kind !== "actor" && node.kind !== "feature" && (showIndications || node.confidence === "proven"));
  }

  const selectedFeatureNodeIds = new Set(selectedFeature?.nodeIds ?? []);
  const selectedFeatureEdgeIds = new Set(selectedFeature?.edgeIds ?? []);
  const selectedFlowNodes = selectedFeature && payload ? payload.model.nodes.filter(node => {
    const correctedGroup = payload.overlay.groups[node.id];
    return correctedGroup ? correctedGroup === selectedFeature.id : selectedFeatureNodeIds.has(node.id);
  }) : [];
  const selectedFlowNodeIds = new Set(selectedFlowNodes.map(node => node.id));
  // Include only real edges stored for this feature. No layout edges become semantic edges.
  const selectedFlowEdges = selectedFeature && payload ? payload.model.edges.filter(edge => selectedFeatureEdgeIds.has(edge.id) && selectedFlowNodeIds.has(edge.source) && selectedFlowNodeIds.has(edge.target) && (showIndications || edge.confidence === "proven")) : [];
  const availableFlowEntries = selectedFeature ? flowEntryOptions(selectedFeature, selectedFlowNodes, selectedFlowEdges) : [];
  const savedFlowEntryId = flowEntrySelection && flowEntrySelection.featureId === selectedFeature?.id ? flowEntrySelection.nodeId : null;
  const selectedFlowEntryId = savedFlowEntryId === ALL_FEATURE_FACTS || availableFlowEntries.some(entry => entry.node.id === savedFlowEntryId)
    ? savedFlowEntryId!
    : availableFlowEntries[0]?.node.id ?? ALL_FEATURE_FACTS;
  const selectedFlowEntry = availableFlowEntries.find(entry => entry.node.id === selectedFlowEntryId) ?? null;
  const flowScopeData = selectedFeature ? flowScope(selectedFlowEntryId, selectedFlowNodes, selectedFlowEdges) : { nodes: [], edges: [] };
  const scopedFlowNodes = flowScopeData.nodes;
  const scopedFlowEdges = flowScopeData.edges;
  const flowNeedle = query.trim().toLocaleLowerCase();
  const matchingRelationNodeIds = new Set(scopedFlowEdges.filter(edge => [edge.label, edge.reason, ...edge.evidence.map(item => item.filePath)].join(" ").toLocaleLowerCase().includes(flowNeedle)).flatMap(edge => [edge.source, edge.target]));
  const visibleFlowNodes = scopedFlowNodes.filter(node => (showIndications || node.confidence === "proven") &&
    (!flowNeedle || matchingRelationNodeIds.has(node.id) || [nodeLabel(node), node.reason, node.kind, ...node.evidence.map(item => item.filePath)].join(" ").toLocaleLowerCase().includes(flowNeedle)) &&
    (node.kind !== "actor" || scopedFlowEdges.some(edge => edge.source === node.id || edge.target === node.id)));
  const visibleFlowNodeIds = new Set(visibleFlowNodes.map(node => node.id));
  const visibleFlowEdges = scopedFlowEdges.filter(edge => visibleFlowNodeIds.has(edge.source) && visibleFlowNodeIds.has(edge.target) && (!flowNeedle || matchingRelationNodeIds.has(edge.source) || matchingRelationNodeIds.has(edge.target)));
  const flowKey = JSON.stringify([selectedFeatureId, selectedFlowEntryId, query, showIndications, payload?.revision]);
  // Keep each selected flow intact: paging nodes independently used to drop
  // every edge that crossed a page boundary and made the path unreadable.
  const pageFlowNodes = visibleFlowNodes;
  const pageFlowEdges = visibleFlowEdges;
  const pageNodeById = new Map(pageFlowNodes.map(node => [node.id, node]));
  const edgeDegrees = new Map<string, { incoming: number; outgoing: number }>();
  for (const edge of pageFlowEdges) {
    const sourceDegree = edgeDegrees.get(edge.source) ?? { incoming: 0, outgoing: 0 };
    const targetDegree = edgeDegrees.get(edge.target) ?? { incoming: 0, outgoing: 0 };
    sourceDegree.outgoing += 1; targetDegree.incoming += 1;
    edgeDegrees.set(edge.source, sourceDegree); edgeDegrees.set(edge.target, targetDegree);
  }
  const layout = flowLayout(pageFlowNodes, pageFlowEdges);
  const flowAnchorNodeId = selectedFlowEntry?.node.id ?? pageFlowNodes.find(node => node.kind === "actor")?.id ?? pageFlowNodes[0]?.id;
  useEffect(() => {
    if (!selectedFeature || !flowCanvasRef.current) return;
    const canvas = flowCanvasRef.current;
    let alignFrame = 0;
    let lastViewportWidth = Number.NaN;
    const fitWidth = () => {
      const viewportWidth = canvas.getBoundingClientRect().width;
      if (viewportWidth === lastViewportWidth) return;
      lastViewportWidth = viewportWidth;
      const minZoom = canvas.clientWidth < 640 ? 55 : 30;
      const nextZoom = Math.max(minZoom, Math.min(100, Math.floor((canvas.clientWidth - 32) / layout.width * 100)));
      setFlowZoom(current => current === nextZoom ? current : nextZoom);
      cancelAnimationFrame(alignFrame);
      if (flowAnchorNodeId) alignFrame = requestAnimationFrame(() => centerFlowViewport(canvas, flowAnchorNodeId, layout.positions, layout.width, nextZoom));
    };
    fitWidth();
    const observer = new ResizeObserver(fitWidth);
    observer.observe(canvas);
    return () => { observer.disconnect(); cancelAnimationFrame(alignFrame); };
  }, [flowAnchorNodeId, flowKey, layout.width, selectedFeature]);
  useEffect(() => {
    const canvas = flowCanvasRef.current;
    if (!selectedFeature || !canvas || !flowAnchorNodeId) return;
    const frame = requestAnimationFrame(() => centerFlowViewport(canvas, flowAnchorNodeId, layout.positions, layout.width, flowZoom));
    return () => cancelAnimationFrame(frame);
  }, [flowAnchorNodeId, flowKey, flowZoom, layout.width, selectedFeature]);

  async function saveOverlay(nextOverlay: PresentationOverlay) {
    if (!payload || saving) return;
    setSaving(true); setSaveError(""); setSaveMessage("");
    const controller = new AbortController();
    controllerRef.current?.abort();
    controllerRef.current = controller;
    try {
      await verifySession(controller.signal);
      const response = await fetch(`/api/analyses/${encodeURIComponent(analysisId)}/semantic/presentation`, {
        method: "PATCH", headers: { ...identityHeaders(), "Content-Type": "application/json" },
        credentials: "same-origin", cache: "no-store", signal: controller.signal,
        body: JSON.stringify({ expectedRevision: payload.revision, overlay: nextOverlay }),
      });
      if (response.status === 409) { setSaveError("Koreksi berubah di sesi lain. Muat ulang hasil sebelum menyimpan lagi."); return; }
      if (response.status === 401) { await verifySession(controller.signal); throw new Error("Koreksi tidak diizinkan untuk akun aktif."); }
      if (!response.ok) throw new Error(statusMessage(await response.json()) ?? "Koreksi belum dapat disimpan.");
      const body = await response.json() as { data?: unknown };
      const next = parsePayload(body.data, analysisId, accountKey);
      await verifySession(controller.signal);
      setState({ status: "ready", payload: next }); setSaveMessage(`Koreksi disimpan · revisi ${next.revision}`);
      publishRevision(next);
    } catch (error) {
      if (!isAbort(error)) setSaveError(error instanceof Error ? error.message : "Koreksi belum dapat disimpan.");
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null;
      setSaving(false);
    }
  }

  function submitCorrection(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!payload || !selectedNode) return;
    const label = editedLabel.trim();
    if (!label || label.length > 100) { setSaveError("Nama harus berisi 1–100 karakter."); return; }
    const labels = { ...payload.overlay.labels };
    if (label === selectedNode.label) delete labels[selectedNode.id]; else labels[selectedNode.id] = label;
    const groups = { ...payload.overlay.groups };
    if (editedGroup && editedGroup !== (selectedNode.featureId ?? "")) groups[selectedNode.id] = editedGroup;
    else delete groups[selectedNode.id];
    void saveOverlay({ labels, groups });
  }

  const fallbackSection = state.status === "legacy" || (state.status === "error" && legacyOpen);
  return <section className={styles.workspace} aria-label={mode === "flow" ? "Alur fitur berbasis source" : "Knowledge graph fitur dan konsep"}>
    <header className={styles.header}>
      <div><p className={styles.eyebrow}>{mode === "flow" ? "USER FLOW" : "KNOWLEDGE GRAPH"}</p><h2>{mode === "flow" ? "User flows" : "Repository concepts"}</h2><p>{mode === "flow" ? "Lihat alur aplikasi dan hubungan source sejak awal. Pilih bagian diagram untuk evidence atau detailed flow." : "Lihat aktor, endpoint/controller, dan data store yang terhubung. Detail konsep tersedia tanpa menyembunyikan diagram utama."}</p></div>
      <div className={styles.statusPills}>{payload ? <><span>{payload.model.snapshot.repository} @ <code>{payload.model.snapshot.commitSha.slice(0, 8)}</code></span>{payload.model.frameworks.length ? <span>{payload.model.frameworks.join(", ")}</span> : null}</> : null}<span>{mode === "flow" ? "Source evidence" : "Feature overview"}</span></div>
    </header>

    {state.status === "loading" ? <p className={styles.status} role="status">Memeriksa akun dan memuat model fitur…</p> : null}
    {state.status === "legacy" ? <div className={styles.legacyNotice} role="status"><strong>Model semantik perlu dibuat.</strong><p>{state.message} Analisis source lama tetap bisa dibaca pada tampilan teknis.</p><button type="button" onClick={() => { if (onLegacyFallback) { setLegacyOpen(true); onLegacyFallback(); } else setLegacyOpen(value => !value); }} aria-expanded={onLegacyFallback ? undefined : legacyOpen}>{onLegacyFallback ? "Buka graph teknis" : legacyOpen ? "Tutup diagram lama" : "Buka diagram lama"}</button></div> : null}
    {state.status === "error" ? <div className={styles.errorBox} role="alert"><p>{state.message}</p><button type="button" onClick={() => void reload()}>Coba lagi</button>{legacyFallback ? <button type="button" onClick={() => { setLegacyOpen(true); onLegacyFallback?.(); }}>Buka graph teknis</button> : null}</div> : null}

    {fallbackSection && legacyFallback ? <div className={styles.legacyFallback}>{legacyFallback}</div> : null}
    {payload ? <AnalysisLimitations items={payload.model.limitations} /> : null}
    {payload && (mode === "flow" || selectedFeature) ? <>
      <div className={styles.legend} aria-label="Flow diagram legend"><span data-kind="actor">Actor</span><span data-kind="step">Action</span><span data-kind="decision">Decision</span><span data-kind="component">Service/API</span><span data-kind="store">Data store</span><span data-kind="outcome">Outcome</span><span><i className={styles.dashedLegend} />Indicated relationship</span></div>
      {!selectedFeature ? <>
        <div className={styles.controls}><label>Search features<input type="search" value={query} onChange={event => updateSearch(event.currentTarget.value)} placeholder="Feature, concept, or source path" /></label><p aria-live="polite">{visibleFeatures.length} of {features.length} features detected.</p></div>
        <ArchitectureOverview payload={payload} featureIds={overviewFeatureIds} showIndications={showIndications} onShowIndications={setShowIndications} onOpenFeature={setSelectedFeatureId} onInspectNode={setSelectedNodeId} />
      </> : <>
        <div className={styles.controls}><label>Search steps or evidence<input type="search" value={query} onChange={event => updateSearch(event.currentTarget.value)} placeholder="Action, decision, source path…" /></label><p aria-live="polite">{visibleFlowNodes.length} of {scopedFlowNodes.length} nodes match.</p></div>
        <div className={styles.flowBreadcrumb}><button type="button" onClick={() => setSelectedFeatureId(null)}>All features</button><span aria-hidden="true">/</span><strong>{payload.overlay.labels[selectedFeature.id] ?? selectedFeature.label}</strong><label><input type="checkbox" checked={showIndications} onChange={event => setShowIndications(event.currentTarget.checked)} />Show indicated relationships</label></div>
        <div className={styles.flowEntryTools}>
          <label>Entry point<select aria-label="Start flow from" value={selectedFlowEntryId} onChange={event => { setFlowEntrySelection({ featureId: selectedFeature.id, nodeId: event.currentTarget.value }); setSelectedNodeId(null); }}>
            <option value={ALL_FEATURE_FACTS}>All feature facts ({selectedFlowNodes.length})</option>
            {availableFlowEntries.map(entry => <option key={entry.node.id} value={entry.node.id}>{nodeLabel(entry.node)} · {entry.actorNodes.length ? `action by ${entry.actorNodes.map(nodeLabel).join(", ")} (${entry.actorConfidence === "proven" ? "Proven" : "Indicated"})` : entry.isDeclaredEntry ? "declared entry point" : "detected action"}</option>)}
          </select></label>
          <p aria-live="polite">{selectedFlowEntry ? `Source path from ${nodeLabel(selectedFlowEntry.node)}${selectedFlowEntry.actorNodes.length ? `, triggered by ${selectedFlowEntry.actorNodes.map(nodeLabel).join(", ")}` : ""}.` : `Feature overview with ${selectedFlowNodes.length} source facts.`}</p>
        </div>
        <div className={styles.flowTools} role="group" aria-label="User flow diagram controls"><button type="button" onClick={() => setFlowZoom(value => Math.max(30, value - 10))} disabled={flowZoom <= 30} aria-label="Zoom out user flow">−</button><span aria-live="polite">Zoom {flowZoom}%</span><button type="button" onClick={() => setFlowZoom(value => Math.min(150, value + 10))} disabled={flowZoom >= 150} aria-label="Zoom in user flow">+</button><button type="button" onClick={() => { const canvas = flowCanvasRef.current; if (!canvas) return; const minZoom = canvas.clientWidth < 640 ? 55 : 30; const nextZoom = Math.max(minZoom, Math.min(100, Math.floor((canvas.clientWidth - 32) / layout.width * 100))); setFlowZoom(nextZoom); requestAnimationFrame(() => { if (flowAnchorNodeId) centerFlowViewport(canvas, flowAnchorNodeId, layout.positions, layout.width, nextZoom); else canvas.scrollTo({ top: 0, left: 0, behavior: "auto" }); }); }}>Fit diagram</button></div>
        <p className={styles.flowCoverage} aria-live="polite">Showing all {pageFlowNodes.length} nodes and {pageFlowEdges.length} source relationships in this flow. {selectedFlowEntry && selectedFlowNodes.length > scopedFlowNodes.length ? `${selectedFlowNodes.length - scopedFlowNodes.length} unrelated feature facts are outside this entry point; select “All feature facts” to inspect them. ` : ""}{!showIndications ? `${scopedFlowNodes.filter(node => node.confidence === "indicated").length} indicated nodes are hidden by the filter.` : ""}</p>
        <p className={styles.edgeLabelGuidance}>Arrows follow source relationships. Decision branches show their labels on the diagram; open Relationship evidence for all labels, rationale, and source lines.</p>
        <div ref={flowCanvasRef} className={styles.flowCanvas} data-testid="semantic-flow-canvas" role="region" aria-label={`${selectedFlowEntry ? "User flow" : "Feature overview"} ${featureLabel(selectedFeature)}`} tabIndex={0}>
          <svg width={layout.width * flowZoom / 100} height={layout.height * flowZoom / 100} viewBox={`0 0 ${layout.width} ${layout.height}`} role="group" aria-label={`${selectedFlowEntry ? "User flow diagram" : "Feature overview"} ${featureLabel(selectedFeature)}`}>
            <defs><marker id={`arrow-${analysisId.replace(/[^a-z0-9]/giu, "")}`} markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" /></marker></defs>
            {pageFlowEdges.map((edge, routeIndex) => {
              const source = pageNodeById.get(edge.source), target = pageNodeById.get(edge.target);
              const from = layout.positions.get(edge.source), to = layout.positions.get(edge.target);
              if (!source || !target || !from || !to) return null;
              const sourceDegree = edgeDegrees.get(edge.source), targetDegree = edgeDegrees.get(edge.target);
              const inlineLabel = edge.label.length > 0 && (source.kind === "decision" || (sourceDegree?.outgoing === 1 && targetDegree?.incoming === 1));
              return <FlowEdge key={edge.id} edge={edge} source={source} target={target} from={from} to={to} inlineLabel={inlineLabel} markerId={`arrow-${analysisId.replace(/[^a-z0-9]/giu, "")}`} labelForNode={nodeLabel} routeIndex={routeIndex} />;
            })}
            {pageFlowNodes.map(node => { const point = layout.positions.get(node.id); if (!point) return null; const lines = splitLabel(nodeLabel(node)); return <g key={node.id} data-node-id={node.id} className={`${styles.flowNode} ${styles[`kind_${node.kind}`]} ${node.confidence === "indicated" ? styles.indicatedNode : ""}`} role="button" tabIndex={0} aria-label={`${node.kind}: ${nodeLabel(node)}; ${node.confidence === "proven" ? "Proven" : "Indicated"}`} onClick={() => setSelectedNodeId(node.id)} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSelectedNodeId(node.id); } }}><title>{nodeLabel(node)}</title>{node.kind === "decision" ? <polygon points={`${point.x},${point.y - 54} ${point.x + 78},${point.y} ${point.x},${point.y + 54} ${point.x - 78},${point.y}`} /> : <rect x={point.x - 100} y={point.y - 42} width="200" height="84" rx="14" />}<text x={point.x} y={point.y - (lines.length - 1) * 8}>{lines.map((line, index) => <tspan key={index} x={point.x} dy={index ? 19 : 0}>{line}</tspan>)}</text><text className={styles.nodeKindLabel} x={point.x} y={point.y + 30}>{node.kind}</text></g>; })}
          </svg>
        </div>
        <FlowStepEvidence key={flowKey} nodes={pageFlowNodes} repository={evidenceRepository} commitSha={evidenceCommitSha} labelForNode={nodeLabel} selectedNodeId={selectedNodeId} selectNode={setSelectedNodeId} />
        <RelationshipEvidence edges={visibleFlowEdges} nodes={payload.model.nodes} repository={evidenceRepository} commitSha={evidenceCommitSha} labelForNode={nodeLabel} />
      </>}
      {selectedNode && payload ? <NodeCorrection key={`${accountKey}:${selectedNode.id}`} node={selectedNode} payload={payload} editedLabel={editedLabel} editedGroup={editedGroup} setEditedLabel={setEditedLabel} setEditedGroup={setEditedGroup} submit={submitCorrection} saving={saving} message={saveMessage} error={saveError} reload={() => void reload()} features={features} onReset={node => {
        const labels = { ...payload.overlay.labels }; delete labels[node.id]; const groups = { ...payload.overlay.groups }; delete groups[node.id]; void saveOverlay({ labels, groups });
      }} repository={evidenceRepository} commitSha={evidenceCommitSha} /> : null}
    </> : null}

    {payload && mode === "graph" && !selectedFeature ? <>
      <div className={styles.controls}><label>Search features<input type="search" value={query} onChange={event => updateSearch(event.currentTarget.value)} placeholder="Feature, concept, or source path" /></label><p aria-live="polite">{visibleFeatures.length} of {features.length} features detected.</p></div>
      <ArchitectureOverview payload={payload} featureIds={overviewFeatureIds} showIndications={showIndications} onShowIndications={setShowIndications} onOpenFeature={setSelectedFeatureId} onInspectNode={setSelectedNodeId} />
      <details className={styles.featureBrowser}><summary>Explore individual concepts and components</summary><ClusteredKnowledgeGraph payload={payload} expandedFeatures={expandedFeatures} toggleExpanded={toggleExpanded} selectedNodeId={selectedNodeId} selectNode={setSelectedNodeId} search={query} setSearch={updateSearch} features={visibleFeatures} featureLabel={featureLabel} nodeLabel={nodeLabel} nodesForFeature={renderedFeatureNodes} groupFor={groupFor} showIndications={showIndications} setShowIndications={setShowIndications} focusedFeatureId={focusedFeatureId} setFocusedFeatureId={setFocusedFeatureId} zoom={graphZoom} setZoom={setGraphZoom} reset={() => { setExpandedFeatures([]); setFocusedFeatureId(null); setGraphZoom(100); setSelectedNodeId(null); setShowIndications(true); setQuery(""); }} /></details></> : null}
    {selectedNode && payload && mode === "graph" && !selectedFeature ? <NodeCorrection key={`${accountKey}:${selectedNode.id}`} node={selectedNode} payload={payload} editedLabel={editedLabel} editedGroup={editedGroup} setEditedLabel={setEditedLabel} setEditedGroup={setEditedGroup} submit={submitCorrection} saving={saving} message={saveMessage} error={saveError} reload={() => void reload()} features={features} onReset={node => { const labels = { ...payload.overlay.labels }; delete labels[node.id]; const groups = { ...payload.overlay.groups }; delete groups[node.id]; void saveOverlay({ labels, groups }); }} repository={evidenceRepository} commitSha={evidenceCommitSha} /> : null}
  </section>;
}

function NodeCorrection({ node, payload, editedLabel, editedGroup, setEditedLabel, setEditedGroup, submit, saving, message, error, reload, features, onReset, repository, commitSha }: {
  node: SemanticNode; payload: SemanticPayload; editedLabel: string; editedGroup: string;
  setEditedLabel: (value: string) => void; setEditedGroup: (value: string) => void;
  submit: (event: FormEvent<HTMLFormElement>) => void; saving: boolean; message: string; error: string;
  reload: () => void;
  features: SemanticFeature[]; onReset: (node: SemanticNode) => void; repository: string; commitSha: string;
}) {
  const hasOverride = Object.hasOwn(payload.overlay.labels, node.id) || Object.hasOwn(payload.overlay.groups, node.id);
  return <aside className={styles.inspector} aria-labelledby="semantic-inspector-heading">
    <div><p className={styles.eyebrow}>EVIDENCE & CORRECTIONS</p><h3 id="semantic-inspector-heading">{nodeLabelForInspector(node, payload)}</h3><p>{node.kind} · {node.confidence === "proven" ? "Proven from source" : `Indicated · ${node.reason}`}</p></div>
    <EvidenceList items={node.evidence} repository={repository} commitSha={commitSha} />
    <form onSubmit={submit} className={styles.correctionForm}>
      <label>Display name<input value={editedLabel} maxLength={100} onChange={event => setEditedLabel(event.currentTarget.value)} /></label>
      {["concept", "component", "store"].includes(node.kind) ? <label>Feature group<select value={editedGroup} onChange={event => setEditedGroup(event.currentTarget.value)}><option value="">Automatic from model</option>{features.map(feature => <option key={feature.id} value={feature.id}>{payload.overlay.labels[feature.id] ?? feature.label}</option>)}</select></label> : null}
      <div><button type="submit" disabled={saving}>{saving ? "Saving…" : "Save changes"}</button><button type="button" disabled={saving || !hasOverride} onClick={() => onReset(node)}>Restore automatic</button></div>
    </form>
    {message ? <p className={styles.savedMessage} role="status">{message}</p> : null}{error ? <div className={styles.errorBox} role="alert"><p>{error}</p><button type="button" onClick={reload}>Reload model</button></div> : null}
  </aside>;
}
function nodeLabelForInspector(node: SemanticNode, payload: SemanticPayload) { return payload.overlay.labels[node.id] ?? node.label; }

const featurePalette = [
  { fill: "#ddf4ff", border: "#0969da", text: "#0550ae" },
  { fill: "#fbefff", border: "#8250df", text: "#6639ba" },
  { fill: "#dafbe1", border: "#1a7f37", text: "#116329" },
  { fill: "#fff8c5", border: "#bf8700", text: "#7d4e00" },
  { fill: "#ffebe9", border: "#cf222e", text: "#a40e26" },
  { fill: "#fff1e5", border: "#bc4c00", text: "#953800" },
  { fill: "#f0f1f3", border: "#59636e", text: "#424a53" },
];

function featureColors(id: string) {
  let hash = 2166136261;
  for (const character of id) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return featurePalette[(hash >>> 0) % featurePalette.length]!;
}

function colorStyle(id: string): CSSProperties {
  const colors = featureColors(id);
  return { "--feature-fill": colors.fill, "--feature-border": colors.border, "--feature-text": colors.text } as CSSProperties;
}

function packFeatureNetwork(features: SemanticFeature[], bounds: Map<string, { width: number; height: number }>, links: Map<string, Set<string>>) {
  const maxDimension = Math.max(0, ...features.map(feature => Math.max(bounds.get(feature.id)?.width ?? 280, bounds.get(feature.id)?.height ?? 112)));
  const cellSize = Math.max(200, maxDimension + 48);
  const cells = new Map<string, Array<{ id: string; x: number; y: number }>>();
  const placed = new Map<string, { x: number; y: number }>();
  const cellKey = (x: number, y: number) => `${Math.floor(x / cellSize)},${Math.floor(y / cellSize)}`;
  const insert = (item: { id: string; x: number; y: number }) => {
    const key = cellKey(item.x, item.y);
    const bucket = cells.get(key) ?? [];
    bucket.push(item);
    cells.set(key, bucket);
  };
  const collides = (x: number, y: number, id: string) => {
    const cellX = Math.floor(x / cellSize), cellY = Math.floor(y / cellSize);
    for (let dx = -2; dx <= 2; dx += 1) for (let dy = -2; dy <= 2; dy += 1) {
      for (const other of cells.get(`${cellX + dx},${cellY + dy}`) ?? []) {
        if (other.id === id) continue;
        const own = bounds.get(id) ?? { width: 280, height: 112 };
        const otherBounds = bounds.get(other.id) ?? { width: 280, height: 112 };
        if (Math.abs(x - other.x) < (own.width + otherBounds.width) / 2 + 36 && Math.abs(y - other.y) < (own.height + otherBounds.height) / 2 + 36) return true;
      }
    }
    return false;
  };
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  const stableAngle = (id: string) => {
    let hash = 2166136261;
    for (const character of id) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
    return ((hash >>> 0) / 0xffffffff) * Math.PI * 2;
  };
  const ordered = [...features].sort((left, right) =>
    Math.max(bounds.get(right.id)?.width ?? 280, bounds.get(right.id)?.height ?? 112) - Math.max(bounds.get(left.id)?.width ?? 280, bounds.get(left.id)?.height ?? 112) ||
    (links.get(right.id)?.size ?? 0) - (links.get(left.id)?.size ?? 0) ||
    left.id.localeCompare(right.id));
  for (const [index, feature] of ordered.entries()) {
    const ownBounds = bounds.get(feature.id) ?? { width: 280, height: 112 };
    const placedNeighbors = [...(links.get(feature.id) ?? [])].filter(id => placed.has(id)).map(id => ({ id, point: placed.get(id)! }));
    let origin: { x: number; y: number };
    if (placedNeighbors.length) {
      const centroid = placedNeighbors.reduce((sum, item) => ({ x: sum.x + item.point.x / placedNeighbors.length, y: sum.y + item.point.y / placedNeighbors.length }), { x: 0, y: 0 });
      const angle = Math.hypot(centroid.x, centroid.y) > 1 ? Math.atan2(centroid.y, centroid.x) : stableAngle(feature.id);
      const ownExtent = (Math.abs(Math.cos(angle)) * ownBounds.width + Math.abs(Math.sin(angle)) * ownBounds.height) / 2;
      const neighborExtent = placedNeighbors.reduce((sum, item) => { const neighbor = bounds.get(item.id) ?? { width: 280, height: 112 }; return sum + (Math.abs(Math.cos(angle)) * neighbor.width + Math.abs(Math.sin(angle)) * neighbor.height) / (2 * placedNeighbors.length); }, 0);
      origin = { x: centroid.x + Math.cos(angle) * (ownExtent + neighborExtent + 80), y: centroid.y + Math.sin(angle) * (ownExtent + neighborExtent + 80) };
    } else {
      const radialDistance = index === 0 ? 0 : cellSize * 0.62 * Math.sqrt(index);
      const angle = index * goldenAngle;
      origin = { x: Math.cos(angle) * radialDistance, y: Math.sin(angle) * radialDistance };
    }
    let point = origin;
    for (let attempt = 0; collides(point.x, point.y, feature.id); attempt += 1) {
      const ring = 0.6 + Math.floor(attempt / 8) * 0.55;
      const angle = stableAngle(feature.id) + attempt * goldenAngle;
      point = { x: origin.x + Math.cos(angle) * cellSize * ring, y: origin.y + Math.sin(angle) * cellSize * ring };
    }
    placed.set(feature.id, point);
    insert({ id: feature.id, ...point });
  }
  let minX = 0, maxX = 0, minY = 0, maxY = 0;
  for (const feature of features) {
    const point = placed.get(feature.id)!;
    const box = bounds.get(feature.id) ?? { width: 280, height: 112 };
    minX = Math.min(minX, point.x - box.width / 2); maxX = Math.max(maxX, point.x + box.width / 2);
    minY = Math.min(minY, point.y - box.height / 2); maxY = Math.max(maxY, point.y + box.height / 2);
  }
  const padding = 72;
  const offset = { x: padding - minX, y: padding - minY };
  const positions = new Map([...placed].map(([id, point]) => [id, { x: point.x + offset.x, y: point.y + offset.y }]));
  return { positions, offset, width: Math.max(320, maxX - minX + padding * 2), height: Math.max(300, maxY - minY + padding * 2) };
}

function clipRectEdge(from: { x: number; y: number }, to: { x: number; y: number }, source: { width: number; height: number }, target: { width: number; height: number }) {
  const dx = to.x - from.x, dy = to.y - from.y;
  const sourceScale = 1 / Math.max(Math.abs(dx) / (source.width / 2), Math.abs(dy) / (source.height / 2), 1);
  const targetScale = 1 / Math.max(Math.abs(dx) / (target.width / 2), Math.abs(dy) / (target.height / 2), 1);
  return {
    from: { x: from.x + dx * sourceScale, y: from.y + dy * sourceScale },
    to: { x: to.x - dx * targetScale, y: to.y - dy * targetScale },
  };
}

/** Child cards occupy two columns; reserve the middle gap for cross-row relations. */
function routeChildRelation(from: { x: number; y: number }, to: { x: number; y: number }, centerX: number, cardWidth: number, index: number) {
  if (from.x === to.x && from.y === to.y) {
    const port = from.x + cardWidth / 2;
    return { path: `M ${port} ${from.y - 12} H ${port + 18} V ${from.y + 12} H ${port}`, labelX: port + 18, labelY: from.y - 20 };
  }
  if (Math.abs(from.y - to.y) < 1) {
    const direction = Math.sign(to.x - from.x);
    const start = from.x + direction * cardWidth / 2;
    const end = to.x - direction * cardWidth / 2;
    return { path: `M ${start} ${from.y} H ${end}`, labelX: (start + end) / 2, labelY: from.y - 10 };
  }
  const start = from.x + (from.x <= centerX ? 1 : -1) * cardWidth / 2;
  const end = to.x + (to.x <= centerX ? 1 : -1) * cardWidth / 2;
  const lane = centerX + (index % 5 - 2) * 5;
  return { path: `M ${start} ${from.y} H ${lane} V ${to.y} H ${end}`, labelX: lane, labelY: (from.y + to.y) / 2 - 8 };
}

function ClusteredKnowledgeGraph({ payload, expandedFeatures, toggleExpanded, selectedNodeId, selectNode, search, setSearch, features, featureLabel, nodeLabel, nodesForFeature, groupFor, showIndications, setShowIndications, focusedFeatureId, setFocusedFeatureId, zoom, setZoom, reset }: {
  payload: SemanticPayload; expandedFeatures: string[]; toggleExpanded: (id: string) => void;
  selectedNodeId: string | null; selectNode: (id: string) => void; search: string; setSearch: (value: string) => void;
  features: SemanticFeature[]; featureLabel: (feature: SemanticFeature) => string; nodeLabel: (node: SemanticNode) => string;
  nodesForFeature: (feature: SemanticFeature) => SemanticNode[];
  groupFor: (node: SemanticNode, payload: SemanticPayload) => string | null;
  showIndications: boolean; setShowIndications: (value: boolean) => void; focusedFeatureId: string | null; setFocusedFeatureId: (value: string | null) => void;
  zoom: number; setZoom: (value: number) => void; reset: () => void;
}) {
  const graphViewportRef = useRef<HTMLDivElement>(null);
  const graphViewportSizeRef = useRef<{ width: number; height: number } | null>(null);
  const [listLimitState, setListLimitState] = useState({ search, limit: 50 });
  const listLimit = listLimitState.search === search ? listLimitState.limit : 50;
  const [graphNodeLimits, setGraphNodeLimits] = useState<Record<string, number>>({});
  const [focusedGraphNodeId, setFocusedGraphNodeId] = useState<string | null>(null);
  const [fitRequest, setFitRequest] = useState(0);
  const appliedFitRequestRef = useRef(fitRequest);
  const graphNodePageSize = 12;
  const allFeatureIds = new Set(payload.model.features.map(feature => feature.id));
  const degree = new Map<string, number>();
  const relationsByFeature = new Map<string, number>();
  const relationRows = payload.model.edges.filter(edge => showIndications || edge.confidence === "proven");
  const groupedEdges: Array<{ source: string; target: string; confidence: "proven" | "indicated"; count: number; evidence: SemanticEdge[] }> = [];
  const aggregateEdges = new Map<string, { source: string; target: string; confidence: "proven" | "indicated"; count: number; evidence: SemanticEdge[] }>();
  const modelNodeById = new Map(payload.model.nodes.map(node => [node.id, node]));
  const edgesByFeature = new Map<string, SemanticEdge[]>();
  const edgeFeaturesById = new Map<string, Set<string>>();
  for (const feature of payload.model.features) for (const edgeId of feature.edgeIds) {
    const featureIds = edgeFeaturesById.get(edgeId) ?? new Set<string>();
    featureIds.add(feature.id);
    edgeFeaturesById.set(edgeId, featureIds);
  }
  for (const edge of relationRows) {
    const sourceNode = modelNodeById.get(edge.source), targetNode = modelNodeById.get(edge.target);
    const source = sourceNode ? groupFor(sourceNode, payload) : null;
    const target = targetNode ? groupFor(targetNode, payload) : null;
    const declaredFeatureIds = edgeFeaturesById.get(edge.id) ?? [];
    for (const featureId of new Set([source, target, ...declaredFeatureIds])) {
      if (!featureId || !allFeatureIds.has(featureId)) continue;
      const rows = edgesByFeature.get(featureId) ?? [];
      rows.push(edge);
      edgesByFeature.set(featureId, rows);
      relationsByFeature.set(featureId, (relationsByFeature.get(featureId) ?? 0) + 1);
      degree.set(featureId, (degree.get(featureId) ?? 0) + 1);
    }
    if (!source || !target || source === target || !allFeatureIds.has(source) || !allFeatureIds.has(target)) continue;
    const key = `${source}\0${target}`;
    const old = aggregateEdges.get(key);
    const row = old ? { ...old, count: old.count + 1, confidence: old.confidence === "proven" && edge.confidence === "proven" ? "proven" as const : "indicated" as const, evidence: [...old.evidence, edge] } : { source, target, confidence: edge.confidence, count: 1, evidence: [edge] };
    aggregateEdges.set(key, row);
  }
  groupedEdges.push(...aggregateEdges.values());
  const neighborIds = new Set<string>();
  if (focusedFeatureId) {
    neighborIds.add(focusedFeatureId);
    for (const edge of groupedEdges) {
      if (edge.source === focusedFeatureId) neighborIds.add(edge.target);
      if (edge.target === focusedFeatureId) neighborIds.add(edge.source);
    }
  }
  const graphNodeById = new Map(payload.model.nodes.map(node => [node.id, node]));
  const focusedNodeNeighbors = new Set<string>();
  if (focusedGraphNodeId) {
    focusedNodeNeighbors.add(focusedGraphNodeId);
    for (const edge of relationRows) {
      if (edge.source === focusedGraphNodeId) focusedNodeNeighbors.add(edge.target);
      if (edge.target === focusedGraphNodeId) focusedNodeNeighbors.add(edge.source);
    }
  }
  const featureNeighborsOfFocusedNode = new Set(features.filter(feature => nodesForFeature(feature).some(node => focusedNodeNeighbors.has(node.id))).map(feature => feature.id));
  const displayedFeatures = focusedGraphNodeId
    ? features.filter(feature => featureNeighborsOfFocusedNode.has(feature.id))
    : focusedFeatureId ? features.filter(feature => neighborIds.has(feature.id)) : features;
  function allNodesForFeature(feature: SemanticFeature): SemanticNode[] {
    return nodesForFeature(feature);
  }
  function nodesVisibleInCluster(feature: SemanticFeature): SemanticNode[] {
    const all = allNodesForFeature(feature);
    const needle = search.trim().toLocaleLowerCase();
    const matches = needle ? all.filter(node => [nodeLabel(node), node.kind, node.reason, ...node.evidence.map(item => item.filePath)].join(" ").toLocaleLowerCase().includes(needle)) : [];
    const candidates = matches.length ? matches : all;
    const inFocus = focusedGraphNodeId ? candidates.filter(node => focusedNodeNeighbors.has(node.id)) : candidates;
    return inFocus.slice(0, graphNodeLimits[feature.id] ?? graphNodePageSize);
  }
  const clusterNodes = new Map(displayedFeatures.map(feature => [feature.id, nodesVisibleInCluster(feature)]));
  const nodeCardWidth = 210;
  const nodeCardHeight = 72;
  const nodeColumnGap = 50;
  const nodeRowGap = 110;
  const featureBounds = new Map(displayedFeatures.map(feature => {
    const count = expandedFeatures.includes(feature.id) ? (clusterNodes.get(feature.id)?.length ?? 0) : 0;
    const rows = Math.ceil(count / 2);
    return [feature.id, { width: count ? 520 : 280, height: count ? 86 + rows * nodeRowGap : 112 }];
  }));
  const featureLinks = new Map(displayedFeatures.map(feature => [feature.id, new Set<string>()]));
  for (const edge of groupedEdges) {
    if (featureLinks.has(edge.source) && featureLinks.has(edge.target)) {
      featureLinks.get(edge.source)!.add(edge.target);
      featureLinks.get(edge.target)!.add(edge.source);
    }
  }
  // Put source-related features near each other, then pack remaining clusters
  // in a deterministic sunflower. A spatial hash keeps collision checks local.
  const network = packFeatureNetwork(displayedFeatures, featureBounds, featureLinks);
  const positions = network.positions;
  const nodePositions = new Map<string, { x: number; y: number }>();
  for (const feature of displayedFeatures) {
    if (!expandedFeatures.includes(feature.id)) continue;
    const center = positions.get(feature.id)!;
    const visibleNodes = clusterNodes.get(feature.id) ?? [];
    for (const [index, node] of visibleNodes.entries()) {
      const row = Math.floor(index / 2);
      const column = index % 2;
      nodePositions.set(`${feature.id}\0${node.id}`, {
        x: center.x + (visibleNodes.length === 1 ? 0 : column === 0 ? -nodeColumnGap / 2 - nodeCardWidth / 2 : nodeColumnGap / 2 + nodeCardWidth / 2),
        y: center.y - (featureBounds.get(feature.id)!.height / 2) + 122 + row * nodeRowGap,
      });
    }
  }
  const width = network.width;
  const height = network.height;
  const focusedNodeFeatureId = focusedGraphNodeId
    ? displayedFeatures.find(feature => allNodesForFeature(feature).some(node => node.id === focusedGraphNodeId))?.id
    : undefined;
  const graphAnchorFeatureId = displayedFeatures.find(feature => feature.id === focusedFeatureId)?.id
    ?? focusedNodeFeatureId
    ?? [...expandedFeatures].reverse().find(featureId => positions.has(featureId))
    ?? displayedFeatures[0]?.id;
  const graphLayoutKey = JSON.stringify([payload.revision, displayedFeatures.map(feature => feature.id), expandedFeatures, displayedFeatures.map(feature => [feature.id, clusterNodes.get(feature.id)?.map(node => node.id) ?? []]), focusedFeatureId, focusedGraphNodeId, showIndications]);
  useEffect(() => {
    const viewport = graphViewportRef.current;
    if (!viewport) return;
    let alignFrame = 0;
    const fitOrReveal = () => {
      const viewportSize = { width: viewport.getBoundingClientRect().width, height: viewport.getBoundingClientRect().height };
      const previousSize = graphViewportSizeRef.current;
      // SVG content zoom can change the viewport's intrinsic clientHeight. Only
      // a container-width change is a fit event; content height changes must
      // preserve manual zoom and only reposition the active feature.
      const resized = !previousSize || previousSize.width !== viewportSize.width;
      const forceFit = appliedFitRequestRef.current !== fitRequest;
      graphViewportSizeRef.current = viewportSize;
      let alignmentZoom = zoom;
      if (resized || forceFit) {
        const minZoom = viewport.clientWidth < 640 ? 85 : 75;
        alignmentZoom = Math.max(minZoom, Math.min(100, Math.floor((viewport.clientWidth - 32) / width * 100)));
        setZoom(alignmentZoom);
      }
      appliedFitRequestRef.current = fitRequest;
      cancelAnimationFrame(alignFrame);
      if (graphAnchorFeatureId) alignFrame = requestAnimationFrame(() => focusGraphViewport(viewport, graphAnchorFeatureId, positions, featureBounds, width, height, alignmentZoom));
    };
    fitOrReveal();
    const observer = new ResizeObserver(fitOrReveal);
    observer.observe(viewport);
    return () => { observer.disconnect(); cancelAnimationFrame(alignFrame); };
  }, [fitRequest, graphAnchorFeatureId, graphLayoutKey, height, width, zoom, setZoom]);
  const displayEdges = groupedEdges.filter(edge => positions.has(edge.source) && positions.has(edge.target));
  const displayedGraphRelations = displayedFeatures.flatMap(feature => {
    const visible = clusterNodes.get(feature.id) ?? [];
    if (!expandedFeatures.includes(feature.id) || visible.length < 2) return [];
    const visibleIds = new Set(visible.map(node => node.id));
    return relationRows.filter(edge => visibleIds.has(edge.source) && visibleIds.has(edge.target)).map(edge => ({ ...edge, featureId: feature.id }));
  });
  const principalRelationsByFeature = new Map<string, number>();
  const principalRelationIds = new Set<string>();
  for (const feature of payload.model.features) {
    const nodeIds = new Set(nodesForFeature(feature).map(node => node.id));
    const edges = (edgesByFeature.get(feature.id) ?? []).filter(edge => nodeIds.has(edge.source) && nodeIds.has(edge.target));
    principalRelationsByFeature.set(feature.id, edges.length);
    for (const edge of edges) principalRelationIds.add(edge.id);
  }
  const crossFeatureRelationIds = new Set(groupedEdges.flatMap(edge => edge.evidence.map(item => item.id)));
  const graphProjectionRelationIds = new Set([...principalRelationIds, ...crossFeatureRelationIds]);
  const renderedRelationIds = new Set([...displayedGraphRelations.map(edge => edge.id), ...displayEdges.flatMap(edge => edge.evidence.map(item => item.id))]);
  const graphRelationsOutsideProjection = Math.max(0, relationRows.length - graphProjectionRelationIds.size);
  const graphRelationsNotOnCanvas = Math.max(0, relationRows.length - renderedRelationIds.size);
  const hiddenGraphNodes = displayedFeatures.reduce((count, feature) => {
    const visibleCount = expandedFeatures.includes(feature.id) ? (clusterNodes.get(feature.id)?.length ?? 0) : 0;
    return count + Math.max(0, allNodesForFeature(feature).length - visibleCount);
  }, 0);
  const listedFeatures = displayedFeatures.slice(0, listLimit);
  const focusedNode = focusedGraphNodeId ? graphNodeById.get(focusedGraphNodeId) : undefined;
  function revealCluster(featureId: string, expanded: boolean) {
    toggleExpanded(featureId);
    if (!expanded) {
      const index = features.findIndex(feature => feature.id === featureId);
      if (index >= 0) setListLimitState({ search, limit: Math.max(listLimit, index + 1) });
    }
  }
  return <>
    <div className={styles.controls}><label>Search features, concepts, or components<input type="search" value={search} onChange={event => { setSearch(event.currentTarget.value); setFocusedFeatureId(null); }} placeholder="Search all features and evidence" /></label><p aria-live="polite">{features.length} of {payload.model.features.length} features · {payload.model.nodes.length} semantic nodes.</p></div>
    <div className={styles.graphTools} role="group" aria-label="Knowledge graph controls">
      <label><input type="checkbox" checked={showIndications} onChange={event => setShowIndications(event.currentTarget.checked)} />Show indicated relationships</label>
      <div className={styles.zoomControls}><button type="button" onClick={() => setZoom(Math.max(30, zoom - 10))} disabled={zoom <= 30} aria-label="Zoom out knowledge graph">−</button><span aria-live="polite">Zoom {zoom}%</span><button type="button" onClick={() => setZoom(Math.min(150, zoom + 10))} disabled={zoom >= 150} aria-label="Zoom in knowledge graph">+</button></div>
      <button type="button" onClick={() => { const viewport = graphViewportRef.current; if (!viewport) return; const minZoom = viewport.clientWidth < 640 ? 85 : 75; const nextZoom = Math.max(minZoom, Math.min(100, Math.floor((viewport.clientWidth - 32) / width * 100))); setZoom(nextZoom); if (graphAnchorFeatureId) requestAnimationFrame(() => focusGraphViewport(viewport, graphAnchorFeatureId, positions, featureBounds, width, height, nextZoom)); }}>Fit graph</button>
      <button type="button" onClick={() => { setGraphNodeLimits({}); setFocusedGraphNodeId(null); setFitRequest(value => value + 1); reset(); }}>Reset graph</button>
      {focusedFeatureId || focusedGraphNodeId ? <button type="button" onClick={() => { setFocusedFeatureId(null); setFocusedGraphNodeId(null); }}>Show all features and nodes</button> : null}
    </div>
    <p className={styles.graphLegend} aria-label="Knowledge graph legend"><span><i className={styles.sourceRelationLegend} />Source relationship</span><span><i className={styles.indicatedRelationLegend} />Indicated relationship</span><span>Feature frames group related responsibilities</span></p>
    <div ref={graphViewportRef} className={styles.clusterViewport} role="region" aria-label="Knowledge graph canvas; scroll to explore features" tabIndex={0}>
      <svg width={width * zoom / 100} height={height * zoom / 100} viewBox={`0 0 ${width} ${height}`} role="group" aria-label="Feature, concept, component, and source relationship clusters">
        <defs><marker id={`semantic-arrow-${analysisIdSafe(payload.analysisId)}`} markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" /></marker></defs>
        {displayedFeatures.map(feature => {
          const point = positions.get(feature.id)!;
          const size = featureBounds.get(feature.id)!;
          const colors = featureColors(feature.id);
          return <rect key={`background:${feature.id}`} className={styles.featureFrame} data-feature-background={feature.id} x={point.x - size.width / 2} y={point.y - size.height / 2} width={size.width} height={size.height} rx="12" fill={colors.fill} stroke={colors.border} />;
        })}
        {displayEdges.map((edge, index) => {
          const from = positions.get(edge.source)!, to = positions.get(edge.target)!;
          const fromBounds = featureBounds.get(edge.source)!, toBounds = featureBounds.get(edge.target)!;
          const clipped = clipRectEdge(from, to, fromBounds, toBounds);
          const sourceLabel = payload.overlay.labels[edge.source] ?? payload.model.features.find(feature => feature.id === edge.source)?.label ?? edge.source;
          const targetLabel = payload.overlay.labels[edge.target] ?? payload.model.features.find(feature => feature.id === edge.target)?.label ?? edge.target;
          const inlineLabel = displayEdges.length === 1;
          const description = `${sourceLabel} → ${targetLabel} · ${edge.count} source relationships · ${edge.confidence === "proven" ? "Proven" : "Indicated"}`;
          return <g key={`${edge.source}:${edge.target}`} data-source-id={edge.source} data-target-id={edge.target} data-inline-label={inlineLabel} role="img" aria-label={description} className={edge.confidence === "indicated" ? styles.indicatedEdge : styles.flowEdge}>
            <title>{description}. Expand a feature to inspect relationship evidence and source lines.</title>
            <path d={`M ${clipped.from.x} ${clipped.from.y} Q ${(clipped.from.x + clipped.to.x) / 2} ${Math.min(clipped.from.y, clipped.to.y) - 85 - (index % 3) * 18} ${clipped.to.x} ${clipped.to.y}`} markerEnd={`url(#semantic-arrow-${analysisIdSafe(payload.analysisId)})`} />
            {inlineLabel ? <text x={(clipped.from.x + clipped.to.x) / 2} y={Math.min(clipped.from.y, clipped.to.y) - 43 - (index % 3) * 9}>{edge.count} cross-feature relationships</text> : null}
          </g>;
        })}
        {displayedFeatures.filter(feature => expandedFeatures.includes(feature.id)).flatMap(feature => {
          const nodes = clusterNodes.get(feature.id) ?? [];
          const nodeById = new Map(nodes.map(node => [node.id, node]));
          const sourceRelations = displayedGraphRelations.filter(edge => edge.featureId === feature.id && nodeById.has(edge.source) && nodeById.has(edge.target));
          const relationLines = sourceRelations.map((edge, index) => {
            const from = nodePositions.get(`${feature.id}\0${edge.source}`), to = nodePositions.get(`${feature.id}\0${edge.target}`);
            if (!from || !to) return null;
            const route = routeChildRelation(from, to, positions.get(feature.id)!.x, nodeCardWidth, index);
            return <g key={`source:${feature.id}:${edge.id}`} data-edge-id={edge.id} data-source-id={edge.source} data-target-id={edge.target} data-scope-feature-id={feature.id} className={edge.confidence === "indicated" ? styles.indicatedEdge : styles.flowEdge}>
              <title>{`${nodeLabel(nodeById.get(edge.source)!)} ${edge.label} ${nodeLabel(nodeById.get(edge.target)!)} · ${edge.confidence === "proven" ? "Proven" : `Indicated: ${edge.reason}`}`}</title>
              <path d={route.path} markerEnd={`url(#semantic-arrow-${analysisIdSafe(payload.analysisId)})`} />
              {sourceRelations.length === 1 ? <text x={route.labelX} y={route.labelY}>{edge.label}</text> : null}
            </g>;
          });
          return relationLines;
        })}
        {displayedFeatures.map(feature => {
          const point = positions.get(feature.id)!;
          const size = featureBounds.get(feature.id)!;
          const selected = expandedFeatures.includes(feature.id);
          const totalNodes = allNodesForFeature(feature).length;
          const visibleNodes = clusterNodes.get(feature.id) ?? [];
          const mainRelationCount = principalRelationsByFeature.get(feature.id) ?? 0;
          const left = point.x - size.width / 2;
          const top = point.y - size.height / 2;
          const headingLines = splitLabel(featureLabel(feature), 32, 2);
          const nodeCount = selected ? `${visibleNodes.length} of ${totalNodes}` : `${totalNodes}`;
          const cardMeta = `${nodeCount} nodes · ${mainRelationCount} links`;
          return <g key={feature.id} data-testid="semantic-feature-card" data-feature-id={feature.id} role="button" tabIndex={0} aria-label={`${featureLabel(feature)}, ${totalNodes} concepts/components, ${mainRelationCount} primary relationships; ${selected ? "collapse group" : "expand group"}`} aria-expanded={selected} onClick={() => revealCluster(feature.id, selected)} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); revealCluster(feature.id, selected); } }} className={styles.featureCluster} style={colorStyle(feature.id)}>
            <title>{featureLabel(feature)} · {totalNodes} concepts/components · {mainRelationCount} primary relationships</title>
            <rect className={styles.featureHitbox} x={left} y={top} width={size.width} height={size.height} rx="12" fill="transparent" stroke="none" pointerEvents="all" />
            <text className={styles.featureCardTitle} x={left + 16} y={top + 28} textAnchor="start">{headingLines.map((line, index) => <tspan key={index} x={left + 16} dy={index ? 17 : 0}>{line}</tspan>)}</text>
            <text className={styles.featureCardMeta} x={left + 16} y={top + (headingLines.length > 1 ? 62 : 52)} textAnchor="start">{cardMeta}</text>
          </g>;
        })}
        {displayedFeatures.filter(feature => expandedFeatures.includes(feature.id)).flatMap(feature => (clusterNodes.get(feature.id) ?? []).map(node => { const point = nodePositions.get(`${feature.id}\0${node.id}`)!; const colors = featureColors(feature.id); const isFocused = focusedGraphNodeId === node.id; const left = point.x - nodeCardWidth / 2, top = point.y - nodeCardHeight / 2; const labelLines = splitLabel(nodeLabel(node), 24, 2); return <g key={`node:${feature.id}:${node.id}`} data-testid="semantic-graph-node" data-node-id={node.id} className={`${styles.graphNode} ${node.confidence === "indicated" ? styles.indicatedGraphNode : ""}`} role="button" tabIndex={0} data-kind={node.kind} aria-pressed={selectedNodeId === node.id} aria-label={`${node.kind}: ${nodeLabel(node)}; ${node.confidence === "proven" ? "Proven" : `Indicated: ${node.reason}`}; select to inspect evidence and relationships`} onClick={() => { selectNode(node.id); setFocusedFeatureId(null); setFocusedGraphNodeId(isFocused ? null : node.id); }} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); selectNode(node.id); setFocusedFeatureId(null); setFocusedGraphNodeId(isFocused ? null : node.id); } }}><title>{nodeLabel(node)} · {node.kind}</title><rect x={left} y={top} width={nodeCardWidth} height={nodeCardHeight} rx="8" fill={colors.fill} stroke={colors.border} /><text className={styles.graphNodeLabel} x={left + 12} y={top + 24} textAnchor="start">{labelLines.map((line, index) => <tspan key={index} x={left + 12} dy={index ? 16 : 0}>{line}</tspan>)}</text><text className={styles.graphNodeKind} x={left + 12} y={top + 61} textAnchor="start">{node.kind}</text><text className={styles.graphNodeConfidence} x={left + nodeCardWidth - 12} y={top + 61} textAnchor="end">{node.confidence === "proven" ? "PROVEN" : "INDICATED"}</text></g>; }))}
      </svg>
    </div>
    <p className={styles.flowCoverage}>Color groups each feature or domain. Feature cards group related responsibilities; expand a card to inspect its main concepts, components, and data stores. Files, methods, properties, helpers, and small details stay in evidence.</p>
    <p className={styles.flowCoverage} aria-live="polite">Showing {displayedFeatures.length} clusters · {features.length} of {payload.model.features.length} matching features · {hiddenGraphNodes} concepts/components hidden from the canvas · {graphRelationsNotOnCanvas} source relationships not drawn here (expand a cluster or inspect evidence).{graphRelationsOutsideProjection ? ` ${graphRelationsOutsideProjection} connect activities or details outside the primary graph.` : ""}{!showIndications ? ` ${payload.model.nodes.filter(node => node.confidence === "indicated" && ["concept", "component", "store"].includes(node.kind)).length} indicated nodes hidden by the filter.` : ""} {focusedNode ? `Focused node: ${nodeLabel(focusedNode)}` : ""}</p>
    <details className={styles.featureBrowser} data-testid="semantic-feature-browser">
      <summary>Browse features and evidence ({displayedFeatures.length})</summary>
      <div className={styles.clusterList} aria-label="All feature clusters">{listedFeatures.map(feature => { const expanded = expandedFeatures.includes(feature.id); const allNodes = allNodesForFeature(feature); const nodes = nodesVisibleInCluster(feature); const featureEdges = edgesByFeature.get(feature.id) ?? []; const hiddenCount = Math.max(0, allNodes.length - nodes.length); const colors = featureColors(feature.id); return <section id={`semantic-cluster-${encodeURIComponent(feature.id)}`} key={feature.id} className={styles.clusterCard} style={{ borderLeft: `3px solid ${colors.border}` }}>
      <div className={styles.clusterActions}><button type="button" className={styles.clusterHeading} onClick={() => toggleExpanded(feature.id)} aria-expanded={expanded} style={colorStyle(feature.id)}><span className={styles.featureIcon} aria-hidden="true" style={{ borderColor: colors.border, backgroundColor: colors.fill, color: colors.text }}>{featureLabel(feature)[0]?.toLocaleUpperCase() ?? "F"}</span><span><strong>{featureLabel(feature)}</strong><small>{nodes.length} of {allNodes.length} concepts/components · {principalRelationsByFeature.get(feature.id) ?? 0} primary relationships{hiddenCount ? ` · ${hiddenCount} more nodes not shown` : ""}</small></span><span>{expanded ? "−" : "+"}</span></button><button className={styles.focusButton} type="button" aria-pressed={focusedFeatureId === feature.id} onClick={() => { setFocusedGraphNodeId(null); setFocusedFeatureId(focusedFeatureId === feature.id ? null : feature.id); }} title="Focus this feature and neighboring relationships">{focusedFeatureId === feature.id ? "Focused" : "Focus neighbors"}</button></div>
      {expanded ? <div className={styles.clusterNodes}>{nodes.map(node => <div className={styles.clusterNodeItem} key={node.id}><button type="button" aria-pressed={selectedNodeId === node.id} data-kind={node.kind} data-confidence={node.confidence} onClick={() => selectNode(node.id)}><strong>{nodeLabel(node)}</strong><small>{node.kind} · {node.confidence === "proven" ? "Proven" : `Indicated: ${node.reason}`}</small></button><button className={styles.focusButton} type="button" aria-pressed={focusedGraphNodeId === node.id} onClick={() => { selectNode(node.id); setFocusedFeatureId(null); setFocusedGraphNodeId(focusedGraphNodeId === node.id ? null : node.id); }}>Focus node neighbors</button></div>)}{hiddenCount ? <button className={styles.loadMore} type="button" onClick={() => setGraphNodeLimits(current => ({ ...current, [feature.id]: (current[feature.id] ?? graphNodePageSize) + graphNodePageSize }))}>Load {Math.min(graphNodePageSize, hiddenCount)} more nodes ({nodes.length} of {allNodes.length})</button> : null}<RelationshipEvidence edges={featureEdges} nodes={payload.model.nodes} repository={payload.model.snapshot.repository} commitSha={payload.model.snapshot.commitSha} labelForNode={nodeLabel} /></div> : null}
      </section>; })}</div>
      {displayedFeatures.length > listedFeatures.length ? <button className={styles.loadMore} type="button" onClick={() => setListLimitState({ search, limit: Math.min(displayedFeatures.length, listLimit + 50) })}>Load 50 more clusters ({listedFeatures.length} of {displayedFeatures.length})</button> : null}
    </details>
  </>;
}
