"use client";
import { Badge, Icon, Loading, Notice } from "./primitives";
import type { AnalysisProgress, AnalysisStatus, LoadState, StageStatus } from "./types";
import styles from "./ui-foundation.module.css";
const labels: Record<AnalysisStatus | StageStatus, string> = { QUEUED: "Dalam antrean", RUNNING: "Diproses", COMPLETED: "Selesai", COMPLETED_WITH_LIMITATIONS: "Selesai dengan keterbatasan", FAILED: "Gagal", PENDING: "Menunggu" };
export interface ProgressPanelProps {
  progress: LoadState<AnalysisProgress>;
  onReload: () => void;
  onChooseTarget: () => void;
  onRetry?: () => void;
  onOpenResult?: () => void;
  retryLabel?: string;
}
export function ProgressPanel({ progress, onReload, onChooseTarget, onRetry, onOpenResult, retryLabel = "Coba Lagi" }: ProgressPanelProps) {
  if (progress.status === "loading") return <section className={styles.card}><Loading label="Memuat progres analisis…" /></section>;
  if (progress.status === "error") return <section className={styles.card}><Notice tone="error" title="Progres belum dapat dimuat" action={<button className={styles.secondaryButton} onClick={onReload}>Coba Lagi</button>}>{progress.message}</Notice></section>;
  if (progress.status === "empty" || progress.status === "idle") return <section className={styles.card}><Notice title="Belum ada analisis dipilih" action={<button className={styles.secondaryButton} onClick={onChooseTarget}>Pilih Repository</button>}>Pilih target untuk melihat konteks dan tahapan analisis.</Notice></section>;
  const analysis = progress.data; const complete = analysis.status === "COMPLETED" || analysis.status === "COMPLETED_WITH_LIMITATIONS";
  return <div className={styles.progressGrid}>
    <section className={styles.card} aria-labelledby="stage-heading">
      <div className={styles.sectionHeading}><div><Badge>PIPELINE ANALISIS</Badge><h2 id="stage-heading">Sembilan tahap, satu alur</h2><p className={styles.muted}>Tahap dijalankan berurutan. Status menjelaskan hasil yang diterima dari sumber data.</p></div><Icon name="progress" /></div>
      <ol className={styles.stages} aria-label="Tahap analisis">
        {analysis.stages.map((stage, index) => <li key={stage.key} className={styles.stage} aria-current={stage.status === "RUNNING" ? "step" : undefined} data-stage-state={stage.status}>
          <span className={styles.stageNumber} aria-hidden="true">{stage.status === "COMPLETED" ? <Icon name="check" /> : String(index + 1).padStart(2, "0")}</span><span className={styles.stageLabel}>{stage.label}</span><span className={styles.stageStatus}>{labels[stage.status]}</span>
        </li>)}
      </ol>
    </section>
    <aside className={styles.card} aria-labelledby="context-heading">
      <Badge>{labels[analysis.status]}</Badge><h2 id="context-heading">Konteks analisis</h2><dl className={styles.context}><dt>Repository</dt><dd className={styles.mono}>{analysis.repository}</dd><dt>Branch</dt><dd className={styles.mono}>{analysis.branch}</dd><dt>Commit · full SHA</dt><dd className={styles.mono}>{analysis.fullSha}</dd><dt>Analysis ID</dt><dd className={styles.mono}>{analysis.analysisId}</dd></dl>
      {analysis.status === "QUEUED" && <Notice title="Menunggu giliran">Analisis lain dapat menggunakan slot global. Tidak ada perkiraan waktu yang dibuat oleh antarmuka.</Notice>}
      {analysis.status === "RUNNING" && <Notice title="Analisis sedang diproses">Ikuti status setiap tahap. Hasil belum tersedia sampai seluruh bundle lengkap.</Notice>}
      {analysis.status === "FAILED" && <Notice tone="error" title="Analisis berhenti" action={onRetry && <button className={styles.secondaryButton} onClick={onRetry}>{retryLabel}</button>}>{analysis.error ?? "Tahap analisis gagal. Periksa rincian dan coba lagi."}<p>Tahap setelah kegagalan tetap menunggu; hasil belum tersedia.</p></Notice>}
      {complete && <Notice tone={analysis.status === "COMPLETED_WITH_LIMITATIONS" ? "warning" : "success"} title={labels[analysis.status]}>{analysis.limitations.length ? <ul className={styles.limitations}>{analysis.limitations.map(item => <li key={item}>{item}</li>)}</ul> : "Semua tahap pada data yang diterima berstatus selesai."}</Notice>}
      <button className={styles.primaryButton} disabled={!complete || !onOpenResult} onClick={onOpenResult} aria-describedby="result-availability">Lihat Hasil Analisis <Icon name="arrow" /></button><p id="result-availability" className={styles.caption}>{!complete ? "Hasil tersedia setelah semua tahap berhasil." : !onOpenResult ? "Akses graph dan dokumen belum terhubung pada pratinjau komponen ini." : "Buka hasil dengan konteks repository dan commit yang sama."}</p>
    </aside>
  </div>;
}
