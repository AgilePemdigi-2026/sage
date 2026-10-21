"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { AssetIcon, Badge, DesignFrame, Panel } from "../design-system/ui.tsx";
import { formatDateTime, statusLabel, statusTone } from "./format.ts";
import { applyHistoryPatch, createHistoryData } from "./history-data.ts";
import type { HistoryItem, HistoryPatchTarget } from "./history-data.ts";
import styles from "../sprint-ui/preview-client.module.css";

const STATUS_OPTIONS = ["QUEUED", "RUNNING", "COMPLETED", "COMPLETED_WITH_LIMITATIONS", "FAILED"] as const;

export function HistoryClient({ accountKey }: { accountKey: string }) {
  const [items, setItems] = useState<HistoryItem[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  const [error, setError] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  /** Target state dan mesin data dibuat sekali: setState dari useState stabil, dan pola
   * ini menghindari akses ref saat render (react-hooks/refs). */
  const [target] = useState<HistoryPatchTarget>(() => ({
    updateItems: updater => { setItems(previous => updater(previous)); },
    setItems: value => { setItems(value); },
    setNextCursor: value => { setNextCursor(value); },
    setError: value => { setError(value); },
    setLoaded: value => { setLoaded(value); },
  }));
  const data = useMemo(() => createHistoryData({
    fetch: (input, init) => fetch(input, init),
    apply: patch => applyHistoryPatch(target, patch),
  }), [target]);

  useEffect(() => {
    const controller = new AbortController();
    data.reload(accountKey, query, status, controller.signal);
    return () => controller.abort();
  }, [query, status, accountKey, reloadKey, data]);

  const load = nextCursor ? () => {
    const cursor = nextCursor;
    data.loadMore(accountKey, query, status, cursor);
  } : null;

  const trimmed = query.trim();
  const renderRow = (item: HistoryItem) => (
    <div className={styles.historyRow} key={item.id}>
      <div><strong>{item.repository.fullName}</strong><span className={styles.shaShort}>{item.commitSha.slice(0, 7)}</span><small>Diantrekan {formatDateTime(item.queuedAt)}{item.completedAt ? ` · Selesai ${formatDateTime(item.completedAt)}` : ""}</small></div>
      <code>{item.branch || "—"}</code>
      <Badge tone={statusTone(item.status) ?? "neutral"}>{statusLabel(item.status) ?? item.status}</Badge>
      <Link href={`/analyses/${item.id}`}>Buka</Link>
    </div>
  );
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
      {!loaded ? <div className={styles.loadingRows} role="status" aria-label="Memuat riwayat">{[0, 1].map(index => <div key={index}><span /><span /><span /></div>)}</div> : null}
      {error ? <div className={styles.historyMessage} role="alert">
        <AssetIcon group="history-error" name="imgIcon2" />
        <div><strong>Riwayat gagal dimuat</strong><p>Periksa koneksi lalu muat ulang halaman.</p></div>
        <button type="button" className={styles.textAction} onClick={() => setReloadKey(key => key + 1)}>Coba lagi</button>
      </div> : null}
      {loaded && !error && items?.length === 0 && !trimmed && !status ? <div className={styles.historyMessage}>
        <AssetIcon group="history-empty" name="imgIcon1" />
        <div><strong>Belum ada analisis</strong><p>Pilih repository untuk memulai analisis pertama.</p></div>
        <Link className={styles.secondaryAction} href="/workspace/repositories">Pilih repository</Link>
      </div> : null}
      {loaded && !error && items?.length === 0 && (trimmed || status) ? <div className={styles.historyMessage}>
        <AssetIcon group="history-empty" name="imgIcon" />
        <div><strong>Tidak ada hasil untuk {trimmed ? `“${trimmed}”` : "filter ini"}</strong><p>Pencarian memeriksa repository, branch, dan SHA.</p></div>
        <button type="button" className={styles.textAction} onClick={() => { setQuery(""); setStatus(""); }}>Hapus filter</button>
      </div> : null}
      {loaded && items && items.length > 0 ? <>
        <div className={styles.historyColumns} aria-hidden="true"><span>Repository dan commit</span><span>Branch</span><span>Status</span><span>Aksi</span></div>
        {items.map(renderRow)}
        {load ? <button type="button" className={styles.textAction} onClick={() => load()}>Muat lebih banyak</button> : null}
      </> : null}
    </Panel>
    <p className={styles.historyFootnote}>Status diperbarui saat halaman dimuat; halaman detail analisis melakukan pembaruan otomatis.</p>
  </DesignFrame>;
}
