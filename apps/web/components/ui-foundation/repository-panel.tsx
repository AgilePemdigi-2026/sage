"use client";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Badge, Icon, Loading, Notice } from "./primitives";
import { normalizeRepository, validateTarget, type TargetErrors } from "./target-validation";
import type { AnalysisTarget, LoadState, Repository } from "./types";
import styles from "./ui-foundation.module.css";
export interface RepositoryPanelProps {
  repositories: LoadState<readonly Repository[]>;
  selectedRepository: Repository | null;
  branches: LoadState<{ repository: string; names: readonly string[] }>;
  onSelectRepository: (repository: Repository) => void;
  onResolveRepository: (slug: string) => void;
  onRetryRepositories: () => void;
  onRetryBranches: () => void;
  onSubmit: (target: AnalysisTarget) => void;
  submitLabel?: string;
  onTargetChange?: () => void;
}
export function RepositoryPanel({ repositories, selectedRepository, branches, onSelectRepository, onResolveRepository, onRetryRepositories, onRetryBranches, onSubmit, onTargetChange, submitLabel = "Mulai Analisis" }: RepositoryPanelProps) {
  const searchInput = useRef<HTMLInputElement>(null); const branchInput = useRef<HTMLSelectElement>(null);
  const retryRepositories = useRef(false); const retryBranches = useRef(false);
  useEffect(() => { if (retryRepositories.current && repositories.status === "ready") { retryRepositories.current = false; searchInput.current?.focus(); } }, [repositories.status]);
  useEffect(() => { if (retryBranches.current && branches.status === "ready") { retryBranches.current = false; branchInput.current?.focus(); } }, [branches.status]);
  const id = useId(); const publicInput = useRef<HTMLInputElement>(null); const commitInput = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState(""); const [publicRepository, setPublicRepository] = useState(""); const [branch, setBranch] = useState(""); const [commit, setCommit] = useState(""); const [errors, setErrors] = useState<TargetErrors>({});
  const branchData = branches.status === "ready" && branches.data.repository === selectedRepository?.fullName ? branches.data : null;
  const selectedBranch = branchData?.names.includes(branch) ? branch : branchData?.names[0] ?? "";
  const filtered = repositories.status === "ready" ? repositories.data.filter(repo => repo.fullName.toLowerCase().includes(query.toLowerCase().trim())) : [];
  function choose(repo: Repository) { onTargetChange?.(); setBranch(""); setCommit(""); setErrors({}); onSelectRepository(repo); }
  function resolve() {
    const slug = normalizeRepository(publicRepository);
    if (!slug) { setErrors({ repository: "Gunakan owner/repository atau URL HTTPS github.com yang valid." }); publicInput.current?.focus(); return; }
    setErrors({}); setBranch(""); setCommit(""); onResolveRepository(slug);
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    const result = validateTarget({ repository: selectedRepository?.fullName ?? "", branch: selectedBranch, commit }, branchData?.names ?? []);
    if (!result.valid) { setErrors(result.errors); if (result.errors.repository) publicInput.current?.focus(); else if (result.errors.branch) document.getElementById(`${id}-branch`)?.focus(); else commitInput.current?.focus(); return; }
    setErrors({}); onSubmit(result.target);
  }
  return <div className={styles.repositoryGrid}>
    <section className={styles.card} aria-labelledby={`${id}-repos`}>
      <div className={styles.sectionHeading}><div><h2 id={`${id}-repos`}>Repository terotorisasi</h2><p className={styles.muted}>Pilih dari akses yang diberikan melalui GitHub.</p></div><Icon name="repository" /></div>
      <label className={styles.fieldLabel} htmlFor={`${id}-search`}>Cari repository terotorisasi</label><input ref={searchInput} id={`${id}-search`} className={styles.input} type="search" placeholder="Cari nama repository…" value={query} onChange={event => setQuery(event.target.value)} />
      <div className={styles.repositoryList}>
        {repositories.status === "loading" && <Loading label="Memuat daftar repository…" />}
        {repositories.status === "idle" && <Notice title="Akses repository belum dimuat">Hubungkan akun untuk melihat daftar repository.</Notice>}
        {repositories.status === "error" && <Notice tone="error" title="Daftar repository gagal dimuat" action={<button className={styles.secondaryButton} onClick={() => { retryRepositories.current = true; onRetryRepositories(); }}>Coba Lagi</button>}>{repositories.message}</Notice>}
        {(repositories.status === "empty" || (repositories.status === "ready" && !repositories.data.length)) && <Notice title="Belum ada repository terotorisasi">Periksa akses GitHub atau gunakan input repository publik di bawah.</Notice>}
        {repositories.status === "ready" && repositories.data.length > 0 && !filtered.length && <Notice title="Repository tidak ditemukan">Coba kata pencarian lain atau <button className={styles.textButton} onClick={() => setQuery("")}>Reset pencarian</button>.</Notice>}
        {filtered.map(repo => <label key={repo.fullName} className={styles.repositoryOption}><input type="radio" name={`${id}-repository`} checked={selectedRepository?.fullName === repo.fullName} onChange={() => choose(repo)} /><span className={styles.repositoryCopy}><strong className={styles.mono}>{repo.fullName}</strong><span>{repo.description}</span><span className={styles.repositoryMeta}>{repo.language} <span aria-hidden="true">·</span> {repo.visibility === "private" ? "Private" : "Publik"}</span></span></label>)}
      </div>
      <div className={styles.cardDivider} /><h3>Repository publik milik pihak lain</h3><p className={styles.caption}>Input ini tidak memberikan akses ke repository private.</p>
      <label className={styles.fieldLabel} htmlFor={`${id}-public`}>Owner/repository atau URL GitHub</label><input ref={publicInput} id={`${id}-public`} className={styles.input} value={publicRepository} onChange={event => { setPublicRepository(event.target.value); onTargetChange?.(); }} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); resolve(); } }} placeholder="owner/repository" aria-invalid={Boolean(errors.repository)} aria-describedby={errors.repository ? `${id}-repository-error` : `${id}-public-help`} autoCapitalize="none" autoCorrect="off" spellCheck={false} />
      <p id={`${id}-public-help`} className={styles.caption}>Hanya format GitHub yang diperiksa di antarmuka.</p>{errors.repository && <p id={`${id}-repository-error`} className={styles.fieldError} role="alert">{errors.repository}</p>}
      <button className={styles.secondaryButton} onClick={resolve}>Gunakan target publik <Icon name="arrow" /></button>
    </section>
    <form className={styles.card} onSubmit={submit} noValidate aria-labelledby={`${id}-target`}>
      <Badge>TARGET ANALISIS</Badge><h2 id={`${id}-target`}>Tentukan versi kode</h2><p className={styles.muted}>Branch dan commit membantu menjaga konteks analisis tetap konsisten.</p>
      <div className={styles.targetSummary}><span className={styles.fieldLabel}>Repository dipilih</span><strong className={styles.mono}>{selectedRepository?.fullName ?? "Belum dipilih"}</strong>{selectedRepository?.visibility === "unverified" && <span className={styles.caption}>Target contoh · belum diverifikasi ke GitHub</span>}</div>
      <label className={styles.fieldLabel} htmlFor={`${id}-branch`}>Branch</label><select ref={branchInput} id={`${id}-branch`} className={styles.input} value={selectedBranch} onChange={event => { setBranch(event.target.value); setCommit(""); onTargetChange?.(); }} disabled={!branchData?.names.length} aria-invalid={Boolean(errors.branch)} aria-describedby={`${id}-branch-help${errors.branch ? ` ${id}-branch-error` : ""}`}><option value="" disabled>Pilih branch</option>{branchData?.names.map(name => <option key={name} value={name}>{name}</option>)}</select>
      <div id={`${id}-branch-help`} className={styles.caption}>
        {branches.status === "loading" ? <Loading label="Memuat branch…" /> : branches.status === "error" ? <Notice tone="error" title="Branch gagal dimuat" action={<button type="button" className={styles.textButton} onClick={() => { retryBranches.current = true; onRetryBranches(); }}>Coba Lagi</button>}>{branches.message}</Notice> : (branchData && !branchData.names.length || branches.status === "empty") ? "Repository ini belum memiliki branch." : !branchData ? "Pilih repository dan tunggu daftar branch untuk target tersebut." : "Branch berasal dari data yang diberikan ke komponen."}
      </div>{errors.branch && <p id={`${id}-branch-error`} className={styles.fieldError} role="alert">{errors.branch}</p>}
      <label className={styles.fieldLabel} htmlFor={`${id}-commit`}>Commit <span className={styles.optional}>opsional</span></label><input ref={commitInput} id={`${id}-commit`} className={`${styles.input} ${styles.mono}`} value={commit} onChange={event => { setCommit(event.target.value); onTargetChange?.(); }} placeholder="Contoh: a1b2c3d" autoCapitalize="none" autoCorrect="off" spellCheck={false} aria-invalid={Boolean(errors.commit)} aria-describedby={`${id}-commit-help${errors.commit ? ` ${id}-commit-error` : ""}`} /><p id={`${id}-commit-help`} className={styles.caption}>Kosongkan untuk commit terbaru pada branch. Server akan memvalidasi izin, riwayat, dan full SHA saat integrasi tersedia.</p>{errors.commit && <p id={`${id}-commit-error`} className={styles.fieldError} role="alert">{errors.commit}</p>}
      <button type="submit" className={styles.primaryButton} disabled={!selectedRepository || !branchData?.names.length}>{submitLabel}<Icon name="arrow" /></button><p className={styles.caption}>Pilih repository dan muat branch sebelum melanjutkan.</p>
    </form>
  </div>;
}
