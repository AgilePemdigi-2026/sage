"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { AssetIcon, Badge, DesignFrame, Panel } from "../design-system/ui.tsx";
import { formatDateTime, statusLabel, statusTone } from "./format.ts";
import { createDetailPoller, shouldPollAnalysisDetail } from "./detail-data.ts";
import type { AnalysisDetailView } from "../../lib/analyses/presenters.ts";
import styles from "../sprint-ui/preview-client.module.css";

/** Bentuk payload server (presenters.ts) — di-derive, tidak ditulis manual. */
export type DetailView = AnalysisDetailView;
export type StageView = DetailView["stages"][number];

function isTerminal(status: string) {
  return !shouldPollAnalysisDetail(status);
}

function responseMessage(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const error = (value as { error?: unknown }).error;
  if (!error || typeof error !== "object" || Array.isArray(error)) return null;
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" ? message : null;
}

export function AnalysisDetailClient({ analysisId, accountKey, initial, reason }: {
  analysisId: string; accountKey: string; initial: DetailView | null; reason: "not-found" | null;
}) {
  const [detail, setDetail] = useState<DetailView | null>(initial);
  const [fetchError, setFetchError] = useState(false);
  const [retryBusy, setRetryBusy] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const sequenceRef = useRef(0);
  const retryKeyRef = useRef("");
  const retrySequenceRef = useRef(0);
  const reloadStarted = useRef(false);

  function reloadForSessionChange() {
    if (reloadStarted.current) return;
    reloadStarted.current = true;
    setDetail(null);
    setRetryError(null);
    window.location.replace(`${window.location.pathname}${window.location.search}`);
  }

  async function verifyCurrentAccount(isRelevant: () => boolean = () => true): Promise<boolean> {
    const response = await fetch("/api/auth/session", {
      headers: { "X-SAGE-Account": accountKey }, cache: "no-store", credentials: "same-origin",
    });
    if (response.status === 401) {
      if (isRelevant()) reloadForSessionChange();
      return false;
    }
    if (!response.ok) throw new Error("Sesi belum dapat diperiksa. Coba lagi.");
    const body = await response.json() as { data?: { accountKey?: string } };
    if (body.data?.accountKey !== accountKey) {
      if (isRelevant()) reloadForSessionChange();
      return false;
    }
    return isRelevant();
  }

  useEffect(() => {
    return () => { retrySequenceRef.current += 1; };
  }, [analysisId, accountKey]);

  async function retryFailedAnalysis() {
    if (!detail || detail.status !== "FAILED" || retryBusy) return;
    const retrySequence = ++retrySequenceRef.current;
    if (!retryKeyRef.current) retryKeyRef.current = `retry-${crypto.randomUUID()}`;
    setRetryBusy(true);
    setRetryError(null);
    try {
      if (!(await verifyCurrentAccount(() => retrySequenceRef.current === retrySequence))) return;
      const response = await fetch(`/api/analyses/${encodeURIComponent(analysisId)}/retry`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": retryKeyRef.current,
          "X-SAGE-Account": accountKey,
        },
        body: "{}",
        cache: "no-store",
        credentials: "same-origin",
      });
      let payload: unknown = null;
      try { payload = await response.json(); } catch { /* Verify the active account before showing any response result. */ }
      if (!(await verifyCurrentAccount(() => retrySequenceRef.current === retrySequence)) || retrySequenceRef.current !== retrySequence) return;
      if (!response.ok) {
        if (response.status === 409) retryKeyRef.current = "";
        setRetryError(responseMessage(payload) ?? "Analisis belum dapat diulang. Coba lagi.");
        return;
      }
      const analysisIdResult = payload && typeof payload === "object" && !Array.isArray(payload)
        ? (payload as { data?: { analysisId?: unknown } }).data?.analysisId
        : null;
      if (typeof analysisIdResult !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(analysisIdResult)) {
        setRetryError("Analisis berhasil dikirim, tetapi progresnya belum dapat dibuka. Muat ulang halaman riwayat.");
        return;
      }
      // Force a fresh server session check; avoid reusing an App Router RSC cache
      // entry from before the post-response account verification.
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination
      window.location.assign(`/analyses/${encodeURIComponent(analysisIdResult)}`);
    } catch (cause) {
      if (retrySequenceRef.current !== retrySequence) return;
      try {
        if (!(await verifyCurrentAccount(() => retrySequenceRef.current === retrySequence))) return;
      } catch { /* Keep the request error; the periodic identity check will retry. */ }
      if (retrySequenceRef.current !== retrySequence) return;
      setRetryError(cause instanceof Error ? cause.message : "Analisis belum dapat diulang. Coba lagi dengan tombol yang sama.");
    } finally {
      if (retrySequenceRef.current === retrySequence) setRetryBusy(false);
    }
  }

  useEffect(() => {
    let active = true;
    async function verifyPollAccount() {
      if (!active) return false;
      return verifyCurrentAccount(() => active);
    }
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
      verifySession: verifyPollAccount,
      onAccountMismatch: () => { if (active) reloadForSessionChange(); },
    });
    poller.start();
    return () => { active = false; poller.stop(); };
  // Polling follows status transitions so reaching any terminal state stops the timer.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail?.status, reason, analysisId, accountKey]);

  useEffect(() => {
    let active = true;
    let checking = false;
    async function checkIdentity() {
      if (!active || checking || document.visibilityState !== "visible") return;
      checking = true;
      try {
        await verifyCurrentAccount(() => active);
      } catch {
        if (active) setFetchError(true);
      } finally {
        checking = false;
      }
    }
    void checkIdentity();
    const interval = window.setInterval(() => void checkIdentity(), 15_000);
    const onFocus = () => { if (document.visibilityState === "visible") void checkIdentity(); };
    const onPageShow = () => void checkIdentity();
    const onVisibility = () => { if (document.visibilityState === "visible") void checkIdentity(); };
    window.addEventListener("focus", onFocus);
    window.addEventListener("pageshow", onPageShow);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      active = false;
      window.clearInterval(interval);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("pageshow", onPageShow);
      document.removeEventListener("visibilitychange", onVisibility);
    };
    // This check keeps server-rendered detail scoped to its authenticated account.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analysisId, accountKey]);

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
        <div><strong>Analisis gagal</strong><p><code>{detail.errorCode}</code> — tahap berikutnya tetap menunggu. Ulangi dari snapshot target yang sama.</p></div>
      </div> : null}
      {detail.status === "FAILED" ? <div className={styles.historyRetry}>
        <button className={styles.secondaryAction} type="button" disabled={retryBusy} onClick={() => void retryFailedAnalysis()}>
          {retryBusy ? "Mengantrekan…" : "Ulangi analisis"}
        </button>
        {retryError ? <p className={styles.historyRetryError} role="alert">{retryError}</p> : null}
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
      <p className={styles.historyFootnote}>Graph dan dokumen membaca hasil canonical tersimpan dari snapshot yang sama setelah analisis sukses.</p>
    </Panel> : null}
  </DesignFrame>;
}
