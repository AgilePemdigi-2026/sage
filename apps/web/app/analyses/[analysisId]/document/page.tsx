import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { database, resolveSession } from "@sage/database";
import { getUniqueCookie, isValidOpaqueToken, SESSION_COOKIE } from "../../../../lib/auth/handlers.ts";
import { DesignFrame } from "../../../../components/design-system/ui.tsx";
import { LiveDocumentClient } from "../../../../components/live-document/live-document-client.tsx";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Architecture Definition Document — SAGE",
  robots: { index: false, follow: false },
};

const ANALYSIS_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

/** The page sends only the SSR session identity; document data is fetched after client identity validation. */
export default async function AnalysisDocumentPage({ params }: { params: Promise<{ analysisId: string }> }) {
  const analysisId = (await params).analysisId;
  if (!ANALYSIS_ID_PATTERN.test(analysisId)) notFound();

  const requestHeaders = await headers();
  const token = getUniqueCookie(requestHeaders.get("cookie"), SESSION_COOKIE);
  if (!token || !isValidOpaqueToken(token)) redirect("/login?error=session");
  const db = database();
  const session = await resolveSession(db, token, new Date());
  if (!session) redirect("/login?error=session");
  const user = await db.user.findUnique({ where: { id: session.userId }, select: { githubUserId: true } });
  if (!user) redirect("/login?error=session");

  return <DesignFrame active="history">
    <LiveDocumentClient analysisId={analysisId} accountKey={user.githubUserId} />
  </DesignFrame>;
}
