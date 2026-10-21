import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeReferences } from "@sage/analyzer-js";
import { canonicalizeCkg, type CcmV1, type CcmSnapshot } from "@sage/contracts";
import { createSession, database, storeGitHubCredential } from "@sage/database";
import { chromium, request, type APIRequestContext, type APIResponse, type BrowserContext, type Page } from "playwright";
import { pack, type Header } from "tar-stream";
import { gzipSync } from "node:zlib";
import { projectCcmForGraph } from "../apps/web/components/graph-foundation/graph-projection.ts";

/**
 * Destructive integration regression for the issue 17 live graph path.
 *
 * Run only against the dedicated database and private temporary STORAGE_ROOT,
 * with a real Next server using that same STORAGE_ROOT:
 *   SAGE_GRAPH_TESTS=1 DATABASE_URL=postgresql://sage@sage-graph17-db:5432/sage_graph17 \
 *   STORAGE_ROOT=/tmp/sage-graph17-storage SAGE_GRAPH_BASE_URL=http://127.0.0.1:3000 \
 *   npx tsx scripts/test-live-graph.ts
 *
 * The fixture uses real Postgres rows, session cookies, the graph HTTP route,
 * and the browser UI. It directly seeds terminal CKG/archive rows for a stable
 * page test; that does not exercise the nine-stage worker pipeline or worker
 * publication. No OAuth connection or provider token is created.
 */

const enabled = process.env.SAGE_GRAPH_TESTS === "1";

type DisposableAccount = {
  userId: string;
  login: string;
  accountKey: string;
  token: string;
  sessionId: string;
  syntheticProviderToken: string;
};

type SeededSnapshot = {
  id: string;
  bytes: Buffer;
  archivePath: string;
  storageKey: string;
};

type SeededGraph = {
  analysisId: string;
  canonical: Extract<ReturnType<typeof canonicalizeCkg>, { ok: true }>;
  sourceBytes: Record<string, Uint8Array>;
  snapshot: CcmSnapshot;
  archive: SeededSnapshot;
};

type ApiErrorBody = {
  error?: { code?: string; message?: string };
  requestId?: string;
};

const viewports = [360, 390, 768, 1024, 1440] as const;
const nodeKinds = ["Module", "Class", "Interface", "Function", "Method", "Property", "UnresolvedReference"] as const;
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureDir = new URL("../tests/fixtures/resolver/typescript/", import.meta.url);
const resultDir = resolve(projectRoot, "artifacts/graph-17");
const fixtureRepository = "AgilePemdigi-2026/sage";
const fixtureBranch = "codex/12-js-ts-resolver";
const fixtureCommit = "d".repeat(40);

function requireDedicatedDatabase(): void {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error("DATABASE_URL is required when SAGE_GRAPH_TESTS=1.");
  let databaseName: string;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") throw new Error("protocol");
    databaseName = decodeURIComponent(parsed.pathname.slice(1));
  } catch {
    throw new Error("DATABASE_URL must be a valid PostgreSQL URL; it was not logged.");
  }
  if (databaseName !== "sage_graph17") {
    throw new Error("Live graph regression only allows the isolated sage_graph17 database.");
  }
}

async function preparePrivateStorageRoot(): Promise<string> {
  const raw = process.env.STORAGE_ROOT;
  if (!raw || !isAbsolute(raw)) throw new Error("STORAGE_ROOT must be an absolute private temporary directory.");
  const requested = resolve(raw);
  const temporaryRoots = [...new Set([resolve(tmpdir()), resolve("/tmp"), resolve("/var/tmp")])];
  if (temporaryRoots.every(root => requested === root || !requested.startsWith(`${root}${sep}`))) {
    throw new Error("Refusing to use STORAGE_ROOT outside a temporary directory.");
  }
  await mkdir(requested, { recursive: true, mode: 0o700 });
  const stat = await lstat(requested);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("STORAGE_ROOT must be a real directory, not a symlink.");
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    throw new Error("STORAGE_ROOT must have private permissions (0700).");
  }
  const existing = await readdir(requested);
  if (existing.length > 0) throw new Error("STORAGE_ROOT must be an empty issue 17 fixture directory.");
  return requested;
}

