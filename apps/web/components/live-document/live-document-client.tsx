"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { ArchitectureDocumentV1 } from "@sage/documents/model";
import { humanNodeName } from "@sage/documents/human";
import type { CcmEdge, CcmNode, EvidenceSpan } from "@sage/contracts";
import type { DocumentPayload } from "../../lib/documents/types.ts";
import { diagramBudget, parseLiveDocumentPayload } from "./document-data.ts";
import { diagramSvgObjectUrl, DiagramRenderError, renderCanonicalDiagramSvg } from "./diagram-renderer.ts";
import { MarkdownExport, PdfExport } from "./markdown-export.tsx";
import styles from "./live-document.module.css";

type DiagramProjection = ArchitectureDocumentV1["softwareEngineeringDiagram"];

type SectionId = "catalog" | "structure" | "uml";
type RequestError = { status: number | null; message: string };
type SessionIdentity = { accountKey?: string };

const sections: { id: SectionId; label: string }[] = [
  { id: "catalog", label: "Interface Catalog" },
  { id: "structure", label: "Software Engineering Diagram" },
  { id: "uml", label: "UML Class Diagram" },
];

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function responseMessage(value: unknown): string | null {
  if (!record(value) || !record(value.error)) return null;
  return typeof value.error.message === "string" ? value.error.message : null;
}

function locationText(evidence: Pick<EvidenceSpan, "filePath" | "startLine" | "endLine"> | null): string {
  if (!evidence) return "Bukti lokasi tidak tersedia";
  const lineRange = evidence.startLine === evidence.endLine
    ? String(evidence.startLine)
    : `${evidence.startLine}–${evidence.endLine}`;
  return `${evidence.filePath}:${lineRange}`;
}

function nodeName(node: CcmNode | undefined, _fallbackId: string): string {
  void _fallbackId;
  return node ? humanNodeName(node) : "Referensi tidak tersedia";
}

function Metadata({ payload }: { payload: DocumentPayload }) {
  const document = payload.document;
  return <section className={styles.snapshotCard} aria-labelledby="document-snapshot-title">
    <h2 id="document-snapshot-title">Snapshot analisis</h2>
    <dl className={styles.metadataGrid}>
      <div><dt>Repository</dt><dd>{document.snapshot.repository}</dd></div>
      <div><dt>Branch</dt><dd>{document.snapshot.branch ?? "Tidak tersedia"}</dd></div>
      <div><dt>Cakupan</dt><dd>{document.files.length} file · {document.canonicalCounts.nodes} node</dd></div>
      <div><dt>Hasil</dt><dd>{document.canonicalCounts.exactEdges} Exact · {document.canonicalCounts.unresolvedEdges} Unresolved</dd></div>
    </dl>
    {document.limitations.length ? <details className={styles.unresolvedBox}><summary>Batasan analisis ({document.limitations.length})</summary><ul>{document.limitations.map((item, index) => <li key={index}>{item.path ? <code>{item.path}: </code> : null}{item.reason}</li>)}</ul></details> : null}
  </section>;
}

