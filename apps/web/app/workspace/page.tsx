import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { readWorkspaceContext } from "../../lib/auth/server-session.ts";
import Link from "next/link";
import { DesignFrame, Panel } from "../../components/design-system/ui.tsx";

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

  return <DesignFrame>
      <section className="flex min-h-[calc(100dvh-140px)] flex-col justify-center py-12">
        <p className="font-mono text-xs tracking-wide text-ink/55">WORKSPACE</p>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-4">
          <h1 className="text-[28px] leading-9 font-semibold tracking-tight">Halo, {label}.</h1>
          <form action="/auth/logout" method="post">
            <button className="rounded-md border border-ink/15 bg-white px-4 py-2 text-sm font-medium hover:bg-ink/5" type="submit">Keluar</button>
          </form>
        </div>
        <p className="mt-3 text-sm text-ink/65">Terhubung sebagai <span className="font-medium">@{workspace.connectionLogin}</span>.</p>
        {logoutFailed ? <p role="alert" className="mt-6 max-w-2xl rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-950">SAGE belum dapat mencabut sesi. Sesi masih aktif; coba keluar lagi.</p> : null}
        <Panel title="Akses repository GitHub" className="mt-8 max-w-3xl">
          <p className="mt-2 text-sm leading-6 text-ink/65">
            Periksa repository public atau instalasi App yang dapat diakses oleh akunmu.
            Setelah target branch dan commit divalidasi, kamu dapat memulai analisis dan mengikuti progresnya.
          </p>
          <Link href="/workspace/repositories" className="mt-4 inline-flex min-h-10 items-center rounded-md bg-[#2ac6ae] px-4 py-2 text-sm font-semibold text-[#061e42]">Buka repository</Link>
          <p className="mt-4 text-xs text-ink/50">Sesi berakhir {sessionExpiry} WIB.</p>
        </Panel>
      </section>
    </DesignFrame>;
}
