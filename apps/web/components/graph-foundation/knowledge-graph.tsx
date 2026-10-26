"use client";

import cytoscape from "cytoscape";
import type { Core, ElementDefinition, StylesheetJson } from "cytoscape";
import { useEffect, useMemo, useRef, useState } from "react";
import type { GraphViewModel } from "./graph-projection";
import styles from "./graph-foundation.module.css";

const stylesheet: StylesheetJson = [
  { selector: "node", style: {
    label: "data(label)",
    color: "#092440",
    "font-family": "Inter, sans-serif",
    "font-size": 10,
    "font-weight": 600,
    "text-wrap": "wrap",
    "text-max-width": "116px",
    "text-valign": "center",
    "text-halign": "center",
    "background-color": "#e3edf5",
    "border-width": 1.5,
    "border-color": "#7993aa",
    shape: "round-rectangle",
    width: 138,
    height: 60,
    padding: "8px",
  } },
  { selector: 'node[category = "Struktur"]', style: { "background-color": "#dff3eb", "border-color": "#3e8066", shape: "hexagon" } },
  { selector: 'node[category = "Simbol"]', style: { "background-color": "#e4f2f4", "border-color": "#36818a", shape: "ellipse" } },
  { selector: 'node[category = "Belum terpecahkan"]', style: { "background-color": "#fff0f0", "border-color": "#a53c4a", color: "#812839", shape: "diamond", width: 154, height: 76 } },
  { selector: "node:parent", style: { "background-opacity": 0.18, "border-style": "dashed", "border-width": 2, "border-color": "#587b91", padding: "28px", "text-valign": "top", "text-halign": "center", "font-size": 11 } },
  { selector: "node.sage-selected", style: { "border-width": 4, "border-color": "#075f58", "overlay-color": "#2ac6ae", "overlay-opacity": 0.16, "overlay-padding": 7 } },
  { selector: "edge", style: {
    width: 2,
    "line-color": "#307d70",
    "target-arrow-color": "#307d70",
    "target-arrow-shape": "triangle",
    "curve-style": "bezier",
    label: "data(label)",
    color: "#273e57",
    "font-family": "Inter, sans-serif",
    "font-size": 8,
    "font-weight": 600,
    "text-rotation": "autorotate",
    "text-background-color": "#ffffff",
    "text-background-opacity": 0.95,
    "text-background-padding": "2px",
    "text-border-width": 0,
  } },
  { selector: 'edge[resolution = "Unresolved"]', style: { "line-style": "dashed", "line-color": "#ac4150", "target-arrow-color": "#ac4150", color: "#812839", "width": 2.5 } },
  { selector: "edge.sage-selected", style: { width: 4 } },
];

function canvasElements(graph: GraphViewModel, moduleParentByNodeId?: Readonly<Record<string, string>>): ElementDefinition[] {
  return [
    ...graph.nodes.map((node) => ({
      group: "nodes" as const,
      data: {
        id: node.id,
        label: node.label,
        name: node.name,
        category: node.category,
        ...(moduleParentByNodeId?.[node.id] ? { parent: moduleParentByNodeId[node.id] } : {}),
      },
    })),
    ...graph.edges.map((edge) => ({
      group: "edges" as const,
      data: { id: edge.id, source: edge.source, target: edge.target, label: edge.label, resolution: edge.resolution },
    })),
  ];
}

function zoomPercent(core: Core | null): number {
  const value = core?.zoom();
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value * 100) : 100;
}

export function GraphCanvas({ graph, selectedId, onSelect, moduleParentByNodeId }: {
  graph: GraphViewModel;
  selectedId: string | null;
  onSelect: (id: string) => void;
  moduleParentByNodeId?: Readonly<Record<string, string>>;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const coreRef = useRef<Core | null>(null);
  const [zoom, setZoom] = useState(100);
  const elements = useMemo(() => canvasElements(graph, moduleParentByNodeId), [graph, moduleParentByNodeId]);

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
      layout: { name: "breadthfirst", directed: true, padding: 48, spacingFactor: 1.25, avoidOverlap: true },
      boxSelectionEnabled: false,
      autoungrabify: false,
    });
    coreRef.current = core;
    const updateZoom = () => {
      if (core.destroyed()) return;
      const nextZoom = zoomPercent(core);
      setZoom((current) => current === nextZoom ? current : nextZoom);
    };
    const selectNode = (event: cytoscape.EventObject) => onSelect(event.target.id());
    core.on("zoom", updateZoom);
    core.on("tap", "node", selectNode);
    core.on("layoutstop", updateZoom);

    const resizeObserver = new ResizeObserver(() => {
      if (core.destroyed()) return;
      core.resize();
      if (core.nodes().length > 0) core.fit(undefined, 32);
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
      core.removeListener("layoutstop", updateZoom);
      core.destroy();
      if (coreRef.current === core) coreRef.current = null;
    };
  }, [elements, graph.nodes.length, onSelect]);

  useEffect(() => {
    const core = coreRef.current;
    if (!core) return;
    core.nodes().removeClass("sage-selected");
    core.edges().removeClass("sage-selected");
    if (!selectedId) return;
    core.getElementById(selectedId).addClass("sage-selected");
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
    <p id="graph-canvas-help" className={styles.canvasHelp}>Gunakan roda mouse atau tombol zoom untuk mengubah tampilan. Untuk memilih node dengan keyboard, gunakan kontrol pemilihan node.</p>
  </div>;
}
