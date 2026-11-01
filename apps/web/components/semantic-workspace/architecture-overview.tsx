"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { SemanticPayload } from "@sage/documents/semantic/model";
import { EvidenceLink } from "../live-document/evidence-links.tsx";
import { buildArchitectureProjection } from "./architecture-projection.ts";
import styles from "./architecture-overview.module.css";

type Props = {
  payload: SemanticPayload;
  featureIds: string[];
  showIndications: boolean;
  onShowIndications: (value: boolean) => void;
  onOpenFeature: (id: string) => void;
  onInspectNode: (id: string) => void;
};
type Box = { x: number; y: number; width: number; height: number };

/** Responsibility frames aggregate source endpoints; arrows retain their original edge IDs. */
export function ArchitectureOverview({ payload, featureIds, showIndications, onShowIndications, onOpenFeature, onInspectNode }: Props) {
  const diagram = useMemo(() => buildArchitectureProjection(payload, { featureIds, showIndications }), [payload, featureIds, showIndications]);
  const [zoom, setZoom] = useState(100);
  const [compact, setCompact] = useState(false);
  const [selected, setSelected] = useState<{ kind: "node" | "edge"; id: string } | null>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const markerId = `architecture-${useId().replace(/[^a-z0-9]/giu, "")}`;
  const featureNodes = diagram.nodes.filter(node => node.kind === "feature");
  const inputs = diagram.nodes.filter(node => node.kind === "actor" || node.kind === "component");
  const outputs = diagram.nodes.filter(node => node.kind === "store" || node.kind === "concept");
  const nodeById = new Map(diagram.nodes.map(node => [node.id, node]));
  const boxes = new Map<string, Box>();
  const featureTop = compact ? 76 + Math.ceil(inputs.length / 2) * 104 : 76;
  featureNodes.forEach((node, index) => boxes.set(node.id, { x: compact ? 24 : 408, y: featureTop + index * 218, width: compact ? 326 : 368, height: 190 }));
  // Shared identities stay outside feature frames. Reading order is not execution order.
  inputs.forEach((node, index) => boxes.set(node.id, compact
    ? { x: 24 + index % 2 * 168, y: 60 + Math.floor(index / 2) * 104, width: 158, height: 84 }
    : { x: 32, y: 88 + index * 154, width: 238, height: 112 }));
  outputs.forEach((node, index) => boxes.set(node.id, { x: compact ? 466 : 914, y: compact ? featureTop + index * 154 : 88 + index * 154, width: 238, height: 112 }));
  const width = compact ? 736 : 1184;
  const height = Math.max(420, ...[...boxes.values()].map(box => box.y + box.height + 48));
  const outgoing = new Map<string, string[]>(), incoming = new Map<string, string[]>();
  for (const edge of diagram.edges) {
    outgoing.set(edge.source, [...(outgoing.get(edge.source) ?? []), edge.id]);
    incoming.set(edge.target, [...(incoming.get(edge.target) ?? []), edge.id]);
  }
  const selectedNode = selected?.kind === "node" ? nodeById.get(selected.id) : undefined;
  const selectedEdge = selected?.kind === "edge" ? diagram.edges.find(edge => edge.id === selected.id) : undefined;
  const connectedIds = selectedNode ? new Set(diagram.edges.filter(edge => edge.source === selectedNode.id || edge.target === selectedNode.id).flatMap(edge => [edge.source, edge.target])) : null;
  const selectionKey = `${payload.analysisId}:${payload.accountKey}`;
  useEffect(() => {
    const surface = viewport.current;
    if (!surface) return;
    surface.scrollTo({ left: 0, top: 0 });
  }, [selectionKey]);
  useEffect(() => {
    const surface = viewport.current;
    if (!surface) return;
    const update = () => setCompact(surface.clientWidth < 700);
    update();
    const observer = new ResizeObserver(update); observer.observe(surface);
    return () => observer.disconnect();
  }, []);
  function fitWidth() {
    const available = viewport.current?.clientWidth ?? width;
    setZoom(Math.max(60, Math.min(100, Math.floor(available / width * 100))));
    viewport.current?.scrollTo({ left: 0, top: 0 });
  }
  function route(source: Box, target: Box, edgeId: string, sourceId: string, targetId: string, index: number) {
    const sourceEdges = outgoing.get(sourceId) ?? [], targetEdges = incoming.get(targetId) ?? [];
    const startY = source.y + 24 + (sourceEdges.indexOf(edgeId) + .5) * (source.height - 48) / Math.max(1, sourceEdges.length);
    const endY = target.y + 24 + (targetEdges.indexOf(edgeId) + .5) * (target.height - 48) / Math.max(1, targetEdges.length);
    const sourceIsInput = inputs.some(node => node.id === sourceId);
    const targetIsInput = inputs.some(node => node.id === targetId);
    if (compact && (sourceIsInput || targetIsInput)) {
      // On narrow screens actors sit above features. Leave their row through
      // its bottom gutter, then use the empty right-hand bus to reach the frame.
      const input = sourceIsInput ? source : target;
      const other = sourceIsInput ? target : source;
      const inputX = input.x + input.width / 2;
      const inputY = input.y + input.height;
      const gapY = inputY + 9;
      const lane = 378 + index % 7 * 6;
      const otherY = sourceIsInput ? endY : startY;
      const path = `M ${inputX} ${inputY} V ${gapY} H ${lane} V ${otherY} H ${other.x + other.width}`;
      return { path: sourceIsInput ? path : `M ${other.x + other.width} ${otherY} H ${lane} V ${gapY} H ${inputX} V ${inputY}`, labelX: lane - 8, labelY: otherY - 8, anchor: "end" as const };
    }
    const sameColumn = source.x === target.x;
    const rightward = target.x > source.x;
    const startX = sameColumn || rightward ? source.x + source.width : source.x;
    const endX = rightward ? target.x : target.x + target.width;
    const lane = sameColumn ? startX + 24 + index % 5 * 4 : (startX + endX) / 2 + (index % 7 - 3) * 7;
    return { path: `M ${startX} ${startY} H ${lane} V ${endY} H ${endX}`, labelX: rightward ? endX - 12 : endX + 12, labelY: endY - 8, anchor: rightward ? "end" as const : "start" as const };
  }
  const kindName = (kind: string) => ({ actor: "ACTOR", feature: "ENDPOINTS / CONTROLLERS", component: "SHARED COMPONENT", store: "DATA STORE", concept: "DOMAIN CONCEPT" }[kind] ?? kind.toUpperCase());
  const inspect = (id: string) => setSelected({ kind: "node", id });
  return <section className={styles.overview} data-testid="architecture-overview" aria-label="Connected source architecture">
    <div className={styles.intro}><div><p className={styles.eyebrow}>SOURCE ARCHITECTURE</p><h3>Actors, features, and shared data</h3><p>Ikuti garis dari aktor ke endpoint/controller dan data yang dipakai. Semua koneksi di bawah berasal dari relasi source; posisi fitur tidak menyatakan urutan aktivitas.</p></div><span className={styles.sourceCount}>{featureNodes.length} features · {diagram.edges.length} connections</span></div>
    <div className={styles.toolbar}>
      <label><input type="checkbox" checked={showIndications} onChange={event => onShowIndications(event.currentTarget.checked)} />Show indicated relationships</label>
      <div><button type="button" aria-label="Zoom out architecture" disabled={zoom <= 50} onClick={() => setZoom(value => Math.max(50, value - 10))}>−</button><output aria-live="polite">{zoom}%</output><button type="button" aria-label="Zoom in architecture" disabled={zoom >= 150} onClick={() => setZoom(value => Math.min(150, value + 10))}>+</button><button type="button" onClick={fitWidth}>Fit width</button><button type="button" onClick={() => { setZoom(100); setSelected(null); viewport.current?.scrollTo({ left: 0, top: 0 }); }}>Reset</button></div>
    </div>
    <div className={styles.legend}><span><i />Source relationship</span><span><i className={styles.dashed} />Indicated</span><span>Feature frames group endpoint/controller source facts</span></div>
    <div className={styles.viewport} ref={viewport} tabIndex={0} role="region" aria-label="Connected architecture canvas, scroll to explore" onKeyDown={event => { if (event.target !== event.currentTarget) return; if (event.key === "+" || event.key === "=") { event.preventDefault(); setZoom(value => Math.min(150, value + 10)); } if (event.key === "-") { event.preventDefault(); setZoom(value => Math.max(50, value - 10)); } }}>
      <div style={{ width: width * zoom / 100, height: height * zoom / 100 }}>
        <div className={`${styles.canvas} ${compact ? styles.compact : ""}`} style={{ width, height, transform: `scale(${zoom / 100})` }}>
          <div className={styles.laneHeading} style={{ left: compact ? 24 : 32 }}>ACTORS & SHARED SERVICES</div><div className={styles.laneHeading} style={{ left: compact ? 24 : 408, top: compact ? featureTop - 28 : 28 }}>APPLICATION FEATURES</div><div className={styles.laneHeading} style={{ left: compact ? 466 : 914, top: compact ? featureTop - 28 : 28 }}>DOMAIN & PERSISTENCE</div>
          <svg className={styles.connections} width={width} height={height} aria-label="Source architecture relationships">
            <defs><marker id={markerId} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#475569" /></marker></defs>
            {diagram.edges.map((edge, index) => {
              const source = boxes.get(edge.source), target = boxes.get(edge.target);
              if (!source || !target) return null;
              const routing = route(source, target, edge.id, edge.source, edge.target, index);
              const path = routing.path;
              const active = selectedEdge?.id === edge.id || selectedNode?.id === edge.source || selectedNode?.id === edge.target;
              const label = edge.labels.join(" / ");
              return <g key={edge.id} data-testid="architecture-edge" data-source={edge.source} data-target={edge.target} data-source-edge-ids={edge.sourceEdgeIds.join(" ")} data-confidence={edge.confidence} className={`${styles.edge} ${edge.confidence === "indicated" ? styles.indicated : ""} ${active ? styles.activeEdge : ""}`} role="button" tabIndex={0} aria-label={`${nodeById.get(edge.source)?.label} → ${nodeById.get(edge.target)?.label}: ${label}; ${edge.sourceEdgeIds.length} source relationships`} onClick={() => setSelected({ kind: "edge", id: edge.id })} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSelected({ kind: "edge", id: edge.id }); } }}>
                <title>{`${label} · ${edge.confidence} · ${edge.sourceEdgeIds.length} source relationships`}</title><path className={styles.edgeHitbox} d={path} /><path className={styles.edgeLine} d={path} markerEnd={`url(#${markerId})`} />
                <text x={routing.labelX} y={routing.labelY} textAnchor={routing.anchor}>{(edge.labels[0] ?? "source relation").slice(0, 22)}{(edge.labels[0]?.length ?? 0) > 22 ? "…" : ""}{edge.labels.length > 1 ? ` +${edge.labels.length - 1}` : ""}</text>
              </g>;
            })}
          </svg>
          {diagram.nodes.map(node => {
            const box = boxes.get(node.id);
            if (!box) return null;
            const dimmed = connectedIds && selectedNode?.id !== node.id && !connectedIds.has(node.id);
            return <button type="button" key={node.id} data-testid="architecture-node" data-node-id={node.id} data-kind={node.kind} data-source-node-ids={node.sourceNodeIds.join(" ")} className={`${styles.node} ${node.kind === "feature" ? styles.feature : node.kind === "actor" ? styles.actor : node.kind === "component" ? styles.component : styles.store} ${selectedNode?.id === node.id ? styles.selectedNode : ""} ${dimmed ? styles.dimmed : ""}`} style={{ left: box.x, top: box.y, width: box.width, height: box.height }} onClick={() => inspect(node.id)} aria-label={`${node.label}, ${kindName(node.kind)}, inspect source evidence`}>
              <span className={styles.nodeKind}>{kindName(node.kind)}</span><strong title={node.label}>{node.label}</strong>
              {node.kind === "feature" ? <><span className={styles.routePreview}>{node.routeLabels.slice(0, 2).map(label => <code key={label} title={label}>{label}</code>)}{!node.routeLabels.length ? <span>No entry point detected</span> : null}</span><span className={styles.componentPreview} title={node.componentLabels.join(" · ")}>{node.componentLabels.slice(0, 2).join(" · ") || "Source-backed feature"}</span><span className={styles.nodeMeta}>{node.routeLabels.length} endpoints · {node.componentLabels.length} components · {node.decisionCount} checks</span></> : <span className={styles.nodeMeta}>{node.confidence === "proven" ? "Proven" : "Indicated"} · {node.sourceFileCount} source files</span>}
            </button>;
          })}
        </div>
      </div>
    </div>
    <p className={styles.coverage}>{diagram.representedEdgeIds.length} source relationships represented · {diagram.hiddenEdgeCount} internal/filtered relationships in detailed flows · {diagram.hiddenNodeCount} internal/filtered facts outside this overview. Shared data connects features to a store; it does not imply a call between features.</p>
    {!diagram.edges.length ? <p className={styles.empty}>Tidak ada hubungan yang didukung source pada filter ini. Fitur tetap ditampilkan; koneksi tidak dibuat berdasarkan nama atau posisi.</p> : null}
    {selectedNode || selectedEdge ? <aside className={styles.inspector} aria-label="Architecture source detail"><div className={styles.inspectorHeading}><h4>{selectedNode?.label ?? `${nodeById.get(selectedEdge!.source)?.label} → ${nodeById.get(selectedEdge!.target)?.label}`}</h4><button type="button" onClick={() => setSelected(null)}>Close detail</button></div>
      {selectedNode ? <><p>{selectedNode.kind === "feature" ? "Frame ini merangkum endpoint/controller. Panah merepresentasikan hubungan source ke/dari anggotanya, bukan node aktivitas baru." : selectedNode.reason}</p>{selectedNode.routeLabels.length ? <div className={styles.detailLabels}>{selectedNode.routeLabels.map(label => <code key={label}>{label}</code>)}</div> : null}{selectedNode.componentLabels.length ? <div className={styles.detailLabels}>{selectedNode.componentLabels.map(label => <code key={label}>{label}</code>)}</div> : null}<button type="button" onClick={() => selectedNode.kind === "feature" ? onOpenFeature(selectedNode.id) : onInspectNode(selectedNode.sourceNodeIds[0] ?? selectedNode.id)}>{selectedNode.kind === "feature" ? "Open detailed flow" : "Inspect source node"}</button></> : <><p>{selectedEdge!.labels.join(" · ")} · {selectedEdge!.confidence === "proven" ? "Proven" : "Indicated"}</p><p>{selectedEdge!.sourceEdgeIds.length} actual source relationships. Endpoint/controller details remain linked to the original nodes.</p><ul className={styles.endpointList}>{selectedEdge!.originalEndpoints.map((pair, index) => <li key={`${pair.source}:${pair.target}:${index}`}>{payload.overlay.labels[pair.source] ?? payload.model.nodes.find(node => node.id === pair.source)?.label} → {payload.overlay.labels[pair.target] ?? payload.model.nodes.find(node => node.id === pair.target)?.label}</li>)}</ul></>}
      <div className={styles.evidence}>{(selectedNode?.evidence ?? selectedEdge?.evidence ?? []).slice(0, 12).map((evidence, index) => <EvidenceLink key={`${evidence.filePath}:${evidence.startLine}:${index}`} repository={payload.model.snapshot.repository} commitSha={payload.model.snapshot.commitSha} evidence={evidence} />)}</div>
    </aside> : null}
  </section>;
}
