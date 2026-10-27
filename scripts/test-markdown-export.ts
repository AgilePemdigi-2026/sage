import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
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
 * Live EXP-01 regression. This requires the disposable sage_export20 database,
 * the test-only encryption key, private empty storage shared with Next/worker,
 * and a production Next.js + worker pair. It never contacts GitHub.
 *
 *   SAGE_EXPORT_TESTS=1 \
 *   DATABASE_URL=postgresql://sage@sage-export20-db:5432/sage_export20 \
 *   CREDENTIAL_ENCRYPTION_KEY=<test-only-32-byte-base64> \
 *   STORAGE_ROOT=/tmp/sage-export20-storage \
 *   SAGE_EXPORT_BASE_URL=http://127.0.0.1:3000 \
 *   SAGE_EXPORT_ARTIFACT_DIR=artifacts/export-20/2026-10-27-run1 \
 *   npx tsx scripts/test-markdown-export.ts
 *
 * The success and retry exports are queued over real HTTP and completed by the
 * production worker consumer. A test-only running export lease holds the
 * single export slot to inject a deterministic source-integrity failure; the
 * production consumer expires that lease, fails the damaged export, and then
 * processes the real HTTP retry after the fixture hash is restored.
 */

type DisposableAccount = {
  userId: string;
  login: string;
  accountKey: string;
  token: string;
  syntheticProviderToken: string;
};

