import { checkBceWorkspace } from "./check-bce-workspace.ts";
import { checkWorkspaceExperience } from "./workspace-ui-checks.ts";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeReferences } from "@sage/analyzer-js";
import { canonicalizeCkg, type CcmSnapshot, type CcmV1 } from "@sage/contracts";
import { compactAnalysisStorage, createSession, database, storeGitHubCredential } from "@sage/database";
import { MARKDOWN_RENDERER_VERSION, renderMarkdownDocument } from "@sage/documents";
import { projectArchitectureDocument, type ArchitectureDocumentV1 } from "@sage/documents/model";
import { chromium, request, type APIRequestContext, type APIResponse, type Browser, type BrowserContext, type Download, type Page, type Response as BrowserResponse } from "playwright";
import { pack, type Header } from "tar-stream";
import { gzipSync } from "node:zlib";

/**
 * Issue 21 live PDF export regression. Requires a disposable sage_pdf21
 * PostgreSQL database, a test-only credential key, private empty storage shared
 * by the production Next.js and worker processes, and the production worker
 * consumer. No provider API is contacted.
 *
 *   SAGE_PDF_TESTS=1 \
 *   DATABASE_URL=postgresql://sage@sage-pdf21-db:5432/sage_pdf21 \
 *   CREDENTIAL_ENCRYPTION_KEY=<test-only-32-byte-base64> \
 *   STORAGE_ROOT=/tmp/sage-pdf21-storage \
 *   SAGE_PDF_BASE_URL=http://127.0.0.1:3000 \
 *   SAGE_PDF_ARTIFACT_DIR=artifacts/pdf-21/2026-10-27-run1 \
 *   node --import tsx scripts/test-pdf-export.ts
 *
 * PDF and Markdown queue entries are created through the live HTTP API; all
 * successful files are produced by the production worker consumer. A test-only
 * expired export lease gates one deliberately corrupted archive so the worker
 * fails the real PDF, then the source hash is restored before the real retry.
 */

type DisposableAccount = {
  userId: string;
  login: string;
  accountKey: string;
  token: string;
  syntheticProviderToken: string;
};
type ExportFormat = "PDF" | "MARKDOWN";
type ExportStatus = "QUEUED" | "GENERATING" | "READY" | "FAILED";
type ExportRecord = {
  id: string;
  format: ExportFormat;
  status: ExportStatus;
  documentHash: string;
  rendererVersion: string;
  contentHash: string | null;
  errorCode: string | null;
};
type ExportData = { analysisId: string; accountKey: string; export: ExportRecord };
type SeededAnalysis = {
  analysisId: string;
  documentId: string;
  document: ArchitectureDocumentV1;
  documentJson: string;
  documentHash: string;
  ckgHash: string;
  snapshot: CcmSnapshot;
  configurationHash: string;
  sourceBytes: Record<string, Uint8Array>;
  archive: { id: string; bytes: Buffer; path: string; storageKey: string; sha256: string };
};
type Blocker = { exportId: string; jobId: string };
type BrowserAudit = { offOrigin: number; provider: number; errors: string[] };

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureDir = new URL("../tests/fixtures/resolver/typescript/", import.meta.url);
const PDF_SIGNATURE = Buffer.from("%PDF-");

function digest(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function hasOwnRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function apiHeaders(account: DisposableAccount): Record<string, string> {
  return { Cookie: `sage_session=${account.token}`, "X-SAGE-Account": account.accountKey };
}

function postHeaders(account: DisposableAccount, origin: string): Record<string, string> {
  return { ...apiHeaders(account), Origin: origin, "Content-Type": "application/json", Accept: "application/json" };
}

function parseExportData(value: unknown, expectedFormat?: ExportFormat): ExportData {
  assert.ok(hasOwnRecord(value) && hasOwnRecord(value.data), "export response must contain data");
  const data = value.data;
  assert.ok(typeof data.analysisId === "string", "export response must bind to an analysis");
  assert.ok(typeof data.accountKey === "string", "export response must bind to an account");
  assert.ok(hasOwnRecord(data.export), "export response must contain an export record");
  const row = data.export;
  assert.ok(typeof row.id === "string" && row.id.length > 0, "export id must be present");
  assert.ok(row.format === "PDF" || row.format === "MARKDOWN", "export format must be PDF or MARKDOWN");
  if (expectedFormat) assert.equal(row.format, expectedFormat);
  assert.ok(["QUEUED", "GENERATING", "READY", "FAILED"].includes(String(row.status)));
  assert.ok(typeof row.documentHash === "string" && /^[a-f0-9]{64}$/.test(row.documentHash));
  assert.ok(typeof row.rendererVersion === "string" && row.rendererVersion.length > 0);
  assert.ok(row.contentHash === null || (typeof row.contentHash === "string" && /^[a-f0-9]{64}$/.test(row.contentHash)));
  assert.ok(row.errorCode === null || typeof row.errorCode === "string");
  return data as unknown as ExportData;
}

async function readJson(response: { json(): Promise<unknown>; status(): number }): Promise<unknown> {
  try { return await response.json() as unknown; }
  catch { throw new Error(`Expected JSON response; received HTTP ${response.status()}.`); }
}

function requireDedicatedDatabase(): void {
  if (process.env.SAGE_PDF_TESTS !== "1") {
    throw new Error("Set SAGE_PDF_TESTS=1 to opt in to the destructive isolated issue 21 integration regression.");
  }
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error("DATABASE_URL is required when SAGE_PDF_TESTS=1.");
  let databaseName: string;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") throw new Error("protocol");
    databaseName = decodeURIComponent(parsed.pathname.slice(1));
  } catch {
    throw new Error("DATABASE_URL must be a valid PostgreSQL URL; it was not logged.");
  }
  if (databaseName !== "sage_pdf21") {
    throw new Error("Live PDF export regression only allows the isolated sage_pdf21 database.");
  }
  const key = process.env.CREDENTIAL_ENCRYPTION_KEY;
  if (!key || !/^[A-Za-z0-9+/]{43}=$/.test(key) || Buffer.from(key, "base64").length !== 32 || Buffer.from(key, "base64").toString("base64") !== key) {
    throw new Error("CREDENTIAL_ENCRYPTION_KEY must be the test-only canonical base64 key shared with Next/worker.");
  }
}

async function preparePrivateStorageRoot(): Promise<string> {
  const raw = process.env.STORAGE_ROOT;
  if (!raw || !isAbsolute(raw)) throw new Error("STORAGE_ROOT must be an absolute private temporary directory shared with Next/worker.");
  const requested = resolve(raw);
  const temporaryRoots = [...new Set([resolve(tmpdir()), resolve("/tmp"), resolve("/var/tmp")])];
  if (temporaryRoots.every(root => requested === root || !requested.startsWith(`${root}${sep}`))) {
    throw new Error("Refusing to use STORAGE_ROOT outside a temporary directory.");
  }
  await mkdir(requested, { recursive: true, mode: 0o700 });
  const stat = await lstat(requested);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("STORAGE_ROOT must be a real directory, not a symlink.");
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) throw new Error("STORAGE_ROOT must have private permissions (0700).");
  if ((await readdir(requested)).length > 0) throw new Error("STORAGE_ROOT must be an empty issue 21 fixture directory.");
  return requested;
}

function artifactDirectory(): string {
  const raw = process.env.SAGE_PDF_ARTIFACT_DIR ?? "artifacts/pdf-21/2026-10-27-run1";
  return isAbsolute(raw) ? resolve(raw) : resolve(projectRoot, raw);
}

async function prepareArtifactDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  if ((await readdir(path)).length > 0) throw new Error("SAGE_PDF_ARTIFACT_DIR must be empty; refusing to overwrite previous evidence.");
}