function InterfaceCatalog({ document }: { document: ArchitectureDocumentV1 }) {
  const { interfaceCatalog } = document;
  const nodeById = new Map(document.softwareEngineeringDiagram.nodes.map(node => [node.id, node]));
  const unresolved = interfaceCatalog.relations.filter(edge => edge.resolution === "Unresolved");
  return <section className={styles.contentCard} aria-labelledby="catalog-heading">
    <div className={styles.sectionHeading}><div><h2 id="catalog-heading">Interface Catalog</h2><p>Deklarasi source dan relasi yang tercatat pada model canonical, dilengkapi bukti file dan baris.</p></div></div>
    <p className={styles.scopeNote}>Simbol, kontrak kode, dan lokasi bukti. Endpoint HTTP atau interface integrasi hanya dapat ditentukan jika tersedia bukti source.</p>
    <div className={styles.legend} aria-label="Legend status relasi">
      <span><i className={styles.exactMark} aria-hidden="true" />Exact — relasi sesuai evidence yang terpetakan</span>
      <span><i className={styles.unresolvedMark} aria-hidden="true" />Unresolved — alasan belum terpecahkan dipertahankan</span>
    </div>
    {interfaceCatalog.entries.length === 0 ? <p className={styles.emptyMessage}>CCM tidak mencatat deklarasi source untuk katalog.</p> : <div className={styles.tableScroll}>
      <table className={styles.catalogTable}>
        <thead><tr><th scope="col">Symbol</th><th scope="col">Contract</th><th scope="col">Evidence</th></tr></thead>
        <tbody>{interfaceCatalog.entries.map((entry) => <tr key={entry.declaration.id}>
          <td data-label="Symbol"><code>{entry.declaration.qualifiedName || entry.declaration.name}</code></td>
          <td data-label="Kind / contract"><span className={styles.kind}>{entry.declaration.kind} · {entry.declaration.language}</span>{entry.declaration.signature ? <code>{entry.declaration.signature}</code> : document.softwareEngineeringDiagram.nodes.some(node => node.parentId === entry.declaration.id && ["Method", "Property"].includes(node.kind)) ? <code>{document.softwareEngineeringDiagram.nodes.filter(node => node.parentId === entry.declaration.id && ["Method", "Property"].includes(node.kind)).map(node => node.signature ?? node.name).join("; ")}</code> : <span className={styles.muted}>Kontrak tidak tersedia di CCM</span>}</td>
          <td data-label="Evidence"><span className={styles.sourceEvidence}>{locationText(entry.declaration.location)}</span>{entry.evidence.filter(item => item.role !== "declaration").map((item, index) => <span key={`${item.filePath}:${item.startLine}:${item.role}:${index}`} className={styles.sourceEvidence}><br />{locationText(item)} · {item.role}</span>)}</td>

        </tr>)}</tbody>
      </table>
    </div>}
    {interfaceCatalog.relations.length > 0 ? <details className={styles.unresolvedBox}><summary id="catalog-relations-title">Relasi dan evidence lengkap</summary>
      <div className={styles.tableScroll}><table className={styles.relationTable}>
        <thead><tr><th scope="col">Source</th><th scope="col">Relasi</th><th scope="col">Target</th><th scope="col">Status / alasan</th><th scope="col">Evidence</th></tr></thead>
        <tbody>{interfaceCatalog.relations.map((edge) => <RelationRow key={edge.id} edge={edge} nodeById={nodeById} />)}</tbody>
      </table></div>
    </details> : <p className={styles.emptyMessage}>CCM tidak mencatat relasi.</p>}
    {unresolved.length ? <p className={styles.emptyMessage}>{unresolved.length} relasi belum terpecahkan; alasan dan evidence tercantum pada tabel relasi.</p> : null}
  </section>;
}

function RelationRow({ edge, nodeById }: { edge: CcmEdge; nodeById: Map<string, CcmNode> }) {
  return <tr>
    <td data-label="Source"><code>{nodeName(nodeById.get(edge.sourceId), edge.sourceId)}</code></td>
    <td data-label="Relasi"><code>{edge.kind}</code></td>
    <td data-label="Target"><code>{nodeName(nodeById.get(edge.targetId), edge.targetId)}</code></td>
    <td data-label="Status / alasan"><strong>{edge.resolution}</strong>{edge.unresolvedReason ? <><br /><span>{edge.unresolvedReason}</span></> : null}</td>
    <td data-label="Evidence">{edge.evidence.length ? edge.evidence.map((item, index) => <span key={`${item.filePath}:${item.startLine}:${index}`} className={styles.sourceEvidence}>{index > 0 ? <br /> : null}{locationText(item)} · {item.role}</span>) : <span className={styles.muted}>Bukti lokasi tidak tersedia</span>}</td>
  </tr>;
}