type ExportRecord = {
  id: string;
  format: "MARKDOWN";
  status: "QUEUED" | "GENERATING" | "READY" | "FAILED";
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
const requireFromScript = createRequire(import.meta.url);
const markedPackage = requireFromScript("marked") as { marked?: { parse(markdown: string, options?: Record<string, unknown>): string | Promise<string> } };
const markdownParser = markedPackage.marked;
assert.ok(markdownParser, "the locked Mermaid dependency must provide the Markdown viewer parser");

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

function parseExportData(value: unknown): ExportData {
  assert.ok(hasOwnRecord(value) && hasOwnRecord(value.data), "export response must contain data");
  const data = value.data;
  assert.ok(typeof data.analysisId === "string", "export response must bind to an analysis");
  assert.ok(typeof data.accountKey === "string", "export response must bind to an account");
  assert.ok(hasOwnRecord(data.export), "export response must contain an export record");
  const row = data.export;
  assert.ok(typeof row.id === "string" && row.id.length > 0, "export id must be present");
  assert.equal(row.format, "MARKDOWN");
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

async function readErrorCode(response: APIResponse): Promise<string | undefined> {
  const body: unknown = await readJson(response);
  return hasOwnRecord(body) && hasOwnRecord(body.error) && typeof body.error.code === "string"
    ? body.error.code
    : undefined;
}

function requireDedicatedDatabase(): void {
  if (process.env.SAGE_EXPORT_TESTS !== "1") {
    throw new Error("Set SAGE_EXPORT_TESTS=1 to opt in to the destructive isolated EXP-01 integration regression.");
  }
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error("DATABASE_URL is required when SAGE_EXPORT_TESTS=1.");
  let databaseName: string;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") throw new Error("protocol");
    databaseName = decodeURIComponent(parsed.pathname.slice(1));
  } catch {
    throw new Error("DATABASE_URL must be a valid PostgreSQL URL; it was not logged.");
  }
  if (databaseName !== "sage_export20") {
    throw new Error("Live Markdown export regression only allows the isolated sage_export20 database.");
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
  if ((await readdir(requested)).length > 0) throw new Error("STORAGE_ROOT must be an empty EXP-01 fixture directory.");
  return requested;
}

function artifactDirectory(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const suffix = randomBytes(3).toString("hex");
  const raw = process.env.SAGE_EXPORT_ARTIFACT_DIR ?? `artifacts/export-20/${stamp}-${suffix}`;
  return isAbsolute(raw) ? resolve(raw) : resolve(projectRoot, raw);
}

async function prepareArtifactDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  if ((await readdir(path)).length > 0) throw new Error("SAGE_EXPORT_ARTIFACT_DIR must be empty; refusing to overwrite previous evidence.");
}

async function makeTarGz(sources: Readonly<Record<string, Uint8Array>>): Promise<Buffer> {
  const tar = pack();
  const root = `sage-export20-source-${randomBytes(4).toString("hex")}`;
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
  await add(`${root}/`, Buffer.alloc(0), "directory");
  const directories = new Set<string>();
  for (const path of Object.keys(sources)) {
    let parent = dirname(path);
    while (parent !== ".") {
      directories.add(parent);
      parent = dirname(parent);
    }
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
  sources["src/export-contract.ts"] = new Uint8Array(Buffer.from([
    "export interface MarkdownExportContract { render(input: string): string; }",
    "export class MarkdownExportService implements MarkdownExportContract {",
    "  render(input: string): string { return `${input}:${missingFormatter.format(input)}`; }",
    "}",
    'export const sourceCanary = "EXPORT20_RAW_SOURCE_CANARY";',
    'export const urlCanary = "https://export20.invalid/EXPORT20_URL_CANARY";',
    "// The worker output must use the snapshot document, not raw source text.",
  ].join("\n"), "utf8"));
  const snapshot: CcmSnapshot = {
    repository: "sage-export20/markdown-fixture",
    branch: "feature/export-20",
    commitSha: "a".repeat(40),
  };
  const configurationHash = digest("SAGE EXP-01 disposable regression configuration v1");
  const result = await analyzeReferences({ snapshot, sources });
  assert.equal(result.errorCode, null, "checked-in TypeScript fixtures must analyze successfully");
  assert.ok(result.ccm, "analyzer fixture must produce a canonical CCM");
  const presentKinds = new Set(result.ccm.nodes.map(node => node.kind));
  for (const kind of ["Class", "Interface", "Function", "Method", "Property", "UnresolvedReference"] as const) {
    assert.ok(presentKinds.has(kind), `fixture should include ${kind}`);
  }
  assert.ok(result.ccm.edges.some(edge => edge.resolution === "Unresolved"), "fixture must include unresolved relation evidence");
  assert.ok(result.ccm.nodes.some(node => node.name === "MarkdownExportService"), "fixture includes its export contract class");
  const limitation = {
    path: "src/export-contract.ts",
    reason: "EXP-01 fixture retains an explicit partial-analysis limitation so the export can prove it preserves caveats.",
    stage: "STATIC_ANALYSIS",
  };
  const ccm: CcmV1 = { ...result.ccm, limitations: [...result.ccm.limitations, limitation] };
  return { sources, ccm, snapshot, configurationHash };
}

async function makeAccount(
  db: ReturnType<typeof database>,
  label: string,
  users: string[],
  sessions: string[],
): Promise<DisposableAccount> {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const login = `export20-${label}-${suffix}`;
  const accountKey = `export20-gh-${label}-${suffix}`;
  const syntheticProviderToken = `synthetic-not-provider-export20-${label}-${suffix}`;
  const user = await db.user.create({ data: { githubUserId: accountKey, login }, select: { id: true } });
  users.push(user.id);
  await storeGitHubCredential(db, user.id, { githubUserId: accountKey, githubLogin: login, accessToken: syntheticProviderToken });
  const created = await createSession(db, user.id, { ttlMs: 30 * 60 * 1000 });
  sessions.push(created.session.sessionId);
  return { userId: user.id, login, accountKey, token: created.token, syntheticProviderToken };
}

async function createArchiveStorage(
  db: ReturnType<typeof database>,
  storageRoot: string,
  ownerUserId: string,
  analysisId: string,
  sources: Readonly<Record<string, Uint8Array>>,
  storageObjectIds: string[],
  createdFolders: string[],
): Promise<SeededAnalysis["archive"]> {
  const bytes = await makeTarGz(sources);
  const folder = await mkdtemp(join(storageRoot, "snapshot-"));
  createdFolders.push(folder);
  const folderName = basename(folder);
  assert.match(folderName, /^snapshot-[A-Za-z0-9]{6}$/);
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
  input: {
    ownerUserId: string;
    repositoryId: string;
    fixture: Awaited<ReturnType<typeof loadFixture>>;
    storageRoot: string;
    label: string;
    storageObjectIds: string[];
    createdFolders: string[];
  },
): Promise<SeededAnalysis> {
  const canonical = canonicalizeCkg(input.fixture.ccm, input.fixture.sources, input.fixture.configurationHash);
  if (!canonical.ok) throw new Error(`CKG canonicalization failed: ${canonical.errorCode}`);
  const projected = projectDocument(canonical.json, input.fixture.sources, canonical.sha256);
  if (!projected.ok) throw new Error(`Architecture document projection failed: ${projected.errorCode}`);
  const now = new Date();
  const analysis = await db.analysis.create({
    data: {
      ownerUserId: input.ownerUserId,
      repositoryId: input.repositoryId,
      repositoryFullNameSnapshot: input.fixture.snapshot.repository,
      branchName: input.fixture.snapshot.branch ?? "main",
      commitSha: input.fixture.snapshot.commitSha,
      configuration: { issue: "EXP-01", fixture: input.label },
      configurationHash: input.fixture.configurationHash,
      analyzerVersion: "sage-analyzer-js-exp01-live-fixture",
      schemaVersion: "1",
      status: "COMPLETED_WITH_LIMITATIONS",
      completedAt: now,
    },
    select: { id: true },
  });
  await db.graphBundle.create({
    data: {
      ownerUserId: input.ownerUserId,
      analysisId: analysis.id,
      schemaVersion: canonical.value.schemaVersion,
      configurationHash: input.fixture.configurationHash,
      canonicalContent: canonical.json,
      nodes: JSON.stringify(canonical.value.ccm.nodes),
      edges: JSON.stringify(canonical.value.ccm.edges),
      nodeCount: canonical.value.counts.nodes,
      edgeCount: canonical.value.counts.edges,
      contentHash: canonical.sha256,
    },
  });
  const documentRow = await db.architectureDocument.create({
    data: {
      ownerUserId: input.ownerUserId,
      analysisId: analysis.id,
      title: projected.value.title,
      documentModelVersion: projected.value.schemaVersion,
      canonicalContent: projected.json,
      interfaceCatalog: JSON.stringify(projected.value.interfaceCatalog),
      softwareEngineeringDiagram: JSON.stringify(projected.value.softwareEngineeringDiagram),
      umlClassDiagram: JSON.stringify(projected.value.umlClassDiagram),
      contentHash: projected.sha256,
    },
    select: { id: true },
  });
  const archive = await createArchiveStorage(
    db, input.storageRoot, input.ownerUserId, analysis.id, input.fixture.sources, input.storageObjectIds, input.createdFolders,
  );
  if (process.env.SAGE_TEST_STORAGE_LAYOUT === "2") {
    const compacted = await compactAnalysisStorage(db, analysis.id, { apply: true, sourceBytes: input.fixture.sources });
    assert.equal(compacted.status, "compacted", "browser fixture must use the verified canonical-only storage layout");
    assert.equal(compacted.graphs, 1);
    assert.equal(compacted.documents, 1);
  }
  return {
    analysisId: analysis.id,
    documentId: documentRow.id,
    document: projected.value,
    documentJson: projected.json,
    documentHash: projected.sha256,
    ckgHash: canonical.sha256,
    snapshot: input.fixture.snapshot,
    configurationHash: input.fixture.configurationHash,
    sourceBytes: input.fixture.sources,
    archive,
  };
}

function projectDocument(canonicalJson: string, sources: Record<string, Uint8Array>, ckgHash: string) {
  // Importing via the package surface keeps this live script aligned with the product model.
  return projectArchitectureDocument(canonicalJson, sources, ckgHash);
}

async function createAnalysisRepository(db: ReturnType<typeof database>, ownerLogin: string): Promise<string> {
  const row = await db.repository.create({
    data: {
      githubRepositoryId: `export20-repo-${randomUUID()}`,
      ownerLogin,
      name: "markdown-export-fixture",
      fullName: `${ownerLogin}/markdown-export-fixture`,
      visibility: "PRIVATE",
      defaultBranch: "feature/export-20",
    },
    select: { id: true },
  });
  return row.id;
}

async function seedWorkerSlotBlocker(
  db: ReturnType<typeof database>,
  input: { ownerUserId: string; analysis: SeededAnalysis },
): Promise<Blocker> {
  return db.$transaction(async tx => {
    await tx.$executeRaw`INSERT INTO "WorkerSlot" ("slotKey", "updatedAt", "lastEnqueueSequence") VALUES ('export', clock_timestamp(), 0) ON CONFLICT ("slotKey") DO NOTHING`;
    const slots = await tx.$queryRaw<Array<{ jobId: string | null; lastEnqueueSequence: bigint }>>`SELECT "jobId", "lastEnqueueSequence" FROM "WorkerSlot" WHERE "slotKey" = 'export' FOR UPDATE`;
    assert.equal(slots.length, 1);
    assert.equal(slots[0]!.jobId, null, "test must only hold an idle export worker slot");
    const sequence = slots[0]!.lastEnqueueSequence + 1n;
    const expiresAt = new Date(Date.now() + 120_000);
    const now = new Date();
    const exportRow = await tx.export.create({
      data: {
        ownerUserId: input.ownerUserId,
        analysisId: input.analysis.analysisId,
        architectureDocumentId: input.analysis.documentId,
        format: "MARKDOWN",
        documentHash: input.analysis.documentHash,
        rendererVersion: MARKDOWN_RENDERER_VERSION,
        status: "GENERATING",
      },
      select: { id: true },
  });
  const job = await tx.job.create({
    data: {
      ownerUserId: input.ownerUserId,
      analysisId: input.analysis.analysisId,
      exportId: exportRow.id,
      type: "EXPORT",
      queueSequence: sequence,
      status: "RUNNING",
      startedAt: now,
      leaseExpiresAt: expiresAt,
      heartbeatAt: now,
      attempt: 1,
    },
    select: { id: true },
  });
  const leaseTokenHash = digest(randomUUID());
  await tx.workerSlot.upsert({
    where: { slotKey: "export" },
    create: {
      slotKey: "export",
      jobId: job.id,
      ownerUserId: input.ownerUserId,
      leaseUntil: expiresAt,
      heartbeatAt: now,
      leaseTokenHash,
      lastEnqueueSequence: sequence,
    },
    update: {
      jobId: job.id,
      ownerUserId: input.ownerUserId,
      leaseUntil: expiresAt,
      heartbeatAt: now,
      leaseTokenHash,
      lastEnqueueSequence: sequence,
    },
  });
  return { exportId: exportRow.id, jobId: job.id };
  });
}

async function expireWorkerSlotBlocker(db: ReturnType<typeof database>, blocker: Blocker): Promise<void> {
  const expiredAt = new Date(0);
  await db.job.update({ where: { id: blocker.jobId }, data: { leaseExpiresAt: expiredAt } });
  await db.workerSlot.update({ where: { slotKey: "export" }, data: { leaseUntil: expiredAt } });
}

async function waitForBlockerRecovery(
  db: ReturnType<typeof database>,
  blocker: Blocker,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const exportRow = await db.export.findUnique({ where: { id: blocker.exportId }, select: { status: true, errorCode: true } });
    const job = await db.job.findUnique({ where: { id: blocker.jobId }, select: { status: true, errorCode: true } });
    if (exportRow?.status === "FAILED" && exportRow.errorCode === "WORKER_INTERRUPTED" &&
        job?.status === "FAILED" && job.errorCode === "WORKER_INTERRUPTED") return;
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
  api: APIRequestContext,
  base: string,
  analysisId: string,
  exportId: string,
  account: DisposableAccount,
): Promise<{ response: APIResponse; value: unknown }> {
  const response: APIResponse = await api.get(exportStatusPath(base, analysisId, exportId), { headers: apiHeaders(account) });
  return { response, value: await readJson(response) };
}

async function waitForExportStatus(
  api: APIRequestContext,
  base: string,
  analysisId: string,
  exportId: string,
  account: DisposableAccount,
  wanted: ExportRecord["status"],
  timeoutMs = 60_000,
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
    if (current.export.status === "READY" && wanted !== "READY") {
      throw new Error("Export became READY before the controlled failure check could observe FAILED.");
    }
    await new Promise(resolveDelay => setTimeout(resolveDelay, 250));
  }
  throw new Error(`Timed out waiting for export ${wanted}; last observed status was ${lastStatus}.`);
}

function validateExportMetadata(data: ExportData, analysis: SeededAnalysis, account: DisposableAccount): void {
  assert.equal(data.analysisId, analysis.analysisId);
  assert.equal(data.accountKey, account.accountKey);
  assert.equal(data.export.format, "MARKDOWN");
  assert.equal(data.export.documentHash, analysis.documentHash);
  assert.equal(data.export.rendererVersion, MARKDOWN_RENDERER_VERSION);
  if (data.export.status === "READY") assert.match(data.export.contentHash ?? "", /^[a-f0-9]{64}$/);
}

async function assertApiHeaders(response: APIResponse): Promise<void> {
  const headers = response.headers();
  assert.match(headers["cache-control"] ?? "", /private,\s*no-store/i);
  assert.match(headers.vary ?? "", /Cookie/i);
  assert.match(headers.vary ?? "", /X-SAGE-Account/i);
  assert.equal(headers["x-content-type-options"], "nosniff");
}

function assertMarkdownContents(markdown: string, document: ArchitectureDocumentV1, storageRoot: string): void {
  assert.ok(markdown.startsWith("# "), "Markdown must start with its document title");
  for (const heading of ["## Interface Catalog", "## Status and limitations", "## Software Engineering Diagram", "## UML Class Diagram"]) {
    assert.ok(markdown.includes(heading), `Markdown must include ${heading}`);
  }
  assert.ok(markdown.includes("```mermaid\n"), "diagram source must be included in fenced Mermaid blocks");
  assert.ok(markdown.includes(document.softwareEngineeringDiagram.mermaid), "software structure Mermaid source must be complete");
  assert.ok(markdown.includes(document.umlClassDiagram.mermaid), "UML Mermaid source must be complete");
  for (const value of [
    document.schemaVersion,
    document.snapshot.repository,
    document.snapshot.branch ?? "null",
    document.snapshot.commitSha,
    document.ckgSha256,
    document.configurationHash,
    document.provenance.analyzer.name,
    document.provenance.analyzer.version,
    document.provenance.resolver.name,
    document.provenance.resolver.version,
    String(document.canonicalCounts.nodes),
    String(document.canonicalCounts.edges),
  ]) assert.ok(markdown.includes(value), `Markdown includes canonical context ${value}`);
  for (const file of document.files) {
    for (const value of [file.path, file.sha256, String(file.sizeBytes), file.status]) {
      assert.ok(markdown.includes(value), `Markdown includes source file metadata ${value}`);
    }
  }
  for (const entry of document.interfaceCatalog.entries) {
    assert.ok(markdown.includes(entry.declaration.id), `Markdown retains declaration ID ${entry.declaration.id}`);
    assert.ok(markdown.includes(entry.declaration.name), `Markdown retains declaration name ${entry.declaration.name}`);
  }
  const evidence = [
    ...document.interfaceCatalog.entries.flatMap(entry => entry.evidence),
    ...document.interfaceCatalog.relations.flatMap(edge => edge.evidence),
    ...document.softwareEngineeringDiagram.nodes.flatMap(node => node.location ? [node.location] : []),
    ...document.softwareEngineeringDiagram.edges.flatMap(edge => edge.evidence),
    ...document.umlClassDiagram.nodes.flatMap(node => node.location ? [node.location] : []),
    ...document.umlClassDiagram.edges.flatMap(edge => edge.evidence),
  ];
  assert.ok(evidence.length > 0, "source-backed fixture must provide evidence");
  for (const span of evidence) {
    for (const value of [span.filePath, span.fileSha256, String(span.startByte), String(span.endByte), String(span.startLine), String(span.endLine), String(span.startColumn), String(span.endColumn), span.role]) {
      assert.ok(markdown.includes(value), `Markdown preserves evidence field ${value}`);
    }
  }
  for (const limitation of document.limitations) {
    assert.ok(markdown.includes(limitation.reason), "Markdown preserves the analysis limitation text");
    assert.ok(markdown.includes(limitation.stage), "Markdown preserves the limitation stage");
  }
  assert.ok(!markdown.includes("EXPORT20_RAW_SOURCE_CANARY"), "Markdown must not include raw source contents");
  assert.ok(!markdown.includes("EXPORT20_URL_CANARY"), "Markdown must not include source URL literals");
  assert.ok(!markdown.includes(storageRoot), "Markdown must not depend on local storage paths");
  assert.doesNotMatch(markdown, /^!\[[^\]]*\]\((?:https?:)?\/\//m, "Markdown must not reference external image assets");
  assert.doesNotMatch(markdown, /<img\s/i, "Markdown must not embed HTML image assets");
}

async function openCleanMarkdownViewer(
  browser: Browser,
  markdown: string,
  artifactPath: string,
  expectedDocument: ArchitectureDocumentV1,
  viewerHtmlPath: string,
  audit: BrowserAudit,
): Promise<void> {
  assert.ok(markdownParser, "Markdown renderer should be available from the locked Mermaid dependency");
  const rendered: string | Promise<string> = markdownParser.parse(markdown, { gfm: true, breaks: false });
  const html = await rendered;
  const context: BrowserContext = await browser.newContext({ viewport: { width: 1180, height: 900 }, acceptDownloads: true, serviceWorkers: "block" });
  const page: Page = await context.newPage();
  page.on("pageerror", error => audit.errors.push(`clean viewer: ${error.message}`));
  page.on("request", req => auditRequest(req.url(), audit));
  const viewerDocument = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'none'; media-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; script-src 'none'; style-src 'unsafe-inline'"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Clean Markdown viewer</title><style>body{font-family:system-ui,sans-serif;max-width:920px;margin:32px auto;padding:0 24px;line-height:1.55;color:#182026}pre{overflow:auto;padding:16px;background:#f0f3f5;border-radius:8px}code{overflow-wrap:anywhere}h1,h2,h3{line-height:1.2}</style></head><body><main>${html}</main></body></html>`;
  await page.setContent(viewerDocument, { waitUntil: "domcontentloaded" });
  await writeFile(viewerHtmlPath, viewerDocument, { mode: 0o600 });
  const headings = await page.locator("main h2").allTextContents();
  for (const heading of ["Interface Catalog", "Status and limitations", "Software Engineering Diagram", "UML Class Diagram"]) {
    assert.ok(headings.includes(heading), `clean Markdown viewer renders ${heading}`);
  }
  const mermaidBlocks = await page.locator("main pre code.language-mermaid").allTextContents();
  assert.equal(mermaidBlocks.length, 2, "clean viewer renders both Mermaid source blocks without a Mermaid plugin");
  assert.ok(mermaidBlocks.includes(`${expectedDocument.softwareEngineeringDiagram.mermaid}\n`));
  assert.ok(mermaidBlocks.includes(`${expectedDocument.umlClassDiagram.mermaid}\n`));
  assert.equal(await page.locator("main img, main iframe, main object, main embed, main script").count(), 0,
    "downloaded document renders no active or external HTML resource elements");
  assert.equal(await page.locator("main a[href]").count(), 0, "test fixture export contains no active links or off-site references");
  const visibleText = await page.locator("main").innerText();
  assert.ok(visibleText.includes(expectedDocument.snapshot.repository));
  assert.ok(visibleText.includes(expectedDocument.interfaceCatalog.entries[0]?.declaration.name ?? ""));
  assert.ok(visibleText.includes(expectedDocument.limitations[0]?.reason ?? ""));
  await page.screenshot({ path: artifactPath, fullPage: false });
  await context.close();
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
  const context: BrowserContext = await browser.newContext({
    viewport: { width, height: 1000 },
    reducedMotion: "reduce",
    acceptDownloads: true,
    serviceWorkers: "block",
  });
  await context.addCookies([{ name: "sage_session", value: account.token, url: base, httpOnly: true, sameSite: "Lax" }]);
  return context;
}

async function openDocumentPage(context: BrowserContext, base: string, analysisId: string, audit: BrowserAudit, origin: string, label: string): Promise<Page> {
  const page: Page = await context.newPage();
  page.setDefaultTimeout(25_000);
  attachBrowserAudit(page, audit, origin, label);
  await page.goto(documentPagePath(base, analysisId), { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "Architecture Definition Document", exact: true }).waitFor();
  await page.getByRole("button", { name: "Ekspor Markdown", exact: true }).waitFor();
  return page;
}

async function waitForApiResponse(page: Page, pathname: string, method: string): Promise<BrowserResponse> {
  const response = await page.waitForResponse(candidate => {
    const url = new URL(candidate.url());
    return url.pathname === pathname && candidate.request().method() === method;
  });
  return response;
}

async function saveBrowserDownload(download: Download, artifactPath: string): Promise<{ filename: string; bytes: Buffer }> {
  const filename = download.suggestedFilename();
  assert.match(filename, /^sage-[a-z0-9_-]+-[a-f0-9]{7}\.md$/i, "download filename must be a sanitized private attachment");
  await download.saveAs(artifactPath);
  return { filename, bytes: await readFile(artifactPath) };
}

async function verifyDownloadResponse(
  api: APIRequestContext,
  base: string,
  analysis: SeededAnalysis,
  exportId: string,
  account: DisposableAccount,
): Promise<{ bytes: Buffer; markdown: string; filename: string; hash: string }> {
  const response: APIResponse = await api.get(exportDownloadPath(base, analysis.analysisId, exportId), {
    headers: apiHeaders(account),
  });
  assert.equal(response.status(), 200);
  await assertApiHeaders(response);
  const headers = response.headers();
  assert.match(headers["content-type"] ?? "", /^text\/markdown(?:\s*;|$)/i);
  assert.match(headers["content-disposition"] ?? "", /^attachment\s*;/i);
  const filenameMatch = /filename="?([^";]+)"?/i.exec(headers["content-disposition"] ?? "");
  assert.ok(filenameMatch?.[1], "attachment must supply a filename");
  assert.match(filenameMatch[1]!, /^sage-[a-z0-9_-]+-[a-f0-9]{7}\.md$/i);
  const bytes = await response.body();
  const hash = digest(bytes);
  const status = await waitForExportStatus(api, base, analysis.analysisId, exportId, account, "READY");
  assert.equal(hash, status.export.contentHash, "download SHA-256 must equal READY contentHash");
  const markdown = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  assertMarkdownContents(markdown, analysis.document, process.env.STORAGE_ROOT ?? "");
  return { bytes, markdown, filename: filenameMatch[1]!, hash };
}

