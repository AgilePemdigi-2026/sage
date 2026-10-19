import { headers } from "next/headers";
import { database, resolveSession } from "@sage/database";
import { getUniqueCookie, isValidOpaqueToken, SESSION_COOKIE } from "./handlers.ts";

export type WorkspaceContext = {
  readonly login: string;
  readonly displayName: string | null;
  readonly connectionLogin: string;
  readonly connectionExpiresAt: Date | null;
  readonly sessionExpiresAt: Date;
};

export async function readWorkspaceContext(): Promise<WorkspaceContext | null> {
  const requestHeaders = await headers();
  const token = getUniqueCookie(requestHeaders.get("cookie"), SESSION_COOKIE);
  if (!isValidOpaqueToken(token)) return null;

  const now = new Date();
  const db = database();
  const session = await resolveSession(db, token, now);
  if (!session) return null;

  const user = await db.user.findUnique({
    where: { id: session.userId },
    select: { login: true, displayName: true },
  });
  if (!user) return null;

  const connection = await db.gitHubConnection.findFirst({
    where: {
      userId: session.userId,
      status: "ACTIVE",
      revokedAt: null,
      OR: [{ tokenExpiresAt: null }, { tokenExpiresAt: { gt: now } }],
    },
    orderBy: { updatedAt: "desc" },
    select: { githubLogin: true, tokenExpiresAt: true },
  });
  if (!connection) return null;

  return {
    login: user.login,
    displayName: user.displayName,
    connectionLogin: connection.githubLogin,
    connectionExpiresAt: connection.tokenExpiresAt,
    sessionExpiresAt: session.expiresAt,
  };
}
