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
 * Destructive integration regression for the live graph, filter, inspector, and source paths.
 *
 * Run only against the dedicated database and private temporary STORAGE_ROOT,
 * with a real Next server using that same STORAGE_ROOT:
 *   SAGE_GRAPH_TESTS=1 DATABASE_URL=postgresql://sage@sage-graph17-db:5432/sage_graph17 \
 *   STORAGE_ROOT=/tmp/sage-graph17-storage SAGE_GRAPH_BASE_URL=http://127.0.0.1:3000 \
 *   npx tsx scripts/test-live-graph.ts
 *
 * The fixture uses real Postgres rows, session cookies, graph/inspector/source
 * HTTP routes, and the browser UI. It directly seeds terminal CKG/archive rows
 * for stable page tests; that does not exercise the nine-stage worker pipeline
 * or worker publication. No OAuth connection or provider token is created.
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

type SourceFileMetadata = {
  id: string;
  path: string;
  sha256: string;
  sizeBytes: number;
};

type InspectorNode = Omit<CcmV1["nodes"][number], "attributes">;

type NodeDetailData = {
  analysisId: string;
  accountKey: string;
  ckgSha256: string;
  configurationHash: string;
  snapshot: CcmSnapshot;
  node: InspectorNode;
  incoming: { edge: CcmV1["edges"][number]; peer: InspectorNode }[];
  outgoing: { edge: CcmV1["edges"][number]; peer: InspectorNode }[];
  files: SourceFileMetadata[];
};

