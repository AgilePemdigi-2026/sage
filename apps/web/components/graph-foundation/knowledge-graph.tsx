"use client";

import cytoscape from "cytoscape";
import type { Core, ElementDefinition, StylesheetJson } from "cytoscape";
import { useEffect, useMemo, useRef, useState } from "react";
import type { GraphViewModel } from "./graph-projection";
import styles from "./graph-foundation.module.css";

const stylesheet: StylesheetJson = [
  { selector: "node", style: {
    label: "data(label)",
    color: "#243b57",
    "font-family": "Inter, sans-serif",
    "font-size": 9,
    "font-weight": 500,
    "text-wrap": "wrap",
    "text-max-width": "104px",
    "text-valign": "bottom",
    "text-halign": "center",
    "text-margin-y": 20,
    "text-background-color": "#ffffff",
    "text-background-opacity": 0.92,
    "text-background-padding": "2px",
    "background-color": "#e6f0ff",
    "border-width": 1.5,
    "border-color": "#5885bf",
    shape: "ellipse",
    width: "data(size)",
    height: "data(size)",
    padding: "2px",
  } },
  { selector: 'node[category = "Struktur"]', style: { "background-color": "#f0e9ff", "border-color": "#8363bd" } },
  { selector: 'node[category = "Simbol"]', style: { "background-color": "#dff6f0", "border-color": "#278b78", shape: "ellipse" } },
  { selector: 'node[category = "Belum terpecahkan"]', style: { "background-color": "#fff0e8", "border-color": "#c86a50", color: "#812839" } },
  { selector: "node.sage-selected", style: { "border-width": 3.5, "border-color": "#08796e", "overlay-color": "#2ac6ae", "overlay-opacity": 0.25, "overlay-padding": 6, width: "data(focusSize)", height: "data(focusSize)", "font-size": 12, "font-weight": 700, "text-margin-y": 31, "z-index": 10 } },
  { selector: "node.sage-neighbor", style: { "border-width": 2.5, "border-color": "#278b78", width: "data(neighborSize)", height: "data(neighborSize)", "font-size": 10, "font-weight": 600, "text-margin-y": 24, "z-index": 5 } },
  { selector: "node.sage-dimmed", style: { opacity: 0.18 } },
  { selector: "edge", style: {
    width: 1.5,
    "line-color": "#a9bac6",
    "target-arrow-color": "#849dac",
    "target-arrow-shape": "triangle",
    "curve-style": "bezier",
    label: "",
    color: "#415b70",
    "font-family": "Inter, sans-serif",
    "font-size": 8,
    "font-weight": 600,
    "text-rotation": "autorotate",
    "text-background-color": "#ffffff",
    "text-background-opacity": 0.95,
    "text-background-padding": "2px",
    "text-border-width": 0,
  } },
  { selector: 'edge[kind = "CONTAINS"]', style: { "line-style": "dotted", "line-color": "#c3d0d7", "target-arrow-shape": "none", width: 1 } },
  { selector: 'edge[resolution = "Unresolved"]', style: { "line-style": "dashed", "line-color": "#c96754", "target-arrow-color": "#c96754", color: "#812839", "width": 2 } },
  { selector: "edge.sage-connected", style: { label: "data(label)", width: 2.8, "line-color": "#278b78", "target-arrow-color": "#278b78", "z-index": 5 } },
  { selector: 'edge.sage-connected[resolution = "Unresolved"]', style: { "line-color": "#c96754", "target-arrow-color": "#c96754", color: "#812839" } },
  { selector: "edge.sage-dimmed", style: { opacity: 0.12 } },
];

function compactLabel(value: string): string {
  return value.length > 26 ? `${value.slice(0, 25)}…` : value;
}

function canvasElements(graph: GraphViewModel): ElementDefinition[] {
  const degreeByNodeId = new Map<string, number>();
  for (const edge of graph.edges) {
    degreeByNodeId.set(edge.source, (degreeByNodeId.get(edge.source) ?? 0) + 1);
    degreeByNodeId.set(edge.target, (degreeByNodeId.get(edge.target) ?? 0) + 1);
  }
  return [
    ...graph.nodes.map((node) => {
      const baseSize = node.category === "Struktur" ? 32 : node.category === "Berkas" ? 27 : node.category === "Belum terpecahkan" ? 24 : 22;
      const degree = degreeByNodeId.get(node.id) ?? 0;
      const size = Math.min(42, baseSize + Math.round(Math.sqrt(degree) * 2));
      return {
        group: "nodes" as const,
        data: {
          id: node.id,
          label: compactLabel(node.name),
          name: node.name,
          category: node.category,
          size,
          neighborSize: size + 6,
          focusSize: size + 12,
        },
      };
    }),
    ...graph.edges.map((edge) => ({
      group: "edges" as const,
      data: { id: edge.id, source: edge.source, target: edge.target, label: edge.label, kind: edge.kind, resolution: edge.resolution },
    })),
  ];
}

function zoomPercent(core: Core | null): number {
  const value = core?.zoom();
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value * 100) : 100;
}

