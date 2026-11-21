"use client";

import { AnalysisNavigation } from "../analysis-navigation/analysis-navigation.tsx";
import { useEffect, useRef, useState } from "react";
import { AssetIcon, Badge, Button, CopySha, DesignFrame, EmptyState, MaskIcon, PageHead, Panel, PipelineStep, ProgressBar, Stepper, type PipelineStepStatus } from "../design-system/ui.tsx";
import { useHeaderAccount } from "../design-system/account-context.tsx";
import designStyles from "../design-system/ui.module.css";
import { analysisStatusBadge, formatDateTime } from "./format.ts";
import { createDetailPoller, elapsedAnalysisSeconds, formatElapsedDuration, shouldPollAnalysisDetail } from "./detail-data.ts";
import type { AnalysisDetailView } from "../../lib/analyses/presenters.ts";
import progressStyles from "./detail.module.css";
import { formatStageDuration, stageDurationSeconds } from "./stage-duration.ts";

/** Bentuk payload server (presenters.ts) — di-derive, tidak ditulis manual. */
export type DetailView = AnalysisDetailView;
export type StageView = DetailView["stages"][number];

const STEP_STATUS: Record<string, PipelineStepStatus> = { COMPLETED: "done", RUNNING: "active", FAILED: "failed", PENDING: "pending" };
const STAGE_META: Record<string, string> = { COMPLETED: "Selesai", RUNNING: "Sedang berjalan", FAILED: "Gagal", PENDING: "Menunggu" };
const timeFormatter = new Intl.DateTimeFormat("id-ID", { timeStyle: "short", timeZone: "Asia/Jakarta" });
function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : `${timeFormatter.format(date)} WIB`;
}

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
  // Seed from the server snapshot so the timer's first HTML is deterministic and
  // does not differ between server render and browser hydration.
  const [clockNow, setClockNow] = useState(() => {
    const snapshotTime = initial ? Date.parse(initial.updatedAt) : 0;
    return Number.isFinite(snapshotTime) ? snapshotTime : 0;
  });
  const sequenceRef = useRef(0);
  const retryKeyRef = useRef("");
  const retrySequenceRef = useRef(0);
  const reloadStarted = useRef(false);
  const account = useHeaderAccount();

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

  const detailStatus = detail?.status;
  useEffect(() => {
    if (!shouldPollAnalysisDetail(detailStatus ?? "")) return;
    const interval = window.setInterval(() => setClockNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [detailStatus]);

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

  const breadcrumb = [{ label: "Workspace", href: "/workspace" }, { label: "Repository", href: "/workspace/repositories" }, { label: "Analisis" }];
  if (reason === "not-found") return <DesignFrame active="history">
    <PageHead breadcrumb={breadcrumb} title="Analisis tidak tersedia" />
    <EmptyState tone="error" role="alert" icon={{ group: "repository", name: "imgRepo" }} title="Analisis tidak ditemukan" action={<Button href="/workspace/history" variant="secondary">Kembali ke riwayat</Button>}>Record ini bukan milik akun yang masuk, atau sudah dihapus.</EmptyState>
  </DesignFrame>;
  if (!detail) return <DesignFrame active="history">
    <EmptyState role="status" icon={{ group: "repository", name: "imgRepo" }} title="Memuat detail analisis">Tunggu sesaat.</EmptyState>
  </DesignFrame>;

  const total = detail.stages.length;
  const completedStages = detail.stages.filter(stage => stage.status === "COMPLETED").length;
  const runningStage = detail.stages.find(stage => stage.status === "RUNNING");
  const failedStage = detail.stages.find(stage => stage.status === "FAILED");
  const active = !isTerminal(detail.status);
  const badge = analysisStatusBadge(detail.status);
  const overallLabel = detail.status === "RUNNING" && runningStage ? `Berjalan · tahap ${runningStage.sequence} dari ${total}` : badge.label;
  const overallTone = badge.tone;
  const elapsedSeconds = elapsedAnalysisSeconds(detail.timestamps, detail.status, clockNow);
  const duration = elapsedSeconds === null ? "--:--:--" : formatElapsedDuration(elapsedSeconds);

  return <DesignFrame active="history">
    <PageHead
      breadcrumb={breadcrumb}
      title={<span className={progressStyles.title}>{detail.context.repositoryFullName}</span>}
      description={<div className={progressStyles.chips}>
        <span className={progressStyles.chip}><MaskIcon group="repository" name="imgBranch" size={14} /><span className={designStyles.srOnly}>Branch </span>{detail.context.branchName}</span>
        <span className={`${progressStyles.chip} ${progressStyles.chipSha}`}><AssetIcon group="progress-v2" name="imgCommit" /><span className={designStyles.srOnly}>Commit </span><CopySha sha={detail.context.commitSha} /></span>
      </div>}
      aside={<>
        <span className={progressStyles.statusLive} aria-live="polite"><Badge tone={overallTone} pulse={detail.status === "RUNNING"}>{overallLabel}</Badge></span>
        <Stepper steps={["Repository", "Target", "Analisis"]} current={2} label="Langkah analisis" />
      </>}
    />
    <AnalysisNavigation analysisId={analysisId} active="progress" resultsAvailable={Boolean(detail.results)} />

    <div className={progressStyles.layout}>
      <div className={progressStyles.column}>
        {detail.status === "FAILED" || detail.errorCode ? <div className={progressStyles.banner} data-tone="error" role="alert">
          <span className={progressStyles.bannerCopy}>
            <strong>Analisis gagal{failedStage ? ` di tahap ${failedStage.sequence}` : ""}</strong>
            <p>{detail.errorCode ? <><code>{detail.errorCode}</code> — </> : null}{failedStage ? `${failedStage.label} tidak selesai; ` : ""}tahap berikutnya tetap menunggu. Ulangi dari snapshot target yang sama.</p>
          </span>
        </div> : null}
        {detail.results ? <div className={progressStyles.banner} data-tone={detail.status === "COMPLETED_WITH_LIMITATIONS" ? "warning" : "success"} role="status">
          <span className={progressStyles.bannerCopy}>
            <strong>{detail.status === "COMPLETED_WITH_LIMITATIONS" ? "Analisis selesai dengan batasan" : "Analisis selesai"}</strong>
            <p>TOGAF ADD adalah hasil arsitektur utama. Code Knowledge menjadi visual pendamping dari snapshot source yang sama.</p>
          </span>
          <Button href={detail.results.documentUrl} arrow>Buka TOGAF ADD</Button>
        </div> : null}
        {detail.limitations.length > 0 ? <div className={progressStyles.banner} data-tone="warning" role="note">
          <span className={progressStyles.bannerCopy}>
            <strong>Batasan</strong>
            <ul className={progressStyles.limitations}>{detail.limitations.map((limitation, index) => (
              <li key={index}><code>{limitation.stageKey}</code> {limitation.code}: {limitation.safeExplanation}</li>
            ))}</ul>
          </span>
        </div> : null}

        <Panel>
          <div className={progressStyles.cardHead}>
            <h2 className={progressStyles.cardTitle}>Sembilan tahap analisis</h2>
            <span className={progressStyles.count}>{completedStages} / {total} selesai</span>
          </div>
          <ol className={progressStyles.steps} aria-label="Tahap analisis">
            {detail.stages.map(stage => {
              const status = STEP_STATUS[stage.status] ?? "pending";
              const meta = [STAGE_META[stage.status] ?? stage.status, stage.startedAt ? `mulai ${formatTime(stage.startedAt)}` : null, stage.errorCode].filter(Boolean).join(" · ");
              return <PipelineStep
                key={stage.key}
                status={status}
                title={`${stage.sequence}. ${stage.label}`}
                meta={meta}
                aside={<><span className={designStyles.srOnly}>Durasi </span>{formatStageDuration(stageDurationSeconds(stage, clockNow))}</>}
              />;
            })}
          </ol>
        </Panel>
      </div>

      <aside className={progressStyles.side} aria-label="Ringkasan analisis">
        <Panel>
          <div className={progressStyles.summary}>
            <p className={progressStyles.label}>Ringkasan</p>
            <div className={progressStyles.elapsedCard} data-active={active} role="timer" aria-label={`${active ? "Waktu berjalan" : "Durasi analisis"}: ${duration}`}>
              <span className={progressStyles.activityMark} aria-hidden="true" />
              <span className={progressStyles.elapsedCopy}>
                <small>{active ? "WAKTU BERJALAN" : "DURASI TOTAL"}</small>
                <strong aria-live="off">{duration}</strong>
              </span>
              <span className={progressStyles.elapsedHint}>{active ? "Dihitung sejak analisis dikirim" : "Waktu berhenti mengikuti status akhir"}</span>
            </div>
            <div>
              <div className={progressStyles.progressHead}><span>Progres tahap</span><span>{completedStages}/{total}</span></div>
              <ProgressBar value={completedStages} max={total} label={`${completedStages} dari ${total} tahap selesai`} indeterminate={detail.status === "RUNNING"} />
            </div>
            <dl className={progressStyles.facts}>
              <dt>Diantrekan</dt><dd>{formatDateTime(detail.timestamps.queuedAt)}</dd>
              <dt>Dimulai</dt><dd>{formatDateTime(detail.timestamps.startedAt)}</dd>
              <dt>Selesai</dt><dd>{formatDateTime(detail.timestamps.completedAt)}</dd>
              {account ? <><dt>Akun</dt><dd>@{account.login}</dd></> : null}
            </dl>
            {detail.results ? <div className={progressStyles.actions}>
              <Button href={detail.results.graphUrl} variant="secondary" block>Buka Code Knowledge</Button>
            </div> : null}
            {detail.status === "FAILED" ? <div className={progressStyles.actions}>
              <Button block loading={retryBusy} onClick={() => void retryFailedAnalysis()}>{retryBusy ? "Mengantrekan…" : "Ulangi analisis"}</Button>
              {retryError ? <p className={progressStyles.retryError} role="alert">{retryError}</p> : null}
              <Button href="/workspace/repositories" variant="link">Kembali ke repository</Button>
            </div> : null}
            {active ? <p className={progressStyles.note} role="status">Halaman diperbarui otomatis setiap 3 detik sampai analisis selesai.</p> : null}
            {fetchError ? <p className={progressStyles.note} role="status">Pembaruan otomatis gagal sementara; mencoba lagi pada interval berikutnya.</p> : null}
          </div>
        </Panel>
      </aside>
    </div>
  </DesignFrame>;
}
