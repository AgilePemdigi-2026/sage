import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { loginRedirectPath, readWorkspaceContextCached } from "../../lib/auth/workspace-context.ts";
import { Badge, Button, DesignFrame, PageHead, Panel } from "../../components/design-system/ui.tsx";

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
    workspace = await readWorkspaceContextCached();
  } catch {
    redirect("/login?error=unavailable");
  }
  if (!workspace) redirect(await loginRedirectPath("workspace"));

  const label = workspace.displayName?.trim() || workspace.login;
  const sessionExpiry = new Intl.DateTimeFormat("id-ID", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Jakarta",
  }).format(workspace.sessionExpiresAt);

  return <DesignFrame active="repositories">
    <div className="mx-auto w-full max-w-[880px] py-6 sm:py-10">
      <PageHead
        breadcrumb={[{ label: "Workspace" }]}
        title={<>Halo, {label}<span className="-ml-[0.12em]">.</span></>}
        description={<>Terhubung sebagai <span className="font-semibold text-ink">@{workspace.connectionLogin}</span>.</>}
        aside={<form action="/auth/logout" method="post"><Button type="submit" variant="secondary">Keluar</Button></form>}
      />
      {logoutFailed ? <p role="alert" className="mb-6 rounded-control bg-warning-fill px-4 py-3 text-body-sm font-semibold text-warning">SAGE belum dapat mencabut sesi. Sesi masih aktif; coba keluar lagi.</p> : null}
      <Panel title="Akses repository GitHub">
        <p className="text-body-sm text-muted">
          Periksa repository public atau instalasi App yang dapat diakses oleh akunmu.
          Setelah target branch dan commit divalidasi, kamu dapat memulai analisis dan mengikuti progresnya.
        </p>
        <div className="mt-6 flex flex-wrap items-center justify-between gap-4 border-t border-border-soft pt-5">
          <p className="flex items-center gap-2 text-caption text-subtle"><Badge tone="success">Sesi aktif</Badge>Sesi berakhir {sessionExpiry} WIB.</p>
          <Button href="/workspace/repositories" arrow>Buka repository</Button>
        </div>
      </Panel>
    </div>
  </DesignFrame>;
}
