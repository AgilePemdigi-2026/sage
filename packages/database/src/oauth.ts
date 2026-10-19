import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "../generated/client.ts";
import { decryptCredential, encryptCredential, replaceGitHubCredential, storeGitHubCredential } from "./credentials.ts";
import { createSession } from "./session.ts";

const LOCAL_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const MAX_EXPIRED_ATTEMPTS_PER_CREATE = 1000;
const BASE64URL_32_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const OAUTH_VERIFIER_USER = "sage-github-oauth-flow";
const OAUTH_VERIFIER_CONTEXT = "github-oauth-pkce-verifier:v1";

type OAuthTransaction = Prisma.TransactionClient;

type OAuthVerifierRow = {
  encryptedVerifier: string;
  verifierNonce: string;
  verifierAuthTag: string;
  encryptionKeyId: string;
};

type OAuthLoginInput = {
  githubUserId: string;
  login: string;
  displayName: string | null;
  accessToken: string;
  tokenExpiresAt: Date | null;
};

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isCanonical32ByteBase64Url(value: unknown): value is string {
  if (typeof value !== "string" || !BASE64URL_32_PATTERN.test(value)) return false;
  const decoded = Buffer.from(value, "base64url");
  return decoded.length === 32 && decoded.toString("base64url") === value;
}

function readPlainObject(input: unknown, fields: readonly string[], label: string): Record<string, unknown> {
  try {
    if (typeof input !== "object" || input === null || Array.isArray(input)) throw new Error();
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) throw new Error();
    const keys = Reflect.ownKeys(input);
    if (keys.length !== fields.length || keys.some((key) => typeof key !== "string" || !fields.includes(key))) throw new Error();
    const descriptors = Object.getOwnPropertyDescriptors(input);
    const snapshot: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const field of fields) {
      const descriptor = descriptors[field];
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) throw new Error();
      snapshot[field] = descriptor.value;
    }
    return snapshot;
  } catch {
    throw new Error(`${label} tidak valid.`);
  }
}

function snapshotOAuthTokens(input: unknown): { state: string; browserToken: string } | null {
  try {
    const snapshot = readPlainObject(input, ["state", "browserToken"], "OAuth attempt");
    if (!isCanonical32ByteBase64Url(snapshot.state) || !isCanonical32ByteBase64Url(snapshot.browserToken)) return null;
    return Object.freeze({ state: snapshot.state, browserToken: snapshot.browserToken });
  } catch {
    return null;
  }
}

function snapshotLoginInput(input: unknown): OAuthLoginInput {
  const snapshot = readPlainObject(
    input,
    ["githubUserId", "login", "displayName", "accessToken", "tokenExpiresAt"],
    "Data login GitHub",
  );
  const { githubUserId, login, displayName, accessToken, tokenExpiresAt } = snapshot;
  if (typeof githubUserId !== "string" || githubUserId.trim().length === 0) throw new Error("ID akun GitHub tidak valid.");
  if (typeof login !== "string" || login.trim().length === 0) throw new Error("Login GitHub tidak valid.");
  if (displayName !== null && typeof displayName !== "string") throw new Error("Nama akun GitHub tidak valid.");
  if (typeof accessToken !== "string" || accessToken.trim().length === 0) throw new Error("Token GitHub tidak valid.");
  let copiedExpiry: Date | null;
  if (tokenExpiresAt === null) {
    copiedExpiry = null;
  } else if (tokenExpiresAt instanceof Date) {
    const milliseconds = Date.prototype.getTime.call(tokenExpiresAt) as number;
    if (!Number.isFinite(milliseconds)) throw new Error("Masa berlaku token GitHub tidak valid.");
    copiedExpiry = new Date(milliseconds);
  } else {
    throw new Error("Masa berlaku token GitHub tidak valid.");
  }
  return Object.freeze({ githubUserId, login, displayName, accessToken, tokenExpiresAt: copiedExpiry });
}

function requireDatabaseDate(value: unknown): Date {
  if (!(value instanceof Date) || !Number.isFinite(Date.prototype.getTime.call(value) as number)) {
    throw new Error("Waktu database tidak valid.");
  }
  return new Date(Date.prototype.getTime.call(value) as number);
}

/** Creates a short-lived OAuth state and browser binding while storing only their hashes. */
export async function createGitHubOAuthAttempt(
  db: PrismaClient,
): Promise<{ state: string; browserToken: string; codeChallenge: string; expiresAt: Date }> {
  const state = randomBytes(32).toString("base64url");
  const browserToken = randomBytes(32).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  const codeChallenge = createHash("sha256").update(verifier, "utf8").digest("base64url");
  const envelope = encryptCredential(verifier, OAUTH_VERIFIER_USER, OAUTH_VERIFIER_CONTEXT);
  const id = randomUUID();

  try {
    const expiresAt = await db.$transaction(async (tx: OAuthTransaction) => {
      await tx.$executeRaw`
        WITH expired AS (
          SELECT "id"
          FROM "GitHubOAuthAttempt"
          WHERE "expiresAt" <= clock_timestamp()
          ORDER BY "expiresAt"
          LIMIT ${MAX_EXPIRED_ATTEMPTS_PER_CREATE}
          FOR UPDATE SKIP LOCKED
        )
        DELETE FROM "GitHubOAuthAttempt" AS attempt
        USING expired
        WHERE attempt."id" = expired."id"
      `;

      const inserted = await tx.$queryRaw<Array<{ expiresAt: Date }>>`
        INSERT INTO "GitHubOAuthAttempt" (
          "id", "stateHash", "browserTokenHash", "expiresAt", "encryptedVerifier",
          "verifierNonce", "verifierAuthTag", "encryptionKeyId"
        )
        VALUES (
          ${id}, ${sha256(state)}, ${sha256(browserToken)},
          clock_timestamp() + INTERVAL '10 minutes', ${envelope.ciphertext},
          ${envelope.nonce}, ${envelope.authTag}, ${envelope.keyId}
        )
        RETURNING "expiresAt"
      `;
      if (inserted.length !== 1) throw new Error("Insert result is invalid.");
      return requireDatabaseDate(inserted[0].expiresAt);
    });
    return { state, browserToken, codeChallenge, expiresAt };
  } catch {
    throw new Error("OAuth attempt tidak dapat dibuat.");
  }
}

