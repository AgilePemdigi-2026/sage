import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeReferences } from "@sage/analyzer-js";
import { canonicalizeCkg, type CcmSnapshot, type CcmV1 } from "@sage/contracts";
import { createSession, database, storeGitHubCredential } from "@sage/database";
import { projectArchitectureDocument, type ArchitectureDocumentV1 } from "@sage/documents/model";
import { chromium, request, type APIRequestContext, type BrowserContext, type Page } from "playwright";
import { pack, type Header } from "tar-stream";
import { gzipSync } from "node:zlib";

/**
 * Destructive opt-in integration regression for the live DOC-01 document path.
 *
 * Run only with the dedicated `sage_document15` database, the same test-only
 * CREDENTIAL_ENCRYPTION_KEY used by Next, and a private empty STORAGE_ROOT
 * shared with the externally started Next server:
 *   SAGE_DOCUMENT_TESTS=1 DATABASE_URL=postgresql://sage@sage-document15-db:5432/sage_document15 \
 *   CREDENTIAL_ENCRYPTION_KEY=<test-only-32-byte-base64> STORAGE_ROOT=/tmp/sage-document15-storage \
 *   SAGE_DOCUMENT_BASE_URL=http://127.0.0.1:3000 npx tsx scripts/test-live-document.ts
 *
 * It directly seeds terminal analysis/CKG/document/archive records so this
 * proves the real HTTP reader and browser page, not worker publication or the
 * actual nine-stage pipeline. Source bytes are read only to replay canonical
 * artifacts and are never returned by the API.
 */

const enabled = process.env.SAGE_DOCUMENT_TESTS === "1";

type DisposableAccount = {
  userId: string;
  login: string;
  accountKey: string;
  token: string;
  sessionId: string;
  syntheticProviderToken: string;
};

type SeededArchive = {
  id: string;
  bytes: Buffer;
  archivePath: string;
  storageKey: string;
};

type ApiErrorBody = { error?: { code?: string; message?: string }; requestId?: string };
type SeededDocument = {
  analysisId: string;
  ckgJson: string;
  ckgSha256: string;
  documentJson: string;
  documentSha256: string;
  document: ArchitectureDocumentV1;
  snapshot: CcmSnapshot;
  counts: { nodes: number; edges: number };
  sourceBytes: Record<string, Uint8Array>;
  archive: SeededArchive;
};

const viewports = [360, 390, 768, 1024, 1440] as const;
const nodeKinds = ["Module", "Class", "Interface", "Function", "Method", "Property", "UnresolvedReference"] as const;
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureDir = new URL("../tests/fixtures/resolver/typescript/", import.meta.url);
const resultDir = resolve(projectRoot, "artifacts/document-15");
const fixtureRepository = "AgilePemdigi-2026/sage";
const fixtureBranch = "codex/12-js-ts-resolver";
const fixtureCommit = "e".repeat(40);
const specialSourcePath = "src/<script>/café-service.ts";
const htmlCanary = "DOC15_HTML_CANARY";

function digest(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function requireDedicatedDatabase(): void {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error("DATABASE_URL is required when SAGE_DOCUMENT_TESTS=1.");
  let databaseName: string;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") throw new Error("protocol");
    databaseName = decodeURIComponent(parsed.pathname.slice(1));
  } catch {
    throw new Error("DATABASE_URL must be a valid PostgreSQL URL; it was not logged.");
  }
  if (databaseName !== "sage_document15") {
    throw new Error("Live document regression only allows the isolated sage_document15 database.");
  }
  const key = process.env.CREDENTIAL_ENCRYPTION_KEY;
  if (!key || !/^[A-Za-z0-9+/]{43}=$/.test(key) || Buffer.from(key, "base64").length !== 32 || Buffer.from(key, "base64").toString("base64") !== key) {
    throw new Error("CREDENTIAL_ENCRYPTION_KEY must be the test-only canonical base64 key shared with Next.");
  }
}

async function preparePrivateStorageRoot(): Promise<string> {
  const raw = process.env.STORAGE_ROOT;
  if (!raw || !isAbsolute(raw)) throw new Error("STORAGE_ROOT must be an absolute private temporary directory shared with Next.");
  const requested = resolve(raw);
  const temporaryRoots = [...new Set([resolve(tmpdir()), resolve("/tmp"), resolve("/var/tmp")])];
  if (temporaryRoots.every(root => requested === root || !requested.startsWith(`${root}${sep}`))) {
    throw new Error("Refusing to use STORAGE_ROOT outside a temporary directory.");
  }
  await mkdir(requested, { recursive: true, mode: 0o700 });
  const stat = await lstat(requested);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("STORAGE_ROOT must be a real directory, not a symlink.");
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) throw new Error("STORAGE_ROOT must have private permissions (0700).");
  if ((await readdir(requested)).length > 0) throw new Error("STORAGE_ROOT must be an empty DOC-01 fixture directory.");
  return requested;
}

async function makeTarGz(sources: Readonly<Record<string, Uint8Array>>): Promise<Buffer> {
  const tar = pack();
  const archiveRoot = `sage-document15-source-${randomBytes(4).toString("hex")}`;
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
  for (const path of Object.keys(sources).sort()) await add(`${archiveRoot}/${path}`, Buffer.from(sources[path]!), "file");
  tar.finalize();
  const chunks: Buffer[] = [];
  for await (const chunk of tar) chunks.push(Buffer.from(chunk as Uint8Array));
  return gzipSync(Buffer.concat(chunks));
}