function DiagramSection({
  diagram,
  label,
  ckgSha256,
  accountKey,
}: {
  diagram: DiagramProjection;
  label: string;
  ckgSha256: string;
  accountKey: string;
}) {
  const [result, setResult] = useState<{ key: string; state: "ready" | "error" | "unavailable"; url?: string } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [zoomState, setZoomState] = useState<{ key: string; percent: number } | null>(null);
  const generation = useRef(0);
  const currentUrl = useRef<string | null>(null);
  const budget = diagramBudget(diagram);
  const renderKey = `${accountKey}:${ckgSha256}:${label}:${diagram.kind}:${attempt}`;
  const currentResult = result?.key === renderKey ? result : null;
  const state = budget.kind === "unavailable" ? "unavailable" : currentResult?.state ?? "loading";
  const url = currentResult?.url ?? null;
  const zoomPercent = zoomState?.key === renderKey ? zoomState.percent : 100;

  useEffect(() => {
    let active = true;
    const renderGeneration = ++generation.current;
    if (currentUrl.current) URL.revokeObjectURL(currentUrl.current);
    currentUrl.current = null;
    if (budget.kind === "unavailable") return;
    void (async () => {
      try {
        const seed = `${ckgSha256}-${label}-${accountKey}`;
        const svg = await renderCanonicalDiagramSvg(diagram, seed, () => active && generation.current === renderGeneration);
        if (!active || generation.current !== renderGeneration || !svg) return;
        const nextUrl = diagramSvgObjectUrl(svg);
        if (!active || generation.current !== renderGeneration) {
          URL.revokeObjectURL(nextUrl);
          return;
        }
        currentUrl.current = nextUrl;
        setResult({ key: renderKey, state: "ready", url: nextUrl });
      } catch (cause) {
        if (!active || generation.current !== renderGeneration) return;
        setResult({ key: renderKey, state: cause instanceof DiagramRenderError && cause.code === "OVER_BUDGET" ? "unavailable" : "error" });
      }
    })();

    return () => {
      active = false;
      generation.current += 1;
      if (currentUrl.current) URL.revokeObjectURL(currentUrl.current);
      currentUrl.current = null;
    };
  }, [accountKey, attempt, budget.kind, ckgSha256, diagram, label, renderKey]);

  if (budget.kind === "unavailable") return <p className={styles.diagramStatus} role="status">Diagram tidak tersedia: {budget.reason} Katalog dan evidence tetap tersedia.</p>;

  return <>
    {state === "loading" ? <p className={styles.diagramStatus} role="status">Merender diagram canonical secara lokal…</p> : null}
    {state === "unavailable" ? <p className={styles.diagramStatus} role="status">Diagram tidak tersedia karena hasil SVG melewati batas keamanan 4 MiB. Katalog dan evidence tetap tersedia.</p> : null}
    {state === "error" ? <div className={styles.diagramStatus} role="alert">
      <p>{"Diagram gagal dirender atau hasil SVG melewati batas 4 MiB. Katalog dan evidence tetap tersedia."}</p>
      <button className={styles.retryButton} type="button" onClick={() => setAttempt(value => value + 1)}>Coba lagi</button>
    </div> : null}
    {url ? <>
      <div className={styles.diagramZoomControls} role="group" aria-label="Kontrol zoom diagram" data-testid="document-diagram-zoom">
        <button className={styles.diagramZoomButton} type="button" disabled={zoomPercent <= 100}
          onClick={() => setZoomState({ key: renderKey, percent: Math.max(100, zoomPercent - 50) })}>Perkecil</button>
        <output className={styles.diagramZoomValue} aria-live="polite" data-testid="document-diagram-zoom-value">Zoom: {zoomPercent}%</output>
        <button className={styles.diagramZoomButton} type="button" disabled={zoomPercent >= 400}
          onClick={() => setZoomState({ key: renderKey, percent: Math.min(400, zoomPercent + 50) })}>Perbesar</button>
        <button className={styles.diagramZoomButton} type="button" disabled={zoomPercent === 100}
          onClick={() => setZoomState({ key: renderKey, percent: 100 })}>Sesuaikan</button>
      </div>
      <div className={styles.diagramViewport} data-testid="document-diagram-viewport" tabIndex={0} role="region" aria-label={`Area ${label}; gunakan tombol panah untuk menggeser diagram`}>
        {/* The sanitized SVG is loaded as an image Blob URL, never inserted into the active DOM. */}
        {/* eslint-disable-next-line @next/next/no-img-element -- Blob-backed canonical SVG keeps active markup out of the page. */}
        <img className={styles.diagramImage} data-testid="document-diagram-image" src={url} alt={label}
          style={{ width: `${zoomPercent}%` }} />
      </div>
    </> : null}
  </>;
}

