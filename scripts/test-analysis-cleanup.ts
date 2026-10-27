import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createSession, database, disconnectDatabase, storeGitHubCredential } from "@sage/database";
import { chromium, request, type APIRequestContext, type Locator, type Page, type Response as BrowserResponse } from "playwright";

/**
 * Destructive, opt-in live-browser verification for ANALYSIS cleanup.
 *
 * Run only against the isolated `sage_cleanup23` database, a real Next server
 * and worker sharing the supplied private temporary STORAGE_ROOT, and the
 * fixed loopback browser origin:
 *   SAGE_CLEANUP_TESTS=1 \
 *   DATABASE_URL=postgresql://sage@127.0.0.1:5432/sage_cleanup23 \
 *   CREDENTIAL_ENCRYPTION_KEY=<test-only-32-byte-base64> \
 *   STORAGE_ROOT=/tmp/sage-cleanup23-storage \
 *   SAGE_CLEANUP_BASE_URL=http://127.0.0.1:3000 \
 *   npx tsx scripts/test-analysis-cleanup.ts
 *
 * Optional: SAGE_CLEANUP_ARTIFACT_DIR=/tmp/sage-cleanup23-artifacts
 *
 * The fixtures are synthetic and deletion-only. This checks live HTTP routes,
 * the real cleanup worker, and history confirmation/retry at mobile and desktop
 * viewports. It does not run the analysis pipeline, GitHub OAuth, or providers.
 */

const enabled = process.env.SAGE_CLEANUP_TESTS === "1";
if (!enabled) throw new Error("Set SAGE_CLEANUP_TESTS=1 to run the isolated live cleanup regression.");

function requireDedicatedDatabase(): void {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error("DATABASE_URL is required when SAGE_CLEANUP_TESTS=1.");
  let databaseName: string;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") throw new Error("protocol");
    databaseName = decodeURIComponent(parsed.pathname.slice(1));
  } catch {
    throw new Error("DATABASE_URL must be a valid PostgreSQL URL; it was not logged.");
  }
  if (databaseName !== "sage_cleanup23") {
    throw new Error("Live analysis cleanup only allows the isolated sage_cleanup23 database.");
  }
}

requireDedicatedDatabase();

const baseURL = process.env.SAGE_CLEANUP_BASE_URL ?? "http://127.0.0.1:3000";
if (baseURL !== "http://127.0.0.1:3000") {
  throw new Error("SAGE_CLEANUP_BASE_URL must be exactly http://127.0.0.1:3000.");
}
const browserOrigin = new URL(baseURL);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifactDirectory = resolve(process.env.SAGE_CLEANUP_ARTIFACT_DIR ?? join(projectRoot, "artifacts/analysis-cleanup-live"));
const reportPath = join(artifactDirectory, "report.json");
const mobileViewport = { width: 390, height: 844 };
const desktopViewport = { width: 1440, height: 960 };

type DisposableAccount = {
  userId: string;
  login: string;
  accountKey: string;
  token: string;
};

type AnalysisStatusFixture = "FAILED" | "RUNNING";
type SeededAnalysis = {
  id: string;
  repositoryId: string;
  repositoryFullName: string;
  commitSha: string;
  storageKey?: string;
  folderName?: string;
  archivePath?: string;
  archiveBytes?: Buffer;
};
type SeededDeleteArtifacts = {
  exportFolderName: string;
  exportPath: string;
  exportBytes: Buffer;
  pendingFolderName: string;
  pendingPath: string;
};
type CleanupSnapshot = {
  jobId: string;
  analysisId: string;
  status: "QUEUED" | "RUNNING" | "FAILED" | "COMPLETED";
  errorCode: string | null;
};
type CleanupResponse = {
  data?: {
    accountKey?: string;
    analysisId?: string;
    deletion?: CleanupSnapshot;
  };
  error?: { code?: string; message?: string };
};

const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
const checks: string[] = [];
const screenshots: string[] = [];
const fixtureUserIds: string[] = [];
const fixtureRepositoryIds: string[] = [];
const fixtureAnalysisIds: string[] = [];
const storageFolderNames = new Set<string>();
let storageRoot: string | undefined;
let outsideDirectory: string | undefined;
let ownsOutsideDirectory = false;
let outsideCanaryPath: string | undefined;
let outsideCanaryBytes: Buffer | undefined;
let db: ReturnType<typeof database> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let api: APIRequestContext | undefined;
let page: Page | undefined;
let phase = "preflight";
let failed = false;
let failureName: string | null = null;
let failureCode: string | null = null;
let runSucceeded = false;
let externalRequestsBlocked = 0;
let observedCleanupJobs = 0;
let observedCleanupFailures = 0;
let observedCleanupRetries = 0;
let screenshotDirectoryReady = false;

function digest(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function lstatMaybe(path: string) {
  try { return await lstat(path); } catch (error) { if (isMissing(error)) return null; throw error; }
}

async function pathExists(path: string): Promise<boolean> {
  return (await lstatMaybe(path)) !== null;
}

function safeErrorIdentity(error: unknown): { name: string; code: string | null } {
  if (typeof error !== "object" || error === null) return { name: "UnknownError", code: null };
  const value = error as { name?: unknown; code?: unknown };
  const name = typeof value.name === "string" && /^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(value.name)
    ? value.name
    : "Error";
  const code = typeof value.code === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(value.code)
    ? value.code
    : null;
  return { name, code };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolveDelay => setTimeout(resolveDelay, milliseconds));
}

async function preparePrivateStorageRoot(): Promise<string> {
  const raw = process.env.STORAGE_ROOT;
  if (!raw || !isAbsolute(raw)) throw new Error("STORAGE_ROOT must be an absolute private temporary directory shared with Next and the worker.");
  const requested = resolve(raw);
  const temporaryRoots = [...new Set([resolve(tmpdir()), resolve("/tmp"), resolve("/var/tmp")])];
  if (temporaryRoots.every(root => requested === root || !requested.startsWith(`${root}${sep}`))) {
    throw new Error("Refusing to use STORAGE_ROOT outside a temporary directory.");
  }

  await mkdir(requested, { recursive: true, mode: 0o700 });
  const stat = await lstat(requested);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("STORAGE_ROOT must be a real directory, not a symlink.");
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) throw new Error("STORAGE_ROOT must have private permissions (0700).");
  const root = await realpath(requested);
  const canonicalTempRoots = await Promise.all(temporaryRoots.map(async candidate => {
    try { return await realpath(candidate); } catch { return candidate; }
  }));
  if (canonicalTempRoots.every(candidate => root === candidate || !root.startsWith(`${candidate}${sep}`))) {
    throw new Error("Refusing to use a STORAGE_ROOT whose resolved path is outside a temporary directory.");
  }
  if ((await readdir(root)).length !== 0) throw new Error("STORAGE_ROOT must be empty before the live cleanup regression starts.");
  return root;
}

