"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { AssetIcon, Badge, Button, CopySha, DesignFrame, EmptyState, Field, MaskIcon, PageHead, Panel, PillButton, SkeletonRows } from "../design-system/ui.tsx";
import designStyles from "../design-system/ui.module.css";
import { analysisStatusBadge, formatDateTime } from "./format.ts";
import { elapsedAnalysisSeconds } from "./detail-data.ts";
import { formatStageDuration } from "./stage-duration.ts";
import { applyHistoryPatch, createHistoryData, historyDeletionControls } from "./history-data.ts";
import type { HistoryDeletionAction, HistoryItem, HistoryPatchTarget } from "./history-data.ts";
import css from "./history.module.css";
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
  const filtersActive = Boolean(trimmed || status);
  const clearFilters = () => { setQuery(""); setStatus(""); };
  const renderRow = (item: HistoryItem, index: number) => {
    const action = deletionActions[item.id];
    const deletionStatus = item.deletion?.status;
    const deletionControls = historyDeletionControls(item, action, data.isDeletionActive(item.id));
    const failureMessage = (action?.phase === "failed" ? action.message : null) ?? (item.deletion?.errorCode
      ? `Pembersihan sebelumnya gagal (${item.deletion.errorCode}). Coba lagi untuk menghapus analisis.`
      : "Pembersihan sebelumnya gagal. Coba lagi untuk menghapus analisis.");
    const badge = analysisStatusBadge(item.status);
    // Durasi hanya dari data yang ada (diantrekan → selesai); analisis aktif/tanpa waktu selesai → "—".
    const durationSeconds = elapsedAnalysisSeconds({ queuedAt: item.queuedAt, completedAt: item.completedAt }, item.status, Number.NaN);
    return <li className={css.row} key={item.id} style={{ "--i": Math.min(index, 10) } as CSSProperties}>
      <div className={css.repo}>
        <span className={css.repoName} title={item.repository.fullName}>{item.repository.fullName}</span>
        <span className={css.branch}><MaskIcon group="repository" name="imgBranch" size={13} /><span className={designStyles.srOnly}>Branch </span><span>{item.branch || "—"}</span></span>
      </div>
      <div className={css.commit}><span className={css.chip}><AssetIcon group="progress-v2" name="imgCommit" /><CopySha sha={item.commitSha} label={item.commitSha.slice(0, 7)} /></span></div>
      <span className={css.meta}>
        <span className={css.languages}>{item.languages?.length ? item.languages.join(", ") : "Belum terdeteksi"}</span>
        <span className={css.duration}><span className={designStyles.srOnly}>Durasi </span>{formatStageDuration(durationSeconds)}</span>
        <span className={css.date}><span className={designStyles.srOnly}>Diantrekan </span>{formatDateTime(item.queuedAt)}</span>
      </span>
      <span className={css.status}><Badge tone={badge.tone} pulse={item.status === "RUNNING"}>{badge.label}</Badge></span>
      <div className={`${deletionStyles.rowActions} ${css.actions}`}>
        {!item.deletion ? <Link className={css.open} href={`/analyses/${item.id}`}>Buka<AssetIcon group="repository" name="imgChevronRight" className={css.chevron} /></Link> : null}
        {deletionControls.pending ? <span className={deletionStyles.pending} role="status">
          <span className={deletionStyles.spinner} aria-hidden="true" />
          {action?.message ?? (deletionStatus === "RUNNING" ? "Penghapusan sedang berjalan" : "Penghapusan sedang menunggu")}
        </span> : null}
        {deletionControls.failed ? <span className={deletionStyles.failure} role="alert">{failureMessage}</span> : null}
        <button
          type="button"
          className={deletionStyles.deleteAction}
          disabled={deletionControls.deleteDisabled}
          aria-label={`${deletionControls.failed ? "Coba hapus lagi" : "Hapus"} analisis ${item.repository.fullName}`}
          title={item.status === "QUEUED" || item.status === "RUNNING" ? "Analisis yang masih aktif tidak dapat dihapus." : undefined}
          onClick={() => setConfirming({ item, accountKey })}
        >{deletionControls.failed ? "Coba hapus lagi" : "Hapus"}</button>
      </div>
    </li>;
  };
  return <DesignFrame active="history">
    <PageHead
      breadcrumb={[{ label: "Workspace", href: "/workspace" }, { label: "Riwayat" }]}
      title="Riwayat analisis"
      description="Semua analisis milik akunmu, dengan status terbarui. Buka hasil atau hapus beserta artefaknya."
      aside={<Button href="/workspace/repositories" size="lg">Analisis baru</Button>}
    />
    <div className={css.toolbar}>
      <Field className={css.search} label="Cari repository, branch, atau SHA" hideLabel type="search" icon={<MaskIcon group="repository" name="imgSearch" size={18} />} value={query} onChange={event => setQuery(event.target.value)} placeholder="Cari repository, branch, atau SHA" />
      <div className={css.filters} role="group" aria-label="Filter status">
        <PillButton pressed={status === ""} onClick={() => setStatus("")}>Semua</PillButton>
        {STATUS_OPTIONS.map(option => <PillButton key={option} pressed={status === option} onClick={() => setStatus(option)}>{analysisStatusBadge(option).label}</PillButton>)}
      </div>
      {filtersActive ? <Button variant="link" onClick={clearFilters}>Hapus filter</Button> : null}
    </div>
    <Panel className={css.card}>
      {!visibleLoaded ? <div className={css.state}><SkeletonRows rows={4} label="Memuat riwayat" /></div> : null}
      {visibleError ? <div className={css.state}><EmptyState tone="error" role="alert" icon={{ group: "repository", name: "imgRepo" }} title="Riwayat gagal dimuat" action={<Button variant="secondary" onClick={() => setReloadKey(key => key + 1)}>Coba lagi</Button>}>Periksa koneksi lalu muat ulang halaman.</EmptyState></div> : null}
      {visibleLoaded && !visibleError && visibleItems?.length === 0 && !filtersActive ? <div className={css.state}>
        <EmptyState icon={{ group: "repository", name: "imgRepo" }} title="Belum ada riwayat analisis" action={<Button href="/workspace/repositories" variant="secondary">Pilih repository</Button>}>Pilih repository untuk memulai analisis pertama.</EmptyState>
      </div> : null}
      {visibleLoaded && !visibleError && visibleItems?.length === 0 && filtersActive ? <div className={css.state}>
        <EmptyState icon={{ group: "repository", name: "imgSearch" }} title={<>Tidak ada hasil untuk {trimmed ? `“${trimmed}”` : "filter ini"}</>} action={<Button variant="link" onClick={clearFilters}>Hapus filter</Button>}>Pencarian memeriksa repository, branch, dan SHA.</EmptyState>
      </div> : null}
      {visibleLoaded && visibleItems && visibleItems.length > 0 ? <>
        <div className={css.columns} aria-hidden="true"><span>Repository</span><span>Commit</span><span>Bahasa</span><span>Durasi</span><span>Tanggal</span><span>Status</span><span>Aksi</span></div>
        <ul className={css.list} aria-label="Daftar riwayat analisis">{visibleItems.map(renderRow)}</ul>
        {load ? <div className={css.loadMore}><Button variant="link" onClick={() => load()}>Muat lebih banyak</Button></div> : null}
      </> : null}
    </Panel>
    <p className={css.footnote}>Status diperbarui saat halaman dimuat; halaman detail analisis melakukan pembaruan otomatis.</p>
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
          <Button variant="secondary" onClick={() => setConfirming(null)}>Batalkan</Button>
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
