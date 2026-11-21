"use client";

import Link from "next/link";
import { AnalysisNavigation } from "../analysis-navigation/analysis-navigation.tsx";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { NODE_KINDS } from "@sage/contracts/registries";
import type { NodeKind } from "@sage/contracts";
import type { GraphPayload } from "../../lib/graphs/types.ts";
import { GraphCanvas } from "../graph-foundation/knowledge-graph.tsx";
import type { GraphMode } from "./graph-modes.ts";
import { ESSENTIAL_RENDER_LIMITS, GRAPH_RENDER_LIMITS, projectGraphMode } from "./graph-modes.ts";
import { filterGraph } from "./graph-filters.ts";
import { parseLiveGraphPayload } from "./graph-data.ts";
import { AnalysisQuality } from "../analysis-quality/analysis-quality.tsx";
import { NodeInspector } from "./node-inspector.tsx";
import { AssetIcon, Button, EmptyState, Field, MaskIcon, PillButton, SkeletonRows } from "../design-system/ui.tsx";
import styles from "../graph-foundation/graph-foundation.module.css";

type RequestError = { status: number | null; message: string };
type SessionIdentity = { accountKey?: string };

const modes: { id: GraphMode; label: string }[] = [
  { id: "essential", label: "Esensial" },
  { id: "overview", label: "Detail AST" },
  { id: "focus", label: "Fokus node" },
  { id: "all-references", label: "Semua referensi" },
];

const ERROR_ICON = { group: "repository", name: "imgRepo" } as const;
const SEARCH_ICON = { group: "repository", name: "imgSearch" } as const;

function responseMessage(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const error = (value as { error?: unknown }).error;
  if (!error || typeof error !== "object" || Array.isArray(error)) return null;
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" ? message : null;
}

