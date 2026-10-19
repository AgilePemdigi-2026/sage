"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CcmEdge, CcmNode, EvidenceSpan } from "@sage/contracts";
import { ANALYSIS_STAGE_DEFINITIONS, type AnalysisStageStatus } from "@sage/contracts";
import type { PreviewData } from "./types.ts";
import { projectCcmForGraph } from "../graph-foundation/graph-projection.ts";
import { GraphCanvas } from "../graph-foundation/knowledge-graph.tsx";
import { AssetIcon, Badge, CopySha, DesignFrame, Panel } from "../design-system/ui.tsx";
import styles from "./preview-client.module.css";

type Screen = "progress" | "history" | "graph";
type ProgressScenario = "running" | "pending" | "failed" | "completed" | "limitations";
type HistoryScenario = "ready" | "loading" | "empty" | "error";
type SourceRequest = { filePath: string; startLine: number; endLine: number; title: string; kind: "node" | "edge" };

const categoryIcons: Record<CcmNode["kind"], string> = {
  Module: "imgCategoryShapeModule",
  Class: "imgCategoryShapeClass",
  Interface: "imgCategoryShapeInterface",
  Function: "imgCategoryShapeFunction",
  Method: "imgCategoryShapeMethod",
  Property: "imgCategoryShapeProperty",
  UnresolvedReference: "imgCategoryShapeUnresolvedReference",
};
const allCategories = ["Berkas", "Struktur", "Simbol", "Belum terpecahkan"] as const;
const scenarioOptions: { value: ProgressScenario; label: string; tone: "info" | "neutral" | "error" | "success" | "warning" }[] = [
  { value: "running", label: "Berjalan", tone: "info" },
  { value: "pending", label: "Menunggu", tone: "neutral" },
  { value: "failed", label: "Gagal", tone: "error" },
  { value: "completed", label: "Selesai", tone: "success" },
  { value: "limitations", label: "Selesai dengan batasan", tone: "warning" },
];
const scenarioCopy: Record<ProgressScenario, { title: string; description: string }> = {
  running: { title: "Tampilan status: berjalan", description: "Contoh tampilan saat analisis sedang berjalan. Fixture ini tidak memiliki job aktif atau progres tahap." },
  pending: { title: "Tampilan status: menunggu", description: "Contoh tampilan saat analisis menunggu. Tidak ada antrean atau pekerjaan yang dibuat." },
  failed: { title: "Tampilan status: gagal", description: "Contoh tampilan status gagal. Fixture tidak merekam error analisis atau penyebab kegagalan." },
  completed: { title: "Tampilan status: selesai", description: "Contoh tampilan status selesai. Data di bawah tetap snapshot fixture, bukan hasil analisis yang dijalankan." },
  limitations: { title: "Tampilan status: selesai dengan batasan", description: "Contoh tampilan status dengan batasan. Tidak ada laporan hasil eksekusi yang tersimpan pada fixture ini." },
};

function sourceRange(span: EvidenceSpan | null): { startLine: number; endLine: number } | null {
  return span ? { startLine: span.startLine, endLine: span.endLine } : null;
}

function nodeLocation(node: CcmNode) {
  if (!node.filePath || !node.location) return "Tidak ada lokasi deklarasi source";
  return `${node.filePath}:${node.location.startLine}${node.location.endLine !== node.location.startLine ? `–${node.location.endLine}` : ""}`;
}

