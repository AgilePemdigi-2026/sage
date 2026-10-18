import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import type { PrismaClient } from "../packages/database/generated/client.ts";
import {
  decryptCredential,
  encryptCredential,
  readGitHubCredential,
  replaceGitHubCredential,
  revokeGitHubCredentialForUser,
  storeGitHubCredential,
} from "../packages/database/src/credentials.ts";
import {
  findAnalysisForUser,
  findArchitectureDocumentForUser,
  findExportForUser,
  findGitHubConnectionForUser,
  findGitHubInstallationForUser,
  findGraphBundleForUser,
  findJobForUser,
  findSourceFileForUser,
  findStorageObjectForUser,
} from "../packages/database/src/access.ts";
import { createSession, hashSessionToken, resolveSession, revokeSession } from "../packages/database/src/session.ts";

function withEncryptionKey<T>(run: () => T): T {
  const before = process.env.CREDENTIAL_ENCRYPTION_KEY;
  process.env.CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  try {
    return run();
  } finally {
    if (before === undefined) delete process.env.CREDENTIAL_ENCRYPTION_KEY;
    else process.env.CREDENTIAL_ENCRYPTION_KEY = before;
  }
}

test("credential envelope uses AES-GCM and binds user and credential context", () => {
  withEncryptionKey(() => {
    const token = "gho-user-token-do-not-store-in-plaintext";
    const envelope = encryptCredential(token, "user-a", "github-connection:conn-a");
    assert.notEqual(envelope.ciphertext, token);
    assert.equal(Buffer.from(envelope.nonce, "base64").length, 12);
    assert.equal(Buffer.from(envelope.authTag, "base64").length, 16);
    assert.match(envelope.keyId, /^[a-f0-9]{16}$/);
    assert.equal(decryptCredential(envelope, "user-a", "github-connection:conn-a"), token);
    assert.throws(() => decryptCredential(envelope, "user-b", "github-connection:conn-a"), /Kredensial tidak dapat dibuka/);
    assert.throws(() => decryptCredential(envelope, "user-a", "github-connection:conn-b"), /Kredensial tidak dapat dibuka/);

    const damaged = { ...envelope, ciphertext: `${envelope.ciphertext[0] === "A" ? "B" : "A"}${envelope.ciphertext.slice(1)}` };
    assert.throws(() => decryptCredential(damaged, "user-a", "github-connection:conn-a"), /Kredensial tidak dapat dibuka/);
  });
});

test("credential encryption fails closed for missing or malformed keys", () => {
  const before = process.env.CREDENTIAL_ENCRYPTION_KEY;
  try {
    delete process.env.CREDENTIAL_ENCRYPTION_KEY;
    assert.throws(() => encryptCredential("token", "user", "connection"), /CREDENTIAL_ENCRYPTION_KEY/);
    process.env.CREDENTIAL_ENCRYPTION_KEY = "not-base64";
    assert.throws(() => encryptCredential("token", "user", "connection"), /CREDENTIAL_ENCRYPTION_KEY/);
  } finally {
    if (before === undefined) delete process.env.CREDENTIAL_ENCRYPTION_KEY;
    else process.env.CREDENTIAL_ENCRYPTION_KEY = before;
  }
});