async function makeTarGz(sources: Readonly<Record<string, Uint8Array>>): Promise<Buffer> {
  const tar = pack();
  const root = `sage-pdf21-source-${randomBytes(4).toString("hex")}`;
  async function add(name: string, bytes: Buffer, type: "file" | "directory"): Promise<void> {
    const header: Partial<Header> & Pick<Header, "name"> = {
      name, type, size: bytes.byteLength, mode: type === "directory" ? 0o755 : 0o644,
      mtime: new Date(0), linkname: "", uid: 0, gid: 0, uname: "", gname: "", devmajor: 0, devminor: 0,
    };
    await new Promise<void>((resolveEntry, rejectEntry) => {
      tar.entry(header, bytes, error => error ? rejectEntry(error) : resolveEntry());
    });
  }
  await add(`${root}/`, Buffer.alloc(0), "directory");
  const directories = new Set<string>();
  for (const path of Object.keys(sources)) {
    let parent = dirname(path);
    while (parent !== ".") { directories.add(parent); parent = dirname(parent); }
  }
  for (const path of [...directories].sort((left, right) => left.split("/").length - right.split("/").length || left.localeCompare(right))) {
    await add(`${root}/${path}/`, Buffer.alloc(0), "directory");
  }
  for (const path of Object.keys(sources).sort()) await add(`${root}/${path}`, Buffer.from(sources[path]!), "file");
  tar.finalize();
  const chunks: Buffer[] = [];
  for await (const chunk of tar) chunks.push(Buffer.from(chunk as Uint8Array));
  return gzipSync(Buffer.concat(chunks));
}

async function loadFixture(): Promise<{ sources: Record<string, Uint8Array>; ccm: CcmV1; snapshot: CcmSnapshot; configurationHash: string }> {
  const paths = ["src/model.ts", "src/endpoint.ts"];
  const entries = await Promise.all(paths.map(async path => [path, new Uint8Array(await readFile(new URL(path, fixtureDir)))] as const));
  const sources: Record<string, Uint8Array> = Object.fromEntries(entries);
  sources["src/export-contract#95;.ts"] = new Uint8Array(Buffer.from([
    "export interface MarkdownExportContract { render(input: string): string; }",
    "export class MarkdownExportService implements MarkdownExportContract {",
    "  render(input: string): string { return `${input}:${missingFormatter.format(input)}`; }",
    "}",
    'export const sourceCanary = "PDF21_RAW_SOURCE_CANARY";',
    'export const urlCanary = "https://pdf21.invalid/PDF21_URL_CANARY";',
    "// Worker output must use the canonical document, not raw source text.",
  ].join("\n"), "utf8"));
  const snapshot: CcmSnapshot = {
    repository: "sage-pdf21/export-fixture",
    branch: "feature/pdf-21",
    commitSha: "b".repeat(40),
  };
  const configurationHash = digest("SAGE issue 21 disposable PDF regression configuration v1");
  const result = await analyzeReferences({ snapshot, sources });
  assert.equal(result.errorCode, null, "checked-in TypeScript fixtures must analyze successfully");
  assert.ok(result.ccm, "analyzer fixture must produce a canonical CCM");
  assert.equal(result.ccm.nodes.length, 20, "issue 21 fixture must retain 20 canonical nodes");
  assert.equal(result.ccm.edges.length, 27, "issue 21 fixture must retain 27 canonical edges");
  const presentKinds = new Set(result.ccm.nodes.map(node => node.kind));
  for (const kind of ["Class", "Interface", "Function", "Method", "Property", "UnresolvedReference"] as const) {
    assert.ok(presentKinds.has(kind), `fixture should include ${kind}`);
  }
  assert.ok(result.ccm.edges.some(edge => edge.resolution === "Unresolved"), "fixture must retain unresolved relation evidence");
  const limitation = {
    path: "src/export-contract#95;.ts",
    reason: "Issue 21 fixture retains a partial-analysis caveat so the PDF can preserve limitation text.",
    stage: "STATIC_ANALYSIS",
  };
  const ccm: CcmV1 = { ...result.ccm, limitations: [...result.ccm.limitations, limitation] };
  return { sources, ccm, snapshot, configurationHash };
}

async function makeAccount(
  db: ReturnType<typeof database>, label: string, users: string[], sessions: string[],
): Promise<DisposableAccount> {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const login = `pdf21-${label}-${suffix}`;
  const accountKey = `pdf21-gh-${label}-${suffix}`;
  const syntheticProviderToken = `synthetic-not-provider-pdf21-${label}-${suffix}`;
  const user = await db.user.create({ data: { githubUserId: accountKey, login }, select: { id: true } });
  users.push(user.id);
  await storeGitHubCredential(db, user.id, { githubUserId: accountKey, githubLogin: login, accessToken: syntheticProviderToken });
  const created = await createSession(db, user.id, { ttlMs: 30 * 60 * 1000 });
  sessions.push(created.session.sessionId);
  return { userId: user.id, login, accountKey, token: created.token, syntheticProviderToken };
}

async function createArchiveStorage(
  db: ReturnType<typeof database>, storageRoot: string, ownerUserId: string, analysisId: string,
  sources: Readonly<Record<string, Uint8Array>>, storageObjectIds: string[], createdFolders: string[],
): Promise<SeededAnalysis["archive"]> {
  const bytes = await makeTarGz(sources);
  const folder = await mkdtemp(join(storageRoot, "snapshot-"));
  createdFolders.push(folder);
  const folderName = basename(folder);
  const storageKey = `${folderName}/archive.tar.gz`;
  const archivePath = join(folder, "archive.tar.gz");
  await writeFile(archivePath, bytes, { flag: "wx", mode: 0o600 });
  const sha256 = digest(bytes);
  const row = await db.storageObject.create({
    data: { ownerUserId, analysisId, type: "SOURCE_ARCHIVE", storageKey, sha256, byteLength: BigInt(bytes.byteLength) },
    select: { id: true },
  });
  storageObjectIds.push(row.id);
  return { id: row.id, bytes, path: archivePath, storageKey, sha256 };
}

async function seedAnalysis(
  db: ReturnType<typeof database>,
  input: { ownerUserId: string; repositoryId: string; fixture: Awaited<ReturnType<typeof loadFixture>>; storageRoot: string; label: string; storageObjectIds: string[]; createdFolders: string[] },
): Promise<SeededAnalysis> {
  const canonical = canonicalizeCkg(input.fixture.ccm, input.fixture.sources, input.fixture.configurationHash);
  if (!canonical.ok) throw new Error(`CKG canonicalization failed: ${canonical.errorCode}`);
  const projected = projectArchitectureDocument(canonical.json, input.fixture.sources, canonical.sha256);
  if (!projected.ok) throw new Error(`Architecture document projection failed: ${projected.errorCode}`);
  const now = new Date();
  const analysis = await db.analysis.create({
    data: {
      ownerUserId: input.ownerUserId, repositoryId: input.repositoryId,
      repositoryFullNameSnapshot: input.fixture.snapshot.repository,
      branchName: input.fixture.snapshot.branch ?? "main", commitSha: input.fixture.snapshot.commitSha,
      configuration: { issue: "21", fixture: input.label }, configurationHash: input.fixture.configurationHash,
      analyzerVersion: "sage-analyzer-js-pdf21-live-fixture", schemaVersion: "1",
      status: "COMPLETED_WITH_LIMITATIONS", completedAt: now,
    },
    select: { id: true },
  });
  await db.graphBundle.create({
    data: {
      ownerUserId: input.ownerUserId, analysisId: analysis.id, schemaVersion: canonical.value.schemaVersion,
      configurationHash: input.fixture.configurationHash, canonicalContent: canonical.json,
      nodes: JSON.stringify(canonical.value.ccm.nodes), edges: JSON.stringify(canonical.value.ccm.edges),
      nodeCount: canonical.value.counts.nodes, edgeCount: canonical.value.counts.edges, contentHash: canonical.sha256,
    },
  });
  const documentRow = await db.architectureDocument.create({
    data: {
      ownerUserId: input.ownerUserId, analysisId: analysis.id, title: projected.value.title,
      documentModelVersion: projected.value.schemaVersion, canonicalContent: projected.json,
      interfaceCatalog: JSON.stringify(projected.value.interfaceCatalog),
      softwareEngineeringDiagram: JSON.stringify(projected.value.softwareEngineeringDiagram),
      umlClassDiagram: JSON.stringify(projected.value.umlClassDiagram), contentHash: projected.sha256,
    },
    select: { id: true },
  });
  const archive = await createArchiveStorage(db, input.storageRoot, input.ownerUserId, analysis.id, input.fixture.sources, input.storageObjectIds, input.createdFolders);
  if (process.env.SAGE_TEST_STORAGE_LAYOUT === "2") {
    const compacted = await compactAnalysisStorage(db, analysis.id, { apply: true, sourceBytes: input.fixture.sources });
    assert.equal(compacted.status, "compacted", "browser fixture must use the verified canonical-only storage layout");
    assert.equal(compacted.graphs, 1);
    assert.equal(compacted.documents, 1);
  }
  return {
    analysisId: analysis.id, documentId: documentRow.id, document: projected.value, documentJson: projected.json,
    documentHash: projected.sha256, ckgHash: canonical.sha256, snapshot: input.fixture.snapshot,
    configurationHash: input.fixture.configurationHash, sourceBytes: input.fixture.sources, archive,
  };
}