function SourceDialog({ data, request, onClose }: { data: PreviewData; request: SourceRequest; onClose: () => void }) {
  const closeButton = useRef<HTMLButtonElement>(null);
  const text = data.sources[request.filePath] ?? "";
  const allLines = text.split("\n");
  const first = Math.max(1, request.startLine);
  const last = Math.min(allLines.length, Math.max(first, request.endLine));
  const shown = allLines.slice(first - 1, last);

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButton.current?.focus();
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") { event.preventDefault(); onClose(); }
      if (event.key !== "Tab") return;
      const dialog = document.getElementById("source-evidence-dialog");
      const focusable = dialog?.querySelectorAll<HTMLElement>("button:not(:disabled), a[href], [tabindex='0']");
      if (!focusable?.length) return;
      const firstFocusable = focusable[0];
      const lastFocusable = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === firstFocusable) { event.preventDefault(); lastFocusable.focus(); }
      else if (!event.shiftKey && document.activeElement === lastFocusable) { event.preventDefault(); firstFocusable.focus(); }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      previous?.focus();
    };
  }, [onClose]);

  return <div className={styles.dialogBackdrop} onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section id="source-evidence-dialog" className={styles.sourceDialog} role="dialog" aria-modal="true" aria-labelledby="source-evidence-title">
      <header className={styles.dialogHeader}>
        <div><p className={styles.eyebrow}>BUKTI SUMBER · {request.kind === "edge" ? "RELASI" : "NODE"}</p><h2 id="source-evidence-title">{request.title}</h2></div>
        <button ref={closeButton} className={styles.closeButton} type="button" onClick={onClose} aria-label="Tutup bukti sumber">Tutup</button>
      </header>
      <p className={styles.sourcePath}>{request.filePath}:{first}{last !== first ? `–${last}` : ""}</p>
      {text ? <pre className={styles.sourceCode} tabIndex={0} aria-label="Cuplikan source code">{shown.map((line, index) => <span className={index + first >= request.startLine && index + first <= request.endLine ? styles.highlightLine : undefined} key={`${index + first}-${line}`}><i>{index + first}</i>{line || " "}{"\n"}</span>)}</pre> : <p className={styles.emptyState}>File source tidak tersedia pada fixture.</p>}
    </section>
  </div>;
}