test("session creation stores only a hash and returns a 256-bit token once", async () => {
  const created: { data?: { userId: string; tokenHash: string; expiresAt: Date; createdAt: Date } } = {};
  const db = {
    session: {
      create: async ({ data }: { data: NonNullable<typeof created.data> }) => {
        created.data = data;
        return { id: "session-row", userId: data.userId, expiresAt: data.expiresAt };
      },
    },
  } as unknown as PrismaClient;
  const now = new Date("2026-10-18T00:00:00.000Z");
  const result = await createSession(db, "user-1", { now, ttlMs: 60_000 });
  assert.match(result.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(created.data?.userId, "user-1");
  assert.equal(created.data?.tokenHash, hashSessionToken(result.token));
  assert.notEqual(created.data?.tokenHash, result.token);
  assert.equal(result.session.expiresAt.toISOString(), "2026-10-18T00:01:00.000Z");
});

test("session lookup requires a valid token and asks the database for active, unexpired rows", async () => {
  let query: { tokenHash: string; revokedAt: null; expiresAt: { gt: Date } } | undefined;
  let called = 0;
  const db = {
    session: {
      findFirst: async ({ where }: { where: NonNullable<typeof query> }) => {
        called += 1;
        query = where;
        return null;
      },
    },
  } as unknown as PrismaClient;
  const now = new Date("2026-10-18T00:00:00.000Z");
  assert.equal(await resolveSession(db, "bad-token", now), null);
  assert.equal(called, 0);
  assert.equal(await resolveSession(db, "t".repeat(43), now), null);
  assert.equal(query?.tokenHash, hashSessionToken("t".repeat(43)));
  assert.equal(query?.revokedAt, null);
  assert.equal(query?.expiresAt.gt, now);
});

test("session revocation is a hash lookup and invalid tokens never reach the database", async () => {
  let query: { tokenHash: string; revokedAt: null } | undefined;
  let called = 0;
  const db = {
    session: {
      updateMany: async ({ where }: { where: NonNullable<typeof query> }) => {
        called += 1;
        query = where;
        return { count: 1 };
      },
    },
  } as unknown as PrismaClient;
  const token = "r".repeat(43);
  assert.equal(await revokeSession(db, "invalid"), false);
  assert.equal(called, 0);
  assert.equal(await revokeSession(db, token), true);
  assert.equal(query?.tokenHash, hashSessionToken(token));
  assert.equal(query?.revokedAt, null);
});

test("owner-scoped APIs reject missing owners and IDs before issuing database queries", async () => {
  let called = 0;
  const touched = async () => {
    called += 1;
    throw new Error("Database should not be reached.");
  };
  const db = {
    analysis: { findFirst: touched },
    job: { findFirst: touched },
    sourceFile: { findFirst: touched },
    graphBundle: { findFirst: touched },
    architectureDocument: { findFirst: touched },
    export: { findFirst: touched },
    storageObject: { findFirst: touched },
    gitHubConnection: { findFirst: touched, create: touched, updateMany: touched },
    gitHubInstallation: { findFirst: touched },
  } as unknown as PrismaClient;
  const methods = [
    (owner: string, id: string) => findAnalysisForUser(db, owner, id),
    (owner: string, id: string) => findJobForUser(db, owner, id),
    (owner: string, id: string) => findSourceFileForUser(db, owner, id),
    (owner: string, id: string) => findGraphBundleForUser(db, owner, id),
    (owner: string, id: string) => findArchitectureDocumentForUser(db, owner, id),
    (owner: string, id: string) => findExportForUser(db, owner, id),
    (owner: string, id: string) => findStorageObjectForUser(db, owner, id),
    (owner: string, id: string) => findGitHubConnectionForUser(db, owner, id),
    (owner: string, id: string) => findGitHubInstallationForUser(db, owner, id),
  ];
  for (const method of methods) {
    await assert.rejects(async () => method(undefined as unknown as string, "record-id"), /Pemilik/);
    await assert.rejects(async () => method("owner-id", ""), /ID data/);
  }
  assert.equal(called, 0);
});

test("session and credential writers fail closed for missing owners and invalid dates", async () => {
  let called = 0;
  const touched = async () => {
    called += 1;
    throw new Error("Database should not be reached.");
  };
  const db = {
    session: { create: touched },
    gitHubConnection: { create: touched, findFirst: touched, updateMany: touched },
  } as unknown as PrismaClient;
  await assert.rejects(createSession(db, undefined as unknown as string), /Pemilik session/);
  await assert.rejects(createSession(db, "owner-id", { now: new Date(Number.NaN) }), /Waktu session/);
  await assert.rejects(
    storeGitHubCredential(db, undefined as unknown as string, { githubUserId: "gh-1", githubLogin: "user", accessToken: "secret" }),
    /Pemilik kredensial/,
  );
  await assert.rejects(
    replaceGitHubCredential(db, undefined as unknown as string, "connection-id", {
      githubUserId: "gh-1",
      githubLogin: "user",
      accessToken: "secret",
    }),
    /Pemilik kredensial/,
  );
  await assert.rejects(readGitHubCredential(db, "", "connection-id"), /Pemilik kredensial/);
  await assert.rejects(readGitHubCredential(db, "owner-id", "connection-id", new Date(Number.NaN)), /Waktu kredensial/);
  await assert.rejects(revokeGitHubCredentialForUser(db, "owner-id", "connection-id", new Date(Number.NaN)), /Waktu pencabutan/);
  await assert.rejects(revokeGitHubCredentialForUser(db, undefined as unknown as string, "connection-id"), /Pemilik kredensial/);
  assert.equal(called, 0);
});

test("credential replacement is owner-scoped and re-encrypts against the stable connection ID", async () => {
  const before = process.env.CREDENTIAL_ENCRYPTION_KEY;
  process.env.CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  let where: { id: string; userId: string } | undefined;
  let data: Record<string, unknown> | undefined;
  let count = 1;
  const db = {
    gitHubConnection: {
      updateMany: async ({ where: query, data: update }: { where: NonNullable<typeof where>; data: Record<string, unknown> }) => {
        where = query;
        data = update;
        return { count };
      },
    },
  } as unknown as PrismaClient;
  try {
    const plaintext = "new-github-secret";
    assert.equal(await replaceGitHubCredential(db, "user-1", "connection-1", {
      githubUserId: "github-1",
      githubLogin: "login-1",
      accessToken: plaintext,
    }), true);
    assert.deepEqual(where, { id: "connection-1", userId: "user-1" });
    assert.equal(data?.status, "ACTIVE");
    assert.equal(data?.revokedAt, null);
    assert.equal(data?.tokenExpiresAt, null);
    assert.notEqual(data?.encryptedToken, plaintext);
    assert.equal(decryptCredential({
      ciphertext: String(data?.encryptedToken),
      nonce: String(data?.tokenNonce),
      authTag: String(data?.tokenAuthTag),
      keyId: String(data?.encryptionKeyId),
    }, "user-1", "github-connection:connection-1"), plaintext);

    count = 0;
    assert.equal(await replaceGitHubCredential(db, "foreign-user", "connection-1", {
      githubUserId: "github-1",
      githubLogin: "login-1",
      accessToken: "must-not-replace-owner",
    }), false);
    assert.deepEqual(where, { id: "connection-1", userId: "foreign-user" });
  } finally {
    if (before === undefined) delete process.env.CREDENTIAL_ENCRYPTION_KEY;
    else process.env.CREDENTIAL_ENCRYPTION_KEY = before;
  }
});
