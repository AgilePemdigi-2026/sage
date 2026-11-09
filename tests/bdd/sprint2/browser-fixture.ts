import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { pack } from "tar-stream";
import { analyzeReferences } from "@sage/analyzer-js";
import { canonicalizeCkg } from "@sage/contracts";
import { projectArchitectureDocument } from "@sage/documents/model";
import { database, createSession, storeGitHubCredential } from "@sage/database";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

const digest = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const services: ChildProcess[] = [];
let storage: string;
let browser: Browser;
let base: string;
let db: ReturnType<typeof database>;
let initialized: Promise<void> | undefined;
let stopping = false;
let cleanup: Promise<void> | undefined;
const requireRunning = () => assert.ok(!stopping, "Fixture shutdown requested");
const onTerm = () => { void stopFixtureServer().finally(() => process.exit(143)); };
const onInterrupt = () => { void stopFixtureServer().finally(() => process.exit(130)); };

export function startFixtureServer() {
  requireRunning();
  if (initialized) return initialized;
  process.once("SIGTERM", onTerm);
  process.once("SIGINT", onInterrupt);
  return initialized ??= (async () => {
    assert.equal(process.env.SAGE_BDD_DATABASES, "1", "Use the isolated Sprint 2 runner");
    const url = new URL(process.env.SAGE_BDD_DATABASE_URL!);
    assert.equal(url.hostname, "127.0.0.1");
    url.pathname = "/sage_srs_bdd";
    process.env.DATABASE_URL = url.toString();
    db = database();
    storage = await mkdtemp(resolve(tmpdir(), "sage-srs-bdd-"));
    requireRunning();
    const probe = createServer();
    await new Promise<void>(done => probe.listen(0, "127.0.0.1", done));
    const address = probe.address();
    assert.ok(address && typeof address !== "string");
    const port = address.port;
    await new Promise<void>(done => probe.close(() => done()));
    base = `http://127.0.0.1:${port}`;
    const env = { ...process.env, STORAGE_ROOT: storage, AUTH_BASE_URL: base,
      GITHUB_APP_CLIENT_ID: "synthetic-bdd", GITHUB_APP_CLIENT_SECRET: "synthetic-bdd", GITHUB_APP_SLUG: "synthetic-bdd" };
    const logs: Record<string, string> = {};
    for (const [label, args, cwd] of [
      ["web", [resolve("node_modules/next/dist/bin/next"), "start", "--hostname", "127.0.0.1", "--port", String(port)], resolve("apps/web")],
      ["worker", ["--import", "tsx", "apps/worker/src/index.ts"], process.cwd()],
    ] as const) {
      requireRunning();
      logs[label] = "";
      const child = spawn(process.execPath, [...args], { env, cwd, stdio: ["ignore", "pipe", "pipe"] });
      child.stdout!.on("data", data => { logs[label] += String(data); });
      child.stderr!.on("data", data => { logs[label] += String(data); });
      services.push(child);
    }
    let healthy = false;
    for (let i = 0; i < 100; i++) {
      requireRunning();
      assert.ok(services.every(child => child.exitCode === null), "Owned test service exited");
      try { healthy = (await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(500) })).ok; } catch { /* startup */ }
      if (healthy && logs.worker?.includes('"worker_ready"')) break;
      healthy = false;
      await new Promise(done => setTimeout(done, 200));
    }
    assert.ok(healthy, "Owned test services did not become ready");
    requireRunning();
    browser = await chromium.launch({ headless: true, handleSIGINT: false, handleSIGTERM: false });
  })();
}
export function stopFixtureServer(): Promise<void> {
  if (cleanup) return cleanup;
  stopping = true;
  cleanup = (async () => {
    // Resume a fault-injection pause before termination so the worker can exit.
    for (const child of services) { child.kill("SIGCONT"); child.kill("SIGTERM"); }
    await initialized?.catch(() => {});
    const failures: unknown[] = [];
    try { await browser?.close(); } catch (error) { failures.push(error); }
    await Promise.all(services.map(async child => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const closed = new Promise<void>(done => child.once("close", () => done()));
      await Promise.race([closed, new Promise(done => setTimeout(done, 2000))]);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await closed;
      }
    }));
    try { await db?.$disconnect(); } catch (error) { failures.push(error); }
    try { if (storage) await rm(storage, { recursive: true, force: true }); } catch (error) { failures.push(error); }
    process.off("SIGTERM", onTerm);
    process.off("SIGINT", onInterrupt);
    if (failures.length) throw new AggregateError(failures, "Fixture cleanup failed");
  })();
  return cleanup;
}
export function fixtureResourceSnapshot() {
  return { servicePids: services.map(child => child.pid), storage };
}
export interface ScenarioFixture {
  page: Page;
  context: BrowserContext;
  errors: string[];
  analysisId?: string;
  archiveId?: string;
  archiveHash?: string;
  userId: string;
  base: string;
  graph?: Extract<ReturnType<typeof canonicalizeCkg>, { ok: true }>["value"];
}
export async function createFixture(empty: boolean): Promise<ScenarioFixture> {
  await startFixtureServer();
  const tag = randomUUID();
  const user = await db.user.create({ data: { login: `srs-${tag}`, githubUserId: `srs-${tag}` } });
  await storeGitHubCredential(db, user.id, { githubUserId: user.githubUserId, githubLogin: user.login, accessToken: `synthetic-${tag}` });
  const session = await createSession(db, user.id);
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  await context.addCookies([{ name: "sage_session", value: session.token, url: base, httpOnly: true, sameSite: "Lax" }]);
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  const f: ScenarioFixture = { page, context, errors: [], userId: user.id, base };
  page.on("pageerror", error => f.errors.push(error.message));
  if (empty) return f;
  const repository = await db.repository.upsert({ where: { fullName: "acme/fintech-core" }, update: {}, create: {
    fullName: "acme/fintech-core", ownerLogin: "acme", name: "fintech-core", githubRepositoryId: `srs-repository-${tag}`,
  } });
  const sources: Record<string, Uint8Array> = Object.fromEntries(await Promise.all(["src/model.ts", "src/endpoint.ts"].map(async path => [path,
    new Uint8Array(await readFile(resolve("tests/fixtures/resolver/typescript", path)))] as const)));
  const snapshot = { repository: repository.fullName, branch: "main", commitSha: "a".repeat(40) };
  const analyzed = analyzeReferences({ snapshot, sources });
  assert.ok(analyzed.ccm);
  const configurationHash = digest("readable-srs-bdd");
  const graph = canonicalizeCkg(analyzed.ccm, sources, configurationHash);
  assert.ok(graph.ok);
  const doc = projectArchitectureDocument(graph.json, sources, graph.sha256);
  assert.ok(doc.ok);
  const analysis = await db.analysis.create({ data: { ownerUserId: user.id, repositoryId: repository.id,
    repositoryFullNameSnapshot: repository.fullName, branchName: "main", commitSha: snapshot.commitSha,
    configuration: {}, configurationHash, analyzerVersion: "srs-bdd", schemaVersion: "1", status: "COMPLETED", completedAt: new Date() } });
  f.analysisId = analysis.id;
  f.graph = graph.value;
  await db.graphBundle.create({ data: { ownerUserId: user.id, analysisId: analysis.id, schemaVersion: graph.value.schemaVersion,
    configurationHash, canonicalContent: graph.json, nodes: JSON.stringify(graph.value.ccm.nodes), edges: JSON.stringify(graph.value.ccm.edges),
    nodeCount: graph.value.counts.nodes, edgeCount: graph.value.counts.edges, contentHash: graph.sha256 } });
  await db.architectureDocument.create({ data: { ownerUserId: user.id, analysisId: analysis.id, title: doc.value.title,
    documentModelVersion: doc.value.schemaVersion, canonicalContent: doc.json, contentHash: doc.sha256,
    interfaceCatalog: JSON.stringify(doc.value.interfaceCatalog), softwareEngineeringDiagram: JSON.stringify(doc.value.softwareEngineeringDiagram), umlClassDiagram: JSON.stringify(doc.value.umlClassDiagram) } });
  const tar = pack();
  const chunks: Buffer[] = [];
  const collected = (async () => { for await (const chunk of tar) chunks.push(Buffer.from(chunk as Uint8Array)); })();
  for (const [path, bytes] of Object.entries(sources)) {
    await new Promise<void>((done, reject) => tar.entry({ name: `fixture/${path}`, size: bytes.byteLength, mode: 0o644 }, Buffer.from(bytes), error => error ? reject(error) : done()));
    await db.sourceFile.create({ data: { ownerUserId: user.id, analysisId: analysis.id, path, language: "TypeScript", byteLength: BigInt(bytes.byteLength), sha256: digest(bytes), processingStatus: "ANALYZED" } });
  }
  tar.finalize();
  await collected;
  const archive = gzipSync(Buffer.concat(chunks));
  const folder = await mkdtemp(resolve(storage, "snapshot-"));
  const key = `${folder.split("/").at(-1)}/archive.tar.gz`;
  await writeFile(resolve(storage, key), archive, { mode: 0o600 });
  const stored = await db.storageObject.create({ data: { ownerUserId: user.id, analysisId: analysis.id, type: "SOURCE_ARCHIVE", storageKey: key, sha256: digest(archive), byteLength: BigInt(archive.byteLength) } });
  f.archiveId = stored.id;
  f.archiveHash = stored.sha256;
  return f;
}
export function pauseFixtureWorker(paused: boolean) {
  const worker = services[1];
  assert.ok(worker && worker.exitCode === null, "Owned fixture worker must be running");
  worker.kill(paused ? "SIGSTOP" : "SIGCONT");
}
export async function setArchiveFault(f: ScenarioFixture, corrupt: boolean) {
  assert.ok(f.archiveId && f.archiveHash);
  await db.storageObject.update({ where: { id: f.archiveId }, data: { sha256: corrupt ? "0".repeat(64) : f.archiveHash } });
}
export async function exportRecord(f: ScenarioFixture, format: string) {
  return db.export.findFirstOrThrow({ where: { analysisId: f.analysisId!, ownerUserId: f.userId, format: format === "PDF" ? "PDF" : "MARKDOWN" }, orderBy: { createdAt: "desc" } });
}
