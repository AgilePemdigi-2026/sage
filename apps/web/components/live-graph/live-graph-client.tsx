"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { NODE_KINDS } from "@sage/contracts";
import type { NodeKind } from "@sage/contracts";
import type { GraphPayload } from "../../lib/graphs/types.ts";
import { GraphCanvas } from "../graph-foundation/knowledge-graph.tsx";
import type { GraphMode } from "./graph-modes.ts";
import { projectGraphMode } from "./graph-modes.ts";
import { filterGraph } from "./graph-filters.ts";
import { parseLiveGraphPayload } from "./graph-data.ts";
import { NodeInspector } from "./node-inspector.tsx";
import styles from "../graph-foundation/graph-foundation.module.css";
import ui from "../ui-foundation/ui-foundation.module.css";

type RequestError = { status: number | null; message: string };
type SessionIdentity = { accountKey?: string };

const modes: { id: GraphMode; label: string }[] = [
  { id: "overview", label: "Ikhtisar" },
  { id: "focus", label: "Fokus node" },
  { id: "all-references", label: "Semua referensi" },
];

function responseMessage(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const error = (value as { error?: unknown }).error;
  if (!error || typeof error !== "object" || Array.isArray(error)) return null;
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" ? message : null;
}

export function LiveGraphClient({ analysisId, accountKey }: { analysisId: string; accountKey: string }) {
  const [payload, setPayload] = useState<GraphPayload | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<RequestError | null>(null);
  const [mode, setMode] = useState<GraphMode>("overview");
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
      setPayload(null);
      setSelectedId(null);
      window.location.replace(`${window.location.pathname}${window.location.search}`);
    }

    function redirectToLogin() {
      if (reloadStarted.current) return;
      reloadStarted.current = true;
      generation.current += 1;
      abortCurrentRequests();
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
          reloadCurrentPage();
          return null;
        }
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
        const response = await fetch("/api/auth/session", {
          headers: headers(), cache: "no-store", credentials: "same-origin", signal: controller.signal,
        });
        if (!isCurrent(requestGeneration)) return;
        if (response.status === 401) {
          setPayload(null);
          setSelectedId(null);
          reloadCurrentPage();
          return;
        }
        if (!response.ok) throw new Error("Sesi belum dapat diperiksa. Coba lagi.");
        const body = await response.json() as { data?: SessionIdentity };
        if (!isCurrent(requestGeneration)) return;
        if (body.data?.accountKey !== accountKey) {
          setPayload(null);
          setSelectedId(null);
          reloadCurrentPage();
        }
      } catch (cause) {
        if (!isCurrent(requestGeneration) || (cause instanceof DOMException && cause.name === "AbortError")) return;
        setPayload(null);
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

  const visiblePayload = payload?.analysisId === analysisId && payload.accountKey === accountKey ? payload : null;
  const filterResult = useMemo(() => visiblePayload ? filterGraph(visiblePayload.graph, query, selectedKinds) : null, [visiblePayload, query, selectedKinds]);
  const projectionFocusId = mode === "focus" ? selectedId : null;
  const projection = useMemo(() => {
    if (!filterResult) return null;
    const focusId = projectionFocusId && filterResult.graph.nodes.some((node) => node.id === projectionFocusId) ? projectionFocusId : null;
    return projectGraphMode(filterResult.graph, mode, focusId);
  }, [filterResult, mode, projectionFocusId]);
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
    if (error.status === 404) return <div className={`${ui.notice} ${ui.error}`} role="alert"><strong>Analisis tidak ditemukan.</strong><p>Graph ini tidak tersedia untuk akun yang sedang aktif.</p></div>;
    if (error.status === 409) return <div className={`${ui.notice} ${ui.warning}`} role="alert"><strong>Graph belum tersedia.</strong><p>{error.message} Selesaikan analisis terlebih dahulu, lalu buka kembali graph.</p><p className={ui.noticeAction}><Link href={`/analyses/${encodeURIComponent(analysisId)}`}>Kembali ke progres analisis</Link></p><button type="button" className={styles.graphControl} onClick={() => refreshRef.current?.()}>Coba lagi</button></div>;
    if (error.status === 503) return <div className={`${ui.notice} ${ui.error}`} role="alert"><strong>Graph sementara tidak dapat dibaca.</strong><p>{error.message}</p><button type="button" className={styles.graphControl} onClick={() => refreshRef.current?.()}>Coba lagi</button></div>;
    return <div className={`${ui.notice} ${ui.error}`} role="alert"><strong>Graph belum dapat dimuat.</strong><p>{error.message}</p><button type="button" className={styles.graphControl} onClick={() => refreshRef.current?.()}>Coba lagi</button></div>;
  }

  return <div className={styles.graphShell}>
    <div className={ui.pageHeading}>
      <p className={ui.eyebrow}>KNOWLEDGE GRAPH</p>
      <h1>Jelajahi relasi antar simbol</h1>
      <p className={ui.muted}>Jelajahi jaringan kode, pilih simbol, lalu telusuri file sumbernya.</p>
    </div>

    {!visiblePayload && (busy || payload) ? <p className={ui.loading} role="status">Memeriksa akun dan memuat knowledge graph…</p> : null}
    {errorContent()}

    {visiblePayload && filterResult && projection && canonicalCounts ? <>
      <section className={styles.graphCard} aria-label="Knowledge graph analisis">
        <div className={styles.graphCardHeader}>
          <div>
            <h2>Snapshot analisis</h2>
            <p className={styles.repositoryPath}>{visiblePayload.graph.repository}<span aria-hidden="true"> · </span>{visiblePayload.graph.branch ?? "branch tidak diketahui"}</p>
          </div>

        </div>

        <div className={styles.legend} aria-label="Kategori node dan jenis relasi">
          <div className={styles.categoryLegend}>
            <span className={styles.legendItem}><i className={`${styles.categoryMark} ${styles.categoryFile}`} aria-hidden="true" />Berkas</span>
            <span className={styles.legendItem}><i className={`${styles.categoryMark} ${styles.categoryStructure}`} aria-hidden="true" />Struktur</span>
            <span className={styles.legendItem}><i className={`${styles.categoryMark} ${styles.categorySymbol}`} aria-hidden="true" />Simbol</span>
            <span className={styles.legendItem}><i className={`${styles.categoryMark} ${styles.categoryUnresolved}`} aria-hidden="true" />Belum terpecahkan</span>
          </div>
          <div className={styles.edgeLegend}>
            <span className={styles.legendItem}><i className={styles.exactMark} aria-hidden="true" />Exact</span>
            <span className={styles.legendItem}><i className={styles.unresolvedMark} aria-hidden="true" />Unresolved</span>
          </div>
        </div>

        <section className={styles.filterControls} aria-label="Pencarian dan filter node">
          <label className={styles.searchLabel} htmlFor="graph-node-query">Cari node
            <input id="graph-node-query" className={styles.searchInput} type="search" value={query} onChange={(event) => updateQuery(event.target.value)} placeholder="Nama, jenis, nama lengkap, atau berkas" aria-describedby="graph-node-query-help" />
          </label>
          <p id="graph-node-query-help" className={styles.filterHelp}>Pencarian cocok dengan teks di nama, jenis node, nama lengkap, atau path berkas.</p>
          <fieldset className={styles.kindFilters}>
            <legend>Jenis node AST</legend>
            {availableKinds.length ? availableKinds.map((kind) => <label key={kind}>
              <input type="checkbox" checked={selectedKinds.includes(kind)} onChange={() => toggleKind(kind)} />
              {kind}
            </label>) : <p className={styles.filterHelp}>Graph tidak memiliki jenis node untuk difilter.</p>}
          </fieldset>
          <div>
            <button type="button" className={styles.graphControl} onClick={resetFilters} disabled={!query && selectedKinds.length === 0}>Atur ulang filter</button>
          </div>
        </section>

        <section className={styles.modeControls} aria-label="Mode graph">
          <div className={styles.modeButtons}>
            {modes.map((item) => <button key={item.id} type="button" className={styles.modeButton} aria-pressed={mode === item.id} onClick={() => setMode(item.id)}>{item.label}</button>)}
          </div>
          <div className={styles.nodePickerControls}>
            <label className={styles.nodePickerLabel}>Pilih node fokus
              <select ref={nodePickerRef} className={styles.nodePicker} aria-label="Pilih node fokus" data-testid="graph-node-picker" value={selectedId ?? projection.anchorId ?? ""} onChange={(event) => chooseNode(event.target.value)}>
                {!projection.anchorId ? <option value="">Graph tidak memiliki node</option> : null}
                {[...filterResult.graph.nodes].sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0) || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)).map((node) => <option key={node.id} value={node.id}>{node.name} · {node.kind}</option>)}
              </select>
            </label>
            <button type="button" className={styles.graphControl} data-testid="open-node-inspector" onClick={openProjectionAnchor} disabled={!projection.anchorId} aria-expanded={selectedId === projection.anchorId}>Buka inspector node</button>
          </div>
        </section>

        <section className={styles.graphCounts} role="group" aria-label="Ringkasan jumlah graph">
          <p data-testid="canonical-counts">Kanonik: {canonicalCounts.nodes} node · {canonicalCounts.edges} relasi</p>
          <p data-testid="visible-counts">Tampilan: {projection.visibleCounts.nodes} node · {projection.visibleCounts.edges} relasi</p>
          <details className={styles.compactGraphDetails}>
            <summary>Rincian jumlah dan filter</summary>
          <p className={styles.countDetails}>CONTAINS {canonicalCounts.containmentEdges} · Referensi {canonicalCounts.referenceEdges} · Exact {canonicalCounts.exactEdges} · Unresolved {canonicalCounts.unresolvedEdges}</p>
          <p data-testid="query-filter-counts" aria-live="polite">Hasil pencarian dan jenis node: {filterResult.counts.nodes} node · {filterResult.counts.edges} relasi</p>
          <p data-testid="filtered-counts">Hasil mode: {projection.filteredCounts.nodes} node · {projection.filteredCounts.edges} relasi</p>
          <p className={styles.countDetails}>Hasil mode · CONTAINS {projection.filteredCounts.containmentEdges} · Referensi {projection.filteredCounts.referenceEdges} · Exact {projection.filteredCounts.exactEdges} · Unresolved {projection.filteredCounts.unresolvedEdges}</p>
          <p className={styles.countDetails}>Tampilan · CONTAINS {projection.visibleCounts.containmentEdges} · Referensi {projection.visibleCounts.referenceEdges} · Exact {projection.visibleCounts.exactEdges} · Unresolved {projection.visibleCounts.unresolvedEdges}</p>
          </details>
          {projection.omittedCounts.nodes > 0 || projection.omittedCounts.edges > 0 ? <p className={styles.subsetNotice} role="note">Batas render antarmuka: maksimal 200 node dan 500 relasi. Mode ini memuat {projection.visibleCounts.nodes} dari {projection.filteredCounts.nodes} node dan {projection.visibleCounts.edges} dari {projection.filteredCounts.edges} relasi.</p> : null}
        </section>

        {busy ? <p className={ui.loading} role="status">Memeriksa akun sebelum memuat ulang graph…</p> : null}
        {visiblePayload.graph.nodes.length === 0 ? <p className={styles.emptySelection} role="status">Graph tidak memiliki node untuk ditampilkan.</p> : null}
        {visiblePayload.graph.nodes.length > 0 && filterResult.graph.nodes.length === 0 ? <p className={styles.emptySelection} role="status">Tidak ada node yang sesuai dengan kueri dan jenis node yang dipilih.</p> : null}
        {filterResult.graph.nodes.length > 0 && projection.graph.nodes.length === 0 ? <p className={styles.emptySelection} role="status">Mode ini tidak memiliki node untuk ditampilkan.</p> : null}
        <GraphCanvas graph={projection.graph} selectedId={selectedId} onSelect={setSelectedId} />
        {visiblePayload && selectedId && filterResult.graph.nodes.some((node) => node.id === selectedId) ? <NodeInspector
          key={`${analysisId}:${accountKey}:${visiblePayload.ckgSha256}:${visiblePayload.configurationHash}:${visiblePayload.snapshot.repository}:${visiblePayload.snapshot.branch ?? ""}:${visiblePayload.snapshot.commitSha}:${selectedId}`}
          analysisId={analysisId}
          accountKey={accountKey}
          ckgSha256={visiblePayload.ckgSha256}
          configurationHash={visiblePayload.configurationHash}
          snapshot={visiblePayload.snapshot}
          nodeId={selectedId}
          onClose={closeInspector}
          onIdentityFailure={handleInspectorIdentityFailure}
        /> : null}
        <p className={styles.modeDescription} aria-live="polite">
          {mode === "overview" ? "Ikhtisar menampilkan node kanonik sebagai jaringan. Relasi CONTAINS menjadi garis titik-titik; arahkan pointer ke node untuk melihat jenis relasi lainnya." : null}
          {mode === "focus" ? "Fokus menampilkan node terpilih, tetangga langsung, dan relasi yang bersentuhan dengan node terpilih." : null}
          {mode === "all-references" ? "Semua referensi menampilkan endpoint dari relasi selain CONTAINS, termasuk referensi yang belum terpecahkan." : null}
        </p>
      </section>
      <p className={styles.liveGraphFooter}><Link href={`/analyses/${encodeURIComponent(analysisId)}`}>Kembali ke progres analisis</Link></p>
    </> : null}
  </div>;
}