async function captureAnalysisIntegrity(db: ReturnType<typeof database>, analysis: SeededAnalysis, ownerUserId: string): Promise<string> {
  const row = await db.analysis.findUniqueOrThrow({
    where: { id_ownerUserId: { id: analysis.analysisId, ownerUserId } },
    select: { status: true, resultHash: true, configurationHash: true, graphBundle: { select: { contentHash: true } }, architectureDocument: { select: { contentHash: true } } },
  });
  return JSON.stringify({
    status: row.status,
    resultHash: row.resultHash,
    configurationHash: row.configurationHash,
    graphHash: row.graphBundle?.contentHash ?? null,
    documentHash: row.architectureDocument?.contentHash ?? null,
  });
}

async function removeOwnedStorageFiles(db: ReturnType<typeof database>, storageRoot: string, analysisIds: string[]): Promise<void> {
  if (!analysisIds.length) return;
  const rows = await db.storageObject.findMany({ where: { analysisId: { in: analysisIds }, type: "EXPORT" }, select: { storageKey: true } });
  for (const row of rows) {
    if (!/^export-[A-Za-z0-9-]{36}\/document\.md$/.test(row.storageKey)) continue;
    const file = resolve(storageRoot, ...row.storageKey.split("/"));
    if (!file.startsWith(`${resolve(storageRoot)}${sep}`)) continue;
    await rm(file, { force: true });
    const directory = dirname(file);
    if (directory.startsWith(`${resolve(storageRoot)}${sep}`)) await rm(directory, { recursive: true, force: true });
  }
}