function focusNeighborhood(core: Core, selectedId: string | null): void {
  core.elements().removeClass("sage-selected sage-neighbor sage-connected sage-dimmed");
  if (!selectedId) return;
  const selected = core.getElementById(selectedId);
  if (selected.empty()) return;
  core.nodes().addClass("sage-dimmed");
  core.edges().addClass("sage-dimmed");
  selected.removeClass("sage-dimmed").addClass("sage-selected");
  const incident = selected.connectedEdges();
  incident.removeClass("sage-dimmed").addClass("sage-connected");
  incident.connectedNodes().removeClass("sage-dimmed").addClass("sage-neighbor");
}

export function GraphCanvas({ graph, selectedId, onSelect }: {
  graph: GraphViewModel;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const coreRef = useRef<Core | null>(null);
  const selectedIdRef = useRef<string | null>(selectedId);
  const [zoom, setZoom] = useState(100);
  const elements = useMemo(() => canvasElements(graph), [graph]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !graph.nodes.length) return;

    const core = cytoscape({
      container: host,
      elements,
      style: stylesheet,
      minZoom: 0.1,
      maxZoom: 2.5,
      wheelSensitivity: 0.18,
      layout: {
        name: "cose",
        animate: false,
        randomize: true,
        padding: 36,
        nodeRepulsion: 4_400,
        nodeOverlap: 12,
        idealEdgeLength: 78,
        edgeElasticity: 90,
        nestingFactor: 1,
        gravity: 0.24,
        numIter: 420,
        initialTemp: 180,
        coolingFactor: 0.96,
        minTemp: 1,
        componentSpacing: 38,
      },
      boxSelectionEnabled: false,
      autoungrabify: false,
    });
    coreRef.current = core;
    const updateZoom = () => {
      if (core.destroyed()) return;
      const nextZoom = zoomPercent(core);
      setZoom((current) => current === nextZoom ? current : nextZoom);
    };
    const selectNode = (event: cytoscape.EventObject) => {
      focusNeighborhood(core, event.target.id());
      onSelect(event.target.id());
    };
    const hoverNode = (event: cytoscape.EventObject) => focusNeighborhood(core, event.target.id());
    const leaveNode = () => focusNeighborhood(core, selectedIdRef.current);
    core.on("zoom", updateZoom);
    core.on("tap", "node", selectNode);
    core.on("mouseover", "node", hoverNode);
    core.on("mouseout", "node", leaveNode);
    core.on("layoutstop", updateZoom);

    const resizeObserver = new ResizeObserver(() => {
      if (core.destroyed()) return;
      core.resize();
      updateZoom();
    });
    resizeObserver.observe(host);
    core.ready(() => {
      if (core.nodes().length > 0) core.fit(undefined, 32);
      updateZoom();
    });

    return () => {
      resizeObserver.disconnect();
      core.removeListener("zoom", updateZoom);
      core.removeListener("tap", "node", selectNode);
      core.removeListener("mouseover", "node", hoverNode);
      core.removeListener("mouseout", "node", leaveNode);
      core.removeListener("layoutstop", updateZoom);
      core.destroy();
      if (coreRef.current === core) coreRef.current = null;
    };
  }, [elements, graph.nodes.length, onSelect]);

  useEffect(() => {
    selectedIdRef.current = selectedId;
    const core = coreRef.current;
    if (!core) return;
    focusNeighborhood(core, selectedId);
  }, [graph, selectedId]);

  function scaleBy(factor: number) {
    const core = coreRef.current;
    const host = hostRef.current;
    if (!core || core.destroyed() || core.nodes().empty() || !host || host.clientWidth <= 0 || host.clientHeight <= 0) return;
    core.zoom({ level: core.zoom() * factor, renderedPosition: { x: host.clientWidth / 2, y: host.clientHeight / 2 } });
    setZoom(zoomPercent(core));
  }

  function fitGraph() {
    const core = coreRef.current;
    if (!core || core.destroyed() || core.nodes().empty()) return;
    core.fit(undefined, 32);
    setZoom(zoomPercent(core));
  }

  const displayedZoom = graph.nodes.length > 0 ? zoom : 100;

  return <div className={styles.canvasArea}>
    <div className={styles.canvasToolbar} aria-label="Kontrol kanvas">
      <div className={styles.canvasActions}>
        <button type="button" className={styles.graphControl} onClick={() => scaleBy(1.2)} aria-label="Perbesar" disabled={!graph.nodes.length}>Perbesar</button>
        <button type="button" className={styles.graphControl} onClick={() => scaleBy(1 / 1.2)} aria-label="Perkecil" disabled={!graph.nodes.length}>Perkecil</button>
        <button type="button" className={styles.graphControl} onClick={fitGraph} aria-label="Sesuaikan tampilan" disabled={!graph.nodes.length}>Sesuaikan tampilan</button>
      </div>
      <output className={styles.zoomOutput} aria-live="polite" aria-label="Tingkat zoom">{displayedZoom}%</output>
    </div>
    <div className={styles.canvasFrame}>
      <div ref={hostRef} role="region" aria-label="Kanvas knowledge graph" aria-describedby="graph-canvas-help" className={styles.canvas} />
    </div>
    <p id="graph-canvas-help" className={styles.canvasHelp}>Arahkan pointer ke node untuk menyorot tetangganya dan melihat jenis relasi. Pilih node untuk membuka fokus serta detail lengkapnya. Label panjang dipersingkat di kanvas. Gunakan roda mouse atau tombol zoom; untuk keyboard, pilih node lewat kontrol di atas.</p>
  </div>;
}
