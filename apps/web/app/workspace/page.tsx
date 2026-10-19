import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { readWorkspaceContext } from "../../lib/auth/server-session.ts";

export const metadata: Metadata = {
  title: "Workspace — SAGE",
  robots: { index: false, follow: false },
};

type WorkspacePageProps = {
  readonly searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export default async function WorkspacePage({ searchParams }: WorkspacePageProps) {
  const params = await searchParams;
  const logoutFailed = params?.error === "logout";
  let workspace;
  try {
    workspace = await readWorkspaceContext();
  } catch {
    redirect("/login?error=unavailable");
  }
  if (!workspace) redirect("/login?error=session");

  const label = workspace.displayName?.trim() || workspace.login;
  const sessionExpiry = new Intl.DateTimeFormat("id-ID", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Jakarta",
  }).format(workspace.sessionExpiresAt);

  return (
    <main className="mx-auto flex min-h-screen max-w-6xl flex-col px-5 sm:px-8">
      <header className="flex items-center justify-between border-b border-ink/10 py-6">
        <Link href="/" className="text-2xl font-bold tracking-tight" aria-label="SAGE beranda">SAGE<span className="text-accent">.</span></Link>
        <form action="/auth/logout" method="post">
          <button className="rounded-lg border border-ink/15 bg-white px-4 py-2 text-sm font-medium hover:bg-ink/5" type="submit">Keluar</button>
        </form>
      </header>
      <section className="flex flex-1 flex-col justify-center py-16">
        <p className="font-mono text-xs tracking-wide text-ink/55">WORKSPACE</p>
        <h1 className="mt-3 text-4xl font-semibold tracking-tight">Halo, {label}.</h1>
        <p className="mt-3 text-sm text-ink/65">Terhubung sebagai <span className="font-medium">@{workspace.connectionLogin}</span>.</p>
        {logoutFailed ? <p role="alert" className="mt-6 max-w-2xl rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-950">SAGE belum dapat mencabut sesi. Sesi masih aktif; coba keluar lagi.</p> : null}
        <div className="mt-8 max-w-2xl rounded-xl border border-ink/10 bg-white p-6">
          <h2 className="text-base font-semibold">Akses repository GitHub</h2>
          <p className="mt-2 text-sm leading-6 text-ink/65">
            Periksa repository public atau instalasi App yang dapat diakses oleh akunmu.
            Pembuatan job analisis belum tersedia.
          </p>
          <Link href="/workspace/repositories" className="mt-4 inline-block rounded-lg bg-ink px-4 py-2 text-sm text-white">Buka repository</Link>
          <p className="mt-4 text-xs text-ink/50">Sesi berakhir {sessionExpiry} WIB.</p>
        </div>
      </section>
      <footer className="border-t border-ink/10 py-5 text-xs text-ink/55">Source-code Architecture Graph Extraction</footer>
    </main>
  );
}
