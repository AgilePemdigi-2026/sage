"use client";
import { useState } from "react";
import { AppShell } from "../../components/ui-foundation/app-shell";
import { LoginPanel } from "../../components/ui-foundation/login-panel";
import { RepositoryPanel } from "../../components/ui-foundation/repository-panel";
import { ProgressPanel } from "../../components/ui-foundation/progress-panel";
import { Notice } from "../../components/ui-foundation/primitives";
import type { AnalysisProgress, AnalysisStatus, AnalysisTarget, LoadState, LoginState, Repository, Screen } from "../../components/ui-foundation/types";
import styles from "../../components/ui-foundation/ui-foundation.module.css";
import { progressFixture, repositories } from "./fixture-data";
const scenarios: Record<Screen, readonly { value: string; label: string }[]> = {
  login: [{ value: "idle", label: "Belum terhubung" }, { value: "loading", label: "Memuat koneksi" }, { value: "denied", label: "Izin ditolak" }, { value: "error", label: "Koneksi gagal" }, { value: "connected", label: "Contoh koneksi berhasil" }],
  repository: [{ value: "ready", label: "Daftar tersedia" }, { value: "loading", label: "Daftar dimuat" }, { value: "empty", label: "Daftar kosong" }, { value: "error", label: "Daftar gagal" }, { value: "branch-loading", label: "Branch dimuat" }, { value: "branch-empty", label: "Branch kosong" }, { value: "branch-error", label: "Branch gagal" }, { value: "branch-stale", label: "Branch milik target lain" }],
  progress: [{ value: "QUEUED", label: "Dalam antrean" }, { value: "RUNNING", label: "Diproses" }, { value: "FAILED", label: "Tahap gagal" }, { value: "COMPLETED", label: "Selesai" }, { value: "COMPLETED_WITH_LIMITATIONS", label: "Selesai dengan keterbatasan" }, { value: "loading", label: "Progres dimuat" }, { value: "error", label: "Progres gagal dimuat" }, { value: "empty", label: "Belum ada analisis" }],
};
const headings: Record<Screen, { eyebrow: string; title: string; description: string }> = {
  login: { eyebrow: "01 / KONEKSI", title: "Mulai dari repository Anda", description: "Hubungkan akses, pilih target, lalu ikuti alur analisis." },
  repository: { eyebrow: "02 / TARGET", title: "Pilih Repository", description: "Tentukan repository dan versi source code yang akan dipahami." },
  progress: { eyebrow: "03 / PROSES", title: "Progres Analisis", description: "Tetap terhubung dengan konteks kode di setiap tahap." },
};
export function PreviewClient() {
  const [screen, setScreen] = useState<Screen>("login"); const [login, setLogin] = useState<LoginState>("idle"); const [repositoryScenario, setRepositoryScenario] = useState("ready"); const [progressScenario, setProgressScenario] = useState("RUNNING"); const [selected, setSelected] = useState<Repository | null>(null); const [submitted, setSubmitted] = useState<AnalysisTarget | null>(null); const [retry, setRetry] = useState(false);
  const scenario = screen === "login" ? login : screen === "repository" ? repositoryScenario : progressScenario;
  function navigate(next: Screen) { setScreen(next); setSubmitted(null); requestAnimationFrame(() => document.getElementById("konten-utama")?.focus()); }
  function updateScenario(value: string) {
    if (screen === "login") setLogin(value as LoginState);
    else if (screen === "repository") { setRepositoryScenario(value); setSubmitted(null); setSelected(value.startsWith("branch-") ? repositories[0] : null); }
    else { setProgressScenario(value); setRetry(false); }
  }
  const repoState: LoadState<readonly Repository[]> = repositoryScenario === "loading" ? { status: "loading" } : repositoryScenario === "empty" ? { status: "empty" } : repositoryScenario === "error" ? { status: "error", message: "Contoh error daftar. Tidak ada request GitHub yang dikirim." } : { status: "ready", data: repositories };
  const branchState: LoadState<{ repository: string; names: readonly string[] }> = !selected ? { status: "idle" } : repositoryScenario === "branch-loading" ? { status: "loading" } : repositoryScenario === "branch-empty" ? { status: "empty" } : repositoryScenario === "branch-error" ? { status: "error", message: "Contoh error branch. Pilihan target tetap dipertahankan." } : { status: "ready", data: { repository: repositoryScenario === "branch-stale" ? "target-lain/repository" : selected.fullName, names: ["main", "develop"] } };
  const progress: LoadState<AnalysisProgress> = progressScenario === "loading" ? { status: "loading" } : progressScenario === "error" ? { status: "error", message: "Contoh error pembacaan progres. Hasil tidak diklaim selesai." } : progressScenario === "empty" ? { status: "empty" } : { status: "ready", data: progressFixture(progressScenario as AnalysisStatus, retry) };
  return <AppShell screen={screen} onNavigate={navigate}>
    <div className={styles.fixtureBanner}><span className={styles.fixtureDot} aria-hidden="true" /><div><strong>Data contoh · Tidak terhubung ke GitHub</strong><span>Halaman ini hanya menguji komponen UI. Tidak membuat sesi, job analisis, atau hasil repository nyata.</span></div></div>
    <div className={styles.pageHeading}><p className={styles.eyebrow}>{headings[screen].eyebrow}</p><h1>{headings[screen].title}</h1><p className={styles.muted}>{headings[screen].description}</p></div>
    <section className={styles.previewControls} aria-label="Skenario pratinjau"><div><strong>Uji state komponen</strong><p>Pilih kondisi contoh untuk memeriksa tampilan dan aksi pemulihan.</p></div><div><label className={styles.fieldLabel} htmlFor="preview-scenario">Kondisi pratinjau</label><select id="preview-scenario" className={styles.input} value={scenario} onChange={event => updateScenario(event.target.value)}>{scenarios[screen].map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select></div></section>
    {screen === "login" && <LoginPanel state={login} onConnect={() => setLogin("connected")} onContinue={() => navigate("repository")} userLabel="pengguna-contoh" />}
    {screen === "repository" && <><RepositoryPanel repositories={repoState} selectedRepository={selected} branches={branchState} onSelectRepository={repo => { setSelected(repo); setSubmitted(null); }} onResolveRepository={slug => { setSelected({ fullName: slug, visibility: "unverified", language: "Belum diperiksa", description: "Target publik contoh; belum diverifikasi ke GitHub." }); setSubmitted(null); }} onRetryRepositories={() => setRepositoryScenario("ready")} onRetryBranches={() => setRepositoryScenario("ready")} onSubmit={setSubmitted} onTargetChange={() => setSubmitted(null)} submitLabel="Pratinjau target analisis" />{submitted && <div className={styles.submission}><Notice tone="success" title="Target contoh valid secara format"><p className={styles.mono}>{submitted.repository} · {submitted.branch} · {submitted.commit ?? "Commit terbaru (belum di-resolve)"}</p><p>Tidak ada job dibuat. Keberadaan repository, hak akses, branch, dan commit belum diverifikasi ke GitHub.</p></Notice></div>}</>}
    {screen === "progress" && <ProgressPanel progress={progress} onReload={() => setProgressScenario("RUNNING")} onChooseTarget={() => navigate("repository")} onRetry={() => { setRetry(true); setProgressScenario("RUNNING"); }} retryLabel="Simulasikan Coba Lagi" />}
  </AppShell>;
}
