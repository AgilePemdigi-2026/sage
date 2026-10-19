import { createHash, createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import type { GitHubConnectionStatus, PrismaClient } from "../generated/client.ts";

const KEY_ENV = "CREDENTIAL_ENCRYPTION_KEY";
const KEY_ID_LENGTH = 16;
const CREDENTIAL_CONTEXT_PREFIX = "github-connection:";
type CredentialDatabase = Pick<PrismaClient, "gitHubConnection">;

export type EncryptedCredential = {
  ciphertext: string;
  nonce: string;
  authTag: string;
  keyId: string;
};

function readEncryptionKey(): Buffer {
  const encoded = process.env[KEY_ENV];
  if (!encoded || !/^[A-Za-z0-9+/]{43}=$/.test(encoded)) {
    throw new Error(`${KEY_ENV} wajib berupa base64 kanonis untuk tepat 32 byte.`);
  }
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32 || key.toString("base64") !== encoded) {
    throw new Error(`${KEY_ENV} wajib berupa base64 kanonis untuk tepat 32 byte.`);
  }
  return key;
}

function keyIdFor(key: Buffer): string {
  return createHash("sha256").update(key).digest("hex").slice(0, KEY_ID_LENGTH);
}

function associatedData(userId: string, context: string, keyId: string): Buffer {
  if (typeof userId !== "string" || userId.trim().length === 0 || typeof context !== "string" || context.length === 0) {
    throw new Error("Konteks kredensial tidak valid.");
  }
  return Buffer.from(JSON.stringify(["sage-credential-v1", userId, context, keyId]), "utf8");
}

function requireOwnerAndId(userId: unknown, id: unknown): void {
  if (typeof userId !== "string" || userId.trim().length === 0) throw new Error("Pemilik kredensial tidak valid.");
  if (typeof id !== "string" || id.trim().length === 0) throw new Error("ID kredensial tidak valid.");
}

function requireValidDate(value: Date, label: string): void {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error(`${label} tidak valid.`);
}

function decodeCanonicalBase64(value: string): Buffer {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error("Invalid encoding");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) throw new Error("Invalid encoding");
  return decoded;
}

export function encryptCredential(plaintext: string, userId: string, context: string): EncryptedCredential {
  if (typeof plaintext !== "string" || plaintext.length === 0) throw new Error("Kredensial atau konteks tidak valid.");
  const key = readEncryptionKey();
  const keyId = keyIdFor(key);
  const nonce = randomBytes(12);
  try {
    const aad = associatedData(userId, context, keyId);
    const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return {
      ciphertext: ciphertext.toString("base64"),
      nonce: nonce.toString("base64"),
      authTag: authTag.toString("base64"),
      keyId,
    };
  } catch {
    throw new Error("Kredensial tidak dapat dienkripsi.");
  }
}

export function decryptCredential(envelope: EncryptedCredential, userId: string, context: string): string {
  const key = readEncryptionKey();
  const keyId = keyIdFor(key);
  try {
    if (!envelope || typeof envelope !== "object" || envelope.keyId !== keyId) throw new Error("Invalid envelope");
    const aad = associatedData(userId, context, keyId);
    const nonce = decodeCanonicalBase64(envelope.nonce);
    const authTag = decodeCanonicalBase64(envelope.authTag);
    const ciphertext = decodeCanonicalBase64(envelope.ciphertext);
    if (nonce.length !== 12 || authTag.length !== 16) throw new Error("Invalid envelope");
    const decipher = createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
    decipher.setAAD(aad);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("Kredensial tidak dapat dibuka.");
  }
}

