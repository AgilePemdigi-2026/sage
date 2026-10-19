import { createHash, randomBytes } from "node:crypto";
import type { PrismaClient } from "../generated/client.ts";

type SessionDatabase = Pick<PrismaClient, "session">;

const DEFAULT_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function requireUserId(userId: string): void {
  if (typeof userId !== "string" || userId.trim().length === 0) throw new Error("Pemilik session tidak valid.");
}

function requireValidDate(value: Date, label: string): void {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error(`${label} tidak valid.`);
}

export type ResolvedSession = {
  readonly sessionId: string;
  readonly userId: string;
  readonly expiresAt: Date;
};

export function hashSessionToken(token: string): string {
  if (typeof token !== "string" || token.length === 0) throw new Error("Token session tidak valid.");
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export async function createSession(
  db: SessionDatabase,
  userId: string,
  options: { now?: Date; ttlMs?: number } = {},
): Promise<{ token: string; session: ResolvedSession }> {
  requireUserId(userId);
  const now = options.now ?? new Date();
  requireValidDate(now, "Waktu session");
  const ttlMs = options.ttlMs ?? DEFAULT_SESSION_TTL_MS;
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error("Durasi session tidak valid.");

  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(now.getTime() + ttlMs);
  requireValidDate(expiresAt, "Masa berlaku session");
  const stored = await db.session.create({
    data: { userId, tokenHash: hashSessionToken(token), expiresAt, createdAt: now },
    select: { id: true, userId: true, expiresAt: true },
  });

  return { token, session: { sessionId: stored.id, userId: stored.userId, expiresAt: stored.expiresAt } };
}

/** Resolves only active, unexpired sessions; callers must use the returned userId as the owner scope. */
export async function resolveSession(db: SessionDatabase, token: string, now = new Date()): Promise<ResolvedSession | null> {
  requireValidDate(now, "Waktu session");
  if (typeof token !== "string") return null;
  if (!SESSION_TOKEN_PATTERN.test(token)) return null;
  const session = await db.session.findFirst({
    where: { tokenHash: hashSessionToken(token), revokedAt: null, expiresAt: { gt: now } },
    select: { id: true, userId: true, expiresAt: true },
  });
  if (!session) return null;
  return { sessionId: session.id, userId: session.userId, expiresAt: session.expiresAt };
}

export async function revokeSession(db: SessionDatabase, token: string, now = new Date()): Promise<boolean> {
  requireValidDate(now, "Waktu session");
  if (typeof token !== "string") return false;
  if (!SESSION_TOKEN_PATTERN.test(token)) return false;
  const result = await db.session.updateMany({
    where: { tokenHash: hashSessionToken(token), revokedAt: null },
    data: { revokedAt: now },
  });
  return result.count === 1;
}