async function validateArtifactDirectory(root: string): Promise<void> {
  const artifact = resolve(artifactDirectory);
  if (artifact === root || artifact.startsWith(`${root}${sep}`)) {
    throw new Error("SAGE_CLEANUP_ARTIFACT_DIR must be outside STORAGE_ROOT.");
  }
  let existing = artifact;
  const suffix: string[] = [];
  while (!(await lstatMaybe(existing))) {
    const parent = dirname(existing);
    if (parent === existing) throw new Error("SAGE_CLEANUP_ARTIFACT_DIR has no existing parent directory.");
    suffix.unshift(basename(existing));
    existing = parent;
  }
  const canonicalArtifact = resolve(await realpath(existing), ...suffix);
  if (canonicalArtifact === root || canonicalArtifact.startsWith(`${root}${sep}`)) {
    throw new Error("SAGE_CLEANUP_ARTIFACT_DIR must resolve outside STORAGE_ROOT.");
  }
}

async function makeAccount(label: "owner" | "foreign"): Promise<DisposableAccount> {
  assert.ok(db);
  const accountSuffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const login = `cleanup-${label}-${accountSuffix}`;
  const accountKey = `cleanup-gh-${label}-${accountSuffix}`;
  const user = await db.user.create({ data: { githubUserId: accountKey, login }, select: { id: true } });
  fixtureUserIds.push(user.id);
  await storeGitHubCredential(db, user.id, {
    githubUserId: accountKey,
    githubLogin: login,
    accessToken: `synthetic-not-provider-cleanup-${label}-${accountSuffix}`,
  });
  const created = await createSession(db, user.id, { ttlMs: 30 * 60 * 1000 });
  return { userId: user.id, login, accountKey, token: created.token };
}

async function createRepository(account: DisposableAccount, label: string): Promise<{ id: string; fullName: string }> {
  assert.ok(db);
  const repositorySuffix = randomUUID().replaceAll("-", "").slice(0, 8);
  const fullName = `cleanup-live/${label}-${repositorySuffix}`;
  const row = await db.repository.create({
    data: {
      githubRepositoryId: `cleanup-live-${randomUUID()}`,
      ownerLogin: account.login,
      name: `${label}-${repositorySuffix}`,
      fullName,
      visibility: "PUBLIC",
      defaultBranch: "main",
    },
    select: { id: true },
  });
  fixtureRepositoryIds.push(row.id);
  return { id: row.id, fullName };
}

async function newFolderName(): Promise<string> {
  let folderName: string;
  do { folderName = `snapshot-${randomBytes(4).toString("hex").slice(0, 6)}`; }
  while (storageFolderNames.has(folderName));
  storageFolderNames.add(folderName);
  return folderName;
}

async function seedAnalysis(input: {
  account: DisposableAccount;
  label: string;
  status: AnalysisStatusFixture;
  commitSha?: string;
  retryParentId?: string;
  repository?: { id: string; fullName: string };
}): Promise<SeededAnalysis> {
  assert.ok(db);
  const repository = input.repository ?? await createRepository(input.account, input.label);
  const now = new Date();
  const configuration = { cleanupFixture: true };
  const analysis = await db.analysis.create({
    data: {
      ownerUserId: input.account.userId,
      repositoryId: repository.id,
      repositoryFullNameSnapshot: repository.fullName,
      ...(input.retryParentId ? { retryParentId: input.retryParentId } : {}),
      branchName: "main",
      commitSha: input.commitSha ?? randomBytes(20).toString("hex"),
      configuration,
      configurationHash: digest(JSON.stringify(configuration)),
      analyzerVersion: "analysis-cleanup-live-fixture",
      schemaVersion: "1",
      status: input.status,
      errorCode: input.status === "FAILED" ? "FIXTURE_ANALYSIS_FAILED" : null,
      startedAt: input.status === "RUNNING" ? now : now,
      completedAt: input.status === "RUNNING" ? null : now,
    },
    select: { id: true, commitSha: true },
  });
  fixtureAnalysisIds.push(analysis.id);
  return {
    id: analysis.id,
    repositoryId: repository.id,
    repositoryFullName: repository.fullName,
    commitSha: analysis.commitSha,
  };
}

async function seedArchive(input: {
  account: DisposableAccount;
  analysis: SeededAnalysis;
  label: string;
  symlinkTarget?: string;
}): Promise<SeededAnalysis> {
  assert.ok(db);
  assert.ok(storageRoot);
  const folderName = await newFolderName();
  const bytes = Buffer.from(`synthetic delete-only source archive fixture: ${input.label}\n`, "utf8");
  const archivePath = join(storageRoot, folderName, "archive.tar.gz");
  if (input.symlinkTarget) {
    await symlink(input.symlinkTarget, join(storageRoot, folderName), process.platform === "win32" ? "junction" : "dir");
    await writeFile(join(input.symlinkTarget, "archive.tar.gz"), bytes, { flag: "wx", mode: 0o600 });
  } else {
    await mkdir(join(storageRoot, folderName), { mode: 0o700 });
    await writeFile(archivePath, bytes, { flag: "wx", mode: 0o600 });
  }

  const storageObject = await db.storageObject.create({
    data: {
      ownerUserId: input.account.userId,
      analysisId: input.analysis.id,
      type: "SOURCE_ARCHIVE",
      storageKey: `${folderName}/archive.tar.gz`,
      sha256: digest(bytes),
      byteLength: BigInt(bytes.byteLength),
      status: "ACTIVE",
    },
    select: { id: true },
  });
  await db.sourceFile.create({
    data: {
      ownerUserId: input.account.userId,
      analysisId: input.analysis.id,
      storageObjectId: storageObject.id,
      path: "src/cleanup-fixture.ts",
      language: "TypeScript",
      byteLength: BigInt(bytes.byteLength),
      sha256: digest(bytes),
      processingStatus: "COMPLETED",
    },
  });
  return {
    ...input.analysis,
    storageKey: `${folderName}/archive.tar.gz`,
    folderName,
    archivePath,
    archiveBytes: bytes,
  };
}