function GraphScreen({ data }: { data: PreviewData }) {
  const graph = useMemo(() => projectCcmForGraph(data.model), [data.model]);
  const [query, setQuery] = useState("");
  const [categories, setCategories] = useState<string[]>([...allCategories]);
  const [mode, setMode] = useState<"all" | "focus">("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sourceRequest, setSourceRequest] = useState<SourceRequest | null>(null);

  const matchedNodes = useMemo(() => graph.nodes.filter(node => {
    const search = query.trim().toLowerCase();
    const matchesQuery = !search || [node.name, node.qualifiedName, node.kind, node.filePath ?? ""].some(value => value.toLowerCase().includes(search));
    return categories.includes(node.category) && matchesQuery;
  }), [graph.nodes, query, categories]);
  const focusAnchorId = matchedNodes.find(node => node.id === selectedId)?.id ?? matchedNodes[0]?.id ?? null;
  const focusSet = useMemo(() => {
    if (mode !== "focus" || !focusAnchorId) return null;
    const connected = new Set([focusAnchorId]);
    for (const edge of graph.edges) {
      if (edge.source === focusAnchorId) connected.add(edge.target);
      if (edge.target === focusAnchorId) connected.add(edge.source);
    }
    return connected;
  }, [graph.edges, mode, focusAnchorId]);
  const visibleNodes = useMemo(() => matchedNodes.filter(node => !focusSet || focusSet.has(node.id)), [matchedNodes, focusSet]);
  const visibleIds = useMemo(() => new Set(visibleNodes.map(node => node.id)), [visibleNodes]);
  const visibleEdges = useMemo(() => graph.edges.filter(edge => visibleIds.has(edge.source) && visibleIds.has(edge.target)), [graph.edges, visibleIds]);
  const visibleGraph = useMemo(() => ({ ...graph, nodes: visibleNodes, edges: visibleEdges }), [graph, visibleEdges, visibleNodes]);
  const selectedView = visibleNodes.find(node => node.id === selectedId) ?? visibleNodes[0] ?? null;
  const selected = selectedView ? data.model.nodes.find(node => node.id === selectedView.id) ?? null : null;
  const incoming = selected ? data.model.edges.filter(edge => edge.targetId === selected.id) : [];
  const outgoing = selected ? data.model.edges.filter(edge => edge.sourceId === selected.id) : [];
  const nodeById = useMemo(() => new Map(data.model.nodes.map(node => [node.id, node])), [data.model.nodes]);

  function toggleCategory(category: string) {
    setCategories(current => current.includes(category) ? current.filter(value => value !== category) : [...current, category]);
  }
  function openNodeSource(node: CcmNode) {
    const range = sourceRange(node.location);
    if (node.filePath && range) setSourceRequest({ filePath: node.filePath, ...range, title: node.qualifiedName, kind: "node" });
  }
  function openEdgeSource(edge: CcmEdge) {
    const evidence = edge.evidence[0];
    if (evidence) setSourceRequest({ filePath: evidence.filePath, startLine: evidence.startLine, endLine: evidence.endLine, title: `${edge.kind} · ${edge.resolution}`, kind: "edge" });
  }
  const closeSource = useCallback(() => setSourceRequest(null), []);

  return <>
    <div className={styles.pageHeading}>
      <p className={styles.eyebrow}>03 / KNOWLEDGE GRAPH</p>
      <h1>Telusuri node dan relasi</h1>
      <p className={styles.muted}>Graph memproyeksikan node dan edge dari fixture CCM yang sudah divalidasi.</p>
    </div>
    <div className={styles.graphSummary}>
      <div><span>Repository</span><strong>{graph.repository}</strong></div>
      <div><span>Branch</span><strong>{graph.branch ?? "Tidak tersedia"}</strong></div>
      <div><span>Snapshot SHA</span><CopySha sha={graph.commitSha} /></div>
      <div><span>Jumlah pada fixture</span><strong>{graph.nodes.length} node · {graph.edges.length} relasi</strong></div>
    </div>
    <div className={styles.graphLayout}>
      <div className={styles.graphMainColumn}>
        <Panel title="Knowledge graph" className={styles.graphPanel}>
          <div className={styles.graphFilters}>
            <label className={styles.searchField}>Cari node<input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Nama, jenis, atau file" /></label>
            <fieldset className={styles.categoryFilters}><legend>Jenis node</legend>{allCategories.map(category => <label key={category}><input type="checkbox" checked={categories.includes(category)} onChange={() => toggleCategory(category)} />{category}</label>)}</fieldset>
            <div className={styles.modeGroup} role="group" aria-label="Mode tampilan graph">
              <button type="button" aria-pressed={mode === "all"} onClick={() => setMode("all")}>Semua relasi</button>
              <button type="button" aria-pressed={mode === "focus"} onClick={() => setMode("focus")}>Fokus node</button>
            </div>
          </div>
          <div className={styles.countLine} aria-live="polite"><strong>{visibleNodes.length} dari {graph.nodes.length} node</strong><span>{visibleEdges.length} dari {graph.edges.length} relasi terlihat</span></div>
          {visibleNodes.length ? <GraphCanvas graph={visibleGraph} selectedId={selected?.id ?? null} onSelect={setSelectedId} /> : <div className={styles.emptyGraph}>Tidak ada node yang cocok dengan pencarian dan kategori.</div>}
          <div className={styles.legend} aria-label="Jenis node">
            {data.model.nodes.reduce<CcmNode[]>((items, node) => items.some(item => item.kind === node.kind) ? items : [...items, node], []).map(node => <span className={styles.legendItem} key={node.kind}><AssetIcon group="graph" name={categoryIcons[node.kind]} />{node.kind}</span>)}
          </div>
          <p className={styles.graphFootnote}>Kontrol fokus hanya menampilkan node terpilih beserta relasi langsung dari model ini.</p>
        </Panel>
        <Panel title="Daftar node" className={styles.nodesPanel}>
          <div className={styles.nodeList} role="group" aria-label="Pilih node untuk melihat detail">
            {visibleNodes.map(node => <button key={node.id} type="button" className={styles.nodeOption} aria-pressed={selected?.id === node.id} onClick={() => setSelectedId(node.id)}>
              <AssetIcon group="graph" name={categoryIcons[node.kind]} />
              <span><strong>{node.name}</strong><small>{node.kind} · {nodeLocation(data.model.nodes.find(item => item.id === node.id)!)}</small></span>
            </button>)}
          </div>
        </Panel>
      </div>
      <aside className={styles.inspector} aria-live="polite">
        <Panel title="Node Inspector">
          {selected ? <>
            <h3 className={styles.inspectorName}>{selected.qualifiedName}</h3>
            <p className={styles.nodeMeta}>{selected.kind} · {selected.language ?? "TypeScript"} · {selected.origin === "unresolved" ? "Belum terpecahkan" : "Source"}</p>
            <dl className={styles.detailGrid}><dt>Lokasi source</dt><dd>{nodeLocation(selected)}</dd><dt>Node ID</dt><dd><code>{selected.id}</code></dd></dl>
            {selected.filePath && selected.location ? <button className={styles.textAction} type="button" onClick={() => openNodeSource(selected)}>Buka bukti deklarasi</button> : <p className={styles.noSource}>Target ini belum memiliki deklarasi source.</p>}
            <RelationList label="Relasi keluar" edges={outgoing} nodeById={nodeById} onOpen={openEdgeSource} />
            <RelationList label="Relasi masuk" edges={incoming} nodeById={nodeById} onOpen={openEdgeSource} />
          </> : <p className={styles.emptyState}>Pilih node untuk melihat bukti langsung dari fixture.</p>}
        </Panel>
      </aside>
    </div>
    {sourceRequest ? <SourceDialog data={data} request={sourceRequest} onClose={closeSource} /> : null}
  </>;
}

function RelationList({ label, edges, nodeById, onOpen }: { label: string; edges: CcmEdge[]; nodeById: Map<string, CcmNode>; onOpen: (edge: CcmEdge) => void }) {
  return <section className={styles.relationSection}>
    <h3>{label} <span>({edges.length})</span></h3>
    {edges.length ? <ul>{edges.map(edge => {
      const relatedId = label === "Relasi keluar" ? edge.targetId : edge.sourceId;
      const related = nodeById.get(relatedId);
      const span = edge.evidence[0];
      return <li key={edge.id}><button type="button" onClick={() => onOpen(edge)}><strong>{related?.qualifiedName ?? relatedId}</strong><span>{edge.kind} · {edge.resolution}</span><small>{span ? `${span.filePath}:${span.startLine}` : "Tanpa bukti source"}</small></button></li>;
    })}</ul> : <p className={styles.emptyRelation}>Tidak ada relasi pada arah ini.</p>}
  </section>;
}

function ProgressScreen({ data }: { data: PreviewData }) {
  const [scenario, setScenario] = useState<ProgressScenario>("running");
  const details = scenarioCopy[scenario];
  const tone = scenarioOptions.find(option => option.value === scenario)!.tone;
  const stageStates: AnalysisStageStatus[] = scenario === "pending"
    ? ANALYSIS_STAGE_DEFINITIONS.map(() => "PENDING")
    : scenario === "running"
      ? ANALYSIS_STAGE_DEFINITIONS.map((_, index) => index < 3 ? "COMPLETED" : index === 3 ? "RUNNING" : "PENDING")
      : scenario === "failed"
        ? ANALYSIS_STAGE_DEFINITIONS.map((_, index) => index < 2 ? "COMPLETED" : index === 2 ? "FAILED" : "PENDING")
        : ANALYSIS_STAGE_DEFINITIONS.map(() => "COMPLETED");
  const stageTone = (status: AnalysisStageStatus): "info" | "success" | "error" | "neutral" => status === "RUNNING" ? "info" : status === "COMPLETED" ? "success" : status === "FAILED" ? "error" : "neutral";
  const stageLabel = (status: AnalysisStageStatus) => status === "RUNNING" ? "Berjalan" : status === "COMPLETED" ? "Selesai" : status === "FAILED" ? "Gagal" : "Menunggu";
  const stageIcon = (status: AnalysisStageStatus) => status === "RUNNING" ? ["progress", "imgIcon2"] : status === "COMPLETED" ? ["progress", "imgIcon3"] : status === "FAILED" ? ["progress-failed", "imgIcon3"] : ["progress", "imgIcon1"];
  return <>
    <div className={styles.pageHeading}>
      <p className={styles.eyebrow}>01 / ANALISIS</p>
      <h1>Progres analisis</h1>
      <p className={styles.muted}>Contoh tampilan status dengan konteks snapshot source yang dapat diperiksa.</p>
    </div>
    <details className={styles.scenarioControls}>
      <summary>Ubah skenario tampilan</summary>
      <p>Perubahan ini hanya mengganti presentasi status. Tidak ada job atau status analisis yang ditulis.</p>
      <div className={styles.scenarioButtons} role="group" aria-label="Skenario status pratinjau">{scenarioOptions.map(option => <button key={option.value} type="button" aria-pressed={scenario === option.value} onClick={() => setScenario(option.value)}>{option.label}</button>)}</div>
    </details>
    <div className={styles.progressGrid}>
      <Panel title="Analysis execution pipeline · skenario ilustratif" className={styles.pipelinePanel}>
        <div className={styles.pipelineIntro}><Badge tone={tone}>{scenarioOptions.find(option => option.value === scenario)!.label}</Badge><p>{details.description}</p></div>
        <ol className={styles.pipelineStages} aria-label="Sembilan tahap pipeline dalam skenario tampilan">
          {ANALYSIS_STAGE_DEFINITIONS.map((stage, index) => {
            const status = stageStates[index];
            const [iconGroup, iconName] = stageIcon(status);
            return <li className={styles.pipelineStage} data-stage-key={stage.key} key={stage.key}>
              <AssetIcon group={iconGroup} name={iconName} />
              <span className={styles.stageCopy}><strong>{stage.label}</strong><code>{stage.key}</code></span>
              <Badge tone={stageTone(status)}>{stageLabel(status)}</Badge>
            </li>;
          })}
        </ol>
        <p className={styles.pipelineDisclaimer}>Tahap dan status di atas hanya skenario UI. Tidak ada eksekusi, durasi, persentase, atau progres tersimpan.</p>
      </Panel>
      <Panel title="Analysis snapshot" className={styles.snapshotPanel}>
        <div className={styles.contextList}><span>Status tampilan</span><Badge tone={tone}>{scenarioOptions.find(option => option.value === scenario)!.label}</Badge><span>Repository</span><strong>{data.model.snapshot.repository}</strong><span>Branch</span><strong>{data.model.snapshot.branch ?? "Tidak tersedia"}</strong><span>Commit · SHA lengkap</span><CopySha sha={data.model.snapshot.commitSha} /><span>ID pratinjau</span><code>fixture-report</code></div>
        <div className={styles.fixtureCounts}><strong>{data.model.nodes.length} node</strong><span>{data.model.edges.length} relasi</span><span>{data.model.files.length} file source</span></div>
        {scenario === "failed" ? <div className={styles.stateMessage} role="status"><AssetIcon group="progress-failed" name="imgIcon3" />Status kegagalan ditampilkan sebagai contoh; fixture tidak menyediakan penyebab error.</div> : null}
        {scenario === "limitations" ? <div className={styles.stateMessage} role="status"><AssetIcon group="progress-complete" name="imgIcon2" />Status batasan hanya presentasi; CCM fixture tidak menyertakan rincian limitation.</div> : null}
        {scenario === "completed" ? <div className={styles.stateMessage} role="status"><AssetIcon group="progress-complete" name="imgIcon" />CCM fixture lolos validasi kontrak dan evidence.</div> : null}
        <Link className={styles.primaryAction} href="/preview/graph?analysis=fixture-report">Buka graph fixture</Link>
        <Link className={styles.secondaryAction} href="/preview/history">Lihat riwayat pratinjau</Link>
      </Panel>
    </div>
  </>;
}

function HistoryScreen({ data }: { data: PreviewData }) {
  const [scenario, setScenario] = useState<HistoryScenario>("ready");
  const [query, setQuery] = useState("");
  const snapshot = data.model.snapshot;
  const searchText = `${snapshot.repository} ${snapshot.branch ?? ""} ${snapshot.commitSha}`.toLowerCase();
  const matches = !query.trim() || searchText.includes(query.trim().toLowerCase());
  return <>
    <div className={styles.pageHeading}>
      <p className={styles.eyebrow}>02 / RIWAYAT</p>
      <h1>Riwayat pratinjau</h1>
      <p className={styles.muted}>Fixture memuat satu snapshot source tervalidasi. Ini bukan daftar hasil analisis yang tersimpan.</p>
    </div>
    <details className={styles.scenarioControls}>
      <summary>Ubah skenario tampilan</summary>
      <p>Memilih keadaan layar contoh; tidak ada pemanggilan API atau data riwayat yang dibuat.</p>
      <div className={styles.scenarioButtons} role="group" aria-label="Skenario riwayat pratinjau">
        {(["ready", "loading", "empty", "error"] as HistoryScenario[]).map(value => <button key={value} type="button" aria-pressed={scenario === value} onClick={() => setScenario(value)}>{({ ready: "Data fixture", loading: "Memuat", empty: "Kosong", error: "Error" })[value]}</button>)}
      </div>
    </details>
    <Panel title="Snapshot source" className={styles.historyPanel}>
      <label className={styles.searchField}>Cari repository, branch, atau SHA<input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Contoh: report-service" /></label>
      <div className={styles.historyColumns} aria-hidden="true"><span>Repository dan commit</span><span>Branch</span><span>Isi fixture</span><span>Aksi</span></div>
      {scenario === "loading" ? <div className={styles.loadingRows} role="status" aria-label="Memuat contoh riwayat">{[0, 1].map(row => <div key={row}><span /><span /><span /></div>)}</div> : null}
      {scenario === "error" ? <div className={styles.historyMessage} role="alert"><AssetIcon group="history-error" name="imgIcon2" /><div><strong>Contoh tampilan saat riwayat gagal dimuat</strong><p>Tidak ada request yang dikirim. Fixture lokal tetap dapat dibuka melalui layar graph.</p></div></div> : null}
      {scenario === "empty" ? <div className={styles.historyMessage}><AssetIcon group="history-empty" name="imgIcon1" /><div><strong>Belum ada snapshot untuk ditampilkan</strong><p>Ini keadaan layar kosong contoh; fixture satu snapshot masih tersedia pada opsi Data fixture.</p></div></div> : null}
      {scenario === "ready" && matches ? <div className={styles.historyRow}>
        <div><strong>{snapshot.repository}</strong><span className={styles.shaShort}>{snapshot.commitSha.slice(0, 7)}</span><small>{data.model.files.length} file · {data.model.nodes.length} node · {data.model.edges.length} relasi</small></div>
        <code>{snapshot.branch ?? "—"}</code>
        <Badge tone="info">Fixture tervalidasi</Badge>
        <Link href="/preview/graph?analysis=fixture-report">Lihat graph</Link>
      </div> : null}
      {scenario === "ready" && !matches ? <div className={styles.historyMessage}><AssetIcon group="history-empty" name="imgIcon" /><div><strong>Tidak ada hasil untuk “{query.trim()}”</strong><p>Pencarian memeriksa repository, branch, dan SHA dari snapshot fixture.</p></div><button type="button" className={styles.textAction} onClick={() => setQuery("")}>Hapus pencarian</button></div> : null}
    </Panel>
    <p className={styles.historyFootnote}>Status loading, kosong, dan error tersedia untuk meninjau layout saja. Seluruh isi tetap bersumber dari fixture ini.</p>
  </>;
}

export function PreviewClient({ screen, data }: { screen: Screen; data: PreviewData }) {
  return <DesignFrame active={screen === "history" ? "history" : "none"} preview>
    <div className={styles.breadcrumb}>Workspace <span>/</span> {screen === "graph" ? "Knowledge Graph" : screen === "history" ? "Riwayat" : "Progres analisis"}</div>
    {screen === "progress" ? <ProgressScreen data={data} /> : screen === "history" ? <HistoryScreen data={data} /> : <GraphScreen data={data} />}
  </DesignFrame>;
}