function digest(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertIsolatedDbUrl(): void {
  requireDedicatedDatabase();
}

async function makeTarGz(sources: Readonly<Record<string, Uint8Array>>): Promise<Buffer> {
  const tar = pack();
  const archiveRoot = `sage-graph17-source-${randomBytes(4).toString("hex")}`;
  async function add(name: string, bytes: Buffer, type: "file" | "directory"): Promise<void> {
    const header: Partial<Header> & Pick<Header, "name"> = {
      name,
      type,
      size: bytes.byteLength,
      mode: type === "directory" ? 0o755 : 0o644,
      mtime: new Date(0),
      linkname: "",
      uid: 0,
      gid: 0,
      uname: "",
      gname: "",
      devmajor: 0,
      devminor: 0,
    };
    await new Promise<void>((resolveEntry, rejectEntry) => {
      tar.entry(header, bytes, error => error ? rejectEntry(error) : resolveEntry());
    });
  }

  await add(`${archiveRoot}/`, Buffer.alloc(0), "directory");
  const directories = new Set<string>();
  for (const path of Object.keys(sources)) {
    let parent = dirname(path);
    while (parent !== ".") {
      directories.add(parent);
      parent = dirname(parent);
    }
  }
  for (const path of [...directories].sort((left, right) => left.split("/").length - right.split("/").length || left.localeCompare(right))) {
    await add(`${archiveRoot}/${path}/`, Buffer.alloc(0), "directory");
  }
  for (const path of Object.keys(sources).sort()) {
    await add(`${archiveRoot}/${path}`, Buffer.from(sources[path]!), "file");
  }
  tar.finalize();
  const chunks: Buffer[] = [];
  for await (const chunk of tar) chunks.push(Buffer.from(chunk as Uint8Array));
  return gzipSync(Buffer.concat(chunks));
}

async function loadResolverFixture(): Promise<{ sources: Record<string, Uint8Array>; ccm: CcmV1; snapshot: CcmSnapshot }> {
  // This is the repository's hand-authored TypeScript resolver fixture used by
  // tests/resolver-integration.test.ts, not a fabricated CKG payload.
  const paths = ["src/model.ts", "src/endpoint.ts"];
  const entries = await Promise.all(paths.map(async path => {
    const bytes = new Uint8Array(await readFile(new URL(path, fixtureDir)));
    return [path, bytes] as const;
  }));
  const sources = Object.fromEntries(entries);
  const snapshot: CcmSnapshot = {
    repository: fixtureRepository,
    branch: fixtureBranch,
    commitSha: fixtureCommit,
  };
  const result = analyzeReferences({ snapshot, sources });
  assert.equal(result.errorCode, null, "the checked-in TypeScript resolver fixture must analyze successfully");
  assert.ok(result.ccm, "the checked-in TypeScript resolver fixture must produce a CCM");
  const presentKinds = new Set(result.ccm.nodes.map(node => node.kind));
  for (const kind of nodeKinds) assert.ok(presentKinds.has(kind), `fixture must contain ${kind}`);
  assert.ok(result.ccm.edges.some(edge => edge.resolution === "Unresolved"), "fixture must exercise unresolved references");
  return { sources, ccm: result.ccm, snapshot };
}

async function createArchiveStorage(
  db: ReturnType<typeof database>,
  storageRoot: string,
  ownerUserId: string,
  analysisId: string,
  sources: Readonly<Record<string, Uint8Array>>,
  storageObjectIds: string[],
  createdFolders: string[],
): Promise<SeededSnapshot> {
  const bytes = await makeTarGz(sources);
  const folderPath = await mkdtemp(join(storageRoot, "snapshot-"));
  createdFolders.push(folderPath);
  const folderName = basename(folderPath);
  assert.match(folderName, /^snapshot-[A-Za-z0-9]{6}$/);
  const storageKey = `${folderName}/archive.tar.gz`;
  const archivePath = join(folderPath, "archive.tar.gz");
  await writeFile(archivePath, bytes, { flag: "wx", mode: 0o600 });
  const stored = await db.storageObject.create({
    data: {
      ownerUserId,
      analysisId,
      type: "SOURCE_ARCHIVE",
      storageKey,
      sha256: digest(bytes),
      byteLength: BigInt(bytes.byteLength),
    },
    select: { id: true },
  });
  storageObjectIds.push(stored.id);
  return { id: stored.id, bytes, archivePath, storageKey };
}

function makeEmptyCcm(snapshot: CcmSnapshot, provenance: CcmV1["provenance"]): CcmV1 {
  return {
    schemaVersion: 1,
    snapshot,
    provenance,
    files: [],
    nodes: [],
    edges: [],
    limitations: [],
  };
}

function cookieHeader(account: DisposableAccount): Record<string, string> {
  return {
    Cookie: `sage_session=${account.token}`,
    "X-SAGE-Account": account.accountKey,
  };
}

function noSensitiveErrorData(bodyText: string, secrets: readonly string[]): void {
  for (const value of secrets) if (value) assert.ok(!bodyText.includes(value), "error response must not expose session tokens or private fixture data");
  assert.doesNotMatch(bodyText, /snapshot-[A-Za-z0-9]{6}\/archive\.tar\.gz|sage-graph17-source|RESOLVER_TS_FIXTURE_MUST_NOT_EXECUTE/i);
}

async function graphApiResponse(
  api: APIRequestContext,
  basePath: string,
  account: DisposableAccount,
): Promise<{ response: APIResponse; body: { data: Record<string, unknown>; error?: ApiErrorBody["error"] } }> {
  const response = await api.get(basePath, { headers: cookieHeader(account) });
  return { response, body: await response.json() as { data: Record<string, unknown>; error?: ApiErrorBody["error"] } };
}

function graphUrl(base: string, analysisId: string): string {
  return `${base}/api/analyses/${analysisId}/graph`;
}

function graphPageUrl(base: string, analysisId: string): string {
  return `${base}/analyses/${analysisId}/graph`;
}

async function readFixtureGraph(api: APIRequestContext, base: string, analysisId: string, owner: DisposableAccount) {
  return graphApiResponse(api, graphUrl(base, analysisId), owner);
}

async function makeAccount(db: ReturnType<typeof database>, label: string, userIds: string[], sessionIds: string[]): Promise<DisposableAccount> {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const login = `graph17-${label}-${suffix}`;
  const accountKey = `graph17-gh-${label}-${suffix}`;
  const syntheticProviderToken = `synthetic-not-provider-${label}-${suffix}`;
  const user = await db.user.create({ data: { githubUserId: accountKey, login }, select: { id: true } });
  userIds.push(user.id);
  // The repository-session endpoint requires an active connection. This is a
  // synthetic encrypted token only; the test never contacts GitHub or uses OAuth.
  await storeGitHubCredential(db, user.id, {
    githubUserId: accountKey,
    githubLogin: login,
    accessToken: syntheticProviderToken,
  });
  const created = await createSession(db, user.id, { ttlMs: 30 * 60 * 1000 });
  sessionIds.push(created.session.sessionId);
  return { userId: user.id, login, accountKey, token: created.token, sessionId: created.session.sessionId, syntheticProviderToken };
}

async function createAnalysisRow(
  db: ReturnType<typeof database>,
  input: {
    ownerUserId: string;
    repositoryId: string;
    analysisId?: string;
    status: "RUNNING" | "COMPLETED" | "COMPLETED_WITH_LIMITATIONS";
    snapshot: CcmSnapshot;
    configurationHash: string;
    label: string;
  },
): Promise<string> {
  const now = new Date();
  const created = await db.analysis.create({
    data: {
      ...(input.analysisId ? { id: input.analysisId } : {}),
      ownerUserId: input.ownerUserId,
      repositoryId: input.repositoryId,
      repositoryFullNameSnapshot: input.snapshot.repository,
      branchName: input.snapshot.branch ?? "main",
      commitSha: input.snapshot.commitSha,
      configuration: { issue: 17, fixture: input.label },
      configurationHash: input.configurationHash,
      analyzerVersion: "sage-analyzer-js-static-resolver-fixture",
      schemaVersion: "1",
      status: input.status,
      startedAt: input.status === "RUNNING" ? now : null,
      completedAt: input.status === "RUNNING" ? null : now,
    },
    select: { id: true },
  });
  return created.id;
}

async function seedGraphBundle(
  db: ReturnType<typeof database>,
  input: {
    ownerUserId: string;
    analysisId: string;
    sourceBytes: Record<string, Uint8Array>;
    ccm: CcmV1;
    configurationHash: string;
  },
): Promise<SeededGraph> {
  const canonical = canonicalizeCkg(input.ccm, input.sourceBytes, input.configurationHash);
  if (!canonical.ok) throw new Error(`CKG canonicalization failed: ${canonical.errorCode}`);
  await db.graphBundle.create({
    data: {
      ownerUserId: input.ownerUserId,
      analysisId: input.analysisId,
      schemaVersion: canonical.value.schemaVersion,
      configurationHash: input.configurationHash,
      canonicalContent: canonical.json,
      // This storage format mirrors persistCanonicalGraph and is independently
      // checked by readCanonicalGraphForUser on every API read.
      nodes: JSON.stringify(canonical.value.ccm.nodes),
      edges: JSON.stringify(canonical.value.ccm.edges),
      nodeCount: canonical.value.counts.nodes,
      edgeCount: canonical.value.counts.edges,
      contentHash: canonical.sha256,
    },
  });
  return {
    analysisId: input.analysisId,
    canonical,
    sourceBytes: input.sourceBytes,
    snapshot: input.ccm.snapshot,
    // Assigned by the caller after its immutable snapshot archive is registered.
    archive: undefined as unknown as SeededSnapshot,
  };
}

async function zoomPercent(page: Page): Promise<number> {
  return Number((await page.getByLabel("Tingkat zoom", { exact: true }).innerText()).replace("%", ""));
}

async function takeScreenshot(page: Page, filename: string): Promise<void> {
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: join(resultDir, filename), fullPage: true });
}

