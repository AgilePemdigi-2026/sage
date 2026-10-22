"use client";

import { useEffect, useRef, useState } from "react";
import design from "../design-system/ui.module.css";

type Installation = { id: string; accountLogin: string };
type Repository = { id: string; fullName: string; private: boolean; defaultBranch: string | null };
type Page<T> = { items: T[]; nextPage: number | null };
type Branch = { name: string; commitSha: string };
type ValidatedTarget = { repository: Repository; branch: string; commitSha: string; branchHeadSha: string };
type AccountIdentity = { accountKey: string; login: string };
type EnqueuedAnalysis = { analysisId: string };

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
  const generation = useRef(0);
  const reloadStarted = useRef(false);
  const submissionKey = useRef<{ target: string; key: string } | null>(null);

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
    async function verifyIdentity(hideUntilVerified: boolean) {
      if (identityCheckRunning) return;
      identityCheckRunning = true;
      if (hideUntilVerified) { setScopeVerified(false); setScopeError(""); }
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
    void verifyIdentity(false);
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") void verifyIdentity(false);
    }, 15_000);
    const onFocus = () => { if (document.visibilityState === "visible") void verifyIdentity(true); };
    const onPageShow = () => void verifyIdentity(true);
    const onVisibility = () => { if (document.visibilityState === "visible") void verifyIdentity(true); };
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
      if (page === 1) setBranch(result.items.find(value => value.name === item.defaultBranch)?.name ?? result.items[0]?.name ?? "");
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
  function repoCard(item: Repository) {
    return <li key={item.id} className={`${design.repositoryCard} break-words`}>
      <strong>{item.fullName}</strong><span className="ml-2 text-xs">{item.private ? "Private · berizin" : "Public"}</span>
      <p className="mt-2 text-sm">Branch default: {item.defaultBranch || "Belum ada commit"}</p>
      <button disabled={busy || !scopeVerified} onClick={() => void choose(item)} className="mt-3 rounded border border-ink/40 px-4 py-2">Pilih {item.fullName}</button>
    </li>;
  }
  if (!scopeVerified) return <div className={design.accessPanel} role="status">
    <p>{scopeError || "Memeriksa akun GitHub dan memuat daftar repository…"}</p>
    {scopeError ? <button className="mt-3 underline" onClick={() => window.location.reload()}>Muat ulang sesi</button> : null}
  </div>;
  const filteredPublic = publicRepositories.filter(item => item.fullName.toLowerCase().includes(publicQuery.trim().toLowerCase()));
  return <div className={design.accessPanel} aria-busy={busy || publicBusy}>
    {error ? <p role="alert" className="rounded-lg border border-red-700 p-4 text-red-900">{error}</p> : null}
    {busy ? <p role="status">Memeriksa GitHub…</p> : null}
    {reauthRequired ? <form action="/auth/logout" method="post" className="mb-4"><button className="rounded border border-ink/40 px-4 py-2" type="submit">Keluar untuk menyambungkan ulang GitHub</button></form> : null}
    <section className="rounded-xl border border-ink/20 bg-white p-5">
      <h2 className="text-xl font-semibold">Repository public milik @{accountLogin}</h2>
      <p className="mt-2 text-sm">Daftar repository public yang dimiliki akun GitHub-mu. Pilih repository untuk memuat branch.</p>
      {publicError ? <p role="alert" className="mt-3 rounded-lg border border-red-700 p-4 text-red-900">{publicError} <button className="ml-2 underline" onClick={() => void loadPublicRepositories()}>Coba lagi</button></p> : null}
      {publicBusy && !publicLoaded ? <p role="status" className="mt-3">Memuat repository publik…</p> : null}
      {publicLoaded && publicRepositories.length === 0 ? <p className="mt-3">Akun ini belum memiliki repository public. Repository public orang lain bisa dicari di bagian bawah.</p> : null}
      {publicLoaded && publicRepositories.length > 0 ? <>
        <label className="mt-4 block text-sm">Cari repository public milikmu<input value={publicQuery} onChange={event => setPublicQuery(event.target.value)} className="mt-2 block w-full rounded border border-ink/40 px-3 py-2" placeholder="Cari nama repository" /></label>
        {filteredPublic.length === 0 ? <p className="mt-4">Tidak ada hasil pencarian. Coba kata lain.</p> : null}
        <ul className="mt-4 space-y-3">{filteredPublic.map(repoCard)}</ul>
      </> : null}
      {publicPage ? <button disabled={publicBusy} onClick={() => void loadPublicRepositories(publicPage)} className="mt-3 underline">Repository public berikutnya</button> : null}
      {publicLoaded ? <button disabled={publicBusy} onClick={() => void loadPublicRepositories()} className="mt-3 underline">Muat ulang repository public</button> : null}
    </section>
    <section className="rounded-xl border border-ink/20 bg-white p-5">
      <h2 className="text-xl font-semibold">Repository yang dapat diakses lewat GitHub App</h2>
      <p className="mt-2 text-sm">Daftar ini bisa memuat repository milik organisasi atau repository tempat akunmu menjadi kolaborator. Private hanya bisa dibaca jika akunmu dan App sama-sama mendapat izin Contents read.</p>
      <button disabled={busy} onClick={() => void loadInstallations()} className="mt-4 rounded border border-ink/40 px-4 py-2 disabled:opacity-50">Muat ulang instalasi</button>
      {loaded && installations.length === 0 ? <p className="mt-4">Belum ada instalasi yang dapat diakses lewat App.</p> : null}
      {installUrl ? <a href={installUrl} target="_blank" rel="noreferrer" className="ml-3 inline-block py-2 underline">Atur akses App di GitHub</a> : null}
      <ul className="mt-4 flex flex-wrap gap-3">{installations.map(item => <li key={item.id}><button disabled={busy} onClick={() => void loadRepositories(item.id)} className="rounded border border-ink/40 px-4 py-2" aria-pressed={selectedInstallation === item.id}>{item.accountLogin}</button></li>)}</ul>
      {installationPage ? <button disabled={busy} onClick={() => void loadInstallations(installationPage)} className="mt-3 underline">Instalasi berikutnya</button> : null}
      {selectedInstallation && !busy && !error && repositories.length === 0 ? <p className="mt-4">Tidak ada repository yang dapat dibaca pada instalasi ini.</p> : null}
      <label className="mt-4 block text-sm">Cari pada repository App yang sudah dimuat<input value={query} onChange={event => setQuery(event.target.value)} className="mt-2 block w-full rounded border border-ink/40 px-3 py-2" placeholder="Cari nama repository" /></label>
      {repositories.length > 0 && !repositories.some(item => item.fullName.toLowerCase().includes(query.trim().toLowerCase())) ? <p className="mt-4">Tidak ada hasil pencarian pada halaman yang dimuat.</p> : null}
      <ul className="mt-4 space-y-3">{repositories.filter(item => item.fullName.toLowerCase().includes(query.trim().toLowerCase())).map(repoCard)}</ul>
      {repoPage ? <button disabled={busy} onClick={() => void loadRepositories(selectedInstallation, repoPage)} className="mt-3 underline">Repository berikutnya</button> : null}
    </section>
    <section className="rounded-xl border border-ink/20 bg-white p-5">
      <h2 className="text-xl font-semibold">Repository publik milik pihak lain</h2>
      <form onSubmit={resolve} className="mt-4 flex flex-col gap-3 sm:flex-row">
        <label className="flex-1">Nama atau URL GitHub<input disabled={busy} required maxLength={300} value={repository} onChange={e => setRepository(e.target.value)} placeholder="owner/repository" className="mt-2 block w-full rounded border border-ink/40 px-3 py-2" /></label>
        <button disabled={busy} className="self-start rounded bg-ink px-4 py-2 text-white disabled:opacity-50 sm:self-end">Periksa repository</button>
      </form>
      <p className="mt-3 text-sm">Memasukkan URL private tidak menambah izin. Hanya github.com yang diterima.</p>
      {resolved ? <ul className="mt-4">{repoCard(resolved)}</ul> : null}
    </section>
    {chosen ? <section className="rounded-xl border border-ink/20 bg-white p-5">
      <h2 className="text-xl font-semibold">Versi kode: {chosen.fullName}</h2>
      <button disabled={busy} onClick={() => void choose(chosen)} className="mt-3 underline">Muat ulang branch</button>
      {branchLoaded && branches.length === 0 ? <p className="mt-4">Repository ini belum memiliki branch. Tambahkan commit di GitHub sebelum memilih target.</p> : null}
      <form onSubmit={validate} className="mt-4 space-y-4">
        <label className="block" htmlFor="target-branch">Branch</label><select id="target-branch" disabled={busy || branches.length === 0} value={branch} onChange={e => { setBranch(e.target.value); setCommit(""); setTarget(null); }} className="mt-2 block w-full rounded border border-ink/40 px-3 py-2"><option value="" disabled>Pilih branch</option>{branches.map(item => <option key={item.name} value={item.name}>{item.name}</option>)}</select>
        {branchPage ? <button type="button" disabled={busy} onClick={() => void choose(chosen, branchPage)} className="underline">Muat branch berikutnya</button> : null}
        <label className="block">Commit (opsional)<input disabled={busy} value={commit} maxLength={64} onChange={e => { setCommit(e.target.value); setTarget(null); }} placeholder="Kosongkan untuk commit terbaru branch" className="mt-2 block w-full rounded border border-ink/40 px-3 py-2 font-mono" /></label>
        <p className="text-sm">Commit harus berada dalam riwayat branch yang dipilih. Branch dan izin diperiksa kembali saat memeriksa target.</p>
        <button disabled={busy || !branch} className="rounded bg-ink px-4 py-2 text-white disabled:opacity-50">Periksa target</button>
      </form>
      {target ? <div role="status" className="mt-5 rounded border border-green-700 p-4"><strong>Target tervalidasi</strong><p className="mt-2 break-all font-mono text-sm">{target.repository.fullName} · {target.branch}<br />{target.commitSha}</p><p className="mt-2 text-sm">Analisis akan disimpan untuk full SHA ini.</p><button type="button" disabled={busy || !scopeVerified} onClick={() => void startAnalysis()} className="mt-4 rounded bg-ink px-4 py-2 text-white disabled:opacity-50">{busy ? "Mengantrekan analisis…" : "Mulai analisis"}</button></div> : null}
    </section> : <section aria-label="Target analisis"><h2>Target analisis</h2><p>Pilih repository untuk memuat branch dan memeriksa commit yang akan digunakan.</p></section>}
    <p className="text-sm text-ink/70">Pemeriksaan akses tidak menjalankan job. Job dibuat setelah target tervalidasi dan tombol Mulai analisis dipilih.</p>
  </div>;
}
