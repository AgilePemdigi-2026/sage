"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { AssetIcon, Badge, DesignFrame, Panel } from "../design-system/ui.tsx";
import { formatDateTime, statusLabel, statusTone } from "./format.ts";
import styles from "../sprint-ui/preview-client.module.css";

type HistoryItem = {
  id: string;
  repository: { fullName: string };
  branch: string;
  commitSha: string;
  status: string;
  errorCode: string | null;
  queuedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  retryOfAnalysisId: string | null;
};

const STATUS_OPTIONS = ["QUEUED", "RUNNING", "COMPLETED", "COMPLETED_WITH_LIMITATIONS", "FAILED"] as const;

export function HistoryClient({ accountKey }: { accountKey: string }) {
  const [items, setItems] = useState<HistoryItem[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  const [error, setError] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const queryRef = useRef(query);
  const statusRef = useRef(status);
  useEffect(() => { queryRef.current = query; statusRef.current = status; }, [query, status]);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      const params = new URLSearchParams();
      const search = query.trim();
      if (search) params.set("query", search);
      if (status) params.set("status", status);
      try {
        const response = await fetch(`/api/analyses${params.size ? `?${params.toString()}` : ""}`, {
          headers: { "X-SAGE-Account": accountKey }, cache: "no-store", signal: controller.signal,
        });
        if (!response.ok) { setError(true); return; }
        const body = await response.json() as { data: { analyses: HistoryItem[]; nextCursor: string | null } };
        setError(false);
        setItems(body.data.analyses);
        setNextCursor(body.data.nextCursor);
      } catch (caught) {
        if ((caught as Error).name !== "AbortError") setError(true);
      } finally {
        setLoaded(true);
      }
    })();
    return () => controller.abort();
  }, [query, status, accountKey, reloadKey]);

  async function loadMore() {
    const cursor = nextCursor;
    if (!cursor) return;
    setNextCursor(null);
    try {
      const params = new URLSearchParams();
      if (queryRef.current.trim()) params.set("query", queryRef.current.trim());
      if (statusRef.current) params.set("status", statusRef.current);
      params.set("cursor", cursor);
      const response = await fetch(`/api/analyses?${params.toString()}`, {
        headers: { "X-SAGE-Account": accountKey }, cache: "no-store",
      });
      if (!response.ok) { setError(true); return; }
      const body = await response.json() as { data: { analyses: HistoryItem[]; nextCursor: string | null } };
      setItems(previous => [...(previous ?? []), ...body.data.analyses]);
      setNextCursor(body.data.nextCursor);
    } catch {
      setError(true);
    }
  }

  const trimmed = query.trim();
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
          <option value={STATUS_OPTIONS[0]}>{statusLabel(STATUS_OPTIONS[0]) ?? STATUS_OPTIONS[0]}</option>
          <option value={STATUS_OPTIONS[1]}>{statusLabel(STATUS_OPTIONS[1]) ?? STATUS_OPTIONS[1]}</option>
          <option value={STATUS_OPTIONS[2]}>{statusLabel(STATUS_OPTIONS[2]) ?? STATUS_OPTIONS[2]}</option>
          <option value={STATUS_OPTIONS[3]}>{statusLabel(STATUS_OPTIONS[3]) ?? STATUS_OPTIONS[3]}</option>
          <option value={STATUS_OPTIONS[4]}>{statusLabel(STATUS_OPTIONS[4]) ?? STATUS_OPTIONS[4]}</option>
        </select>
      </label>
      {(trimmed || status) ? (
        <button type="button" className={styles.textAction} onClick={() => { setQuery(""); setStatus(""); }}>Hapus filter</button>
      ) : null}
    </Panel>
    <Panel title="Daftar" className={styles.historyPanel}>
      {!loaded ? <div className={styles.loadingRows} role="status" aria-label="Memuat riwayat">{[0, 1].map(index => <div key={index}><span /><span /><span /></div>)}</div> : null}
      {error && !items ? <div className={styles.historyMessage} role="alert">
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
      {loaded && !error && items && items.length > 0 ? <>
        <div className={styles.historyColumns} aria-hidden="true"><span>Repository dan commit</span><span>Branch</span><span>Status</span><span>Aksi</span></div>
        {items.map(item => (
          <div className={styles.historyRow} key={item.id}>
            <div><strong>{item.repository.fullName}</strong><span className={styles.shaShort}>{item.commitSha.slice(0, 7)}</span><small>Diantrekan {formatDateTime(item.queuedAt)}{item.completedAt ? ` · Selesai ${formatDateTime(item.completedAt)}` : ""}</small></div>
            <code>{item.branch || "—"}</code>
            <Badge tone={statusTone(item.status) ?? "neutral"}>{statusLabel(item.status) ?? item.status}</Badge>
            <Link href={`/analyses/${item.id}`}>Buka</Link>
          </div>
        ))}
        {nextCursor ? <button type="button" className={styles.textAction} onClick={() => void loadMore()}>Muat lebih banyak</button> : null}
      </> : null}
    </Panel>
    <p className={styles.historyFootnote}>Status diperbarui saat halaman dimuat; halaman detail analisis melakukan pembaruan otomatis.</p>
  </DesignFrame>;
}