async function loadResolverFixture(): Promise<{ sources: Record<string, Uint8Array>; ccm: CcmV1; snapshot: CcmSnapshot }> {
  const paths = ["src/model.ts", "src/endpoint.ts"];
  const entries = await Promise.all(paths.map(async path => [path, new Uint8Array(await readFile(new URL(path, fixtureDir)))] as const));
  const sources: Record<string, Uint8Array> = Object.fromEntries(entries);
  const dangerousSource = [
    "export interface CaféPort { execute(): string; }",
    "export class CaféService implements CaféPort {",
    "  execute(): string { return (this as unknown as { missing: { run(): string } }).missing.run(); }",
    "}",
    `export const htmlCanary = "<img src=x onerror=alert('${htmlCanary}')>";`,
    'export const remoteCanary = "https://external-resource.invalid/DOC15_URL_CANARY";',
    "// DOC15_RAW_SOURCE_CANARY: this source must remain outside the response.",
  ].join("\n");
  sources[specialSourcePath] = new Uint8Array(Buffer.from(dangerousSource, "utf8"));
  const snapshot: CcmSnapshot = { repository: fixtureRepository, branch: fixtureBranch, commitSha: fixtureCommit };
  const result = analyzeReferences({ snapshot, sources });
  assert.equal(result.errorCode, null, "checked-in resolver fixture plus Unicode TypeScript must analyze successfully");
  assert.ok(result.ccm, "fixture must produce a CCM");
  const presentKinds = new Set(result.ccm.nodes.map(node => node.kind));
  for (const kind of nodeKinds) assert.ok(presentKinds.has(kind), `fixture must contain ${kind}`);
  assert.ok(result.ccm.edges.some(edge => edge.resolution === "Unresolved"), "fixture must exercise unresolved references");
  assert.ok(result.ccm.nodes.some(node => node.name === "CaféService"), "fixture must include a Unicode declaration");
  return { sources, ccm: result.ccm, snapshot };
}

async function makeAccount(
  db: ReturnType<typeof database>,
  label: string,
  userIds: string[],
  sessionIds: string[],
): Promise<DisposableAccount> {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const login = `document15-${label}-${suffix}`;
  const accountKey = `document15-gh-${label}-${suffix}`;
  const syntheticProviderToken = `synthetic-not-provider-document15-${label}-${suffix}`;
  const user = await db.user.create({ data: { githubUserId: accountKey, login }, select: { id: true } });
  userIds.push(user.id);
  await storeGitHubCredential(db, user.id, { githubUserId: accountKey, githubLogin: login, accessToken: syntheticProviderToken });
  const created = await createSession(db, user.id, { ttlMs: 30 * 60 * 1000 });
  sessionIds.push(created.session.sessionId);
  return { userId: user.id, login, accountKey, token: created.token, sessionId: created.session.sessionId, syntheticProviderToken };
}

function cookieHeader(account: DisposableAccount): Record<string, string> {
  return { Cookie: `sage_session=${account.token}`, "X-SAGE-Account": account.accountKey };
}

function noSensitiveResponseData(bodyText: string, values: readonly string[]): void {
  for (const value of values) if (value) assert.ok(!bodyText.includes(value), "response must not expose session/provider secrets or source/archive data");
  assert.doesNotMatch(bodyText, /snapshot-[A-Za-z0-9]{6}\/archive\.tar\.gz|sage-document15-source|DOC15_RAW_SOURCE_CANARY|DOC15_URL_CANARY|DOC15_HTML_CANARY/i);
}

