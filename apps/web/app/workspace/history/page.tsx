import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { readWorkspaceContext } from "../../../lib/auth/server-session.ts";
import { HistoryClient } from "../../../components/history/history-client.tsx";

export const metadata: Metadata = {
  title: "Riwayat — SAGE",
  robots: { index: false, follow: false },
};

export default async function HistoryPage() {
  const context = await readWorkspaceContext().catch(() => null);
  if (!context) redirect("/login?error=session");
  return <HistoryClient accountKey={context.accountKey} />;
}
