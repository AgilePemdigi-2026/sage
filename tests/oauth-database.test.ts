import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import test from "node:test";
import type { PrismaClient } from "../packages/database/generated/client.ts";
import { decryptCredential, encryptCredential, hashSessionToken } from "../packages/database/src/index.ts";
import { completeGitHubLogin, consumeGitHubOAuthAttempt, createGitHubOAuthAttempt } from "../packages/database/src/oauth.ts";

const OAUTH_AAD_USER = "sage-github-oauth-flow";
const OAUTH_AAD_CONTEXT = "github-oauth-pkce-verifier:v1";

async function withEncryptionKey<T>(run: () => Promise<T>): Promise<T> {
  const before = process.env.CREDENTIAL_ENCRYPTION_KEY;
  process.env.CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  try {
    return await run();
  } finally {
    if (before === undefined) delete process.env.CREDENTIAL_ENCRYPTION_KEY;
    else process.env.CREDENTIAL_ENCRYPTION_KEY = before;
  }
}

function sqlText(strings: TemplateStringsArray): string {
  return strings.join("?");
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

test("OAuth attempt creation persists hashes and an encrypted PKCE verifier with database-clock expiry", async () => {
  await withEncryptionKey(async () => {
    const databaseNow = new Date("2026-10-19T00:00:00.000Z");
    let cleanupSql = "";
    let insertSql = "";
    let cleanupValues: unknown[] = [];
    let insertValues: unknown[] = [];
    const tx = {
      $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
        cleanupSql = sqlText(strings);
        cleanupValues = values;
        return 0;
      },
      $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
        insertSql = sqlText(strings);
        insertValues = values;
        return [{ expiresAt: new Date(databaseNow.getTime() + 10 * 60 * 1000) }];
      },
    };
    const db = { $transaction: async (run: (client: typeof tx) => unknown) => run(tx) } as unknown as PrismaClient;

    const attempt = await createGitHubOAuthAttempt(db);
    assert.match(attempt.state, /^[A-Za-z0-9_-]{43}$/);
    assert.match(attempt.browserToken, /^[A-Za-z0-9_-]{43}$/);
    assert.match(attempt.codeChallenge, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(attempt.expiresAt.toISOString(), "2026-10-19T00:10:00.000Z");
    assert.match(cleanupSql, /"expiresAt" <= clock_timestamp\(\)/);
    assert.match(cleanupSql, /LIMIT \?/);
    assert.deepEqual(cleanupValues, [1000]);
    assert.match(insertSql, /clock_timestamp\(\) \+ INTERVAL '10 minutes'/);
    assert.deepEqual(insertValues.slice(1, 3), [sha256(attempt.state), sha256(attempt.browserToken)]);
    assert.notEqual(insertValues[1], attempt.state);
    assert.notEqual(insertValues[2], attempt.browserToken);

    const verifier = decryptCredential({
      ciphertext: String(insertValues[3]),
      nonce: String(insertValues[4]),
      authTag: String(insertValues[5]),
      keyId: String(insertValues[6]),
    }, OAUTH_AAD_USER, OAUTH_AAD_CONTEXT);
    assert.match(verifier, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(attempt.codeChallenge, createHash("sha256").update(verifier, "utf8").digest("base64url"));
    assert.notEqual(insertValues[3], verifier);
  });
});

test("OAuth consume guards malformed tokens, snapshots inputs, and atomically claims the verifier", async () => {
  await withEncryptionKey(async () => {
    let queryCalls = 0;
    let query = "";
    let values: unknown[] = [];
    let releaseQuery!: () => void;
    const queryGate = new Promise<void>((resolve) => { releaseQuery = resolve; });
    const verifier = randomBytes(32).toString("base64url");
    const envelope = encryptCredential(verifier, OAUTH_AAD_USER, OAUTH_AAD_CONTEXT);
    const db = {
      $queryRaw: async (strings: TemplateStringsArray, ...parameters: unknown[]) => {
        queryCalls += 1;
        query = sqlText(strings);
        values = parameters;
        await queryGate;
        return [{
          encryptedVerifier: envelope.ciphertext,
          verifierNonce: envelope.nonce,
          verifierAuthTag: envelope.authTag,
          encryptionKeyId: envelope.keyId,
        }];
      },
    } as unknown as PrismaClient;

    assert.equal(await consumeGitHubOAuthAttempt(db, { state: "bad", browserToken: "bad" }), null);
    assert.equal(queryCalls, 0);

    const state = randomBytes(32).toString("base64url");
    const browserToken = randomBytes(32).toString("base64url");
    const input = { state, browserToken };
    const pending = consumeGitHubOAuthAttempt(db, input);
    input.state = randomBytes(32).toString("base64url");
    input.browserToken = randomBytes(32).toString("base64url");
    releaseQuery();
    assert.deepEqual(await pending, { codeVerifier: verifier });
    assert.equal(queryCalls, 1);
    assert.match(query, /UPDATE "GitHubOAuthAttempt"/);
    assert.match(query, /"consumedAt" IS NULL/);
    assert.match(query, /"expiresAt" > clock_timestamp\(\)/);
    assert.match(query, /RETURNING "encryptedVerifier"/);
    assert.deepEqual(values, [sha256(state), sha256(browserToken)]);
    assert.notEqual(values[0], state);
    assert.notEqual(values[1], browserToken);
  });
});

test("GitHub login reuses the owner-bound connection and caps the fresh session at eight hours", async () => {
  await withEncryptionKey(async () => {
    const databaseNow = new Date("2026-10-19T00:00:00.000Z");
    const oldExpiry = new Date(databaseNow.getTime() + 12 * 60 * 60 * 1000);
    const input = {
      githubUserId: "github-user-1",
      login: "updated-login",
      displayName: "Updated Name",
      accessToken: "provider-secret-must-not-return",
      tokenExpiresAt: oldExpiry,
    };
    const updateData: Record<string, unknown>[] = [];
    const sessionData: Record<string, unknown>[] = [];
    let queryCount = 0;
    const tx = {
      $queryRaw: async (strings: TemplateStringsArray) => {
        queryCount += 1;
        if (sqlText(strings).includes("clock_timestamp")) return [{ databaseNow }];
        return [{ id: "existing-user" }];
      },
      user: {
        upsert: async ({ where, create, update }: { where: { githubUserId: string }; create: Record<string, unknown>; update: Record<string, unknown> }) => {
          assert.deepEqual(where, { githubUserId: "github-user-1" });
          assert.equal(create.login, "updated-login");
          assert.equal(update.displayName, "Updated Name");
          return { id: "existing-user", login: "updated-login", displayName: "Updated Name" };
        },
      },
      gitHubConnection: {
        findFirst: async () => ({ id: "stable-connection" }),
        updateMany: async ({ where, data }: { where: { id: string; userId: string }; data: Record<string, unknown> }) => {
          assert.deepEqual(where, { id: "stable-connection", userId: "existing-user" });
          updateData.push(data);
          return { count: 1 };
        },
      },
      session: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          sessionData.push(data);
          return { id: "session-1", userId: data.userId, expiresAt: data.expiresAt };
        },
      },
    };
    const db = { $transaction: async (run: (client: typeof tx) => unknown) => run(tx) } as unknown as PrismaClient;

    const result = await completeGitHubLogin(db, input);
    assert.deepEqual(result.user, { id: "existing-user", login: "updated-login", displayName: "Updated Name" });
    assert.equal(result.expiresAt.toISOString(), "2026-10-19T08:00:00.000Z");
    assert.equal(queryCount, 2);
    assert.equal(updateData.length, 1);
    assert.equal(updateData[0].status, "ACTIVE");
    assert.equal(updateData[0].revokedAt, null);
    assert.notEqual(updateData[0].encryptedToken, input.accessToken);
    assert.equal(decryptCredential({
      ciphertext: String(updateData[0].encryptedToken),
      nonce: String(updateData[0].tokenNonce),
      authTag: String(updateData[0].tokenAuthTag),
      keyId: String(updateData[0].encryptionKeyId),
    }, "existing-user", "github-connection:stable-connection"), input.accessToken);
    assert.equal(sessionData.length, 1);
    assert.equal(sessionData[0].userId, "existing-user");
    assert.equal((sessionData[0].expiresAt as Date).toISOString(), "2026-10-19T08:00:00.000Z");
    assert.equal(sessionData[0].tokenHash, hashSessionToken(result.sessionToken));
    assert.notEqual(sessionData[0].tokenHash, result.sessionToken);
    assert.equal(JSON.stringify(result).includes(input.accessToken), false);
  });
});

test("GitHub login rejects an already expired provider credential before mutating the user", async () => {
  await withEncryptionKey(async () => {
    let upsertCalls = 0;
    const databaseNow = new Date("2026-10-19T00:00:00.000Z");
    const tx = {
      $queryRaw: async () => [{ databaseNow }],
      user: { upsert: async () => { upsertCalls += 1; throw new Error("Unexpected upsert"); } },
    };
    const db = { $transaction: async (run: (client: typeof tx) => unknown) => run(tx) } as unknown as PrismaClient;
    await assert.rejects(completeGitHubLogin(db, {
      githubUserId: "expired-user",
      login: "expired",
      displayName: null,
      accessToken: "expired-token",
      tokenExpiresAt: new Date(databaseNow.getTime() - 1),
    }), /Login GitHub tidak dapat diselesaikan/);
    assert.equal(upsertCalls, 0);
  });
});
