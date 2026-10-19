import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import {
  completeGitHubLogin,
  consumeGitHubOAuthAttempt,
  createGitHubOAuthAttempt,
  database,
  disconnectDatabase,
  readGitHubCredential,
} from "../packages/database/src/index.ts";
import type { Prisma } from "../packages/database/generated/client.ts";

const OAUTH_TEST_DATABASE = "sage_oauth05";

function assertIsolatedOAuthTestDatabase(): void {
  if (process.env.SAGE_OAUTH_TESTS !== "1") throw new Error("Set SAGE_OAUTH_TESTS=1 to run isolated OAuth database integration tests.");
  const rawUrl = process.env.DATABASE_URL;
  if (!rawUrl) throw new Error("DATABASE_URL is required for OAuth database integration tests.");
  let databaseName: string;
  try {
    databaseName = decodeURIComponent(new URL(rawUrl).pathname.slice(1));
  } catch {
    throw new Error("DATABASE_URL is invalid; it was not logged.");
  }
  if (databaseName !== OAUTH_TEST_DATABASE) throw new Error(`OAuth database integration tests only allow ${OAUTH_TEST_DATABASE}.`);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function postgresStringLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

test("GH-01 PostgreSQL attempts, replay fencing, rollback, and serialized reconnect", {
  skip: process.env.SAGE_OAUTH_TESTS !== "1",
}, async () => {
  assertIsolatedOAuthTestDatabase();
  const db = database();
  const suffix = randomUUID();
  const githubUserId = `oauth05-${suffix}`;
  const expiredGithubUserId = `${githubUserId}-expired`;
  const rollbackGithubUserId = `${githubUserId}-rollback`;
  const rollbackLogin = `oauth-rollback-${suffix}`;
  const rollbackFunctionName = "GH01RollbackSessionInsert";
  const rollbackTriggerName = "GH01RollbackSessionInsert";
  const fixtureGithubUserIds = [githubUserId, expiredGithubUserId, rollbackGithubUserId];
  const attemptHashes: string[] = [];
  let userId: string | undefined;

  try {
    const attempt = await createGitHubOAuthAttempt(db);
    attemptHashes.push(sha256(attempt.state));
    const storedAttempt = await db.$queryRaw<Array<{
      stateHash: string;
      browserTokenHash: string;
      expiresAt: Date;
      consumedAt: Date | null;
      encryptedVerifier: string;
    }>>`
      SELECT "stateHash", "browserTokenHash", "expiresAt", "consumedAt", "encryptedVerifier"
      FROM "GitHubOAuthAttempt" WHERE "stateHash" = ${sha256(attempt.state)}
    `;
    assert.equal(storedAttempt.length, 1);
    assert.equal(storedAttempt[0].stateHash, sha256(attempt.state));
    assert.equal(storedAttempt[0].browserTokenHash, sha256(attempt.browserToken));
    assert.ok(storedAttempt[0].expiresAt.getTime() > Date.now());
    assert.equal(storedAttempt[0].consumedAt, null);
    assert.equal(JSON.stringify(storedAttempt[0]).includes(attempt.state), false);
    assert.equal(JSON.stringify(storedAttempt[0]).includes(attempt.browserToken), false);

    assert.equal(await consumeGitHubOAuthAttempt(db, {
      state: attempt.state,
      browserToken: createHash("sha256").update("wrong-browser", "utf8").digest("base64url"),
    }), null);
    const claims = await Promise.all(Array.from({ length: 8 }, () => consumeGitHubOAuthAttempt(db, {
      state: attempt.state,
      browserToken: attempt.browserToken,
    })));
    const successfulClaims = claims.filter((claim): claim is { codeVerifier: string } => claim !== null);
    assert.equal(successfulClaims.length, 1);
    assert.equal(createHash("sha256").update(successfulClaims[0].codeVerifier, "utf8").digest("base64url"), attempt.codeChallenge);
    assert.equal(await consumeGitHubOAuthAttempt(db, { state: attempt.state, browserToken: attempt.browserToken }), null);

    const expiredAttempt = await createGitHubOAuthAttempt(db);
    attemptHashes.push(sha256(expiredAttempt.state));
    await db.$executeRaw`
      UPDATE "GitHubOAuthAttempt" SET "expiresAt" = clock_timestamp() - INTERVAL '1 second'
      WHERE "stateHash" = ${sha256(expiredAttempt.state)}
    `;
    assert.equal(await consumeGitHubOAuthAttempt(db, {
      state: expiredAttempt.state,
      browserToken: expiredAttempt.browserToken,
    }), null);

    await assert.rejects(completeGitHubLogin(db, {
      githubUserId: expiredGithubUserId,
      login: `expired-${suffix}`,
      displayName: null,
      accessToken: `expired-provider-secret-${suffix}`,
      tokenExpiresAt: new Date(Date.now() - 1000),
    }), /Login GitHub tidak dapat diselesaikan/);
    assert.equal(await db.user.count({ where: { githubUserId: expiredGithubUserId } }), 0);
    assert.equal(await db.session.count({ where: { user: { githubUserId: expiredGithubUserId } } }), 0);

    // The trigger fails only after the matching fixture User and GitHubConnection exist.
    // Its exact identity predicate keeps unrelated test rows and application users out of scope.
    await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${rollbackTriggerName}" ON "Session"`);
    await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${rollbackFunctionName}"()`);
    const rollbackIdentity = postgresStringLiteral(rollbackGithubUserId);
    const rollbackIdentityLogin = postgresStringLiteral(rollbackLogin);
    await db.$executeRawUnsafe(`
      CREATE FUNCTION "${rollbackFunctionName}"() RETURNS trigger
      LANGUAGE plpgsql AS $gh01$
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM "User" AS fixture_user
          JOIN "GitHubConnection" AS fixture_connection
            ON fixture_connection."userId" = fixture_user."id"
          WHERE fixture_user."id" = NEW."userId"
            AND fixture_user."githubUserId" = ${rollbackIdentity}
            AND fixture_user."login" = ${rollbackIdentityLogin}
            AND fixture_connection."githubUserId" = ${rollbackIdentity}
            AND fixture_connection."status" = 'ACTIVE'
        ) THEN
          RAISE EXCEPTION 'GH-01 fixture rollback';
        END IF;
        RETURN NEW;
      END;
      $gh01$
    `);
    await db.$executeRawUnsafe(`
      CREATE TRIGGER "${rollbackTriggerName}"
      BEFORE INSERT ON "Session"
      FOR EACH ROW EXECUTE FUNCTION "${rollbackFunctionName}"()
    `);

    await assert.rejects(completeGitHubLogin(db, {
      githubUserId: rollbackGithubUserId,
      login: rollbackLogin,
      displayName: "Rollback fixture",
      accessToken: `rollback-provider-secret-${suffix}`,
      tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
    }), /Login GitHub tidak dapat diselesaikan/);
    assert.equal(await db.user.count({ where: { githubUserId: rollbackGithubUserId } }), 0);
    assert.equal(await db.gitHubConnection.count({ where: { githubUserId: rollbackGithubUserId } }), 0);
    assert.equal(await db.session.count({ where: { user: { githubUserId: rollbackGithubUserId } } }), 0);

    const concurrentLogins = await Promise.all(["first", "second", "third"].map((label) => completeGitHubLogin(db, {
      githubUserId,
      login: `oauth-${label}-${suffix}`,
      displayName: `OAuth ${label}`,
      accessToken: `provider-secret-${label}-${suffix}`,
      tokenExpiresAt: new Date(Date.now() + 4 * 60 * 60 * 1000),
    })));
    userId = concurrentLogins[0].user.id;
    assert.ok(concurrentLogins.every((login) => login.user.id === userId));
    assert.ok(concurrentLogins.every((login) => login.expiresAt.getTime() - Date.now() < 4 * 60 * 60 * 1000));

    const connections = await db.gitHubConnection.findMany({
      where: { userId, githubUserId },
      select: { id: true, userId: true, encryptedToken: true, tokenNonce: true, tokenAuthTag: true, encryptionKeyId: true },
    });
    assert.equal(connections.length, 1);
    assert.equal(connections[0].userId, userId);
    assert.equal(JSON.stringify(connections[0]).includes(`provider-secret-`), false);

    const reconnect = await completeGitHubLogin(db, {
      githubUserId,
      login: `reconnected-${suffix}`,
      displayName: "Reconnected",
      accessToken: `provider-secret-reconnected-${suffix}`,
      tokenExpiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000),
    });
    assert.equal(reconnect.user.id, userId);
    const afterReconnect = await db.gitHubConnection.findFirstOrThrow({
      where: { userId, githubUserId },
      select: { id: true, userId: true },
    });
    assert.equal(afterReconnect.id, connections[0].id);
    assert.equal(afterReconnect.userId, userId);
    assert.equal((await readGitHubCredential(db, userId, afterReconnect.id))?.accessToken, `provider-secret-reconnected-${suffix}`);

    const sessionHashes = await db.session.findMany({ where: { userId }, select: { tokenHash: true } });
    assert.equal(sessionHashes.length, 4);
    for (const login of [...concurrentLogins, reconnect]) {
      assert.ok(sessionHashes.some((row) => row.tokenHash === sha256(login.sessionToken)));
      assert.ok(!sessionHashes.some((row) => row.tokenHash === login.sessionToken));
    }
  } finally {
    try {
      await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${rollbackTriggerName}" ON "Session"`);
    } finally {
      try {
        await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${rollbackFunctionName}"()`);
      } finally {
        try {
          await db.$transaction(async (tx: Prisma.TransactionClient) => {
            const fixtureUsers = await tx.user.findMany({
              where: { githubUserId: { in: fixtureGithubUserIds } },
              select: { id: true },
            });
            const fixtureUserIds = fixtureUsers.map((user) => user.id);
            if (fixtureUserIds.length > 0) {
              await tx.gitHubConnection.deleteMany({ where: { userId: { in: fixtureUserIds } } });
              await tx.session.deleteMany({ where: { userId: { in: fixtureUserIds } } });
              await tx.user.deleteMany({ where: { id: { in: fixtureUserIds } } });
            }
          });
          for (const stateHash of attemptHashes) {
            await db.$executeRaw`DELETE FROM "GitHubOAuthAttempt" WHERE "stateHash" = ${stateHash}`;
          }
        } finally {
          await disconnectDatabase();
        }
      }
    }
  }
});
