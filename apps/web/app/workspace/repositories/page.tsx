import Link from "next/link";
import { redirect } from "next/navigation";
import { readWorkspaceContext } from "../../../lib/auth/server-session.ts";
import { RepositoryAccessPanel } from "../../../components/repositories/access-panel.tsx";
import { DesignFrame } from "../../../components/design-system/ui.tsx";

export const metadata = { title: "Repository — SAGE", robots: { index: false, follow: false } };

export default async function RepositoriesPage() {
  let context;
  try { context = await readWorkspaceContext(); } catch { redirect("/login?error=unavailable"); }
  if (!context) redirect("/login?error=session");
  const slug = process.env.GITHUB_APP_SLUG;
  const installUrl = slug && /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/.test(slug)
    ? `https://github.com/apps/${slug}/installations/new` : null;
  return <DesignFrame active="repositories">
    <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
      <div><p className="mb-2 font-mono text-xs tracking-wide text-[#0b7a6c]">TARGET ANALISIS</p><h1 className="text-[28px] leading-9 font-semibold tracking-tight">Pilih repository</h1><p className="mt-2 text-sm leading-6 text-[#52637b]">Terhubung sebagai @{context.connectionLogin}. Izin selalu diperiksa kembali melalui GitHub.</p></div>
      <Link href="/workspace" className="inline-flex min-h-10 items-center rounded-md border border-[#b8c6d3] bg-white px-4 py-2 text-sm font-medium text-[#061e42]">Kembali ke workspace</Link>
    </div>
    <RepositoryAccessPanel key={context.accountKey} installUrl={installUrl} accountKey={context.accountKey} accountLogin={context.connectionLogin} />
  </DesignFrame>;
}
