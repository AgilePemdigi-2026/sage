"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { AssetIcon, Badge, DesignFrame, Panel } from "../design-system/ui.tsx";
import { formatDateTime, statusLabel, statusTone } from "./format.ts";
import { createDetailPoller } from "./detail-data.ts";
import type { AnalysisDetailView } from "../../lib/analyses/presenters.ts";
import styles from "../sprint-ui/preview-client.module.css";

/** Bentuk payload server (presenters.ts) — di-derive, tidak ditulis manual. */
export type DetailView = AnalysisDetailView;
export type StageView = DetailView["stages"][number];

const NON_TERMINAL = ["QUEUED", "RUNNING"] as const;
function isTerminal(status: string) {
  return !(NON_TERMINAL as readonly string[]).includes(status);
}

export function AnalysisDetailClient({ analysisId, accountKey, initial, reason }: {
  analysisId: string; accountKey: string; initial: DetailView | null; reason: "not-found" | null;
}) {
  const [detail, setDetail] = useState<DetailView | null>(initial);
  const [fetchError, setFetchError] = useState(false);
  const sequenceRef = useRef(0);

  useEffect(() => {
    if (reason === "not-found" || !detail || isTerminal(detail.status)) return;
    const poller = createDetailPoller({
      analysisId, accountKey, intervalMs: 3000,
      fetch: (input, init) => fetch(input, init),
      scheduleInterval: (callback, ms) => window.setInterval(callback, ms),
      cancelInterval: handle => { window.clearInterval(handle); },
      // URUTAN PERMINTAAN: nomor monoton lintas interval; dua poll yang tumpang tindih
      // (respons > 3 detik) tidak boleh saling menimpa snapshot tahap.
      touchSequence: () => { sequenceRef.current += 1; return sequenceRef.current; },
      isLatestSequence: sequence => sequenceRef.current === sequence,
      setFetchError: value => { setFetchError(value); },
      setDetail: updater => { setDetail(updater); },
    });
    poller.start();
    return () => { poller.stop(); };
  }, [detail, reason, analysisId, accountKey]);

  if (reason === "not-found") return <DesignFrame>
    <div className={styles.breadcrumb}>Workspace <span>/</span> <Link href="/workspace/history">Riwayat</Link></div>
    <div className={styles.historyMessage} role="alert">
      <AssetIcon group="history-error" name="imgIcon2" />
      <div><strong>Analisis tidak ditemukan</strong><p>Record ini bukan milik akun yang masuk, atau sudah dihapus.</p></div>
      <Link className={styles.secondaryAction} href="/workspace/history">Kembali ke riwayat</Link>
    </div>
  </DesignFrame>;
  if (!detail) return <DesignFrame>
    <div className={styles.historyMessage} role="status"><AssetIcon group="history-empty" name="imgIcon1" /><div><strong>Memuat detail analisis</strong><p>Tunggu sesaat.</p></div></div>
  </DesignFrame>;
  return <DesignFrame>
    <div className={styles.breadcrumb}>Workspace <span>/</span> <Link href="/workspace/history">Riwayat</Link> <span>/</span> Progres analisis</div>
    <div className={styles.pageHeading}>
      <p className={styles.eyebrow}>03 / PROGRES</p>
      <h1>{detail.context.repositoryFullName}</h1>
      <p className={styles.muted}>Branch {detail.context.branchName} · commit {detail.context.commitSha}</p>
    </div>
    <Panel title="Ringkasan" className={styles.historyPanel}>
      <div className={styles.historyRow}>
        <div><strong>Status</strong><small>Diantrekan {formatDateTime(detail.timestamps.queuedAt)}{detail.timestamps.completedAt ? ` · Selesai ${formatDateTime(detail.timestamps.completedAt)}` : ""}</small></div>
        <Badge tone={statusTone(detail.status) ?? "neutral"}>{statusLabel(detail.status) ?? detail.status}</Badge>
        <span aria-hidden="true" />
      </div>
      {detail.errorCode ? <div className={styles.historyMessage} role="alert">
        <AssetIcon group="history-error" name="imgIcon2" />
        <div><strong>Analisis gagal</strong><p><code>{detail.errorCode}</code> — tahap berikutnya tetap menunggu. Buat analisis baru dari target yang sama untuk mengulang.</p></div>
      </div> : null}
      {detail.limitations.length > 0 ? <div className={styles.historyMessage} role="note">
        <AssetIcon group="progress-complete" name="imgIcon2" />
        <div><strong>Batasan</strong>{detail.limitations.map((limitation, index) => (
          <p key={index}><code>{limitation.stageKey}</code> {limitation.code}: {limitation.safeExplanation}</p>
        ))}</div>
      </div> : null}
      {!isTerminal(detail.status) ? <p className={styles.historyFootnote} role="status">Halaman diperbarui otomatis setiap 3 detik sampai analisis selesai.</p> : null}
      {fetchError ? <p className={styles.historyFootnote} role="status">Pembaruan otomatis gagal sementara; mencoba lagi pada interval berikutnya.</p> : null}
    </Panel>
    <Panel title="Sembilan tahap" className={styles.historyPanel}>
      <ol>
        {detail.stages.map(stage => (
          <li key={stage.key} className={styles.historyRow}>
            <div><strong>{stage.sequence}. {stage.label}</strong><small>{stage.startedAt ? `Mulai ${formatDateTime(stage.startedAt)}` : ""}{stage.finishedAt ? ` · Selesai ${formatDateTime(stage.finishedAt)}` : ""}{stage.errorCode ? " · " + stage.errorCode : ""}</small></div>
            <Badge tone={statusTone(stage.status) ?? "neutral"}>{statusLabel(stage.status) ?? stage.status}</Badge>
            <span aria-hidden="true" />
          </li>
        ))}
      </ol>
    </Panel>
    {detail.results ? <Panel title="Hasil" className={styles.historyPanel}>
      <Link className={styles.primaryAction} href={detail.results.graphUrl}>Buka knowledge graph</Link>
      <Link className={styles.secondaryAction} href={detail.results.documentUrl}>Buka dokumentasi</Link>
      <p className={styles.historyFootnote}>Graph membaca hasil tersimpan setelah analisis sukses; halaman dokumen mengikuti integrasi DOC-01.</p>
    </Panel> : null}
  </DesignFrame>;
}