export async function storeGitHubCredential(
  db: CredentialDatabase,
  userId: string,
  input: { githubUserId: string; githubLogin: string; accessToken: string; tokenExpiresAt?: Date | null },
): Promise<{ id: string; userId: string; githubUserId: string; githubLogin: string; status: GitHubConnectionStatus }> {
  requireOwnerAndId(userId, input?.githubUserId);
  if (!input || typeof input !== "object") throw new Error("Data koneksi GitHub tidak valid.");
  if (typeof input.githubLogin !== "string" || input.githubLogin.trim().length === 0) throw new Error("Login GitHub tidak valid.");
  if (input.tokenExpiresAt !== undefined && input.tokenExpiresAt !== null) requireValidDate(input.tokenExpiresAt, "Masa berlaku kredensial");
  const id = randomUUID();
  const envelope = encryptCredential(input.accessToken, userId, `${CREDENTIAL_CONTEXT_PREFIX}${id}`);
  return db.gitHubConnection.create({
    data: {
      id,
      userId,
      githubUserId: input.githubUserId,
      githubLogin: input.githubLogin,
      encryptedToken: envelope.ciphertext,
      tokenNonce: envelope.nonce,
      tokenAuthTag: envelope.authTag,
      encryptionKeyId: envelope.keyId,
      tokenExpiresAt: input.tokenExpiresAt,
    },
    select: { id: true, userId: true, githubUserId: true, githubLogin: true, status: true },
  });
}

/** Re-encrypts an existing connection during OAuth refresh/reconnect without changing its owner-bound ID. */
export async function replaceGitHubCredential(
  db: CredentialDatabase,
  userId: string,
  connectionId: string,
  input: { githubUserId: string; githubLogin: string; accessToken: string; tokenExpiresAt?: Date | null },
): Promise<boolean> {
  requireOwnerAndId(userId, connectionId);
  requireOwnerAndId(userId, input?.githubUserId);
  if (!input || typeof input !== "object") throw new Error("Data koneksi GitHub tidak valid.");
  if (typeof input.githubLogin !== "string" || input.githubLogin.trim().length === 0) throw new Error("Login GitHub tidak valid.");
  if (input.tokenExpiresAt !== undefined && input.tokenExpiresAt !== null) requireValidDate(input.tokenExpiresAt, "Masa berlaku kredensial");

  const envelope = encryptCredential(input.accessToken, userId, `${CREDENTIAL_CONTEXT_PREFIX}${connectionId}`);
  const result = await db.gitHubConnection.updateMany({
    where: { id: connectionId, userId },
    data: {
      githubUserId: input.githubUserId,
      githubLogin: input.githubLogin,
      encryptedToken: envelope.ciphertext,
      tokenNonce: envelope.nonce,
      tokenAuthTag: envelope.authTag,
      encryptionKeyId: envelope.keyId,
      tokenExpiresAt: input.tokenExpiresAt ?? null,
      revokedAt: null,
      status: "ACTIVE",
    },
  });
  return result.count === 1;
}

export async function readGitHubCredential(
  db: CredentialDatabase,
  userId: string,
  connectionId: string,
  now = new Date(),
): Promise<{ connection: { id: string; userId: string; githubUserId: string; githubLogin: string }; accessToken: string } | null> {
  requireOwnerAndId(userId, connectionId);
  requireValidDate(now, "Waktu kredensial");
  const row = await db.gitHubConnection.findFirst({
    where: { id: connectionId, userId },
    select: {
      id: true,
      userId: true,
      githubUserId: true,
      githubLogin: true,
      encryptedToken: true,
      tokenNonce: true,
      tokenAuthTag: true,
      encryptionKeyId: true,
      tokenExpiresAt: true,
      revokedAt: true,
      status: true,
    },
  });
  if (!row || row.status !== "ACTIVE" || row.revokedAt || (row.tokenExpiresAt && row.tokenExpiresAt <= now)) return null;

  const accessToken = decryptCredential(
    { ciphertext: row.encryptedToken, nonce: row.tokenNonce, authTag: row.tokenAuthTag, keyId: row.encryptionKeyId },
    userId,
    `${CREDENTIAL_CONTEXT_PREFIX}${row.id}`,
  );
  return {
    connection: { id: row.id, userId: row.userId, githubUserId: row.githubUserId, githubLogin: row.githubLogin },
    accessToken,
  };
}

export async function revokeGitHubCredentialForUser(
  db: CredentialDatabase,
  userId: string,
  connectionId: string,
  now = new Date(),
): Promise<boolean> {
  requireOwnerAndId(userId, connectionId);
  requireValidDate(now, "Waktu pencabutan kredensial");
  const result = await db.gitHubConnection.updateMany({
    where: { id: connectionId, userId, status: "ACTIVE", revokedAt: null },
    data: { status: "REVOKED", revokedAt: now },
  });
  return result.count === 1;
}