async function createAnalysisRepository(db: ReturnType<typeof database>): Promise<string> {
  const row = await db.repository.create({
    data: {
      githubRepositoryId: `pdf21-repo-${randomUUID()}`, ownerLogin: "sage-pdf21", name: "export-fixture",
      fullName: "sage-pdf21/export-fixture", visibility: "PRIVATE", defaultBranch: "feature/pdf-21",
    },
    select: { id: true },
  });
  return row.id;
}

/** Insert one expiring production queue-slot lease under the row lock used by the queue. */
async function seedWorkerSlotBlocker(
  db: ReturnType<typeof database>, input: { ownerUserId: string; analysis: SeededAnalysis; rendererVersion: string },
): Promise<Blocker> {
  return db.$transaction(async tx => {
    await tx.$executeRaw`INSERT INTO "WorkerSlot" ("slotKey", "updatedAt", "lastEnqueueSequence") VALUES ('export', clock_timestamp(), 0) ON CONFLICT ("slotKey") DO NOTHING`;
    const slots = await tx.$queryRaw<Array<{ jobId: string | null; lastEnqueueSequence: bigint }>>`SELECT "jobId", "lastEnqueueSequence" FROM "WorkerSlot" WHERE "slotKey" = 'export' FOR UPDATE`;
    assert.equal(slots.length, 1);
    assert.equal(slots[0]!.jobId, null, "test may only occupy an idle export worker slot");
    const sequence = slots[0]!.lastEnqueueSequence + 1n;
    const expiresAt = new Date(Date.now() + 120_000);
    const now = new Date();
    const exportRow = await tx.export.create({
      data: {
        ownerUserId: input.ownerUserId, analysisId: input.analysis.analysisId,
        architectureDocumentId: input.analysis.documentId, format: "PDF",
        documentHash: input.analysis.documentHash, rendererVersion: input.rendererVersion, status: "GENERATING",
      },
      select: { id: true },
    });
    const job = await tx.job.create({
      data: {
        ownerUserId: input.ownerUserId, analysisId: input.analysis.analysisId, exportId: exportRow.id,
        type: "EXPORT", queueSequence: sequence, status: "RUNNING", startedAt: now,
        leaseExpiresAt: expiresAt, heartbeatAt: now, attempt: 1,
      },
      select: { id: true },
    });
    const leaseTokenHash = digest(randomUUID());
    await tx.workerSlot.upsert({
      where: { slotKey: "export" },
      create: { slotKey: "export", jobId: job.id, ownerUserId: input.ownerUserId, leaseUntil: expiresAt, heartbeatAt: now, leaseTokenHash, lastEnqueueSequence: sequence },
      update: { jobId: job.id, ownerUserId: input.ownerUserId, leaseUntil: expiresAt, heartbeatAt: now, leaseTokenHash, lastEnqueueSequence: sequence },
    });
    return { exportId: exportRow.id, jobId: job.id };
  });
}

async function expireWorkerSlotBlocker(db: ReturnType<typeof database>, blocker: Blocker): Promise<void> {
  const expiredAt = new Date(0);
  await db.job.update({ where: { id: blocker.jobId }, data: { leaseExpiresAt: expiredAt } });
  await db.workerSlot.update({ where: { slotKey: "export" }, data: { leaseUntil: expiredAt } });
}

async function waitForBlockerRecovery(db: ReturnType<typeof database>, blocker: Blocker, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const exportRow = await db.export.findUnique({ where: { id: blocker.exportId }, select: { status: true, errorCode: true } });
    const job = await db.job.findUnique({ where: { id: blocker.jobId }, select: { status: true, errorCode: true } });
    if (exportRow?.status === "FAILED" && exportRow.errorCode === "WORKER_INTERRUPTED"
      && job?.status === "FAILED" && job.errorCode === "WORKER_INTERRUPTED") return;
    await new Promise(resolveDelay => setTimeout(resolveDelay, 200));
  }
  throw new Error("Production export consumer did not recover the deliberately expired blocker lease.");
}

function exportCollectionPath(base: string, analysisId: string): string {
  return `${base}/api/analyses/${encodeURIComponent(analysisId)}/exports`;
}
function exportStatusPath(base: string, analysisId: string, exportId: string): string {
  return `${exportCollectionPath(base, analysisId)}/${encodeURIComponent(exportId)}`;
}
function exportRetryPath(base: string, analysisId: string, exportId: string): string {
  return `${exportStatusPath(base, analysisId, exportId)}/retry`;
}
function exportDownloadPath(base: string, analysisId: string, exportId: string): string {
  return `${exportStatusPath(base, analysisId, exportId)}/download`;
}
function documentPagePath(base: string, analysisId: string): string {
  return `${base}/analyses/${encodeURIComponent(analysisId)}/document`;
}

async function fetchExportStatus(
  api: APIRequestContext, base: string, analysisId: string, exportId: string, account: DisposableAccount,
): Promise<{ response: APIResponse; value: unknown }> {
  const response = await api.get(exportStatusPath(base, analysisId, exportId), { headers: apiHeaders(account) });
  return { response, value: await readJson(response) };
}

async function waitForExportStatus(
  api: APIRequestContext, base: string, analysisId: string, exportId: string, account: DisposableAccount,
  wanted: ExportStatus, timeoutMs = 60_000,
): Promise<ExportData> {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = "unknown";
  while (Date.now() < deadline) {
    const result = await fetchExportStatus(api, base, analysisId, exportId, account);
    assert.equal(result.response.status(), 200, `owner status reader returned HTTP ${result.response.status()}`);
    const current = parseExportData(result.value);
    assert.equal(current.analysisId, analysisId);
    assert.equal(current.accountKey, account.accountKey);
    lastStatus = current.export.status;
    if (current.export.status === wanted) return current;
    if (current.export.status === "FAILED" && wanted !== "FAILED") {
      throw new Error(`Production worker failed export unexpectedly with ${current.export.errorCode ?? "unknown"}.`);
    }
    if (current.export.status === "READY" && wanted !== "READY") throw new Error("Export became READY before failure could be observed.");
    await new Promise(resolveDelay => setTimeout(resolveDelay, 250));
  }
  throw new Error(`Timed out waiting for export ${wanted}; last observed status was ${lastStatus}.`);
}

function validateExportMetadata(data: ExportData, analysis: SeededAnalysis, account: DisposableAccount, format: ExportFormat): void {
  assert.equal(data.analysisId, analysis.analysisId);
  assert.equal(data.accountKey, account.accountKey);
  assert.equal(data.export.format, format);
  assert.equal(data.export.documentHash, analysis.documentHash);
  if (data.export.status === "READY") assert.match(data.export.contentHash ?? "", /^[a-f0-9]{64}$/);
}

async function assertApiHeaders(response: APIResponse): Promise<void> {
  const headers = response.headers();
  assert.match(headers["cache-control"] ?? "", /private,\s*no-store/i);
  assert.match(headers.vary ?? "", /Cookie/i);
  assert.match(headers.vary ?? "", /X-SAGE-Account/i);
  assert.equal(headers["x-content-type-options"], "nosniff");
}

function auditRequest(urlText: string, audit: BrowserAudit, origin?: string): void {
  const parsed = new URL(urlText);
  if (parsed.protocol === "http:" || parsed.protocol === "https:") {
    if (origin && parsed.origin !== origin) audit.offOrigin += 1;
    if (parsed.hostname === "github.com" || parsed.hostname === "api.github.com" || parsed.pathname.startsWith("/api/github/")) audit.provider += 1;
  }
}

function attachBrowserAudit(page: Page, audit: BrowserAudit, origin: string, label: string): void {
  page.on("pageerror", error => audit.errors.push(`${label}: ${error.message}`));
  page.on("request", req => auditRequest(req.url(), audit, origin));
}

