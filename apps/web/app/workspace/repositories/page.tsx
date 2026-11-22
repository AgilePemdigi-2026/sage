import { redirect } from "next/navigation";
import { loginRedirectPath, readWorkspaceContextCached } from "../../../lib/auth/workspace-context.ts";
import { RepositoryAccessPanel } from "../../../components/repositories/access-panel.tsx";
import { DesignFrame } from "../../../components/design-system/ui.tsx";

export const metadata = { title: "Repository", robots: { index: false, follow: false } };

export default async function RepositoriesPage() {
  let context;
  try { context = await readWorkspaceContextCached(); } catch { redirect("/login?error=unavailable"); }
  if (!context) redirect(await loginRedirectPath("repository"));
  const slug = process.env.GITHUB_APP_SLUG;
  const installUrl = slug && /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/.test(slug)
    ? `https://github.com/apps/${slug}/installations/new` : null;
  return <DesignFrame active="repositories">
    <RepositoryAccessPanel key={context.accountKey} installUrl={installUrl} accountKey={context.accountKey} accountLogin={context.connectionLogin} />
  </DesignFrame>;
}
