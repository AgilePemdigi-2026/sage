import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  createSession,
  database,
  disconnectDatabase,
  findAnalysisForUser,
  findArchitectureDocumentForUser,
  findExportForUser,
  findGitHubConnectionForUser,
  findGitHubInstallationForUser,
  findGraphBundleForUser,
  findJobForUser,
  findSourceFileForUser,
  findStorageObjectForUser,
  readGitHubCredential,
  replaceGitHubCredential,
  resolveSession,
  revokeGitHubCredentialForUser,
  revokeSession,
  storeGitHubCredential,
} from "../packages/database/src/index.ts";
import type { PrismaClient } from "../packages/database/generated/client.ts";

const TEST_DATABASES = new Set(["sage_data01", "sage_data01_fresh"]);

function assertIsolatedTestDatabase(): void {
  if (process.env.SAGE_DATABASE_TESTS !== "1") throw new Error("Set SAGE_DATABASE_TESTS=1 to run destructive database integration fixtures.");
  const rawUrl = process.env.DATABASE_URL;
  if (!rawUrl) throw new Error("DATABASE_URL is required for database integration tests.");
  let databaseName: string;
  try {
    databaseName = decodeURIComponent(new URL(rawUrl).pathname.slice(1));
  } catch {
    throw new Error("DATABASE_URL is invalid; it was not logged.");
  }
  if (!TEST_DATABASES.has(databaseName)) throw new Error("Database integration tests only allow the isolated DATA-01 test databases.");
}

async function cleanup(db: PrismaClient, userIds: string[], repositoryId: string): Promise<void> {
  await db.$transaction(async (tx) => {
    await tx.job.deleteMany({ where: { ownerUserId: { in: userIds } } });
    await tx.export.deleteMany({ where: { ownerUserId: { in: userIds } } });
    await tx.sourceFile.deleteMany({ where: { ownerUserId: { in: userIds } } });
    await tx.analysisStage.deleteMany({ where: { ownerUserId: { in: userIds } } });
    await tx.analysisLimitation.deleteMany({ where: { ownerUserId: { in: userIds } } });
    await tx.graphBundle.deleteMany({ where: { ownerUserId: { in: userIds } } });
    await tx.architectureDocument.deleteMany({ where: { ownerUserId: { in: userIds } } });
    await tx.storageObject.deleteMany({ where: { ownerUserId: { in: userIds } } });
    await tx.analysis.deleteMany({ where: { ownerUserId: { in: userIds } } });
    await tx.gitHubConnection.deleteMany({ where: { userId: { in: userIds } } });
    await tx.gitHubInstallation.deleteMany({ where: { ownerUserId: { in: userIds } } });
    await tx.session.deleteMany({ where: { userId: { in: userIds } } });
    await tx.user.deleteMany({ where: { id: { in: userIds } } });
    await tx.repository.deleteMany({ where: { id: repositoryId } });
  });
}