async function seedDeleteOnlyArtifacts(account: DisposableAccount, analysis: SeededAnalysis): Promise<SeededDeleteArtifacts> {
  assert.ok(db);
  assert.ok(storageRoot);
  const contentHash = digest(`delete-only artifact for ${analysis.repositoryFullName}`);
  await db.graphBundle.create({
    data: {
      ownerUserId: account.userId,
      analysisId: analysis.id,
      schemaVersion: "1",
      configurationHash: digest("cleanup-live-config"),
      canonicalContent: "{}",
      nodes: "[]",
      edges: "[]",
      nodeCount: 0,
      edgeCount: 0,
      contentHash,
    },
  });
  const document = await db.architectureDocument.create({
    data: {
      ownerUserId: account.userId,
      analysisId: analysis.id,
      title: "Cleanup delete-only fixture",
      documentModelVersion: "cleanup-live-fixture",
      canonicalContent: "{}",
      interfaceCatalog: "{}",
      softwareEngineeringDiagram: "{}",
      umlClassDiagram: "{}",
      contentHash,
    },
    select: { id: true },
  });
  const exportFolderName = `export-${randomUUID()}`;
  const exportBytes = Buffer.from(`synthetic Markdown export for ${analysis.repositoryFullName}\n`, "utf8");
  const exportPath = join(storageRoot, exportFolderName, "document.md");
  storageFolderNames.add(exportFolderName);
  await mkdir(join(storageRoot, exportFolderName), { mode: 0o700 });
  await writeFile(exportPath, exportBytes, { flag: "wx", mode: 0o600 });
  const exportStorage = await db.storageObject.create({
    data: {
      ownerUserId: account.userId,
      analysisId: analysis.id,
      type: "EXPORT",
      storageKey: `${exportFolderName}/document.md`,
      sha256: digest(exportBytes),
      byteLength: BigInt(exportBytes.byteLength),
      status: "ACTIVE",
    },
    select: { id: true },
  });
  await db.export.create({
    data: {
      ownerUserId: account.userId,
      analysisId: analysis.id,
      architectureDocumentId: document.id,
      storageObjectId: exportStorage.id,
      format: "MARKDOWN",
      documentHash: contentHash,
      rendererVersion: "cleanup-live-fixture",
      status: "READY",
      contentHash,
      readyAt: new Date(),
    },
  });

  // A failed export may have left an exact reserved .pending path with no
  // StorageObject row. Cleanup must include it from the durable reservation.
  const pendingFolderName = `export-${randomUUID()}`;
  const pendingPath = join(storageRoot, pendingFolderName, "document.md.pending");
  storageFolderNames.add(pendingFolderName);
  await mkdir(join(storageRoot, pendingFolderName), { mode: 0o700 });
  await writeFile(pendingPath, Buffer.from("synthetic pending export stage\n"), { flag: "wx", mode: 0o600 });
  const failedExport = await db.export.create({
    data: {
      ownerUserId: account.userId,
      analysisId: analysis.id,
      architectureDocumentId: document.id,
      format: "PDF",
      documentHash: contentHash,
      rendererVersion: "cleanup-live-fixture",
      status: "FAILED",
      errorCode: "FIXTURE_ONLY",
    },
    select: { id: true },
  });
  await db.$transaction(async tx => {
    await tx.workerSlot.upsert({ where: { slotKey: "export" }, create: { slotKey: "export" }, update: {} });
    const slots = await tx.$queryRaw<Array<{ jobId: string | null; lastEnqueueSequence: bigint }>>`SELECT "jobId", "lastEnqueueSequence" FROM "WorkerSlot" WHERE "slotKey" = 'export' FOR UPDATE`;
    if (!slots[0] || slots[0].jobId) throw new Error("Dedicated test database already has an occupied export worker slot.");
    const maxima = await tx.$queryRaw<Array<{ maxSequence: bigint | null }>>`SELECT MAX("queueSequence") AS "maxSequence" FROM "Job" WHERE "type" = 'EXPORT'`;
    const maximum = maxima[0]?.maxSequence ?? 0n;
    const base = slots[0].lastEnqueueSequence > maximum ? slots[0].lastEnqueueSequence : maximum;
    const queueSequence = base + 1n;
    await tx.workerSlot.update({ where: { slotKey: "export" }, data: { lastEnqueueSequence: queueSequence } });
    await tx.job.create({
      data: {
        ownerUserId: account.userId,
        analysisId: analysis.id,
        exportId: failedExport.id,
        queueSequence,
        type: "EXPORT",
        status: "FAILED",
        attempt: 1,
        errorCode: "FIXTURE_ONLY",
        finishedAt: new Date(),
        storageReservations: [`${pendingFolderName}/document.md.pending`],
      },
    });
  });
  return { exportFolderName, exportPath, exportBytes, pendingFolderName, pendingPath };
}

async function seedActiveAnalysis(account: DisposableAccount): Promise<SeededAnalysis> {
  assert.ok(db);
  const analysis = await seedAnalysis({ account, label: "active-analysis", status: "FAILED" });
  const leaseExpiresAt = new Date(Date.now() + 120_000);
  await db.$transaction(async tx => {
    await tx.workerSlot.upsert({ where: { slotKey: "analysis" }, create: { slotKey: "analysis" }, update: {} });
    const slots = await tx.$queryRaw<Array<{ jobId: string | null; lastEnqueueSequence: bigint }>>`SELECT "jobId", "lastEnqueueSequence" FROM "WorkerSlot" WHERE "slotKey" = 'analysis' FOR UPDATE`;
    if (slots[0]?.jobId) throw new Error("Dedicated test database already has an occupied analysis worker slot.");
    const maxima = await tx.$queryRaw<Array<{ maxSequence: bigint | null }>>`SELECT MAX("queueSequence") AS "maxSequence" FROM "Job" WHERE "type" = 'ANALYSIS'`;
    const maximum = maxima[0]?.maxSequence ?? 0n;
    const base = slots[0] && slots[0].lastEnqueueSequence > maximum ? slots[0].lastEnqueueSequence : maximum;
    const queueSequence = base + 1n;
    await tx.workerSlot.update({ where: { slotKey: "analysis" }, data: { lastEnqueueSequence: queueSequence } });
    const job = await tx.job.create({
      data: {
        ownerUserId: account.userId,
        analysisId: analysis.id,
        queueSequence,
        type: "ANALYSIS",
        status: "RUNNING",
        attempt: 1,
        startedAt: new Date(),
        heartbeatAt: new Date(),
        leaseExpiresAt,
      },
      select: { id: true },
    });
    await tx.analysis.update({
      where: { id: analysis.id },
      data: { status: "RUNNING", errorCode: null, startedAt: new Date(), completedAt: null },
    });
    await tx.workerSlot.update({
      where: { slotKey: "analysis" },
      data: {
        jobId: job.id,
        ownerUserId: account.userId,
        leaseUntil: leaseExpiresAt,
        heartbeatAt: new Date(),
        leaseTokenHash: digest(randomUUID()),
      },
    });
  });
  return analysis;
}

