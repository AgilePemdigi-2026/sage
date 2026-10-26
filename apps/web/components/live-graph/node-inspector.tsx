"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CcmSnapshot, EvidenceSpan } from "@sage/contracts";
import type {
  NodeInspectorFile,
  NodeInspectorPayload,
  NodeInspectorRelation,
  SourcePayload,
} from "../../lib/graphs/inspector-types.ts";
import {
  fileForEvidence,
  parseNodeInspectorPayload,
  parseSourcePayload,
  sourceRangeForEvidence,
} from "./inspector-data.ts";
import styles from "../graph-foundation/graph-foundation.module.css";

type DetailState =
  | { key: string; kind: "loading" }
  | { key: string; kind: "ready"; value: NodeInspectorPayload }
  | { key: string; kind: "unavailable" | "error"; message: string }
  | { key: string; kind: "identity" };

type SourceState =
  | { key: string; kind: "loading" }
  | { key: string; kind: "ready"; value: SourcePayload }
  | { key: string; kind: "unavailable" | "error"; message: string }
  | { key: string; kind: "identity" };

interface SourceTarget {
  key: string;
  file: NodeInspectorFile;
  evidence: EvidenceSpan;
  label: string;
  requested: { startLine: number; endLine: number };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function responseMessage(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const error = value.error;
  if (!isRecord(error) || typeof error.message !== "string") return null;
  return error.message;
}

function isAbortError(value: unknown): boolean {
  return value instanceof DOMException && value.name === "AbortError";
}

function formatSnapshot(snapshot: CcmSnapshot): string {
  return `${snapshot.repository} · ${snapshot.branch ?? "branch tidak diketahui"} · ${snapshot.commitSha}`;
}

function EvidenceLocation({ evidence }: { evidence: EvidenceSpan }) {
  return <span className={styles.inspectorEvidenceBounds}>
    {evidence.filePath} · bytes {evidence.startByte}–{evidence.endByte} (akhir eksklusif) · baris {evidence.startLine}:{evidence.startColumn}–{evidence.endLine}:{evidence.endColumn}
  </span>;
}

function SourceLines({ payload, evidence }: { payload: SourcePayload; evidence: EvidenceSpan }) {
  const expectedLineCount = payload.endLine - payload.startLine + 1;
  const sourceLines = payload.text.split("\n");
  if (sourceLines.length > expectedLineCount && sourceLines[sourceLines.length - 1] === "") sourceLines.pop();
  const visibleLines = sourceLines.slice(0, expectedLineCount);
  while (visibleLines.length < expectedLineCount) visibleLines.push("");

  return <ol className={styles.sourceLines} start={payload.startLine} aria-label={`Baris source ${payload.startLine} sampai ${payload.endLine}`}>
    {visibleLines.map((line, index) => {
      const number = payload.startLine + index;
      const lastEvidenceLine = evidence.endLine > evidence.startLine && evidence.endColumn === 1 ? evidence.endLine - 1 : evidence.endLine;
      const highlighted = number >= evidence.startLine && number <= lastEvidenceLine;
      return <li key={number} data-source-line={number} className={highlighted ? styles.sourceEvidenceLine : undefined}>
        <code>{(line.endsWith("\r") ? line.slice(0, -1) : line) || " "}</code>
      </li>;
    })}
  </ol>;
}

export function NodeInspector({
  analysisId,
  accountKey,
  ckgSha256,
  configurationHash,
  snapshot,
  nodeId,
  onClose,
  onIdentityFailure,
}: {
  analysisId: string;
  accountKey: string;
  ckgSha256: string;
  configurationHash: string;
  snapshot: CcmSnapshot;
  nodeId: string;
  onClose: () => void;
  onIdentityFailure: () => void;
}) {
  const contextKey = JSON.stringify([
    analysisId,
    accountKey,
    ckgSha256,
    configurationHash,
    snapshot.repository,
    snapshot.branch,
    snapshot.commitSha,
    nodeId,
  ]);
  const identity = useMemo(() => ({ analysisId, accountKey, ckgSha256, configurationHash, snapshot }), [
    accountKey, analysisId, ckgSha256, configurationHash, snapshot,
  ]);
  const [detailState, setDetailState] = useState<DetailState>({ key: contextKey, kind: "loading" });
  const [sourceTarget, setSourceTarget] = useState<SourceTarget | null>(null);
  const [sourceState, setSourceState] = useState<SourceState | null>(null);
  const [sourceAttempt, setSourceAttempt] = useState(0);
  const nodeController = useRef<AbortController | null>(null);
  const sourceController = useRef<AbortController | null>(null);
  const nodeGeneration = useRef(0);
  const sourceGeneration = useRef(0);
  const sourceDialog = useRef<HTMLDialogElement>(null);
  const sourceReturnFocus = useRef<HTMLButtonElement | null>(null);
  const restoreSourceFocus = useRef(true);
  const isMounted = useRef(true);

  const sourceRequestKey = sourceTarget ? `${contextKey}:${sourceTarget.key}` : null;

  const invalidateIdentity = useCallback(() => {
    nodeGeneration.current += 1;
    nodeController.current?.abort();
    nodeController.current = null;
    sourceGeneration.current += 1;
    sourceController.current?.abort();
    sourceController.current = null;
    restoreSourceFocus.current = false;
    sourceReturnFocus.current = null;
    if (sourceDialog.current?.open) sourceDialog.current.close();
    setDetailState({ key: contextKey, kind: "identity" });
    setSourceTarget(null);
    setSourceState({ key: contextKey, kind: "identity" });
    onIdentityFailure();
  }, [contextKey, onIdentityFailure]);

  const loadNode = useCallback(async () => {
    const requestKey = contextKey;
    const requestId = ++nodeGeneration.current;
    nodeController.current?.abort();
    const controller = new AbortController();
    nodeController.current = controller;
    setDetailState({ key: requestKey, kind: "loading" });
    const current = () => nodeGeneration.current === requestId && !controller.signal.aborted;

    try {
      const response = await fetch(`/api/analyses/${encodeURIComponent(analysisId)}/nodes/${encodeURIComponent(nodeId)}`, {
        headers: { "X-SAGE-Account": accountKey },
        cache: "no-store",
        credentials: "same-origin",
        signal: controller.signal,
      });
      if (!current()) return;
      let body: unknown = null;
      try { body = await response.json(); } catch { /* The status still determines the accessible error state. */ }
      if (!current()) return;
      if (response.status === 401) {
        invalidateIdentity();
        return;
      }
      if (!response.ok) {
        const message = responseMessage(body) ?? "Detail node belum dapat dimuat. Coba lagi.";
        setDetailState({ key: requestKey, kind: response.status === 404 || response.status === 409 || response.status === 503 ? "unavailable" : "error", message });
        return;
      }
      if (!isRecord(body) || !("data" in body)) throw new Error("Respons detail node tidak valid.");
      const value = parseNodeInspectorPayload(body.data, { ...identity, nodeId });
      if (!current()) return;
      setDetailState({ key: requestKey, kind: "ready", value });
    } catch (cause) {
      if (!current() || isAbortError(cause)) return;
      setDetailState({ key: requestKey, kind: "error", message: cause instanceof Error ? cause.message : "Detail node belum dapat dimuat. Coba lagi." });
    } finally {
      if (nodeController.current === controller) nodeController.current = null;
    }
  }, [accountKey, analysisId, contextKey, identity, invalidateIdentity, nodeId]);

  useEffect(() => {
    isMounted.current = true;
    let scheduled = true;
    queueMicrotask(() => { if (scheduled) void loadNode(); });
    const dialog = sourceDialog.current;
    return () => {
      scheduled = false;
      isMounted.current = false;
      nodeGeneration.current += 1;
      sourceGeneration.current += 1;
      nodeController.current?.abort();
      sourceController.current?.abort();
      nodeController.current = null;
      sourceController.current = null;
      sourceReturnFocus.current = null;
      if (dialog?.open) dialog.close();
    };
  }, [loadNode]);

  useEffect(() => {
    const dialog = sourceDialog.current;
    if (sourceTarget && dialog && !dialog.open) dialog.showModal();
  }, [sourceTarget]);

  useEffect(() => {
    if (!sourceTarget || !sourceRequestKey) return;
    const requestKey = sourceRequestKey;
    const requestId = ++sourceGeneration.current;
    sourceController.current?.abort();
    const controller = new AbortController();
    sourceController.current = controller;
    const current = () => sourceGeneration.current === requestId && !controller.signal.aborted;

    async function loadSource() {
      try {
        const query = new URLSearchParams({
          startLine: String(sourceTarget.requested.startLine),
          endLine: String(sourceTarget.requested.endLine),
        });
        const response = await fetch(`/api/analyses/${encodeURIComponent(analysisId)}/files/${encodeURIComponent(sourceTarget.file.id)}/source?${query}`, {
          headers: { "X-SAGE-Account": accountKey },
          cache: "no-store",
          credentials: "same-origin",
          signal: controller.signal,
        });
        if (!current()) return;
        let body: unknown = null;
        try { body = await response.json(); } catch { /* Keep the status-specific message. */ }
        if (!current()) return;
        if (response.status === 401) {
          invalidateIdentity();
          return;
        }
        if (!response.ok) {
          const message = response.status === 413
            ? "Rentang source terlalu besar untuk ditampilkan. Coba muat ulang pratinjau."
            : responseMessage(body) ?? "Source bukti belum dapat dimuat. Coba lagi.";
          setSourceState({ key: requestKey, kind: response.status === 404 || response.status === 409 || response.status === 503 ? "unavailable" : "error", message });
          return;
        }
        if (!isRecord(body) || !("data" in body)) throw new Error("Respons source tidak valid.");
        const value = parseSourcePayload(body.data, { ...identity, file: sourceTarget.file, ...sourceTarget.requested });
        if (!current()) return;
        setSourceState({ key: requestKey, kind: "ready", value });
      } catch (cause) {
        if (!current() || isAbortError(cause)) return;
        setSourceState({ key: requestKey, kind: "error", message: cause instanceof Error ? cause.message : "Source bukti belum dapat dimuat. Coba lagi." });
      } finally {
        if (sourceController.current === controller) sourceController.current = null;
      }
    }

    void loadSource();
    return () => {
      sourceGeneration.current += 1;
      controller.abort();
      if (sourceController.current === controller) sourceController.current = null;
    };
  }, [accountKey, analysisId, contextKey, identity, invalidateIdentity, sourceAttempt, sourceRequestKey, sourceTarget]);

  const detail = detailState.key === contextKey ? detailState : { key: contextKey, kind: "loading" as const };
  const source = sourceState?.key === sourceRequestKey ? sourceState : null;
  const node = detail.kind === "ready" ? detail.value.node : null;

  function openSource(evidence: EvidenceSpan, file: NodeInspectorFile, label: string, trigger: HTMLButtonElement) {
    const requested = sourceRangeForEvidence(evidence);
    const key = JSON.stringify([file.id, evidence.filePath, evidence.fileSha256, evidence.startByte, evidence.endByte, evidence.startLine, evidence.endLine, evidence.role, requested.startLine, requested.endLine]);
    sourceReturnFocus.current = trigger;
    restoreSourceFocus.current = true;
    setSourceAttempt(0);
    setSourceState({ key: `${contextKey}:${key}`, kind: "loading" });
    setSourceTarget({ key, file, evidence, label, requested });
  }

  function closeSource() {
    if (sourceDialog.current?.open) sourceDialog.current.close();
    else handleSourceDialogClose();
  }

  function handleSourceDialogClose() {
    sourceGeneration.current += 1;
    sourceController.current?.abort();
    sourceController.current = null;
    if (isMounted.current) {
      if (sourceTarget) setSourceTarget(null);
      setSourceState(null);
      setSourceAttempt(0);
    }
    const returnFocus = sourceReturnFocus.current;
    sourceReturnFocus.current = null;
    const shouldRestoreFocus = restoreSourceFocus.current;
    restoreSourceFocus.current = true;
    if (isMounted.current && shouldRestoreFocus && returnFocus?.isConnected) requestAnimationFrame(() => returnFocus.focus());
  }

  function sourceButton(evidence: EvidenceSpan, label: string, files: readonly NodeInspectorFile[], testId: string) {
    const file = fileForEvidence(files, evidence);
    if (!file) return <span className={styles.inspectorUnavailable}>Source snapshot untuk lokasi ini tidak tersedia.</span>;
    return <button
      type="button"
      className={styles.inspectorSourceAction}
      data-testid={testId}
      aria-label={`Buka bukti source ${label}, baris ${evidence.startLine} sampai ${evidence.endLine}`}
      onClick={(event) => openSource(evidence, file, label, event.currentTarget)}
    >Buka source, baris {evidence.startLine}–{evidence.endLine}</button>;
  }

  function relationList(title: string, direction: "incoming" | "outgoing", relations: readonly NodeInspectorRelation[], files: readonly NodeInspectorFile[]) {
    const incoming = direction === "incoming";
    return <section className={styles.inspectorRelationGroup} aria-labelledby={`node-inspector-${direction}-title`}>
      <h3 id={`node-inspector-${direction}-title`}>{title} <span>({relations.length})</span></h3>
      {relations.length === 0 ? <p className={styles.inspectorEmpty}>Tidak ada relasi {incoming ? "masuk" : "keluar"} langsung.</p> : <ul className={styles.inspectorRelations} data-testid={`node-inspector-${direction}`}>
        {relations.map(({ edge, peer }, index) => <li key={`${edge.id}:${index}`} data-testid={`node-inspector-${direction}-edge`} data-edge-id={edge.id}>
          <p className={styles.inspectorRelationFlow}>
            <span>{incoming ? peer.name : node?.name}</span><span aria-hidden="true"> → </span><span>{incoming ? node?.name : peer.name}</span>
          </p>
          <p className={styles.inspectorRelationMeta}>
            <code>{edge.kind}</code><span className={edge.resolution === "Unresolved" ? styles.inspectorUnresolved : styles.inspectorExact}>{edge.resolution}</span>
            {edge.unresolvedReason ? <span>Alasan: {edge.unresolvedReason}</span> : null}
          </p>
          <p className={styles.inspectorPeer}>{peer.kind} · <code>{peer.qualifiedName}</code></p>
          {edge.evidence.length ? <ul className={styles.inspectorEvidenceList}>
            {edge.evidence.map((evidence, evidenceIndex) => <li key={`${evidence.filePath}:${evidence.startByte}:${evidenceIndex}`}>
              <EvidenceLocation evidence={evidence} />
              {sourceButton(evidence, `${edge.kind} ${evidence.role}`, files, "relation-source-action")}
            </li>)}
          </ul> : <p className={styles.inspectorUnavailable}>Bukti lokasi relasi tidak tersedia.</p>}
        </li>)}
      </ul>}
    </section>;
  }

  const ready = detail.kind === "ready" ? detail.value : null;
  const currentSource = source?.kind === "ready" ? source.value : null;
  const sourceFullyCoversEvidence = !!currentSource && sourceTarget !== null &&
    currentSource.startLine <= sourceTarget.evidence.startLine && currentSource.endLine >= sourceTarget.evidence.endLine;

  return <>
    <section className={styles.nodeInspector} aria-labelledby="node-inspector-title" data-testid="node-inspector" data-node-id={nodeId}>
      <div className={styles.inspectorHeader}>
        <div>
          <p className={styles.inspectorEyebrow}>INSPEKTOR NODE · GRAPH KANONIK</p>
          <h2 id="node-inspector-title" data-testid="node-inspector-title">{node?.name ?? "Detail node"}</h2>
        </div>
        <button type="button" data-testid="node-inspector-close" className={styles.inspectorClose} onClick={onClose} aria-label="Tutup inspektor node">Tutup</button>
      </div>

      {detail.kind === "loading" ? <p className={styles.inspectorStatus} role="status">Memuat detail dan relasi langsung node…</p> : null}
      {detail.kind === "identity" ? <p className={styles.inspectorStatus} role="status">Memeriksa kembali akun aktif…</p> : null}
      {detail.kind === "unavailable" || detail.kind === "error" ? <div className={styles.inspectorError} role={detail.kind === "error" ? "alert" : "status"}>
        <p>{detail.message}</p>
        <button type="button" data-testid="node-inspector-retry" className={styles.inspectorRetry} onClick={() => void loadNode()}>Coba lagi</button>
      </div> : null}

      {ready ? <>
        <dl className={styles.inspectorDetails}>
          <div><dt>Jenis</dt><dd>{ready.node.kind}</dd></div>
          <div><dt>Nama lengkap</dt><dd><code>{ready.node.qualifiedName}</code></dd></div>
          <div><dt>Bahasa</dt><dd>{ready.node.language}</dd></div>
          <div><dt>Origin</dt><dd>{ready.node.origin}</dd></div>
          <div><dt>Berkas</dt><dd><code>{ready.node.filePath ?? "Tidak tersedia"}</code></dd></div>
        </dl>

        <section className={styles.inspectorLocation} aria-label="Lokasi AST node">
          <h3>Lokasi AST</h3>
          {ready.node.location ? <>
            <EvidenceLocation evidence={ready.node.location} />
            {ready.node.origin === "unresolved" || ready.node.kind === "UnresolvedReference" ?
              <p className={styles.inspectorUnavailable}>Node belum memiliki deklarasi source.</p> :
              <div>{sourceButton(ready.node.location, "deklarasi node", ready.files, "node-inspector-source")}</div>}
          </> : <p className={styles.inspectorUnavailable}>Lokasi deklarasi tidak tersedia.</p>}
        </section>

        <p className={styles.inspectorCanonicalNote}>Relasi langsung berasal dari graph kanonik, terlepas dari kueri, filter jenis, dan mode tampilan.</p>
        <div className={styles.inspectorRelationColumns}>
          {relationList("Relasi masuk", "incoming", ready.incoming, ready.files)}
          {relationList("Relasi keluar", "outgoing", ready.outgoing, ready.files)}
        </div>
      </> : null}
    </section>

    <dialog
      ref={sourceDialog}
      className={styles.nodeSourceDialog}
      data-testid="node-source-dialog"
      aria-labelledby="node-source-dialog-title"
      onCancel={(event) => { event.preventDefault(); closeSource(); }}
      onClose={handleSourceDialogClose}
    >
      {sourceTarget ? <div className={styles.sourceDialogContent}>
        <div className={styles.sourceDialogHeader}>
          <div>
            <p className={styles.inspectorEyebrow}>SOURCE EVIDENCE</p>
            <h2 id="node-source-dialog-title">{sourceTarget.label}</h2>
            <code>{sourceTarget.file.path}</code>
          </div>
          <button type="button" className={styles.inspectorClose} onClick={closeSource} aria-label="Tutup source evidence">Tutup</button>
        </div>
        <dl className={styles.sourceContext}>
          <div><dt>Repository · branch · commit snapshot</dt><dd><code>{formatSnapshot(snapshot)}</code></dd></div>
          <div><dt>Hash CKG</dt><dd><code>{ckgSha256}</code></dd></div>
          <div><dt>SHA-256 file snapshot</dt><dd><code>{sourceTarget.file.sha256}</code></dd></div>
          <div><dt>Batas AST</dt><dd><code>bytes {sourceTarget.evidence.startByte}–{sourceTarget.evidence.endByte} (akhir eksklusif) · baris {sourceTarget.evidence.startLine}:{sourceTarget.evidence.startColumn}–{sourceTarget.evidence.endLine}:{sourceTarget.evidence.endColumn}</code></dd></div>
        </dl>

        {source?.kind === "loading" || !source ? <p className={styles.inspectorStatus} role="status">Memuat rentang source di sekitar bukti…</p> : null}
        {source?.kind === "identity" ? <p className={styles.inspectorStatus} role="status">Memeriksa kembali akun aktif…</p> : null}
        {source?.kind === "unavailable" || source?.kind === "error" ? <div className={styles.inspectorError} role={source.kind === "error" ? "alert" : "status"}>
          <p>{source.message}</p>
          <button type="button" data-testid="node-source-retry" className={styles.inspectorRetry} onClick={() => {
            if (sourceRequestKey) setSourceState({ key: sourceRequestKey, kind: "loading" });
            setSourceAttempt((attempt) => attempt + 1);
          }}>Coba lagi</button>
        </div> : null}
        {currentSource && sourceTarget ? <>
          <div className={styles.sourcePreviewHeader}>
            <p>Pratinjau source · baris {currentSource.startLine}–{currentSource.endLine} dari {currentSource.totalLines}</p>
            <p>Batas AST tetap {sourceTarget.evidence.startLine}:{sourceTarget.evidence.startColumn}–{sourceTarget.evidence.endLine}:{sourceTarget.evidence.endColumn}.</p>
          </div>
          {!sourceFullyCoversEvidence ? <p className={styles.inspectorUnavailable} role="note">Rentang source yang ditampilkan hanya mencakup bagian bukti yang ada pada baris {currentSource.startLine}–{currentSource.endLine}; batas AST lengkap tetap dicantumkan di atas.</p> : null}
          <div className={styles.sourcePreview}>
            <SourceLines payload={currentSource} evidence={sourceTarget.evidence} />
          </div>
          <p className={styles.sourceDialogNote}>Baris yang beririsan dengan bukti disorot utuh; kolom dan rentang byte menunjukkan batas AST. Pratinjau tidak mengeksekusi source.</p>
        </> : null}
      </div> : null}
    </dialog>
  </>;
}
