import { database, resolveSession } from "@sage/database";
import { getUniqueCookie, isValidOpaqueToken, SESSION_COOKIE } from "../auth/handlers.ts";

/** Server-only context untuk endpoint analisis. Pemilik datang dari session cookie, tidak pernah dari field request. */
export async function readAnalysisSession(request: Request): Promise<{ userId: string; githubUserId: string } | null> {
  const token = getUniqueCookie(request.headers.get("cookie"), SESSION_COOKIE);
  if (!isValidOpaqueToken(token)) return null;
  const db = database();
  const now = new Date();
  const session = await resolveSession(db, token, now);
  if (!session) return null;
  const user = await db.user.findUnique({ where: { id: session.userId }, select: { githubUserId: true } });
  if (!user) return null;
  const expectedAccount = request.headers.get("x-sage-account");
  if (expectedAccount !== null && expectedAccount !== user.githubUserId) return null;
  return { userId: session.userId, githubUserId: user.githubUserId };
}