async function seedActiveExport(account: DisposableAccount): Promise<SeededAnalysis> {
  assert.ok(db);
  const analysis = await seedAnalysis({ account, label: "active-export", status: "FAILED" });
  const contentHash = digest(`active export fixture ${analysis.id}`);
  const document = await db.architectureDocument.create({
    data: {
      ownerUserId: account.userId,
      analysisId: analysis.id,
      title: "Active export delete guard",
      documentModelVersion: "cleanup-live-fixture",
      canonicalContent: "{}",
      interfaceCatalog: "{}",
      softwareEngineeringDiagram: "{}",
      umlClassDiagram: "{}",
      contentHash,
    },
    select: { id: true },
  });
  const exported = await db.export.create({
    data: {
      ownerUserId: account.userId,
      analysisId: analysis.id,
      architectureDocumentId: document.id,
      format: "PDF",
      documentHash: contentHash,
      rendererVersion: "cleanup-live-fixture",
      status: "FAILED",
      errorCode: "FIXTURE_ONLY",
    },
    select: { id: true },
  });
  const leaseExpiresAt = new Date(Date.now() + 120_000);
  await db.$transaction(async tx => {
    await tx.workerSlot.upsert({ where: { slotKey: "export" }, create: { slotKey: "export" }, update: {} });
    const slots = await tx.$queryRaw<Array<{ jobId: string | null; lastEnqueueSequence: bigint }>>`SELECT "jobId", "lastEnqueueSequence" FROM "WorkerSlot" WHERE "slotKey" = 'export' FOR UPDATE`;
    if (slots[0]?.jobId) throw new Error("Dedicated test database already has an occupied export worker slot.");
    const maxima = await tx.$queryRaw<Array<{ maxSequence: bigint | null }>>`SELECT MAX("queueSequence") AS "maxSequence" FROM "Job" WHERE "type" = 'EXPORT'`;
    const maximum = maxima[0]?.maxSequence ?? 0n;
    const base = slots[0] && slots[0].lastEnqueueSequence > maximum ? slots[0].lastEnqueueSequence : maximum;
    const queueSequence = base + 1n;
    await tx.workerSlot.update({ where: { slotKey: "export" }, data: { lastEnqueueSequence: queueSequence } });
    await tx.export.update({ where: { id: exported.id }, data: { status: "GENERATING", errorCode: null } });
    const job = await tx.job.create({
      data: {
        ownerUserId: account.userId,
        analysisId: analysis.id,
        exportId: exported.id,
        queueSequence,
        type: "EXPORT",
        status: "RUNNING",
        attempt: 1,
        startedAt: new Date(),
        heartbeatAt: new Date(),
        leaseExpiresAt,
      },
      select: { id: true },
    });
    await tx.workerSlot.update({
      where: { slotKey: "export" },
      data: {
        jobId: job.id,
        ownerUserId: account.userId,
        leaseUntil: leaseExpiresAt,
        heartbeatAt: new Date(),
        leaseTokenHash: digest(randomUUID()),
      },
    });
  });
  return analysis;
}

function authHeaders(account: DisposableAccount): Record<string, string> {
  return {
    Cookie: `sage_session=${account.token}`,
    Origin: browserOrigin.origin,
    "X-SAGE-Account": account.accountKey,
  };
}

function assertApiError(payload: CleanupResponse, code: string): void {
  assert.equal(payload.error?.code, code, `expected API error code ${code}`);
}

async function apiDelete(
  client: APIRequestContext,
  analysisId: string,
  options: { account?: DisposableAccount; origin?: string; accountHeader?: string; body?: unknown } = {},
) {
  const headers: Record<string, string> = { Origin: options.origin ?? browserOrigin.origin };
  if (options.account) headers.Cookie = `sage_session=${options.account.token}`;
  if (options.accountHeader !== undefined) headers["X-SAGE-Account"] = options.accountHeader;
  return client.delete(`/api/analyses/${encodeURIComponent(analysisId)}`, {
    headers,
    data: options.body ?? {},
  });
}

async function readCleanupJob(client: APIRequestContext, account: DisposableAccount, jobId: string): Promise<CleanupSnapshot> {
  const response = await client.get(`/api/jobs/${encodeURIComponent(jobId)}`, { headers: authHeaders(account) });
  assert.equal(response.status(), 200, "the owning account can read its cleanup job");
  const body = await response.json() as CleanupResponse;
  assert.ok(body.data?.deletion, "cleanup job response uses the common data envelope");
  assert.equal(body.data.accountKey, account.accountKey);
  assert.equal(body.data.deletion.jobId, jobId);
  return body.data.deletion;
}

async function waitForCleanupStatus(
  client: APIRequestContext,
  account: DisposableAccount,
  jobId: string,
  expected: "FAILED" | "COMPLETED",
  timeoutMs = 30_000,
): Promise<CleanupSnapshot> {
  const deadline = Date.now() + timeoutMs;
  let last: CleanupSnapshot | undefined;
  while (Date.now() < deadline) {
    last = await readCleanupJob(client, account, jobId);
    if (last.status === expected) return last;
    if (last.status === "FAILED" || last.status === "COMPLETED") {
      throw new Error(`Cleanup worker reached ${last.status} while waiting for ${expected}.`);
    }
    await delay(200);
  }
  throw new Error(`Cleanup job did not reach ${expected} before the verification timeout (last status: ${last?.status ?? "unavailable"}).`);
}

async function assertNoHorizontalOverflow(target: Page): Promise<void> {
  assert.equal(
    await target.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    true,
    "history page should fit the selected viewport width",
  );
}

