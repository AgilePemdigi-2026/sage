"use client";

import { useEffect, useState } from "react";
import design from "../design-system/ui.module.css";

type Installation = { id: string; accountLogin: string };
type Repository = { id: string; fullName: string; private: boolean; defaultBranch: string | null };
type Page<T> = { items: T[]; nextPage: number | null };
type Branch = { name: string; commitSha: string };
type ValidatedTarget = { repository: Repository; branch: string; commitSha: string; branchHeadSha: string };

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, cache: "no-store", credentials: "same-origin" });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error?.message || "Layanan belum tersedia. Coba lagi.");
  return payload.data as T;
}

export function RepositoryAccessPanel({ installUrl }: { installUrl: string | null }) {
  const [installations, setInstallations] = useState<Installation[]>([]);
  const [installationPage, setInstallationPage] = useState<number | null>(null);
  const [repositories, setRepositories] = useState<Repository[]>([]);
  const [repoPage, setRepoPage] = useState<number | null>(null);
  const [selectedInstallation, setSelectedInstallation] = useState("");
  const [repository, setRepository] = useState("");
  const [resolved, setResolved] = useState<Repository | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [query, setQuery] = useState("");
  const [chosen, setChosen] = useState<Repository | null>(null);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [branchPage, setBranchPage] = useState<number | null>(null);
  const [branchLoaded, setBranchLoaded] = useState(false);
  const [branch, setBranch] = useState("");
  const [commit, setCommit] = useState("");
  const [target, setTarget] = useState<ValidatedTarget | null>(null);

  async function loadInstallations(page = 1) {
    setError(""); setBusy(true);
    try {
      const result = await request<Page<Installation>>(`/api/github/installations?page=${page}`);
      setInstallations(old => page === 1 ? result.items : [...old, ...result.items]);
      setInstallationPage(result.nextPage); setLoaded(true);
    } catch (e) { setError(e instanceof Error ? e.message : "GitHub belum tersedia."); }
    finally { setBusy(false); }
  }
  useEffect(() => {
    let active = true;
    void request<Page<Installation>>("/api/github/installations?page=1")
      .then(result => { if (active) { setInstallations(result.items); setInstallationPage(result.nextPage); setLoaded(true); } })
      .catch(() => { if (active) setError("Instalasi belum dapat dimuat. Coba muat ulang atau masuk lagi."); })
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, []);

  async function loadRepositories(id: string, page = 1) {
    setError(""); setBusy(true); setSelectedInstallation(id);
    if (page === 1) { setRepositories([]); setRepoPage(null); setQuery(""); }
    try {
      const result = await request<Page<Repository>>(`/api/github/installations/${encodeURIComponent(id)}/repositories?page=${page}`);
      setRepositories(old => page === 1 ? result.items : [...old, ...result.items]); setRepoPage(result.nextPage);
    } catch (e) { setError(e instanceof Error ? e.message : "GitHub belum tersedia."); }
    finally { setBusy(false); }
  }
  async function resolve(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(""); setResolved(null);
    try { setResolved(await request<Repository>("/api/repositories/resolve", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ repository }),
    })); } catch (e) { setError(e instanceof Error ? e.message : "Repository tidak dapat diperiksa."); }
    finally { setBusy(false); }
  }
  async function choose(item: Repository, page = 1) {
    setError(""); setBusy(true); setTarget(null);
    if (page === 1) { setChosen(item); setBranchPage(null); setBranches([]); setBranch(""); setCommit(""); setBranchLoaded(false); }
    try {
      const result = await request<Page<Branch>>(`/api/repositories/branches?repository=${encodeURIComponent(item.fullName)}&page=${page}`);
      setBranches(old => [...new Map((page === 1 ? result.items : [...old, ...result.items]).map(value => [value.name, value])).values()]);
      if (page === 1) setBranch(result.items.find(value => value.name === item.defaultBranch)?.name ?? result.items[0]?.name ?? "");
      setBranchPage(result.nextPage); setBranchLoaded(true);
    } catch (e) { setError(e instanceof Error ? e.message : "Branch belum dapat dimuat."); }
    finally { setBusy(false); }
  }
  async function validate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!chosen || !branch || busy) return;
    setBusy(true); setError(""); setTarget(null);
    try { setTarget(await request<ValidatedTarget>("/api/repositories/target", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ repository: chosen.fullName, branch, commit: commit.trim() || null }) })); }
    catch (e) { setError(e instanceof Error ? e.message : "Target tidak valid."); }
    finally { setBusy(false); }
  }
  function repoCard(item: Repository) {
    return <li key={item.id} className={`${design.repositoryCard} break-words`}>
      <strong>{item.fullName}</strong><span className="ml-2 text-xs">{item.private ? "Private · berizin" : "Public"}</span>
      <p className="mt-2 text-sm">Branch default: {item.defaultBranch || "Belum ada commit"}</p>
      <button disabled={busy} onClick={() => void choose(item)} className="mt-3 rounded border border-ink/40 px-4 py-2">Pilih {item.fullName}</button>
    </li>;
  }
  return <div className={design.accessPanel} aria-busy={busy}>
    {error ? <p role="alert" className="rounded-lg border border-red-700 p-4 text-red-900">{error}</p> : null}
    {busy ? <p role="status">Memeriksa GitHub…</p> : null}
    <section className="rounded-xl border border-ink/20 bg-white p-5">
      <h2 className="text-xl font-semibold">Repository dari instalasi App</h2>
      <p className="mt-2 text-sm">Private hanya tersedia jika akunmu dan App sama-sama mendapat akses Contents read.</p>
      <button disabled={busy} onClick={() => void loadInstallations()} className="mt-4 rounded border border-ink/40 px-4 py-2 disabled:opacity-50">Muat ulang instalasi</button>
      {loaded && installations.length === 0 ? <p className="mt-4">Belum ada instalasi yang dapat diakses. Public tetap bisa diperiksa lewat form di bawah.</p> : null}
      {installUrl ? <a href={installUrl} target="_blank" rel="noreferrer" className="ml-3 inline-block py-2 underline">Atur akses App di GitHub</a> : null}
      <ul className="mt-4 flex flex-wrap gap-3">{installations.map(item => <li key={item.id}><button disabled={busy} onClick={() => void loadRepositories(item.id)} className="rounded border border-ink/40 px-4 py-2" aria-pressed={selectedInstallation === item.id}>{item.accountLogin}</button></li>)}</ul>
      {installationPage ? <button disabled={busy} onClick={() => void loadInstallations(installationPage)} className="mt-3 underline">Instalasi berikutnya</button> : null}
      {selectedInstallation && !busy && !error && repositories.length === 0 ? <p className="mt-4">Tidak ada repository yang dapat dibaca pada instalasi ini.</p> : null}
      <label className="mt-4 block text-sm">Cari pada repository yang sudah dimuat<input value={query} onChange={event => setQuery(event.target.value)} className="mt-2 block w-full rounded border border-ink/40 px-3 py-2" placeholder="Cari nama repository" /></label>
      {repositories.length > 0 && !repositories.some(item => item.fullName.toLowerCase().includes(query.trim().toLowerCase())) ? <p className="mt-4">Tidak ada hasil pencarian pada halaman yang dimuat.</p> : null}
      <ul className="mt-4 space-y-3">{repositories.filter(item => item.fullName.toLowerCase().includes(query.trim().toLowerCase())).map(repoCard)}</ul>
      {repoPage ? <button disabled={busy} onClick={() => void loadRepositories(selectedInstallation, repoPage)} className="mt-3 underline">Repository berikutnya</button> : null}
    </section>
    <section className="rounded-xl border border-ink/20 bg-white p-5">
      <h2 className="text-xl font-semibold">Public milik siapa saja</h2>
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
      {target ? <div role="status" className="mt-5 rounded border border-green-700 p-4"><strong>Target tervalidasi</strong><p className="mt-2 break-all font-mono text-sm">{target.repository.fullName} · {target.branch}<br />{target.commitSha}</p><p className="mt-2 text-sm">Belum ada job analisis yang dibuat.</p></div> : null}
    </section> : <section aria-label="Target analisis"><h2>Target analisis</h2><p>Pilih repository untuk memuat branch dan memeriksa commit yang akan digunakan.</p></section>}
    <p className="text-sm text-ink/70">Pemeriksaan akses belum menjalankan job analisis.</p>
  </div>;
}