function DiagramDocumentSection({ payload, section }: { payload: DocumentPayload; section: Exclude<SectionId, "catalog"> }) {
  const diagram = section === "structure" ? payload.document.softwareEngineeringDiagram : payload.document.umlClassDiagram;
  const label = section === "structure" ? sections[1].label : sections[2].label;
  const nodeById = new Map(diagram.nodes.map(node => [node.id, node]));
  const unresolvedEdges = diagram.edges.filter(edge => edge.resolution === "Unresolved");
  return <section className={styles.contentCard} aria-labelledby="diagram-heading">
    <div className={styles.sectionHeading}><div><h2 id="diagram-heading">{label}</h2><p>Diagram source untuk mempelajari struktur dan ketergantungan kode. Anggota class diringkas ke pemiliknya pada diagram struktur; detail bukti tersedia di bawah.</p></div></div>
    <div className={styles.legend} aria-label="Legend diagram">
      <span><i className={styles.exactMark} aria-hidden="true" />Exact</span>
      <span><i className={styles.unresolvedMark} aria-hidden="true" />Unresolved</span>
      <span>Teal: class · Ungu: interface · Biru: function · Abu: module · Amber: unresolved</span>
    </div>
    <DiagramSection diagram={diagram} label={label} ckgSha256={payload.document.ckgSha256} accountKey={payload.accountKey} />
    {diagram.nodeMappings.length ? <section aria-labelledby="diagram-evidence-title">
      <h3 id="diagram-evidence-title" className={styles.evidenceHeading}>Bukti node pada diagram</h3>
      <div className={styles.tableScroll}><table className={styles.mappingTable}>
        <thead><tr><th scope="col">Node</th><th scope="col">Kind</th><th scope="col">Evidence source</th></tr></thead>
        <tbody>{diagram.nodeMappings.map((mapping, index) => {
          const node = nodeById.get(mapping.nodeId);
          const evidence = mapping.evidence ?? node?.location ?? null;
          return <tr key={`${mapping.nodeId}:${mapping.mermaidLine}:${index}`}>
            <td data-label="Node"><code>{nodeName(node, mapping.nodeId)}</code></td>
            <td data-label="Kind">{node?.kind ?? "Member"}</td>
            <td data-label="Evidence source"><span className={styles.sourceEvidence}>{locationText(evidence)}</span></td>
          </tr>;
        })}</tbody>
      </table></div>
    </section> : <p className={styles.emptyMessage}>Diagram tidak memiliki mapping node.</p>}
    {diagram.edgeMappings.length ? <section aria-labelledby="diagram-relations-title">
      <h3 id="diagram-relations-title" className={styles.evidenceHeading}>Relasi dan evidence</h3>
      <div className={styles.tableScroll}><table className={styles.mappingTable}>
        <thead><tr><th scope="col">Relasi</th><th scope="col">Status</th><th scope="col">Evidence source</th></tr></thead>
        <tbody>{diagram.edgeMappings.map((mapping) => {
          const edge = diagram.edges.find(item => item.id === mapping.edgeId);
          return <tr key={mapping.edgeId}>
            <td data-label="Relasi"><code>{edge?.kind ?? mapping.edgeId}</code>{edge ? <span><br />{nodeName(nodeById.get(edge.sourceId), edge.sourceId)} → {nodeName(nodeById.get(edge.targetId), edge.targetId)}</span> : null}</td>
            <td data-label="Status">{edge?.resolution ?? "Tidak diketahui"}{edge?.unresolvedReason ? <><br />{edge.unresolvedReason}</> : null}</td>
            <td data-label="Evidence source">{mapping.evidence.length ? mapping.evidence.map((item, index) => <span key={`${item.filePath}:${item.startLine}:${index}`} className={styles.sourceEvidence}>{index ? <br /> : null}{locationText(item)}</span>) : <span className={styles.muted}>Bukti lokasi tidak tersedia</span>}</td>
          </tr>;
        })}</tbody>
      </table></div>
    </section> : <p className={styles.emptyMessage}>Diagram tidak mencatat edge.</p>}
    {unresolvedEdges.length ? <p className={styles.emptyMessage}>{unresolvedEdges.length} relasi Unresolved; alasan dan evidence tetap dicantumkan di atas.</p> : null}
  </section>;
}

