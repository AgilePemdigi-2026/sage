import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createSession,
  database,
  disconnectDatabase,
  findAnalysisForUser,
  findArchitectureDocumentForUser,
  findGraphBundleForUser,
  findSourceFileForUser,
  findStorageObjectForUser,
  readGitHubCredential,
  storeGitHubCredential,
} from "../packages/database/src/index.ts";
import type { PrismaClient } from "../packages/database/generated/client.ts";

const TEST_DATABASES = new Set(["sage_data01", "sage_data01_fresh"]);
const CREDENTIAL_PREFIX = "data01-persistence-credential-";

type State = {
  userId: string;
  repositoryId: string;
  analysisId: string;
  sessionId: string;
  connectionId: string;
  storageObjectId: string;
  sourceFileId: string;
  graphBundleId: string;
  documentId: string;
};

function assertIsolatedTestDatabase(): string {
  if (process.env.SAGE_DATABASE_TESTS !== "1") throw new Error("Set SAGE_DATABASE_TESTS=1 to run destructive database persistence fixtures.");
  const rawUrl = process.env.DATABASE_URL;
  if (!rawUrl) throw new Error("DATABASE_URL is required for DATA-01 persistence checks.");
  let databaseName: string;
  try {
    databaseName = decodeURIComponent(new URL(rawUrl).pathname.slice(1));
  } catch {
    throw new Error("DATABASE_URL is invalid; it was not logged.");
  }
  if (!TEST_DATABASES.has(databaseName)) throw new Error("Persistence checks only allow the isolated DATA-01 test databases.");
  if (!process.env.STORAGE_ROOT) throw new Error("STORAGE_ROOT must point to the persistent test volume.");
  return databaseName;
}

function statePath(databaseName: string): string {
  return join(process.env.STORAGE_ROOT!, "data-check", `data01-${databaseName}.json`);
}

function parseState(input: string): State {
  const value: unknown = JSON.parse(input);
  if (!value || typeof value !== "object") throw new Error("Persisted DATA-01 test state is invalid.");
  const state = value as Record<string, unknown>;
  for (const key of ["userId", "repositoryId", "analysisId", "sessionId", "connectionId", "storageObjectId", "sourceFileId", "graphBundleId", "documentId"] as const) {
    if (typeof state[key] !== "string" || state[key].length === 0) throw new Error("Persisted DATA-01 test state is invalid.");
  }
  return state as State;
}

async function cleanup(db: PrismaClient, state: Pick<State, "userId" | "repositoryId">): Promise<void> {
  await db.$transaction(async (tx) => {
    await tx.job.deleteMany({ where: { ownerUserId: state.userId } });
    await tx.export.deleteMany({ where: { ownerUserId: state.userId } });
    await tx.sourceFile.deleteMany({ where: { ownerUserId: state.userId } });
    await tx.analysisStage.deleteMany({ where: { ownerUserId: state.userId } });
    await tx.analysisLimitation.deleteMany({ where: { ownerUserId: state.userId } });
    await tx.graphBundle.deleteMany({ where: { ownerUserId: state.userId } });
    await tx.architectureDocument.deleteMany({ where: { ownerUserId: state.userId } });
    await tx.storageObject.deleteMany({ where: { ownerUserId: state.userId } });
    await tx.analysis.deleteMany({ where: { ownerUserId: state.userId } });
    await tx.gitHubConnection.deleteMany({ where: { userId: state.userId } });
    await tx.gitHubInstallation.deleteMany({ where: { ownerUserId: state.userId } });
    await tx.session.deleteMany({ where: { userId: state.userId } });
    await tx.user.deleteMany({ where: { id: state.userId } });
    await tx.repository.deleteMany({ where: { id: state.repositoryId } });
  });
}

