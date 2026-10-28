import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { ANALYSIS_STAGE_DEFINITIONS } from "@sage/contracts";
import { createSession, database, storeGitHubCredential } from "@sage/database";
import { chromium, type BrowserContext, type Page } from "playwright";

/**
 * Live issue-16 browser/API/worker regression. It uses disposable accounts in
 * the isolated `sage_pipeline16` database and requires the Next server and real
 * worker consumer to share that database and a private temporary STORAGE_ROOT.
 *
 * Run from the project root with the test-only provider fixture preloaded into
 * both Next and the worker:
 *   SAGE_PIPELINE_TESTS=1 DATABASE_URL=postgresql://sage@sage-pipeline16-db:5432/sage_pipeline16 \
 *   CREDENTIAL_ENCRYPTION_KEY=<test-only-32-byte-base64> STORAGE_ROOT=/tmp/sage-pipeline16-storage \
 *   SAGE_PIPELINE_BASE_URL=http://web:3000 npx tsx scripts/test-live-pipeline.ts
 *
 * Browser requests, production API routes, queue rows, worker stages, and
 * terminal result publication use the real app and PostgreSQL. Only GitHub's
 * exact private fixture repository/permission/archive responses are simulated
 * by scripts/helpers/pipeline-provider-fixture.mjs; it returns a 403 for the
 * denied fixture credential and delays archive bytes by four seconds so the
 * browser can observe RUNNING. One QUEUED row is directly seeded without a job
 * to exercise a held stale response without competing with the real consumer.
 */

type DisposableAccount = {
  userId: string;
  accountKey: string;
  token: string;
  sessionId: string;
  providerToken: string;
};

type AnalysisStatus = "QUEUED" | "RUNNING" | "COMPLETED" | "COMPLETED_WITH_LIMITATIONS" | "FAILED";
type ApiError = { error?: { code?: string; message?: string }; requestId?: string };
type ApiEnvelope<T> = { data?: T } & ApiError;
type QueuedResponse = { analysisId: string; jobId: string; configurationHash: string; commitSha: string; replayed?: true };

const enabled = process.env.SAGE_PIPELINE_TESTS === "1";
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const resultDir = resolve(projectRoot, "artifacts/pipeline-16");
const fixtureOwner = "sage-pipeline16-fixture";
const fixtureRepository = "private-sample";
const fixtureFullName = `${fixtureOwner}/${fixtureRepository}`;
const fixtureRepositoryId = "160016";
const fixtureCommit = "16".repeat(20);
const allowedProviderToken = "sage-pipeline16-provider-allowed";
const deniedProviderToken = "sage-pipeline16-provider-denied";
const fixtureConfiguration = {
  limitsVersion: 1,
  maxSourceFileBytes: 1_048_576,
  sourcePolicyVersion: "sage-source-policy-v1",
  version: 1,
};
const fixtureConfigurationHash = createHash("sha256").update(JSON.stringify(fixtureConfiguration)).digest("hex");

function requireDedicatedEnvironment(): { base: string; origin: string; storageRoot: string } {
  if (!enabled) throw new Error("Live pipeline browser test requires SAGE_PIPELINE_TESTS=1.");
  const rawDatabaseUrl = process.env.DATABASE_URL;
  if (!rawDatabaseUrl) throw new Error("DATABASE_URL is required when SAGE_PIPELINE_TESTS=1.");
  let databaseName: string;
  try {
    const databaseUrl = new URL(rawDatabaseUrl);
    if (databaseUrl.protocol !== "postgresql:" && databaseUrl.protocol !== "postgres:") throw new Error("protocol");
    databaseName = decodeURIComponent(databaseUrl.pathname.slice(1));
  } catch {
    throw new Error("DATABASE_URL must be a valid PostgreSQL URL; it was not logged.");
  }
  if (databaseName !== "sage_pipeline16") throw new Error("Live pipeline regression only allows the isolated sage_pipeline16 database.");

  const encryptionKey = process.env.CREDENTIAL_ENCRYPTION_KEY;
  if (!encryptionKey || !/^[A-Za-z0-9+/]{43}=$/.test(encryptionKey) || Buffer.from(encryptionKey, "base64").length !== 32 || Buffer.from(encryptionKey, "base64").toString("base64") !== encryptionKey) {
    throw new Error("CREDENTIAL_ENCRYPTION_KEY must be the test-only canonical base64 key shared with Next and the worker.");
  }

  const rawBase = process.env.SAGE_PIPELINE_BASE_URL ?? "http://127.0.0.1:3000";
  const baseUrl = new URL(rawBase);
  if (baseUrl.protocol !== "http:" || !["localhost", "127.0.0.1", "web"].includes(baseUrl.hostname)) {
    throw new Error("SAGE_PIPELINE_BASE_URL must use the loopback or internal web host over HTTP.");
  }
  const rawStorageRoot = process.env.STORAGE_ROOT;
  if (!rawStorageRoot || !isAbsolute(rawStorageRoot)) throw new Error("STORAGE_ROOT must be an absolute private temporary directory shared with the worker.");
  const storageRoot = resolve(rawStorageRoot);
  const tempRoots = [...new Set([resolve(tmpdir()), resolve("/tmp"), resolve("/var/tmp")])];
  if (tempRoots.every(root => storageRoot === root || !storageRoot.startsWith(`${root}${sep}`))) {
    throw new Error("Refusing to use STORAGE_ROOT outside a temporary directory.");
  }
  return { base: baseUrl.toString().replace(/\/$/, ""), origin: baseUrl.origin, storageRoot };
}

function cookie(account: DisposableAccount): { name: string; value: string; url: string; httpOnly: true; sameSite: "Lax" } {
  return { name: "sage_session", value: account.token, url: base, httpOnly: true, sameSite: "Lax" };
}

async function createAccount(
  db: ReturnType<typeof database>,
  label: string,
  providerToken: string,
  userIds: string[],
  sessionIds: string[],
): Promise<DisposableAccount> {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const accountKey = `pipeline16-${label}-${suffix}`;
  const user = await db.user.create({
    data: { githubUserId: accountKey, login: `pipeline16-${label}-${suffix}` },
    select: { id: true },
  });
  userIds.push(user.id);
  await storeGitHubCredential(db, user.id, {
    githubUserId: accountKey,
    githubLogin: fixtureOwner,
    accessToken: providerToken,
  });
  const created = await createSession(db, user.id, { ttlMs: 20 * 60 * 1000 });
  sessionIds.push(created.session.sessionId);
  return { userId: user.id, accountKey, token: created.token, sessionId: created.session.sessionId, providerToken };
}

function apiHeaders(account?: DisposableAccount, extra: HeadersInit = {}, origin?: string): Headers {
  const headers = new Headers(extra);
  if (account) {
    headers.set("Cookie", `sage_session=${account.token}`);
    headers.set("X-SAGE-Account", account.accountKey);
  }
  if (origin) headers.set("Origin", origin);
  return headers;
}

async function apiCall<T>(
  path: string,
  options: { account?: DisposableAccount; method?: string; body?: unknown; idempotencyKey?: string; origin?: string } = {},
): Promise<{ response: Response; body: ApiEnvelope<T> }> {
  const headers = apiHeaders(options.account, {
    ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
    ...(options.idempotencyKey ? { "Idempotency-Key": options.idempotencyKey } : {}),
  }, options.origin);
  const response = await fetch(new URL(path, base), {
    method: options.method ?? "GET",
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    redirect: "manual",
  });
  let body: ApiEnvelope<T>;
  try { body = await response.json() as ApiEnvelope<T>; }
  catch { body = {}; }
  return { response, body };
}

