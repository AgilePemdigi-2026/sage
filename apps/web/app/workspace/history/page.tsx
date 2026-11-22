import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { loginRedirectPath, readWorkspaceContextCached } from "../../../lib/auth/workspace-context.ts";
import { HistoryClient } from "../../../components/history/history-client.tsx";

export const metadata: Metadata = {
  title: "Riwayat — SAGE",
  robots: { index: false, follow: false },
};

export default async function HistoryPage() {
  const context = await readWorkspaceContextCached().catch(() => null);
  if (!context) redirect(await loginRedirectPath("history"));
  return <HistoryClient accountKey={context.accountKey} />;
}