type SourceData = {
  analysisId: string;
  accountKey: string;
  ckgSha256: string;
  configurationHash: string;
  snapshot: CcmSnapshot;
  file: SourceFileMetadata;
  startLine: number;
  endLine: number;
  totalLines: number;
  text: string;
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
  if (existing.length > 0) throw new Error("STORAGE_ROOT must be an empty private live-graph fixture directory.");
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

function assertPrivateAccountResponse(response: APIResponse): void {
  const headers = response.headers();
  assert.match(headers["cache-control"] ?? "", /private,\s*no-store/i);
  assert.match(headers["vary"] ?? "", /Cookie/i);
  assert.match(headers["vary"] ?? "", /X-SAGE-Account/i);
  assert.equal(headers["x-content-type-options"], "nosniff");
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

function nodeDetailUrl(base: string, analysisId: string, nodeId: string): string {
  return `${base}/api/analyses/${encodeURIComponent(analysisId)}/nodes/${encodeURIComponent(nodeId)}`;
}

function sourceUrl(base: string, analysisId: string, fileId: string, startLine: number, endLine: number): string {
  const query = new URLSearchParams({ startLine: String(startLine), endLine: String(endLine) });
  return `${base}/api/analyses/${encodeURIComponent(analysisId)}/files/${encodeURIComponent(fileId)}/source?${query}`;
}

function sourceFileId(path: string, fileSha256: string): string {
  return `file-${digest(`${path}\0${fileSha256}`)}`;
}

function lineCount(text: string): number {
  return text.split(/\r\n|\r|\n/).length;
}

function canonicalFileMetadata(ccm: CcmV1, path: string): SourceFileMetadata {
  const file = ccm.files.find(candidate => candidate.path === path);
  assert.ok(file, `canonical CKG must include processed source ${path}`);
  assert.equal(file.status, "processed", `source access is limited to processed canonical file ${path}`);
  return {
    id: sourceFileId(file.path, file.sha256),
    path: file.path,
    sha256: file.sha256,
    sizeBytes: file.sizeBytes,
  };
}

function compareByEdgeId<T extends { edge: { id: string } }>(left: T, right: T): number {
  return left.edge.id.localeCompare(right.edge.id);
}

function inspectorNode(node: CcmV1["nodes"][number]): InspectorNode {
  const { attributes, ...safeNode } = node;
  void attributes;
  return safeNode;
}

function expectedGraphFilter(
  graph: ReturnType<typeof projectCcmForGraph>,
  query: string,
  selectedKinds: readonly string[] = [],
): { nodes: typeof graph.nodes; edges: typeof graph.edges } {
  const normalizedQuery = query.trim().toLowerCase();
  const allowedKinds = new Set(selectedKinds);
  const nodes = graph.nodes.filter(node =>
    (allowedKinds.size === 0 || allowedKinds.has(node.kind)) &&
    (!normalizedQuery || [node.name, node.kind, node.qualifiedName, node.filePath ?? ""]
      .some(value => value.toLowerCase().includes(normalizedQuery))));
  const nodeIds = new Set(nodes.map(node => node.id));
  const edges = graph.edges.filter(edge => nodeIds.has(edge.source) && nodeIds.has(edge.target));
  return { nodes, edges };
}

async function assertDisplayedGraphCounts(
  page: Page,
  testId: string,
  expected: { nodes: readonly unknown[]; edges: readonly unknown[] },
): Promise<void> {
  const expectedNodes = expected.nodes.length;
  const expectedEdges = expected.edges.length;
  await page.waitForFunction(({ id, nodes, edges }) => {
    const text = document.querySelector(`[data-testid="${id}"]`)?.textContent ?? "";
    const counts = text.match(/(\d+)\s+node\s*·\s*(\d+)\s+relasi/);
    return !!counts && Number(counts[1]) === nodes && Number(counts[2]) === edges;
  }, { id: testId, nodes: expectedNodes, edges: expectedEdges }, { timeout: 5_000 });
  const text = await page.getByTestId(testId).innerText();
  const counts = text.match(/(\d+)\s+node\s*·\s*(\d+)\s+relasi/);
  assert.ok(counts, `${testId} should show a node and edge count pair; received: ${text}`);
  assert.equal(Number(counts[1]), expectedNodes, `${testId} node count should match; received: ${text}`);
  assert.equal(Number(counts[2]), expectedEdges, `${testId} edge count should match; received: ${text}`);
}

async function clickCanvasNode(page: Page): Promise<string> {
  const canvas = page.getByRole("region", { name: "Kanvas knowledge graph", exact: true });
  const bounds = await canvas.boundingBox();
  assert.ok(bounds, "knowledge graph canvas must have a visible hit area");
  const inspector = page.getByTestId("node-inspector");
  assert.equal(await inspector.count(), 0, "close the inspector before testing a new explicit canvas pick");
  const xFractions = [0.18, 0.34, 0.5, 0.66, 0.82];
  const yFractions = [0.12, 0.25, 0.38, 0.5, 0.62, 0.75, 0.88];
  for (const yFraction of yFractions) {
    for (const xFraction of xFractions) {
      await page.mouse.click(bounds.x + bounds.width * xFraction, bounds.y + bounds.height * yFraction);
      try {
        await page.waitForFunction(() => Boolean(document.querySelector('[data-testid="node-inspector"]')?.getAttribute("data-node-id")), undefined, { timeout: 200 });
        const selectedId = await inspector.getAttribute("data-node-id");
        if (selectedId) return selectedId;
      } catch { /* This point did not hit a rendered graph node. */ }
    }
  }
  throw new Error("Could not select a rendered graph node by clicking the canvas.");
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

    const canonicalCcm = ready.canonical.value.ccm;
    const endpointNode = canonicalCcm.nodes.find(node => node.kind === "Class" && node.name === "Endpoint");
    assert.ok(endpointNode?.location, "fixture Endpoint class must have an exact declaration location");
    const nodeDetailPath = nodeDetailUrl(base, ready.analysisId, endpointNode.id);
    const nodeDetailResponse = await api.get(nodeDetailPath, { headers: cookieHeader(owner) });
    assert.equal(nodeDetailResponse.status(), 200);
    assertPrivateAccountResponse(nodeDetailResponse);
    const nodeDetailBody = await nodeDetailResponse.json() as { data: NodeDetailData };
    const nodeDetail = nodeDetailBody.data;
    assert.equal(nodeDetail.analysisId, ready.analysisId);
    assert.equal(nodeDetail.accountKey, owner.accountKey);
    assert.equal(nodeDetail.ckgSha256, ready.canonical.sha256);
    assert.equal(nodeDetail.configurationHash, configurationHash);
    assert.deepEqual(nodeDetail.snapshot, fixture.snapshot);
    assert.deepEqual(nodeDetail.node, inspectorNode(endpointNode), "inspector must return the exact canonical node fields and evidence location without internal attributes");
    const canonicalNodes = new Map(canonicalCcm.nodes.map(node => [node.id, node]));
    const expectedIncoming = canonicalCcm.edges
      .filter(edge => edge.targetId === endpointNode.id)
      .map(edge => ({ edge, peer: inspectorNode(canonicalNodes.get(edge.sourceId)!) }))
      .sort(compareByEdgeId);
    const expectedOutgoing = canonicalCcm.edges
      .filter(edge => edge.sourceId === endpointNode.id)
      .map(edge => ({ edge, peer: inspectorNode(canonicalNodes.get(edge.targetId)!) }))
      .sort(compareByEdgeId);
    assert.ok(expectedIncoming.length > 0 && expectedOutgoing.length > 0, "Endpoint fixture must exercise canonical incoming and outgoing edges");
    assert.ok([...expectedIncoming, ...expectedOutgoing].some(item => item.edge.evidence.length > 0), "fixture relations must carry evidence spans");
    assert.deepEqual([...nodeDetail.incoming].sort(compareByEdgeId), expectedIncoming, "inspector incoming relations preserve full canonical evidence and peer nodes");
    assert.deepEqual([...nodeDetail.outgoing].sort(compareByEdgeId), expectedOutgoing, "inspector outgoing relations preserve full canonical evidence and peer nodes");
    const relevantPaths = new Set([
      endpointNode.location.filePath,
      ...[...expectedIncoming, ...expectedOutgoing].flatMap(item => item.edge.evidence.map(span => span.filePath)),
    ]);
    const expectedNodeFiles = [...relevantPaths]
      .sort()
      .map(path => canonicalFileMetadata(canonicalCcm, path));
    assert.deepEqual([...nodeDetail.files].sort((left, right) => left.path.localeCompare(right.path)), expectedNodeFiles,
      "inspector source actions are limited to canonical processed files that back this node and its direct relations");
    assert.doesNotMatch(JSON.stringify(nodeDetailBody), /RESOLVER_TS_FIXTURE_MUST_NOT_EXECUTE/);
    checks.push("real API: node inspector returns exact canonical declaration location/hash, in/out peers, relation evidence, and only directly evidenced source files");

    const sourcePath = endpointNode.location.filePath;
    const endpointFile = canonicalFileMetadata(canonicalCcm, sourcePath);
    assert.match(endpointFile.id, /^file-[0-9a-f]{64}$/);
    const exactSourceReads: string[] = [];
    for (const [path, bytes] of Object.entries(ready.sourceBytes)) {
      const file = canonicalFileMetadata(canonicalCcm, path);
      const originalText = Buffer.from(bytes).toString("utf8");
      assert.equal(file.sha256, digest(bytes), `${path} canonical SHA-256 must match the archived snapshot bytes`);
      assert.equal(file.sizeBytes, bytes.byteLength, `${path} canonical byte length must match the archived snapshot bytes`);
      const totalLines = lineCount(originalText);
      const sourceResponse: APIResponse = await api.get(sourceUrl(base, ready.analysisId, file.id, 1, totalLines), { headers: cookieHeader(owner) });
      assert.equal(sourceResponse.status(), 200, `${path} snapshot source should be available to its owner`);
      assertPrivateAccountResponse(sourceResponse);
      const sourceBody = await sourceResponse.json() as { data: SourceData };
      const source = sourceBody.data;
      assert.equal(source.analysisId, ready.analysisId);
      assert.equal(source.accountKey, owner.accountKey);
      assert.equal(source.ckgSha256, ready.canonical.sha256);
      assert.equal(source.configurationHash, configurationHash);
      assert.deepEqual(source.snapshot, fixture.snapshot);
      assert.deepEqual(source.file, file, `${path} source metadata must use the opaque canonical file ID and original hash`);
      assert.equal(source.startLine, 1);
      assert.equal(source.endLine, totalLines);
      assert.equal(source.totalLines, totalLines);
      assert.equal(source.text, originalText, `${path} source must be the exact UTF-8 snapshot text, including original line endings`);
      assert.equal(digest(Buffer.from(source.text, "utf8")), file.sha256, `${path} returned text hash must verify against canonical CKG`);
      exactSourceReads.push(path);
    }
    const endpointText = Buffer.from(ready.sourceBytes[sourcePath]!).toString("utf8");
    assert.equal(endpointText.charCodeAt(0), 0xfeff, "fixture source proves the BOM is preserved");
    assert.match(endpointText, /\r\n/, "fixture source proves CRLF is preserved");
    assert.match(endpointText, /café/, "fixture source proves Unicode is preserved");
    checks.push(`real API: safe source file IDs and exact line/hash/text verified against both immutable snapshot files (${exactSourceReads.join(", ")})`);

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

    const endpointSourceText = Buffer.from(ready.sourceBytes[sourcePath]!).toString("utf8");
    const endpointTotalLines = lineCount(endpointSourceText);
    const endpointSourcePath = sourceUrl(base, ready.analysisId, endpointFile.id, 1, endpointTotalLines);
    for (const [label, path] of [["node inspector", nodeDetailPath], ["source", endpointSourcePath]] as const) {
      const anonymousDetail: APIResponse = await api.get(path);
      assert.equal(anonymousDetail.status(), 401, `${label} requires an authenticated session`);
      assert.equal((await anonymousDetail.json() as ApiErrorBody).error?.code, "AUTH_REQUIRED");
      const staleDetail: APIResponse = await api.get(path, {
        headers: { Cookie: `sage_session=${owner.token}`, "X-SAGE-Account": other.accountKey },
      });
      assert.equal(staleDetail.status(), 401, `${label} rejects a stale account binding`);
      assert.equal((await staleDetail.json() as ApiErrorBody).error?.code, "AUTH_REQUIRED");
      const foreignDetail: APIResponse = await api.get(path, { headers: cookieHeader(other) });
      assert.equal(foreignDetail.status(), 404, `${label} hides an owner's private snapshot from another account`);
      assert.equal((await foreignDetail.json() as ApiErrorBody).error?.code, "ANALYSIS_NOT_FOUND");
    }
    const missingNode = await api.get(nodeDetailUrl(base, ready.analysisId, `node_${"0".repeat(64)}`), { headers: cookieHeader(owner) });
    assert.equal(missingNode.status(), 404);
    assert.equal((await missingNode.json() as ApiErrorBody).error?.code, "NODE_NOT_FOUND");
    const malformedNode = await api.get(nodeDetailUrl(base, ready.analysisId, "bad-node-id"), { headers: cookieHeader(owner) });
    assert.equal(malformedNode.status(), 400);
    assert.equal((await malformedNode.json() as ApiErrorBody).error?.code, "INVALID_INPUT");
    const unknownNodeQuery = await api.get(`${nodeDetailPath}?unexpected=1`, { headers: cookieHeader(owner) });
    assert.equal(unknownNodeQuery.status(), 400);
    assert.equal((await unknownNodeQuery.json() as ApiErrorBody).error?.code, "INVALID_INPUT");
    const missingFile = await api.get(sourceUrl(base, ready.analysisId, `file-${"0".repeat(64)}`, 1, 1), { headers: cookieHeader(owner) });
    assert.equal(missingFile.status(), 404);
    assert.equal((await missingFile.json() as ApiErrorBody).error?.code, "FILE_NOT_FOUND");
    const malformedFile = await api.get(sourceUrl(base, ready.analysisId, "bad-file-id", 1, 1), { headers: cookieHeader(owner) });
    assert.equal(malformedFile.status(), 400);
    assert.equal((await malformedFile.json() as ApiErrorBody).error?.code, "INVALID_INPUT");
    for (const query of ["startLine=0&endLine=1", "startLine=1&endLine=201", "startLine=1&endLine=1&unexpected=1"]) {
      const invalidSourceQuery: APIResponse = await api.get(`${base}/api/analyses/${ready.analysisId}/files/${endpointFile.id}/source?${query}`, { headers: cookieHeader(owner) });
      assert.equal(invalidSourceQuery.status(), 400, `invalid source query should be rejected: ${query}`);
      assert.equal((await invalidSourceQuery.json() as ApiErrorBody).error?.code, "INVALID_INPUT");
    }
    const missingNodeAnalysis = await api.get(nodeDetailUrl(base, "missing-graph-17", endpointNode.id), { headers: cookieHeader(owner) });
    assert.equal(missingNodeAnalysis.status(), 404);
    assert.equal((await missingNodeAnalysis.json() as ApiErrorBody).error?.code, "ANALYSIS_NOT_FOUND");
    const missingFileAnalysis = await api.get(sourceUrl(base, "missing-graph-17", endpointFile.id, 1, 1), { headers: cookieHeader(owner) });
    assert.equal(missingFileAnalysis.status(), 404);
    assert.equal((await missingFileAnalysis.json() as ApiErrorBody).error?.code, "ANALYSIS_NOT_FOUND");
    const runningNode = await api.get(nodeDetailUrl(base, runningId, endpointNode.id), { headers: cookieHeader(other) });
    assert.equal(runningNode.status(), 409);
    assert.equal((await runningNode.json() as ApiErrorBody).error?.code, "RESULT_NOT_READY");
    const runningSource = await api.get(sourceUrl(base, runningId, endpointFile.id, 1, 1), { headers: cookieHeader(other) });
    assert.equal(runningSource.status(), 409);
    assert.equal((await runningSource.json() as ApiErrorBody).error?.code, "RESULT_NOT_READY");
    for (const [label, path, code] of [
      ["node inspector", nodeDetailUrl(base, noBundleId, endpointNode.id), "NODE_INSPECTOR_UNAVAILABLE"],
      ["source", sourceUrl(base, noBundleId, endpointFile.id, 1, 1), "SOURCE_UNAVAILABLE"],
    ] as const) {
      const unavailable: APIResponse = await api.get(path, { headers: cookieHeader(owner) });
      assert.equal(unavailable.status(), 503, `${label} without its canonical graph/archive is unavailable`);
      const body = await unavailable.text();
      assert.match(body, new RegExp(code));
      noSensitiveErrorData(body, [owner.token, other.token, owner.syntheticProviderToken, other.syntheticProviderToken, endpointSourceText, storageRoot]);
    }
    checks.push("real API: inspector/source enforce 401 stale/anonymous, foreign/missing 404, RUNNING 409, unavailable 503, malformed/unknown query 400, and missing node/file 404");

    const invalidNode = canonicalCcm.nodes.find(node => node.origin === "unresolved");
    assert.ok(invalidNode, "fixture must contain an unresolved placeholder for source authorization checks");
    const unresolvedDetailResponse = await api.get(nodeDetailUrl(base, ready.analysisId, invalidNode.id), { headers: cookieHeader(owner) });
    assert.equal(unresolvedDetailResponse.status(), 200);
    const unresolvedDetail = (await unresolvedDetailResponse.json() as { data: NodeDetailData }).data;
    assert.equal(unresolvedDetail.node.location, null, "unresolved placeholders have no declaration location");
    assert.equal(unresolvedDetail.node.filePath, null, "unresolved placeholders do not claim a source file");
    checks.push("real API: unresolved placeholder has no declaration source location");

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
      const unavailableNode = await api.get(nodeDetailPath, { headers: cookieHeader(owner) });
      assert.equal(unavailableNode.status(), 503);
      const unavailableNodeText = await unavailableNode.text();
      assert.match(unavailableNodeText, /NODE_INSPECTOR_UNAVAILABLE/);
      noSensitiveErrorData(unavailableNodeText, [owner.token, other.token, owner.syntheticProviderToken, other.syntheticProviderToken, endpointSourceText, ready.archive.storageKey, storageRoot]);
      const unavailableSource = await api.get(endpointSourcePath, { headers: cookieHeader(owner) });
      assert.equal(unavailableSource.status(), 503);
      const unavailableSourceText = await unavailableSource.text();
      assert.match(unavailableSourceText, /SOURCE_UNAVAILABLE/);
      noSensitiveErrorData(unavailableSourceText, [owner.token, other.token, owner.syntheticProviderToken, other.syntheticProviderToken, endpointSourceText, ready.archive.storageKey, storageRoot]);
    } finally {
      await writeFile(ready.archive.archivePath, ready.archive.bytes, { mode: 0o600 });
    }
    assert.equal((await api.get(baseGraphPath, { headers: cookieHeader(owner) })).status(), 200, "restored source archive must recover");
    assert.equal((await api.get(nodeDetailPath, { headers: cookieHeader(owner) })).status(), 200, "restored archive recovers node details");
    assert.equal((await api.get(endpointSourcePath, { headers: cookieHeader(owner) })).status(), 200, "restored archive recovers source slices");
    checks.push("real API: corrupt immutable source archive makes graph/node/source safe 503 without leaks and recovers after restoration");

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
      const pageGraphRequests: string[] = [];
      const pageNodeRequests: string[] = [];
      const pageSourceRequests: string[] = [];
      page.on("pageerror", error => pageErrors.push(`${width}px: ${error.message}`));
      page.on("request", req => {
        const url = new URL(req.url());
        if (url.pathname === `/api/analyses/${ready!.analysisId}/graph`) pageGraphRequests.push(url.pathname + url.search);
        if (url.pathname.startsWith(`/api/analyses/${ready!.analysisId}/nodes/`)) pageNodeRequests.push(url.pathname + url.search);
        if (url.pathname.startsWith(`/api/analyses/${ready!.analysisId}/files/`) && url.pathname.endsWith("/source")) pageSourceRequests.push(url.pathname + url.search);
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
      const keyboardSelectedId = await picker.inputValue();
      await page.waitForFunction(id => document.querySelector('[data-testid="node-inspector"]')?.getAttribute("data-node-id") === id, keyboardSelectedId);
      assert.equal(await page.getByTestId("node-inspector").getAttribute("data-node-id"), keyboardSelectedId,
        "keyboard selection through the existing focus picker opens the matching node inspector");

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
        const kinds = [...new Set(data.graph.nodes.map(node => node.kind))].sort();
        const kindGroup = page.getByRole("group", { name: "Jenis node AST", exact: true });
        const renderedKinds = await kindGroup.locator('input[type="checkbox"]').evaluateAll(inputs => inputs
          .map(input => (input as HTMLInputElement).labels?.[0]?.textContent?.trim() ?? "")
          .filter(Boolean)
          .sort());
        assert.deepEqual(renderedKinds, kinds, "AST kind choices must reflect the kinds present in this canonical graph");

        await page.getByRole("button", { name: "Ikhtisar", exact: true }).click();
        const graphRequestsBeforeFilter = pageGraphRequests.length;
        const queryInput = page.getByLabel("Cari node", { exact: true });
        await queryInput.focus();
        await page.keyboard.type("Endpoint");
        assert.equal(await queryInput.inputValue(), "Endpoint", "the mobile-width query field accepts keyboard input");
        const queryMatches = expectedGraphFilter(data.graph, "Endpoint");
        assert.ok(queryMatches.nodes.some(node => node.kind === "Class"), "fixture query should match its Endpoint class");
        assert.ok(queryMatches.nodes.some(node => node.kind !== "Class"), "fixture query should also match a non-Class node before the kind filter");
        await assertDisplayedGraphCounts(page, "query-filter-counts", queryMatches);
        await assertDisplayedGraphCounts(page, "filtered-counts", queryMatches);
        await assertDisplayedGraphCounts(page, "visible-counts", queryMatches);

        const focusPicker = page.getByLabel("Pilih node fokus", { exact: true });
        const queryChoiceIds = await focusPicker.locator("option").evaluateAll(options => options
          .map(option => (option as HTMLOptionElement).value).filter(Boolean).sort());
        assert.deepEqual(queryChoiceIds, queryMatches.nodes.map(node => node.id).sort(), "focus choices should match the query result");

        const classCheckbox = page.getByLabel("Class", { exact: true });
        await classCheckbox.focus();
        await page.keyboard.press("Space");
        assert.equal(await classCheckbox.isChecked(), true, "the AST kind filter can be enabled from the keyboard");
        const combinedMatches = expectedGraphFilter(data.graph, "Endpoint", ["Class"]);
        assert.ok(combinedMatches.nodes.length < queryMatches.nodes.length, "the AST kind filter must narrow the query result");
        assert.ok(combinedMatches.nodes.every(node => node.kind === "Class"));
        await assertDisplayedGraphCounts(page, "query-filter-counts", combinedMatches);
        await assertDisplayedGraphCounts(page, "filtered-counts", combinedMatches);
        await assertDisplayedGraphCounts(page, "visible-counts", combinedMatches);
        const combinedChoiceIds = await focusPicker.locator("option").evaluateAll(options => options
          .map(option => (option as HTMLOptionElement).value).filter(Boolean).sort());
        assert.deepEqual(combinedChoiceIds, combinedMatches.nodes.map(node => node.id).sort(), "focus choices should match the combined query and kind result");
        assert.equal(await page.getByTestId("canonical-counts").innerText(), canonicalCounts, "query and kind filters cannot change canonical counts");
        await takeScreenshot(page, "graph-filter-390.png");

        const noResultQuery = `__issue18-no-match-${randomUUID()}__`;
        await queryInput.fill("");
        await queryInput.focus();
        await page.keyboard.type(noResultQuery);
        assert.equal(await queryInput.inputValue(), noResultQuery);
        const noMatches = expectedGraphFilter(data.graph, noResultQuery, ["Class"]);
        await page.getByRole("status").filter({ hasText: "Tidak ada node yang sesuai dengan kueri dan jenis node yang dipilih." }).waitFor();
        await assertDisplayedGraphCounts(page, "query-filter-counts", noMatches);
        await assertDisplayedGraphCounts(page, "filtered-counts", noMatches);
        await assertDisplayedGraphCounts(page, "visible-counts", noMatches);
        const noResultChoiceIds = await focusPicker.locator("option").evaluateAll(options => options
          .map(option => (option as HTMLOptionElement).value).filter(Boolean).sort());
        assert.deepEqual(noResultChoiceIds, [], "no-result state must offer no focus node choices");
        assert.equal(await zoomPercent(page), 100, "empty filtered graph displays the default zoom percentage");
        const zoomIn = page.getByRole("button", { name: "Perbesar", exact: true });
        const zoomOut = page.getByRole("button", { name: "Perkecil", exact: true });
        const fitGraph = page.getByRole("button", { name: "Sesuaikan tampilan", exact: true });
        assert.equal(await zoomIn.isDisabled(), true, "zoom in is disabled when filtering produces no graph nodes");
        assert.equal(await zoomOut.isDisabled(), true, "zoom out is disabled when filtering produces no graph nodes");
        assert.equal(await fitGraph.isDisabled(), true, "fit is disabled when filtering produces no graph nodes");
        await takeScreenshot(page, "graph-filter-empty-390.png");

        const resetButton = page.getByRole("button", { name: "Atur ulang filter", exact: true });
        await resetButton.focus();
        await page.keyboard.press("Enter");
        assert.equal(await queryInput.inputValue(), "", "keyboard reset clears the query");
        assert.equal(await classCheckbox.isChecked(), false, "keyboard reset clears selected kinds");
        await assertDisplayedGraphCounts(page, "query-filter-counts", { nodes: data.graph.nodes, edges: data.graph.edges });
        await assertDisplayedGraphCounts(page, "filtered-counts", { nodes: data.graph.nodes, edges: data.graph.edges });
        await assertDisplayedGraphCounts(page, "visible-counts", { nodes: data.graph.nodes, edges: data.graph.edges });
        const resetChoiceIds = await focusPicker.locator("option").evaluateAll(options =>
          options.map(option => (option as HTMLOptionElement).value).filter(Boolean).sort());
        assert.deepEqual(resetChoiceIds, data.graph.nodes.map(node => node.id).sort(), "reset restores every canonical focus choice");
        assert.equal(await page.getByTestId("canonical-counts").innerText(), canonicalCounts, "reset leaves canonical counts unchanged");
        assert.equal(await zoomIn.isEnabled(), true, "zoom in is enabled again after reset restores graph nodes");
        assert.equal(await zoomOut.isEnabled(), true, "zoom out is enabled again after reset restores graph nodes");
        assert.equal(await fitGraph.isEnabled(), true, "fit is enabled again after reset restores graph nodes");
        assert.equal(pageGraphRequests.length, graphRequestsBeforeFilter, "query, kind filtering, no-result, and reset stay client-side");

        const unchangedGraph = await readFixtureGraph(api, base, ready.analysisId, owner);
        assert.equal(unchangedGraph.response.status(), 200);
        assert.deepEqual(unchangedGraph.body.data, success.body.data, "filtering leaves the immutable original API result unchanged");
        checks.push("390px: keyboard query AND AST kind filter, consistent counts/focus choices, no-result and reset, unchanged canonical API result");

        const uiPicker = page.getByTestId("graph-node-picker");
        await uiPicker.selectOption(endpointNode.id);
        const inspector = page.getByTestId("node-inspector");
        await page.waitForFunction(id => document.querySelector('[data-testid="node-inspector"]')?.getAttribute("data-node-id") === id, endpointNode.id);
        await page.getByTestId("node-inspector-source").first().waitFor();
        assert.equal(await inspector.getAttribute("data-node-id"), endpointNode.id);
        assert.equal((await page.getByTestId("node-inspector-title").innerText()).trim(), endpointNode.name);
        const inspectorText = await inspector.innerText();
        assert.ok(inspectorText.includes(endpointNode.location.filePath), "inspector displays the canonical source path");
        for (const relation of expectedIncoming) assert.ok((await page.getByTestId("node-inspector-incoming").innerText()).includes(relation.peer.name));
        for (const relation of expectedOutgoing) assert.ok((await page.getByTestId("node-inspector-outgoing").innerText()).includes(relation.peer.name));
        await takeScreenshot(page, "graph-inspector-390.png");

        const sourceTrigger = page.getByTestId("node-inspector-source").first();
        await sourceTrigger.focus();
        const sourceResponse = page.waitForResponse(response => {
          const url = new URL(response.url());
          return url.pathname.endsWith(`/files/${endpointFile.id}/source`) && response.status() === 200;
        });
        await page.keyboard.press("Enter");
        await sourceResponse;
        const sourceDialog = page.getByTestId("node-source-dialog");
        await sourceDialog.waitFor();
        const sourceDialogText = await sourceDialog.innerText();
        assert.ok(sourceDialogText.includes(endpointFile.path), "source dialog identifies its repository-relative path");
        assert.ok(sourceDialogText.includes(endpointFile.sha256), "source dialog identifies the exact canonical file hash");
        assert.ok(sourceDialogText.includes("export class Endpoint extends Base implements Payload"), "source dialog renders the snapshot declaration");
        const sourceEvidenceLine = sourceDialog.locator(`[data-source-line="${endpointNode.location.startLine}"]`);
        assert.ok((await sourceEvidenceLine.innerText()).includes("export class Endpoint extends Base implements Payload"), "source dialog labels and highlights the canonical AST evidence line");
        assert.ok(await sourceEvidenceLine.getAttribute("class"), "source evidence line has its highlight class");
        await takeScreenshot(page, "graph-source-390.png");
        await page.keyboard.press("Escape");
        await sourceDialog.waitFor({ state: "hidden" });
        await page.waitForFunction(() => document.activeElement?.getAttribute("data-testid") === "node-inspector-source");
        assert.equal(await sourceTrigger.evaluate(element => document.activeElement === element), true, "Escape returns focus to the source evidence trigger");

        const sourceRequestsBeforeUnresolved = pageSourceRequests.length;
        const unresolvedNodeResponse = page.waitForResponse(response => {
          const url = new URL(response.url());
          return url.pathname === `/api/analyses/${ready!.analysisId}/nodes/${invalidNode.id}` && response.status() === 200;
        });
        await uiPicker.selectOption(invalidNode.id);
        await unresolvedNodeResponse;
        await page.waitForFunction(id => document.querySelector('[data-testid="node-inspector"]')?.getAttribute("data-node-id") === id, invalidNode.id);
        assert.equal(await page.getByTestId("node-inspector-source").count(), 0, "unresolved placeholder has no declaration source action");
        assert.equal(pageSourceRequests.length, sourceRequestsBeforeUnresolved, "selecting an unresolved placeholder does not request source text");

        await uiPicker.selectOption(endpointNode.id);
        await page.waitForFunction(id => document.querySelector('[data-testid="node-inspector"]')?.getAttribute("data-node-id") === id, endpointNode.id);
        const restoredSourceTrigger = page.getByTestId("node-inspector-source").first();
        await restoredSourceTrigger.click();
        const restoredDialog = page.getByTestId("node-source-dialog");
        await restoredDialog.waitFor();
        await restoredDialog.getByText("export class Endpoint extends Base implements Payload", { exact: false }).waitFor();

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
        assert.equal(await page.getByTestId("node-inspector").count(), 0, "account switch removes the old inspector");
        assert.equal(await page.getByTestId("node-source-dialog").isVisible(), false, "account switch closes the old source dialog");
        const visibleBody = await page.locator("body").innerText();
        for (const oldName of oldNames) assert.ok(!visibleBody.includes(oldName), `account switch must clear old node ${oldName}`);
        assert.ok(!visibleBody.includes("export class Endpoint extends Base implements Payload"), "account switch removes old snapshot source text");
        assert.ok(pageNodeRequests.some(path => path.endsWith(`/nodes/${endpointNode.id}`)), "focus-picker selection must fetch node details");
        assert.ok(pageSourceRequests.some(path => path.includes(`/files/${endpointFile.id}/source?`)), "opening source evidence must fetch the selected snapshot file");
        checks.push("390px: focus-picker node selection opens canonical inspector, source dialog preserves snapshot text and Escape focus, unresolved selection makes no source request, and account switch clears inspector/source");
      }

      if (width === 1440) {
        const uiPicker = page.getByTestId("graph-node-picker");
        await uiPicker.selectOption(endpointNode.id);
        await page.waitForFunction(id => document.querySelector('[data-testid="node-inspector"]')?.getAttribute("data-node-id") === id, endpointNode.id);
        const desktopInspector = page.getByTestId("node-inspector");
        await page.getByTestId("node-inspector-source").first().waitFor();
        assert.equal(await desktopInspector.getAttribute("data-node-id"), endpointNode.id);
        await takeScreenshot(page, "graph-inspector-1440.png");

        const desktopSourceTrigger = page.getByTestId("node-inspector-source").first();
        await desktopSourceTrigger.focus();
        const desktopSourceResponse = page.waitForResponse(response => {
          const url = new URL(response.url());
          return url.pathname.endsWith(`/files/${endpointFile.id}/source`) && response.status() === 200;
        });
        await page.keyboard.press("Enter");
        await desktopSourceResponse;
        const desktopSourceDialog = page.getByTestId("node-source-dialog");
        await desktopSourceDialog.waitFor();
        await desktopSourceDialog.getByText("export class Endpoint extends Base implements Payload", { exact: false }).waitFor();
        await takeScreenshot(page, "graph-source-1440.png");
        await page.keyboard.press("Escape");
        await desktopSourceDialog.waitFor({ state: "hidden" });
        await page.waitForFunction(() => document.activeElement?.getAttribute("data-testid") === "node-inspector-source");
        assert.equal(await desktopSourceTrigger.evaluate(element => document.activeElement === element), true, "desktop Escape returns focus to the source evidence trigger");

        await page.getByTestId("node-inspector-close").click();
        await desktopInspector.waitFor({ state: "detached" });
        const canvasSelectedId = await clickCanvasNode(page);
        assert.ok(canonicalCcm.nodes.some(node => node.id === canvasSelectedId), "desktop canvas click selects a canonical node");
        assert.equal(await page.getByTestId("node-inspector").getAttribute("data-node-id"), canvasSelectedId);
        checks.push("1440px: focus-picker opens source-backed inspector/source screenshots and a direct canvas click opens a canonical node inspector");
      }

      assert.deepEqual(pageErrors, [], `${width}px graph route should not throw browser errors`);
      checks.push(`${width}px: real owner graph, modes and count semantics, keyboard node selection, unresolved legend, zoom/fit, screenshot, and no horizontal overflow/page errors`);
      await context.close();
    }

    const nodeRetryContext = await browser.newContext({ viewport: { width: 390, height: 1000 }, reducedMotion: "reduce" });
    await nodeRetryContext.addCookies([{
      name: "sage_session", value: owner.token, url: base, httpOnly: true, sameSite: "Lax",
    }]);
    const nodeRetryPage = await nodeRetryContext.newPage();
    nodeRetryPage.setDefaultTimeout(20_000);
    nodeRetryPage.on("pageerror", error => pageErrors.push(`inspector/source retry: ${error.message}`));
    let firstNode503 = true;
    await nodeRetryPage.route(`**/api/analyses/${ready.analysisId}/nodes/${endpointNode.id}`, async route => {
      if (!firstNode503) return route.continue();
      firstNode503 = false;
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        headers: { "Cache-Control": "private, no-store" },
        body: JSON.stringify({
          error: { code: "NODE_INSPECTOR_UNAVAILABLE", message: "Detail node sementara tidak dapat dibaca. Coba lagi.", details: {} },
          requestId: randomUUID(),
        }),
      });
    });
    await nodeRetryPage.goto(graphPageUrl(base, ready.analysisId), { waitUntil: "networkidle" });
    const retryPicker = nodeRetryPage.getByTestId("graph-node-picker");
    const firstNodeError = nodeRetryPage.waitForResponse(response => {
      const url = new URL(response.url());
      return url.pathname === `/api/analyses/${ready!.analysisId}/nodes/${endpointNode.id}` && response.status() === 503;
    });
    await retryPicker.selectOption(endpointNode.id);
    await firstNodeError;
    await nodeRetryPage.getByTestId("node-inspector").getByRole("status").waitFor();
    const retryNodeButton = nodeRetryPage.getByTestId("node-inspector-retry");
    await retryNodeButton.waitFor();
    const successfulNodeRetry = nodeRetryPage.waitForResponse(response => {
      const url = new URL(response.url());
      return url.pathname === `/api/analyses/${ready!.analysisId}/nodes/${endpointNode.id}` && response.status() === 200;
    });
    await retryNodeButton.click();
    await successfulNodeRetry;
    await nodeRetryPage.getByTestId("node-inspector-source").first().waitFor();

    let firstSource503 = true;
    await nodeRetryPage.route(`**/api/analyses/${ready.analysisId}/files/${endpointFile.id}/source*`, async route => {
      if (!firstSource503) return route.continue();
      firstSource503 = false;
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        headers: { "Cache-Control": "private, no-store" },
        body: JSON.stringify({
          error: { code: "SOURCE_UNAVAILABLE", message: "Source snapshot sementara tidak dapat dibaca. Coba lagi.", details: {} },
          requestId: randomUUID(),
        }),
      });
    });
    const firstSourceError = nodeRetryPage.waitForResponse(response => {
      const url = new URL(response.url());
      return url.pathname === `/api/analyses/${ready!.analysisId}/files/${endpointFile.id}/source` && response.status() === 503;
    });
    await nodeRetryPage.getByTestId("node-inspector-source").first().click();
    await firstSourceError;
    const sourceRetryDialog = nodeRetryPage.getByTestId("node-source-dialog");
    await sourceRetryDialog.getByRole("status").waitFor();
    const retrySourceButton = nodeRetryPage.getByTestId("node-source-retry");
    await retrySourceButton.waitFor();
    const successfulSourceRetry = nodeRetryPage.waitForResponse(response => {
      const url = new URL(response.url());
      return url.pathname === `/api/analyses/${ready!.analysisId}/files/${endpointFile.id}/source` && response.status() === 200;
    });
    await retrySourceButton.click();
    await successfulSourceRetry;
    await sourceRetryDialog.getByText("export class Endpoint extends Base implements Payload", { exact: false }).waitFor();
    await nodeRetryContext.close();
    checks.push("390px controlled API faults: one inspector 503 and one source 503 each show a retry action and recover through the real Next/Postgres endpoint");

    const baseNode = canonicalCcm.nodes.find(node => node.kind === "Class" && node.name === "Base");
    assert.ok(baseNode?.location, "fixture Base class must have a declaration location for the stale inspector race");
    const inspectorRaceContext = await browser.newContext({ viewport: { width: 390, height: 1000 }, reducedMotion: "reduce" });
    await inspectorRaceContext.addCookies([{
      name: "sage_session", value: owner.token, url: base, httpOnly: true, sameSite: "Lax",
    }]);
    const inspectorRacePage = await inspectorRaceContext.newPage();
    inspectorRacePage.setDefaultTimeout(20_000);
    inspectorRacePage.on("pageerror", error => pageErrors.push(`stale node inspector response: ${error.message}`));
    let releaseDelayedNodeResponse = () => {};
    let finishDelayedNodeRoute = () => {};
    let signalDelayedNodeRequest = () => {};
    let signalDelayedNodeResponseReady = () => {};
    const delayedNodeResponseGate = new Promise<void>(resolve => { releaseDelayedNodeResponse = resolve; });
    const delayedNodeRouteFinished = new Promise<void>(resolve => { finishDelayedNodeRoute = resolve; });
    const delayedNodeRequestStarted = new Promise<void>(resolve => { signalDelayedNodeRequest = resolve; });
    const delayedNodeResponseReady = new Promise<void>(resolve => { signalDelayedNodeResponseReady = resolve; });
    let holdEndpointDetails = true;
    let delayedNodeStatus = 0;
    await inspectorRacePage.route(`**/api/analyses/${ready.analysisId}/nodes/${endpointNode.id}`, async route => {
      if (!holdEndpointDetails) return route.continue();
      holdEndpointDetails = false;
      signalDelayedNodeRequest();
      try {
        const actual = await route.fetch();
        delayedNodeStatus = actual.status();
        signalDelayedNodeResponseReady();
        await delayedNodeResponseGate;
        try { await route.fulfill({ response: actual }); }
        catch { /* A newer node selection may abort this obsolete detail request. */ }
      } finally {
        finishDelayedNodeRoute();
      }
    });
    await inspectorRacePage.goto(graphPageUrl(base, ready.analysisId), { waitUntil: "networkidle" });
    const racePicker = inspectorRacePage.getByTestId("graph-node-picker");
    const endpointDetailsWaiter = delayedNodeRequestStarted;
    await racePicker.selectOption(endpointNode.id);
    await endpointDetailsWaiter;
    await delayedNodeResponseReady;
    assert.equal(delayedNodeStatus, 200, "stale inspector response is held only after a genuine API success");
    await inspectorRacePage.getByTestId("node-inspector").getByRole("status").waitFor();
    const baseDetailsResponse = inspectorRacePage.waitForResponse(response => {
      const url = new URL(response.url());
      return url.pathname === `/api/analyses/${ready!.analysisId}/nodes/${baseNode.id}` && response.status() === 200;
    });
    await racePicker.selectOption(baseNode.id);
    await baseDetailsResponse;
    await inspectorRacePage.getByTestId("node-inspector-source").first().waitFor();
    assert.equal(await inspectorRacePage.getByTestId("node-inspector").getAttribute("data-node-id"), baseNode.id);
    assert.equal((await inspectorRacePage.getByTestId("node-inspector-title").innerText()).trim(), baseNode.name);
    releaseDelayedNodeResponse();
    await delayedNodeRouteFinished;
    await inspectorRacePage.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    assert.equal(await inspectorRacePage.getByTestId("node-inspector").getAttribute("data-node-id"), baseNode.id,
      "late Endpoint detail must not replace the more recent Base selection");
    assert.equal((await inspectorRacePage.getByTestId("node-inspector-title").innerText()).trim(), baseNode.name);
    await inspectorRaceContext.close();
    checks.push("390px delayed inspector response: selection B completes while real selection A is held; releasing A cannot replace B");

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

    // Explicit browser double: headers resolve, but a superseded error body aborts later.
    // This exercises the await boundary after response.json(), not only delayed headers.
    const errorRaceContext = await browser.newContext({ viewport: { width: 390, height: 1000 } });
    await errorRaceContext.addCookies([{
      name: "sage_session", value: owner.token, url: base, httpOnly: true, sameSite: "Lax",
    }]);
    await errorRaceContext.addInitScript(({ graphPath }) => {
      const originalFetch = window.fetch.bind(window);
      let holdFirstBody = true;
      const state = window as unknown as { graphErrorBodyPending?: boolean; releaseGraphErrorBody?: () => void };
      window.fetch = async (input, init) => {
        const target = input instanceof Request ? input.url : String(input);
        const response = await originalFetch(input, init);
        if (!holdFirstBody || new URL(target, window.location.href).pathname !== graphPath || !response.ok) return response;
        holdFirstBody = false;
        await response.body?.cancel();
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            state.graphErrorBodyPending = true;
            state.releaseGraphErrorBody = () => controller.error(new DOMException("Superseded test response", "AbortError"));
          },
        });
        return new Response(body, { status: 503, headers: { "Content-Type": "application/json" } });
      };
    }, { graphPath: `/api/analyses/${ready.analysisId}/graph` });
    const errorRacePage = await errorRaceContext.newPage();
    errorRacePage.on("pageerror", error => pageErrors.push(`delayed error body: ${error.message}`));
    await errorRacePage.goto(graphPageUrl(base, ready.analysisId), { waitUntil: "domcontentloaded" });
    await errorRacePage.waitForFunction(() => (window as unknown as { graphErrorBodyPending?: boolean }).graphErrorBodyPending === true);
    await errorRacePage.evaluate(() => window.dispatchEvent(new Event("focus")));
    await errorRacePage.getByTestId("canonical-counts").waitFor();
    await errorRacePage.evaluate(() => (window as unknown as { releaseGraphErrorBody?: () => void }).releaseGraphErrorBody?.());
    await errorRacePage.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    assert.equal(await errorRacePage.getByTestId("canonical-counts").count(), 1, "an aborted stale error body must not clear the newer graph");
    assert.equal(await errorRacePage.getByRole("region", { name: "Kanvas knowledge graph", exact: true }).count(), 1);
    assert.equal(await errorRacePage.getByRole("alert").filter({ hasText: "Graph sementara tidak dapat dibaca." }).count(), 0);
    await errorRaceContext.close();
    checks.push("controlled delayed error body: superseded 503 body abort cannot clear the replacement graph or publish an obsolete error");

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
      controlledCase: "The first 360px graph request receives one intercepted 503; independent node-detail and source-detail requests each receive a controlled 503 before their retry reaches the genuine Next/Postgres API; a separate delayed error body checks stale-error handling.",
      inspectorSourceCase: "Node details and source line ranges are checked against the canonical CKG and immutable archive. Browser coverage uses the focus picker at 390px, a canvas click at 1440px, delayed node-selection responses, Escape focus restoration, unresolved-node no-source behavior, and account-switch clearing.",
      screenshots: ["graph-inspector-390.png", "graph-source-390.png", "graph-inspector-1440.png", "graph-source-1440.png"],
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