async function createFixtureRepository(db: ReturnType<typeof database>): Promise<{ id: string; created: boolean }> {
  const existing = await db.repository.findUnique({ where: { githubRepositoryId: fixtureRepositoryId }, select: { id: true } });
  const repository = await db.repository.upsert({
    where: { githubRepositoryId: fixtureRepositoryId },
    create: {
      githubRepositoryId: fixtureRepositoryId,
      ownerLogin: fixtureOwner,
      name: fixtureRepository,
      fullName: fixtureFullName,
      visibility: "PRIVATE",
      defaultBranch: "main",
      archived: false,
    },
    update: {
      ownerLogin: fixtureOwner,
      name: fixtureRepository,
      fullName: fixtureFullName,
      visibility: "PRIVATE",
      defaultBranch: "main",
      archived: false,
    },
    select: { id: true },
  });
  return { id: repository.id, created: existing === null };
}

async function seedAnalysis(
  db: ReturnType<typeof database>,
  input: {
    ownerUserId: string;
    repositoryId: string;
    status: AnalysisStatus;
    withFailedJob?: boolean;
    label: string;
  },
): Promise<string> {
  const now = new Date();
  const failedStageSequence = input.status === "FAILED" ? 3 : null;
  return db.$transaction(async tx => {
    let queueSequence: bigint | undefined;
    if (input.withFailedJob) {
      assert.equal(input.status, "FAILED");
      // A direct FAILED job still obeys the real queue schema. Reserve its
      // unique sequence and advance the singleton counter under the same lock
      // the consumer/enqueue path uses; FAILED rows are never claimable.
      await tx.$executeRaw`
        INSERT INTO "WorkerSlot" ("slotKey", "updatedAt", "lastEnqueueSequence")
        VALUES ('analysis', clock_timestamp(), COALESCE((SELECT MAX("queueSequence") FROM "Job" WHERE "type" = 'ANALYSIS'), 0))
        ON CONFLICT ("slotKey") DO NOTHING
      `;
      const slots = await tx.$queryRaw<Array<{ lastEnqueueSequence: bigint }>>`
        SELECT "lastEnqueueSequence" FROM "WorkerSlot" WHERE "slotKey" = 'analysis' FOR UPDATE
      `;
      assert.equal(slots.length, 1, "the isolated worker slot exists before inserting the failed fixture job");
      queueSequence = slots[0]!.lastEnqueueSequence + 1n;
      await tx.$executeRaw`
        UPDATE "WorkerSlot" SET "lastEnqueueSequence" = ${queueSequence}, "updatedAt" = clock_timestamp()
        WHERE "slotKey" = 'analysis'
      `;
    }

    const analysis = await tx.analysis.create({
      data: {
        ownerUserId: input.ownerUserId,
        repositoryId: input.repositoryId,
        repositoryFullNameSnapshot: fixtureFullName,
        branchName: "main",
        commitSha: fixtureCommit,
        configuration: fixtureConfiguration,
        configurationHash: fixtureConfigurationHash,
        analyzerVersion: "declarations-v1",
        schemaVersion: "1",
        status: input.status,
        errorCode: input.status === "FAILED" ? "PARSE_FAILED" : null,
        queuedAt: now,
        startedAt: input.status === "RUNNING" || input.status === "FAILED" || input.status === "COMPLETED" || input.status === "COMPLETED_WITH_LIMITATIONS" ? now : null,
        completedAt: input.status === "FAILED" || input.status === "COMPLETED" || input.status === "COMPLETED_WITH_LIMITATIONS" ? now : null,
      },
      select: { id: true },
    });
    const stageRows = ANALYSIS_STAGE_DEFINITIONS.map(stage => {
      const failed = stage.sequence === failedStageSequence;
      const running = input.status === "RUNNING" && stage.sequence === 1;
      const completed = input.status === "COMPLETED" || input.status === "COMPLETED_WITH_LIMITATIONS";
      return {
        analysisId: analysis.id,
        ownerUserId: input.ownerUserId,
        sequence: stage.sequence,
        key: stage.key,
        status: failed ? "FAILED" as const : running ? "RUNNING" as const : completed ? "COMPLETED" as const : "PENDING" as const,
        startedAt: failed || running || completed ? now : null,
        finishedAt: failed || completed ? now : null,
        errorCode: failed ? "PARSE_FAILED" : null,
      };
    });
    await tx.analysisStage.createMany({ data: stageRows });
    if (input.withFailedJob) {
      assert.ok(queueSequence !== undefined);
      await tx.job.create({
        data: {
          ownerUserId: input.ownerUserId,
          analysisId: analysis.id,
          type: "ANALYSIS",
          status: "FAILED",
          queueSequence,
          errorCode: "PARSE_FAILED",
          startedAt: now,
          finishedAt: now,
        },
      });
    }
    return analysis.id;
  });
}

async function waitForTerminalAnalysis(db: ReturnType<typeof database>, analysisId: string, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const analysis = await db.analysis.findUnique({
      where: { id: analysisId },
      select: {
        status: true,
        errorCode: true,
        completedAt: true,
        resultHash: true,
        stages: { orderBy: { sequence: "asc" }, select: { key: true, status: true, errorCode: true } },
        limitations: { select: { stageKey: true, code: true } },
        sourceFiles: { select: { path: true, language: true, processingStatus: true } },
        graphBundle: { select: { nodeCount: true, edgeCount: true, contentHash: true } },
        architectureDocument: { select: { contentHash: true } },
        jobs: { where: { type: "ANALYSIS" }, take: 1, select: { status: true, errorCode: true, attempt: true } },
      },
    });
    assert.ok(analysis, "analysis row remains present while worker runs");
    if (analysis.status === "COMPLETED" || analysis.status === "COMPLETED_WITH_LIMITATIONS" || analysis.status === "FAILED") return analysis;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`Worker did not reach a terminal state within ${timeoutMs} ms (${analysisId}).`);
}

async function waitForPageText(page: Page, pattern: RegExp, timeoutMs = 180_000): Promise<void> {
  await page.getByText(pattern).first().waitFor({ state: "visible", timeout: timeoutMs });
}

async function installSession(context: BrowserContext, account: DisposableAccount): Promise<void> {
  await context.addCookies([cookie(account)]);
}