function historyRowForCommit(target: Page, commitSha: string): Locator {
  // The short SHA is a unique, visible identifier in the fixture row. Its
  // grandparent is the history row containing that row's action buttons.
  return target.getByText(commitSha.slice(0, 7), { exact: true }).locator("xpath=../..");
}

async function capture(target: Page, name: string): Promise<void> {
  assert.ok(screenshotDirectoryReady);
  await target.screenshot({ path: join(artifactDirectory, name), fullPage: true });
  screenshots.push(name);
}

async function confirmDeleteFromHistory(target: Page, buttonName: string, commitSha: string): Promise<BrowserResponse> {
  await historyRowForCommit(target, commitSha).getByRole("button", { name: buttonName, exact: true }).click();
  const dialog = target.getByRole("dialog");
  await dialog.waitFor({ state: "visible" });
  await dialog.getByRole("button", { name: "Hapus permanen", exact: true }).waitFor({ state: "visible" });
  const responsePromise = target.waitForResponse(response => {
    if (response.request().method() !== "DELETE") return false;
    const path = new URL(response.url()).pathname;
    return /^\/api\/analyses\/[A-Za-z0-9_-]{8,64}$/.test(path);
  });
  await dialog.getByRole("button", { name: "Hapus permanen", exact: true }).click();
  return responsePromise;
}

async function teardownFixtures(): Promise<void> {
  if (!db || fixtureUserIds.length === 0) return;
  const ownerIds = [...new Set(fixtureUserIds)];
  const repositoryIds = [...new Set(fixtureRepositoryIds)];
  await db.$transaction(async tx => {
    // WorkerSlot uses SetNull for its Job relation; remove only slots owned by
    // these synthetic users before deleting their fenced fixture jobs.
    await tx.workerSlot.deleteMany({ where: { ownerUserId: { in: ownerIds } } });
    await tx.job.deleteMany({ where: { ownerUserId: { in: ownerIds } } });
    await tx.gitHubConnection.deleteMany({ where: { userId: { in: ownerIds } } });
    await tx.export.deleteMany({ where: { ownerUserId: { in: ownerIds } } });
    await tx.sourceFile.deleteMany({ where: { ownerUserId: { in: ownerIds } } });
    await tx.analysisStage.deleteMany({ where: { ownerUserId: { in: ownerIds } } });
    await tx.analysisLimitation.deleteMany({ where: { ownerUserId: { in: ownerIds } } });
    await tx.graphBundle.deleteMany({ where: { ownerUserId: { in: ownerIds } } });
    await tx.architectureDocument.deleteMany({ where: { ownerUserId: { in: ownerIds } } });
    await tx.storageObject.deleteMany({ where: { ownerUserId: { in: ownerIds } } });
    await tx.analysis.updateMany({ where: { ownerUserId: { in: ownerIds }, retryParentId: { not: null } }, data: { retryParentId: null } });
    await tx.analysis.deleteMany({ where: { ownerUserId: { in: ownerIds } } });
    if (repositoryIds.length) await tx.repository.deleteMany({ where: { id: { in: repositoryIds } } });
    await tx.session.deleteMany({ where: { userId: { in: ownerIds } } });
    await tx.user.deleteMany({ where: { id: { in: ownerIds } } });
  });
}

async function removeOwnedStorageFolders(): Promise<void> {
  if (!storageRoot) return;
  for (const folderName of storageFolderNames) {
    const folder = join(storageRoot, folderName);
    const stat = await lstatMaybe(folder);
    if (!stat) continue;
    if (stat.isSymbolicLink()) await unlink(folder);
    else if (stat.isDirectory()) await rm(folder, { recursive: true, force: true });
  }
  if (outsideDirectory && ownsOutsideDirectory) await rm(outsideDirectory, { recursive: true, force: true });
}

