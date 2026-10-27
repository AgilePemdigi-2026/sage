"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { AssetIcon, Badge, DesignFrame, Panel } from "../design-system/ui.tsx";
import { formatDateTime, statusLabel, statusTone } from "./format.ts";
import { applyHistoryPatch, createHistoryData } from "./history-data.ts";
import type { HistoryDeletionAction, HistoryItem, HistoryPatchTarget } from "./history-data.ts";
import styles from "../sprint-ui/preview-client.module.css";
import deletionStyles from "./history-delete.module.css";

const STATUS_OPTIONS = ["QUEUED", "RUNNING", "COMPLETED", "COMPLETED_WITH_LIMITATIONS", "FAILED"] as const;

export function HistoryClient({ accountKey }: { accountKey: string }) {
  const [items, setItems] = useState<HistoryItem[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  const [error, setError] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [deletionActions, setDeletionActions] = useState<Record<string, HistoryDeletionAction>>({});
  const [confirming, setConfirming] = useState<{ item: HistoryItem; accountKey: string } | null>(null);
  const deleteDialog = useRef<HTMLDialogElement>(null);

  /** Target state dan mesin data dibuat sekali: setState dari useState stabil, dan pola
   * ini menghindari akses ref saat render (react-hooks/refs). */
  const [target] = useState<HistoryPatchTarget>(() => ({
    updateItems: updater => { setItems(previous => updater(previous)); },
    setItems: value => { setItems(value); },
    setNextCursor: value => { setNextCursor(value); },
    setError: value => { setError(value); },
    setLoaded: value => { setLoaded(value); },
    setDeletion: (analysisId, deletion) => {
      setItems(previous => previous?.map(item => item.id === analysisId ? { ...item, deletion } : item) ?? previous);
    },
    setDeletionAction: (analysisId, action) => {
      setDeletionActions(previous => {
        if (action === null) {
          if (!(analysisId in previous)) return previous;
          const remaining = { ...previous };
          delete remaining[analysisId];
          return remaining;
        }
        return { ...previous, [analysisId]: action };
      });
    },
    clearDeletionActions: () => { setDeletionActions({}); },
  }));
  const data = useMemo(() => createHistoryData({
    fetch: (input, init) => fetch(input, init),
    apply: patch => applyHistoryPatch(target, patch),
    onAnalysisDeleted: () => { setReloadKey(key => key + 1); },
  }), [target]);
  const accountIsActive = data.isAccountActive(accountKey);

  useEffect(() => {
    const controller = new AbortController();
    data.reload(accountKey, query, status, controller.signal);
    return () => controller.abort();
  }, [query, status, accountKey, reloadKey, data]);

  useEffect(() => {
    return () => {
      setConfirming(current => current?.accountKey === accountKey ? null : current);
    };
  }, [accountKey]);

  const activeConfirmation = confirming?.accountKey === accountKey ? confirming : null;

  useEffect(() => {
    const dialog = deleteDialog.current;
    if (!activeConfirmation || !dialog) return;
    if (!dialog.open) dialog.showModal();
    dialog.querySelector<HTMLButtonElement>("[data-confirm-delete]")?.focus();
    return () => { if (dialog.open) dialog.close(); };
  }, [activeConfirmation]);

  const load = nextCursor ? () => {
    const cursor = nextCursor;
    data.loadMore(accountKey, query, status, cursor);
  } : null;

  const trimmed = query.trim();
  const visibleItems = accountIsActive ? items : null;
  const visibleError = accountIsActive && error;
  const visibleLoaded = accountIsActive && loaded;
  const renderRow = (item: HistoryItem) => {
    const action = deletionActions[item.id];
    const deletionStatus = item.deletion?.status;
    const deleting = deletionStatus === "QUEUED" || deletionStatus === "RUNNING" || action?.phase === "submitting" || action?.phase === "pending";
    const deleteDisabled = item.status === "QUEUED" || item.status === "RUNNING" || deleting;
    const failed = deletionStatus === "FAILED" || action?.phase === "failed";
    const failureMessage = action?.message ?? (item.deletion?.errorCode
      ? `Pembersihan sebelumnya gagal (${item.deletion.errorCode}). Coba lagi untuk menghapus analisis.`
      : "Pembersihan sebelumnya gagal. Coba lagi untuk menghapus analisis.");
    return <div className={styles.historyRow} key={item.id}>
      <div><strong>{item.repository.fullName}</strong><span className={styles.shaShort}>{item.commitSha.slice(0, 7)}</span><small>Diantrekan {formatDateTime(item.queuedAt)}{item.completedAt ? ` · Selesai ${formatDateTime(item.completedAt)}` : ""}</small></div>
      <code>{item.branch || "—"}</code>
      <Badge tone={statusTone(item.status) ?? "neutral"}>{statusLabel(item.status) ?? item.status}</Badge>
      <div className={deletionStyles.rowActions}>
        {!item.deletion ? <Link href={`/analyses/${item.id}`}>Buka</Link> : null}
        {deleting ? <span className={deletionStyles.pending} role="status">
          <span className={deletionStyles.spinner} aria-hidden="true" />
          {action?.message ?? (deletionStatus === "RUNNING" ? "Penghapusan sedang berjalan" : "Penghapusan sedang menunggu")}
        </span> : null}
        {failed ? <span className={deletionStyles.failure} role="alert">{failureMessage}</span> : null}
        <button
          type="button"
          className={deletionStyles.deleteAction}
          disabled={deleteDisabled}
          aria-label={`${failed ? "Coba hapus lagi" : "Hapus"} analisis ${item.repository.fullName}`}
          title={item.status === "QUEUED" || item.status === "RUNNING" ? "Analisis yang masih aktif tidak dapat dihapus." : undefined}
          onClick={() => setConfirming({ item, accountKey })}
        >{failed ? "Coba hapus lagi" : "Hapus"}</button>
      </div>
    </div>;
  };
  return <DesignFrame active="history">
    <div className={styles.breadcrumb}>Workspace <span>/</span> Riwayat</div>
    <div className={styles.pageHeading}>
      <p className={styles.eyebrow}>02 / RIWAYAT</p>
      <h1>Riwayat analisis</h1>
      <p className={styles.muted}>Daftar analisis milik akun yang masuk, dengan status terbarui.</p>
    </div>
    <Panel title="Filter" className={styles.historyPanel}>
      <label className={styles.searchField}>Cari repository, branch, atau SHA
        <input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Contoh: report-service" />
      </label>
      <label className={styles.searchField}>Status
        <select value={status} onChange={event => setStatus(event.target.value)}>
          <option value="">Semua</option>
          {STATUS_OPTIONS.map(option => <option key={option} value={option}>{statusLabel(option) ?? option}</option>)}
        </select>
      </label>
      {(trimmed || status) ? (
        <button type="button" className={styles.textAction} onClick={() => { setQuery(""); setStatus(""); }}>Hapus filter</button>
      ) : null}
    </Panel>
    <Panel title="Daftar" className={styles.historyPanel}>
      {!visibleLoaded ? <div className={styles.loadingRows} role="status" aria-label="Memuat riwayat">{[0, 1].map(index => <div key={index}><span /><span /><span /></div>)}</div> : null}
      {visibleError ? <div className={styles.historyMessage} role="alert">
        <AssetIcon group="history-error" name="imgIcon2" />
        <div><strong>Riwayat gagal dimuat</strong><p>Periksa koneksi lalu muat ulang halaman.</p></div>
        <button type="button" className={styles.textAction} onClick={() => setReloadKey(key => key + 1)}>Coba lagi</button>
      </div> : null}
      {visibleLoaded && !visibleError && visibleItems?.length === 0 && !trimmed && !status ? <div className={styles.historyMessage}>
        <AssetIcon group="history-empty" name="imgIcon1" />
        <div><strong>Belum ada analisis</strong><p>Pilih repository untuk memulai analisis pertama.</p></div>
        <Link className={styles.secondaryAction} href="/workspace/repositories">Pilih repository</Link>
      </div> : null}
      {visibleLoaded && !visibleError && visibleItems?.length === 0 && (trimmed || status) ? <div className={styles.historyMessage}>
        <AssetIcon group="history-empty" name="imgIcon" />
        <div><strong>Tidak ada hasil untuk {trimmed ? `“${trimmed}”` : "filter ini"}</strong><p>Pencarian memeriksa repository, branch, dan SHA.</p></div>
        <button type="button" className={styles.textAction} onClick={() => { setQuery(""); setStatus(""); }}>Hapus filter</button>
      </div> : null}
      {visibleLoaded && visibleItems && visibleItems.length > 0 ? <>
        <div className={styles.historyColumns} aria-hidden="true"><span>Repository dan commit</span><span>Branch</span><span>Status</span><span>Aksi</span></div>
        {visibleItems.map(renderRow)}
        {load ? <button type="button" className={styles.textAction} onClick={() => load()}>Muat lebih banyak</button> : null}
      </> : null}
    </Panel>
    <p className={styles.historyFootnote}>Status diperbarui saat halaman dimuat; halaman detail analisis melakukan pembaruan otomatis.</p>
    <dialog
      ref={deleteDialog}
      className={deletionStyles.dialog}
      aria-labelledby="history-delete-title"
      aria-describedby="history-delete-description"
      onCancel={event => { event.preventDefault(); setConfirming(null); }}
    >
      {activeConfirmation ? <div className={deletionStyles.dialogContent}>
        <p className={deletionStyles.dialogEyebrow}>HAPUS ANALISIS</p>
        <h2 id="history-delete-title">Hapus {activeConfirmation.item.repository.fullName}?</h2>
        <p id="history-delete-description">
          Arsip analisis, graph, dokumentasi, serta ekspor PDF dan Markdown akan dihapus secara permanen. Analisis turunan tetap ada, tetapi tautan ke analisis induk ini mungkin terhapus. Tindakan ini tidak dapat dibatalkan.
        </p>
        <div className={deletionStyles.dialogActions}>
          <button type="button" className={styles.textAction} onClick={() => setConfirming(null)}>Batalkan</button>
          <button
            type="button"
            data-confirm-delete
            className={deletionStyles.confirmAction}
            onClick={() => {
              const confirmation = activeConfirmation;
              setConfirming(null);
              data.deleteAnalysis(confirmation.accountKey, confirmation.item.id);
            }}
          >Hapus permanen</button>
        </div>
      </div> : null}
    </dialog>
  </DesignFrame>;
}