/** Atomically consumes a matching, unexpired attempt; concurrent calls can receive the verifier only once. */
export async function consumeGitHubOAuthAttempt(
  db: PrismaClient,
  input: { state: string; browserToken: string },
): Promise<{ codeVerifier: string } | null> {
  const tokens = snapshotOAuthTokens(input);
  if (!tokens) return null;

  try {
    const rows = await db.$queryRaw<OAuthVerifierRow[]>`
      UPDATE "GitHubOAuthAttempt"
      SET "consumedAt" = clock_timestamp()
      WHERE "stateHash" = ${sha256(tokens.state)}
        AND "browserTokenHash" = ${sha256(tokens.browserToken)}
        AND "consumedAt" IS NULL
        AND "expiresAt" > clock_timestamp()
      RETURNING "encryptedVerifier", "verifierNonce", "verifierAuthTag", "encryptionKeyId"
    `;
    if (rows.length === 0) return null;
    if (rows.length !== 1) throw new Error("OAuth attempt row count is invalid.");
    const row = rows[0];
    const codeVerifier = decryptCredential(
      { ciphertext: row.encryptedVerifier, nonce: row.verifierNonce, authTag: row.verifierAuthTag, keyId: row.encryptionKeyId },
      OAUTH_VERIFIER_USER,
      OAUTH_VERIFIER_CONTEXT,
    );
    if (!isCanonical32ByteBase64Url(codeVerifier)) throw new Error("OAuth verifier is invalid.");
    return { codeVerifier };
  } catch {
    throw new Error("OAuth attempt tidak dapat digunakan.");
  }
}

/** Upserts the GitHub identity, refreshes its encrypted credential, and creates a fresh local session atomically. */
export async function completeGitHubLogin(
  db: PrismaClient,
  input: OAuthLoginInput,
): Promise<{ sessionToken: string; expiresAt: Date; user: { id: string; login: string; displayName: string | null } }> {
  const snapshot = snapshotLoginInput(input);

  try {
    return await db.$transaction(async (tx: OAuthTransaction) => {
      const clockRows = await tx.$queryRaw<Array<{ databaseNow: Date }>>`
        SELECT clock_timestamp() AS "databaseNow"
      `;
      if (clockRows.length !== 1) throw new Error("Database clock result is invalid.");
      const databaseNow = requireDatabaseDate(clockRows[0].databaseNow);
      if (snapshot.tokenExpiresAt && snapshot.tokenExpiresAt.getTime() <= databaseNow.getTime()) {
        throw new Error("Provider token is already expired.");
      }

      const user = await tx.user.upsert({
        where: { githubUserId: snapshot.githubUserId },
        create: {
          githubUserId: snapshot.githubUserId,
          login: snapshot.login,
          displayName: snapshot.displayName,
        },
        update: { login: snapshot.login, displayName: snapshot.displayName },
        select: { id: true, login: true, displayName: true },
      });

      const lockedUsers = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "User" WHERE "id" = ${user.id} FOR UPDATE
      `;
      if (lockedUsers.length !== 1 || lockedUsers[0].id !== user.id) throw new Error("GitHub user lock failed.");

      const existingConnection = await tx.gitHubConnection.findFirst({
        where: { userId: user.id, githubUserId: snapshot.githubUserId },
        select: { id: true },
      });
      const credentialInput = {
        githubUserId: snapshot.githubUserId,
        githubLogin: snapshot.login,
        accessToken: snapshot.accessToken,
        tokenExpiresAt: snapshot.tokenExpiresAt,
      };
      if (existingConnection) {
        const replaced = await replaceGitHubCredential(tx, user.id, existingConnection.id, credentialInput);
        if (!replaced) throw new Error("GitHub credential replacement failed.");
      } else {
        await storeGitHubCredential(tx, user.id, credentialInput);
      }

      const sessionTtlMs = snapshot.tokenExpiresAt
        ? Math.min(LOCAL_SESSION_TTL_MS, snapshot.tokenExpiresAt.getTime() - databaseNow.getTime())
        : LOCAL_SESSION_TTL_MS;
      if (!Number.isFinite(sessionTtlMs) || sessionTtlMs <= 0) throw new Error("Local session expiry is invalid.");
      const createdSession = await createSession(tx, user.id, { now: databaseNow, ttlMs: sessionTtlMs });

      return {
        sessionToken: createdSession.token,
        expiresAt: createdSession.session.expiresAt,
        user: { id: user.id, login: user.login, displayName: user.displayName },
      };
    });
  } catch {
    throw new Error("Login GitHub tidak dapat diselesaikan.");
  }
}