async function createBrowserContext(browser: Browser, base: string, account: DisposableAccount, width: number): Promise<BrowserContext> {
  const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: "reduce", acceptDownloads: true, serviceWorkers: "block" });
  await context.addCookies([{ name: "sage_session", value: account.token, url: base, httpOnly: true, sameSite: "Lax" }]);
  return context;
}

async function openDocumentPage(context: BrowserContext, base: string, analysisId: string, audit: BrowserAudit, origin: string, label: string): Promise<Page> {
  const page = await context.newPage();
  page.setDefaultTimeout(25_000);
  attachBrowserAudit(page, audit, origin, label);
  await page.goto(documentPagePath(base, analysisId), { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "Architecture Definition Document", exact: true }).waitFor();
  await page.getByRole("button", { name: "Ekspor PDF", exact: true }).waitFor();
  return page;
}

async function waitForApiResponse(page: Page, pathname: string, method: string): Promise<BrowserResponse> {
  return page.waitForResponse(candidate => {
    const url = new URL(candidate.url());
    return url.pathname === pathname && candidate.request().method() === method;
  });
}

function assertPdfBytes(bytes: Uint8Array, label: string): void {
  assert.ok(bytes.byteLength > PDF_SIGNATURE.byteLength, `${label} must be a non-empty PDF`);
  assert.deepEqual(Buffer.from(bytes.subarray(0, PDF_SIGNATURE.byteLength)), PDF_SIGNATURE, `${label} must start with %PDF-`);
}

function pdfFilenameFrom(response: APIResponse): string {
  const disposition = response.headers()["content-disposition"] ?? "";
  assert.match(disposition, /^attachment\s*;/i, "PDF must be returned as a private attachment");
  const match = /filename="?([^";]+)"?/i.exec(disposition);
  assert.ok(match?.[1], "PDF attachment must supply a filename");
  assert.match(match[1]!, /^sage-[a-z0-9_-]+-[a-f0-9]{7}\.pdf$/i, "filename must be sanitized and bind to the 7-character commit SHA");
  return match[1]!;
}

async function verifyPdfDownload(
  api: APIRequestContext, base: string, analysis: SeededAnalysis, exportId: string, account: DisposableAccount,
): Promise<{ bytes: Buffer; filename: string; hash: string }> {
  const response = await api.get(exportDownloadPath(base, analysis.analysisId, exportId), { headers: apiHeaders(account) });
  assert.equal(response.status(), 200);
  await assertApiHeaders(response);
  const headers = response.headers();
  assert.match(headers["content-type"] ?? "", /^application\/pdf(?:\s*;|$)/i);
  const filename = pdfFilenameFrom(response);
  const bytes = await response.body();
  assertPdfBytes(bytes, "Production worker attachment");
  assert.equal(Number(headers["content-length"]), bytes.byteLength);
  const ready = await waitForExportStatus(api, base, analysis.analysisId, exportId, account, "READY");
  assert.equal(digest(bytes), ready.export.contentHash, "download SHA-256 must equal READY contentHash");
  return { bytes, filename, hash: digest(bytes) };
}

async function saveBrowserDownload(download: Download, artifactPath: string): Promise<{ filename: string; bytes: Buffer }> {
  const filename = download.suggestedFilename();
  assert.match(filename, /^sage-[a-z0-9_-]+-[a-f0-9]{7}\.pdf$/i, "browser download must keep a sanitized PDF attachment filename");
  await download.saveAs(artifactPath);
  const bytes = await readFile(artifactPath);
  assertPdfBytes(bytes, "Browser PDF download");
  return { filename, bytes };
}

async function verifyMarkdownDownload(
  api: APIRequestContext, base: string, analysis: SeededAnalysis, exportId: string, account: DisposableAccount,
): Promise<{ bytes: Buffer; filename: string; hash: string }> {
  const response = await api.get(exportDownloadPath(base, analysis.analysisId, exportId), { headers: apiHeaders(account) });
  assert.equal(response.status(), 200);
  await assertApiHeaders(response);
  const headers = response.headers();
  assert.match(headers["content-type"] ?? "", /^text\/markdown(?:\s*;|$)/i);
  assert.match(headers["content-disposition"] ?? "", /^attachment\s*;/i);
  const filenameMatch = /filename="?([^";]+)"?/i.exec(headers["content-disposition"] ?? "");
  assert.ok(filenameMatch?.[1]);
  assert.match(filenameMatch[1]!, /^sage-[a-z0-9_-]+-[a-f0-9]{7}\.md$/i);
  const bytes = await response.body();
  const ready = await waitForExportStatus(api, base, analysis.analysisId, exportId, account, "READY");
  assert.equal(digest(bytes), ready.export.contentHash);
  return { bytes, filename: filenameMatch[1]!, hash: digest(bytes) };
}

async function removeOwnedExportFiles(db: ReturnType<typeof database>, storageRoot: string, analysisIds: string[]): Promise<void> {
  if (!analysisIds.length) return;
  const rows = await db.storageObject.findMany({ where: { analysisId: { in: analysisIds }, type: "EXPORT" }, select: { storageKey: true } });
  for (const row of rows) {
    if (!/^export-[A-Za-z0-9-]{36}\/document\.(?:pdf|md)$/i.test(row.storageKey)) continue;
    const root = resolve(storageRoot);
    const file = resolve(root, ...row.storageKey.split("/"));
    if (!file.startsWith(`${root}${sep}`)) continue;
    await rm(file, { force: true });
    const directory = dirname(file);
    if (directory.startsWith(`${root}${sep}`)) await rm(directory, { recursive: true, force: true });
  }
}