async function selectFixtureRepository(page: Page): Promise<void> {
  await page.goto(`${base}/workspace/repositories`, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Pilih repository", exact: true }).waitFor();
  await page.getByRole("button", { name: fixtureOwner, exact: true }).waitFor();
  await page.getByRole("button", { name: fixtureOwner, exact: true }).click();
  await page.getByRole("button", { name: "Pilih repository", exact: true }).last().waitFor();
  await page.getByRole("button", { name: "Pilih repository", exact: true }).last().click();
  await page.getByRole("heading", { name: `Siapkan analisis: ${fixtureFullName}`, exact: true }).waitFor();
  await page.waitForFunction(() => {
    const heading = document.querySelector<HTMLElement>("#analysis-target-heading");
    return document.activeElement === heading && Boolean(heading && heading.getBoundingClientRect().top >= 0 && heading.getBoundingClientRect().top < innerHeight);
  });
  await page.getByLabel("Branch", { exact: true }).locator('option[value="main"]').waitFor({ state: "attached" });
}

async function deleteOwnedFixtures(
  db: ReturnType<typeof database>,
  input: { analysisIds: string[]; userIds: string[]; repositoryId: string; repositoryCreated: boolean; storageRoot: string },
): Promise<void> {
  const userOwnedRows = input.userIds.length
    ? await db.analysis.findMany({ where: { ownerUserId: { in: input.userIds } }, select: { id: true, retryParentId: true } })
    : [];
  const uniqueAnalysisIds = [...new Set([...input.analysisIds, ...userOwnedRows.map(row => row.id)])];
  if (uniqueAnalysisIds.length) {
    const activeJobs = await db.job.findMany({
      where: { analysisId: { in: uniqueAnalysisIds }, type: "ANALYSIS", status: { in: ["QUEUED", "RUNNING"] } },
      select: { analysisId: true, status: true },
    });
    if (activeJobs.length) {
      throw new Error(`Refusing cleanup while ${activeJobs.length} fixture analysis job(s) are queued or running.`);
    }
    const rows = await db.analysis.findMany({ where: { id: { in: uniqueAnalysisIds } }, select: { id: true, retryParentId: true } });
    const childIds = rows.filter(row => row.retryParentId && uniqueAnalysisIds.includes(row.retryParentId)).map(row => row.id);
    const parentIds = rows.filter(row => !row.retryParentId || !uniqueAnalysisIds.includes(row.retryParentId)).map(row => row.id);
    const storageObjects = await db.storageObject.findMany({ where: { analysisId: { in: uniqueAnalysisIds } }, select: { storageKey: true } });
    await db.job.deleteMany({ where: { analysisId: { in: uniqueAnalysisIds } } });
    if (childIds.length) await db.analysis.deleteMany({ where: { id: { in: childIds } } });
    if (parentIds.length) await db.analysis.deleteMany({ where: { id: { in: parentIds } } });
    for (const item of storageObjects) {
      if (!/^snapshot-[A-Za-z0-9]{6}\/archive\.tar\.gz$/.test(item.storageKey)) continue;
      const folder = item.storageKey.split("/")[0]!;
      const target = resolve(input.storageRoot, folder);
      if (!target.startsWith(`${resolve(input.storageRoot)}${sep}`)) continue;
      try {
        const stat = await lstat(target);
        if (stat.isDirectory() && !stat.isSymbolicLink()) await rm(target, { recursive: true, force: true });
      } catch { /* The worker may already have removed a failed snapshot folder. */ }
    }
  }
  if (input.userIds.length) await db.user.deleteMany({ where: { id: { in: input.userIds } } });
  if (input.repositoryCreated) {
    const remaining = await db.analysis.count({ where: { repositoryId: input.repositoryId } });
    if (remaining === 0) await db.repository.deleteMany({ where: { id: input.repositoryId } });
  }
}

async function runLivePipelineRegression(): Promise<void> {
  const environment = requireDedicatedEnvironment();
  base = environment.base;
  origin = environment.origin;
  storageRoot = environment.storageRoot;
  await mkdir(resultDir, { recursive: true });

  const db = database();
  const userIds: string[] = [];
  const sessionIds: string[] = [];
  const analysisIds: string[] = [];
  const checks: string[] = [];
  const failures: string[] = [];
  const emittedScreenshots: string[] = [];
  const pageErrors: string[] = [];
  const providerBoundary = "GitHub is simulated only for the exact private fixture repository, its fixture account's empty public-repository listing, and two exact synthetic credentials; all product API, browser, PostgreSQL, worker, and result reads are real.";
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let owner: DisposableAccount | undefined;
  let denied: DisposableAccount | undefined;
  let repositoryId = "";
  let repositoryCreated = false;
  let cleanupSafe = true;
  let reportStatus: "PASS" | "FAIL" = "PASS";
  let reportError: string | undefined;
  let phase = "storage-fixture-setup";
  let mainAnalysisId: string | undefined;
  let retryAnalysisId: string | undefined;
  let mainSummary: Record<string, unknown> | undefined;
  let retrySummary: Record<string, unknown> | undefined;
  const releaseHeldResponses: Array<() => void> = [];

  try {
    const storageStat = await lstat(storageRoot).catch(() => null);
    if (storageStat && (!storageStat.isDirectory() || storageStat.isSymbolicLink())) throw new Error("STORAGE_ROOT must be a real directory, not a symlink.");
    await mkdir(storageRoot, { recursive: true, mode: 0o700 });
    const privateStorage = await lstat(storageRoot);
    if (!privateStorage.isDirectory() || privateStorage.isSymbolicLink()) throw new Error("STORAGE_ROOT must be a real directory, not a symlink.");
    if (process.platform !== "win32" && (privateStorage.mode & 0o077) !== 0) throw new Error("STORAGE_ROOT must have private permissions (0700).");

    const repository = await createFixtureRepository(db);
    repositoryId = repository.id;
    repositoryCreated = repository.created;
    owner = await createAccount(db, "owner", allowedProviderToken, userIds, sessionIds);
    denied = await createAccount(db, "denied", deniedProviderToken, userIds, sessionIds);

    const auth = await apiCall<{ accountKey: string; login: string }>("/api/auth/session", { account: owner });
    assert.equal(auth.response.status, 200, "server-seeded session authenticates against the live API");
    assert.equal(auth.body.data?.accountKey, owner.accountKey);
    checks.push("real Next auth-session route accepts a disposable encrypted-credential session");

    phase = "auth-and-scope-prechecks";
    const noSession = await apiCall("/api/analyses");
    assert.equal(noSession.response.status, 401, "history/submission API rejects missing sessions");
    checks.push("real API rejects unauthenticated history reads");

    const parentOwnerId = await seedAnalysis(db, { ownerUserId: owner.userId, repositoryId, status: "FAILED", withFailedJob: true, label: "owner-retry-parent" });
    analysisIds.push(parentOwnerId);
    const parentDeniedId = await seedAnalysis(db, { ownerUserId: denied.userId, repositoryId, status: "FAILED", withFailedJob: true, label: "denied-retry-parent" });
    analysisIds.push(parentDeniedId);
    const raceAnalysisId = await seedAnalysis(db, { ownerUserId: owner.userId, repositoryId, status: "QUEUED", label: "held-account-switch-race" });
    analysisIds.push(raceAnalysisId);

    const foreignDetail = await apiCall(`/api/analyses/${parentOwnerId}`, { account: denied });
    assert.equal(foreignDetail.response.status, 404, "other account cannot read the failed parent's progress");
    const foreignRetry = await apiCall(`/api/analyses/${parentOwnerId}/retry`, {
      account: denied, method: "POST", body: {}, idempotencyKey: `pipeline16-cross-${randomUUID().replaceAll("-", "")}`, origin,
    });
    assert.equal(foreignRetry.response.status, 404, "other account cannot retry the failed parent");
    checks.push("owner-scoped API hides another account's detail and retry target");

    phase = "retry-provider-denial-api-precheck";
    const deniedBefore = await db.analysis.count({ where: { ownerUserId: denied.userId } });
    const deniedApi = await apiCall<QueuedResponse>(`/api/analyses/${parentDeniedId}/retry`, {
      account: denied, method: "POST", body: {}, idempotencyKey: `pipeline16-denied-${randomUUID().replaceAll("-", "")}`, origin,
    });
    assert.equal(deniedApi.response.status, 403, "retry rechecks the current provider permission");
    assert.equal(await db.analysis.count({ where: { ownerUserId: denied.userId } }), deniedBefore, "provider denial never enqueues a replacement");
    checks.push("retry permission denial is a real API 403 from the controlled synthetic provider boundary and creates no analysis row");

    browser = await chromium.launch({ headless: true });
    phase = "target-account-switch-race";
    const targetRaceContext = await browser.newContext({ viewport: { width: 390, height: 1000 }, reducedMotion: "reduce" });
    await installSession(targetRaceContext, owner);
    const targetRacePage = await targetRaceContext.newPage();
    targetRacePage.setDefaultTimeout(20_000);
    targetRacePage.on("pageerror", error => pageErrors.push(`target account switch race: ${error.message}`));
    let releaseStaleTarget = () => {};
    let resolveTargetResponseReady = () => {};
    let resolveTargetResponseDone = () => {};
    const staleTargetGate = new Promise<void>(resolve => { releaseStaleTarget = resolve; });
    releaseHeldResponses.push(releaseStaleTarget);
    const targetApiReady = new Promise<void>(resolve => { resolveTargetResponseReady = resolve; });
    const targetResponseDone = new Promise<void>(resolve => { resolveTargetResponseDone = resolve; });
    let targetApiStatus = 0;
    let holdTargetResponse = true;
    await targetRacePage.route("**/api/repositories/target", async route => {
      if (!holdTargetResponse) return route.continue();
      holdTargetResponse = false;
      try {
        const actual = await route.fetch();
        targetApiStatus = actual.status();
        resolveTargetResponseReady();
        await staleTargetGate;
        try { await route.fulfill({ response: actual }); }
        catch { /* The identity reload can abort the request; both outcomes must hide the stale target. */ }
      } finally {
        resolveTargetResponseReady();
        resolveTargetResponseDone();
      }
    });
    await selectFixtureRepository(targetRacePage);
    await targetRacePage.getByLabel("Commit (opsional)", { exact: true }).fill(fixtureCommit);
    const targetIdentityMismatch = targetRacePage.waitForResponse(response => {
      const url = new URL(response.url());
      return url.pathname === "/api/auth/session" && response.status() === 401
        && response.request().headers()["x-sage-account"] === owner!.accountKey;
    });
    const targetPostRequest = targetRacePage.waitForRequest(request => new URL(request.url()).pathname === "/api/repositories/target" && request.method() === "POST");
    const targetNavigation = targetRacePage.waitForNavigation({ waitUntil: "domcontentloaded" });
    await targetRacePage.getByRole("button", { name: "Periksa target", exact: true }).click();
    await targetPostRequest;
    await targetApiReady;
    assert.equal(targetApiStatus, 200, "held target validation comes from the real API and fixture provider response");
    await targetRaceContext.addCookies([cookie(denied)]);
    releaseStaleTarget();
    const [targetMismatch] = await Promise.all([targetIdentityMismatch, targetNavigation, targetResponseDone]);
    assert.equal(targetMismatch.status(), 401, "the response's fresh identity check sees account B instead of page account A");
    await targetRacePage.getByRole("heading", { name: "Pilih repository", exact: true }).waitFor();
    const targetRaceBody = await targetRacePage.locator("body").innerText();
    assert.ok(!targetRaceBody.includes("Target tervalidasi"), "account B never receives the delayed account-A validation result");
    assert.ok(!targetRaceBody.includes(fixtureCommit), "account B never sees the delayed account-A commit");
    await targetRacePage.screenshot({ path: join(resultDir, "account-switch-stale-target.png"), fullPage: true });
    emittedScreenshots.push("account-switch-stale-target.png");
    await targetRaceContext.close();
    checks.push("changing A→B while the real target-validation API response is held triggers the fresh account check and hides the stale validated target");

    phase = "main-browser-target-selection-and-validation";
    const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, reducedMotion: "reduce" });
    await installSession(context, owner);
    const page = await context.newPage();
    page.setDefaultTimeout(20_000);
    page.on("pageerror", error => pageErrors.push(error.message));
    const progressObservations: Array<{ status: string; stages: string[] }> = [];
    let detailRequestCount = 0;
    page.on("request", request => {
      const url = new URL(request.url());
      if (mainAnalysisId && url.pathname === `/api/analyses/${mainAnalysisId}` && request.method() === "GET") detailRequestCount++;
    });
    page.on("response", async response => {
      const url = new URL(response.url());
      if (!mainAnalysisId || url.pathname !== `/api/analyses/${mainAnalysisId}` || response.request().method() !== "GET") return;
      try {
        const payload = await response.json() as ApiEnvelope<{ status: string; stages: Array<{ status: string }> }>;
        if (payload.data) progressObservations.push({ status: payload.data.status, stages: payload.data.stages.map(stage => stage.status) });
      } catch { /* Response may be cancelled by a navigation. */ }
    });

    await selectFixtureRepository(page);
    assert.equal(await page.getByLabel("Branch", { exact: true }).inputValue(), "main");
    await page.getByLabel("Commit (opsional)", { exact: true }).fill(fixtureCommit);

    const targetValidation = page.waitForResponse(response => new URL(response.url()).pathname === "/api/repositories/target" && response.request().method() === "POST");
    await page.getByRole("button", { name: "Periksa target", exact: true }).click();
    const targetValidationResponse = await targetValidation;
    assert.equal(targetValidationResponse.status(), 200, "the selected repository branch must be checked by the live target API");
    await page.getByText("Target tervalidasi", { exact: true }).waitFor();
    assert.ok((await page.locator("body").innerText()).includes(fixtureCommit), "UI shows the full immutable commit resolved by GitHub API behavior");

    phase = "main-browser-submission-and-live-queue-record";
    const repositoryRequest = page.waitForRequest(request => new URL(request.url()).pathname === "/api/analyses" && request.method() === "POST");
    const repositoryPost = page.waitForResponse(response => new URL(response.url()).pathname === "/api/analyses" && response.request().method() === "POST");
    await page.getByRole("button", { name: "Mulai analisis", exact: true }).click();
    const [submissionRequest, submissionResponse] = await Promise.all([repositoryRequest, repositoryPost]);
    assert.equal(submissionResponse.status(), 202, "the real UI submission must create a queued analysis through Next");
    const submissionBody = await submissionResponse.json() as ApiEnvelope<QueuedResponse>;
    assert.ok(submissionBody.data?.analysisId);
    const submissionKey = submissionRequest.headers()["idempotency-key"];
    assert.match(submissionKey ?? "", /^[A-Za-z0-9_-]{16,128}$/);
    const submittedPayload = submissionRequest.postDataJSON() as { repository?: string; branch?: string; commit?: string };
    assert.deepEqual(submittedPayload, { repository: fixtureFullName, branch: "main", commit: fixtureCommit });
    mainAnalysisId = submissionBody.data.analysisId;
    analysisIds.push(mainAnalysisId);
    await page.waitForURL(`${base}/analyses/${mainAnalysisId}`);
    assert.equal(new URL(page.url()).pathname, `/analyses/${mainAnalysisId}`, "successful submission redirects to live analysis progress");
    await page.getByRole("heading", { name: fixtureFullName, exact: true }).waitFor();
    const elapsedTimer = page.getByRole("timer");
    await elapsedTimer.waitFor();
    const firstElapsedValue = await elapsedTimer.locator("strong").innerText();
    assert.match(firstElapsedValue, /^\d{2,}:\d{2}:\d{2}$/);
    await page.waitForFunction(previous => {
      const value = document.querySelector('[role="timer"] strong')?.textContent;
      return Boolean(value && value !== previous);
    }, firstElapsedValue, { timeout: 5000 });
    const submitted = await db.analysis.findUnique({
      where: { id: mainAnalysisId },
      select: { ownerUserId: true, repositoryId: true, repositoryFullNameSnapshot: true, branchName: true, commitSha: true, configurationHash: true, status: true, jobs: { where: { type: "ANALYSIS" }, select: { id: true, status: true } } },
    });
    assert.ok(submitted);
    assert.equal(submitted.ownerUserId, owner.userId);
    assert.equal(submitted.repositoryId, repositoryId);
    assert.equal(submitted.repositoryFullNameSnapshot, fixtureFullName);
    assert.equal(submitted.branchName, "main");
    assert.equal(submitted.commitSha, fixtureCommit);
    assert.ok(["QUEUED", "RUNNING", "COMPLETED", "COMPLETED_WITH_LIMITATIONS"].includes(submitted.status), "worker may claim and finish the queue row immediately after live submission");
    assert.equal(submitted.jobs.length, 1);
    checks.push("production repository UI validates the selected private target, focuses the compact target step, shows advancing elapsed time, and POSTs a real idempotent analysis job to PostgreSQL");

    const replay = await apiCall<QueuedResponse>("/api/analyses", {
      account: owner, method: "POST", body: submittedPayload, idempotencyKey: submissionKey, origin,
    });
    assert.equal(replay.response.status, 200, "replaying the exact browser submission key should return its existing record");
    assert.equal(replay.body.data?.analysisId, mainAnalysisId);
    assert.equal(replay.body.data?.replayed, true);
    checks.push("exact browser submission key safely replays the same queued PostgreSQL analysis instead of creating a duplicate");

    phase = "main-worker-terminal-publication-and-browser-polling";
    const mainTerminal = await waitForTerminalAnalysis(db, mainAnalysisId);
    assert.notEqual(mainTerminal.status, "FAILED", `the real worker must publish successful fixture results (error ${mainTerminal.errorCode ?? "none"})`);
    assert.equal(mainTerminal.status, "COMPLETED_WITH_LIMITATIONS", "the PHP/TypeScript fixture and omitted submodule should produce an explicit partial result");
    assert.match(mainTerminal.resultHash ?? "", /^[a-f0-9]{64}$/);
    assert.ok(mainTerminal.graphBundle && mainTerminal.graphBundle.nodeCount > 0, "worker publishes a non-empty canonical graph");
    assert.ok(mainTerminal.architectureDocument, "worker publishes its architecture document");
    assert.equal(mainTerminal.stages.length, ANALYSIS_STAGE_DEFINITIONS.length);
    assert.ok(mainTerminal.stages.every(stage => stage.status === "COMPLETED"));
    assert.ok(mainTerminal.limitations.length > 0, "partial result explains its limitations");
    assert.ok(mainTerminal.limitations.some(item => item.code === "MODEL_LIMITATIONS"), "publication aggregates model and snapshot limitations into the safe summary code");
    assert.ok(mainTerminal.sourceFiles.some(file => file.language?.toLowerCase() === "typescript"));
    assert.ok(mainTerminal.sourceFiles.some(file => file.language?.toLowerCase() === "php"));
    const publishedGraph = await apiCall<{
      analysisId: string;
      ckgSha256: string;
      limitations: Array<{ path: string | null; reason: string; stage: string }>;
    }>(`/api/analyses/${mainAnalysisId}/graph`, { account: owner });
    assert.equal(publishedGraph.response.status, 200, "the completed graph is readable through the real owner-bound graph API");
    assert.equal(publishedGraph.body.data?.analysisId, mainAnalysisId);
    assert.equal(publishedGraph.body.data?.ckgSha256, mainTerminal.graphBundle.contentHash);
    assert.ok(publishedGraph.body.data?.limitations.some(item => item.reason === "SUBMODULE_CONTENTS_NOT_INCLUDED"), "the canonical graph API retains the exact snapshot limitation reason");
    mainSummary = {
      status: mainTerminal.status,
      resultHash: mainTerminal.resultHash,
      completedStages: mainTerminal.stages.filter(stage => stage.status === "COMPLETED").length,
      graphNodeCount: mainTerminal.graphBundle.nodeCount,
      graphEdgeCount: mainTerminal.graphBundle.edgeCount,
      architectureDocumentHash: mainTerminal.architectureDocument.contentHash,
      languages: [...new Set(mainTerminal.sourceFiles.map(file => file.language).filter((language): language is string => Boolean(language)))],
      limitationCount: mainTerminal.limitations.length,
    };
    await waitForPageText(page, /Selesai dengan batasan/);
    assert.ok(await page.getByRole("link", { name: /knowledge graph/i }).count());
    assert.ok(await page.getByRole("link", { name: /dokumentasi/i }).count());
    const terminalDetailReads = detailRequestCount;
    await page.waitForTimeout(3_600);
    assert.equal(detailRequestCount, terminalDetailReads, "terminal detail page stops its polling interval");
    assert.ok(progressObservations.some(item => item.status === "RUNNING"), "real API polling must observe the worker's RUNNING status");
    assert.ok(progressObservations.some(item => item.status === "COMPLETED_WITH_LIMITATIONS"), "polling must apply the terminal status published by the worker");
    checks.push("browser polls the real PostgreSQL progress API through RUNNING and COMPLETED_WITH_LIMITATIONS, shows graph/document results, and stops after terminal state");
    await page.screenshot({ path: join(resultDir, "pipeline-complete.png"), fullPage: true });
    emittedScreenshots.push("pipeline-complete.png");

    phase = "failed-parent-retry-ui-and-replay";
    const failedParent = await db.analysis.findUnique({ where: { id: parentOwnerId }, select: { id: true, configuration: true, configurationHash: true, commitSha: true, branchName: true, status: true } });
    assert.ok(failedParent);
    const retryPageContext = await browser.newContext({ viewport: { width: 1280, height: 1000 }, reducedMotion: "reduce" });
    await installSession(retryPageContext, owner);
    const retryPage = await retryPageContext.newPage();
    retryPage.setDefaultTimeout(20_000);
    retryPage.on("pageerror", error => pageErrors.push(`retry UI: ${error.message}`));
    await retryPage.goto(`${base}/analyses/${parentOwnerId}`, { waitUntil: "domcontentloaded" });
    await retryPage.getByRole("alert").filter({ hasText: /analisis gagal|analisis berhenti/i }).waitFor();
    const retryRequest = retryPage.waitForRequest(request => new URL(request.url()).pathname === `/api/analyses/${parentOwnerId}/retry` && request.method() === "POST");
    const retryResponse = retryPage.waitForResponse(response => new URL(response.url()).pathname === `/api/analyses/${parentOwnerId}/retry` && response.request().method() === "POST");
    await retryPage.getByRole("button", { name: /coba lagi|ulangi|retry/i }).click();
    const retryHttpRequest = await retryRequest;
    const retryHttpResponse = await retryResponse;
    assert.equal(retryHttpResponse.status(), 202, "the retry control creates a new analysis through the real retry endpoint");
    const retryBody = await retryHttpResponse.json() as ApiEnvelope<QueuedResponse>;
    assert.ok(retryBody.data?.analysisId);
    retryAnalysisId = retryBody.data.analysisId;
    analysisIds.push(retryAnalysisId);
    assert.notEqual(retryAnalysisId, parentOwnerId);
    const retryIdempotencyKey = retryHttpRequest.headers()["idempotency-key"];
    assert.match(retryIdempotencyKey ?? "", /^[A-Za-z0-9_-]{16,128}$/);
    await retryPage.waitForURL(`${base}/analyses/${retryAnalysisId}`);
    const retryChild = await db.analysis.findUnique({
      where: { id: retryAnalysisId },
      select: { ownerUserId: true, retryParentId: true, commitSha: true, branchName: true, configuration: true, configurationHash: true, status: true },
    });
    assert.ok(retryChild);
    assert.equal(retryChild.ownerUserId, owner.userId);
    assert.equal(retryChild.retryParentId, parentOwnerId);
    assert.equal(retryChild.commitSha, failedParent.commitSha, "retry keeps the failed full SHA");
    assert.equal(retryChild.branchName, failedParent.branchName);
    assert.deepEqual(retryChild.configuration, failedParent.configuration, "retry keeps the exact stored configuration");
    assert.equal(retryChild.configurationHash, failedParent.configurationHash, "retry keeps the same configuration hash");
    assert.equal(await db.analysis.count({ where: { ownerUserId: owner.userId, retryParentId: parentOwnerId } }), 1);
    const retryReplay = await apiCall<QueuedResponse>(`/api/analyses/${parentOwnerId}/retry`, {
      account: owner, method: "POST", body: {}, idempotencyKey: retryIdempotencyKey, origin,
    });
    assert.equal(retryReplay.response.status, 200, "repeating the exact UI retry key replays its replacement");
    assert.equal(retryReplay.body.data?.analysisId, retryAnalysisId);
    assert.equal(retryReplay.body.data?.replayed, true);
    checks.push("failed-detail retry creates a distinct child with the same full SHA/configuration, rechecks simulated provider permission, and exact-key replay returns that child");
    await retryPage.screenshot({ path: join(resultDir, "retry-progress.png"), fullPage: true });
    emittedScreenshots.push("retry-progress.png");
    await retryPageContext.close();

    phase = "retry-preflight-response-unmount-race";
    const preflightContext = await browser.newContext({ viewport: { width: 1280, height: 1000 }, reducedMotion: "reduce" });
    await installSession(preflightContext, owner);
    const preflightPage = await preflightContext.newPage();
    preflightPage.setDefaultTimeout(20_000);
    preflightPage.on("pageerror", error => pageErrors.push(`retry preflight race: ${error.message}`));
    let holdNextPreflightResponse = false;
    let releasePreflightResponse = () => {};
    let resolvePreflightReady = () => {};
    let resolvePreflightDone = () => {};
    let preflightStatus = 0;
    const preflightGate = new Promise<void>(resolve => { releasePreflightResponse = resolve; });
    releaseHeldResponses.push(releasePreflightResponse);
    const preflightReady = new Promise<void>(resolve => { resolvePreflightReady = resolve; });
    const preflightDone = new Promise<void>(resolve => { resolvePreflightDone = resolve; });
    await preflightPage.route("**/api/auth/session", async route => {
      if (!holdNextPreflightResponse || route.request().headers()["x-sage-account"] !== owner!.accountKey) return route.continue();
      holdNextPreflightResponse = false;
      try {
        const actual = await route.fetch();
        preflightStatus = actual.status();
        resolvePreflightReady();
        await preflightGate;
        try { await route.fulfill({ response: actual }); }
        catch { /* The route response may finish after the detail page unmounts. */ }
      } finally {
        resolvePreflightReady();
        resolvePreflightDone();
      }
    });
    const initialIdentityCheck = preflightPage.waitForResponse(response => {
      const url = new URL(response.url());
      return url.pathname === "/api/auth/session" && response.request().headers()["x-sage-account"] === owner!.accountKey;
    });
    await preflightPage.goto(`${base}/analyses/${parentOwnerId}`, { waitUntil: "domcontentloaded" });
    assert.equal((await initialIdentityCheck).status(), 200, "the failed detail page completes its initial owner session check before the retry race");
    await preflightPage.getByRole("button", { name: /coba lagi|ulangi|retry/i }).waitFor();
    await preflightPage.waitForLoadState("networkidle");
    holdNextPreflightResponse = true;
    let preflightRetryPostCount = 0;
    preflightPage.on("request", request => {
      if (new URL(request.url()).pathname === `/api/analyses/${parentOwnerId}/retry` && request.method() === "POST") preflightRetryPostCount += 1;
    });
    await preflightPage.getByRole("button", { name: /coba lagi|ulangi|retry/i }).click();
    await preflightReady;
    assert.equal(preflightStatus, 200, "held retry preflight session response comes from the real auth API");
    await preflightPage.locator('[class*="breadcrumb"]').getByRole("link", { name: "Riwayat", exact: true }).click();
    await preflightPage.waitForURL(`${base}/workspace/history`);
    await preflightPage.getByRole("heading", { name: "Riwayat analisis", exact: true }).waitFor();
    const unexpectedRetryPost = preflightPage.waitForRequest(
      request => new URL(request.url()).pathname === `/api/analyses/${parentOwnerId}/retry` && request.method() === "POST",
      { timeout: 1_500 },
    ).then(() => true, () => false);
    releasePreflightResponse();
    await preflightDone;
    assert.equal(await unexpectedRetryPost, false, "a successful preflight response consumed after unmount does not send a retry POST");
    assert.equal(preflightRetryPostCount, 0, "the delayed preflight response cannot enqueue after navigating to history");
    assert.equal(new URL(preflightPage.url()).pathname, "/workspace/history");
    assert.equal(await db.analysis.count({ where: { ownerUserId: owner.userId, retryParentId: parentOwnerId } }), 1, "preflight unmount creates no second retry child");
    await preflightContext.close();
    checks.push("navigating to history while retry preflight session is held prevents the unmounted detail action from posting a retry");

    phase = "retry-success-response-unmount-race";
    const delayedRetryContext = await browser.newContext({ viewport: { width: 1280, height: 1000 }, reducedMotion: "reduce" });
    await installSession(delayedRetryContext, owner);
    const delayedRetryPage = await delayedRetryContext.newPage();
    delayedRetryPage.setDefaultTimeout(20_000);
    delayedRetryPage.on("pageerror", error => pageErrors.push(`retry response race: ${error.message}`));
    let holdSuccessfulRetryResponse = true;
    let releaseSuccessfulRetryResponse = () => {};
    let resolveSuccessfulRetryReady = () => {};
    let resolveSuccessfulRetryDone = () => {};
    let successfulRetryStatus = 0;
    const successfulRetryGate = new Promise<void>(resolve => { releaseSuccessfulRetryResponse = resolve; });
    releaseHeldResponses.push(releaseSuccessfulRetryResponse);
    const successfulRetryReady = new Promise<void>(resolve => { resolveSuccessfulRetryReady = resolve; });
    const successfulRetryDone = new Promise<void>(resolve => { resolveSuccessfulRetryDone = resolve; });
    await delayedRetryPage.route(`**/api/analyses/${parentOwnerId}/retry`, async route => {
      if (!holdSuccessfulRetryResponse) return route.continue();
      holdSuccessfulRetryResponse = false;
      try {
        const actual = await route.fetch();
        successfulRetryStatus = actual.status();
        resolveSuccessfulRetryReady();
        await successfulRetryGate;
        try { await route.fulfill({ response: actual }); }
        catch { /* The response is intentionally released after detail unmounts. */ }
      } finally {
        resolveSuccessfulRetryReady();
        resolveSuccessfulRetryDone();
      }
    });
    await delayedRetryPage.goto(`${base}/analyses/${parentOwnerId}`, { waitUntil: "domcontentloaded" });
    await delayedRetryPage.getByRole("alert").filter({ hasText: /analisis gagal|analisis berhenti/i }).waitFor();
    const delayedRetryRequest = delayedRetryPage.waitForRequest(
      request => new URL(request.url()).pathname === `/api/analyses/${parentOwnerId}/retry` && request.method() === "POST",
    );
    const delayedRetryResponse = delayedRetryPage.waitForResponse(
      response => new URL(response.url()).pathname === `/api/analyses/${parentOwnerId}/retry` && response.request().method() === "POST",
    );
    await delayedRetryPage.getByRole("button", { name: /coba lagi|ulangi|retry/i }).click();
    const delayedRetryHttpRequest = await delayedRetryRequest;
    await successfulRetryReady;
    assert.equal(successfulRetryStatus, 202, "held successful retry response is a real newly enqueued retry");
    assert.match(delayedRetryHttpRequest.headers()["idempotency-key"] ?? "", /^[A-Za-z0-9_-]{16,128}$/);
    await delayedRetryPage.locator('[class*="breadcrumb"]').getByRole("link", { name: "Riwayat", exact: true }).click();
    await delayedRetryPage.waitForURL(`${base}/workspace/history`);
    await delayedRetryPage.getByRole("heading", { name: "Riwayat analisis", exact: true }).waitFor();
    let staleRetryRedirect = false;
    delayedRetryPage.on("framenavigated", frame => {
      if (frame === delayedRetryPage.mainFrame() && new URL(frame.url()).pathname.startsWith("/analyses/")) staleRetryRedirect = true;
    });
    releaseSuccessfulRetryResponse();
    await successfulRetryDone;
    const deliveredRetryResponse = await delayedRetryResponse;
    assert.equal(deliveredRetryResponse.status(), 202);
    const delayedRetryBody = await deliveredRetryResponse.json() as ApiEnvelope<QueuedResponse>;
    assert.ok(delayedRetryBody.data?.analysisId);
    const delayedRetryAnalysisId = delayedRetryBody.data.analysisId;
    analysisIds.push(delayedRetryAnalysisId);
    assert.notEqual(delayedRetryAnalysisId, parentOwnerId);
    await delayedRetryPage.waitForTimeout(1_500);
    assert.equal(new URL(delayedRetryPage.url()).pathname, "/workspace/history", "a successful retry response consumed after unmount cannot redirect away from history");
    assert.equal(staleRetryRedirect, false, "no transient detail navigation occurs after the delayed retry response is released");
    assert.equal(await delayedRetryPage.getByRole("heading", { name: "Riwayat analisis", exact: true }).count(), 1);
    const delayedRetryTerminal = await waitForTerminalAnalysis(db, delayedRetryAnalysisId);
    assert.equal(delayedRetryTerminal.status, "COMPLETED_WITH_LIMITATIONS", "the held request still created a real worker-consumable retry");
    await delayedRetryContext.close();
    checks.push("navigating to history while retry POST response is held prevents the unmounted detail action from redirecting after response delivery");

    const deniedContext = await browser.newContext({ viewport: { width: 1280, height: 1000 }, reducedMotion: "reduce" });
    await installSession(deniedContext, denied);
    const deniedPage = await deniedContext.newPage();
    deniedPage.setDefaultTimeout(20_000);
    deniedPage.on("pageerror", error => pageErrors.push(`permission error UI: ${error.message}`));
    await deniedPage.goto(`${base}/analyses/${parentDeniedId}`, { waitUntil: "domcontentloaded" });
    await deniedPage.getByRole("button", { name: /coba lagi|ulangi|retry/i }).waitFor();
    const deniedCountBeforeUi = await db.analysis.count({ where: { ownerUserId: denied.userId } });
    const deniedRetryResponse = deniedPage.waitForResponse(response => new URL(response.url()).pathname === `/api/analyses/${parentDeniedId}/retry` && response.request().method() === "POST");
    await deniedPage.getByRole("button", { name: /coba lagi|ulangi|retry/i }).click();
    const deniedUiResponse = await deniedRetryResponse;
    assert.equal(deniedUiResponse.status(), 403);
    await deniedPage.getByRole("alert").filter({ hasText: /izin|akses|permission/i }).waitFor();
    assert.equal(await db.analysis.count({ where: { ownerUserId: denied.userId } }), deniedCountBeforeUi, "failed fresh permission check creates no child job");
    assert.equal(await deniedPage.getByRole("button", { name: /coba lagi|ulangi|retry/i }).count(), 1, "the retry action remains available after a provider denial");
    await deniedPage.screenshot({ path: join(resultDir, "retry-permission-error.png"), fullPage: true });
    emittedScreenshots.push("retry-permission-error.png");
    await deniedContext.close();
    checks.push("browser displays a safe retry error after fresh provider permission denial and leaves the retry parent unchanged");

    phase = "held-detail-account-switch-race";
    const raceContext = await browser.newContext({ viewport: { width: 390, height: 1000 }, reducedMotion: "reduce" });
    await installSession(raceContext, owner);
    const racePage = await raceContext.newPage();
    racePage.setDefaultTimeout(20_000);
    racePage.on("pageerror", error => pageErrors.push(`account switch race: ${error.message}`));
    let releaseStaleResponse = () => {};
    let resolveDelayedRequest = () => {};
    let allowDetailFetch = () => {};
    let resolveActualResponse = () => {};
    let resolveHeldResponseDone = () => {};
    const staleGate = new Promise<void>(resolve => { releaseStaleResponse = resolve; });
    releaseHeldResponses.push(releaseStaleResponse);
    const delayedRequestStarted = new Promise<void>(resolve => { resolveDelayedRequest = resolve; });
    const detailFetchGate = new Promise<void>(resolve => { allowDetailFetch = resolve; });
    releaseHeldResponses.push(allowDetailFetch);
    const actualResponseReady = new Promise<void>(resolve => { resolveActualResponse = resolve; });
    const heldResponseDone = new Promise<void>(resolve => { resolveHeldResponseDone = resolve; });
    let holdNextDetailResponse = true;
    let heldResponseStatus = 0;
    await racePage.route(`**/api/analyses/${raceAnalysisId}`, async route => {
      if (!holdNextDetailResponse) return route.continue();
      holdNextDetailResponse = false;
      resolveDelayedRequest();
      try {
        await detailFetchGate;
        const actual = await route.fetch();
        heldResponseStatus = actual.status();
        resolveActualResponse();
        await staleGate;
        try { await route.fulfill({ response: actual }); }
        catch { /* Account reload may abort the held request; that is also safe. */ }
      } finally {
        resolveActualResponse();
        resolveHeldResponseDone();
      }
    });
    await racePage.goto(`${base}/analyses/${raceAnalysisId}`, { waitUntil: "domcontentloaded" });
    await delayedRequestStarted;
    assert.ok((await racePage.locator("body").innerText()).includes("Menunggu"), "the server-rendered account-A page starts with the queued detail");
    const staleRunningObservations: string[] = [];
    await racePage.exposeFunction("__recordPipeline16StaleRunning", (text: string) => {
      staleRunningObservations.push(text);
    });
    await racePage.evaluate((commit) => {
      const observer = new MutationObserver(() => {
        const text = document.body.innerText;
        if (text.includes("Berjalan") && text.includes(`commit ${commit}`)) {
          void (window as Window & { __recordPipeline16StaleRunning?: (value: string) => void }).__recordPipeline16StaleRunning?.(text);
        }
      });
      observer.observe(document.body, { subtree: true, childList: true, characterData: true });
    }, fixtureCommit);
    // Make the held API body differ from the page's initial QUEUED snapshot.
    // If the poller applies the body before rechecking the session, the observer
    // catches even a brief RUNNING flash before the account-B reload completes.
    const staleProgressAt = new Date();
    await db.$transaction([
      db.analysis.update({ where: { id: raceAnalysisId }, data: { status: "RUNNING", startedAt: staleProgressAt } }),
      db.analysisStage.update({
        where: { analysisId_sequence: { analysisId: raceAnalysisId, sequence: 1 } },
        data: { status: "RUNNING", startedAt: staleProgressAt },
      }),
    ]);
    allowDetailFetch();
    await actualResponseReady;
    assert.equal(heldResponseStatus, 200, "held owner-A detail body comes from the real API and database");
    const identityMismatch = racePage.waitForResponse(response => {
      const url = new URL(response.url());
      return url.pathname === "/api/auth/session" && response.status() === 401
        && response.request().headers()["x-sage-account"] === owner!.accountKey;
    });
    await raceContext.addCookies([cookie(denied)]);
    releaseStaleResponse();
    const [mismatchResponse] = await Promise.all([identityMismatch, heldResponseDone]);
    assert.equal(mismatchResponse.status(), 401, "real session API rejects account B with account A's page binding after consuming the held detail body");
    await racePage.getByRole("alert").filter({ hasText: /analisis tidak ditemukan/i }).waitFor();
    await racePage.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const raceBody = await racePage.locator("body").innerText();
    assert.ok(!raceBody.includes(fixtureFullName), "account B never sees the stale owner-A repository after the delayed response is released");
    assert.ok(!raceBody.includes(fixtureCommit), "account B never sees the stale owner-A commit after the delayed response is released");
    assert.ok(!raceBody.includes("Analisis sedang berjalan"), "stale owner-A progress never returns after the account switch");
    assert.deepEqual(staleRunningObservations, [], "the held RUNNING body is never briefly rendered before the fresh identity check rejects account A");
    await racePage.screenshot({ path: join(resultDir, "account-switch-stale-response.png"), fullPage: true });
    emittedScreenshots.push("account-switch-stale-response.png");
    await raceContext.close();
    checks.push("real A→B cookie switch during a held database-backed A detail response reloads to B's not-found state and does not restore A's target/progress");

    const retryTerminal = await waitForTerminalAnalysis(db, retryAnalysisId);
    assert.equal(retryTerminal.status, "COMPLETED_WITH_LIMITATIONS");
    assert.match(retryTerminal.resultHash ?? "", /^[a-f0-9]{64}$/);
    assert.ok(retryTerminal.graphBundle && retryTerminal.architectureDocument);
    retrySummary = {
      status: retryTerminal.status,
      resultHash: retryTerminal.resultHash,
      completedStages: retryTerminal.stages.filter(stage => stage.status === "COMPLETED").length,
      graphNodeCount: retryTerminal.graphBundle.nodeCount,
      graphEdgeCount: retryTerminal.graphBundle.edgeCount,
      architectureDocumentHash: retryTerminal.architectureDocument.contentHash,
      limitationCount: retryTerminal.limitations.length,
      retryParentId: parentOwnerId,
    };
    checks.push("worker consumes the retried queue row and publishes its own terminal graph/document result");
    assert.deepEqual(pageErrors, [], "browser flows must not emit uncaught JavaScript errors");
  } catch (error) {
    reportStatus = "FAIL";
    const errorName = error instanceof Error ? error.name : "UnknownError";
    const safeStackFrames = error instanceof Error && error.stack
      ? error.stack.split("\n").slice(1).filter(frame => /^\s+at\s/.test(frame)).slice(0, 2).map(frame => frame.trim())
      : [];
    const safeErrorCode = error && typeof error === "object" && "code" in error
      && typeof (error as { code?: unknown }).code === "string"
      ? (error as { code: string }).code
      : undefined;
    reportError = `${errorName}${safeErrorCode ? `:${safeErrorCode}` : ""} [${phase}]${safeStackFrames.length ? ` ${safeStackFrames.join(" | ")}` : ""}`;
    failures.push(reportError);
    console.error("Live pipeline verification failed; diagnostics include only the failure phase, error type/code, and stack frames.", reportError);
  } finally {
    for (const release of releaseHeldResponses) release();
    try { await browser?.close(); } catch { reportStatus = "FAIL"; }
    try {
      if (storageRoot) await deleteOwnedFixtures(db, { analysisIds, userIds, repositoryId, repositoryCreated, storageRoot });
      else if (userIds.length) await db.user.deleteMany({ where: { id: { in: userIds } } });
    } catch (error) {
      cleanupSafe = false;
      reportStatus = "FAIL";
      reportError ??= error instanceof Error ? error.name : "CleanupError";
      failures.push(`cleanup:${reportError}`);
    }
    if (cleanupSafe) {
      try { if (sessionIds.length) await db.session.deleteMany({ where: { id: { in: sessionIds } } }); }
      catch { reportStatus = "FAIL"; failures.push("session-cleanup-failed"); }
    }
    await db.$disconnect();
    const report = {
      checkedAt: new Date().toISOString(),
      status: reportStatus,
      checks,
      failures,
      scope: "Live Next.js HTTP and Chromium browser against isolated PostgreSQL with the real queue consumer, stage handlers, terminal publication, retry endpoint, and result readers.",
      simulatedBoundary: providerBoundary,
      mainAnalysis: mainSummary ?? null,
      retryAnalysis: retrySummary ?? null,
      artifacts: emittedScreenshots,
      limitations: [
        "GitHub private-repository metadata, installation access, branch/commit checks, and source archive bytes come from the guarded test-only fixture; no real GitHub permission is claimed.",
        "The failed retry parents and the queued account-switch race record are seeded directly in PostgreSQL; the successful submission and both successful worker runs use the real UI/API/queue/worker path.",
      ],
      errorType: reportError ?? null,
    };
    await mkdir(resultDir, { recursive: true });
    await writeFile(join(resultDir, "report.json"), JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify(report));
  }
  if (reportStatus === "FAIL") process.exitCode = 1;
}

let base = "";
let origin = "";
let storageRoot = "";

await runLivePipelineRegression();
