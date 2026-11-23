"use client";

import { useEffect, useRef, useState } from "react";
import { Badge, Button, CopySha, EmptyState, Field, PageHead, Panel, PillLink, ScrollList, SkeletonRows, Spinner, Stepper, useVisibleSection } from "../design-system/ui.tsx";
import { Icon } from "../design-system/icons.tsx";
import design from "../design-system/ui.module.css";
import css from "./repositories.module.css";

type Installation = { id: string; accountLogin: string };
type Repository = { id: string; fullName: string; private: boolean; defaultBranch: string | null };
type Page<T> = { items: T[]; nextPage: number | null };
type Branch = { name: string; commitSha: string };
type ValidatedTarget = { repository: Repository; branch: string; commitSha: string; branchHeadSha: string };
type AccountIdentity = { accountKey: string; login: string };
type EnqueuedAnalysis = { analysisId: string };

const SOURCE_SECTIONS = ["sumber-public", "sumber-app"] as const;

class AccountChangedError extends Error {
  constructor() { super("Akun GitHub berubah. Memuat ulang sesi…"); }
}

export function RepositoryAccessPanel({ installUrl, accountKey, accountLogin }: { installUrl: string | null; accountKey: string; accountLogin: string }) {
  const [installations, setInstallations] = useState<Installation[]>([]);
  const [installationPage, setInstallationPage] = useState<number | null>(null);
  const [repositories, setRepositories] = useState<Repository[]>([]);
  const [repoPage, setRepoPage] = useState<number | null>(null);
  const [selectedInstallation, setSelectedInstallation] = useState("");
  const [repository, setRepository] = useState("");
  const [resolved, setResolved] = useState<Repository | null>(null);
  const [error, setError] = useState("");
  const [reauthRequired, setReauthRequired] = useState(false);
  const [busy, setBusy] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [query, setQuery] = useState("");
  const [publicRepositories, setPublicRepositories] = useState<Repository[]>([]);
  const [publicPage, setPublicPage] = useState<number | null>(null);
  const [publicQuery, setPublicQuery] = useState("");
  const [publicError, setPublicError] = useState("");
  const [publicBusy, setPublicBusy] = useState(true);
  const [publicLoaded, setPublicLoaded] = useState(false);
  const [chosen, setChosen] = useState<Repository | null>(null);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [branchPage, setBranchPage] = useState<number | null>(null);
  const [branchLoaded, setBranchLoaded] = useState(false);
  const [branch, setBranch] = useState("");
  const [commit, setCommit] = useState("");
  const [target, setTarget] = useState<ValidatedTarget | null>(null);
  const [scopeVerified, setScopeVerified] = useState(false);
  const [scopeError, setScopeError] = useState("");
  // Presentational only: which action shows a spinner on its own button (busy stays the single source of truth).
  const [pending, setPending] = useState<"validate" | "start" | null>(null);
  const visibleSource = useVisibleSection(SOURCE_SECTIONS);
  const generation = useRef(0);
  const reloadStarted = useRef(false);
  const submissionKey = useRef<{ target: string; key: string } | null>(null);
  const targetSection = useRef<HTMLElement>(null);
  const targetHeading = useRef<HTMLHeadingElement>(null);
  const repositoryListHeading = useRef<HTMLHeadingElement>(null);
  const chosenId = chosen?.id;

  // Move to the target step as soon as a public or App-authorized repository is
  // chosen. Branch loading happens in place so even a slow or failed request
  // leaves its status beside the controls; focus the heading for assistive tech.
  useEffect(() => {
    if (!chosenId) return;
    const section = targetSection.current;
    const heading = targetHeading.current;
    if (!section || !heading) return;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    section.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "start" });
    window.requestAnimationFrame(() => heading.focus({ preventScroll: true }));
  }, [chosenId]);

  function reloadForSessionChange() {
    if (reloadStarted.current) return;
    reloadStarted.current = true;
    clearAccountData();
    setScopeVerified(false);
    window.location.replace(`${window.location.pathname}${window.location.search}`);
  }

  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const scopeGeneration = generation.current;
    const headers = new Headers(init?.headers);
    headers.set("X-SAGE-Account", accountKey);
    const response = await fetch(path, { ...init, headers, cache: "no-store", credentials: "same-origin" });
    if (response.status === 401) {
      const requestPath = new URL(path, window.location.href).pathname;
      if (requestPath === "/api/auth/session") {
        if (generation.current === scopeGeneration) reloadForSessionChange();
        throw new AccountChangedError();
      }
      let identityResponse: Response;
      try {
        identityResponse = await fetch("/api/auth/session", {
          headers: { "X-SAGE-Account": accountKey }, cache: "no-store", credentials: "same-origin",
        });
      } catch {
        throw new Error("Sesi belum dapat diperiksa. Coba muat ulang halaman.");
      }
      if (identityResponse.status === 401) {
        if (generation.current === scopeGeneration) reloadForSessionChange();
        throw new AccountChangedError();
      }
      if (!identityResponse.ok) throw new Error("Sesi belum dapat diperiksa. Coba lagi.");
      const identity = (await identityResponse.json() as { data?: AccountIdentity }).data;
      if (identity?.accountKey !== accountKey) {
        if (generation.current === scopeGeneration) reloadForSessionChange();
        throw new AccountChangedError();
      }
      setReauthRequired(true);
      throw new Error("Akun SAGE masih aktif, tetapi akses GitHub perlu diperbarui. Keluar lalu masuk kembali untuk menyambungkan akun GitHub.");
    }
    let payload: { data?: T; error?: { message?: string } };
    try { payload = await response.json(); }
    catch { throw new Error("Layanan belum tersedia. Coba lagi."); }
    if (new URL(path, window.location.href).pathname !== "/api/auth/session") {
      // The account cookie can change while any repository action is in flight.
      // Check the active server identity after consuming its body, before exposing
      // either returned data or an API error to the page scoped to this account.
      let identityResponse: Response;
      try {
        identityResponse = await fetch("/api/auth/session", {
          headers: { "X-SAGE-Account": accountKey }, cache: "no-store", credentials: "same-origin",
        });
      } catch {
        throw new Error("Sesi belum dapat diperiksa. Coba lagi.");
      }
      if (identityResponse.status === 401) {
        if (generation.current === scopeGeneration) reloadForSessionChange();
        throw new AccountChangedError();
      }
      if (!identityResponse.ok) throw new Error("Sesi belum dapat diperiksa. Coba lagi.");
      let identity: AccountIdentity | undefined;
      try { identity = (await identityResponse.json() as { data?: AccountIdentity }).data; }
      catch { throw new Error("Sesi belum dapat diperiksa. Coba lagi."); }
      if (identity?.accountKey !== accountKey) {
        if (generation.current === scopeGeneration) reloadForSessionChange();
        throw new AccountChangedError();
      }
    }
    if (!response.ok) throw new Error(payload.error?.message || "Layanan belum tersedia. Coba lagi.");
    return payload.data as T;
  }

  function clearAccountData() {
    generation.current += 1;
    setInstallations([]); setInstallationPage(null); setRepositories([]); setRepoPage(null);
    setSelectedInstallation(""); setQuery(""); setLoaded(false);
    setPublicRepositories([]); setPublicPage(null); setPublicQuery(""); setPublicError(""); setPublicLoaded(false);
    setChosen(null); setBranches([]); setBranchPage(null); setBranchLoaded(false); setBranch(""); setCommit(""); setTarget(null);
    setRepository(""); setResolved(null); setError(""); setReauthRequired(false); setBusy(false); setPublicBusy(false);
  }

  useEffect(() => {
    let active = true;
    let identityCheckRunning = false;
    async function verifyIdentity() {
      if (identityCheckRunning) return;
      identityCheckRunning = true;
      try {
        const identity = await request<AccountIdentity>("/api/auth/session");
        if (!active) return;
        if (identity.accountKey !== accountKey) { reloadForSessionChange(); return; }
        setScopeError(""); setScopeVerified(true);
      } catch (cause) {
        if (!active || cause instanceof AccountChangedError) return;
        setScopeError(cause instanceof Error ? cause.message : "Sesi belum dapat diperiksa.");
      } finally { identityCheckRunning = false; }
    }
    void verifyIdentity();
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") void verifyIdentity();
    }, 15_000);
    const onFocus = () => { if (document.visibilityState === "visible") void verifyIdentity(); };
    const onPageShow = () => void verifyIdentity();
    const onVisibility = () => { if (document.visibilityState === "visible") void verifyIdentity(); };
    window.addEventListener("focus", onFocus);
    window.addEventListener("pageshow", onPageShow);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      active = false; generation.current += 1; window.clearInterval(interval);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("pageshow", onPageShow);
      document.removeEventListener("visibilitychange", onVisibility);
    };
    // This effect is intentionally tied to the server-rendered account scope.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountKey]);

  useEffect(() => {
    if (!scopeVerified) return;
    let active = true;
    const requestGeneration = generation.current;
    queueMicrotask(() => {
      if (!active) return;
      void request<Page<Installation>>("/api/github/installations?page=1")
        .then(result => { if (active && generation.current === requestGeneration) { setInstallations(result.items); setInstallationPage(result.nextPage); setLoaded(true); } })
        .catch(cause => { if (active && generation.current === requestGeneration && !(cause instanceof AccountChangedError)) setError(cause instanceof Error ? cause.message : "Instalasi belum dapat dimuat. Coba lagi."); })
        .finally(() => { if (active && generation.current === requestGeneration) setBusy(false); });
    });
    queueMicrotask(() => {
      if (!active) return;
      void request<Page<Repository>>("/api/repositories/public?page=1")
        .then(result => { if (active && generation.current === requestGeneration) { setPublicRepositories(result.items); setPublicPage(result.nextPage); setPublicLoaded(true); } })
        .catch(cause => { if (active && generation.current === requestGeneration && !(cause instanceof AccountChangedError)) setPublicError(cause instanceof Error ? cause.message : "Repository publik belum dapat dimuat."); })
        .finally(() => { if (active && generation.current === requestGeneration) setPublicBusy(false); });
    });
    return () => { active = false; };
    // Reload both account-specific lists only after the signed-in identity is verified.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeVerified, accountKey]);

  async function loadInstallations(page = 1) {
    const requestGeneration = generation.current;
    setError(""); setReauthRequired(false); setBusy(true);
    try {
      const result = await request<Page<Installation>>(`/api/github/installations?page=${page}`);
      if (generation.current !== requestGeneration) return;
      setInstallations(old => page === 1 ? result.items : [...old, ...result.items]);
      setInstallationPage(result.nextPage); setLoaded(true);
    } catch (cause) { if (generation.current === requestGeneration && !(cause instanceof AccountChangedError)) setError(cause instanceof Error ? cause.message : "GitHub belum tersedia."); }
    finally { if (generation.current === requestGeneration) setBusy(false); }
  }
  async function loadRepositories(id: string, page = 1) {
    const requestGeneration = generation.current;
    setError(""); setBusy(true); setSelectedInstallation(id);
    if (page === 1) { setRepositories([]); setRepoPage(null); setQuery(""); }
    try {
      const result = await request<Page<Repository>>(`/api/github/installations/${encodeURIComponent(id)}/repositories?page=${page}`);
      if (generation.current !== requestGeneration) return;
      setRepositories(old => page === 1 ? result.items : [...old, ...result.items]); setRepoPage(result.nextPage);
    } catch (cause) { if (generation.current === requestGeneration && !(cause instanceof AccountChangedError)) setError(cause instanceof Error ? cause.message : "GitHub belum tersedia."); }
    finally { if (generation.current === requestGeneration) setBusy(false); }
  }
  async function loadPublicRepositories(page = 1) {
    const requestGeneration = generation.current;
    setPublicError(""); setReauthRequired(false); setPublicBusy(true);
    try {
      const result = await request<Page<Repository>>(`/api/repositories/public?page=${page}`);
      if (generation.current !== requestGeneration) return;
      setPublicRepositories(old => page === 1 ? result.items : [...old, ...result.items]);
      setPublicPage(result.nextPage); setPublicLoaded(true);
    } catch (cause) { if (generation.current === requestGeneration && !(cause instanceof AccountChangedError)) setPublicError(cause instanceof Error ? cause.message : "Repository publik belum dapat dimuat."); }
    finally { if (generation.current === requestGeneration) setPublicBusy(false); }
  }
  async function resolve(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); const requestGeneration = generation.current; setBusy(true); setError(""); setReauthRequired(false); setResolved(null);
    try {
      const resolvedRepository = await request<Repository>("/api/repositories/resolve", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ repository }),
      });
      if (generation.current === requestGeneration) setResolved(resolvedRepository);
    } catch (cause) { if (generation.current === requestGeneration && !(cause instanceof AccountChangedError)) setError(cause instanceof Error ? cause.message : "Repository tidak dapat diperiksa."); }
    finally { if (generation.current === requestGeneration) setBusy(false); }
  }
  async function choose(item: Repository, page = 1) {
    const requestGeneration = generation.current;
    setError(""); setReauthRequired(false); setBusy(true); setTarget(null);
    if (page === 1) { setChosen(item); setBranchPage(null); setBranches([]); setBranch(""); setCommit(""); setBranchLoaded(false); }
    try {
      const result = await request<Page<Branch>>(`/api/repositories/branches?repository=${encodeURIComponent(item.fullName)}&page=${page}`);
      if (generation.current !== requestGeneration) return;
      setBranches(old => [...new Map((page === 1 ? result.items : [...old, ...result.items]).map(value => [value.name, value])).values()]);
      if (page === 1) setBranch(item.defaultBranch || result.items[0]?.name || "");
      setBranchPage(result.nextPage); setBranchLoaded(true);
    } catch (cause) { if (generation.current === requestGeneration && !(cause instanceof AccountChangedError)) setError(cause instanceof Error ? cause.message : "Branch belum dapat dimuat."); }
    finally { if (generation.current === requestGeneration) setBusy(false); }
  }
  async function validate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!chosen || !branch || busy) return;
    const requestGeneration = generation.current;
    setBusy(true); setError(""); setReauthRequired(false); setTarget(null);
    try {
      const validated = await request<ValidatedTarget>("/api/repositories/target", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ repository: chosen.fullName, branch, commit: commit.trim() || null }) });
      if (generation.current === requestGeneration) setTarget(validated);
    } catch (cause) { if (generation.current === requestGeneration && !(cause instanceof AccountChangedError)) setError(cause instanceof Error ? cause.message : "Target tidak valid."); }
    finally { if (generation.current === requestGeneration) setBusy(false); }
  }
  async function startAnalysis() {
    if (!target || busy) return;
    const requestGeneration = generation.current;
    const targetKey = `${target.repository.id}:${target.branch}:${target.commitSha}`;
    if (submissionKey.current?.target !== targetKey) submissionKey.current = { target: targetKey, key: `target-${crypto.randomUUID()}` };
    setBusy(true); setError(""); setReauthRequired(false);
    try {
      let response: Response | null = null;
      let payload: { data?: EnqueuedAnalysis; error?: { message?: string } } | null = null;
      let requestError: unknown = null;
      try {
        response = await fetch("/api/analyses", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": submissionKey.current.key,
            "X-SAGE-Account": accountKey,
          },
          body: JSON.stringify({ repository: target.repository.fullName, branch: target.branch, commit: target.commitSha }),
          cache: "no-store",
          credentials: "same-origin",
        });
        try { payload = await response.json(); } catch { /* Verify the session before reporting a response parse error. */ }
      } catch (cause) {
        requestError = cause;
      }
      if (generation.current !== requestGeneration) return;
      // Read the POST body first, then check the active server session before using
      // either an error message or a successful result from the response.
      const identity = await request<AccountIdentity>("/api/auth/session");
      if (generation.current !== requestGeneration) return;
      if (identity.accountKey !== accountKey) { reloadForSessionChange(); return; }
      if (!response) throw requestError instanceof Error ? requestError : new Error("Analisis belum dapat dimulai. Coba lagi dengan target yang sama.");
      if (!response.ok) {
        if (response.status === 401) setReauthRequired(true);
        throw new Error(response.status === 401
          ? "Akun SAGE masih aktif, tetapi akses GitHub perlu diperbarui. Keluar lalu masuk kembali untuk menyambungkan akun GitHub."
          : payload?.error?.message || "Analisis belum dapat dimulai. Coba lagi dengan target yang sama.");
      }
      if (typeof payload?.data?.analysisId !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(payload.data.analysisId)) {
        throw new Error("Analisis sudah dikirim, tetapi progresnya belum dapat dibuka. Buka riwayat untuk memeriksa statusnya.");
      }
      // Force a fresh server session check; avoid reusing an App Router RSC cache
      // entry from before the post-response account verification.
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination
      window.location.assign(`/analyses/${encodeURIComponent(payload.data.analysisId)}`);
    } catch (cause) {
      if (generation.current === requestGeneration && !(cause instanceof AccountChangedError)) {
        if (cause instanceof Error && cause.message === "Sesi belum dapat diperiksa. Coba lagi.") {
          setError("Sesi belum dapat diperiksa. Coba lagi sebelum menggunakan hasil permintaan.");
        } else {
          setError(cause instanceof Error ? cause.message : "Analisis belum dapat dimulai. Coba lagi dengan target yang sama.");
        }
      }
    } finally { if (generation.current === requestGeneration) setBusy(false); }
  }
  function repoRow(item: Repository) {
    const selected = chosen?.id === item.id;
    return <li key={item.id}>
      <button type="button" className={css.row} aria-label={`Pilih ${item.fullName}`} aria-pressed={selected} disabled={busy || !scopeVerified} onClick={() => void choose(item)}>
        <span className={css.rowIcon}><Icon name="repo" /></span>
        <span className={css.rowCopy}>
          <span className={css.rowName} title={item.fullName}>{item.fullName}</span>
          <span className={css.rowMeta}>Branch default: {item.defaultBranch || "Belum ada commit"}</span>
        </span>
        <Badge tone="neutral">{item.private ? "Private · berizin" : "Public"}</Badge>
        <span className={css.rowEnd} aria-hidden="true">
          {selected ? <Icon name="checkCircle" className={css.check} /> : <Icon name="chevronRight" className={css.chevron} />}
        </span>
      </button>
    </li>;
  }
  const step = !chosen ? 0 : target ? 2 : 1;
  const head = <PageHead
    breadcrumb={[{ label: "Workspace", href: "/workspace" }, { label: "Repository" }]}
    title="Pilih repository"
    description={<>Pilih repository yang ingin dianalisis, lalu tentukan branch dan commit. Terhubung sebagai @{accountLogin}. Izin selalu diperiksa kembali melalui GitHub.</>}
    aside={<><Button href="/workspace" variant="link">Kembali ke workspace</Button><Stepper steps={["Repository", "Target", "Analisis"]} current={step} label="Langkah analisis" /></>}
  />;
  if (!scopeVerified) return <>
    {head}
    <Panel>
      {scopeError
        ? <EmptyState tone="error" role="status" icon="repo" action={<Button variant="secondary" onClick={() => window.location.reload()}>Muat ulang sesi</Button>}>{scopeError}</EmptyState>
        : <SkeletonRows rows={4} label="Memeriksa akun GitHub dan memuat daftar repository…" />}
    </Panel>
  </>;
  const filteredPublic = publicRepositories.filter(item => item.fullName.toLowerCase().includes(publicQuery.trim().toLowerCase()));
  const filteredApp = repositories.filter(item => item.fullName.toLowerCase().includes(query.trim().toLowerCase()));
  const publicCount = `${publicRepositories.length}${publicPage ? "+" : ""}`;
  const appCount = `${repositories.length}${repoPage ? "+" : ""}`;
  return <>
    {head}
    {error ? <p role="alert" className={css.alert}>{error}</p> : null}
    {busy && !chosen ? <p role="status" className={design.srOnly}>Memeriksa GitHub…</p> : null}
    {reauthRequired ? <form action="/auth/logout" method="post" className={css.reauth}><Button type="submit" variant="secondary">Keluar untuk menyambungkan ulang GitHub</Button></form> : null}
    <div className={css.layout} aria-busy={busy || publicBusy}>
      <div className={css.column}>
        <Panel>
          <div className={css.cardHead}>
            <h2 className={css.cardTitle}>Repository kamu</h2>
            <nav className={css.sourcePills} aria-label="Sumber repository">
              <PillLink href="#sumber-public" active={visibleSource === "sumber-public"}>Public · {publicCount}</PillLink>
              <PillLink href="#sumber-app" active={visibleSource === "sumber-app"}>GitHub App · {appCount}</PillLink>
            </nav>
          </div>

          <section id="sumber-public" className={css.source} aria-labelledby="sumber-public-heading">
            <h3 id="sumber-public-heading" ref={repositoryListHeading} tabIndex={-1} className={css.sourceTitle}>Repository public milik @{accountLogin}</h3>
            <p className={css.sourceLead}>Daftar repository public yang dimiliki akun GitHub-mu. Pilih repository untuk memuat branch.</p>
            {publicError ? <EmptyState tone="error" role="alert" icon="repo" action={<Button variant="secondary" onClick={() => void loadPublicRepositories()}>Coba lagi</Button>}>{publicError}</EmptyState> : null}
            {publicBusy && !publicLoaded ? <SkeletonRows rows={5} className={css.skeletonRows} label="Memuat repository publik…" /> : null}
            {publicLoaded && publicRepositories.length === 0 ? <EmptyState icon="repo">Akun ini belum memiliki repository public. Repository public orang lain bisa dicari di bagian bawah.</EmptyState> : null}
            {publicLoaded && publicRepositories.length > 0 ? <>
              <Field label="Cari repository public milikmu" icon={<Icon name="search" />} value={publicQuery} onChange={event => setPublicQuery(event.target.value)} placeholder="Cari repository…" type="search" />
              {filteredPublic.length === 0 ? <EmptyState icon="search" action={<Button variant="ghost" onClick={() => setPublicQuery("")}>Reset pencarian</Button>}>Tidak ada hasil pencarian. Coba kata lain.</EmptyState> : null}
              <ScrollList label="Daftar repository public" footer={publicPage ? <Button variant="link" disabled={publicBusy} onClick={() => void loadPublicRepositories(publicPage)}>Repository public berikutnya</Button> : undefined}>
                {filteredPublic.length > 0 ? <ul className={css.list}>{filteredPublic.map(repoRow)}</ul> : null}
              </ScrollList>
            </> : null}
            {publicPage && !(publicLoaded && publicRepositories.length > 0) ? <div className={css.inlineActions}><Button variant="link" disabled={publicBusy} onClick={() => void loadPublicRepositories(publicPage)}>Repository public berikutnya</Button></div> : null}
            {publicLoaded ? <div className={css.inlineActions}><Button variant="link" disabled={publicBusy} onClick={() => void loadPublicRepositories()}>Muat ulang repository public</Button></div> : null}
          </section>

          <section id="sumber-app" className={css.source} aria-labelledby="sumber-app-heading">
            <h3 id="sumber-app-heading" className={css.sourceTitle}>Repository yang dapat diakses lewat GitHub App</h3>
            <p className={css.sourceLead}>Daftar ini bisa memuat repository milik organisasi atau repository tempat akunmu menjadi kolaborator. Private hanya bisa dibaca jika akunmu dan App sama-sama mendapat izin Contents read.</p>
            <div className={css.inlineActions}>
              <Button variant="link" disabled={busy} onClick={() => void loadInstallations()}>Muat ulang instalasi</Button>
              {installUrl && installations.length > 0 ? <a href={installUrl} target="_blank" rel="noreferrer" className={css.textButton}>Atur akses App di GitHub</a> : null}
            </div>
            {loaded && installations.length === 0 ? <EmptyState icon="github" action={installUrl ? <Button href={installUrl} variant="secondary" target="_blank" rel="noreferrer">Atur akses App di GitHub</Button> : undefined}>Belum ada instalasi yang dapat diakses lewat App.</EmptyState> : null}
            {installations.length > 0 ? <ul className={css.installations}>{installations.map(item => <li key={item.id}><button type="button" className={design.navPill} disabled={busy} onClick={() => void loadRepositories(item.id)} aria-pressed={selectedInstallation === item.id}>{item.accountLogin}</button></li>)}</ul> : null}
            {installationPage ? <div className={css.inlineActions}><Button variant="link" disabled={busy} onClick={() => void loadInstallations(installationPage)}>Instalasi berikutnya</Button></div> : null}
            {selectedInstallation && busy && repositories.length === 0 && !error ? <SkeletonRows rows={5} className={css.skeletonRows} label="Memuat repository instalasi…" /> : null}
            {selectedInstallation && !busy && !error && repositories.length === 0 ? <EmptyState icon="repo">Tidak ada repository yang dapat dibaca pada instalasi ini.</EmptyState> : null}
            <Field label="Cari pada repository App yang sudah dimuat" icon={<Icon name="search" />} value={query} onChange={event => setQuery(event.target.value)} placeholder="Cari repository…" type="search" />
            {repositories.length > 0 && filteredApp.length === 0 ? <EmptyState icon="search" action={<Button variant="ghost" onClick={() => setQuery("")}>Reset pencarian</Button>}>Tidak ada hasil pencarian pada halaman yang dimuat.</EmptyState> : null}
            {repositories.length > 0 ? <ScrollList label="Daftar repository GitHub App" footer={repoPage ? <Button variant="link" disabled={busy} onClick={() => void loadRepositories(selectedInstallation, repoPage)}>Repository berikutnya</Button> : undefined}>
              {filteredApp.length > 0 ? <ul className={css.list}>{filteredApp.map(repoRow)}</ul> : null}
            </ScrollList> : null}
            {repoPage && repositories.length === 0 ? <div className={css.inlineActions}><Button variant="link" disabled={busy} onClick={() => void loadRepositories(selectedInstallation, repoPage)}>Repository berikutnya</Button></div> : null}
          </section>
        </Panel>

        <Panel title="Repository publik milik pihak lain">
          <form onSubmit={resolve} className={css.resolveForm}>
            <Field label="Nama atau URL GitHub" disabled={busy} required maxLength={300} value={repository} onChange={e => setRepository(e.target.value)} placeholder="owner/repository" hint="Memasukkan URL private tidak menambah izin. Hanya github.com yang diterima." />
            <Button type="submit" variant="secondary" disabled={busy}>Periksa repository</Button>
          </form>
          {resolved ? <ul className={`${css.list} ${css.resolved}`}>{repoRow(resolved)}</ul> : null}
        </Panel>
        {!chosen ? <p className={css.caption}>Pemeriksaan akses tidak menjalankan job. Job dibuat setelah target tervalidasi dan tombol Mulai analisis dipilih.</p> : null}
      </div>

      <section ref={targetSection} className={`${design.panel} ${css.target}`} aria-labelledby={chosen ? "analysis-target-heading" : "target-placeholder-heading"}>
        {chosen ? <div key={chosen.id} className={css.targetBody}>
          <p className={css.label}>Target analisis</p>
          <h2 id="analysis-target-heading" ref={targetHeading} tabIndex={-1} className={css.targetName}>
            <span className={design.srOnly}>Siapkan analisis: </span>
            <Icon name="repo" className={css.maskTeal} />
            <span>{chosen.fullName}</span>
          </h2>
          <p className={css.visibility}><Badge tone={chosen.private ? "neutral" : "teal"}>{chosen.private ? "Private" : "Public"}</Badge>{chosen.private ? "Berizin melalui GitHub App" : "Dapat dianalisis"}. Pilih branch dan commit yang akan dianalisis.</p>
          <div className={design.targetActions}>
            <Button variant="secondary" disabled={busy} onClick={() => { setChosen(null); setBranches([]); setBranchPage(null); setBranchLoaded(false); setBranch(""); setCommit(""); setTarget(null); setError(""); setTimeout(() => repositoryListHeading.current?.focus(), 0); }}>Pilih repository lain</Button>
            <Button variant="secondary" disabled={busy} onClick={() => void choose(chosen)}>Muat ulang branch</Button>
          </div>
          {busy && !branchLoaded ? <p className={css.status} role="status"><Spinner /> Memuat branch untuk {chosen.fullName}…</p> : null}
          {branchLoaded && branches.length === 0 ? <EmptyState icon="gitBranch">Repository ini belum memiliki branch. Tambahkan commit di GitHub sebelum memilih target.</EmptyState> : null}
          <form onSubmit={event => { setPending("validate"); void validate(event).finally(() => setPending(null)); }} className={css.form}>
            <Field id="target-branch" label="Branch" icon={<Icon name="gitBranch" />} trailing={<Icon name="chevronDown" />} mono>
              <select id="target-branch" disabled={busy || (branches.length === 0 && !chosen.defaultBranch)} value={branch} onChange={e => { setBranch(e.target.value); setCommit(""); setTarget(null); }}><option value="" disabled>Pilih branch</option>{chosen.defaultBranch && !branches.some(item => item.name === chosen.defaultBranch) ? <option value={chosen.defaultBranch}>{chosen.defaultBranch}</option> : null}{branches.map(item => <option key={item.name} value={item.name}>{item.name}</option>)}</select>
            </Field>
            {branchPage ? <button type="button" disabled={busy} onClick={() => void choose(chosen, branchPage)} className={css.textButton}>Muat branch berikutnya</button> : null}
            <Field id="target-commit" label="Commit" optional mono disabled={busy} value={commit} maxLength={64} onChange={e => { setCommit(e.target.value); setTarget(null); }} placeholder="Kosongkan untuk commit terbaru" hint="Commit harus berada dalam riwayat branch yang dipilih. Branch dan izin diperiksa kembali saat memeriksa target." />
            <Button type="submit" variant={target ? "secondary" : "primary"} block disabled={busy || !branch} loading={pending === "validate"}>{pending === "validate" ? "Memeriksa target…" : "Periksa target"}</Button>
          </form>
          {target ? <>
            <div role="status" className={css.validated}>
              <span className={css.validatedTitle}><Icon name="checkCircle" /><strong>Target tervalidasi</strong></span>
              <p className={css.validatedMeta}>{target.repository.fullName} · {target.branch}</p>
              <CopySha sha={target.commitSha} />
              <p className={css.validatedNote}>Analisis akan disimpan untuk full SHA ini.</p>
            </div>
            <Button size="lg" block disabled={busy || !scopeVerified} loading={pending === "start"} onClick={() => { setPending("start"); void startAnalysis().finally(() => setPending(null)); }}>{pending === "start" || busy ? "Mengantrekan analisis…" : "Mulai analisis"}</Button>
          </> : null}
        </div> : <div className={css.placeholder}>
          <p className={css.label}>Target analisis</p>
          <h2 id="target-placeholder-heading" className={css.sourceTitle}>Belum ada repository dipilih</h2>
          <EmptyState icon="gitBranch">Pilih repository di daftar untuk menentukan branch dan commit.</EmptyState>
        </div>}
      </section>
    </div>
  </>;
}