async function runLivePdfExportRegression(): Promise<void> {
  requireDedicatedDatabase();
  const rawBase = process.env.SAGE_PDF_BASE_URL ?? "http://127.0.0.1:3000";
  const base = rawBase.replace(/\/$/, "");
  const parsedBase = new URL(base);
  if (parsedBase.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(parsedBase.hostname)
    || parsedBase.username || parsedBase.password || parsedBase.pathname !== "/" || parsedBase.search || parsedBase.hash) {
    throw new Error("SAGE_PDF_BASE_URL must be a local HTTP origin such as http://127.0.0.1:3000.");
  }
  const storageRoot = await preparePrivateStorageRoot();
  const resultDir = artifactDirectory();
  let artifactDirReady = false;
  const db = database();
  const users: string[] = [];
  const sessionIds: string[] = [];
  const analysisIds: string[] = [];
  const storageObjectIds: string[] = [];
  const createdFolders: string[] = [];
  const checks: string[] = [];
  const failures: string[] = [];
  const screenshots: string[] = [];
  const browserAudit: BrowserAudit = { offOrigin: 0, provider: 0, errors: [] };
  let repositoryId = "";
  let browser: Browser | undefined;
  let api: APIRequestContext | undefined;
  let owner: DisposableAccount | undefined;
  let other: DisposableAccount | undefined;
  let readyAnalysis: SeededAnalysis | undefined;
  let recoveryAnalysis: SeededAnalysis | undefined;
  let blockerAnalysis: SeededAnalysis | undefined;
  let blocker: Blocker | undefined;
  let failureInjection: string | undefined;
  let pdfRendererVersion: string | undefined;
  let pdfExportId: string | undefined;
  let markdownExportId: string | undefined;
  let recoveredFailureCode: string | undefined;
  let pdfBytes: Buffer | undefined;
  let pdfHash: string | undefined;
  let expectedMarkdown: Buffer | undefined;
  let markdownHash: string | undefined;
  let reportStatus: "PASS" | "FAIL" = "PASS";
  let reportError: string | undefined;

  try {
    await prepareArtifactDirectory(resultDir);
    artifactDirReady = true;
    api = await request.newContext({ baseURL: base, timeout: 20_000 });
    const health = await api.get("/api/health");
    assert.equal(health.status(), 200, "real Next server must be reachable and connected to PostgreSQL");
    assert.deepEqual(await readJson(health), { status: "ok", service: "web", database: "ok" });
    checks.push("real Next API and PostgreSQL health");

    assert.equal(await db.export.count(), 0, "sage_pdf21 must not contain prior exports before this isolated live run");
    owner = await makeAccount(db, "owner", users, sessionIds);
    other = await makeAccount(db, "other", users, sessionIds);
    repositoryId = await createAnalysisRepository(db);
    const fixture = await loadFixture();
    readyAnalysis = await seedAnalysis(db, { ownerUserId: owner.userId, repositoryId, fixture, storageRoot, label: "pdf-ready-and-markdown-control", storageObjectIds, createdFolders });
    analysisIds.push(readyAnalysis.analysisId);
    recoveryAnalysis = await seedAnalysis(db, { ownerUserId: owner.userId, repositoryId, fixture, storageRoot, label: "pdf-real-failure-and-retry", storageObjectIds, createdFolders });
    analysisIds.push(recoveryAnalysis.analysisId);
    blockerAnalysis = await seedAnalysis(db, { ownerUserId: owner.userId, repositoryId, fixture, storageRoot, label: "pdf-worker-slot-fault-control", storageObjectIds, createdFolders });
    analysisIds.push(blockerAnalysis.analysisId);
    assert.equal(readyAnalysis.documentHash, recoveryAnalysis.documentHash, "same canonical document fixture must replay to one document hash");
    assert.equal(readyAnalysis.documentHash, blockerAnalysis.documentHash);
    await writeFile(join(resultDir, "expected-document.json"), `${JSON.stringify(readyAnalysis.document, null, 2)}\n`, { mode: 0o600 });
    checks.push("20-node / 27-edge analyzer fixture projected to a canonical, public expected-document.json with one explicit limitation");

    const invalidOrigin = await api.post(exportCollectionPath(base, readyAnalysis.analysisId), {
      headers: { ...apiHeaders(owner), Origin: "https://pdf21.invalid", "Content-Type": "application/json" }, data: { format: "PDF" },
    });
    assert.equal(invalidOrigin.status(), 403);
    const invalidFormat = await api.post(exportCollectionPath(base, readyAnalysis.analysisId), {
      headers: postHeaders(owner, parsedBase.origin), data: { format: "HTML" },
    });
    assert.equal(invalidFormat.status(), 422);
    const extraBodyField = await api.post(exportCollectionPath(base, readyAnalysis.analysisId), {
      headers: postHeaders(owner, parsedBase.origin), data: { format: "PDF", unexpected: true },
    });
    assert.equal(extraBodyField.status(), 400);
    const badQuery = await api.post(`${exportCollectionPath(base, readyAnalysis.analysisId)}?unexpected=1`, {
      headers: postHeaders(owner, parsedBase.origin), data: { format: "PDF" },
    });
    assert.equal(badQuery.status(), 400);
    checks.push("POST rejects unsupported formats, extra body fields, query parameters, and off-origin requests");

    const originalClockRecord = await db.analysis.findUniqueOrThrow({ where: { id: readyAnalysis.analysisId }, select: { status: true, queuedAt: true, startedAt: true, completedAt: true } });
    const clockProbe = {
      start: async () => { await db.analysis.update({ where: { id: readyAnalysis!.analysisId }, data: { status: "QUEUED", queuedAt: new Date(Date.now() - 61_000), startedAt: null, completedAt: null } }); },
      finish: async () => { await db.analysis.update({ where: { id: readyAnalysis!.analysisId }, data: originalClockRecord }); },
    };
    browser = await chromium.launch({ headless: true });
    const context390 = await createBrowserContext(browser, base, owner, 390);
    const page390 = await openDocumentPage(context390, base, readyAnalysis.analysisId, browserAudit, parsedBase.origin, "PDF export 390px");
    await checkWorkspaceExperience(page390, base, readyAnalysis.analysisId, readyAnalysis.document, resultDir, 390, clockProbe);
    checks.push("390px real workspace: centered geometry, bounded searchable catalog, commit-pinned evidence, graph controls, progress and removed preview navigation");
    const humanText = await page390.locator("body").innerText();
    assert.ok(!humanText.includes(readyAnalysis.document.ckgSha256));
    assert.ok(!humanText.includes(readyAnalysis.documentHash));
    assert.ok(!humanText.includes(readyAnalysis.snapshot.commitSha));
    for (const label of ["Software Engineering Diagram", "UML Class Diagram"]) {
      await page390.getByRole("button", { name: label, exact: true }).click();
      const image = page390.getByRole("img", { name: label, exact: true });
      await image.waitFor({ timeout: 30_000 });
      const svg = await image.evaluate(async el => fetch(el.getAttribute("src")!).then(r => r.text()));
      assert.ok(!svg.includes("node_"), "visible diagram must use human names, not opaque IDs");
      await page390.getByRole("button", { name: "Perbesar", exact: true }).click();
      await page390.getByRole("button", { name: "Sesuaikan", exact: true }).click();
      await page390.screenshot({ path: join(resultDir, `human-${label.startsWith("UML") ? "uml" : "structure"}-390.png`), fullPage: true });
    }
    await page390.getByRole("button", { name: "Interface Catalog", exact: true }).click();
    checks.push("human document hides hashes and renders both colored SVG diagrams with zoom at 390px");
    const createPath = new URL(exportCollectionPath(base, readyAnalysis.analysisId)).pathname;
    const create390Promise = waitForApiResponse(page390, createPath, "POST");
    await page390.getByRole("button", { name: "Ekspor PDF", exact: true }).click();
    const create390Response = await create390Promise;
    assert.ok(create390Response.status() === 200 || create390Response.status() === 202);
    assert.deepEqual(create390Response.request().postDataJSON(), { format: "PDF" }, "PDF UI must use the canonical POST {format: PDF} request");
    const create390Data = parseExportData(await readJson(create390Response), "PDF");
    validateExportMetadata(create390Data, readyAnalysis, owner, "PDF");
    pdfExportId = create390Data.export.id;
    pdfRendererVersion = create390Data.export.rendererVersion;
    const staleAccount = await api.get(exportStatusPath(base, readyAnalysis.analysisId, pdfExportId), {
      headers: { Cookie: `sage_session=${owner.token}`, "X-SAGE-Account": other.accountKey },
    });
    assert.equal(staleAccount.status(), 401, "valid old session with a mismatched selected-account header must be rejected");
    const unauthenticated = await api.get(exportStatusPath(base, readyAnalysis.analysisId, pdfExportId));
    assert.equal(unauthenticated.status(), 401);
    checks.push("stale selected-account and unauthenticated nested status requests are rejected with 401");
    const readyPdf = await waitForExportStatus(api, base, readyAnalysis.analysisId, pdfExportId, owner, "READY");
    validateExportMetadata(readyPdf, readyAnalysis, owner, "PDF");
    assert.equal(readyPdf.export.rendererVersion, pdfRendererVersion);
    await page390.getByRole("button", { name: "Unduh PDF", exact: true }).waitFor();
    await page390.screenshot({ path: join(resultDir, "pdf-21-390-ready.png"), fullPage: true });
    screenshots.push("pdf-21-390-ready.png");
    const browserDownload390Promise = page390.waitForEvent("download");
    await page390.getByRole("button", { name: "Unduh PDF", exact: true }).click();
    const browserDownload390 = await browserDownload390Promise;
    const downloaded390 = await saveBrowserDownload(browserDownload390, join(resultDir, "sage-pdf21-browser-390.pdf"));
    const expectedSlug = readyAnalysis.snapshot.repository.split("/").at(-1)!.toLowerCase();
    assert.equal(downloaded390.filename, `sage-${expectedSlug}-${readyAnalysis.snapshot.commitSha.slice(0, 7)}.pdf`);
    const responseDownloadOne = await verifyPdfDownload(api, base, readyAnalysis, pdfExportId, owner);
    const responseDownloadTwo = await verifyPdfDownload(api, base, readyAnalysis, pdfExportId, owner);
    assert.deepEqual(responseDownloadTwo.bytes, responseDownloadOne.bytes, "repeated download of the same READY export must be byte-identical");
    assert.deepEqual(downloaded390.bytes, responseDownloadOne.bytes, "390px browser attachment must equal the READY private file bytes");
    pdfBytes = responseDownloadOne.bytes;
    pdfHash = responseDownloadOne.hash;
    checks.push("390px browser created PDF through real POST, downloaded the worker-produced attachment, and repeated READY downloads were byte-identical");

    const context1440 = await createBrowserContext(browser, base, owner, 1440);
    const page1440 = await openDocumentPage(context1440, base, readyAnalysis.analysisId, browserAudit, parsedBase.origin, "PDF export 1440px");
    await checkWorkspaceExperience(page1440, base, readyAnalysis.analysisId, readyAnalysis.document, resultDir, 1440, clockProbe);
    checks.push("1440px real workspace: centered geometry, bounded searchable catalog, commit-pinned evidence, graph controls, progress and removed preview navigation");
    for (const label of ["Software Engineering Diagram", "UML Class Diagram"]) {
      await page1440.getByRole("button", { name: label, exact: true }).click();
      await page1440.getByRole("img", { name: label, exact: true }).waitFor({ timeout: 30_000 });
      await page1440.locator("summary", { hasText: "Bukti node pada diagram" }).click();
      assert.equal(await page1440.locator("details[open] summary", { hasText: "Bukti node pada diagram" }).count(), 1);
      await page1440.screenshot({ path: join(resultDir, `human-${label.startsWith("UML") ? "uml" : "structure"}-1440.png`), fullPage: true });
    }
    await page1440.getByRole("button", { name: "Interface Catalog", exact: true }).click();
    const create1440Promise = waitForApiResponse(page1440, createPath, "POST");
    await page1440.getByRole("button", { name: "Ekspor PDF", exact: true }).click();
    const create1440Response = await create1440Promise;
    assert.equal(create1440Response.status(), 200, "repeat PDF POST must deduplicate to the existing READY record");
    const create1440Data = parseExportData(await readJson(create1440Response), "PDF");
    assert.equal(create1440Data.export.id, pdfExportId);
    assert.equal(create1440Data.export.rendererVersion, pdfRendererVersion);
    await page1440.getByRole("button", { name: "Unduh PDF", exact: true }).waitFor();
    await page1440.screenshot({ path: join(resultDir, "pdf-21-1440-ready.png"), fullPage: true });
    screenshots.push("pdf-21-1440-ready.png");
    const browserDownload1440Promise = page1440.waitForEvent("download");
    await page1440.getByRole("button", { name: "Unduh PDF", exact: true }).click();
    const browserDownload1440 = await browserDownload1440Promise;
    const downloaded1440 = await saveBrowserDownload(browserDownload1440, join(resultDir, "sage-pdf21-browser-1440.pdf"));
    assert.equal(downloaded1440.filename, downloaded390.filename);
    assert.deepEqual(downloaded1440.bytes, downloaded390.bytes, "390px and 1440px downloads must use the same READY object");
    checks.push("1440px browser created a deduplicated PDF and downloaded the same READY bytes as the 390px browser");
    await context1440.close();
    await context390.close();

    const pdfStatus = await api.get(exportStatusPath(base, readyAnalysis.analysisId, pdfExportId), { headers: apiHeaders(owner) });
    assert.equal(pdfStatus.status(), 200);
    validateExportMetadata(parseExportData(await readJson(pdfStatus), "PDF"), readyAnalysis, owner, "PDF");
    const pdfStatusWithQuery = await api.get(`${exportStatusPath(base, readyAnalysis.analysisId, pdfExportId)}?unexpected=1`, { headers: apiHeaders(owner) });
    assert.equal(pdfStatusWithQuery.status(), 400);
    const foreignStatus = await api.get(exportStatusPath(base, readyAnalysis.analysisId, pdfExportId), { headers: apiHeaders(other) });
    assert.equal(foreignStatus.status(), 404);
    const foreignDownload = await api.get(exportDownloadPath(base, readyAnalysis.analysisId, pdfExportId), { headers: apiHeaders(other) });
    assert.equal(foreignDownload.status(), 404);
    const foreignRetry = await api.post(exportRetryPath(base, readyAnalysis.analysisId, pdfExportId), {
      headers: postHeaders(other, parsedBase.origin), data: {},
    });
    assert.equal(foreignRetry.status(), 404);
    checks.push("nested status/retry/download paths enforce owner scope: owner reads READY; foreign account receives 404");

    const pdfStorage = await db.export.findUniqueOrThrow({
      where: { id: pdfExportId },
      select: { ownerUserId: true, analysisId: true, format: true, status: true, documentHash: true, rendererVersion: true, contentHash: true,
        storageObject: { select: { storageKey: true, sha256: true, byteLength: true, type: true, status: true } } },
    });
    assert.equal(pdfStorage.ownerUserId, owner.userId);
    assert.equal(pdfStorage.analysisId, readyAnalysis.analysisId);
    assert.equal(pdfStorage.format, "PDF");
    assert.equal(pdfStorage.status, "READY");
    assert.equal(pdfStorage.contentHash, pdfHash);
    assert.ok(pdfStorage.storageObject);
    assert.equal(pdfStorage.storageObject.type, "EXPORT");
    assert.equal(pdfStorage.storageObject.status, "ACTIVE");
    assert.equal(pdfStorage.storageObject.sha256, pdfHash);
    assert.equal(Number(pdfStorage.storageObject.byteLength), pdfBytes.byteLength);
    const storageKey = pdfStorage.storageObject.storageKey;
    assert.match(storageKey, /^export-[A-Za-z0-9-]{36}\/document\.pdf$/i);
    const storedPath = resolve(storageRoot, ...storageKey.split("/"));
    assert.ok(storedPath.startsWith(`${resolve(storageRoot)}${sep}`));
    const storedFolder = await lstat(dirname(storedPath));
    const storedFile = await lstat(storedPath);
    assert.ok(storedFolder.isDirectory() && !storedFolder.isSymbolicLink());
    assert.ok(storedFile.isFile() && !storedFile.isSymbolicLink());
    if (process.platform !== "win32") {
      assert.equal(storedFolder.mode & 0o777, 0o700);
      assert.equal(storedFile.mode & 0o777, 0o600);
    }
    const storedBytes = await readFile(storedPath);
    assert.deepEqual(storedBytes, pdfBytes, "private stored file must match the verified PDF attachment");
    assertPdfBytes(storedBytes, "Private stored export");
    checks.push("PDF attachment is application/pdf, starts with %PDF-, and matches owner-bound ACTIVE private storage checksum/length/0600 file");

    const markdownPost = await api.post(exportCollectionPath(base, readyAnalysis.analysisId), {
      headers: postHeaders(owner, parsedBase.origin), data: { format: "MARKDOWN" },
    });
    assert.ok(markdownPost.status() === 200 || markdownPost.status() === 202);
    const markdownCreated = parseExportData(await readJson(markdownPost), "MARKDOWN");
    validateExportMetadata(markdownCreated, readyAnalysis, owner, "MARKDOWN");
    markdownExportId = markdownCreated.export.id;
    assert.notEqual(markdownExportId, pdfExportId, "format is part of export deduplication; PDF and Markdown require separate rows");
    assert.equal(markdownCreated.export.rendererVersion, MARKDOWN_RENDERER_VERSION);
    const readyMarkdown = await waitForExportStatus(api, base, readyAnalysis.analysisId, markdownExportId, owner, "READY");
    validateExportMetadata(readyMarkdown, readyAnalysis, owner, "MARKDOWN");
    const markdownFile = await verifyMarkdownDownload(api, base, readyAnalysis, markdownExportId, owner);
    expectedMarkdown = Buffer.from(renderMarkdownDocument(readyAnalysis.document), "utf8");
    assert.deepEqual(markdownFile.bytes, expectedMarkdown, "legacy worker Markdown bytes must match the canonical renderer output");
    markdownHash = markdownFile.hash;
    checks.push("legacy Markdown path still creates/downloads through the production worker and exactly matches renderMarkdownDocument");

    // Hold a real 200 PDF response while the session cookie changes. The UI
    // must revalidate identity after the Blob arrives and suppress the download.
    const delayedContext = await createBrowserContext(browser, base, owner, 390);
    const delayedPage = await openDocumentPage(delayedContext, base, readyAnalysis.analysisId, browserAudit, parsedBase.origin, "delayed PDF attachment account switch");
    const delayedCreatePromise = waitForApiResponse(delayedPage, createPath, "POST");
    await delayedPage.getByRole("button", { name: "Ekspor PDF", exact: true }).click();
    assert.equal((await delayedCreatePromise).status(), 200);
    await delayedPage.getByRole("button", { name: "Unduh PDF", exact: true }).waitFor();
    let releaseDelayedDownload: () => void = () => {};
    let signalDelayedDownload: () => void = () => {};
    const delayedDownloadGate = new Promise<void>(resolveGate => { releaseDelayedDownload = resolveGate; });
    const delayedDownloadReady = new Promise<void>(resolveGate => { signalDelayedDownload = resolveGate; });
    let heldDownloadStatus = 0;
    await delayedPage.route(exportDownloadPath(base, readyAnalysis.analysisId, pdfExportId), async route => {
      const actual: APIResponse = await route.fetch();
      heldDownloadStatus = actual.status();
      signalDelayedDownload();
      await delayedDownloadGate;
      try { await route.fulfill({ response: actual }); } catch { /* auth refresh can abort the held request */ }
    });
    let leakedDownloadCount = 0;
    delayedPage.on("download", () => { leakedDownloadCount += 1; });
    await delayedPage.getByRole("button", { name: "Unduh PDF", exact: true }).click();
    await delayedDownloadReady;
    assert.equal(heldDownloadStatus, 200, "held response must be the real owner attachment");
    await delayedContext.addCookies([{ name: "sage_session", value: other.token, url: base, httpOnly: true, sameSite: "Lax" }]);
    const ownerSession401 = delayedPage.waitForResponse(response => {
      const url = new URL(response.url());
      return url.pathname === "/api/auth/session" && response.request().headers()["x-sage-account"] === owner!.accountKey && response.status() === 401;
    });
    await delayedPage.evaluate(() => window.dispatchEvent(new Event("focus")));
    await ownerSession401;
    releaseDelayedDownload();
    await delayedPage.getByRole("alert").filter({ hasText: "Analisis tidak ditemukan." }).waitFor();
    await delayedPage.waitForTimeout(250);
    assert.equal(leakedDownloadCount, 0, "late owner-A PDF attachment must not become an account-B browser download");
    assert.equal(await delayedPage.getByRole("button", { name: "Unduh PDF", exact: true }).count(), 0);
    await delayedContext.close();
    checks.push("delayed real PDF attachment revalidates the session after body transfer; account switch exposes no old-account download");

    // Queue the damaged target behind an expired, DB-seeded test lease. This
    // makes the fault happen after the real POST but before the real consumer.
    blocker = await seedWorkerSlotBlocker(db, {
      ownerUserId: owner.userId, analysis: blockerAnalysis, rendererVersion: pdfRendererVersion,
    });
    const recoveryContext = await createBrowserContext(browser, base, owner, 390);
    const recoveryPage = await openDocumentPage(recoveryContext, base, recoveryAnalysis.analysisId, browserAudit, parsedBase.origin, "PDF worker failure and retry");
    const recoveryCreatePath = new URL(exportCollectionPath(base, recoveryAnalysis.analysisId)).pathname;
    const recoveryCreatePromise = waitForApiResponse(recoveryPage, recoveryCreatePath, "POST");
    await recoveryPage.getByRole("button", { name: "Ekspor PDF", exact: true }).click();
    const recoveryCreateResponse = await recoveryCreatePromise;
    assert.ok(recoveryCreateResponse.status() === 200 || recoveryCreateResponse.status() === 202);
    const recoveryCreated = parseExportData(await readJson(recoveryCreateResponse), "PDF");
    validateExportMetadata(recoveryCreated, recoveryAnalysis, owner, "PDF");
    assert.equal(recoveryCreated.export.status, "QUEUED", "test-only lease must hold the real PDF POST behind the worker slot");
    const recoveryExportId = recoveryCreated.export.id;
    assert.equal(recoveryCreated.export.rendererVersion, pdfRendererVersion);
    const corruptedHash = recoveryAnalysis.archive.sha256 === "0".repeat(64) ? "1".repeat(64) : "0".repeat(64);
    failureInjection = "After the real PDF POST queued behind a test-only lease, changed only the source archive StorageObject.sha256. Production lease recovery and the real worker produced EXPORT_FAILED; the original archive checksum was restored before POST retry.";
    try {
      await db.storageObject.update({ where: { id: recoveryAnalysis.archive.id }, data: { sha256: corruptedHash } });
      await expireWorkerSlotBlocker(db, blocker);
      await waitForBlockerRecovery(db, blocker);
      const failed = await waitForExportStatus(api, base, recoveryAnalysis.analysisId, recoveryExportId, owner, "FAILED");
      recoveredFailureCode = failed.export.errorCode ?? undefined;
      assert.equal(recoveredFailureCode, "EXPORT_FAILED", "archive integrity exception must follow the production worker's generic failure contract");
      await recoveryPage.getByRole("button", { name: "Coba ekspor PDF lagi", exact: true }).waitFor();
      await recoveryPage.screenshot({ path: join(resultDir, "pdf-21-390-failed.png"), fullPage: true });
      screenshots.push("pdf-21-390-failed.png");
    } finally {
      await db.storageObject.update({ where: { id: recoveryAnalysis.archive.id }, data: { sha256: recoveryAnalysis.archive.sha256 } });
    }
    checks.push("actual source archive checksum fault reaches production PDF worker and fails as EXPORT_FAILED; source hash restored before retry POST");

    const retryPath = new URL(exportRetryPath(base, recoveryAnalysis.analysisId, recoveryExportId)).pathname;
    const retryResponsePromise = waitForApiResponse(recoveryPage, retryPath, "POST");
    await recoveryPage.getByRole("button", { name: "Coba ekspor PDF lagi", exact: true }).click();
    const retryResponse = await retryResponsePromise;
    assert.equal(retryResponse.status(), 202);
    const retryData = parseExportData(await readJson(retryResponse), "PDF");
    validateExportMetadata(retryData, recoveryAnalysis, owner, "PDF");
    assert.equal(retryData.export.id, recoveryExportId, "retry must keep the export identity");
    assert.equal(retryData.export.documentHash, recoveryCreated.export.documentHash);
    assert.equal(retryData.export.rendererVersion, recoveryCreated.export.rendererVersion);
    assert.ok(["QUEUED", "GENERATING", "READY"].includes(retryData.export.status));
    const retried = await waitForExportStatus(api, base, recoveryAnalysis.analysisId, recoveryExportId, owner, "READY");
    validateExportMetadata(retried, recoveryAnalysis, owner, "PDF");
    assert.equal(retried.export.documentHash, recoveryCreated.export.documentHash);
    assert.equal(retried.export.rendererVersion, recoveryCreated.export.rendererVersion);
    await recoveryPage.getByRole("button", { name: "Unduh PDF", exact: true }).waitFor();
    await recoveryPage.screenshot({ path: join(resultDir, "pdf-21-390-retried-ready.png"), fullPage: true });
    screenshots.push("pdf-21-390-retried-ready.png");
    const retryDownloadPromise = recoveryPage.waitForEvent("download");
    await recoveryPage.getByRole("button", { name: "Unduh PDF", exact: true }).click();
    const retryDownload = await retryDownloadPromise;
    const retryFile = await saveBrowserDownload(retryDownload, join(resultDir, "sage-pdf21-browser-retry.pdf"));
    const retryVerified = await verifyPdfDownload(api, base, recoveryAnalysis, recoveryExportId, owner);
    assert.deepEqual(retryFile.bytes, retryVerified.bytes, "retried browser download must match the retried READY storage object");
    assert.equal(retryVerified.hash, retried.export.contentHash);
    checks.push("retry uses the real API and production consumer, keeps format/document hash/renderer version, and downloads a valid PDF");
    await recoveryContext.close();

    const blockerFailure = await db.export.findUnique({ where: { id: blocker.exportId }, select: { status: true, errorCode: true } });
    const targetFailure = await db.export.findUnique({ where: { id: recoveryExportId }, select: { status: true, errorCode: true } });
    assert.deepEqual(blockerFailure, { status: "FAILED", errorCode: "WORKER_INTERRUPTED" });
    assert.deepEqual(targetFailure, { status: "READY", errorCode: null });
    checks.push("real consumer recovered the expired test lease, failed the archive-integrity export, and completed its real retry");

    assert.equal(browserAudit.offOrigin, 0, "browser regression must remain same-origin");
    assert.equal(browserAudit.provider, 0, "browser regression must not contact GitHub/provider APIs");
    assert.deepEqual(browserAudit.errors, [], "browser pages must finish without uncaught errors");
    const bceSource = await readFile(new URL("../tests/fixtures/architecture-bce/order.ts", import.meta.url));
    const bceSnapshot = { ...fixture.snapshot, commitSha: "c".repeat(40) };
    const bceSources = { "src/order.ts": new Uint8Array(bceSource) };
    const bceResolved = analyzeReferences({ snapshot: bceSnapshot, sources: bceSources });
    assert.ok(bceResolved.ccm, "BCE source fixture must produce canonical CCM");
    assert.equal(bceResolved.ccm.edges.filter(edge => edge.resolution === "Unresolved").length, 0, "supported BCE dependency/receiver fixture must resolve without guesses");
    const bceAnalysis = await seedAnalysis(db, { ownerUserId: owner.userId, repositoryId,
      fixture: { sources: bceSources, ccm: bceResolved.ccm, snapshot: bceSnapshot, configurationHash: digest("bce-v1") },
      storageRoot, label: "bce-main-classes", storageObjectIds, createdFolders });
    analysisIds.push(bceAnalysis.analysisId);
    for (const width of [390, 1440]) {
      const bceContext = await createBrowserContext(browser, base, owner, width);
      try { await checkBceWorkspace(await bceContext.newPage(), base, bceAnalysis.analysisId, resultDir, width); }
      finally { await bceContext.close(); }
    }
    const bceCreatedResponse = await api.post(exportCollectionPath(base, bceAnalysis.analysisId), {
      headers: postHeaders(owner, parsedBase.origin), data: { format: "PDF" },
    });
    assert.equal(bceCreatedResponse.status(), 202);
    const bceCreated = parseExportData(await readJson(bceCreatedResponse), "PDF");
    await waitForExportStatus(api, base, bceAnalysis.analysisId, bceCreated.export.id, owner, "READY");
    const bcePdf = await verifyPdfDownload(api, base, bceAnalysis, bceCreated.export.id, owner);
    await writeFile(join(resultDir, "bce-main-classes.pdf"), bcePdf.bytes);
    checks.push("BCE fixture: local/injected/inherited receivers resolve; all five main classifiers and dependency lines render on 390/1440 px with portrait aspect ratio; PDF exported by production worker");
    checks.push("tested browser paths make no off-origin/provider requests and have no uncaught page errors");
  } catch (error) {
    reportStatus = "FAIL";
    reportError = error instanceof Error ? error.message : "Live PDF export regression failed.";
    failures.push(reportError);
  } finally {
    await browser?.close().catch(() => undefined);
    await api?.dispose().catch(() => undefined);
    try {
      if (recoveryAnalysis && storageObjectIds.includes(recoveryAnalysis.archive.id)) {
        await db.storageObject.updateMany({ where: { id: recoveryAnalysis.archive.id }, data: { sha256: recoveryAnalysis.archive.sha256 } });
      }
      if (analysisIds.length) await removeOwnedExportFiles(db, storageRoot, analysisIds);
      const exports = analysisIds.length
        ? await db.export.findMany({ where: { analysisId: { in: analysisIds }, ownerUserId: { in: users } }, select: { id: true } }) : [];
      const exportIds = exports.map(row => row.id);
      if (exportIds.length) await db.job.deleteMany({ where: { exportId: { in: exportIds }, ownerUserId: { in: users } } });
      if (analysisIds.length) await db.job.deleteMany({ where: { analysisId: { in: analysisIds }, ownerUserId: { in: users }, type: "EXPORT" } });
      if (analysisIds.length) await db.export.deleteMany({ where: { analysisId: { in: analysisIds }, ownerUserId: { in: users } } });
      if (analysisIds.length) await db.storageObject.deleteMany({ where: { analysisId: { in: analysisIds }, ownerUserId: { in: users } } });
      if (storageObjectIds.length) await db.storageObject.deleteMany({ where: { id: { in: storageObjectIds } } });
      if (analysisIds.length) {
        await db.architectureDocument.deleteMany({ where: { analysisId: { in: analysisIds }, ownerUserId: { in: users } } });
        await db.graphBundle.deleteMany({ where: { analysisId: { in: analysisIds }, ownerUserId: { in: users } } });
        await db.analysis.deleteMany({ where: { id: { in: analysisIds }, ownerUserId: { in: users } } });
      }
      if (sessionIds.length) await db.session.deleteMany({ where: { id: { in: sessionIds } } });
      if (users.length) await db.gitHubConnection.deleteMany({ where: { userId: { in: users } } });
      if (users.length) await db.user.deleteMany({ where: { id: { in: users } } });
      if (repositoryId) await db.repository.deleteMany({ where: { id: repositoryId } });
    } catch (cleanupError) {
      reportStatus = "FAIL";
      const message = cleanupError instanceof Error ? cleanupError.message : "Fixture database cleanup failed.";
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
    const report = {
      checkedAt: new Date().toISOString(),
      status: reportStatus,
      storageLayoutVersion: process.env.SAGE_TEST_STORAGE_LAYOUT === "2" ? 2 : 1,
      failures,
      reportError,
      checks,
      artifactsDirectory: artifactDirReady ? resultDir : null,
      artifactFiles: artifactDirReady ? [...await readdir(resultDir).catch(() => []), "report.json"].sort() : [],
      screenshots,
      expectedDocument: readyAnalysis ? {
        file: "expected-document.json",
        canonicalDocumentHash: readyAnalysis.documentHash,
        canonicalDocumentJsonSha256: digest(readyAnalysis.documentJson),
        canonicalCkgHash: readyAnalysis.ckgHash,
        repository: readyAnalysis.snapshot.repository,
        branch: readyAnalysis.snapshot.branch,
        commitSha: readyAnalysis.snapshot.commitSha,
        nodeCount: readyAnalysis.document.canonicalCounts.nodes,
        edgeCount: readyAnalysis.document.canonicalCounts.edges,
        title: readyAnalysis.document.title,
        limitationCount: readyAnalysis.document.limitations.length,
      } : null,
      pdf: {
        exportId: pdfExportId ?? null,
        rendererVersion: pdfRendererVersion ?? null,
        sha256: pdfHash ?? null,
        byteLength: pdfBytes?.byteLength ?? null,
        contentType: "application/pdf",
        signature: pdfBytes ? pdfBytes.subarray(0, PDF_SIGNATURE.byteLength).toString("ascii") : null,
        browserFiles: ["sage-pdf21-browser-390.pdf", "sage-pdf21-browser-1440.pdf", "sage-pdf21-browser-retry.pdf"],
      },
      markdownControl: {
        exportId: markdownExportId ?? null,
        rendererVersion: MARKDOWN_RENDERER_VERSION,
        expectedSha256: expectedMarkdown ? digest(expectedMarkdown) : null,
        downloadedSha256: markdownHash ?? null,
        exactRendererMatch: expectedMarkdown && markdownHash ? digest(expectedMarkdown) === markdownHash : null,
      },
      retry: { actualFailureCode: recoveredFailureCode ?? null, injectedFault: failureInjection ?? null },
      browser: { offOriginRequests: browserAudit.offOrigin, providerRequests: browserAudit.provider, pageErrors: browserAudit.errors },
      viewports: [390, 1440],
      safeFixtureBoundaries: {
        accountAndSyntheticProviderTokens: "never included in artifacts",
        rawSourceCanary: "PDF21_RAW_SOURCE_CANARY; must not appear in exported document",
        sourceUrlCanary: "PDF21_URL_CANARY; must not be included or fetched",
        storageRoot: "private empty temporary directory; only fixture-owned archive/export files are cleaned",
      },
    };
    if (artifactDirReady) {
      await writeFile(join(resultDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 }).catch(writeError => {
        reportStatus = "FAIL";
        const message = writeError instanceof Error ? writeError.message : "Could not write the report.";
        console.error(`SAGE_PDF_REPORT_WRITE_FAILED ${message}`);
      });
    }
    console.log(JSON.stringify(report, null, 2));
  }
  if (reportStatus !== "PASS") process.exitCode = 1;
}

async function main(): Promise<void> {
  await runLivePdfExportRegression();
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : "Live PDF export regression failed.");
  process.exitCode = 1;
});