async function runLiveMarkdownExportRegression(): Promise<void> {
  requireDedicatedDatabase();
  const rawBase = process.env.SAGE_EXPORT_BASE_URL ?? "http://127.0.0.1:3000";
  const base = rawBase.replace(/\/$/, "");
  const parsedBase = new URL(base);
  if (parsedBase.protocol !== "http:" && parsedBase.protocol !== "https:") throw new Error("SAGE_EXPORT_BASE_URL must be HTTP(S).");
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
  let success: SeededAnalysis | undefined;
  let recovery: SeededAnalysis | undefined;
  let firstBlocker: Blocker | undefined;
  let secondBlocker: Blocker | undefined;
  let failureInjection: string | undefined;
  let exportedHash: string | undefined;
  let reportStatus: "PASS" | "FAIL" = "PASS";
  let reportError: string | undefined;
  let savedFilename: string | undefined;
  let savedBytes: Buffer | undefined;
  let expectedMarkdown: string | undefined;

  try {
    await prepareArtifactDirectory(resultDir);
    artifactDirReady = true;
    api = await request.newContext({ baseURL: base, timeout: 20_000 });
    const health: APIResponse = await api.get("/api/health");
    assert.equal(health.status(), 200, "real Next server must be reachable and connected to PostgreSQL");
    const healthBody: unknown = await readJson(health);
    assert.deepEqual(healthBody, { status: "ok", service: "web", database: "ok" });
    checks.push("real Next API and PostgreSQL health");

    const preexisting = await db.export.count();
    assert.equal(preexisting, 0, "sage_export20 must not contain prior user exports before the isolated live run");
    owner = await makeAccount(db, "owner", users, sessionIds);
    other = await makeAccount(db, "other", users, sessionIds);
    repositoryId = await createAnalysisRepository(db, owner.login);
    const fixture = await loadFixture();
    success = await seedAnalysis(db, {
      ownerUserId: owner.userId, repositoryId, fixture, storageRoot, label: "ready-and-stability", storageObjectIds, createdFolders,
    });
    recovery = await seedAnalysis(db, {
      ownerUserId: owner.userId, repositoryId, fixture, storageRoot, label: "actual-failure-and-retry", storageObjectIds, createdFolders,
    });
    const leaseControl = await seedAnalysis(db, {
      ownerUserId: owner.userId, repositoryId, fixture, storageRoot, label: "worker-slot-fault-control-1", storageObjectIds, createdFolders,
    });
    const secondLeaseControl = await seedAnalysis(db, {
      ownerUserId: owner.userId, repositoryId, fixture, storageRoot, label: "worker-slot-fault-control-2", storageObjectIds, createdFolders,
    });
    analysisIds.push(success.analysisId, recovery.analysisId, leaseControl.analysisId, secondLeaseControl.analysisId);
    assert.equal(success.documentHash, recovery.documentHash, "same immutable fixture snapshot must replay to one identical document hash");
    expectedMarkdown = renderMarkdownDocument(success.document);
    assert.equal(renderMarkdownDocument(recovery.document), expectedMarkdown, "same snapshot document produces identical canonical Markdown before worker execution");

    const integrityBefore = new Map<string, string>();
    for (const analysis of [success, recovery, leaseControl, secondLeaseControl]) {
      integrityBefore.set(analysis.analysisId, await captureAnalysisIntegrity(db, analysis, owner.userId));
    }
    checks.push("real analyzer fixture seeded as four identical canonical GraphBundle, ArchitectureDocument, limitation, and private source archive snapshots");

    // The blocker is only a deterministic test gate: production claim recovery
    // must expire this lease, while all actual document export creation/retry
    // and successful file generation still use the HTTP handlers and consumer.
    firstBlocker = await seedWorkerSlotBlocker(db, { ownerUserId: owner.userId, analysis: leaseControl });
    checks.push("test-only live export lease holds the production queue slot to make duplicate-POST and failure timings deterministic");

    const invalidOrigin: APIResponse = await api.post(exportCollectionPath(base, success.analysisId), {
      headers: { ...postHeaders(owner, parsedBase.origin), Origin: "https://invalid-origin.example" },
      data: { format: "MARKDOWN" },
    });
    assert.ok(invalidOrigin.status() >= 400 && invalidOrigin.status() < 500, "foreign Origin must be rejected");
    const invalidBody: APIResponse = await api.post(exportCollectionPath(base, success.analysisId), {
      headers: postHeaders(owner, parsedBase.origin), data: { format: "MARKDOWN", unexpected: true },
    });
    assert.ok(invalidBody.status() >= 400 && invalidBody.status() < 500, "unknown JSON fields must be rejected");
    const invalidFormat: APIResponse = await api.post(exportCollectionPath(base, success.analysisId), {
      headers: postHeaders(owner, parsedBase.origin), data: { format: "HTML" },
    });
    assert.ok(invalidFormat.status() >= 400 && invalidFormat.status() < 500, "unknown export format must be rejected by this endpoint");
    const noAuth: APIResponse = await api.post(exportCollectionPath(base, success.analysisId), {
      headers: { Origin: parsedBase.origin, "Content-Type": "application/json" }, data: { format: "MARKDOWN" },
    });
    assert.equal(noAuth.status(), 401);
    assert.equal(await db.export.count({ where: { analysisId: success.analysisId } }), 0,
      "invalid-origin/body/auth attempts must not create export records");
    checks.push("strict same-origin POST, exact request body, MARKDOWN format, and authenticated owner checks");

    const foreignCreate: APIResponse = await api.post(exportCollectionPath(base, success.analysisId), {
      headers: postHeaders(other, parsedBase.origin), data: { format: "MARKDOWN" },
    });
    assert.equal(foreignCreate.status(), 404, "foreign owner must not enqueue an export for another account");
    assert.equal(await db.export.count({ where: { analysisId: success.analysisId } }), 0);
    checks.push("foreign owner create returns 404 without revealing or creating an export");

    const context390 = await createBrowserContext(browser = await chromium.launch({ headless: true, args: ["--disable-background-networking", "--disable-default-apps"] }), base, owner, 390);
    const page390 = await openDocumentPage(context390, base, success.analysisId, browserAudit, parsedBase.origin, "390px ready export");
    const createPath = new URL(exportCollectionPath(base, success.analysisId)).pathname;
    const createResponsePromise: Promise<BrowserResponse> = waitForApiResponse(page390, createPath, "POST");
    await page390.getByRole("button", { name: "Ekspor Markdown", exact: true }).click();
    const createResponse: BrowserResponse = await createResponsePromise;
    assert.ok(createResponse.status() >= 200 && createResponse.status() < 300, "real browser create click must enqueue Markdown over HTTP");
    const createdBody: unknown = await readJson(createResponse);
    const createdData = parseExportData(createdBody);
    validateExportMetadata(createdData, success, owner);
    assert.equal(createdData.export.status, "QUEUED", "live worker slot blocker must keep this request queued for dedup checks");
    const successExportId = createdData.export.id;
    await page390.getByRole("status").filter({ hasText: "Ekspor Markdown masuk antrean." }).waitFor();
    checks.push("390px live document page: real Ekspor Markdown click creates a QUEUED export through same-origin HTTP");

    const [duplicateA, duplicateB]: [APIResponse, APIResponse] = await Promise.all([
      api.post(exportCollectionPath(base, success.analysisId), { headers: postHeaders(owner, parsedBase.origin), data: { format: "MARKDOWN" } }),
      api.post(exportCollectionPath(base, success.analysisId), { headers: postHeaders(owner, parsedBase.origin), data: { format: "MARKDOWN" } }),
    ]);
    assert.ok(duplicateA.status() >= 200 && duplicateA.status() < 300);
    assert.ok(duplicateB.status() >= 200 && duplicateB.status() < 300);
    const duplicateAData = parseExportData(await readJson(duplicateA));
    const duplicateBData = parseExportData(await readJson(duplicateB));
    assert.equal(duplicateAData.export.id, successExportId);
    assert.equal(duplicateBData.export.id, successExportId);
    assert.equal(await db.export.count({ where: { analysisId: success.analysisId, ownerUserId: owner.userId, format: "MARKDOWN" } }), 1,
      "simultaneous duplicate requests must persist only one export row");
    assert.equal(await db.job.count({ where: { analysisId: success.analysisId, ownerUserId: owner.userId, type: "EXPORT" } }), 1,
      "simultaneous duplicate requests must enqueue only one export job");
    checks.push("two concurrent API POSTs and the browser POST deduplicate to one owner/analysis/document/renderer export and job");

    const mismatchedAccount: APIResponse = await api.get(exportStatusPath(base, success.analysisId, successExportId), {
      headers: { Cookie: `sage_session=${owner.token}`, "X-SAGE-Account": other.accountKey },
    });
    assert.equal(mismatchedAccount.status(), 401);
    const foreignStatus: APIResponse = await api.get(exportStatusPath(base, success.analysisId, successExportId), { headers: apiHeaders(other) });
    assert.equal(foreignStatus.status(), 404);
    const foreignDownload: APIResponse = await api.get(exportDownloadPath(base, success.analysisId, successExportId), { headers: apiHeaders(other) });
    assert.equal(foreignDownload.status(), 404);
    const unknownStatus: APIResponse = await api.get(exportStatusPath(base, success.analysisId, "missing-export20"), { headers: apiHeaders(owner) });
    assert.equal(unknownStatus.status(), 404);
    const notReadyDownload: APIResponse = await api.get(exportDownloadPath(base, success.analysisId, successExportId), { headers: apiHeaders(owner) });
    assert.equal(notReadyDownload.status(), 409);
    assert.equal(await readErrorCode(notReadyDownload), "EXPORT_NOT_READY");
    checks.push("status/download owner isolation and EXPORT_NOT_READY behavior before the worker publishes a file");

    await expireWorkerSlotBlocker(db, firstBlocker);
    await waitForBlockerRecovery(db, firstBlocker);
    const ready = await waitForExportStatus(api, base, success.analysisId, successExportId, owner, "READY");
    validateExportMetadata(ready, success, owner);
    await assertApiHeaders((await fetchExportStatus(api, base, success.analysisId, successExportId, owner)).response);
    await page390.getByRole("button", { name: "Unduh Markdown", exact: true }).waitFor();
    await page390.getByRole("status").filter({ hasText: "Markdown siap diunduh." }).waitFor();
    await page390.screenshot({ path: join(resultDir, "export-20-390-ready.png"), fullPage: true });
    screenshots.push("export-20-390-ready.png");

    const browserDownloadEvent = page390.waitForEvent("download");
    await page390.getByRole("button", { name: "Unduh Markdown", exact: true }).click();
    const browserDownload = await browserDownloadEvent;
    const downloaded = await saveBrowserDownload(browserDownload, join(resultDir, "sage-export20-browser-390.md"));
    savedFilename = downloaded.filename;
    savedBytes = downloaded.bytes;
    exportedHash = digest(downloaded.bytes);
    assert.equal(exportedHash, ready.export.contentHash);
    assert.equal(new TextDecoder("utf-8", { fatal: true }).decode(downloaded.bytes), expectedMarkdown,
      "real downloaded bytes must equal the canonical deterministic renderer output");
    await writeFile(join(resultDir, "export-20-390-download.md"), downloaded.bytes, { mode: 0o600 });
    checks.push("390px browser download: real attachment bytes verify against the stored SHA-256 and canonical Markdown renderer output");

    const directDownload = await verifyDownloadResponse(api, base, success, successExportId, owner);
    assert.equal(directDownload.hash, exportedHash);
    assert.deepEqual(directDownload.bytes, downloaded.bytes, "API and browser attachment must contain identical bytes");
    checks.push("API GET download: content type, private attachment filename, no-store headers, and exact SHA-256 verified");

    await openCleanMarkdownViewer(
      browser,
      directDownload.markdown,
      join(resultDir, "export-20-clean-markdown-viewer.png"),
      success.document,
      join(resultDir, "export-20-clean-markdown-viewer.html"),
      browserAudit,
    );
    screenshots.push("export-20-clean-markdown-viewer.png");
    checks.push("clean offline Chromium Markdown viewer using the locked Mermaid dependency's Marked parser: three document sections, two full Mermaid source blocks, no active/external HTML resources");

    const context1440 = await createBrowserContext(browser, base, owner, 1440);
    const page1440 = await openDocumentPage(context1440, base, success.analysisId, browserAudit, parsedBase.origin, "1440px ready export");
    const create1440ResponsePromise: Promise<BrowserResponse> = waitForApiResponse(page1440, createPath, "POST");
    await page1440.getByRole("button", { name: "Ekspor Markdown", exact: true }).click();
    const create1440Response: BrowserResponse = await create1440ResponsePromise;
    assert.ok(create1440Response.status() >= 200 && create1440Response.status() < 300);
    const create1440Data = parseExportData(await readJson(create1440Response));
    assert.equal(create1440Data.export.id, successExportId, "1440px create click must reuse the same deduplicated export");
    await page1440.getByRole("button", { name: "Unduh Markdown", exact: true }).waitFor();
    await page1440.screenshot({ path: join(resultDir, "export-20-1440-ready.png"), fullPage: true });
    screenshots.push("export-20-1440-ready.png");
    const download1440Promise = page1440.waitForEvent("download");
    await page1440.getByRole("button", { name: "Unduh Markdown", exact: true }).click();
    const download1440 = await download1440Promise;
    const downloaded1440 = await saveBrowserDownload(download1440, join(resultDir, "sage-export20-browser-1440.md"));
    assert.equal(digest(downloaded1440.bytes), exportedHash, "390px and 1440px downloads are byte-identical");
    checks.push("1440px browser page: real create click and actual private Markdown download match the 390px byte hash");
    await context1440.close();

    // Hold a real READY create/status response from owner A while the session
    // cookie changes to B. The export component must be unmounted and discard
    // the delayed A response before it can expose an old download control.
    const delayedPostContext = await createBrowserContext(browser, base, owner, 390);
    const delayedPostPage = await openDocumentPage(delayedPostContext, base, success.analysisId, browserAudit, parsedBase.origin, "delayed export status account switch");
    let releaseDelayedPost: () => void = () => {};
    let signalDelayedPost: () => void = () => {};
    const delayedPostGate = new Promise<void>(resolveGate => { releaseDelayedPost = resolveGate; });
    const delayedPostReady = new Promise<void>(resolveGate => { signalDelayedPost = resolveGate; });
    let delayedPostStatus = 0;
    await delayedPostPage.route(exportCollectionPath(base, success.analysisId), async route => {
      const actual: APIResponse = await route.fetch();
      delayedPostStatus = actual.status();
      signalDelayedPost();
      await delayedPostGate;
      try { await route.fulfill({ response: actual }); } catch { /* identity refresh can abort the held request */ }
    });
    await delayedPostPage.getByRole("button", { name: "Ekspor Markdown", exact: true }).click();
    await delayedPostReady;
    assert.equal(delayedPostStatus, 200, "the delayed export response must be a real owner-A READY response");
    await delayedPostContext.addCookies([{ name: "sage_session", value: other.token, url: base, httpOnly: true, sameSite: "Lax" }]);
    const ownerSession401Promise = delayedPostPage.waitForResponse(response => {
      const url = new URL(response.url());
      return url.pathname === "/api/auth/session" && response.request().headers()["x-sage-account"] === owner!.accountKey && response.status() === 401;
    });
    await delayedPostPage.evaluate(() => window.dispatchEvent(new Event("focus")));
    await ownerSession401Promise;
    releaseDelayedPost();
    await delayedPostPage.getByRole("alert").filter({ hasText: "Analisis tidak ditemukan." }).waitFor();
    assert.equal(await delayedPostPage.getByRole("button", { name: "Unduh Markdown", exact: true }).count(), 0);
    assert.equal(await delayedPostPage.getByRole("button", { name: "Coba ekspor Markdown lagi", exact: true }).count(), 0);
    const delayedPostText = await delayedPostPage.locator("body").innerText();
    assert.ok(!delayedPostText.includes("MarkdownExportService"));
    assert.ok(!delayedPostText.includes(success.documentHash));
    await delayedPostContext.close();
    checks.push("delayed READY response: account switch to B rejects A identity, clears the document, and never publishes A's stale download control");

    // The product download is fetched as a Blob and verifies account identity
    // again after its body arrives. Hold the real 200 bytes at the browser
    // boundary, switch accounts, then release it; no attachment may download.
    const delayedDownloadContext = await createBrowserContext(browser, base, owner, 390);
    const delayedDownloadPage = await openDocumentPage(delayedDownloadContext, base, success.analysisId, browserAudit, parsedBase.origin, "delayed download account switch");
    const delayedCreatePromise: Promise<BrowserResponse> = waitForApiResponse(delayedDownloadPage, createPath, "POST");
    await delayedDownloadPage.getByRole("button", { name: "Ekspor Markdown", exact: true }).click();
    const delayedCreateResponse: BrowserResponse = await delayedCreatePromise;
    assert.ok(delayedCreateResponse.status() >= 200 && delayedCreateResponse.status() < 300);
    await delayedDownloadPage.getByRole("button", { name: "Unduh Markdown", exact: true }).waitFor();
    let releaseDelayedDownload: () => void = () => {};
    let signalDelayedDownload: () => void = () => {};
    const delayedDownloadGate = new Promise<void>(resolveGate => { releaseDelayedDownload = resolveGate; });
    const delayedDownloadReady = new Promise<void>(resolveGate => { signalDelayedDownload = resolveGate; });
    let heldDownloadStatus = 0;
    await delayedDownloadPage.route(exportDownloadPath(base, success.analysisId, successExportId), async route => {
      const actual: APIResponse = await route.fetch();
      heldDownloadStatus = actual.status();
      signalDelayedDownload();
      await delayedDownloadGate;
      try { await route.fulfill({ response: actual }); } catch { /* the account refresh may abort before the body is released */ }
    });
    let leakedDownloadCount = 0;
    delayedDownloadPage.on("download", () => { leakedDownloadCount += 1; });
    await delayedDownloadPage.getByRole("button", { name: "Unduh Markdown", exact: true }).click();
    await delayedDownloadReady;
    assert.equal(heldDownloadStatus, 200, "the delayed download response must be the real owner-A attachment");
    await delayedDownloadContext.addCookies([{ name: "sage_session", value: other.token, url: base, httpOnly: true, sameSite: "Lax" }]);
    const downloadIdentity401 = delayedDownloadPage.waitForResponse(response => {
      const url = new URL(response.url());
      return url.pathname === "/api/auth/session" && response.request().headers()["x-sage-account"] === owner!.accountKey && response.status() === 401;
    });
    await delayedDownloadPage.evaluate(() => window.dispatchEvent(new Event("focus")));
    await downloadIdentity401;
    releaseDelayedDownload();
    await delayedDownloadPage.getByRole("alert").filter({ hasText: "Analisis tidak ditemukan." }).waitFor();
    await delayedDownloadPage.waitForTimeout(250);
    assert.equal(leakedDownloadCount, 0, "late owner-A attachment must not become a browser download for account B");
    const delayedDownloadText = await delayedDownloadPage.locator("body").innerText();
    assert.ok(!delayedDownloadText.includes("MarkdownExportService"));
    assert.ok(!delayedDownloadText.includes(success.documentHash));
    await delayedDownloadContext.close();
    checks.push("delayed real attachment response: account switch during Blob transfer is rejected after session recheck and produces no old-account download");

    // Put a controlled, valid lease in front of the real queue so the archive
    // metadata can be altered only after the target export has been enqueued.
    secondBlocker = await seedWorkerSlotBlocker(db, { ownerUserId: owner.userId, analysis: secondLeaseControl });
    const recoveryContext = await createBrowserContext(browser, base, owner, 390);
    const recoveryPage = await openDocumentPage(recoveryContext, base, recovery.analysisId, browserAudit, parsedBase.origin, "worker failure and retry");
    const recoveryCreatePath = new URL(exportCollectionPath(base, recovery.analysisId)).pathname;
    const recoveryCreatePromise: Promise<BrowserResponse> = waitForApiResponse(recoveryPage, recoveryCreatePath, "POST");
    await recoveryPage.getByRole("button", { name: "Ekspor Markdown", exact: true }).click();
    const recoveryCreateResponse: BrowserResponse = await recoveryCreatePromise;
    assert.ok(recoveryCreateResponse.status() >= 200 && recoveryCreateResponse.status() < 300);
    const recoveryData = parseExportData(await readJson(recoveryCreateResponse));
    validateExportMetadata(recoveryData, recovery, owner);
    assert.equal(recoveryData.export.status, "QUEUED");
    const recoveryExportId = recoveryData.export.id;
    await recoveryPage.getByRole("status").filter({ hasText: "Ekspor Markdown masuk antrean." }).waitFor();

    const corruptedHash = recovery.archive.sha256 === "0".repeat(64) ? "1".repeat(64) : "0".repeat(64);
    failureInjection = "After the real create POST queued the export behind an active test-only lease, changed the source archive StorageObject.sha256 to a wrong digest. The production consumer recovered the expired blocker, read the real archive, and failed the export with EXPORT_FAILED. The stored digest was restored before the real retry POST.";
    try {
      await db.storageObject.update({ where: { id: recovery.archive.id }, data: { sha256: corruptedHash } });
      await expireWorkerSlotBlocker(db, secondBlocker);
      await waitForBlockerRecovery(db, secondBlocker);
      const failed = await waitForExportStatus(api, base, recovery.analysisId, recoveryExportId, owner, "FAILED");
      assert.equal(failed.export.errorCode, "EXPORT_FAILED", "real worker must report safe source-integrity failure");
      await recoveryPage.getByRole("alert").filter({ hasText: "Ekspor Markdown belum berhasil. Anda dapat mencoba lagi." }).waitFor();
      await recoveryPage.getByRole("button", { name: "Coba ekspor Markdown lagi", exact: true }).waitFor();
      await recoveryPage.screenshot({ path: join(resultDir, "export-20-390-failed.png"), fullPage: true });
      screenshots.push("export-20-390-failed.png");
    } finally {
      await db.storageObject.update({ where: { id: recovery.archive.id }, data: { sha256: recovery.archive.sha256 } });
    }
    checks.push("controlled storage-integrity fault reached the real worker and failed safely as EXPORT_FAILED; test-only archive digest restored before retry");

    const retryPath = new URL(exportRetryPath(base, recovery.analysisId, recoveryExportId)).pathname;
    const retryResponsePromise: Promise<BrowserResponse> = waitForApiResponse(recoveryPage, retryPath, "POST");
    await recoveryPage.getByRole("button", { name: "Coba ekspor Markdown lagi", exact: true }).click();
    const retryResponse: BrowserResponse = await retryResponsePromise;
    assert.ok(retryResponse.status() >= 200 && retryResponse.status() < 300, "real UI retry button must call retry endpoint");
    const retryData = parseExportData(await readJson(retryResponse));
    validateExportMetadata(retryData, recovery, owner);
    assert.equal(retryData.export.id, recoveryExportId, "retry must retain the existing export identity");
    assert.ok(["QUEUED", "GENERATING", "READY"].includes(retryData.export.status));
    const recovered = await waitForExportStatus(api, base, recovery.analysisId, recoveryExportId, owner, "READY");
    validateExportMetadata(recovered, recovery, owner);
    assert.equal(recovered.export.documentHash, ready.export.documentHash, "retry remains bound to the same canonical document hash");
    assert.equal(recovered.export.contentHash, exportedHash, "same canonical snapshot retry must reproduce the initial exact content hash");
    await recoveryPage.getByRole("button", { name: "Unduh Markdown", exact: true }).waitFor();
    await recoveryPage.screenshot({ path: join(resultDir, "export-20-390-retried-ready.png"), fullPage: true });
    screenshots.push("export-20-390-retried-ready.png");
    const retryDownloadPromise = recoveryPage.waitForEvent("download");
    await recoveryPage.getByRole("button", { name: "Unduh Markdown", exact: true }).click();
    const retryDownload = await retryDownloadPromise;
    const retryFile = await saveBrowserDownload(retryDownload, join(resultDir, "sage-export20-browser-retry.md"));
    assert.deepEqual(retryFile.bytes, savedBytes, "the real retry must reproduce byte-identical standalone Markdown");
    checks.push("real UI retry requeues the same export/document hash, worker returns READY, and the retried browser download is byte-for-byte identical");
    await recoveryContext.close();

    const blockerFailure = await db.export.findUnique({ where: { id: firstBlocker.exportId }, select: { status: true, errorCode: true } });
    const targetFailure = await db.export.findUnique({ where: { id: recoveryExportId }, select: { status: true, errorCode: true } });
    assert.deepEqual(blockerFailure, { status: "FAILED", errorCode: "WORKER_INTERRUPTED" });
    assert.deepEqual(targetFailure, { status: "READY", errorCode: null });
    checks.push("production lease recovery records WORKER_INTERRUPTED, real archive-integrity failure is retryable, and retry succeeds without changing the document hash");

    for (const analysis of [success, recovery, leaseControl, secondLeaseControl]) {
      assert.equal(await captureAnalysisIntegrity(db, analysis, owner.userId), integrityBefore.get(analysis.analysisId),
        "Markdown export failure/retry must not mutate analysis status, result hash, graph hash, or architecture document hash");
    }
    checks.push("analysis status/result hash, canonical graph hash, and architecture document hash are unchanged after failure and retry");

    const bStatus = await api.get(exportStatusPath(base, success.analysisId, successExportId), { headers: apiHeaders(other) });
    assert.equal(bStatus.status(), 404);
    const bRetry = await api.post(exportRetryPath(base, success.analysisId, successExportId), {
      headers: postHeaders(other, parsedBase.origin), data: {},
    });
    assert.equal(bRetry.status(), 404);
    checks.push("foreign account cannot inspect or retry another account's ready export");

    assert.equal(browserAudit.offOrigin, 0, "all tested browser flows must remain same-origin");
    assert.equal(browserAudit.provider, 0, "no tested browser path may contact GitHub or a provider API");
    assert.deepEqual(browserAudit.errors, [], "browser pages and clean viewer must finish without uncaught errors");
    checks.push("all UI/download/race flows remain same-origin, make no GitHub/provider request, and produce no uncaught browser errors");
  } catch (error) {
    reportStatus = "FAIL";
    reportError = error instanceof Error ? error.message : "Live Markdown export regression failed.";
    failures.push(reportError);
  } finally {
    await browser?.close().catch(() => undefined);
    await api?.dispose().catch(() => undefined);
    try {
      if (recovery && storageObjectIds.includes(recovery.archive.id)) {
        await db.storageObject.updateMany({ where: { id: recovery.archive.id }, data: { sha256: recovery.archive.sha256 } });
      }
      if (analysisIds.length) await removeOwnedStorageFiles(db, storageRoot, analysisIds);
      const exports = analysisIds.length
        ? await db.export.findMany({ where: { analysisId: { in: analysisIds }, ownerUserId: { in: users } }, select: { id: true } })
        : [];
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
      screenshots,
      downloadedFilename: savedFilename,
      downloadedBytes: savedBytes?.byteLength ?? null,
      downloadedSha256: exportedHash,
      rendererVersion: MARKDOWN_RENDERER_VERSION,
      canonicalDocumentHash: success?.documentHash ?? null,
      canonicalCkgHash: success?.ckgHash ?? null,
      markdownMatchesRenderer: savedBytes && expectedMarkdown ? savedBytes.equals(Buffer.from(expectedMarkdown, "utf8")) : null,
      failureInjection,
      browser: { offOriginRequests: browserAudit.offOrigin, providerRequests: browserAudit.provider, pageErrors: browserAudit.errors },
      viewports: [390, 1440],
      viewer: "Marked 16 via locked Mermaid dependency in a fresh CSP-restricted, offline Chromium page; Mermaid fences remain readable source code, no Mermaid plugin is loaded.",
      safeFixtureBoundaries: {
        accountTokensAndSyntheticProviderTokens: "never included in screenshots/report/Markdown",
        rawSourceCanary: "EXPORT20_RAW_SOURCE_CANARY; must not be included in exported Markdown",
        sourceUrlCanary: "EXPORT20_URL_CANARY; must not be included or fetched",
        storageRoot: "must be a private empty temporary directory; only per-fixture archive/export paths are cleaned",
      },
    };
    if (artifactDirReady) {
      await writeFile(join(resultDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 }).catch(writeError => {
        reportStatus = "FAIL";
        const message = writeError instanceof Error ? writeError.message : "Could not write the report.";
        console.error(`SAGE_EXPORT_REPORT_WRITE_FAILED ${message}`);
      });
    }
    console.log(JSON.stringify(report, null, 2));
  }
  if (reportStatus !== "PASS") process.exitCode = 1;
}

async function main(): Promise<void> {
  await runLiveMarkdownExportRegression();
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : "Live Markdown export regression failed.");
  process.exitCode = 1;
});