export function LiveGraphClient({ analysisId, accountKey }: { analysisId: string; accountKey: string }) {
  const [payload, setPayload] = useState<GraphPayload | null>(null);
  const [verifiedIdentity, setVerifiedIdentity] = useState<{ analysisId: string; accountKey: string } | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<RequestError | null>(null);
  const [mode, setMode] = useState<GraphMode>("essential");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selectedKinds, setSelectedKinds] = useState<NodeKind[]>([]);
  const nodePickerRef = useRef<HTMLSelectElement>(null);
  const generation = useRef(0);
  const graphController = useRef<AbortController | null>(null);
  const sessionController = useRef<AbortController | null>(null);
  const refreshRef = useRef<(() => void) | null>(null);
  const fullCheckRunning = useRef(false);
  const reloadStarted = useRef(false);

  useEffect(() => {
    let active = true;
    let periodicCheckRunning = false;

    function headers() {
      return { "X-SAGE-Account": accountKey };
    }

    function reloadCurrentPage() {
      if (reloadStarted.current) return;
      reloadStarted.current = true;
      generation.current += 1;
      abortCurrentRequests();
      setVerifiedIdentity(null);
      setPayload(null);
      setSelectedId(null);
      window.location.replace(`${window.location.pathname}${window.location.search}`);
    }

    function redirectToLogin() {
      if (reloadStarted.current) return;
      reloadStarted.current = true;
      generation.current += 1;
      abortCurrentRequests();
      setVerifiedIdentity(null);
      setPayload(null);
      setSelectedId(null);
      window.location.replace("/login?error=session");
    }

    function abortCurrentRequests() {
      graphController.current?.abort();
      graphController.current = null;
      sessionController.current?.abort();
      sessionController.current = null;
    }

    function isCurrent(requestGeneration: number) {
      return active && generation.current === requestGeneration;
    }

    async function checkSession(requestGeneration: number): Promise<SessionIdentity | null> {
      const controller = new AbortController();
      sessionController.current = controller;
      try {
        setVerifiedIdentity(null);
        const response = await fetch("/api/auth/session", {
          headers: headers(),
          cache: "no-store",
          credentials: "same-origin",
          signal: controller.signal,
        });
        if (!isCurrent(requestGeneration)) return null;
        if (response.status === 401) {
          reloadCurrentPage();
          return null;
        }
        if (!response.ok) throw new Error("Sesi belum dapat diperiksa. Coba lagi.");
        const body = await response.json() as { data?: SessionIdentity };
        if (!isCurrent(requestGeneration)) return null;
        if (body.data?.accountKey !== accountKey) {
          setVerifiedIdentity(null);
          reloadCurrentPage();
          return null;
        }
        setVerifiedIdentity({ analysisId, accountKey });
        return body.data;
      } finally {
        if (sessionController.current === controller) sessionController.current = null;
      }
    }

    async function loadGraph(requestGeneration: number) {
      const controller = new AbortController();
      graphController.current = controller;
      try {
        const response = await fetch(`/api/analyses/${encodeURIComponent(analysisId)}/graph`, {
          headers: headers(),
          cache: "no-store",
          credentials: "same-origin",
          signal: controller.signal,
        });
        if (!isCurrent(requestGeneration)) return;
        if (response.status === 401) {
          setVerifiedIdentity(null);
          setPayload(null);
          setSelectedId(null);
          const identity = await checkSession(requestGeneration);
          if (identity && isCurrent(requestGeneration)) {
            redirectToLogin();
          }
          return;
        }
        if (!response.ok) {
          let message: string | null = null;
          try { message = responseMessage(await response.json()); } catch { /* Keep the status-specific message. */ }
          if (!isCurrent(requestGeneration)) return;
          if (response.status !== 503) setVerifiedIdentity(null);
          setPayload(null);
          setSelectedId(null);
          setError({ status: response.status, message: message ?? "Graph belum dapat dimuat. Coba lagi." });
          return;
        }
        const body = await response.json() as { data?: unknown };
        if (!isCurrent(requestGeneration)) return;
        const validated = parseLiveGraphPayload(body.data, analysisId, accountKey);
        setPayload(validated);
        setSelectedId((previous) => previous && validated.graph.nodes.some((node) => node.id === previous) ? previous : null);
        setError(null);
      } catch (cause) {
        if (!isCurrent(requestGeneration) || (cause instanceof DOMException && cause.name === "AbortError")) return;
        setPayload(null);
        setSelectedId(null);
        setError({ status: null, message: cause instanceof Error ? cause.message : "Graph belum dapat dimuat. Coba lagi." });
      } finally {
        if (isCurrent(requestGeneration)) setBusy(false);
        if (graphController.current === controller) graphController.current = null;
      }
    }

    async function refreshAfterIdentityCheck() {
      if (!active || reloadStarted.current) return;
      fullCheckRunning.current = true;
      const requestGeneration = ++generation.current;
      abortCurrentRequests();
      setPayload(null);
      setVerifiedIdentity(null);
      setSelectedId(null);
      setError(null);
      setBusy(true);
      try {
        const identity = await checkSession(requestGeneration);
        if (identity && isCurrent(requestGeneration)) await loadGraph(requestGeneration);
      } catch (cause) {
        if (isCurrent(requestGeneration) && !(cause instanceof DOMException && cause.name === "AbortError")) {
          setPayload(null);
          setSelectedId(null);
          setError({ status: null, message: cause instanceof Error ? cause.message : "Sesi belum dapat diperiksa. Coba lagi." });
        }
      } finally {
        if (isCurrent(requestGeneration)) {
          fullCheckRunning.current = false;
          setBusy(false);
        }
      }
    }
    refreshRef.current = () => { void refreshAfterIdentityCheck(); };

    async function verifyIdentityPeriodically() {
      if (!active || reloadStarted.current || periodicCheckRunning || fullCheckRunning.current || document.visibilityState !== "visible") return;
      periodicCheckRunning = true;
      const requestGeneration = generation.current;
      const controller = new AbortController();
      sessionController.current = controller;
      try {
        // Keep the verified canvas mounted during routine checks to preserve layout and zoom.
        // Any mismatch or failed check below still clears the owner-bound payload.
        const response = await fetch("/api/auth/session", {
          headers: headers(), cache: "no-store", credentials: "same-origin", signal: controller.signal,
        });
        if (!isCurrent(requestGeneration)) return;
        if (response.status === 401) {
          setVerifiedIdentity(null);
          setPayload(null);
          setSelectedId(null);
          reloadCurrentPage();
          return;
        }
        if (!response.ok) throw new Error("Sesi belum dapat diperiksa. Coba lagi.");
        const body = await response.json() as { data?: SessionIdentity };
        if (!isCurrent(requestGeneration)) return;
        if (body.data?.accountKey !== accountKey) {
          setVerifiedIdentity(null);
          setPayload(null);
          setSelectedId(null);
          reloadCurrentPage();
        } else {
          setVerifiedIdentity({ analysisId, accountKey });
        }
      } catch (cause) {
        if (!isCurrent(requestGeneration) || (cause instanceof DOMException && cause.name === "AbortError")) return;
        setPayload(null);
        setVerifiedIdentity(null);
        setSelectedId(null);
        setError({ status: null, message: cause instanceof Error ? cause.message : "Sesi belum dapat diperiksa. Coba lagi." });
      } finally {
        periodicCheckRunning = false;
        if (sessionController.current === controller) sessionController.current = null;
      }
    }

    void refreshAfterIdentityCheck();
    const interval = window.setInterval(() => void verifyIdentityPeriodically(), 15_000);
    const onFocus = () => { if (document.visibilityState === "visible") void refreshAfterIdentityCheck(); };
    const onPageShow = () => void refreshAfterIdentityCheck();
    const onVisibility = () => { if (document.visibilityState === "visible") void refreshAfterIdentityCheck(); };
    window.addEventListener("focus", onFocus);
    window.addEventListener("pageshow", onPageShow);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      active = false;
      generation.current += 1;
      fullCheckRunning.current = false;
      refreshRef.current = null;
      window.clearInterval(interval);
      abortCurrentRequests();
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("pageshow", onPageShow);
      document.removeEventListener("visibilitychange", onVisibility);
    };
    // The server-rendered identity defines the scope of this client page.
  }, [analysisId, accountKey]);

  const identityVerified = verifiedIdentity?.analysisId === analysisId && verifiedIdentity.accountKey === accountKey;
  const visiblePayload = identityVerified && payload?.analysisId === analysisId && payload.accountKey === accountKey ? payload : null;
  const filterResult = useMemo(() => visiblePayload ? filterGraph(visiblePayload.graph, query, selectedKinds) : null, [visiblePayload, query, selectedKinds]);
  const projectionFocusId = mode === "focus" ? selectedId : null;
  const projection = useMemo(() => {
    if (!filterResult) return null;
    const focusId = projectionFocusId && filterResult.graph.nodes.some((node) => node.id === projectionFocusId) ? projectionFocusId : null;
    return projectGraphMode(filterResult.graph, mode, focusId);
  }, [filterResult, mode, projectionFocusId]);
  const renderLimits = mode === "essential" ? ESSENTIAL_RENDER_LIMITS : GRAPH_RENDER_LIMITS;
  const canonicalCounts = visiblePayload?.canonicalCounts ?? null;
  const availableKinds = useMemo(() => {
    if (!visiblePayload) return [];
    const presentKinds = new Set(visiblePayload.graph.nodes.map((node) => node.kind));
    return NODE_KINDS.filter((kind) => presentKinds.has(kind));
  }, [visiblePayload]);

  function chooseNode(id: string) {
    setSelectedId(id || null);
    setMode("focus");
  }

  function openProjectionAnchor() {
    if (projection?.anchorId) setSelectedId(projection.anchorId);
  }

  function closeInspector() {
    setSelectedId(null);
    requestAnimationFrame(() => nodePickerRef.current?.focus());
  }

  const handleInspectorIdentityFailure = useCallback(() => {
    setPayload(null);
    setVerifiedIdentity(null);
    setSelectedId(null);
    refreshRef.current?.();
  }, []);

  function retainSelectedMatch(nextQuery: string, nextKinds: readonly NodeKind[]) {
    if (!selectedId || !payload) return;
    if (!filterGraph(payload.graph, nextQuery, nextKinds).graph.nodes.some((node) => node.id === selectedId)) setSelectedId(null);
  }

  function updateQuery(nextQuery: string) {
    retainSelectedMatch(nextQuery, selectedKinds);
    setQuery(nextQuery);
  }

  function toggleKind(kind: NodeKind) {
    const nextKinds = selectedKinds.includes(kind) ? selectedKinds.filter((value) => value !== kind) : [...selectedKinds, kind];
    retainSelectedMatch(query, nextKinds);
    setSelectedKinds(nextKinds);
  }

  function resetFilters() {
    setQuery("");
    setSelectedKinds([]);
  }

  function errorContent() {
    if (!error) return null;
    const retry = <Button variant="secondary" onClick={() => refreshRef.current?.()}>Coba lagi</Button>;
    if (error.status === 404) return <EmptyState tone="error" role="alert" icon={ERROR_ICON} title="Analisis tidak ditemukan.">Graph ini tidak tersedia untuk akun yang sedang aktif.</EmptyState>;
    if (error.status === 409) return <EmptyState role="alert" icon={ERROR_ICON} title="Graph belum tersedia." action={<><Button href={`/analyses/${encodeURIComponent(analysisId)}`} variant="secondary" arrow>Kembali ke progres analisis</Button>{retry}</>}>{error.message} Selesaikan analisis terlebih dahulu, lalu buka kembali graph.</EmptyState>;
    if (error.status === 503) return <EmptyState tone="error" role="alert" icon={ERROR_ICON} title="Code Knowledge sementara tidak tersedia." action={retry}>{error.message}</EmptyState>;
    return <EmptyState tone="error" role="alert" icon={ERROR_ICON} title="Code Knowledge tidak dapat dimuat." action={retry}>{error.message}</EmptyState>;
  }

  const documentHref = `/analyses/${encodeURIComponent(analysisId)}/document`;
  const kindCounts = new Map<NodeKind, number>();
  for (const node of visiblePayload?.graph.nodes ?? []) kindCounts.set(node.kind, (kindCounts.get(node.kind) ?? 0) + 1);
  const graphLegend = <div className={styles.legend} aria-label="Kategori node dan jenis relasi">
    <span className={styles.legendItem}><i className={`${styles.categoryMark} ${styles.categoryFile}`} aria-hidden="true" />Berkas</span>
    <span className={styles.legendItem}><i className={`${styles.categoryMark} ${styles.categoryStructure}`} aria-hidden="true" />Struktur</span>
    <span className={styles.legendItem}><i className={`${styles.categoryMark} ${styles.categorySymbol}`} aria-hidden="true" />Simbol</span>
    <span className={styles.legendItem}><i className={`${styles.categoryMark} ${styles.categoryUnresolved}`} aria-hidden="true" />Belum terpecahkan</span>
    <span className={styles.legendDivider} aria-hidden="true" />
    <span className={styles.legendItem}><i className={styles.exactMark} aria-hidden="true" />Exact</span>
    <span className={styles.legendItem}><i className={styles.unresolvedMark} aria-hidden="true" />Unresolved</span>
  </div>;
  const filtersActive = Boolean(query) || selectedKinds.length > 0;
  const emptyMessage = !visiblePayload || !filterResult || !projection ? null
    : visiblePayload.graph.nodes.length === 0 ? "Graph tidak memiliki node untuk ditampilkan."
      : filterResult.graph.nodes.length === 0 ? "Tidak ada node yang sesuai dengan kueri dan jenis node yang dipilih."
        : projection.graph.nodes.length === 0 ? "Mode ini tidak memiliki node untuk ditampilkan." : null;
  const showInspector = Boolean(visiblePayload && filterResult && selectedId && filterResult.graph.nodes.some((node) => node.id === selectedId));

  return <div className={styles.graphShell}>
    <AnalysisNavigation analysisId={analysisId} active="graph" />
    {/* h1 berada di page head bersama (nama repo); judul tab menjadi h2. */}
    <header className={styles.tabHead}>
      <div className={styles.tabHeadCopy}>
        <p className={styles.label}>Code Knowledge</p>
        <h2>Struktur source code</h2>
        <p className={styles.lead}>Telusuri module, symbol, dependency, dan bukti pada source code di commit yang dianalisis.</p>
      </div>
      {visiblePayload ? <Button href={documentHref} variant="secondary" arrow>Buka dokumen TOGAF ADD</Button> : null}
    </header>

    {!visiblePayload && (busy || payload) ? <div className={styles.workspace}>
      <section className={styles.graphCard} aria-label="Memuat knowledge graph">
        <SkeletonRows rows={1} label="Memeriksa akun dan memuat knowledge graph…" />
        <div className={styles.canvasSkeleton} aria-hidden="true" />
      </section>
      <aside className={styles.inspectorRail} aria-hidden="true">
        <div className={styles.inspectorPlaceholder}><div className={styles.lineSkeleton} /><div className={styles.lineSkeleton} /><div className={styles.blockSkeleton} /></div>
      </aside>
    </div> : null}
    {error && !visiblePayload ? <section className={styles.stateCard}>{errorContent()}</section> : null}

    {visiblePayload && filterResult && projection && canonicalCounts ? <>
      <div className={styles.workspace}>
        <section className={styles.graphCard} aria-label="Knowledge graph analisis">
          <div className={styles.graphCardHeader}>
            <h3>Knowledge graph</h3>
            <p className={styles.repositoryPath}>{visiblePayload.graph.repository}<span aria-hidden="true"> · </span>{visiblePayload.graph.branch ?? "branch tidak diketahui"}</p>
          </div>

          <div className={styles.toolbar}>
            <section className={styles.filterControls} aria-label="Pencarian dan filter node">
              <Field id="graph-node-query" className={styles.searchField} label="Cari node" hideLabel type="search" icon={<MaskIcon group="repository" name="imgSearch" size={18} />} value={query} onChange={(event) => updateQuery(event.target.value)} placeholder="Cari node, berkas, atau simbol" aria-describedby="graph-node-query-help" />
              {/* <details> asli mengatur buka/tutup (keyboard, atribut open); panel saudara ditampilkan lewat CSS [open] ~ panel agar selebar toolbar. */}
              <details className={styles.kindDisclosure} data-testid="graph-kind-filters-disclosure">
                <summary aria-controls="graph-kind-panel">Filter jenis node AST{selectedKinds.length ? ` · ${selectedKinds.length} dipilih` : ""}</summary>
              </details>
              <Button variant="secondary" className={styles.resetButton} onClick={resetFilters} disabled={!filtersActive}>Atur ulang filter</Button>
              <div id="graph-kind-panel" className={styles.kindPopover}>
                <p id="graph-node-query-help" className={styles.filterHelp}>Pencarian cocok dengan teks di nama, jenis node, nama lengkap, atau path berkas.</p>
                <fieldset className={styles.kindFilters}>
                  <legend>Jenis node AST</legend>
                  {availableKinds.length ? availableKinds.map((kind) => <label key={kind}>
                    <input type="checkbox" checked={selectedKinds.includes(kind)} onChange={() => toggleKind(kind)} />
                    {/* Jumlah node per jenis lewat CSS (data-count) agar teks label tetap persis nama jenis. */}
                    <span className={styles.kindName} data-count={kindCounts.get(kind) ?? 0}>{kind}</span>
                  </label>) : <p className={styles.filterHelp}>Graph tidak memiliki jenis node untuk difilter.</p>}
                </fieldset>
              </div>
            </section>

            <section className={styles.modeControls} aria-label="Mode graph">
              <div className={styles.modeButtons}>
                {modes.map((item) => <PillButton key={item.id} pressed={mode === item.id} onClick={() => setMode(item.id)}>{item.label}</PillButton>)}
              </div>
              <div className={styles.nodePickerControls}>
                <Field id="graph-node-picker" className={styles.nodePickerField} label="Pilih node fokus" hideLabel trailing={<AssetIcon group="header" name="imgIconChevronDown" />}>
                  <select id="graph-node-picker" ref={nodePickerRef} aria-label="Pilih node fokus" data-testid="graph-node-picker" value={selectedId ?? projection.anchorId ?? ""} onChange={(event) => chooseNode(event.target.value)}>
                    {!projection.anchorId ? <option value="">Graph tidak memiliki node</option> : null}
                    {[...filterResult.graph.nodes].sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0) || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)).map((node) => <option key={node.id} value={node.id}>{node.name} · {node.kind}</option>)}
                  </select>
                </Field>
                <Button variant="secondary" data-testid="open-node-inspector" onClick={openProjectionAnchor} disabled={!projection.anchorId} aria-expanded={selectedId === projection.anchorId}>Buka inspector node</Button>
              </div>
            </section>
          </div>

          {busy ? <p className={styles.inlineStatus} role="status">Memeriksa akun sebelum memuat ulang graph…</p> : null}
          {emptyMessage ? <EmptyState
            role="status"
            icon={visiblePayload.graph.nodes.length === 0 ? ERROR_ICON : SEARCH_ICON}
            action={filtersActive ? <Button variant="secondary" onClick={resetFilters} aria-label="Atur ulang filter dan kueri">Atur ulang filter</Button> : undefined}
          >{emptyMessage}</EmptyState> : null}
          {/* Saat kosong: legend + region kanvas disembunyikan (hidden), tetap di DOM; kontrol zoom tetap ada dan nonaktif. */}
          <div className={styles.canvasBlock}>
            <div hidden={Boolean(emptyMessage)}>{graphLegend}</div>
            <GraphCanvas graph={projection.graph} selectedId={selectedId} onSelect={setSelectedId} collapsed={Boolean(emptyMessage)} />
          </div>

          <section className={styles.graphCounts} role="group" aria-label="Ringkasan jumlah graph">
            <div className={styles.countLine}>
              <p data-testid="visible-counts">{mode === "essential" ? "Tampilan proyeksi esensial" : "Tampilan"}: {projection.visibleCounts.nodes} node · {projection.visibleCounts.edges} relasi</p>
              <p data-testid="canonical-counts">Kanonik: {canonicalCounts.nodes} node · {canonicalCounts.edges} relasi</p>
            </div>
            <details className={styles.compactGraphDetails}>
              <summary>Rincian jumlah dan filter</summary>
              <p className={styles.countDetails}>CONTAINS {canonicalCounts.containmentEdges} · Referensi {canonicalCounts.referenceEdges} · Exact {canonicalCounts.exactEdges} · Unresolved {canonicalCounts.unresolvedEdges}</p>
              <p data-testid="query-filter-counts" aria-live="polite">Hasil pencarian dan jenis node: {filterResult.counts.nodes} node · {filterResult.counts.edges} relasi</p>
              <p data-testid="filtered-counts">{mode === "essential" ? "Proyeksi esensial" : "Hasil mode"}: {projection.filteredCounts.nodes} node · {projection.filteredCounts.edges} relasi</p>
              <p className={styles.countDetails}>{mode === "essential" ? "Proyeksi esensial" : "Hasil mode"} · CONTAINS {projection.filteredCounts.containmentEdges} · Referensi {projection.filteredCounts.referenceEdges} · Exact {projection.filteredCounts.exactEdges} · Unresolved {projection.filteredCounts.unresolvedEdges}</p>
              <p className={styles.countDetails}>Tampilan · CONTAINS {projection.visibleCounts.containmentEdges} · Referensi {projection.visibleCounts.referenceEdges} · Exact {projection.visibleCounts.exactEdges} · Unresolved {projection.visibleCounts.unresolvedEdges}</p>
            </details>
            {mode === "essential" ? <p className={styles.projectionNote} role="note">Esensial merangkum source Module, Class, Interface, dan fungsi tingkat atas. Metode/properti diringkas ke pemilik; relasi Exact lintas pemilik digabung. “Detail AST” membuka deklarasi kanonik dengan batas render yang ditampilkan.</p> : null}
            {projection.omittedCounts.nodes > 0 || projection.omittedCounts.edges > 0 ? <p className={styles.subsetNotice} role="note">Batas render antarmuka: maksimal {renderLimits.nodes} node dan {renderLimits.edges} relasi. Mode ini memuat {projection.visibleCounts.nodes} dari {projection.filteredCounts.nodes} node dan {projection.visibleCounts.edges} dari {projection.filteredCounts.edges} relasi.</p> : null}
          </section>
          <AnalysisQuality edges={visiblePayload.graph.edges} />
          <p className={styles.modeDescription} aria-live="polite">
            {mode === "essential" ? "Esensial menampilkan ringkasan node arsitektural dan dependency Exact lintas pemilik." : null}
            {mode === "overview" ? "Detail AST menampilkan node kanonik sebagai jaringan. Relasi CONTAINS menjadi garis titik-titik; arahkan pointer ke node untuk melihat jenis relasi lainnya." : null}
            {mode === "focus" ? "Fokus menampilkan node terpilih, tetangga langsung, dan relasi yang bersentuhan dengan node terpilih." : null}
            {mode === "all-references" ? "Semua referensi menampilkan endpoint dari relasi selain CONTAINS, termasuk referensi yang belum terpecahkan." : null}
          </p>
        </section>

        {/* Panel detail: sticky di kanan (≥1060 px), di bawah graph pada layar sempit. Dipasang ulang per node → animasi masuk. */}
        <aside className={styles.inspectorRail} aria-label="Detail node">
          {showInspector && visiblePayload && selectedId ? <NodeInspector
            key={`${analysisId}:${accountKey}:${visiblePayload.ckgSha256}:${visiblePayload.configurationHash}:${visiblePayload.snapshot.repository}:${visiblePayload.snapshot.branch ?? ""}:${visiblePayload.snapshot.commitSha}:${selectedId}`}
            analysisId={analysisId}
            accountKey={accountKey}
            ckgSha256={visiblePayload.ckgSha256}
            configurationHash={visiblePayload.configurationHash}
            snapshot={visiblePayload.snapshot}
            nodeId={selectedId}
            onClose={closeInspector}
            onIdentityFailure={handleInspectorIdentityFailure}
          /> : <div className={styles.inspectorPlaceholder}>
            <p className={styles.label}>Inspector</p>
            <p className={styles.placeholderText}>Pilih node di kanvas atau lewat daftar “Pilih node fokus” untuk melihat jenis, lokasi deklarasi, relasi langsung, dan bukti source.</p>
          </div>}
        </aside>
      </div>
      <p className={styles.liveGraphFooter}><Link href={`/analyses/${encodeURIComponent(analysisId)}`}>Kembali ke progres analisis</Link></p>
    </> : null}
  </div>;
}
