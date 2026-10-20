import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { database, getAnalysisDetailForUser, resolveSession } from "@sage/database";
import { presentAnalysisDetail } from "../../../lib/analyses/presenters.ts";
import { getUniqueCookie, isValidOpaqueToken, SESSION_COOKIE } from "../../../lib/auth/handlers.ts";
import { AnalysisDetailClient } from "../../../components/history/detail-client.tsx";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Progres analisis — SAGE",
  robots: { index: false, follow: false },
};

const ANALYSIS_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

export default async function AnalysisDetailPage({ params }: { params: Promise<{ analysisId: string }> }) {
  const raw = (await params).analysisId;
  if (!ANALYSIS_ID_PATTERN.test(raw)) {
    return <AnalysisDetailClient analysisId="" accountKey="" initial={null} reason="not-found" />;
  }
  const requestHeaders = await headers();
  const token = getUniqueCookie(requestHeaders.get("cookie"), SESSION_COOKIE);
  if (!token || !isValidOpaqueToken(token)) redirect("/login?error=session");
  const db = database();
  const session = await resolveSession(db, token, new Date());
  if (!session) redirect("/login?error=session");
  const user = await db.user.findUnique({ where: { id: session.userId }, select: { githubUserId: true } });
  if (!user) redirect("/login?error=session");
  const detail = await getAnalysisDetailForUser(db, session.userId, raw);
  return <AnalysisDetailClient
    analysisId={raw}
    accountKey={user.githubUserId}
    initial={detail ? presentAnalysisDetail(detail) as never : null}
    reason={detail ? null : "not-found"}
  />;
}
