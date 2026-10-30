"use client";

import type { CSSProperties, FormEvent, ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PresentationOverlay, SemanticEdge, SemanticFeature, SemanticModel, SemanticNode, SemanticPayload } from "@sage/documents/semantic/model";
import { EvidenceLink } from "../live-document/evidence-links.tsx";
import styles from "./semantic-workspace.module.css";

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
  const genericAction = /^(?:tindakan pengguna|aksi pengguna|kirim formulir|submit|batal)$/iu;
  const endpoint = /^(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+\//iu;
  const pathScore = (entry: FlowEntryOption) => flowScope(entry.node.id, nodes, edges).nodes.reduce((score, node) => score + ({ actor: 0, feature: 0, step: 1, decision: 3, component: 3, outcome: 3, store: 2, concept: 1 }[node.kind]), 0);
  const scores = new Map([...entries.values()].map(entry => [entry.node.id, pathScore(entry)]));
  return [...entries.values()].sort((left, right) => {
    const rank = (entry: FlowEntryOption) => [
      entry.actorNodes.length ? 0 : 1,
      -(scores.get(entry.node.id) ?? 0),
      endpoint.test(entry.node.label) ? 1 : 0,
      genericAction.test(entry.node.label) ? 1 : 0,
      entry.node.confidence === "proven" ? 0 : 1,
      entry.isDeclaredEntry ? 0 : 1,
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

function splitLabel(value: string, max = 22): string[] {
  const words = value.trim().split(/\s+/u);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (line && `${line} ${word}`.length > max) { lines.push(line); line = word; }
    else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines.slice(0, 3);
}

function flowLayout(nodes: SemanticNode[], edges: SemanticEdge[]) {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const indegree = new Map(nodes.map(node => [node.id, 0]));
  const outgoing = new Map(nodes.map(node => [node.id, [] as string[]]));
  for (const edge of edges) {
    if (!byId.has(edge.source) || !byId.has(edge.target)) continue;
    indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1);
    outgoing.get(edge.source)?.push(edge.target);
  }
  const layer = new Map(nodes.map(node => [node.id, 0]));
  const queue = nodes.filter(node => indegree.get(node.id) === 0).map(node => node.id).sort();
  let queueHead = 0;
  const visited = new Set<string>();
  while (queueHead < queue.length) {
    const id = queue[queueHead++]!;
    visited.add(id);
    for (const target of (outgoing.get(id) ?? []).sort()) {
      layer.set(target, Math.max(layer.get(target) ?? 0, (layer.get(id) ?? 0) + 1));
      indegree.set(target, indegree.get(target)! - 1);
      if (indegree.get(target) === 0) queue.push(target);
    }
  }
  // Cyclic and isolated source facts remain visible in a final reading layer.
  const cycleLayer = Math.max(0, ...layer.values()) + 1;
  for (const node of nodes) if (!visited.has(node.id)) layer.set(node.id, cycleLayer);
  const groups = new Map<number, SemanticNode[]>();
  for (const node of nodes) { const rank = layer.get(node.id) ?? 0; groups.set(rank, [...(groups.get(rank) ?? []), node]); }
  const sortedLayers = [...groups].sort(([a], [b]) => a - b).map(([rank, items]) => [rank, items.sort((a, b) => a.id.localeCompare(b.id))] as const);
  const positions = new Map<string, { x: number; y: number }>();
  let yOffset = 50;
  const columns = 4;
  for (const [, items] of sortedLayers) {
    for (let index = 0; index < items.length; index += 1) positions.set(items[index]!.id, { x: 126 + (index % columns) * 246, y: yOffset + Math.floor(index / columns) * 142 });
    yOffset += Math.max(1, Math.ceil(items.length / columns)) * 190;
  }
  return { positions, width: columns * 246 + 10, height: Math.max(260, yOffset + 30) };
}

function flowEdgeGeometry(source: SemanticNode, target: SemanticNode, from: { x: number; y: number }, to: { x: number; y: number }) {
  const sourceHeight = source.kind === "decision" ? 54 : 42;
  const targetHeight = target.kind === "decision" ? 54 : 42;
  const sourceWidth = source.kind === "decision" ? 78 : 100;
  const targetWidth = target.kind === "decision" ? 78 : 100;
  if (to.y > from.y + 8) {
    const startY = from.y + sourceHeight;
    const endY = to.y - targetHeight;
    const span = endY - startY;
    const bend = Math.min(90, Math.max(22, span * 0.45));
    return { path: `M ${from.x} ${startY} C ${from.x} ${startY + bend}, ${to.x} ${endY - bend}, ${to.x} ${endY}`, labelX: (from.x + to.x) / 2, labelY: (startY + endY) / 2 - 6, sourcePortOffset: sourceHeight, targetPortOffset: targetHeight };
  }
  if (to.y < from.y - 8) {
    const startY = from.y - sourceHeight;
    const endY = to.y + targetHeight;
    const laneY = Math.min(startY, endY) - 78;
    return { path: `M ${from.x} ${startY} C ${from.x} ${laneY}, ${to.x} ${laneY}, ${to.x} ${endY}`, labelX: (from.x + to.x) / 2, labelY: laneY - 6, sourcePortOffset: sourceHeight, targetPortOffset: targetHeight };
  }
  const direction = to.x >= from.x ? 1 : -1;
  const startX = from.x + sourceWidth * direction;
  const endX = to.x - targetWidth * direction;
  const laneY = Math.min(from.y, to.y) - 78;
  return { path: `M ${startX} ${from.y} C ${startX} ${laneY}, ${endX} ${laneY}, ${endX} ${to.y}`, labelX: (startX + endX) / 2, labelY: laneY - 6, sourcePortOffset: sourceWidth, targetPortOffset: targetWidth };
}

function FlowEdge({ edge, source, target, from, to, inlineLabel, markerId, labelForNode }: {
  edge: SemanticEdge; source: SemanticNode; target: SemanticNode;
  from: { x: number; y: number }; to: { x: number; y: number };
  inlineLabel: boolean; markerId: string; labelForNode: (node: SemanticNode) => string;
}) {
  const geometry = flowEdgeGeometry(source, target, from, to);
  const confidence = edge.confidence === "proven" ? "Terbukti" : "Indikasi";
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
    <summary>Daftar langkah dan evidence ({nodes.length} di jendela ini)</summary>
    <div className={styles.flowStepList} aria-label="Langkah alur dan bukti">{visibleNodes.map(node => <article key={node.id}>
      <button type="button" aria-pressed={selectedNodeId === node.id} onClick={() => selectNode(node.id)}>
        <span className={styles.stepNumber}>{node.kind === "decision" ? "◇" : node.kind === "outcome" ? "✓" : "•"}</span>
        <span><strong>{labelForNode(node)}</strong><small>{node.kind} · {node.confidence === "proven" ? "Terbukti" : `Indikasi: ${node.reason}`}</small></span>
      </button>
      <EvidenceList items={node.evidence} repository={repository} commitSha={commitSha} />
    </article>)}</div>
    {pageCount > 1 ? <div className={styles.relationshipPages} role="group" aria-label="Navigasi daftar langkah">
      <button type="button" disabled={currentPage === 0} onClick={() => setPage(value => Math.max(0, value - 1))}>Langkah sebelumnya</button>
      <span>{currentPage * pageSize + 1}–{Math.min(nodes.length, (currentPage + 1) * pageSize)} dari {nodes.length} langkah</span>
      <button type="button" disabled={currentPage + 1 >= pageCount} onClick={() => setPage(value => Math.min(pageCount - 1, value + 1))}>Langkah berikutnya</button>
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
    <summary>Evidence relasi ({edges.length})</summary>
    {open ? <>
      <div className={styles.relationshipList}>{visibleEdges.map(edge => <article key={edge.id}>
        <p><strong>{nodeById.get(edge.source) ? labelForNode(nodeById.get(edge.source)!) : "Sumber"}</strong><span aria-hidden="true"> → </span><strong>{nodeById.get(edge.target) ? labelForNode(nodeById.get(edge.target)!) : "Target"}</strong></p>
        <p><code>{edge.label}</code> · {edge.confidence === "proven" ? "Terbukti" : "Indikasi"} · {edge.reason}</p>
        <EvidenceList items={edge.evidence} repository={repository} commitSha={commitSha} />
      </article>)}</div>
      {pageCount > 1 ? <div className={styles.relationshipPages}><button type="button" disabled={currentPage === 0} onClick={() => setPage(value => Math.max(0, value - 1))}>Sebelumnya</button><span>Halaman {currentPage + 1} dari {pageCount}</span><button type="button" disabled={currentPage + 1 >= pageCount} onClick={() => setPage(value => Math.min(pageCount - 1, value + 1))}>Berikutnya</button></div> : null}
    </> : null}
  </details>;
}

function AnalysisLimitations({ items }: { items: SemanticModel["limitations"] }) {
  const [page, setPage] = useState(0);
  const pageSize = 20;
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
  const currentPage = Math.min(page, pageCount - 1);
  return <details className={styles.relationshipDisclosure}>
    <summary>Catatan batasan ekstraksi ({items.length})</summary>
    {items.length ? <>
      <ul className={styles.limitationList}>{items.slice(currentPage * pageSize, currentPage * pageSize + pageSize).map((item, index) => <li key={`${item.filePath}:${currentPage * pageSize + index}`}><code>{item.filePath}</code><span>{item.reason}</span></li>)}</ul>
      {pageCount > 1 ? <div className={styles.relationshipPages}><button type="button" disabled={currentPage === 0} onClick={() => setPage(value => Math.max(0, value - 1))}>Sebelumnya</button><span>Halaman {currentPage + 1} dari {pageCount}</span><button type="button" disabled={currentPage + 1 >= pageCount} onClick={() => setPage(value => Math.min(pageCount - 1, value + 1))}>Berikutnya</button></div> : null}
    </> : <p className={styles.emptyLimitations}>Tidak ada batasan yang dicatat oleh extractor pada snapshot ini.</p>}
  </details>;
}

export function SemanticWorkspace({ analysisId, accountKey, repository, commitSha, mode, legacyFallback, onLegacyFallback, onRevision }: Props) {
  const [state, setState] = useState<State>({ status: "loading" });
  const [legacyOpen, setLegacyOpen] = useState(false);
  const [showIndications, setShowIndications] = useState(true);
  const [query, setQuery] = useState("");
  const [flowFeatureLimit, setFlowFeatureLimit] = useState(50);
  const [flowPageState, setFlowPageState] = useState<{ key: string; page: number }>({ key: "", page: 0 });
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
    setExpandedFeatures([]); setFocusedFeatureId(null); setGraphZoom(100); setFlowZoom(100); setSelectedFeatureId(null); setFlowEntrySelection(null); setSelectedNodeId(null); setShowIndications(true); setQuery(""); setFlowFeatureLimit(50); setFlowPageState({ key: "", page: 0 });
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
  const actorsGroupedByFeature = useMemo(() => {
    const grouped = new Map<string, SemanticNode[]>();
    const append = (featureId: string, node: SemanticNode) => {
      const rows = grouped.get(featureId) ?? [];
      if (!rows.some(row => row.id === node.id)) rows.push(node);
      grouped.set(featureId, rows);
    };
    for (const [featureId, nodes] of membersByFeature) for (const node of nodes) if (node.kind === "actor") append(featureId, node);
    return grouped;
  }, [membersByFeature]);
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
  const flowFeatures = visibleFeatures.slice(0, flowFeatureLimit);

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
  const flowKey = `${selectedFeatureId ?? ""}\0${selectedFlowEntryId}\0${query}\0${showIndications}`;
  const initialFlowLayout = flowLayout(visibleFlowNodes, visibleFlowEdges);
  const orderedFlowNodes = [...visibleFlowNodes].sort((left, right) => {
    const a = initialFlowLayout.positions.get(left.id)!, b = initialFlowLayout.positions.get(right.id)!;
    return a.y - b.y || a.x - b.x || left.id.localeCompare(right.id);
  });
  const flowWindowSize = 24;
  const flowPageCount = Math.max(1, Math.ceil(orderedFlowNodes.length / flowWindowSize));
  const flowPage = Math.min(flowPageCount - 1, flowPageState.key === flowKey ? flowPageState.page : 0);
  const pageFlowNodes = orderedFlowNodes.slice(flowPage * flowWindowSize, flowPage * flowWindowSize + flowWindowSize);
  const pageFlowNodeIds = new Set(pageFlowNodes.map(node => node.id));
  const pageFlowEdges = visibleFlowEdges.filter(edge => pageFlowNodeIds.has(edge.source) && pageFlowNodeIds.has(edge.target));
  const pageNodeById = new Map(pageFlowNodes.map(node => [node.id, node]));
  const edgeDegrees = new Map<string, { incoming: number; outgoing: number }>();
  for (const edge of pageFlowEdges) {
    const sourceDegree = edgeDegrees.get(edge.source) ?? { incoming: 0, outgoing: 0 };
    const targetDegree = edgeDegrees.get(edge.target) ?? { incoming: 0, outgoing: 0 };
    sourceDegree.outgoing += 1; targetDegree.incoming += 1;
    edgeDegrees.set(edge.source, sourceDegree); edgeDegrees.set(edge.target, targetDegree);
  }
  const layout = flowLayout(pageFlowNodes, pageFlowEdges);
  const hiddenFlowNodes = orderedFlowNodes.length - pageFlowNodes.length;
  const hiddenFlowEdges = selectedFlowEdges.length - pageFlowEdges.length;

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
      <div><p className={styles.eyebrow}>{mode === "flow" ? "ALUR SOFTWARE" : "KNOWLEDGE GRAPH"}</p><h2>{mode === "flow" ? "Fitur dan alur pengguna" : "Fitur dan konsep repository"}</h2><p>{mode === "flow" ? "Pilih fitur untuk membaca aktivitas, keputusan, komponen, dan hasil beserta sumbernya." : "Setiap cluster mewakili fitur. Buka cluster untuk melihat konsep, komponen utama, dan penyimpanannya."}</p></div>
      <div className={styles.statusPills}>{payload ? <><span>{payload.model.snapshot.repository} @ <code>{payload.model.snapshot.commitSha.slice(0, 8)}</code></span>{payload.model.frameworks.length ? <span>{payload.model.frameworks.join(", ")}</span> : null}</> : null}<span>{mode === "flow" ? "Evidence source" : "Peta fitur"}</span></div>
    </header>

    {state.status === "loading" ? <p className={styles.status} role="status">Memeriksa akun dan memuat model fitur…</p> : null}
    {state.status === "legacy" ? <div className={styles.legacyNotice} role="status"><strong>Model semantik perlu dibuat.</strong><p>{state.message} Analisis source lama tetap bisa dibaca pada tampilan teknis.</p><button type="button" onClick={() => { if (onLegacyFallback) { setLegacyOpen(true); onLegacyFallback(); } else setLegacyOpen(value => !value); }} aria-expanded={onLegacyFallback ? undefined : legacyOpen}>{onLegacyFallback ? "Buka graph teknis" : legacyOpen ? "Tutup diagram lama" : "Buka diagram lama"}</button></div> : null}
    {state.status === "error" ? <div className={styles.errorBox} role="alert"><p>{state.message}</p><button type="button" onClick={() => void reload()}>Coba lagi</button>{legacyFallback ? <button type="button" onClick={() => { setLegacyOpen(true); onLegacyFallback?.(); }}>Buka graph teknis</button> : null}</div> : null}

    {fallbackSection && legacyFallback ? <div className={styles.legacyFallback}>{legacyFallback}</div> : null}
    {payload ? <AnalysisLimitations items={payload.model.limitations} /> : null}
    {payload && mode === "flow" ? <>
      <div className={styles.legend} aria-label="Legenda bukti alur"><span data-kind="actor">Aktor</span><span data-kind="step">Tindakan</span><span data-kind="decision">Keputusan</span><span data-kind="component">Layanan/API</span><span data-kind="store">Penyimpanan</span><span data-kind="outcome">Hasil</span><span><i className={styles.dashedLegend} />Indikasi</span></div>
      {!selectedFeature ? <>
        <div className={styles.controls}><label>Cari fitur<input type="search" value={query} onChange={event => updateSearch(event.currentTarget.value)} placeholder="Nama fitur, konsep, atau path bukti" /></label><p aria-live="polite">{visibleFeatures.length} dari {features.length} fitur terdeteksi.</p></div>
        <div className={styles.featureGrid} data-testid="semantic-feature-overview">
        {flowFeatures.map(feature => {
          const featureNode = payload.model.nodes.find(node => node.id === feature.id);
          const entries = feature.entryNodeIds.length;
          const evidenceFiles = new Set(feature.evidence.map(item => item.filePath));
          const actors = actorsGroupedByFeature.get(feature.id) ?? [];
          return <button className={styles.featureCard} type="button" key={feature.id} data-feature-id={feature.id} onClick={() => setSelectedFeatureId(feature.id)}>
            <span className={styles.featureIcon} aria-hidden="true">{(featureLabel(feature)[0] ?? "F").toLocaleUpperCase()}</span><span className={styles.featureBody}><strong>{featureLabel(feature)}</strong><small>{entries} titik masuk · {feature.nodeIds.length} fakta terkait</small><small>{evidenceFiles.size} file sumber · {featureNode?.confidence === "indicated" ? "indikasi" : "bukti tersedia"}</small>{actors.length ? <span className={styles.actorChips} aria-label={`Aktor yang terhubung ke ${featureLabel(feature)}`}><small>Aktor</small>{actors.map(actor => <span key={actor.id} title={actor.reason}>{nodeLabel(actor)} <small>{actor.confidence === "proven" ? "Terbukti" : "Indikasi"}</small></span>)}</span> : <small>Tidak ada aktor yang terdeteksi.</small>}</span><span aria-hidden="true">→</span>
          </button>;
        })}
        {!flowFeatures.length ? <p className={styles.status}>Tidak ada fitur sesuai pencarian.</p> : null}
        </div>
        {visibleFeatures.length > flowFeatures.length ? <button className={styles.loadMore} type="button" onClick={() => setFlowFeatureLimit(limit => Math.min(visibleFeatures.length, limit + 50))}>Muat 50 fitur berikutnya ({flowFeatures.length} dari {visibleFeatures.length})</button> : null}
      </> : <>
        <div className={styles.controls}><label>Cari langkah atau bukti<input type="search" value={query} onChange={event => updateSearch(event.currentTarget.value)} placeholder="Tindakan, keputusan, path file…" /></label><p aria-live="polite">{visibleFlowNodes.length} dari {scopedFlowNodes.length} node cocok dengan pencarian.</p></div>
        <div className={styles.flowBreadcrumb}><button type="button" onClick={() => setSelectedFeatureId(null)}>Semua fitur</button><span aria-hidden="true">/</span><strong>{payload.overlay.labels[selectedFeature.id] ?? selectedFeature.label}</strong><label><input type="checkbox" checked={showIndications} onChange={event => setShowIndications(event.currentTarget.checked)} />Tampilkan indikasi</label></div>
        <div className={styles.flowEntryTools}>
          <label>Titik awal alur<select aria-label="Mulai alur dari" value={selectedFlowEntryId} onChange={event => { setFlowEntrySelection({ featureId: selectedFeature.id, nodeId: event.currentTarget.value }); setSelectedNodeId(null); }}>
            <option value={ALL_FEATURE_FACTS}>Semua fakta fitur ({selectedFlowNodes.length})</option>
            {availableFlowEntries.map(entry => <option key={entry.node.id} value={entry.node.id}>{nodeLabel(entry.node)} · {entry.actorNodes.length ? `aksi oleh ${entry.actorNodes.map(nodeLabel).join(", ")} (${entry.actorConfidence === "proven" ? "terbukti" : "indikasi"})` : entry.isDeclaredEntry ? "titik masuk model" : "aksi terdeteksi"}</option>)}
          </select></label>
          <p aria-live="polite">{selectedFlowEntry ? `Menelusuri relasi source dari ${nodeLabel(selectedFlowEntry.node)}${selectedFlowEntry.actorNodes.length ? `, dengan aktor ${selectedFlowEntry.actorNodes.map(nodeLabel).join(", ")}` : ""}.` : `Peta semua ${selectedFlowNodes.length} fakta fitur; gunakan jendela untuk membaca bagian lain.`}</p>
        </div>
        {flowPageCount > 1 ? <div className={styles.flowPaging} role="group" aria-label="Navigasi jendela alur"><button type="button" disabled={flowPage === 0} onClick={() => setFlowPageState({ key: flowKey, page: Math.max(0, flowPage - 1) })}>Jendela sebelumnya</button><span>Jendela {flowPage + 1} dari {flowPageCount} · {orderedFlowNodes.length} node yang cocok</span><button type="button" disabled={flowPage + 1 >= flowPageCount} onClick={() => setFlowPageState({ key: flowKey, page: Math.min(flowPageCount - 1, flowPage + 1) })}>Jendela berikutnya</button></div> : null}
        <div className={styles.flowTools} role="group" aria-label="Kontrol diagram alur"><button type="button" onClick={() => setFlowZoom(value => Math.max(30, value - 10))} disabled={flowZoom <= 30} aria-label="Perkecil diagram alur">−</button><span aria-live="polite">Zoom {flowZoom}%</span><button type="button" onClick={() => setFlowZoom(value => Math.min(150, value + 10))} disabled={flowZoom >= 150} aria-label="Perbesar diagram alur">+</button><button type="button" onClick={() => { const width = flowCanvasRef.current?.clientWidth ?? layout.width; setFlowZoom(Math.max(30, Math.min(100, Math.floor((width - 20) / layout.width * 100)))); requestAnimationFrame(() => flowCanvasRef.current?.scrollTo({ top: 0, left: 0, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" })); }}>Sesuaikan diagram</button></div>
        <p className={styles.flowCoverage} aria-live="polite">Jendela ini menampilkan {pageFlowNodes.length} dari {orderedFlowNodes.length} node dan {pageFlowEdges.length} relasi source. {hiddenFlowNodes ? `${hiddenFlowNodes} node berada di jendela lain. ` : ""}{selectedFlowEntry && selectedFlowNodes.length > scopedFlowNodes.length ? `${selectedFlowNodes.length - scopedFlowNodes.length} fakta lain pada fitur ini tersedia lewat “Semua fakta fitur”. ` : ""}{hiddenFlowEdges ? `${hiddenFlowEdges} relasi tidak terlihat di jendela ini atau tersembunyi oleh filter. ` : ""}{!showIndications ? `${scopedFlowNodes.filter(node => node.confidence === "indicated").length} node indikasi disembunyikan.` : ""}</p>
        <p className={styles.edgeLabelGuidance}>Arah panah mengikuti relasi source. Pada alur dengan banyak relasi, label tersedia saat pointer berada di garis dan pada panel Evidence relasi; buka panel untuk melihat label, keyakinan, alasan, serta tautan baris kode.</p>
        <div ref={flowCanvasRef} className={styles.flowCanvas} data-testid="semantic-flow-canvas" role="region" aria-label={`${selectedFlowEntry ? "Alur" : "Peta fakta"} fitur ${featureLabel(selectedFeature)}`} tabIndex={0}>
          <svg width={layout.width * flowZoom / 100} height={layout.height * flowZoom / 100} viewBox={`0 0 ${layout.width} ${layout.height}`} role="group" aria-label={`${selectedFlowEntry ? "Diagram alur" : "Peta fakta"} ${featureLabel(selectedFeature)}`}>
            <defs><marker id={`arrow-${analysisId.replace(/[^a-z0-9]/giu, "")}`} markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" /></marker></defs>
            {pageFlowEdges.map(edge => {
              const source = pageNodeById.get(edge.source), target = pageNodeById.get(edge.target);
              const from = layout.positions.get(edge.source), to = layout.positions.get(edge.target);
              if (!source || !target || !from || !to) return null;
              const sourceDegree = edgeDegrees.get(edge.source), targetDegree = edgeDegrees.get(edge.target);
              const inlineLabel = pageFlowEdges.length <= 5 && sourceDegree?.outgoing === 1 && targetDegree?.incoming === 1;
              return <FlowEdge key={edge.id} edge={edge} source={source} target={target} from={from} to={to} inlineLabel={inlineLabel} markerId={`arrow-${analysisId.replace(/[^a-z0-9]/giu, "")}`} labelForNode={nodeLabel} />;
            })}
            {pageFlowNodes.map(node => { const point = layout.positions.get(node.id); if (!point) return null; const lines = splitLabel(nodeLabel(node)); return <g key={node.id} data-node-id={node.id} className={`${styles.flowNode} ${styles[`kind_${node.kind}`]} ${node.confidence === "indicated" ? styles.indicatedNode : ""}`} role="button" tabIndex={0} aria-label={`${node.kind}: ${nodeLabel(node)}; ${node.confidence === "proven" ? "terbukti" : "indikasi"}`} onClick={() => setSelectedNodeId(node.id)} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSelectedNodeId(node.id); } }}>{node.kind === "decision" ? <polygon points={`${point.x},${point.y - 54} ${point.x + 78},${point.y} ${point.x},${point.y + 54} ${point.x - 78},${point.y}`} /> : <rect x={point.x - 100} y={point.y - 42} width="200" height="84" rx="14" />}<text x={point.x} y={point.y - (lines.length - 1) * 8}>{lines.map((line, index) => <tspan key={index} x={point.x} dy={index ? 19 : 0}>{line}</tspan>)}</text><text className={styles.nodeKindLabel} x={point.x} y={point.y + 30}>{node.kind}</text></g>; })}
          </svg>
        </div>
        <FlowStepEvidence key={flowKey} nodes={pageFlowNodes} repository={evidenceRepository} commitSha={evidenceCommitSha} labelForNode={nodeLabel} selectedNodeId={selectedNodeId} selectNode={setSelectedNodeId} />
        <RelationshipEvidence edges={visibleFlowEdges} nodes={payload.model.nodes} repository={evidenceRepository} commitSha={evidenceCommitSha} labelForNode={nodeLabel} />
      </>}
      {selectedNode && payload ? <NodeCorrection key={`${accountKey}:${selectedNode.id}`} node={selectedNode} payload={payload} editedLabel={editedLabel} editedGroup={editedGroup} setEditedLabel={setEditedLabel} setEditedGroup={setEditedGroup} submit={submitCorrection} saving={saving} message={saveMessage} error={saveError} reload={() => void reload()} features={features} onReset={node => {
        const labels = { ...payload.overlay.labels }; delete labels[node.id]; const groups = { ...payload.overlay.groups }; delete groups[node.id]; void saveOverlay({ labels, groups });
      }} repository={evidenceRepository} commitSha={evidenceCommitSha} /> : null}
    </> : null}

    {payload && mode === "graph" ? <ClusteredKnowledgeGraph payload={payload} expandedFeatures={expandedFeatures} toggleExpanded={toggleExpanded} selectedNodeId={selectedNodeId} selectNode={setSelectedNodeId} search={query} setSearch={updateSearch} features={visibleFeatures} featureLabel={featureLabel} nodeLabel={nodeLabel} nodesForFeature={renderedFeatureNodes} groupFor={groupFor} showIndications={showIndications} setShowIndications={setShowIndications} focusedFeatureId={focusedFeatureId} setFocusedFeatureId={setFocusedFeatureId} zoom={graphZoom} setZoom={setGraphZoom} reset={() => { setExpandedFeatures([]); setFocusedFeatureId(null); setGraphZoom(100); setSelectedNodeId(null); setShowIndications(true); setQuery(""); }} /> : null}
    {selectedNode && payload && mode === "graph" ? <NodeCorrection key={`${accountKey}:${selectedNode.id}`} node={selectedNode} payload={payload} editedLabel={editedLabel} editedGroup={editedGroup} setEditedLabel={setEditedLabel} setEditedGroup={setEditedGroup} submit={submitCorrection} saving={saving} message={saveMessage} error={saveError} reload={() => void reload()} features={features} onReset={node => { const labels = { ...payload.overlay.labels }; delete labels[node.id]; const groups = { ...payload.overlay.groups }; delete groups[node.id]; void saveOverlay({ labels, groups }); }} repository={evidenceRepository} commitSha={evidenceCommitSha} /> : null}
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
    <div><p className={styles.eyebrow}>BUKTI & KOREKSI</p><h3 id="semantic-inspector-heading">{nodeLabelForInspector(node, payload)}</h3><p>{node.kind} · {node.confidence === "proven" ? "Terbukti dari source" : `Indikasi · ${node.reason}`}</p></div>
    <EvidenceList items={node.evidence} repository={repository} commitSha={commitSha} />
    <form onSubmit={submit} className={styles.correctionForm}>
      <label>Nama tampilan<input value={editedLabel} maxLength={100} onChange={event => setEditedLabel(event.currentTarget.value)} /></label>
      {["concept", "component", "store"].includes(node.kind) ? <label>Kelompok fitur<select value={editedGroup} onChange={event => setEditedGroup(event.currentTarget.value)}><option value="">Otomatis dari model</option>{features.map(feature => <option key={feature.id} value={feature.id}>{payload.overlay.labels[feature.id] ?? feature.label}</option>)}</select></label> : null}
      <div><button type="submit" disabled={saving}>{saving ? "Menyimpan…" : "Simpan koreksi"}</button><button type="button" disabled={saving || !hasOverride} onClick={() => onReset(node)}>Kembalikan otomatis</button></div>
    </form>
    {message ? <p className={styles.savedMessage} role="status">{message}</p> : null}{error ? <div className={styles.errorBox} role="alert"><p>{error}</p><button type="button" onClick={reload}>Muat ulang model</button></div> : null}
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

function ClusteredKnowledgeGraph({ payload, expandedFeatures, toggleExpanded, selectedNodeId, selectNode, search, setSearch, features, featureLabel, nodeLabel, nodesForFeature, groupFor, showIndications, setShowIndications, focusedFeatureId, setFocusedFeatureId, zoom, setZoom, reset }: {
  payload: SemanticPayload; expandedFeatures: string[]; toggleExpanded: (id: string) => void;
  selectedNodeId: string | null; selectNode: (id: string) => void; search: string; setSearch: (value: string) => void;
  features: SemanticFeature[]; featureLabel: (feature: SemanticFeature) => string; nodeLabel: (node: SemanticNode) => string;
  nodesForFeature: (feature: SemanticFeature) => SemanticNode[];
  groupFor: (node: SemanticNode, payload: SemanticPayload) => string | null;
  showIndications: boolean; setShowIndications: (value: boolean) => void; focusedFeatureId: string | null; setFocusedFeatureId: (value: string | null) => void;
  zoom: number; setZoom: (value: number) => void; reset: () => void;
}) {
  const [listLimitState, setListLimitState] = useState({ search, limit: 50 });
  const listLimit = listLimitState.search === search ? listLimitState.limit : 50;
  const [pendingRevealFeatureId, setPendingRevealFeatureId] = useState<string | null>(null);
  const [graphNodeLimits, setGraphNodeLimits] = useState<Record<string, number>>({});
  const [focusedGraphNodeId, setFocusedGraphNodeId] = useState<string | null>(null);
  const graphNodePageSize = 12;
  useEffect(() => {
    if (!pendingRevealFeatureId) return;
    const target = document.getElementById(`semantic-cluster-${encodeURIComponent(pendingRevealFeatureId)}`);
    if (!target) return;
    requestAnimationFrame(() => target.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "center" }));
  }, [listLimit, pendingRevealFeatureId]);
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
  const columns = 3;
  const cellWidth = 390;
  const positions = new Map<string, { x: number; y: number }>();
  const circlePositions = new Map<string, { x: number; y: number }>();
  let height = 44;
  for (let row = 0; row < Math.ceil(displayedFeatures.length / columns); row += 1) {
    const rowFeatures = displayedFeatures.slice(row * columns, (row + 1) * columns);
    const maxNodeRows = Math.max(0, ...rowFeatures.map(feature => expandedFeatures.includes(feature.id) ? Math.ceil((clusterNodes.get(feature.id)?.length ?? 0) / 3) : 0));
    const rowHeight = Math.max(210, 238 + maxNodeRows * 80);
    for (let column = 0; column < rowFeatures.length; column += 1) {
      const feature = rowFeatures[column]!;
      const cellX = 20 + column * cellWidth;
      positions.set(feature.id, { x: cellX + cellWidth / 2, y: height + 58 });
      if (!expandedFeatures.includes(feature.id)) continue;
      const visibleNodes = clusterNodes.get(feature.id) ?? [];
      for (const [index, node] of visibleNodes.entries()) {
        const rowIndex = Math.floor(index / 3);
        const indexInRow = index % 3;
        const countInRow = Math.min(3, visibleNodes.length - rowIndex * 3);
        const rowStart = cellX + cellWidth / 2 - ((countInRow - 1) * 120) / 2;
        circlePositions.set(`${feature.id}\0${node.id}`, { x: rowStart + indexInRow * 120, y: height + 215 + rowIndex * 80 });
      }
    }
    height += rowHeight + 24;
  }
  const width = Math.max(820, columns * cellWidth + 40);
  height = Math.max(300, height);
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
  const hiddenGraphNodes = displayedFeatures.reduce((count, feature) => count + Math.max(0, allNodesForFeature(feature).length - (clusterNodes.get(feature.id)?.length ?? 0)), 0);
  const listedFeatures = displayedFeatures.slice(0, listLimit);
  const focusedNode = focusedGraphNodeId ? graphNodeById.get(focusedGraphNodeId) : undefined;
  function revealCluster(featureId: string, expanded: boolean) {
    toggleExpanded(featureId);
    if (expanded) {
      setPendingRevealFeatureId(null);
    } else {
      const index = features.findIndex(feature => feature.id === featureId);
      if (index >= 0) setListLimitState({ search, limit: Math.max(listLimit, index + 1) });
      setPendingRevealFeatureId(featureId);
    }
  }
  return <>
    <div className={styles.controls}><label>Cari fitur, konsep, atau komponen<input type="search" value={search} onChange={event => { setSearch(event.currentTarget.value); setFocusedFeatureId(null); setPendingRevealFeatureId(null); }} placeholder="Cari dalam seluruh graph" /></label><p aria-live="polite">{features.length} dari {payload.model.features.length} fitur · {payload.model.nodes.length} fakta semantik.</p></div>
    <div className={styles.graphTools} role="group" aria-label="Kontrol knowledge graph">
      <label><input type="checkbox" checked={showIndications} onChange={event => setShowIndications(event.currentTarget.checked)} />Tampilkan indikasi</label>
      <div className={styles.zoomControls}><button type="button" onClick={() => setZoom(Math.max(60, zoom - 10))} disabled={zoom <= 60} aria-label="Perkecil knowledge graph">−</button><span aria-live="polite">Zoom {zoom}%</span><button type="button" onClick={() => setZoom(Math.min(150, zoom + 10))} disabled={zoom >= 150} aria-label="Perbesar knowledge graph">+</button></div>
      <button type="button" onClick={() => { setGraphNodeLimits({}); setFocusedGraphNodeId(null); reset(); }}>Atur ulang graph</button>
      {focusedFeatureId || focusedGraphNodeId ? <button type="button" onClick={() => { setFocusedFeatureId(null); setFocusedGraphNodeId(null); }}>Tampilkan semua fitur dan node</button> : null}
    </div>
    <p className={styles.graphLegend} aria-label="Legenda hubungan knowledge graph"><span><i className={styles.sourceRelationLegend} />Relasi source tersimpan</span><span><i className={styles.indicatedRelationLegend} />Indikasi</span><span><i className={styles.membershipRelationLegend} />Garis titik mengelompokkan node ke fitur; bukan klaim relasi kode</span></p>
    <div className={styles.clusterViewport} role="region" aria-label="Kanvas cluster knowledge graph; gulir untuk melihat fitur lain" tabIndex={0}>
      <svg width={width * zoom / 100} height={height * zoom / 100} viewBox={`0 0 ${width} ${height}`} role="group" aria-label="Jaringan cluster fitur, konsep, komponen, dan relasi source">
        <defs><marker id={`semantic-arrow-${analysisIdSafe(payload.analysisId)}`} markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" /></marker></defs>
        {displayEdges.map((edge, index) => { const from = positions.get(edge.source)!, to = positions.get(edge.target)!; const sourceLabel = payload.overlay.labels[edge.source] ?? payload.model.features.find(feature => feature.id === edge.source)?.label ?? edge.source; const targetLabel = payload.overlay.labels[edge.target] ?? payload.model.features.find(feature => feature.id === edge.target)?.label ?? edge.target; const inlineLabel = displayEdges.length === 1; const description = `${sourceLabel} → ${targetLabel} · ${edge.count} relasi source · ${edge.confidence === "proven" ? "Terbukti" : "Indikasi"}`; return <g key={`${edge.source}:${edge.target}`} data-source-id={edge.source} data-target-id={edge.target} data-inline-label={inlineLabel} role="img" aria-label={description} className={edge.confidence === "indicated" ? styles.indicatedEdge : styles.flowEdge}><title>{description}. Buka evidence fitur untuk rincian hubungan dan baris sumber.</title><path d={`M ${from.x} ${from.y} Q ${(from.x + to.x) / 2} ${Math.min(from.y, to.y) - 85 - (index % 3) * 18} ${to.x} ${to.y}`} markerEnd={`url(#semantic-arrow-${analysisIdSafe(payload.analysisId)})`} />{inlineLabel ? <text x={(from.x + to.x) / 2} y={Math.min(from.y, to.y) - 43 - (index % 3) * 9}>{edge.count} relasi antar fitur</text> : null}</g>; })}
        {displayedFeatures.filter(feature => expandedFeatures.includes(feature.id)).flatMap(feature => {
          const center = positions.get(feature.id)!;
          const nodes = clusterNodes.get(feature.id) ?? [];
          const nodeById = new Map(nodes.map(node => [node.id, node]));
          const groupingLines = nodes.map(node => { const point = circlePositions.get(`${feature.id}\0${node.id}`)!; return <g key={`membership:${feature.id}:${node.id}`} className={styles.membershipEdge}><title>{`Pengelompokan ${nodeLabel(node)} ke fitur ${featureLabel(feature)}; ini bukan relasi kode.`}</title><path d={`M ${center.x} ${center.y + 55} C ${center.x} ${center.y + 95}, ${point.x} ${point.y - 56}, ${point.x} ${point.y - 32}`} /></g>; });
          const sourceRelations = displayedGraphRelations.filter(edge => edge.featureId === feature.id && nodeById.has(edge.source) && nodeById.has(edge.target));
          const relationLines = sourceRelations.map((edge, index) => { const from = circlePositions.get(`${feature.id}\0${edge.source}`), to = circlePositions.get(`${feature.id}\0${edge.target}`); if (!from || !to) return null; const curve = (index % 3 - 1) * 14; return <g key={`source:${feature.id}:${edge.id}`} className={edge.confidence === "indicated" ? styles.indicatedEdge : styles.flowEdge}><title>{`${nodeLabel(nodeById.get(edge.source)!)} ${edge.label} ${nodeLabel(nodeById.get(edge.target)!)} · ${edge.confidence === "proven" ? "Terbukti" : `Indikasi: ${edge.reason}`}`}</title><path d={`M ${from.x} ${from.y} Q ${(from.x + to.x) / 2 + curve} ${(from.y + to.y) / 2 - curve} ${to.x} ${to.y}`} markerEnd={`url(#semantic-arrow-${analysisIdSafe(payload.analysisId)})`} />{sourceRelations.length === 1 ? <text x={(from.x + to.x) / 2} y={Math.min(from.y, to.y) - 40}>{edge.label}</text> : null}</g>; });
          return [...groupingLines, ...relationLines];
        })}
        {displayedFeatures.map(feature => { const point = positions.get(feature.id)!; const selected = expandedFeatures.includes(feature.id); const radius = Math.min(66, 48 + Math.min(18, Math.log2((degree.get(feature.id) ?? 0) + 1) * 4)); const totalNodes = allNodesForFeature(feature).length; const visibleNodes = clusterNodes.get(feature.id) ?? []; const colors = featureColors(feature.id); const mainRelationCount = principalRelationsByFeature.get(feature.id) ?? 0; return <g key={feature.id} data-feature-id={feature.id} role="button" tabIndex={0} aria-label={`${featureLabel(feature)}, ${totalNodes} konsep/komponen terpilih dari peran utama, ${mainRelationCount} relasi antarnode utama; ${selected ? "tutup cluster" : "perluas cluster"}`} aria-expanded={selected} onClick={() => revealCluster(feature.id, selected)} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); revealCluster(feature.id, selected); } }} className={styles.featureCluster} style={colorStyle(feature.id)}><circle cx={point.x} cy={point.y} r={radius} fill={colors.fill} stroke={colors.border} /><text x={point.x} y={point.y - 4} fill={colors.text}>{splitLabel(featureLabel(feature), 19).map((line, lineIndex) => <tspan key={lineIndex} x={point.x} dy={lineIndex ? 18 : 0}>{line}</tspan>)}</text><text className={styles.clusterCount} x={point.x} y={point.y + radius + 19}>{selected ? `${visibleNodes.length} ditampilkan` : `${totalNodes} konsep/komponen`} · {mainRelationCount} relasi antar node</text></g>; })}
        {displayedFeatures.filter(feature => expandedFeatures.includes(feature.id)).flatMap(feature => (clusterNodes.get(feature.id) ?? []).map(node => { const point = circlePositions.get(`${feature.id}\0${node.id}`)!; const colors = featureColors(feature.id); const isFocused = focusedGraphNodeId === node.id; return <g key={`node:${feature.id}:${node.id}`} className={`${styles.graphNode} ${node.confidence === "indicated" ? styles.indicatedGraphNode : ""}`} role="button" tabIndex={0} data-kind={node.kind} aria-pressed={selectedNodeId === node.id} aria-label={`${node.kind}: ${nodeLabel(node)}; ${node.confidence === "proven" ? "Terbukti" : `Indikasi: ${node.reason}`}; klik untuk memilih dan memfokuskan tetangga`} onClick={() => { selectNode(node.id); setFocusedFeatureId(null); setFocusedGraphNodeId(isFocused ? null : node.id); }} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); selectNode(node.id); setFocusedFeatureId(null); setFocusedGraphNodeId(isFocused ? null : node.id); } }}><circle cx={point.x} cy={point.y} r="32" fill={colors.fill} stroke={colors.border} /><text x={point.x} y={point.y - 2}>{splitLabel(nodeLabel(node), 11).map((line, index) => <tspan key={index} x={point.x} dy={index ? 11 : 0}>{line}</tspan>)}</text><text className={styles.graphNodeKind} x={point.x} y={point.y + 24}>{node.kind}</text></g>; }))}
      </svg>
    </div>
    <p className={styles.flowCoverage}>Warna membedakan fitur dan domain; ukuran lingkaran mengikuti jumlah relasi, bukan kepentingan bisnis. Node di dalam cluster adalah konsep, komponen utama, atau penyimpanan. File, method, property, helper, dan detail kecil tetap di evidence.</p>
    <p className={styles.flowCoverage} aria-live="polite">Menampilkan {displayedFeatures.length} cluster · {features.length} dari {payload.model.features.length} fitur cocok · {hiddenGraphNodes} konsep/komponen tersembunyi dari kanvas · {graphRelationsNotOnCanvas} relasi source belum tergambar di kanvas (perluas cluster atau lihat evidence).{graphRelationsOutsideProjection ? ` ${graphRelationsOutsideProjection} di antaranya menghubungkan aktivitas atau detail yang tidak menjadi node utama graph.` : ""}{!showIndications ? ` ${payload.model.nodes.filter(node => node.confidence === "indicated" && ["concept", "component", "store"].includes(node.kind)).length} node indikasi disembunyikan.` : ""} {focusedNode ? `Fokus node: ${nodeLabel(focusedNode)}` : ""}</p>
    <div className={styles.clusterList} aria-label="Daftar semua cluster fitur">{listedFeatures.map(feature => { const expanded = expandedFeatures.includes(feature.id); const allNodes = allNodesForFeature(feature); const nodes = nodesVisibleInCluster(feature); const featureEdges = edgesByFeature.get(feature.id) ?? []; const hiddenCount = Math.max(0, allNodes.length - nodes.length); const colors = featureColors(feature.id); return <section id={`semantic-cluster-${encodeURIComponent(feature.id)}`} key={feature.id} className={styles.clusterCard} style={{ borderLeft: `3px solid ${colors.border}` }}>
      <div className={styles.clusterActions}><button type="button" className={styles.clusterHeading} onClick={() => toggleExpanded(feature.id)} aria-expanded={expanded} style={colorStyle(feature.id)}><span className={styles.featureIcon} aria-hidden="true" style={{ borderColor: colors.border, backgroundColor: colors.fill, color: colors.text }}>{featureLabel(feature)[0]?.toLocaleUpperCase() ?? "F"}</span><span><strong>{featureLabel(feature)}</strong><small>{nodes.length} dari {allNodes.length} konsep/komponen · {principalRelationsByFeature.get(feature.id) ?? 0} relasi antar node utama{hiddenCount ? ` · ${hiddenCount} node lainnya belum ditampilkan` : ""}</small></span><span>{expanded ? "−" : "+"}</span></button><button className={styles.focusButton} type="button" aria-pressed={focusedFeatureId === feature.id} onClick={() => { setFocusedGraphNodeId(null); setFocusedFeatureId(focusedFeatureId === feature.id ? null : feature.id); }} title="Fokuskan fitur dan relasi tetangganya">{focusedFeatureId === feature.id ? "Fokus aktif" : "Fokus tetangga"}</button></div>
      {expanded ? <div className={styles.clusterNodes}>{nodes.map(node => <div className={styles.clusterNodeItem} key={node.id}><button type="button" aria-pressed={selectedNodeId === node.id} data-kind={node.kind} data-confidence={node.confidence} onClick={() => selectNode(node.id)}><strong>{nodeLabel(node)}</strong><small>{node.kind} · {node.confidence === "proven" ? "Terbukti" : `Indikasi: ${node.reason}`}</small></button><button className={styles.focusButton} type="button" aria-pressed={focusedGraphNodeId === node.id} onClick={() => { selectNode(node.id); setFocusedFeatureId(null); setFocusedGraphNodeId(focusedGraphNodeId === node.id ? null : node.id); }}>Fokus tetangga node</button></div>)}{hiddenCount ? <button className={styles.loadMore} type="button" onClick={() => setGraphNodeLimits(current => ({ ...current, [feature.id]: (current[feature.id] ?? graphNodePageSize) + graphNodePageSize }))}>Muat {Math.min(graphNodePageSize, hiddenCount)} node berikutnya ({nodes.length} dari {allNodes.length})</button> : null}<RelationshipEvidence edges={featureEdges} nodes={payload.model.nodes} repository={payload.model.snapshot.repository} commitSha={payload.model.snapshot.commitSha} labelForNode={nodeLabel} /></div> : null}
    </section>; })}</div>
    {displayedFeatures.length > listedFeatures.length ? <button className={styles.loadMore} type="button" onClick={() => setListLimitState({ search, limit: Math.min(displayedFeatures.length, listLimit + 50) })}>Muat 50 cluster berikutnya ({listedFeatures.length} dari {displayedFeatures.length})</button> : null}
  </>;
}
