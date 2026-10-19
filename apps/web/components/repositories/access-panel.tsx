"use client";

import { useEffect, useState } from "react";

type Installation = { id: string; accountLogin: string };
type Repository = { id: string; fullName: string; private: boolean; defaultBranch: string | null };
type Page<T> = { items: T[]; nextPage: number | null };

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
    if (page === 1) setRepositories([]);
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
  function repoCard(item: Repository) {
    return <li key={item.id} className="rounded-lg border border-ink/20 p-4 break-words">
      <strong>{item.fullName}</strong><span className="ml-2 text-xs">{item.private ? "Private · berizin" : "Public"}</span>
      <p className="mt-2 text-sm">Branch default: {item.defaultBranch || "Belum ada commit"}</p>
    </li>;
  }
  return <div className="mt-8 space-y-8" aria-busy={busy}>
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
      <ul className="mt-4 space-y-3">{repositories.map(repoCard)}</ul>
      {repoPage ? <button disabled={busy} onClick={() => void loadRepositories(selectedInstallation, repoPage)} className="mt-3 underline">Repository berikutnya</button> : null}
    </section>
    <section className="rounded-xl border border-ink/20 bg-white p-5">
      <h2 className="text-xl font-semibold">Public milik siapa saja</h2>
      <form onSubmit={resolve} className="mt-4 flex flex-col gap-3 sm:flex-row">
        <label className="flex-1">Nama atau URL GitHub<input required maxLength={300} value={repository} onChange={e => setRepository(e.target.value)} placeholder="owner/repository" className="mt-2 block w-full rounded border border-ink/40 px-3 py-2" /></label>
        <button disabled={busy} className="self-start rounded bg-ink px-4 py-2 text-white disabled:opacity-50 sm:self-end">Periksa repository</button>
      </form>
      <p className="mt-3 text-sm">Memasukkan URL private tidak menambah izin. Hanya github.com yang diterima.</p>
      {resolved ? <ul className="mt-4">{repoCard(resolved)}</ul> : null}
    </section>
    <p className="text-sm text-ink/70">Pemeriksaan akses belum menjalankan job analisis.</p>
  </div>;
}