test("DATA-01 owner isolation, sessions, credentials and database constraints", async () => {
  assertIsolatedTestDatabase();
  const db = database();
  const suffix = randomUUID();
  let userIds: string[] = [];
  let repositoryId = "";
  try {
    const userA = await db.user.create({ data: { githubUserId: `data01-a-${suffix}`, login: `data01-a-${suffix}` } });
    userIds = [userA.id];
    const userB = await db.user.create({ data: { githubUserId: `data01-b-${suffix}`, login: `data01-b-${suffix}` } });
    userIds.push(userB.id);
    const repository = await db.repository.create({
      data: {
        githubRepositoryId: `data01-repository-${suffix}`,
        ownerLogin: "sage-data01-test",
        name: suffix,
        fullName: `sage-data01-test/${suffix}`,
        visibility: "PUBLIC",
      },
    });
    repositoryId = repository.id;
    const installation = await db.gitHubInstallation.create({
      data: { ownerUserId: userA.id, installationId: `data01-installation-${suffix}`, accountLogin: "sage-data01-test", accountType: "Organization" },
    });

    const analysisData = (ownerUserId: string) => ({
      ownerUserId,
      repositoryId: repository.id,
      branchName: "main",
      commitSha: "a".repeat(40),
      configuration: { includeTests: false },
      configurationHash: "b".repeat(64),
      analyzerVersion: "data01-test",
      schemaVersion: "1",
      status: "COMPLETED" as const,
    });
    const analysisA = await db.analysis.create({ data: analysisData(userA.id) });
    const analysisB = await db.analysis.create({ data: analysisData(userB.id) });
    await assert.rejects(
      db.user.create({ data: { githubUserId: userA.githubUserId, login: `duplicate-${suffix}` } }),
      (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "P2002",
    );

    const sourceStorage = await db.storageObject.create({
      data: {
        ownerUserId: userA.id,
        analysisId: analysisA.id,
        type: "SOURCE_FILE",
        storageKey: `data01-tests/${suffix}/source.ts`,
        sha256: "c".repeat(64),
        byteLength: 12n,
      },
    });
    const exportStorage = await db.storageObject.create({
      data: {
        ownerUserId: userA.id,
        analysisId: analysisA.id,
        type: "EXPORT",
        storageKey: `data01-tests/${suffix}/export.md`,
        sha256: "d".repeat(64),
        byteLength: 24n,
      },
    });
    const sourceFile = await db.sourceFile.create({
      data: {
        ownerUserId: userA.id,
        analysisId: analysisA.id,
        storageObjectId: sourceStorage.id,
        path: "src/index.ts",
        language: "TypeScript",
        byteLength: 12n,
        sha256: "c".repeat(64),
        processingStatus: "COMPLETED",
      },
    });
    await db.analysisStage.create({ data: { ownerUserId: userA.id, analysisId: analysisA.id, sequence: 1, key: "snapshot", status: "COMPLETED" } });
    const graphBundle = await db.graphBundle.create({
      data: {
        ownerUserId: userA.id,
        analysisId: analysisA.id,
        schemaVersion: "1",
        configurationHash: "b".repeat(64),
        nodes: [{ id: "n1", kind: "file" }],
        edges: [],
        nodeCount: 1,
        edgeCount: 0,
        contentHash: "e".repeat(64),
      },
    });
    const document = await db.architectureDocument.create({
      data: {
        ownerUserId: userA.id,
        analysisId: analysisA.id,
        title: "Test architecture",
        documentModelVersion: "1",
        interfaceCatalog: { interfaces: [] },
        softwareEngineeringDiagram: { nodes: [], edges: [] },
        umlClassDiagram: { classes: [], relationships: [] },
        contentHash: "f".repeat(64),
      },
    });
    const exportRecord = await db.export.create({
      data: {
        ownerUserId: userA.id,
        analysisId: analysisA.id,
        architectureDocumentId: document.id,
        storageObjectId: exportStorage.id,
        format: "MARKDOWN",
        documentHash: "f".repeat(64),
        rendererVersion: "data01-test",
        status: "READY",
        contentHash: "1".repeat(64),
      },
    });
    const job = await db.job.create({ data: { ownerUserId: userA.id, analysisId: analysisA.id, type: "ANALYSIS", status: "COMPLETED", queueSequence: 1n } });

    // The same public repository is valid for both users; all result records remain owner-bound.
    assert.equal(analysisA.repositoryId, analysisB.repositoryId);
    assert.ok(await findAnalysisForUser(db, userA.id, analysisA.id));
    assert.ok(await findAnalysisForUser(db, userB.id, analysisB.id));
    assert.equal(await findAnalysisForUser(db, userB.id, analysisA.id), null);
    assert.equal(await findAnalysisForUser(db, userA.id, analysisB.id), null);
    assert.equal(await findJobForUser(db, userB.id, job.id), null);
    assert.equal(await findSourceFileForUser(db, userB.id, sourceFile.id), null);
    assert.equal(await findGraphBundleForUser(db, userB.id, graphBundle.id), null);
    assert.equal(await findArchitectureDocumentForUser(db, userB.id, document.id), null);
    assert.equal(await findExportForUser(db, userB.id, exportRecord.id), null);
    assert.equal(await findStorageObjectForUser(db, userB.id, sourceStorage.id), null);
    assert.equal(await findGitHubInstallationForUser(db, userB.id, installation.id), null);
    assert.ok(await findGitHubInstallationForUser(db, userA.id, installation.id));

    const session = await createSession(db, userA.id);
    const sessionRow = await db.session.findUniqueOrThrow({ where: { id: session.session.sessionId }, select: { tokenHash: true } });
    assert.notEqual(sessionRow.tokenHash, session.token);
    assert.match(sessionRow.tokenHash, /^[a-f0-9]{64}$/);
    assert.equal((await resolveSession(db, session.token))?.userId, userA.id);
    assert.equal(await resolveSession(db, session.token, new Date(session.session.expiresAt.getTime() + 1)), null);
    assert.equal(await revokeSession(db, session.token), true);
    assert.equal(await resolveSession(db, session.token), null);
    assert.equal(await revokeSession(db, session.token), false);

    const plaintext = `github-secret-${suffix}`;
    const connection = await storeGitHubCredential(db, userA.id, {
      githubUserId: `gh-${suffix}`,
      githubLogin: `login-${suffix}`,
      accessToken: plaintext,
    });
    assert.equal(await findGitHubConnectionForUser(db, userB.id, connection.id), null);
    assert.ok(await findGitHubConnectionForUser(db, userA.id, connection.id));
    const storedCredential = await db.gitHubConnection.findUniqueOrThrow({
      where: { id: connection.id },
      select: { encryptedToken: true, tokenNonce: true, tokenAuthTag: true, encryptionKeyId: true },
    });
    assert.ok(!JSON.stringify(storedCredential).includes(plaintext));
    assert.equal(await readGitHubCredential(db, userB.id, connection.id), null);
    assert.equal((await readGitHubCredential(db, userA.id, connection.id))?.accessToken, plaintext);
    assert.equal(await replaceGitHubCredential(db, userB.id, connection.id, {
      githubUserId: `gh-${suffix}`,
      githubLogin: `login-${suffix}`,
      accessToken: `foreign-replacement-${suffix}`,
    }), false);

    await db.gitHubConnection.update({
      where: { id: connection.id },
      data: { status: "EXPIRED", tokenExpiresAt: new Date(Date.now() - 1) },
    });
    assert.equal(await readGitHubCredential(db, userA.id, connection.id), null);
    const refreshedToken = `refreshed-secret-${suffix}`;
    assert.equal(await replaceGitHubCredential(db, userA.id, connection.id, {
      githubUserId: `gh-${suffix}`,
      githubLogin: `login-${suffix}`,
      accessToken: refreshedToken,
      tokenExpiresAt: new Date(Date.now() + 60_000),
    }), true);
    assert.equal((await readGitHubCredential(db, userA.id, connection.id))?.accessToken, refreshedToken);
    assert.notEqual((await readGitHubCredential(db, userA.id, connection.id))?.accessToken, plaintext);

    const expiredConnection = await storeGitHubCredential(db, userA.id, {
      githubUserId: `gh-expired-${suffix}`,
      githubLogin: `expired-${suffix}`,
      accessToken: `expired-secret-${suffix}`,
      tokenExpiresAt: new Date(Date.now() - 1),
    });
    assert.equal(await readGitHubCredential(db, userA.id, expiredConnection.id), null);
    assert.equal(await revokeGitHubCredentialForUser(db, userA.id, connection.id), true);
    assert.equal(await readGitHubCredential(db, userA.id, connection.id), null);
    assert.equal(await revokeGitHubCredentialForUser(db, userA.id, connection.id), false);
    const reconnectedToken = `reconnected-secret-${suffix}`;
    assert.equal(await replaceGitHubCredential(db, userA.id, connection.id, {
      githubUserId: `gh-${suffix}`,
      githubLogin: `login-${suffix}`,
      accessToken: reconnectedToken,
    }), true);
    assert.equal((await readGitHubCredential(db, userA.id, connection.id))?.accessToken, reconnectedToken);

    await assert.rejects(
      db.sourceFile.create({
        data: {
          ownerUserId: userB.id,
          analysisId: analysisA.id,
          path: "foreign.ts",
          byteLength: 1n,
          sha256: "2".repeat(64),
          processingStatus: "PENDING",
        },
      }),
      (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "P2003",
    );
    await assert.rejects(
      db.export.create({
        data: {
          ownerUserId: userB.id,
          analysisId: analysisA.id,
          architectureDocumentId: document.id,
          format: "PDF",
          documentHash: "f".repeat(64),
          rendererVersion: "data01-test",
        },
      }),
      (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "P2003",
    );

    await db.gitHubConnection.update({
      where: { id: connection.id },
      data: { status: "ACTIVE", revokedAt: null, encryptedToken: "AA==" },
    });
    await assert.rejects(readGitHubCredential(db, userA.id, connection.id), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message.includes(plaintext), false);
      return /Kredensial tidak dapat dibuka/.test(error.message);
    });
  } finally {
    if (userIds.length > 0 && repositoryId) await cleanup(db, userIds, repositoryId);
    await disconnectDatabase();
  }
});