export function LiveDocumentClient({ analysisId, accountKey }: { analysisId: string; accountKey: string }) {
  const [payload, setPayload] = useState<DocumentPayload | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<RequestError | null>(null);
  const [section, setSection] = useState<SectionId>("catalog");
  const generation = useRef(0);
  const documentController = useRef<AbortController | null>(null);
  const sessionController = useRef<AbortController | null>(null);
  const refreshRef = useRef<(() => void) | null>(null);
  const fullCheckRunning = useRef(false);
  const reloadStarted = useRef(false);
  const visiblePayload = payload?.analysisId === analysisId && payload.accountKey === accountKey ? payload : null;

  useEffect(() => {
    let active = true;
    let periodicCheckRunning = false;

    function requestHeaders() { return { "X-SAGE-Account": accountKey }; }
    function abortCurrentRequests() {
      documentController.current?.abort();
      documentController.current = null;
      sessionController.current?.abort();
      sessionController.current = null;
    }
    function isCurrent(requestGeneration: number) { return active && generation.current === requestGeneration; }
    function clearSensitiveData() {
      setPayload(null);
      setSection("catalog");
    }
    function reloadCurrentPage() {
      if (reloadStarted.current) return;
      reloadStarted.current = true;
      generation.current += 1;
      abortCurrentRequests();
      clearSensitiveData();
      window.location.replace(`${window.location.pathname}${window.location.search}`);
    }
    function redirectToLogin() {
      if (reloadStarted.current) return;
      reloadStarted.current = true;
      generation.current += 1;
      abortCurrentRequests();
      clearSensitiveData();
      window.location.replace("/login?error=session");
    }

    async function checkSession(requestGeneration: number): Promise<SessionIdentity | null> {
      const controller = new AbortController();
      sessionController.current = controller;
      try {
        const response = await fetch("/api/auth/session", {
          headers: requestHeaders(), cache: "no-store", credentials: "same-origin", signal: controller.signal,
        });
        if (!isCurrent(requestGeneration)) return null;
        if (response.status === 401) { reloadCurrentPage(); return null; }
        if (!response.ok) throw new Error("Sesi belum dapat diperiksa. Coba lagi.");
        const body = await response.json() as { data?: SessionIdentity };
        if (!isCurrent(requestGeneration)) return null;
        if (body.data?.accountKey !== accountKey) { reloadCurrentPage(); return null; }
        return body.data;
      } finally {
        if (sessionController.current === controller) sessionController.current = null;
      }
    }

    async function loadDocument(requestGeneration: number) {
      const controller = new AbortController();
      documentController.current = controller;
      try {
        const response = await fetch(`/api/analyses/${encodeURIComponent(analysisId)}/document`, {
          headers: requestHeaders(), cache: "no-store", credentials: "same-origin", signal: controller.signal,
        });
        if (!isCurrent(requestGeneration)) return;
        if (response.status === 401) {
          clearSensitiveData();
          const identity = await checkSession(requestGeneration);
          if (identity && isCurrent(requestGeneration)) redirectToLogin();
          return;
        }
        if (!response.ok) {
          let message: string | null = null;
          try { message = responseMessage(await response.json()); } catch { /* Keep the safe status message. */ }
          if (!isCurrent(requestGeneration)) return;
          setPayload(null);
          setError({ status: response.status, message: message ?? "Dokumen belum dapat dimuat. Coba lagi." });
          return;
        }
        const body = await response.json() as { data?: unknown };
        if (!isCurrent(requestGeneration)) return;
        const validated = parseLiveDocumentPayload(body.data, analysisId, accountKey);
        // A cookie can change while a large response is in flight, without a focus event.
        // Recheck the server identity after reading the body before publishing private facts.
        const identity = await checkSession(requestGeneration);
        if (!identity || !isCurrent(requestGeneration)) return;
        setPayload(validated);
        setError(null);
      } catch (cause) {
        if (!isCurrent(requestGeneration) || (cause instanceof DOMException && cause.name === "AbortError")) return;
        setPayload(null);
        setError({ status: null, message: cause instanceof Error ? cause.message : "Dokumen belum dapat dimuat. Coba lagi." });
      } finally {
        if (isCurrent(requestGeneration)) setBusy(false);
        if (documentController.current === controller) documentController.current = null;
      }
    }

    async function refreshAfterIdentityCheck() {
      if (!active || reloadStarted.current) return;
      fullCheckRunning.current = true;
      const requestGeneration = ++generation.current;
      abortCurrentRequests();
      clearSensitiveData();
      setError(null);
      setBusy(true);
      try {
        const identity = await checkSession(requestGeneration);
        if (identity && isCurrent(requestGeneration)) await loadDocument(requestGeneration);
      } catch (cause) {
        if (isCurrent(requestGeneration) && !(cause instanceof DOMException && cause.name === "AbortError")) {
          setPayload(null);
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
          headers: requestHeaders(), cache: "no-store", credentials: "same-origin", signal: controller.signal,
        });
        if (!isCurrent(requestGeneration)) return;
        if (response.status === 401) { clearSensitiveData(); reloadCurrentPage(); return; }
        if (!response.ok) throw new Error("Sesi belum dapat diperiksa. Coba lagi.");
        const body = await response.json() as { data?: SessionIdentity };
        if (!isCurrent(requestGeneration)) return;
        if (body.data?.accountKey !== accountKey) { clearSensitiveData(); reloadCurrentPage(); }
      } catch (cause) {
        if (!isCurrent(requestGeneration) || (cause instanceof DOMException && cause.name === "AbortError")) return;
        clearSensitiveData();
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
  }, [analysisId, accountKey]);

  function errorContent() {
    if (!error) return null;
    if (error.status === 404) return <section className={`${styles.notice} ${styles.error}`} role="alert"><h2>Analisis tidak ditemukan.</h2><p>Dokumen ini tidak tersedia untuk akun yang sedang aktif.</p></section>;
    if (error.status === 409) return <section className={`${styles.notice} ${styles.warning}`} role="alert"><h2>Dokumen belum tersedia.</h2><p>{error.message} Selesaikan analisis terlebih dahulu, lalu buka kembali dokumen.</p><p><Link href={`/analyses/${encodeURIComponent(analysisId)}`}>Kembali ke progres analisis</Link></p><button className={styles.retryButton} type="button" onClick={() => refreshRef.current?.()}>Coba lagi</button></section>;
    if (error.status === 503) return <section className={`${styles.notice} ${styles.error}`} role="alert"><h2>Dokumen sementara tidak dapat dibaca.</h2><p>{error.message}</p><button className={styles.retryButton} type="button" onClick={() => refreshRef.current?.()}>Coba lagi</button></section>;
    return <section className={`${styles.notice} ${styles.error}`} role="alert"><h2>Dokumen belum dapat dimuat.</h2><p>{error.message}</p><button className={styles.retryButton} type="button" onClick={() => refreshRef.current?.()}>Coba lagi</button></section>;
  }

  return <div className={styles.documentPage}>
    <div className={styles.pageHeading}>

      <h1>Architecture Definition Document</h1>
      <p>Pelajari kontrak dan struktur kode dari snapshot analisis. PDF menyajikan ringkasan; Markdown memuat seluruh detail teknis.</p>
    </div>

    {busy && !visiblePayload ? <p className={styles.loading} role="status">Memeriksa akun dan memuat dokumen arsitektur…</p> : null}
    {errorContent()}
    {visiblePayload ? <>
      <Metadata payload={visiblePayload} />
      <p className={styles.footerLink}><Link href={`/analyses/${encodeURIComponent(analysisId)}/graph`}>Kembali ke graph</Link></p>
      <div className={styles.sectionLayout}>
        <nav className={styles.sectionNav} aria-label="Bagian dokumen">
          {sections.map((item) => <button
            key={item.id}
            id={`document-tab-${item.id}`}
            type="button"
            className={styles.sectionButton}
            aria-pressed={section === item.id}
            aria-controls="document-content"
            onClick={() => setSection(item.id)}
          >{item.label}</button>)}
        </nav>
        <div id="document-content" className={styles.sectionContent} aria-live="polite">
      <div className={styles.exportGrid}>
        <MarkdownExport
          key={`MARKDOWN:${visiblePayload.analysisId}:${visiblePayload.accountKey}:${visiblePayload.contentHash}`}
          payload={visiblePayload}
          onUnauthorized={() => refreshRef.current?.()}
        />
        <PdfExport
          key={`PDF:${visiblePayload.analysisId}:${visiblePayload.accountKey}:${visiblePayload.contentHash}`}
          payload={visiblePayload}
          onUnauthorized={() => refreshRef.current?.()}
        />
      </div>

          {section === "catalog" ? <InterfaceCatalog document={visiblePayload.document} /> :
            <DiagramDocumentSection key={`${accountKey}:${visiblePayload.document.ckgSha256}:${section}`} payload={visiblePayload} section={section} />}
        </div>
      </div>
      <p className={styles.footerLink}><Link href={`/analyses/${encodeURIComponent(analysisId)}`}>Kembali ke progres analisis</Link></p>
    </> : null}
  </div>;
}