async function createAnalysisRow(
  db: ReturnType<typeof database>,
  input: {
    ownerUserId: string;
    repositoryId: string;
    snapshot: CcmSnapshot;
    configurationHash: string;
    status: "RUNNING" | "COMPLETED" | "COMPLETED_WITH_LIMITATIONS";
    label: string;
  },
): Promise<string> {
  const now = new Date();
  const created = await db.analysis.create({
    data: {
      ownerUserId: input.ownerUserId,
      repositoryId: input.repositoryId,
      repositoryFullNameSnapshot: input.snapshot.repository,
      branchName: input.snapshot.branch ?? "main",
      commitSha: input.snapshot.commitSha,
      configuration: { issue: "DOC-01", fixture: input.label },
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

async function createArchiveStorage(
  db: ReturnType<typeof database>,
  storageRoot: string,
  ownerUserId: string,
  analysisId: string,
  sources: Readonly<Record<string, Uint8Array>>,
  storageObjectIds: string[],
  createdFolders: string[],
): Promise<SeededArchive> {
  const bytes = await makeTarGz(sources);
  const folderPath = await mkdtemp(join(storageRoot, "snapshot-"));
  createdFolders.push(folderPath);
  const folderName = basename(folderPath);
  assert.match(folderName, /^snapshot-[A-Za-z0-9]{6}$/);
  const storageKey = `${folderName}/archive.tar.gz`;
  const archivePath = join(folderPath, "archive.tar.gz");
  await writeFile(archivePath, bytes, { flag: "wx", mode: 0o600 });
  const stored = await db.storageObject.create({
    data: { ownerUserId, analysisId, type: "SOURCE_ARCHIVE", storageKey, sha256: digest(bytes), byteLength: BigInt(bytes.byteLength) },
    select: { id: true },
  });
  storageObjectIds.push(stored.id);
  return { id: stored.id, bytes, archivePath, storageKey };
}

async function seedCanonicalDocument(
  db: ReturnType<typeof database>,
  input: {
    ownerUserId: string;
    analysisId: string;
    sourceBytes: Record<string, Uint8Array>;
    ccm: CcmV1;
    configurationHash: string;
    storageRoot: string;
    storageObjectIds: string[];
    createdFolders: string[];
  },
): Promise<SeededDocument> {
  const canonical = canonicalizeCkg(input.ccm, input.sourceBytes, input.configurationHash);
  if (!canonical.ok) throw new Error(`CKG canonicalization failed: ${canonical.errorCode}`);
  const document = projectArchitectureDocument(canonical.json, input.sourceBytes, canonical.sha256);
  if (!document.ok) throw new Error(`Architecture document projection failed: ${document.errorCode}`);
  await db.graphBundle.create({
    data: {
      ownerUserId: input.ownerUserId,
      analysisId: input.analysisId,
      schemaVersion: canonical.value.schemaVersion,
      configurationHash: input.configurationHash,
      canonicalContent: canonical.json,
      nodes: JSON.stringify(canonical.value.ccm.nodes),
      edges: JSON.stringify(canonical.value.ccm.edges),
      nodeCount: canonical.value.counts.nodes,
      edgeCount: canonical.value.counts.edges,
      contentHash: canonical.sha256,
    },
  });
  await db.architectureDocument.create({
    data: {
      ownerUserId: input.ownerUserId,
      analysisId: input.analysisId,
      title: document.value.title,
      documentModelVersion: document.value.schemaVersion,
      canonicalContent: document.json,
      interfaceCatalog: JSON.stringify(document.value.interfaceCatalog),
      softwareEngineeringDiagram: JSON.stringify(document.value.softwareEngineeringDiagram),
      umlClassDiagram: JSON.stringify(document.value.umlClassDiagram),
      contentHash: document.sha256,
    },
  });
  const archive = await createArchiveStorage(
    db, input.storageRoot, input.ownerUserId, input.analysisId, input.sourceBytes, input.storageObjectIds, input.createdFolders,
  );
  return {
    analysisId: input.analysisId,
    ckgJson: canonical.json,
    ckgSha256: canonical.sha256,
    documentJson: document.json,
    documentSha256: document.sha256,
    document: document.value,
    snapshot: document.value.snapshot,
    counts: { nodes: canonical.value.counts.nodes, edges: canonical.value.counts.edges },
    sourceBytes: input.sourceBytes,
    archive,
  };
}

function documentApiUrl(base: string, analysisId: string): string {
  return `${base}/api/analyses/${analysisId}/document`;
}

function documentPageUrl(base: string, analysisId: string): string {
  return `${base}/analyses/${analysisId}/document`;
}

async function assertSafeRenderedSvg(
  page: Page,
  alt: string,
  viewportWidth: number,
  svgArtifacts: string[],
  expectHtmlPathAsText = false,
): Promise<void> {
  const image = page.getByRole("img", { name: alt, exact: true });
  await image.waitFor({ state: "visible" });
  await page.waitForFunction(label => {
    const imageElement = document.querySelector<HTMLImageElement>(`img[alt="${CSS.escape(label)}"]`);
    return Boolean(imageElement?.complete && imageElement.naturalWidth > 0);
  }, alt);
  const result = await image.evaluate(async imageElement => {
    const image = imageElement as HTMLImageElement;
    const source = image.currentSrc || image.src;
    const response = await fetch(source);
    const markup = await response.text();
    const xml = new DOMParser().parseFromString(markup, "image/svg+xml");
    const svg = xml.documentElement;
    const forbidden: string[] = [];
    const external: string[] = [];
    const elements = [svg, ...Array.from(svg.querySelectorAll("*"))];
    for (const element of elements) {
      const name = element.localName.toLowerCase();
      if (element.namespaceURI !== "http://www.w3.org/2000/svg" ||
          ["script", "foreignobject", "iframe", "object", "embed", "image", "audio", "video", "a", "set", "animate", "animatetransform", "animatemotion"].includes(name)) {
        forbidden.push(name);
      }
      for (const attribute of Array.from(element.attributes)) {
        const attributeName = attribute.localName.toLowerCase();
        const value = attribute.value.trim();
        if (attributeName.startsWith("on")) forbidden.push(`${name}[${attributeName}]`);
        if (attributeName === "href" || attributeName === "src") {
          if (!value.startsWith("#")) external.push(`${name}[${attributeName}]=${value}`);
        }
        for (const match of value.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gi)) {
          if (!match[2]!.trim().startsWith("#")) external.push(`${name}[${attributeName}]=${match[2]}`);
        }
        if (/javascript\s*:/i.test(value)) forbidden.push(`${name}[${attributeName}]`);
      }
      if (name === "style") {
        const style = element.textContent ?? "";
        if (/@import|expression\s*\(|javascript\s*:/i.test(style)) forbidden.push("style");
        for (const match of style.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gi)) {
          if (!match[2]!.trim().startsWith("#")) external.push(`style=${match[2]}`);
        }
      }
    }
    return {
      sourceProtocol: new URL(source).protocol,
      contentType: response.headers.get("content-type") ?? "",
      parserError: Boolean(xml.querySelector("parsererror")),
      rootName: svg.localName,
      forbidden,
      external,
      hasUnicodeLabel: (svg.textContent ?? "").includes("CaféService"),
      hasHtmlPathAsText: (svg.textContent ?? "").includes("<script>"),
      hasUrlCanary: markup.includes("DOC15_URL_CANARY"),
      svgBytes: new TextEncoder().encode(markup).byteLength,
      markup,
    };
  });
  const diagramName = alt === "Software Engineering Diagram" ? "software-engineering-diagram" : "uml-class-diagram";
  const artifactPath = `artifacts/document-15/svg/document-${viewportWidth}-${diagramName}.svg`;
  await mkdir(dirname(join(projectRoot, artifactPath)), { recursive: true });
  await writeFile(join(projectRoot, artifactPath), result.markup, { mode: 0o600 });
  svgArtifacts.push(artifactPath);
  assert.equal(result.sourceProtocol, "blob:", `${alt} must be served as a local blob-backed SVG image`);
  assert.match(result.contentType, /image\/svg\+xml/i);
  assert.equal(result.parserError, false, `${alt} SVG must parse as XML`);
  assert.equal(result.rootName, "svg");
  assert.deepEqual(result.forbidden, [], `${alt} SVG must have inert labels and elements`);
  assert.deepEqual(result.external, [], `${alt} SVG must have no external resource references`);
  assert.equal(result.hasUnicodeLabel, true, `${alt} SVG must retain the Unicode declaration label`);
  assert.equal(result.hasHtmlPathAsText, expectHtmlPathAsText, `${alt} SVG must handle the HTML-like source path as plain text when it is part of a label`);
  assert.equal(result.hasUrlCanary, false, `${alt} SVG must not contain an untrusted URL source literal`);
  assert.ok(result.svgBytes <= 4 * 1024 * 1024, `${alt} SVG must remain within the renderer size limit`);
}

async function assertDiagramZoom(
  page: Page,
  alt: string,
  viewportWidth: number,
  zoomArtifacts: string[],
  captureMaximumZoom = false,
): Promise<void> {
  const controls = page.getByRole("group", { name: "Kontrol zoom diagram", exact: true });
  const percent = page.getByTestId("document-diagram-zoom-value");
  const image = page.getByRole("img", { name: alt, exact: true });
  const decrease = controls.getByRole("button", { name: "Perkecil", exact: true });
  const increase = controls.getByRole("button", { name: "Perbesar", exact: true });
  const fit = controls.getByRole("button", { name: "Sesuaikan", exact: true });
  const waitForPercent = async (value: number): Promise<void> => {
    await page.waitForFunction(expected =>
      document.querySelector("[data-testid='document-diagram-zoom-value']")?.textContent?.trim() === expected,
    `Zoom: ${value}%`);
  };
  const imageWidth = async (): Promise<number> => image.evaluate(element => element.getBoundingClientRect().width);

  await controls.waitFor({ state: "visible" });
  await image.waitFor({ state: "visible" });
  assert.equal((await percent.innerText()).trim(), "Zoom: 100%", `${viewportWidth}px ${alt} must start at 100%`);
  assert.equal(await decrease.isDisabled(), true, `${viewportWidth}px Perkecil must be disabled at the 100% minimum`);
  assert.equal(await increase.isDisabled(), false, `${viewportWidth}px Perbesar must be enabled below the 400% maximum`);
  assert.equal(await fit.isDisabled(), true, `${viewportWidth}px Sesuaikan must be disabled at 100%`);
  const widthAt100 = await imageWidth();

  await increase.focus();
  await page.keyboard.press("Enter");
  await waitForPercent(150);
  const widthAt150 = await imageWidth();
  assert.ok(widthAt150 > widthAt100 + 1, `${viewportWidth}px Perbesar must visibly increase the SVG image width`);
  assert.equal(await decrease.isDisabled(), false, `${viewportWidth}px Perkecil must be enabled above the minimum`);
  assert.equal(await fit.isDisabled(), false, `${viewportWidth}px Sesuaikan must be enabled above 100%`);

  await decrease.focus();
  await page.keyboard.press("Space");
  await waitForPercent(100);
  assert.ok(Math.abs((await imageWidth()) - widthAt100) <= 1, `${viewportWidth}px Perkecil must restore the 100% image width`);

  await increase.focus();
  await page.keyboard.press("Space");
  await waitForPercent(150);
  await fit.focus();
  await page.keyboard.press("Enter");
  await waitForPercent(100);
  assert.ok(Math.abs((await imageWidth()) - widthAt100) <= 1, `${viewportWidth}px Sesuaikan must reset image width to 100%`);

  if (captureMaximumZoom) {
    for (const nextPercent of [150, 200, 250, 300, 350, 400]) {
      await increase.click();
      await waitForPercent(nextPercent);
    }
    assert.equal(await increase.isDisabled(), true, `${viewportWidth}px Perbesar must clamp at 400%`);
    assert.equal(await decrease.isDisabled(), false, `${viewportWidth}px Perkecil must remain available at 400%`);
    assert.ok((await imageWidth()) > widthAt100 * 3.9, `${viewportWidth}px 400% zoom must expand the rendered image width`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true,
      `${viewportWidth}px zoomed diagram must remain contained by its scrollable viewport`);

    const screenshotName = `document-${viewportWidth}-${alt === "Software Engineering Diagram" ? "software" : "uml"}-diagram-zoom-400.png`;
    await controls.scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(resultDir, screenshotName), fullPage: false });
    const artifactPath = `artifacts/document-15/${screenshotName}`;
    zoomArtifacts.push(artifactPath);
    await page.getByTestId("document-diagram-viewport").screenshot({ path: join(resultDir, screenshotName.replace(/\.png$/, "-diagram-viewport.png")) });
    zoomArtifacts.push(`artifacts/document-15/${screenshotName.replace(/\.png$/, "-diagram-viewport.png")}`);

    await fit.focus();
    await page.keyboard.press("Enter");
    await waitForPercent(100);
    assert.ok(Math.abs((await imageWidth()) - widthAt100) <= 1, `${viewportWidth}px Sesuaikan must reset from the 400% maximum`);
  }
}

async function saveScreenshot(page: Page, filename: string): Promise<void> {
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: join(resultDir, filename), fullPage: true });
  await page.screenshot({ path: join(resultDir, filename.replace(/\.png$/, "-viewport.png")), fullPage: false });
}

