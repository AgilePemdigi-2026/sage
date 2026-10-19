import Link from "next/link";
import { redirect } from "next/navigation";
import { readWorkspaceContext } from "../../../lib/auth/server-session.ts";
import { RepositoryAccessPanel } from "../../../components/repositories/access-panel.tsx";

export const metadata = { title: "Repository — SAGE", robots: { index: false, follow: false } };

export default async function RepositoriesPage() {
  let context;
  try { context = await readWorkspaceContext(); } catch { redirect("/login?error=unavailable"); }
  if (!context) redirect("/login?error=session");
  const slug = process.env.GITHUB_APP_SLUG;
  const installUrl = slug && /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/.test(slug)
    ? `https://github.com/apps/${slug}/installations/new` : null;
  return <main className="mx-auto min-h-screen max-w-5xl px-5 py-8 sm:px-8">
    <Link href="/workspace" className="text-sm underline">Kembali ke workspace</Link>
    <h1 className="mt-6 text-3xl font-semibold">Pilih repository</h1>
    <p className="mt-3 text-sm text-ink/70">Terhubung sebagai @{context.connectionLogin}. Izin selalu diperiksa kembali melalui GitHub.</p>
    <RepositoryAccessPanel installUrl={installUrl} />
  </main>;
}
