"use client";

import cytoscape from "cytoscape";
import type { Core, ElementDefinition, StylesheetJson } from "cytoscape";
import { useEffect, useMemo, useRef, useState } from "react";
import type { GraphViewModel } from "./graph-projection";
import { Icon } from "../design-system/icons.tsx";
import styles from "./graph-foundation.module.css";

/** Warna graph diambil dari token @theme (apps/web/app/globals.css) saat kanvas dibuat; nilai cadangan = token yang sama.
 *  Kategori: Berkas = info, Struktur = ink, Simbol = teal, Belum terpecahkan = error. Legend memakai token yang sama. */
function themeTokens() {
  const root = typeof document === "undefined" ? null : getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string) => root?.getPropertyValue(name).trim() || fallback;
  return {
    ink: read("--color-ink", "#061e42"),
    muted: read("--color-muted", "#4a5b73"),
    subtle: read("--color-subtle", "#5f6f85"),
    surface: read("--color-surface", "#ffffff"),
    subtleBg: read("--color-subtle-bg", "#eef3f7"),
    teal50: read("--color-teal-50", "#e6faf6"),
    teal500: read("--color-teal-500", "#2ac6ae"),
    teal700: read("--color-teal-700", "#0b7a6c"),
    info: read("--color-info", "#1d5fa8"),
    infoFill: read("--color-info-fill", "#e8f1fb"),
    error: read("--color-error", "#b42318"),
    errorFill: read("--color-error-fill", "#fdecea"),
    sans: read("--font-sans", '"Plus Jakarta Sans", sans-serif'),
  };
}

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function graphStylesheet(): StylesheetJson {
  const t = themeTokens();
  // Sorot hover/tetangga 150 ms (motion spec); tanpa transisi saat prefers-reduced-motion.
  const transition = prefersReducedMotion() ? {} : {
    "transition-property": "opacity, border-width, border-color, line-color, width",
    "transition-duration": 150,
    "transition-timing-function": "ease-out" as const,
  };
  return [
    { selector: "node", style: {
      label: "data(label)",
      color: t.ink,
      "font-family": t.sans,
      "font-size": 9,
      "font-weight": 600,
      "text-wrap": "wrap",
      "text-max-width": "104px",
      "text-valign": "bottom",
      "text-halign": "center",
      "text-margin-y": 20,
      "text-background-color": t.surface,
      "text-background-opacity": 0.92,
      "text-background-padding": "2px",
      "text-background-shape": "roundrectangle",
      "background-color": t.infoFill,
      "border-width": 1.5,
      "border-color": t.info,
      shape: "ellipse",
      width: "data(size)",
      height: "data(size)",
      padding: "2px",
      ...transition,
    } },
    { selector: 'node[category = "Struktur"]', style: { "background-color": t.subtleBg, "border-color": t.ink } },
    { selector: 'node[category = "Simbol"]', style: { "background-color": t.teal50, "border-color": t.teal700, shape: "ellipse" } },
    { selector: 'node[category = "Belum terpecahkan"]', style: { "background-color": t.errorFill, "border-color": t.error, color: t.error } },
    { selector: "node.sage-selected", style: { "border-width": 3.5, "border-color": t.teal700, "overlay-color": t.teal500, "overlay-opacity": 0.25, "overlay-padding": 6, width: "data(focusSize)", height: "data(focusSize)", "font-size": 12, "font-weight": 700, "text-margin-y": 31, "z-index": 10 } },
    { selector: "node.sage-neighbor", style: { "border-width": 2.5, "border-color": t.teal700, width: "data(neighborSize)", height: "data(neighborSize)", "font-size": 10, "font-weight": 700, "text-margin-y": 24, "z-index": 5 } },
    // Motion spec: node di luar sorotan opacity .25.
    { selector: "node.sage-dimmed", style: { opacity: 0.25 } },
    { selector: "edge", style: {
      width: 1.5,
      "line-color": t.subtle,
      "line-opacity": 0.55,
      "target-arrow-color": t.subtle,
      "target-arrow-shape": "triangle",
      "curve-style": "bezier",
      label: "",
      color: t.muted,
      "font-family": t.sans,
      "font-size": 8,
      "font-weight": 600,
      "text-rotation": "autorotate",
      "text-background-color": t.surface,
      "text-background-opacity": 0.95,
      "text-background-padding": "2px",
      "text-border-width": 0,
      ...transition,
    } },
    { selector: 'edge[kind = "CONTAINS"]', style: { "line-style": "dotted", "line-opacity": 0.4, "target-arrow-shape": "none", width: 1 } },
    { selector: 'edge[resolution = "Unresolved"]', style: { "line-style": "dashed", "line-color": t.error, "line-opacity": 0.75, "target-arrow-color": t.error, color: t.error, "width": 2 } },
    { selector: "edge.sage-connected", style: { label: "data(label)", width: 2.8, "line-color": t.teal700, "line-opacity": 1, "target-arrow-color": t.teal700, color: t.ink, "z-index": 5 } },
    { selector: 'edge.sage-connected[resolution = "Unresolved"]', style: { "line-color": t.error, "target-arrow-color": t.error, color: t.error } },
    { selector: "edge.sage-dimmed", style: { opacity: 0.18 } },
  ];
}

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
  incident.connectedNodes().not(selected).removeClass("sage-dimmed").addClass("sage-neighbor");
}

export function GraphCanvas({ graph, selectedId, onSelect, collapsed = false }: {
  graph: GraphViewModel;
  /** Graph kosong/tanpa hasil: region kanvas disembunyikan; kontrol zoom tetap ada (nonaktif) tetapi tidak terlihat. */
  collapsed?: boolean;
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
      style: graphStylesheet(),
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
    // Label kanvas digambar dengan font token; gambar ulang setelah webfont siap (tidak mengubah layout).
    void document.fonts?.ready.then(() => { if (!core.destroyed()) core.style().update(); });

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

  return <div className={styles.canvasArea} data-collapsed={collapsed || undefined}>
    <div className={styles.canvasFrame}>
      <div ref={hostRef} role="region" aria-label="Kanvas knowledge graph" aria-describedby="graph-canvas-help" className={styles.canvas} hidden={collapsed} />
      <div className={styles.canvasToolbar} aria-label="Kontrol kanvas">
        <div className={styles.canvasActions}>
          <button type="button" className={styles.zoomButton} onClick={() => scaleBy(1.2)} aria-label="Perbesar" title="Perbesar" disabled={!graph.nodes.length}><Icon name="plus" /></button>
          <button type="button" className={styles.zoomButton} onClick={() => scaleBy(1 / 1.2)} aria-label="Perkecil" title="Perkecil" disabled={!graph.nodes.length}><Icon name="minus" /></button>
          <button type="button" className={styles.zoomButton} onClick={fitGraph} aria-label="Sesuaikan tampilan" title="Sesuaikan tampilan" disabled={!graph.nodes.length}><Icon name="fit" /></button>
        </div>
        <output className={styles.zoomOutput} aria-live="polite" aria-label="Tingkat zoom">{displayedZoom}%</output>
      </div>
    </div>
    <p id="graph-canvas-help" className={styles.canvasHelp} hidden={collapsed}>Arahkan pointer ke node untuk menyorot tetangganya dan melihat jenis relasi. Pilih node untuk membuka fokus serta detail lengkapnya. Label panjang dipersingkat di kanvas. Geser kanvas untuk berpindah, gunakan roda mouse atau tombol zoom; untuk keyboard, pilih node lewat daftar “Pilih node fokus”.</p>
  </div>;
}