async function run(): Promise<void> {
  phase = "private storage and artifact preflight";
  storageRoot = await preparePrivateStorageRoot();
  await validateArtifactDirectory(storageRoot);
  await mkdir(artifactDirectory, { recursive: true });
  screenshotDirectoryReady = true;

  phase = "dedicated database connection";
  db = database();
  await db.$queryRaw`SELECT 1`;
  const owner = await makeAccount("owner");
  const foreign = await makeAccount("foreign");

  phase = "prepare outside-neighbor safety canary";
  const outsideSuffix = randomUUID().replaceAll("-", "").slice(0, 10);
  outsideDirectory = join(dirname(storageRoot), `${basename(storageRoot)}-neighbor-${outsideSuffix}`);
  if (await pathExists(outsideDirectory)) throw new Error("Refusing to reuse an existing outside-neighbor fixture directory.");
  await mkdir(outsideDirectory, { mode: 0o700 });
  ownsOutsideDirectory = true;
  outsideCanaryPath = join(outsideDirectory, "preserve-me.txt");
  outsideCanaryBytes = Buffer.from(`outside cleanup canary ${outsideSuffix}\n`, "utf8");
  await writeFile(outsideCanaryPath, outsideCanaryBytes, { flag: "wx", mode: 0o600 });

  phase = "seed terminal retry-parent analysis";
  const parent = await seedAnalysis({ account: owner, label: "retry-parent", status: "FAILED", commitSha: "a".repeat(40) });
  phase = "seed parent source archive and source file";
  const parentWithArchive = await seedArchive({ account: owner, analysis: parent, label: "retry-parent" });
  phase = "seed preserved retry child";
  const child = await seedAnalysis({
    account: owner,
    label: "retry-child",
    status: "FAILED",
    commitSha: "b".repeat(40),
    retryParentId: parent.id,
    repository: { id: parent.repositoryId, fullName: parent.repositoryFullName },
  });
  phase = "seed registered Markdown/PDF artifacts and pending export reservation";
  const parentArtifacts = await seedDeleteOnlyArtifacts(owner, parent);

  phase = "seed symlink-failure analysis";
  const symlinkFixture = await seedAnalysis({ account: owner, label: "symlink-retry", status: "FAILED", commitSha: "c".repeat(40) });
  phase = "seed symlinked source archive";
  const symlinkWithArchive = await seedArchive({
    account: owner,
    analysis: symlinkFixture,
    label: "symlink retry",
    symlinkTarget: outsideDirectory,
  });
  phase = "seed foreign analysis and storage";
  const foreignAnalysis = await seedAnalysis({ account: foreign, label: "foreign-preserved", status: "FAILED", commitSha: "d".repeat(40) });
  const foreignWithArchive = await seedArchive({ account: foreign, analysis: foreignAnalysis, label: "foreign preserved" });
  phase = "seed active analysis job with a fenced worker slot";
  const activeAnalysis = await seedActiveAnalysis(owner);
  phase = "seed active export job with a fenced worker slot";
  const activeExportAnalysis = await seedActiveExport(owner);

  // This FAILED cleanup row is intentionally inert. It gives the live job API
  // a foreign-owned record without starting deletion of the foreign archive.
  phase = "seed inert foreign cleanup-job access fixture";
  const foreignJob = await db.job.create({
    data: {
      ownerUserId: foreign.userId,
      type: "CLEANUP",
      status: "FAILED",
      cleanupAnalysisId: `cleanup-foreign-fixture-${suffix}`,
      cleanupManifest: [],
      errorCode: "FIXTURE_ONLY",
      finishedAt: new Date(),
    },
    select: { id: true },
  });

  phase = "live Next API security and conflict checks";
  api = await request.newContext({ baseURL, extraHTTPHeaders: { Accept: "application/json" }, timeout: 15_000 });
  const anonymousDelete = await apiDelete(api, parent.id);
  assert.equal(anonymousDelete.status(), 401);
  assertApiError(await anonymousDelete.json() as CleanupResponse, "AUTH_REQUIRED");

  const wrongAccount = await apiDelete(api, parent.id, { account: owner, accountHeader: foreign.accountKey });
  assert.equal(wrongAccount.status(), 401);
  assertApiError(await wrongAccount.json() as CleanupResponse, "AUTH_REQUIRED");

  const badOrigin = await apiDelete(api, parent.id, { account: owner, origin: "https://attacker.invalid" });
  assert.equal(badOrigin.status(), 403);
  assertApiError(await badOrigin.json() as CleanupResponse, "FORBIDDEN_ORIGIN");

  const unknownFields = await apiDelete(api, parent.id, { account: owner, body: { unexpected: true } });
  assert.equal(unknownFields.status(), 400);
  assertApiError(await unknownFields.json() as CleanupResponse, "INVALID_INPUT");

  const foreignAnalysisDelete = await apiDelete(api, foreignAnalysis.id, { account: owner });
  assert.equal(foreignAnalysisDelete.status(), 404);
  assertApiError(await foreignAnalysisDelete.json() as CleanupResponse, "ANALYSIS_NOT_FOUND");

  const foreignJobAsOwner = await api.get(`/api/jobs/${foreignJob.id}`, { headers: authHeaders(owner) });
  assert.equal(foreignJobAsOwner.status(), 404);
  const foreignJobAnonymous = await api.get(`/api/jobs/${foreignJob.id}`);
  assert.equal(foreignJobAnonymous.status(), 401);
  const foreignJobAsForeign = await api.get(`/api/jobs/${foreignJob.id}`, { headers: authHeaders(foreign) });
  assert.equal(foreignJobAsForeign.status(), 200);
  const foreignJobPayload = await foreignJobAsForeign.json() as CleanupResponse;
  assert.equal(foreignJobPayload.data?.deletion?.status, "FAILED");

  const activeAnalysisDelete = await apiDelete(api, activeAnalysis.id, { account: owner });
  assert.equal(activeAnalysisDelete.status(), 409);
  assertApiError(await activeAnalysisDelete.json() as CleanupResponse, "ANALYSIS_ACTIVE");
  assert.equal((await db.analysis.findUnique({ where: { id: activeAnalysis.id }, select: { deletionRequestedAt: true } }))?.deletionRequestedAt, null);

  const activeExportDelete = await apiDelete(api, activeExportAnalysis.id, { account: owner });
  assert.equal(activeExportDelete.status(), 409);
  assertApiError(await activeExportDelete.json() as CleanupResponse, "EXPORT_ACTIVE");
  assert.equal((await db.analysis.findUnique({ where: { id: activeExportAnalysis.id }, select: { deletionRequestedAt: true } }))?.deletionRequestedAt, null);
  checks.push("Live DELETE rejects anonymous, stale-account, off-origin, unknown-field, and foreign-owner requests with 401/403/400/404; active analysis and export fixtures return 409.");
  checks.push("Live cleanup-job reads are owner-only: foreign owner receives 200 while another account and anonymous caller receive 404 and 401.");

  phase = "history UI setup at 390px";
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: mobileViewport });
  await context.addCookies([{
    name: "sage_session",
    value: owner.token,
    url: browserOrigin.origin,
    httpOnly: true,
    sameSite: "Lax",
    secure: false,
  }]);
  await context.route("**/*", async route => {
    if (new URL(route.request().url()).origin !== browserOrigin.origin) {
      externalRequestsBlocked += 1;
      await route.abort();
    } else {
      await route.continue();
    }
  });
  page = await context.newPage();
  let deleteRequests = 0;
  page.on("request", requestEvent => {
    if (requestEvent.method() === "DELETE" && new URL(requestEvent.url()).pathname.startsWith("/api/analyses/")) deleteRequests += 1;
  });
  await page.goto(new URL("/workspace/history", browserOrigin).toString(), { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Riwayat analisis", exact: true }).waitFor({ state: "visible" });
  const parentDeleteLabel = `Hapus analisis ${parent.repositoryFullName}`;
  await historyRowForCommit(page, parent.commitSha).getByRole("button", { name: parentDeleteLabel, exact: true }).waitFor({ state: "visible" });
  await assertNoHorizontalOverflow(page);
  assert.equal(await page.getByText(foreignAnalysis.repositoryFullName, { exact: true }).count(), 0, "foreign analysis must not be listed in the owner history page");
  assert.equal(await page.getByRole("button", { name: `Hapus analisis ${activeAnalysis.repositoryFullName}`, exact: true }).isDisabled(), true);

  phase = "history confirmation cancel";
  await historyRowForCommit(page, parent.commitSha).getByRole("button", { name: parentDeleteLabel, exact: true }).click();
  const cancelDialog = page.getByRole("dialog");
  await cancelDialog.getByRole("heading", { name: `Hapus ${parent.repositoryFullName}?`, exact: true }).waitFor({ state: "visible" });
  await cancelDialog.getByRole("button", { name: "Batalkan", exact: true }).click();
  await cancelDialog.waitFor({ state: "hidden" });
  assert.equal(deleteRequests, 0, "cancel must not submit DELETE");
  assert.equal((await db.analysis.findUnique({ where: { id: parent.id }, select: { deletionRequestedAt: true } }))?.deletionRequestedAt, null);
  assert.equal(await db.job.count({ where: { ownerUserId: owner.userId, type: "CLEANUP", cleanupAnalysisId: parent.id } }), 0);
  assert.equal(await pathExists(parentWithArchive.archivePath!), true);
  await capture(page, "cleanup-390-confirm-cancelled.png");
  checks.push("At 390px, cancelling the accessible confirmation leaves the analysis row, cleanup queue, archive, and history entry intact.");

  phase = "real cleanup of a retry parent at 1440px";
  await page.setViewportSize(desktopViewport);
  await assertNoHorizontalOverflow(page);
  const parentResponse = await confirmDeleteFromHistory(page, parentDeleteLabel, parent.commitSha);
  assert.equal(parentResponse.status(), 202, "first accepted deletion returns an asynchronous cleanup job");
  const parentBody = await parentResponse.json() as CleanupResponse;
  assert.equal(parentBody.data?.analysisId, parent.id);
  assert.equal(parentBody.data?.accountKey, owner.accountKey);
  assert.ok(parentBody.data?.deletion?.jobId);
  const parentJobId = parentBody.data.deletion.jobId;
  observedCleanupJobs += 1;
  const completedParent = await waitForCleanupStatus(api, owner, parentJobId, "COMPLETED");
  assert.equal(completedParent.analysisId, parent.id);
  const parentJobRow = await db.job.findUnique({ where: { id: parentJobId }, select: { status: true, finishedAt: true, attempt: true, analysisId: true } });
  assert.equal(parentJobRow?.status, "COMPLETED");
  assert.ok(parentJobRow?.finishedAt);
  assert.equal(parentJobRow?.analysisId, null, "completed cleanup job retains its stable analysis ID without the deleted parent FK");
  assert.equal(await pathExists(join(storageRoot, parentWithArchive.folderName!)), false, "archive folder must be gone before/when the worker reports completion");
  assert.equal(await db.analysis.findUnique({ where: { id: parent.id } }), null, "cleanup removes the real parent analysis row");
  const survivingChild = await db.analysis.findUnique({ where: { id: child.id }, select: { id: true, retryParentId: true, ownerUserId: true } });
  assert.equal(survivingChild?.id, child.id, "retry child remains after parent deletion");
  assert.equal(survivingChild?.retryParentId, null, "retry child no longer points at the deleted parent");
  assert.equal(survivingChild?.ownerUserId, owner.userId);
  assert.equal(await db.sourceFile.count({ where: { ownerUserId: owner.userId, analysisId: parent.id } }), 0);
  assert.equal(await db.storageObject.count({ where: { ownerUserId: owner.userId, analysisId: parent.id } }), 0);
  assert.equal(await pathExists(parentArtifacts.exportPath), false, "registered Markdown export file must be removed");
  assert.equal(await pathExists(parentArtifacts.pendingPath), false, "reserved pending PDF file must be removed");
  assert.equal(await pathExists(join(storageRoot, parentArtifacts.exportFolderName)), false);
  assert.equal(await pathExists(join(storageRoot, parentArtifacts.pendingFolderName)), false);
  assert.equal(await db.graphBundle.count({ where: { ownerUserId: owner.userId, analysisId: parent.id } }), 0);
  assert.equal(await db.architectureDocument.count({ where: { ownerUserId: owner.userId, analysisId: parent.id } }), 0);
  assert.equal(await db.export.count({ where: { ownerUserId: owner.userId, analysisId: parent.id } }), 0);
  const repeatedDelete = await apiDelete(api, parent.id, { account: owner });
  assert.equal(repeatedDelete.status(), 204, "completed delete is idempotent");
  const parentDetail = await api.get(`/api/analyses/${parent.id}`, { headers: authHeaders(owner) });
  assert.equal(parentDetail.status(), 404, "deleted parent detail is no longer readable");
  await page.getByText(parent.commitSha.slice(0, 7), { exact: true }).waitFor({ state: "detached", timeout: 15_000 });
  await page.getByText(child.commitSha.slice(0, 7), { exact: true }).waitFor({ state: "visible" });
  await assertNoHorizontalOverflow(page);
  await capture(page, "cleanup-1440-parent-deleted-child-preserved.png");
  checks.push("The live cleanup worker removed source archive, registered Markdown export, reserved .pending export, source/graph/document/export rows, and the parent analysis before its job became COMPLETED; repeat DELETE returns 204 and the retry child remains visible with a null parent link.");

  phase = "real cleanup failure and retry from history UI";
  await page.setViewportSize(mobileViewport);
  const symlinkDeleteLabel = `Hapus analisis ${symlinkWithArchive.repositoryFullName}`;
  const symlinkResponse = await confirmDeleteFromHistory(page, symlinkDeleteLabel, symlinkWithArchive.commitSha);
  assert.equal(symlinkResponse.status(), 202);
  const symlinkBody = await symlinkResponse.json() as CleanupResponse;
  assert.ok(symlinkBody.data?.deletion?.jobId);
  const symlinkJobId = symlinkBody.data.deletion.jobId;
  observedCleanupJobs += 1;
  const failedCleanup = await waitForCleanupStatus(api, owner, symlinkJobId, "FAILED");
  assert.equal(failedCleanup.errorCode, "CLEANUP_FAILED");
  observedCleanupFailures += 1;
  assert.equal(await pathExists(symlinkWithArchive.archivePath!), true, "external archive reached through a symlink must be preserved");
  assert.deepEqual(await readFile(symlinkWithArchive.archivePath!), symlinkWithArchive.archiveBytes, "the outside archive bytes must remain unchanged after failed cleanup");
  assert.deepEqual(await readFile(outsideCanaryPath!), outsideCanaryBytes, "outside-neighbor canary bytes must remain unchanged after failed cleanup");
  assert.equal((await lstat(join(storageRoot, symlinkWithArchive.folderName!))).isSymbolicLink(), true, "failed cleanup leaves the unsafe link available for a safe retry");
  const retryButtonName = `Coba hapus lagi analisis ${symlinkWithArchive.repositoryFullName}`;
  await page.getByRole("button", { name: retryButtonName, exact: true }).waitFor({ state: "visible", timeout: 15_000 });
  await assertNoHorizontalOverflow(page);
  await capture(page, "cleanup-390-failed-retry-visible.png");

  phase = "repair symlink fixture and retry at 1440px";
  await unlink(join(storageRoot, symlinkWithArchive.folderName!));
  await mkdir(join(storageRoot, symlinkWithArchive.folderName!), { mode: 0o700 });
  await writeFile(symlinkWithArchive.archivePath!, symlinkWithArchive.archiveBytes!, { flag: "wx", mode: 0o600 });
  assert.equal(await pathExists(symlinkWithArchive.archivePath!), true);
  await page.setViewportSize(desktopViewport);
  await assertNoHorizontalOverflow(page);
  const retryResponse = await confirmDeleteFromHistory(page, retryButtonName, symlinkWithArchive.commitSha);
  assert.equal(retryResponse.status(), 202, "retry requeues the failed cleanup job");
  const retryBody = await retryResponse.json() as CleanupResponse;
  assert.equal(retryBody.data?.deletion?.jobId, symlinkJobId, "retry reuses the same durable cleanup job");
  observedCleanupRetries += 1;
  const retriedCleanup = await waitForCleanupStatus(api, owner, symlinkJobId, "COMPLETED");
  assert.equal(retriedCleanup.analysisId, symlinkWithArchive.id);
  assert.equal(await pathExists(join(storageRoot, symlinkWithArchive.folderName!)), false);
  assert.deepEqual(await readFile(join(outsideDirectory, "archive.tar.gz")), symlinkWithArchive.archiveBytes, "successful retry still leaves the outside archive untouched");
  assert.deepEqual(await readFile(outsideCanaryPath!), outsideCanaryBytes, "successful retry still leaves the outside-neighbor directory untouched");
  const retryJobRow = await db.job.findUnique({ where: { id: symlinkJobId }, select: { status: true, attempt: true, analysisId: true, cleanupAnalysisId: true } });
  assert.equal(retryJobRow?.status, "COMPLETED");
  assert.ok((retryJobRow?.attempt ?? 0) >= 2, "retry must run a second worker attempt");
  assert.equal(retryJobRow?.analysisId, null);
  assert.equal(retryJobRow?.cleanupAnalysisId, symlinkWithArchive.id);
  assert.equal(await db.analysis.findUnique({ where: { id: symlinkWithArchive.id } }), null);
  await page.getByText(symlinkWithArchive.commitSha.slice(0, 7), { exact: true }).waitFor({ state: "detached", timeout: 15_000 });
  await assertNoHorizontalOverflow(page);
  await capture(page, "cleanup-1440-retry-completed.png");
  checks.push("A symlinked registered snapshot key fails safely, keeps outside bytes intact, exposes the retry action, and succeeds through the real history retry flow after repair.");

  phase = "foreign fixture preservation and final HTTP reads";
  const foreignAnalysisAfterCleanup = await db.analysis.findUnique({ where: { id: foreignWithArchive.id }, select: { id: true, deletionRequestedAt: true } });
  assert.equal(foreignAnalysisAfterCleanup?.id, foreignWithArchive.id);
  assert.equal(foreignAnalysisAfterCleanup?.deletionRequestedAt, null);
  const foreignStorage = await db.storageObject.findFirst({ where: { ownerUserId: foreign.userId, analysisId: foreignWithArchive.id }, select: { status: true, storageKey: true } });
  assert.equal(foreignStorage?.status, "ACTIVE");
  assert.equal(foreignStorage?.storageKey, foreignWithArchive.storageKey);
  assert.deepEqual(await readFile(foreignWithArchive.archivePath!), foreignWithArchive.archiveBytes);
  assert.deepEqual(await readFile(outsideCanaryPath!), outsideCanaryBytes);
  checks.push("Foreign analysis, active storage metadata, archive bytes, and the outside-neighbor canary are unchanged after owner cleanup.");

  runSucceeded = true;
}

void run().catch(async error => {
  failed = true;
  const identity = safeErrorIdentity(error);
  failureName = identity.name;
  failureCode = identity.code;
  console.error(`Analysis cleanup live verification failed during ${phase} (errorName=${identity.name}${identity.code ? `, errorCode=${identity.code}` : ""}); data and credentials are omitted.`);
  if (page && screenshotDirectoryReady) {
    try {
      await page.screenshot({ path: join(artifactDirectory, "cleanup-failure.png"), fullPage: true });
      screenshots.push("cleanup-failure.png");
    } catch { /* best-effort screenshot; UI fixtures are synthetic */ }
  }
}).finally(async () => {
  if (!runSucceeded) failed = true;
  if (browser) await browser.close().catch(() => undefined);
  if (api) await api.dispose().catch(() => undefined);
  if (db) {
    try { await teardownFixtures(); }
    catch {
      failed = true;
      phase = "fixture teardown";
      console.error("Analysis cleanup fixture teardown failed; database details are omitted.");
    }
    await disconnectDatabase().catch(() => undefined);
  }
  try { await removeOwnedStorageFolders(); }
  catch {
    failed = true;
    phase = "temporary fixture cleanup";
    console.error("Analysis cleanup temporary fixture cleanup failed; filesystem details are omitted.");
  }

  const report = {
    checkedAt: new Date().toISOString(),
    status: failed ? "FAIL" : "PASS",
    checks,
    counts: {
      fixtureUsers: fixtureUserIds.length,
      fixtureAnalyses: fixtureAnalysisIds.length,
      cleanupJobsObserved: observedCleanupJobs,
      cleanupWorkerFailuresObserved: observedCleanupFailures,
      cleanupRetriesObserved: observedCleanupRetries,
      externalBrowserRequestsBlocked: externalRequestsBlocked,
    },
    screenshots,
    failedPhase: failed ? phase : null,
    failureName: failed ? failureName : null,
    failureCode: failed ? failureCode : null,
    scope: "Synthetic delete-only PostgreSQL fixtures, live Next routes, real cleanup worker, and Playwright history UI at 390px and 1440px.",
    limitations: [
      "The fixture archives and graph/document/export rows are synthetic and are not pipeline publication evidence.",
      "No GitHub OAuth flow, provider request, or analysis pipeline was executed.",
    ],
  };
  if (screenshotDirectoryReady) {
    try {
      await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    } catch {
      failed = true;
      console.error("Analysis cleanup report could not be saved; report contents omitted.");
    }
  }
  console.log(JSON.stringify({ ...report, status: failed ? "FAIL" : report.status }));
  if (failed) process.exitCode = 1;
});