async function runLiveGraphRegression(): Promise<void> {
  assertIsolatedDbUrl();
  const base = (process.env.SAGE_GRAPH_BASE_URL ?? "http://127.0.0.1:3000").replace(/\/$/, "");
  const parsedBase = new URL(base);
  if (parsedBase.protocol !== "http:" && parsedBase.protocol !== "https:") throw new Error("SAGE_GRAPH_BASE_URL must be HTTP(S).");
  const storageRoot = await preparePrivateStorageRoot();
  const db = database();
  const users: string[] = [];
  const sessionIds: string[] = [];
  const analysisIds: string[] = [];
  const storageObjectIds: string[] = [];
  const createdFolders: string[] = [];
  const checks: string[] = [];
  const failures: string[] = [];
  const pageErrors: string[] = [];
  const providerRequests: string[] = [];
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let api: Awaited<ReturnType<typeof request.newContext>> | undefined;
  let repositoryId = "";
  let reportStatus: "PASS" | "FAIL" = "PASS";
  let reportError: string | undefined;
  let owner: DisposableAccount | undefined;
  let other: DisposableAccount | undefined;
  let ready: SeededGraph | undefined;
  let empty: SeededGraph | undefined;

  try {
    await mkdir(resultDir, { recursive: true });
    api = await request.newContext({ baseURL: base, timeout: 20_000 });
    const health = await api.get("/api/health");
    assert.equal(health.status(), 200, "the externally started Next server must be reachable and connected to Postgres");
    assert.deepEqual(await health.json(), { status: "ok", service: "web", database: "ok" });
    checks.push("real Next server health and PostgreSQL connectivity");

    owner = await makeAccount(db, "owner", users, sessionIds);
    other = await makeAccount(db, "other", users, sessionIds);
    const repository = await db.repository.create({
      data: {
        githubRepositoryId: `graph17-repo-${randomUUID()}`,
        ownerLogin: owner.login,
        name: "resolver-typescript-fixture",
        fullName: `${owner.login}/resolver-typescript-fixture`,
        visibility: "PUBLIC",
      },
      select: { id: true },
    });
    repositoryId = repository.id;

    const fixture = await loadResolverFixture();
    const configurationHash = digest("SAGE issue 17 live graph regression fixture configuration v1");
    const readyAnalysisId = await createAnalysisRow(db, {
      ownerUserId: owner.userId,
      repositoryId,
      status: "COMPLETED_WITH_LIMITATIONS",
      snapshot: fixture.snapshot,
      configurationHash,
      label: "resolver-typescript-public-fixture",
    });
    analysisIds.push(readyAnalysisId);
    const readySeed = await seedGraphBundle(db, {
      ownerUserId: owner.userId,
      analysisId: readyAnalysisId,
      sourceBytes: fixture.sources,
      ccm: fixture.ccm,
      configurationHash,
    });
    ready = readySeed;
    ready.archive = await createArchiveStorage(db, storageRoot, owner.userId, readyAnalysisId, fixture.sources, storageObjectIds, createdFolders);

    const emptySnapshot: CcmSnapshot = {
      repository: fixture.snapshot.repository,
      branch: fixture.snapshot.branch,
      commitSha: createHash("sha1").update("sage-graph17-empty-fixture").digest("hex"),
    };
    const emptyConfigurationHash = digest("SAGE issue 17 empty graph fixture configuration v1");
    const emptyAnalysisId = await createAnalysisRow(db, {
      ownerUserId: owner.userId,
      repositoryId,
      status: "COMPLETED",
      snapshot: emptySnapshot,
      configurationHash: emptyConfigurationHash,
      label: "empty-graph",
    });
    analysisIds.push(emptyAnalysisId);
    const emptySourceBytes: Record<string, Uint8Array> = {};
    const emptySeed = await seedGraphBundle(db, {
      ownerUserId: owner.userId,
      analysisId: emptyAnalysisId,
      sourceBytes: emptySourceBytes,
      ccm: makeEmptyCcm(emptySnapshot, fixture.ccm.provenance),
      configurationHash: emptyConfigurationHash,
    });
    empty = emptySeed;
    empty.archive = await createArchiveStorage(db, storageRoot, owner.userId, emptyAnalysisId, emptySourceBytes, storageObjectIds, createdFolders);

    const runningSnapshot: CcmSnapshot = {
      repository: fixture.snapshot.repository,
      branch: fixture.snapshot.branch,
      commitSha: createHash("sha1").update("sage-graph17-running-fixture").digest("hex"),
    };
    const runningId = await createAnalysisRow(db, {
      ownerUserId: other.userId,
      repositoryId,
      status: "RUNNING",
      snapshot: runningSnapshot,
      configurationHash: digest("SAGE issue 17 running fixture configuration v1"),
      label: "in-progress-no-archive",
    });
    analysisIds.push(runningId);
    assert.equal(await db.storageObject.count({ where: { analysisId: runningId, ownerUserId: other.userId, type: "SOURCE_ARCHIVE" } }), 0);

    const noBundleId = await createAnalysisRow(db, {
      ownerUserId: owner.userId,
      repositoryId,
      status: "COMPLETED",
      snapshot: runningSnapshot,
      configurationHash: digest("SAGE issue 17 missing graph fixture configuration v1"),
      label: "terminal-without-graph",
    });
    analysisIds.push(noBundleId);
    browser = await chromium.launch({ headless: true });

    const baseGraphPath = graphUrl(base, ready.analysisId);
    const success = await readFixtureGraph(api, base, ready.analysisId, owner);
    assert.equal(success.response.status(), 200);
    const responseHeaders = success.response.headers();
    assert.match(responseHeaders["cache-control"] ?? "", /private,\s*no-store/i);
    assert.match(responseHeaders["vary"] ?? "", /Cookie/i);
    assert.match(responseHeaders["vary"] ?? "", /X-SAGE-Account/i);
    assert.equal(responseHeaders["x-content-type-options"], "nosniff");
    const data = success.body.data as {
      analysisId: string;
      accountKey: string;
      ckgSha256: string;
      configurationHash: string;
      snapshot: CcmSnapshot;
      provenance: CcmV1["provenance"];
      canonicalCounts: { nodes: number; edges: number; containmentEdges: number; referenceEdges: number; exactEdges: number; unresolvedEdges: number };
      filteredCounts: { nodes: number; edges: number };
      returnedCounts: { nodes: number; edges: number };
      paginated: boolean;
      graph: ReturnType<typeof projectCcmForGraph>;
    };
    assert.equal(data.analysisId, ready.analysisId);
    assert.equal(data.accountKey, owner.accountKey);
    assert.equal(data.ckgSha256, ready.canonical.sha256);
    assert.equal(data.configurationHash, configurationHash);
    assert.deepEqual(data.snapshot, fixture.snapshot);
    assert.deepEqual(data.provenance, fixture.ccm.provenance);
    assert.deepEqual(data.canonicalCounts, ready.canonical.value.counts);
    assert.deepEqual(data.filteredCounts, { nodes: ready.canonical.value.counts.nodes, edges: ready.canonical.value.counts.edges });
    assert.deepEqual(data.returnedCounts, data.filteredCounts);
    assert.equal(data.paginated, false);
    assert.deepEqual(data.graph, projectCcmForGraph(ready.canonical.value.ccm));
    for (const kind of nodeKinds) assert.ok(data.graph.nodes.some(node => node.kind === kind), `API graph must preserve ${kind}`);
    const successText = JSON.stringify(success.body);
    assert.ok(!successText.includes("RESOLVER_TS_FIXTURE_MUST_NOT_EXECUTE"), "API returns graph evidence but never raw source text");
    assert.ok(!successText.includes(owner.token) && !successText.includes(other.token));
    assert.ok(!successText.includes(owner.syntheticProviderToken) && !successText.includes(other.syntheticProviderToken));
    assert.ok(!successText.includes(ready.archive.storageKey) && !successText.includes(storageRoot));
    checks.push("real API: owner gets canonical CKG, snapshot/hash/count mirrors, seven analyzer-produced node kinds, and no source/archive/session-token leak");

    const anonymous = await api.get(baseGraphPath);
    assert.equal(anonymous.status(), 401);
    assert.equal((await anonymous.json() as ApiErrorBody).error?.code, "AUTH_REQUIRED");
    const staleAccount = await api.get(baseGraphPath, {
      headers: { Cookie: `sage_session=${owner.token}`, "X-SAGE-Account": other.accountKey },
    });
    assert.equal(staleAccount.status(), 401);
    assert.equal((await staleAccount.json() as ApiErrorBody).error?.code, "AUTH_REQUIRED");
    const foreign = await api.get(baseGraphPath, { headers: cookieHeader(other) });
    assert.equal(foreign.status(), 404);
    assert.equal((await foreign.json() as ApiErrorBody).error?.code, "ANALYSIS_NOT_FOUND");
    const unknown = await api.get(graphUrl(base, "missing-graph-17"), { headers: cookieHeader(owner) });
    assert.equal(unknown.status(), 404);
    assert.equal((await unknown.json() as ApiErrorBody).error?.code, "ANALYSIS_NOT_FOUND");
    const running = await api.get(graphUrl(base, runningId), { headers: cookieHeader(other) });
    assert.equal(running.status(), 409, "owned RUNNING analysis with no archive is hidden before the graph read");
    assert.equal((await running.json() as ApiErrorBody).error?.code, "RESULT_NOT_READY");
    const noBundle = await api.get(graphUrl(base, noBundleId), { headers: cookieHeader(owner) });
    assert.equal(noBundle.status(), 503, "a terminal analysis without its canonical archive and graph is unavailable");
    const noBundleText = await noBundle.text();
    assert.match(noBundleText, /GRAPH_UNAVAILABLE/);
    noSensitiveErrorData(noBundleText, [owner.token, other.token, owner.syntheticProviderToken, other.syntheticProviderToken, "RESOLVER_TS_FIXTURE_MUST_NOT_EXECUTE", storageRoot]);
    const unknownQuery = await api.get(`${baseGraphPath}?unexpected=1`, { headers: cookieHeader(owner) });
    assert.equal(unknownQuery.status(), 400);
    assert.equal((await unknownQuery.json() as ApiErrorBody).error?.code, "INVALID_INPUT");
    const unsupportedMode = await api.get(`${baseGraphPath}?mode=server`, { headers: cookieHeader(owner) });
    assert.equal(unsupportedMode.status(), 400);
    assert.equal((await unsupportedMode.json() as ApiErrorBody).error?.code, "INVALID_INPUT");
    checks.push("real API: anonymous/stale-account 401, foreign/missing 404, RUNNING 409, terminal result without archive/CKG 503, and invalid query 400");

    const emptyResponse = await readFixtureGraph(api, base, empty.analysisId, owner);
    assert.equal(emptyResponse.response.status(), 200);
    const emptyData = emptyResponse.body.data as {
      canonicalCounts: { nodes: number; edges: number; containmentEdges: number; referenceEdges: number; exactEdges: number; unresolvedEdges: number };
      graph: { nodes: unknown[]; edges: unknown[] };
    };
    assert.deepEqual(emptyData.canonicalCounts, {
      nodes: 0, edges: 0, containmentEdges: 0, referenceEdges: 0, exactEdges: 0, unresolvedEdges: 0,
    });
    assert.deepEqual(emptyData.graph.nodes, []);
    assert.deepEqual(emptyData.graph.edges, []);
    checks.push("real API: canonical empty graph returns a valid zero-count payload");

    const originalBundle = await db.graphBundle.findUniqueOrThrow({
      where: { analysisId_ownerUserId: { analysisId: ready.analysisId, ownerUserId: owner.userId } },
    });
    const corruptedHash = originalBundle.contentHash === "0".repeat(64) ? "1".repeat(64) : "0".repeat(64);
    try {
      await db.graphBundle.update({
        where: { analysisId_ownerUserId: { analysisId: ready.analysisId, ownerUserId: owner.userId } },
        data: { contentHash: corruptedHash },
      });
      const corrupted = await api.get(baseGraphPath, { headers: cookieHeader(owner) });
      assert.equal(corrupted.status(), 503);
      const text = await corrupted.text();
      assert.match(text, /GRAPH_UNAVAILABLE/);
      assert.match(text, /Graph belum dapat dibaca\. Coba lagi\./);
      noSensitiveErrorData(text, [owner.token, other.token, owner.syntheticProviderToken, other.syntheticProviderToken, "RESOLVER_TS_FIXTURE_MUST_NOT_EXECUTE", ready.archive.storageKey, storageRoot]);
    } finally {
      await db.graphBundle.update({
        where: { analysisId_ownerUserId: { analysisId: ready.analysisId, ownerUserId: owner.userId } },
        data: { contentHash: originalBundle.contentHash },
      });
    }
    assert.equal((await api.get(baseGraphPath, { headers: cookieHeader(owner) })).status(), 200, "restored canonical bundle must recover");
    checks.push("real API: corrupted canonical bundle becomes safe 503, leaks no source/storage/session secret, and recovers after restoration");

    const corruptedArchive = Buffer.from(ready.archive.bytes);
    corruptedArchive[corruptedArchive.length - 1] = corruptedArchive[corruptedArchive.length - 1]! ^ 0x01;
    try {
      await writeFile(ready.archive.archivePath, corruptedArchive, { mode: 0o600 });
      const corrupted = await api.get(baseGraphPath, { headers: cookieHeader(owner) });
      assert.equal(corrupted.status(), 503);
      const text = await corrupted.text();
      assert.match(text, /GRAPH_UNAVAILABLE/);
      assert.match(text, /Graph belum dapat dibaca\. Coba lagi\./);
      noSensitiveErrorData(text, [owner.token, other.token, owner.syntheticProviderToken, other.syntheticProviderToken, "RESOLVER_TS_FIXTURE_MUST_NOT_EXECUTE", ready.archive.storageKey, storageRoot]);
    } finally {
      await writeFile(ready.archive.archivePath, ready.archive.bytes, { mode: 0o600 });
    }
    assert.equal((await api.get(baseGraphPath, { headers: cookieHeader(owner) })).status(), 200, "restored source archive must recover");
    checks.push("real API: corrupt immutable source archive becomes safe 503, leaks no source/storage/session secret, and recovers after restoration");

    let controlled503Used = false;
    for (const width of viewports) {
      const context: BrowserContext = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: "reduce" });
      await context.addCookies([{
        name: "sage_session",
        value: owner.token,
        url: base,
        httpOnly: true,
        sameSite: "Lax",
      }]);
      const page = await context.newPage();
      page.setDefaultTimeout(20_000);
      page.on("pageerror", error => pageErrors.push(`${width}px: ${error.message}`));
      page.on("request", req => {
        const url = new URL(req.url());
        if (url.hostname === "github.com" || url.hostname === "api.github.com" || url.pathname.startsWith("/api/github/")) providerRequests.push(req.url());
      });

      if (!controlled503Used) {
        let firstGraphRequest = true;
        await page.route(`**/api/analyses/${ready.analysisId}/graph*`, async route => {
          if (!firstGraphRequest) return route.continue();
          firstGraphRequest = false;
          controlled503Used = true;
          await route.fulfill({
            status: 503,
            contentType: "application/json",
            headers: { "Cache-Control": "private, no-store" },
            body: JSON.stringify({
              error: { code: "GRAPH_UNAVAILABLE", message: "Graph belum dapat dibaca. Coba lagi.", details: {} },
              requestId: randomUUID(),
            }),
          });
        });
      }

      const expectedGraphStatus = page.waitForResponse(response => {
        const url = new URL(response.url());
        return url.pathname === `/api/analyses/${ready!.analysisId}/graph`;
      });
      await page.goto(graphPageUrl(base, ready.analysisId), { waitUntil: "networkidle" });
      const firstGraphResponse = await expectedGraphStatus;
      const canvas = page.getByRole("region", { name: "Kanvas knowledge graph", exact: true });
      if (firstGraphResponse.status() === 503) {
        assert.equal(width, 360, "only the first viewport uses the explicitly controlled 503 retry case");
        const alert = page.getByRole("alert").filter({ hasText: "Graph sementara tidak dapat dibaca." });
        await alert.waitFor();
        assert.match(await alert.innerText(), /Graph belum dapat dibaca/);
        const retryResponse = page.waitForResponse(response => {
          const url = new URL(response.url());
          return url.pathname === `/api/analyses/${ready!.analysisId}/graph` && response.status() === 200;
        });
        await page.getByRole("button", { name: "Coba lagi", exact: true }).click();
        await retryResponse;
      } else {
        assert.equal(firstGraphResponse.status(), 200, `${width}px route must load through the genuine graph API`);
      }
      await canvas.waitFor();
      await canvas.locator("canvas").first().waitFor();
      await page.getByTestId("canonical-counts").waitFor();
      await page.getByTestId("visible-counts").waitFor();
      const canonicalCounts = await page.getByTestId("canonical-counts").innerText();
      const overviewVisibleCounts = await page.getByTestId("visible-counts").innerText();
      assert.match(canonicalCounts, /Kanonik:/);
      assert.match(overviewVisibleCounts, /Tampilan:/);
      assert.equal(await page.getByRole("button", { name: "Ikhtisar", exact: true }).getAttribute("aria-pressed"), "true");
      const legend = page.getByLabel("Kategori node dan jenis relasi", { exact: true });
      const legendText = await legend.innerText();
      for (const label of ["Belum terpecahkan", "Exact", "Unresolved"]) assert.ok(legendText.includes(label));

      await takeScreenshot(page, `graph-overview-${width}.png`);
      const modeVisibleCounts = new Set<string>([overviewVisibleCounts]);
      await page.getByRole("button", { name: "Fokus node", exact: true }).click();
      await page.getByRole("button", { name: "Fokus node", exact: true }).waitFor();
      modeVisibleCounts.add(await page.getByTestId("visible-counts").innerText());
      assert.equal(await page.getByTestId("canonical-counts").innerText(), canonicalCounts, "focus mode leaves canonical totals unchanged");

      const picker = page.getByLabel("Pilih node fokus", { exact: true });
      await picker.waitFor();
      const selectableValues = await picker.locator("option").evaluateAll(options => options
        .map(option => (option as HTMLOptionElement).value).filter(Boolean));
      assert.ok(selectableValues.length >= 2, "focus picker exposes at least two fixture nodes");
      await picker.selectOption(selectableValues[0]!);
      await picker.focus();
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Enter");
      assert.notEqual(await picker.inputValue(), selectableValues[0], "keyboard navigation selects a different graph node");

      await takeScreenshot(page, `graph-focus-${width}.png`);
      await page.getByRole("button", { name: "Semua referensi", exact: true }).click();
      modeVisibleCounts.add(await page.getByTestId("visible-counts").innerText());
      assert.equal(await page.getByTestId("canonical-counts").innerText(), canonicalCounts, "reference mode leaves canonical totals unchanged");
      assert.ok(modeVisibleCounts.size >= 2, "mode changes alter the visible node/edge counts for the checked-in fixture");

      // Let the new mode finish Cytoscape layout, ResizeObserver fit and React's zoom output.
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      const beforeZoom = await zoomPercent(page);
      await page.getByRole("button", { name: "Perbesar", exact: true }).click();
      await page.waitForFunction(previous => Number(document.querySelector('[aria-label="Tingkat zoom"]')?.textContent?.replace("%", "")) > previous, beforeZoom);
      const largerZoom = await zoomPercent(page);
      assert.ok(largerZoom > beforeZoom);
      await page.getByRole("button", { name: "Perkecil", exact: true }).click();
      await page.waitForFunction(previous => Number(document.querySelector('[aria-label="Tingkat zoom"]')?.textContent?.replace("%", "")) < previous, largerZoom);
      const smallerZoom = await zoomPercent(page);
      assert.ok(smallerZoom < largerZoom);
      await page.getByRole("button", { name: "Perbesar", exact: true }).click();
      const changedZoom = await zoomPercent(page);
      await page.getByRole("button", { name: "Sesuaikan tampilan", exact: true }).click();
      assert.ok(await zoomPercent(page) < changedZoom, "fit control resets the rendered viewport to the graph bounds");

      await takeScreenshot(page, `graph-${width}.png`);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `${width}px page must not overflow horizontally`);

      if (width === 390) {
        const oldNames = fixture.ccm.nodes.map(node => node.name).filter(Boolean);
        const switched404 = page.waitForResponse(response => {
          const url = new URL(response.url());
          return url.pathname === `/api/analyses/${ready!.analysisId}/graph` && response.status() === 404;
        });
        await context.addCookies([{
          name: "sage_session",
          value: other.token,
          url: base,
          httpOnly: true,
          sameSite: "Lax",
        }]);
        await page.evaluate(() => window.dispatchEvent(new Event("focus")));
        await switched404;
        await page.getByRole("alert").filter({ hasText: "Analisis tidak ditemukan." }).waitFor();
        assert.equal(await canvas.count(), 0, "account switch clears the old owner's canvas");
        assert.equal(await page.getByTestId("canonical-counts").count(), 0, "account switch clears old canonical totals");
        const visibleBody = await page.locator("body").innerText();
        for (const oldName of oldNames) assert.ok(!visibleBody.includes(oldName), `account switch must clear old node ${oldName}`);
      }

      assert.deepEqual(pageErrors, [], `${width}px graph route should not throw browser errors`);
      checks.push(`${width}px: real owner graph, modes and count semantics, keyboard node selection, unresolved legend, zoom/fit, screenshot, and no horizontal overflow/page errors`);
      await context.close();
    }
    assert.equal(controlled503Used, true, "first browser load must consume the marked one-off controlled 503 and retry through the real API");
    assert.deepEqual(providerRequests, [], "graph page makes no GitHub/provider requests");
    checks.push("browser-only controlled case: one intercepted 503 exposes retry and then recovers from the real database-backed API");
    checks.push("390px account switch: focus identity recheck replaces A with B, gets real 404, and removes old graph/count data");

    // Keep GraphCanvas's checked-in preview fixture covered too: this route is
    // static/local and must never call the API or a provider.
    const previewContext = await browser.newContext({ viewport: { width: 390, height: 1000 }, reducedMotion: "reduce" });
    const previewPage = await previewContext.newPage();
    const previewProductRequests: string[] = [];
    previewPage.on("pageerror", error => pageErrors.push(`graph preview: ${error.message}`));
    previewPage.on("request", req => {
      const url = new URL(req.url());
      if (url.pathname.startsWith("/api/") || url.hostname === "github.com" || url.hostname === "api.github.com") {
        previewProductRequests.push(req.url());
      }
    });
    await previewPage.goto(`${base}/graph-preview`, { waitUntil: "networkidle" });
    await previewPage.getByText("Fixture tervalidasi · Tidak terhubung ke GitHub", { exact: true }).waitFor();
    await previewPage.getByRole("region", { name: "Kanvas knowledge graph", exact: true }).locator("canvas").first().waitFor();
    assert.deepEqual(previewProductRequests, [], "the graph-preview fixture must render without product/API requests");
    await previewContext.close();
    checks.push("graph-preview shared GraphCanvas renders its local fixture and sends no product/API/provider requests");

    // Reproduce a delayed owner-A response while the real identity endpoint sees
    // owner B. The underlying A graph response is fetched from the real route,
    // held at the browser boundary, then released after focus starts identity
    // refresh. Generation/abort handling must prevent it from restoring A's data.
    const raceContext = await browser.newContext({ viewport: { width: 390, height: 1000 }, reducedMotion: "reduce" });
    await raceContext.addCookies([{
      name: "sage_session", value: owner.token, url: base, httpOnly: true, sameSite: "Lax",
    }]);
    const racePage = await raceContext.newPage();
    racePage.setDefaultTimeout(20_000);
    racePage.on("pageerror", error => pageErrors.push(`delayed identity switch: ${error.message}`));
    let releaseDelayedResponse = () => {};
    let finishDelayedRoute = () => {};
    let signalDelayedRequest = () => {};
    let signalDelayedResponseReady = () => {};
    const delayedResponseGate = new Promise<void>(resolve => { releaseDelayedResponse = resolve; });
    const delayedRouteFinished = new Promise<void>(resolve => { finishDelayedRoute = resolve; });
    const delayedRequestStarted = new Promise<void>(resolve => { signalDelayedRequest = resolve; });
    const delayedResponseReady = new Promise<void>(resolve => { signalDelayedResponseReady = resolve; });
    let holdFirstGraphResponse = true;
    let delayedResponseStatus = 0;
    await racePage.route(`**/api/analyses/${ready.analysisId}/graph`, async route => {
      if (!holdFirstGraphResponse) return route.continue();
      holdFirstGraphResponse = false;
      signalDelayedRequest();
      try {
        const actual = await route.fetch();
        delayedResponseStatus = actual.status();
        signalDelayedResponseReady();
        await delayedResponseGate;
        try { await route.fulfill({ response: actual }); }
        catch { /* The focus identity refresh may abort this original fetch. */ }
      } finally {
        finishDelayedRoute();
      }
    });
    await racePage.goto(graphPageUrl(base, ready.analysisId), { waitUntil: "domcontentloaded" });
    await delayedRequestStarted;
    await delayedResponseReady;
    assert.equal(delayedResponseStatus, 200, "the held owner-A body must come from the real graph API");
    await raceContext.addCookies([{
      name: "sage_session", value: other.token, url: base, httpOnly: true, sameSite: "Lax",
    }]);
    const staleIdentityResponse = racePage.waitForResponse(response => {
      const url = new URL(response.url());
      return url.pathname === "/api/auth/session" && response.request().headers()["x-sage-account"] === owner!.accountKey;
    });
    await racePage.evaluate(() => window.dispatchEvent(new Event("focus")));
    const identityResponse = await staleIdentityResponse;
    assert.equal(identityResponse.status(), 401, "the actual identity endpoint must reject cookie B with page A's account binding");
    const ownerBGraph404 = racePage.waitForResponse(response => {
      const url = new URL(response.url());
      return url.pathname === `/api/analyses/${ready!.analysisId}/graph` &&
        response.request().headers()["x-sage-account"] === other!.accountKey && response.status() === 404;
    });
    releaseDelayedResponse();
    await delayedRouteFinished;
    await ownerBGraph404;
    await racePage.getByRole("alert").filter({ hasText: "Analisis tidak ditemukan." }).waitFor();
    assert.equal(await racePage.getByRole("region", { name: "Kanvas knowledge graph", exact: true }).count(), 0);
    assert.equal(await racePage.getByTestId("canonical-counts").count(), 0);
    const raceBody = await racePage.locator("body").innerText();
    for (const node of fixture.ccm.nodes) assert.ok(!raceBody.includes(node.name), `late owner-A response must not restore ${node.name}`);
    await raceContext.close();
    checks.push("delayed owner-A graph response: real owner-B session mismatch triggers reload/404 and stale response never restores the old canvas");

    const emptyContext = await browser.newContext({ viewport: { width: 390, height: 1000 } });
    await emptyContext.addCookies([{
      name: "sage_session", value: owner.token, url: base, httpOnly: true, sameSite: "Lax",
    }]);
    const emptyPage = await emptyContext.newPage();
    emptyPage.on("pageerror", error => pageErrors.push(`empty graph: ${error.message}`));
    await emptyPage.goto(graphPageUrl(base, empty.analysisId), { waitUntil: "networkidle" });
    await emptyPage.getByRole("region", { name: "Kanvas knowledge graph", exact: true }).waitFor();
    await emptyPage.getByTestId("canonical-counts").waitFor();
    assert.match(await emptyPage.getByTestId("canonical-counts").innerText(), /Kanonik:\s*0 node\s*·\s*0 relasi/);
    await takeScreenshot(emptyPage, "graph-empty-390.png");
    await emptyContext.close();
    checks.push("390px empty graph: zero-node canonical graph renders without a client error");

    assert.deepEqual(pageErrors, [], "all graph browser pages should complete without uncaught errors");
    assert.deepEqual(providerRequests, [], "no browser path should contact GitHub or provider routes");
  } catch (error) {
    reportStatus = "FAIL";
    reportError = error instanceof Error ? error.message : "Live graph regression failed.";
    failures.push(reportError);
  } finally {
    await browser?.close().catch(() => undefined);
    await api?.dispose().catch(() => undefined);
    try {
      if (storageObjectIds.length) await db.storageObject.deleteMany({ where: { id: { in: storageObjectIds } } });
      if (analysisIds.length) {
        await db.graphBundle.deleteMany({ where: { analysisId: { in: analysisIds }, ownerUserId: { in: users } } });
        await db.analysis.deleteMany({ where: { id: { in: analysisIds }, ownerUserId: { in: users } } });
      }
      if (sessionIds.length) await db.session.deleteMany({ where: { id: { in: sessionIds } } });
      if (users.length) await db.gitHubConnection.deleteMany({ where: { userId: { in: users } } });
      if (users.length) await db.user.deleteMany({ where: { id: { in: users } } });
      if (repositoryId) await db.repository.deleteMany({ where: { id: repositoryId } });
    } catch (cleanupError) {
      reportStatus = "FAIL";
      const message = cleanupError instanceof Error ? cleanupError.message : "Fixture cleanup failed.";
      failures.push(`cleanup: ${message}`);
      reportError = reportError ? `${reportError}; cleanup: ${message}` : `cleanup: ${message}`;
    }
    for (const folder of createdFolders) {
      try { await rm(folder, { recursive: true, force: true }); }
      catch (cleanupError) {
        reportStatus = "FAIL";
        const message = cleanupError instanceof Error ? cleanupError.message : "Archive cleanup failed.";
        failures.push(`archive cleanup: ${message}`);
        reportError = reportError ? `${reportError}; archive cleanup: ${message}` : `archive cleanup: ${message}`;
      }
    }
    await db.$disconnect().catch(() => undefined);
    await mkdir(resultDir, { recursive: true });
    const report = {
      checkedAt: new Date().toISOString(),
      status: reportStatus,
      checks,
      failures,
      browserPageErrors: pageErrors,
      providerRequests: providerRequests.length,
      viewports: [...viewports],
      sourceFixture: "tests/fixtures/resolver/typescript/src/model.ts + endpoint.ts via @sage/analyzer-js analyzeReferences",
      fixtureEvidence: ready ? {
        snapshot: ready.snapshot,
        ckgSha256: ready.canonical.sha256,
        canonicalCounts: ready.canonical.value.counts,
      } : null,
      seedScope: "Direct test database seed of canonical GraphBundle and SOURCE_ARCHIVE; this is not the actual nine-stage pipeline or worker publication.",
      controlledCase: "The first 360px browser graph request receives one explicitly intercepted 503; retry continues to the genuine Next/Postgres API.",
      delayedIdentityCase: "A genuine owner-A graph API response is held in Playwright while the genuine session endpoint rejects cookie B with the stale A account binding; A's delayed response is then released and must not restore graph data.",
      storageRoot: "Dedicated private temporary fixture root; only script-created snapshot-* folders are removed.",
      ...(reportError ? { error: reportError } : {}),
    };
    await writeFile(join(resultDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify({ status: reportStatus, checks: checks.length, failures, viewports: viewports.length, artifactDir: resultDir }));
  }
  if (reportStatus === "FAIL") process.exitCode = 1;
}

if (!enabled) {
  console.log("SKIP live graph regression: set SAGE_GRAPH_TESTS=1 to opt in.");
} else {
  await runLiveGraphRegression();
}