async function runLiveDocumentRegression(): Promise<void> {
  requireDedicatedDatabase();
  const rawBase = process.env.SAGE_DOCUMENT_BASE_URL;
  if (!rawBase) throw new Error("SAGE_DOCUMENT_BASE_URL is required for the live document regression.");
  const base = rawBase.replace(/\/$/, "");
  const parsedBase = new URL(base);
  if (parsedBase.protocol !== "http:" && parsedBase.protocol !== "https:") throw new Error("SAGE_DOCUMENT_BASE_URL must be HTTP(S).");
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
  const overflowDiagnostics: Array<Record<string, unknown>> = [];
  const svgArtifacts: string[] = [];
  const zoomArtifacts: string[] = [];
  const offOriginRequests: string[] = [];
  const providerRequests: string[] = [];
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let api: APIRequestContext | undefined;
  let repositoryId = "";
  let reportStatus: "PASS" | "FAIL" = "PASS";
  let reportError: string | undefined;
  let owner: DisposableAccount | undefined;
  let other: DisposableAccount | undefined;
  let ready: SeededDocument | undefined;

  try {
    await mkdir(resultDir, { recursive: true });
    api = await request.newContext({ baseURL: base, timeout: 20_000 });
    const health = await api.get("/api/health");
    assert.equal(health.status(), 200, "externally started Next server must be reachable and connected to PostgreSQL");
    assert.deepEqual(await health.json(), { status: "ok", service: "web", database: "ok" });
    checks.push("real Next server health and PostgreSQL connectivity");

    owner = await makeAccount(db, "owner", users, sessionIds);
    other = await makeAccount(db, "other", users, sessionIds);
    const repository = await db.repository.create({
      data: {
        githubRepositoryId: `document15-repo-${randomUUID()}`,
        ownerLogin: owner.login,
        name: "resolver-typescript-document-fixture",
        fullName: `${owner.login}/resolver-typescript-document-fixture`,
        visibility: "PUBLIC",
      },
      select: { id: true },
    });
    repositoryId = repository.id;

    const fixture = await loadResolverFixture();
    const configurationHash = digest("SAGE DOC-01 live regression fixture configuration v1");
    const analysisId = await createAnalysisRow(db, {
      ownerUserId: owner.userId,
      repositoryId,
      status: "COMPLETED_WITH_LIMITATIONS",
      snapshot: fixture.snapshot,
      configurationHash,
      label: "resolver-typescript-source-backed-document",
    });
    analysisIds.push(analysisId);
    ready = await seedCanonicalDocument(db, {
      ownerUserId: owner.userId,
      analysisId,
      sourceBytes: fixture.sources,
      ccm: fixture.ccm,
      configurationHash,
      storageRoot,
      storageObjectIds,
      createdFolders,
    });

    const runningSnapshot: CcmSnapshot = {
      repository: fixture.snapshot.repository,
      branch: fixture.snapshot.branch,
      commitSha: createHash("sha1").update("sage-document15-running-fixture").digest("hex"),
    };
    const runningId = await createAnalysisRow(db, {
      ownerUserId: other.userId,
      repositoryId,
      status: "RUNNING",
      snapshot: runningSnapshot,
      configurationHash: digest("SAGE DOC-01 running fixture configuration v1"),
      label: "running-no-document",
    });
    analysisIds.push(runningId);

    const missingDocumentSnapshot: CcmSnapshot = {
      repository: fixture.snapshot.repository,
      branch: fixture.snapshot.branch,
      commitSha: createHash("sha1").update("sage-document15-missing-document-fixture").digest("hex"),
    };
    const missingDocumentId = await createAnalysisRow(db, {
      ownerUserId: owner.userId,
      repositoryId,
      status: "COMPLETED",
      snapshot: missingDocumentSnapshot,
      configurationHash: digest("SAGE DOC-01 missing document configuration v1"),
      label: "terminal-without-document",
    });
    analysisIds.push(missingDocumentId);
    await createArchiveStorage(db, storageRoot, owner.userId, missingDocumentId, fixture.sources, storageObjectIds, createdFolders);

    browser = await chromium.launch({ headless: true, args: ["--disable-background-networking", "--disable-default-apps"] });

    const readyUrl = documentApiUrl(base, ready.analysisId);
    const success = await api.get(readyUrl, { headers: cookieHeader(owner) });
    assert.equal(success.status(), 200);
    const responseHeaders = success.headers();
    assert.match(responseHeaders["cache-control"] ?? "", /private,\s*no-store/i);
    assert.match(responseHeaders.vary ?? "", /Cookie/i);
    assert.match(responseHeaders.vary ?? "", /X-SAGE-Account/i);
    assert.equal(responseHeaders["x-content-type-options"], "nosniff");
    const successBody = await success.json() as { data?: { analysisId?: string; accountKey?: string; contentHash?: string; document?: unknown } };
    assert.ok(successBody.data);
    assert.equal(successBody.data.analysisId, ready.analysisId);
    assert.equal(successBody.data.accountKey, owner.accountKey);
    assert.equal(successBody.data.contentHash, ready.documentSha256);
    assert.deepEqual(successBody.data.document, ready.document, "HTTP must expose the complete canonical ArchitectureDocumentV1 projection");
    const successText = JSON.stringify(successBody);
    noSensitiveResponseData(successText, [owner.token, other.token, owner.syntheticProviderToken, other.syntheticProviderToken, storageRoot, ready.archive.storageKey]);
    assert.ok(!successText.includes(Buffer.from(ready.sourceBytes[specialSourcePath]!).toString("utf8")), "HTTP must not expose raw source bytes");
    assert.ok(!successText.includes("DOC15_RAW_SOURCE_CANARY"));
    assert.ok(!successText.includes("DOC15_URL_CANARY"));
    assert.ok(ready.document.interfaceCatalog.relations.some(edge => edge.resolution === "Unresolved"));
    assert.ok(ready.document.interfaceCatalog.entries.some(entry => entry.declaration.name === "CaféService"));
    checks.push("real HTTP API: owner receives the full canonical document, CKG/hash/count metadata, source evidence, and unresolved relations without source/archive/session leaks");

    const anonymous = await api.get(readyUrl);
    assert.equal(anonymous.status(), 401);
    assert.equal((await anonymous.json() as ApiErrorBody).error?.code, "AUTH_REQUIRED");
    const mismatchedAccount = await api.get(readyUrl, {
      headers: { Cookie: `sage_session=${owner.token}`, "X-SAGE-Account": other.accountKey },
    });
    assert.equal(mismatchedAccount.status(), 401);
    assert.equal((await mismatchedAccount.json() as ApiErrorBody).error?.code, "AUTH_REQUIRED");
    const foreign = await api.get(readyUrl, { headers: cookieHeader(other) });
    assert.equal(foreign.status(), 404);
    assert.equal((await foreign.json() as ApiErrorBody).error?.code, "ANALYSIS_NOT_FOUND");
    const unknown = await api.get(documentApiUrl(base, "missing-document-15"), { headers: cookieHeader(owner) });
    assert.equal(unknown.status(), 404);
    assert.equal((await unknown.json() as ApiErrorBody).error?.code, "ANALYSIS_NOT_FOUND");
    const running = await api.get(documentApiUrl(base, runningId), { headers: cookieHeader(other) });
    assert.equal(running.status(), 409);
    assert.equal((await running.json() as ApiErrorBody).error?.code, "RESULT_NOT_READY");
    const noDocument = await api.get(documentApiUrl(base, missingDocumentId), { headers: cookieHeader(owner) });
    assert.equal(noDocument.status(), 503);
    assert.equal((await noDocument.json() as ApiErrorBody).error?.code, "DOCUMENT_UNAVAILABLE");
    const invalidId = await api.get(`${base}/api/analyses/invalid!/document`, { headers: cookieHeader(owner) });
    assert.equal(invalidId.status(), 400);
    assert.equal((await invalidId.json() as ApiErrorBody).error?.code, "INVALID_INPUT");
    const query = await api.get(`${readyUrl}?unexpected=1`, { headers: cookieHeader(owner) });
    assert.equal(query.status(), 400);
    assert.equal((await query.json() as ApiErrorBody).error?.code, "INVALID_INPUT");
    checks.push("real HTTP API: anonymous/account mismatch 401, foreign/missing 404, RUNNING 409, missing terminal document 503, and invalid ID/query 400");

    const originalDocument = await db.architectureDocument.findUniqueOrThrow({
      where: { analysisId_ownerUserId: { analysisId: ready.analysisId, ownerUserId: owner.userId } },
    });
    const corruptedDocumentHash = originalDocument.contentHash === "0".repeat(64) ? "1".repeat(64) : "0".repeat(64);
    try {
      await db.architectureDocument.update({
        where: { analysisId_ownerUserId: { analysisId: ready.analysisId, ownerUserId: owner.userId } },
        data: { contentHash: corruptedDocumentHash },
      });
      const corrupted = await api.get(readyUrl, { headers: cookieHeader(owner) });
      assert.equal(corrupted.status(), 503);
      const body = await corrupted.text();
      assert.match(body, /DOCUMENT_UNAVAILABLE/);
      noSensitiveResponseData(body, [owner.token, other.token, owner.syntheticProviderToken, other.syntheticProviderToken, storageRoot, ready.archive.storageKey]);
    } finally {
      await db.architectureDocument.update({
        where: { analysisId_ownerUserId: { analysisId: ready.analysisId, ownerUserId: owner.userId } },
        data: { contentHash: originalDocument.contentHash },
      });
    }
    assert.equal((await api.get(readyUrl, { headers: cookieHeader(owner) })).status(), 200, "restored canonical document must recover");
    checks.push("real HTTP API: corrupted canonical document becomes safe 503 and recovers after row restoration");

    const corruptedArchive = Buffer.from(ready.archive.bytes);
    corruptedArchive[corruptedArchive.length - 1] = corruptedArchive[corruptedArchive.length - 1]! ^ 0x01;
    try {
      await writeFile(ready.archive.archivePath, corruptedArchive, { mode: 0o600 });
      const corrupted = await api.get(readyUrl, { headers: cookieHeader(owner) });
      assert.equal(corrupted.status(), 503);
      const body = await corrupted.text();
      assert.match(body, /DOCUMENT_UNAVAILABLE/);
      noSensitiveResponseData(body, [owner.token, other.token, owner.syntheticProviderToken, other.syntheticProviderToken, storageRoot, ready.archive.storageKey]);
    } finally {
      await writeFile(ready.archive.archivePath, ready.archive.bytes, { mode: 0o600 });
    }
    assert.equal((await api.get(readyUrl, { headers: cookieHeader(owner) })).status(), 200, "restored source archive must recover");
    checks.push("real HTTP API: corrupted immutable source archive becomes safe 503 and recovers after byte restoration");

    // This is the only synthetic failure outside the delayed-response race:
    // one marked 503 exercises the product retry button, then the retry reaches
    // the genuine document API and database.
    const retryContext = await browser.newContext({ viewport: { width: 390, height: 1000 }, reducedMotion: "reduce", serviceWorkers: "block" });
    await retryContext.addCookies([{ name: "sage_session", value: owner.token, url: base, httpOnly: true, sameSite: "Lax" }]);
    const retryPage = await retryContext.newPage();
    retryPage.setDefaultTimeout(25_000);
    retryPage.on("pageerror", error => pageErrors.push(`controlled retry: ${error.message}`));
    retryPage.on("request", req => {
      const url = new URL(req.url());
      if ((url.protocol === "http:" || url.protocol === "https:") && url.origin !== parsedBase.origin) offOriginRequests.push(`controlled retry ${req.url()}`);
      if (url.hostname === "github.com" || url.hostname === "api.github.com" || url.pathname.startsWith("/api/github/")) providerRequests.push(`controlled retry ${req.url()}`);
    });
    let controlled503Count = 0;
    let genuineRetryStatus = 0;
    await retryPage.route(`**/api/analyses/${ready.analysisId}/document`, async route => {
      if (controlled503Count === 0) {
        controlled503Count += 1;
        return route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: { code: "DOCUMENT_UNAVAILABLE", message: "Dokumen sementara tidak dapat dibaca. Coba lagi." } }),
        });
      }
      const actual = await route.fetch();
      genuineRetryStatus = actual.status();
      return route.fulfill({ response: actual });
    });
    await retryPage.goto(documentPageUrl(base, ready.analysisId), { waitUntil: "networkidle" });
    await retryPage.getByRole("alert").getByRole("button", { name: "Coba lagi", exact: true }).waitFor();
    const retryResponse = retryPage.waitForResponse(response => {
      const url = new URL(response.url());
      return url.pathname === `/api/analyses/${ready!.analysisId}/document` && response.status() === 200;
    });
    await retryPage.getByRole("alert").getByRole("button", { name: "Coba lagi", exact: true }).click();
    await retryResponse;
    const retryCatalogTable = retryPage.getByRole("table").filter({
      has: retryPage.getByRole("columnheader", { name: "Symbol", exact: true }),
    });
    await retryCatalogTable.getByRole("columnheader", { name: "Symbol", exact: true }).waitFor();
    assert.equal(controlled503Count, 1, "only the named first-request UI retry case may be intercepted");
    assert.equal(genuineRetryStatus, 200, "retry must recover from the real document API");
    await retryContext.close();
    checks.push("controlled UI retry: one marked 503 exposes Coba lagi, then the real document API restores the catalog");

    for (const width of viewports) {
      const context: BrowserContext = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: "reduce", serviceWorkers: "block" });
      await context.addCookies([{ name: "sage_session", value: owner.token, url: base, httpOnly: true, sameSite: "Lax" }]);
      const page = await context.newPage();
      page.setDefaultTimeout(25_000);
      page.on("pageerror", error => pageErrors.push(`${width}px: ${error.message}`));
      page.on("request", req => {
        const url = new URL(req.url());
        if ((url.protocol === "http:" || url.protocol === "https:") && url.origin !== parsedBase.origin) offOriginRequests.push(`${width}px ${req.url()}`);
        if (url.hostname === "github.com" || url.hostname === "api.github.com" || url.pathname.startsWith("/api/github/")) providerRequests.push(`${width}px ${req.url()}`);
      });
      await page.goto(documentPageUrl(base, ready.analysisId), { waitUntil: "networkidle" });
      await page.getByRole("heading", { name: "Architecture Definition Document", exact: true }).waitFor();
      await page.getByRole("button", { name: /^Interface Catalog/ }).waitFor();
      for (const label of ["Repository", "Branch", "Commit snapshot", "Hash CKG", "Hash dokumen", "Konfigurasi", "Analyzer", "Schema", "File sumber", "Node / relasi kanonik", "Batasan analisis"]) {
        await page.getByText(label, { exact: false }).first().waitFor();
      }
      const intro = await page.locator("body").innerText();
      assert.ok(intro.includes(ready.document.ckgSha256), `${width}px page must display the canonical CKG hash`);
      assert.ok(intro.includes(ready.documentSha256), `${width}px page must display the canonical document hash`);
      assert.ok(intro.includes(String(ready.counts.nodes)), `${width}px page must expose canonical node counts`);
      assert.ok(intro.includes(String(ready.counts.edges)), `${width}px page must expose canonical edge counts`);
      assert.ok(intro.includes("Exact") && intro.includes("Unresolved"), `${width}px page must expose relation resolution states`);
      assert.ok(intro.includes("CaféService"), `${width}px page must display the Unicode catalog declaration`);
      assert.ok(intro.includes("<script>"), `${width}px page must keep the HTML-like path visible as text`);
      assert.equal(await page.locator("#document-content script, #document-content iframe, #document-content object").count(), 0,
        `${width}px HTML-like source path must not create active document elements`);
      assert.ok(!intro.includes("DOC15_RAW_SOURCE_CANARY"));
      assert.ok(!intro.includes("DOC15_URL_CANARY"));
      const catalogOverflow = await page.evaluate(() => {
        const viewportWidth = window.innerWidth;
        const offenders = Array.from(document.querySelectorAll<HTMLElement>("body *")).map(element => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return {
            tag: element.tagName.toLowerCase(),
            id: element.id,
            className: typeof element.className === "string" ? element.className : "",
            text: (element.innerText || element.textContent || "").trim().slice(0, 100),
            left: Number(rect.left.toFixed(1)),
            right: Number(rect.right.toFixed(1)),
            width: Number(rect.width.toFixed(1)),
            scrollWidth: element.scrollWidth,
            clientWidth: element.clientWidth,
            position: style.position,
            overflowX: style.overflowX,
            outsideRightBy: Number(Math.max(0, rect.right - viewportWidth).toFixed(1)),
            outsideLeftBy: Number(Math.max(0, -rect.left).toFixed(1)),
            innerOverflowBy: Math.max(0, element.scrollWidth - element.clientWidth),
          };
        }).filter(element => element.outsideRightBy > 1 || element.outsideLeftBy > 1 || element.innerOverflowBy > 1)
          .sort((left, right) => Math.max(right.outsideRightBy, right.outsideLeftBy) - Math.max(left.outsideRightBy, left.outsideLeftBy));
        return {
          viewportWidth,
          documentScrollWidth: document.documentElement.scrollWidth,
          bodyScrollWidth: document.body.scrollWidth,
          offenders: offenders.slice(0, 60),
        };
      });
      if (catalogOverflow.documentScrollWidth > width + 1) {
        const diagnostic = { viewport: width, screenshot: `document-${width}-catalog-overflow.png`, ...catalogOverflow };
        overflowDiagnostics.push(diagnostic);
        await saveScreenshot(page, `document-${width}-catalog-overflow.png`);
        console.error(`DOC15_CATALOG_OVERFLOW ${JSON.stringify(diagnostic)}`);
      }
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true, `${width}px catalog must not overflow horizontally`);
      await page.getByRole("heading", { name: "Interface Catalog", exact: true }).waitFor();
      const catalogTable = page.getByRole("table").filter({
        has: page.getByRole("columnheader", { name: "Symbol", exact: true }),
      });
      await catalogTable.getByRole("columnheader", { name: "Symbol", exact: true }).waitFor();
      await catalogTable.getByRole("columnheader", { name: "Kind / contract", exact: true }).waitFor();
      await catalogTable.getByRole("columnheader", { name: "Evidence", exact: true }).waitFor();
      await page.getByText("Unresolved", { exact: true }).first().waitFor();
      const unresolvedReason = ready.document.interfaceCatalog.relations.find(edge => edge.resolution === "Unresolved")?.unresolvedReason;
      assert.ok(unresolvedReason, "canonical fixture must preserve an unresolved reason");
      await page.getByText(unresolvedReason, { exact: true }).first().waitFor();
      await page.getByText(specialSourcePath, { exact: false }).first().waitFor();
      await saveScreenshot(page, `document-${width}-catalog.png`);

      const softwareButton = page.getByRole("button", { name: /^Software Engineering Diagram/ });
      await softwareButton.focus();
      await page.keyboard.press("Enter");
      await page.waitForFunction(() => document.getElementById("document-tab-structure")?.getAttribute("aria-pressed") === "true");
      assert.equal(await softwareButton.getAttribute("aria-pressed"), "true", `${width}px software section must be keyboard-selected`);
      await page.getByRole("heading", { name: "Software Engineering Diagram", exact: true }).waitFor();
      await assertSafeRenderedSvg(page, "Software Engineering Diagram", width, svgArtifacts, true);
      await assertDiagramZoom(
        page,
        "Software Engineering Diagram",
        width,
        zoomArtifacts,
        width === 1440,
      );
      await page.getByRole("heading", { name: "Bukti node pada diagram", exact: true }).waitFor();
      await page.getByRole("columnheader", { name: "Evidence source", exact: true }).first().waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true, `${width}px software diagram must not overflow horizontally`);
      await saveScreenshot(page, `document-${width}-software-diagram.png`);

      const umlButton = page.getByRole("button", { name: /^UML Class Diagram/ });
      await umlButton.focus();
      await page.keyboard.press("Enter");
      await page.waitForFunction(() => document.getElementById("document-tab-uml")?.getAttribute("aria-pressed") === "true");
      assert.equal(await umlButton.getAttribute("aria-pressed"), "true", `${width}px UML section must be keyboard-selected`);
      await page.getByRole("heading", { name: "UML Class Diagram", exact: true }).waitFor();
      assert.ok(ready.document.umlClassDiagram.nodes.some(node => node.qualifiedName.includes("<script>")), "UML fixture qualified names contain the HTML-like path as text");
      await assertSafeRenderedSvg(page, "UML Class Diagram", width, svgArtifacts, true);
      await assertDiagramZoom(page, "UML Class Diagram", width, zoomArtifacts);
      await page.getByRole("heading", { name: "Bukti node pada diagram", exact: true }).waitFor();
      await page.getByRole("columnheader", { name: "Evidence source", exact: true }).first().waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true, `${width}px UML diagram must not overflow horizontally`);
      await saveScreenshot(page, `document-${width}-uml-diagram.png`);
      await context.close();
      checks.push(`${width}px browser: catalog/source evidence, keyboard section and diagram zoom controls, both real Mermaid SVG images, inert labels, and no horizontal overflow`);
    }

    // Hold a genuine owner-A document response while the browser switches to B.
    // The page's focus identity recheck must replace A's identity and discard the late body.
    const raceContext = await browser.newContext({ viewport: { width: 390, height: 1000 }, reducedMotion: "reduce", serviceWorkers: "block" });
    await raceContext.addCookies([{ name: "sage_session", value: owner.token, url: base, httpOnly: true, sameSite: "Lax" }]);
    const racePage = await raceContext.newPage();
    racePage.setDefaultTimeout(25_000);
    racePage.on("pageerror", error => pageErrors.push(`identity switch: ${error.message}`));
    racePage.on("request", req => {
      const url = new URL(req.url());
      if ((url.protocol === "http:" || url.protocol === "https:") && url.origin !== parsedBase.origin) offOriginRequests.push(`identity switch ${req.url()}`);
      if (url.hostname === "github.com" || url.hostname === "api.github.com" || url.pathname.startsWith("/api/github/")) providerRequests.push(`identity switch ${req.url()}`);
    });
    let releaseDelayedResponse = () => {};
    let finishDelayedRoute = () => {};
    let signalDelayedRequest = () => {};
    let signalDelayedResponseReady = () => {};
    const delayedResponseGate = new Promise<void>(resolveGate => { releaseDelayedResponse = resolveGate; });
    const delayedRouteFinished = new Promise<void>(resolveGate => { finishDelayedRoute = resolveGate; });
    const delayedRequestStarted = new Promise<void>(resolveGate => { signalDelayedRequest = resolveGate; });
    const delayedResponseReady = new Promise<void>(resolveGate => { signalDelayedResponseReady = resolveGate; });
    let holdFirstDocumentResponse = true;
    let delayedResponseStatus = 0;
    await racePage.route(`**/api/analyses/${ready.analysisId}/document`, async route => {
      if (!holdFirstDocumentResponse) return route.continue();
      holdFirstDocumentResponse = false;
      signalDelayedRequest();
      try {
        const actual = await route.fetch();
        delayedResponseStatus = actual.status();
        signalDelayedResponseReady();
        await delayedResponseGate;
        try { await route.fulfill({ response: actual }); }
        catch { /* Focus identity refresh may abort the held original request. */ }
      } finally {
        finishDelayedRoute();
      }
    });
    await racePage.goto(documentPageUrl(base, ready.analysisId), { waitUntil: "domcontentloaded" });
    await delayedRequestStarted;
    await delayedResponseReady;
    assert.equal(delayedResponseStatus, 200, "held owner-A document must come from the real database-backed API");
    await raceContext.addCookies([{ name: "sage_session", value: other.token, url: base, httpOnly: true, sameSite: "Lax" }]);
    const staleIdentityResponse = racePage.waitForResponse(response => {
      const url = new URL(response.url());
      return url.pathname === "/api/auth/session" && response.request().headers()["x-sage-account"] === owner!.accountKey;
    });
    await racePage.evaluate(() => window.dispatchEvent(new Event("focus")));
    const identityResponse = await staleIdentityResponse;
    assert.equal(identityResponse.status(), 401, "identity endpoint must reject cookie B with stale A account binding");
    const ownerBDocument404 = racePage.waitForResponse(response => {
      const url = new URL(response.url());
      return url.pathname === `/api/analyses/${ready!.analysisId}/document` &&
        response.request().headers()["x-sage-account"] === other!.accountKey && response.status() === 404;
    });
    releaseDelayedResponse();
    await delayedRouteFinished;
    await ownerBDocument404;
    await racePage.getByRole("alert").filter({ hasText: "Analisis tidak ditemukan." }).waitFor();
    assert.equal(await racePage.getByRole("table").count(), 0, "owner B must not retain owner A's catalog");
    const raceText = await racePage.locator("body").innerText();
    assert.ok(!raceText.includes("CaféService"), "late owner-A response must not restore the private declaration");
    assert.ok(!raceText.includes("<script>"), "late owner-A response must not restore the source path");
    await raceContext.close();
    checks.push("delayed owner-A document response: focus recheck detects account B, receives real 404, and clears stale catalog data");

    assert.deepEqual(offOriginRequests, [], "document pages must make no off-origin HTTP(S) requests");
    assert.deepEqual(providerRequests, [], "document pages must make no GitHub/provider requests");
    checks.push("all browser paths, including retry and identity switch, make no off-origin or GitHub/provider requests");
    assert.deepEqual(pageErrors, [], "all document pages should complete without uncaught browser errors");
  } catch (error) {
    reportStatus = "FAIL";
    reportError = error instanceof Error ? error.message : "Live document regression failed.";
    failures.push(reportError);
  } finally {
    await browser?.close().catch(() => undefined);
    await api?.dispose().catch(() => undefined);
    try {
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
      overflowDiagnostics,
      renderedSvgArtifacts: svgArtifacts,
      diagramZoomArtifacts: zoomArtifacts,
      offOriginRequests: offOriginRequests.length,
      providerRequests: providerRequests.length,
      viewports: [...viewports],
      sourceFixture: "tests/fixtures/resolver/typescript/src/model.ts + endpoint.ts plus analyzer-parsed Unicode TypeScript",
      fixtureEvidence: ready ? {
        snapshot: ready.snapshot,
        ckgSha256: ready.ckgSha256,
        documentSha256: ready.documentSha256,
        canonicalCounts: ready.counts,
        sourceFiles: Object.keys(ready.sourceBytes).sort(),
        sourceBytesByFile: Object.fromEntries(Object.entries(ready.sourceBytes).map(([path, bytes]) => [path, bytes.byteLength])),
        sourceHashesByFile: Object.fromEntries(Object.entries(ready.sourceBytes).map(([path, bytes]) => [path, digest(bytes)])),
      } : null,
      safeFixtureBoundaries: {
        unicodeIdentifier: "CaféService",
        htmlLikePathSegment: specialSourcePath,
        sourceOnlyPayloads: [htmlCanary, "https://external-resource.invalid/DOC15_URL_CANARY", "DOC15_RAW_SOURCE_CANARY"],
        nulPath: "not seeded because canonical snapshot paths reject U+0000",
      },
      seedScope: "Direct test database seed of canonical GraphBundle, ArchitectureDocument, and SOURCE_ARCHIVE; this is not the nine-stage worker pipeline or worker publication.",
      controlledUiFailure: "One browser-only 503 is injected for the named retry case; the page retry recovers through the genuine API. The identity-switch response is held from the genuine API and is not fabricated.",
      delayedIdentityCase: "The held owner-A document body comes from the real HTTP API; changing to B makes the real session endpoint reject the stale A account binding, and B receives a real owner-scoped 404 before the held body can restore A's document.",
      storageRoot: "Dedicated private temporary fixture root; cleanup removes only script-created snapshot-* directories and rows tracked by generated IDs.",
      ...(reportError ? { error: reportError } : {}),
    };
    await writeFile(join(resultDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify({ status: reportStatus, checks: checks.length, failures, viewports: viewports.length, artifactDir: resultDir }));
  }
  if (reportStatus === "FAIL") process.exitCode = 1;
}

if (!enabled) {
  console.log("SKIP live document regression: set SAGE_DOCUMENT_TESTS=1 to opt in.");
} else {
  await runLiveDocumentRegression();
}