async function seed(db: PrismaClient, filePath: string): Promise<void> {
  const user = await db.user.create({ data: { githubUserId: `data01-persist-${randomUUID()}`, login: `data01-persist-${randomUUID()}` } });
  let repositoryId = "";
  const suffix = randomUUID();
  try {
    const repository = await db.repository.create({
      data: {
        githubRepositoryId: `data01-persist-${suffix}`,
        ownerLogin: "sage-data01-test",
        name: suffix,
        fullName: `sage-data01-test/${suffix}`,
        visibility: "PUBLIC",
      },
    });
    repositoryId = repository.id;
    const analysis = await db.analysis.create({
      data: {
        ownerUserId: user.id,
        repositoryId: repository.id,
        branchName: "main",
        commitSha: "a".repeat(40),
        configuration: { persistenceCheck: true },
        configurationHash: "b".repeat(64),
        analyzerVersion: "data01-persistence",
        schemaVersion: "1",
      },
    });
    const storageObject = await db.storageObject.create({
      data: {
        ownerUserId: user.id,
        analysisId: analysis.id,
        type: "SOURCE_FILE",
        storageKey: `data01-check/${suffix}/src/index.ts`,
        sha256: "c".repeat(64),
        byteLength: 10n,
      },
    });
    const sourceFile = await db.sourceFile.create({
      data: {
        ownerUserId: user.id,
        analysisId: analysis.id,
        storageObjectId: storageObject.id,
        path: "src/index.ts",
        language: "TypeScript",
        byteLength: 10n,
        sha256: "c".repeat(64),
        processingStatus: "PENDING",
      },
    });
    const graphBundle = await db.graphBundle.create({
      data: {
        ownerUserId: user.id,
        analysisId: analysis.id,
        schemaVersion: "1",
        configurationHash: "b".repeat(64),
        nodes: [],
        edges: [],
        nodeCount: 0,
        edgeCount: 0,
        contentHash: "d".repeat(64),
      },
    });
    const document = await db.architectureDocument.create({
      data: {
        ownerUserId: user.id,
        analysisId: analysis.id,
        title: "Persistence check",
        documentModelVersion: "1",
        interfaceCatalog: { interfaces: [] },
        softwareEngineeringDiagram: { nodes: [], edges: [] },
        umlClassDiagram: { classes: [], relationships: [] },
        contentHash: "e".repeat(64),
      },
    });
    const createdSession = await createSession(db, user.id);
    const connection = await storeGitHubCredential(db, user.id, {
      githubUserId: `data01-persist-gh-${suffix}`,
      githubLogin: "data01-persistence-check",
      accessToken: `${CREDENTIAL_PREFIX}${suffix}`,
    });
    const state: State = {
      userId: user.id,
      repositoryId: repository.id,
      analysisId: analysis.id,
      sessionId: createdSession.session.sessionId,
      connectionId: connection.id,
      storageObjectId: storageObject.id,
      sourceFileId: sourceFile.id,
      graphBundleId: graphBundle.id,
      documentId: document.id,
    };
    await mkdir(join(process.env.STORAGE_ROOT!, "data-check"), { recursive: true, mode: 0o700 });
    await writeFile(filePath, `${JSON.stringify(state)}\n`, { flag: "wx", mode: 0o600 });
    console.log(`DATA-01 persistence fixtures seeded for ${new URL(process.env.DATABASE_URL!).pathname.slice(1)}.`);
  } catch (error) {
    if (repositoryId) {
      await cleanup(db, { userId: user.id, repositoryId });
    } else {
      await db.user.delete({ where: { id: user.id } });
    }
    throw error;
  }
}

async function check(db: PrismaClient, filePath: string): Promise<void> {
  const state = parseState(await readFile(filePath, "utf8"));
  assert.ok(await db.user.findUnique({ where: { id: state.userId } }));
  assert.ok(await db.repository.findUnique({ where: { id: state.repositoryId } }));
  assert.ok(await findAnalysisForUser(db, state.userId, state.analysisId));
  assert.ok(await findSourceFileForUser(db, state.userId, state.sourceFileId));
  assert.ok(await findStorageObjectForUser(db, state.userId, state.storageObjectId));
  assert.ok(await findGraphBundleForUser(db, state.userId, state.graphBundleId));
  assert.ok(await findArchitectureDocumentForUser(db, state.userId, state.documentId));

  const session = await db.session.findFirst({
    where: { id: state.sessionId, userId: state.userId, revokedAt: null, expiresAt: { gt: new Date() } },
    select: { tokenHash: true },
  });
  assert.ok(session);
  assert.match(session.tokenHash, /^[a-f0-9]{64}$/);

  const credentialRow = await db.gitHubConnection.findFirst({
    where: { id: state.connectionId, userId: state.userId },
    select: { encryptedToken: true },
  });
  assert.ok(credentialRow);
  assert.equal(credentialRow.encryptedToken.includes(CREDENTIAL_PREFIX), false);
  const credential = await readGitHubCredential(db, state.userId, state.connectionId);
  assert.ok(credential?.accessToken.startsWith(CREDENTIAL_PREFIX));

  await cleanup(db, state);
  await unlink(filePath);
  console.log("DATA-01 database and credential persistence after restart: PASS; fixtures removed.");
}

async function main(): Promise<void> {
  const phase = process.argv[2];
  if (phase !== "seed" && phase !== "check") throw new Error("Gunakan fase seed atau check.");
  const databaseName = assertIsolatedTestDatabase();
  const filePath = statePath(databaseName);
  const db = database();
  try {
    if (phase === "seed") {
      await seed(db, filePath);
    } else {
      await check(db, filePath);
    }
  } finally {
    await disconnectDatabase();
  }
}

await main();
