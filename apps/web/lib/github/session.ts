import { database, readGitHubCredential, resolveSession } from "@sage/database";
import { getUniqueCookie, isValidOpaqueToken, SESSION_COOKIE } from "../auth/handlers.ts";

/** Server-only context. Never pass this object to client components or JSON responses. */
export async function readRepositorySession(request: Request) {
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
  const connection = await db.gitHubConnection.findFirst({
    where: { userId: session.userId, githubUserId: user.githubUserId, status: "ACTIVE", revokedAt: null,
      OR: [{ tokenExpiresAt: null }, { tokenExpiresAt: { gt: now } }] },
    orderBy: { updatedAt: "desc" }, select: { id: true, githubLogin: true },
  });
  if (!connection) return null;
  const credential = await readGitHubCredential(db, session.userId, connection.id, now);
  if (!credential) return null;
  return {
    userId: session.userId,
    githubUserId: user.githubUserId,
    githubLogin: connection.githubLogin,
    connectionId: connection.id,
    accessToken: credential.accessToken,
  };
}
