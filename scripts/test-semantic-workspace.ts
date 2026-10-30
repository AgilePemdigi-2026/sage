import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { chromium, type Page, type Route } from "playwright";
import { EDGE_KINDS, EDGE_RESOLUTIONS, EVIDENCE_ROLES, LANGUAGES, NODE_KINDS, NODE_ORIGINS, UNRESOLVED_REASONS } from "@sage/contracts";
import type { PresentationOverlay, SemanticEdge, SemanticFeature, SemanticModel, SemanticNode, SemanticPayload } from "@sage/documents/semantic/model";

/**
 * Browser regression for the semantic workspace using a disposable Next dev server and
 * explicitly labeled HTTP fixtures. This exercises the shipped React component, CSS,
 * browser routing, and overlay request contract. When a saved Perpus semantic artifact is
 * available it also checks actual model-derived flows and evidence without rerunning the
 * analyzer. It does not exercise the real database, worker, or production API integration.
 *
 * Run: npx tsx scripts/test-semantic-workspace.ts
 */

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceAppRoot = resolve(projectRoot, "apps/web");
const artifactDirectory = resolve(projectRoot, "artifacts/semantic-workspace");
const accountKey = "qa-semantic-account";
const analysisId = "qa-semantic-analysis";
const repository = "AgilePemdigi-2026/sage";
const commitSha = "a".repeat(40);
const perpusCorpusPath = process.env.SAGE_SEMANTIC_CORPUS ?? resolve(projectRoot, "artifacts/semantic/container-final/sistem-informasi-perpus-semantic.json");
const privateAccountMarker = "PRIVATE ACCOUNT: fixture owner one";

function evidence(filePath: string, line: number, role: "declaration" | "reference" | "context" = "declaration") {
  return {
    filePath,
    fileSha256: "c".repeat(64),
    startByte: line * 24,
    endByte: line * 24 + 16,
    startLine: line,
    endLine: line + 1,
    startColumn: 1,
    endColumn: 12,
    role,
  };
}

function buildFixture(): SemanticPayload {
  const nodes: SemanticNode[] = [];
  const edges: SemanticEdge[] = [];
  const features: SemanticFeature[] = [];
  const bookFeatureId = "feature-books";
  const authFeatureId = "feature-auth";
  const bookPath = "src/app/api/books/route.ts";
  const authPath = "src/lib/auth/session.ts";
  const addNode = (id: string, kind: SemanticNode["kind"], label: string, featureId: string | null, confidence: SemanticNode["confidence"], line: number) => {
    nodes.push({ id, kind, label, featureId, confidence, reason: `${label} ditemukan pada deklarasi source fixture.`,
      evidence: [evidence(kind === "component" && id === "component-auth" ? authPath : bookPath, line)], technicalNodeIds: [] });
    return id;
  };
  const addEdge = (id: string, source: string, target: string, label: string, confidence: SemanticEdge["confidence"], line: number, file = bookPath) => {
    edges.push({ id, source, target, label, confidence, reason: `Hubungan ${label} dideklarasikan pada baris fixture ${line}.`, evidence: [evidence(file, line, "reference")] });
    return id;
  };

  const bookNodeIds: string[] = [];
  const bookEdgeIds: string[] = [];
  const member = addNode("actor-member", "actor", "Anggota terautentikasi", bookFeatureId, "proven", 8);
  bookNodeIds.push(member);
  const firstStep = addNode("step-open-catalog", "step", "Buka katalog buku", bookFeatureId, "proven", 11);
  bookNodeIds.push(firstStep);
  bookEdgeIds.push(addEdge("edge-member-catalog", member, firstStep, "membuka", "proven", 12));
  let previous = firstStep;
  for (let index = 0; index < 26; index += 1) {
    const step = addNode(`step-search-${String(index).padStart(2, "0")}`, "step", `Cari buku tahap ${index + 1}`, bookFeatureId, "proven", 20 + index);
    bookNodeIds.push(step);
    bookEdgeIds.push(addEdge(`edge-search-${String(index).padStart(2, "0")}`, previous, step, index === 0 ? "memasukkan kata kunci" : "melanjutkan pencarian", "proven", 20 + index));
    previous = step;
  }
  const sessionDecision = addNode("decision-session", "decision", "Sesi pengguna masih berlaku?", bookFeatureId, "proven", 50);
  const bookingService = addNode("component-booking", "component", "BookingService", bookFeatureId, "proven", 55);
  const loanStore = addNode("store-loan", "store", "Loan records", bookFeatureId, "proven", 61);
  const loanOutcome = addNode("outcome-loan", "outcome", "Peminjaman tercatat", bookFeatureId, "proven", 67);
  const rejectedOutcome = addNode("outcome-rejected", "outcome", "Akses ditolak: sesi tidak berlaku", bookFeatureId, "indicated", 70);
  bookNodeIds.push(sessionDecision, bookingService, loanStore, loanOutcome, rejectedOutcome);
  bookEdgeIds.push(addEdge("edge-step-session", previous, sessionDecision, "memeriksa sesi", "proven", 50));
  bookEdgeIds.push(addEdge("edge-session-booking", sessionDecision, bookingService, "jika sesi berlaku", "proven", 55));
  bookEdgeIds.push(addEdge("edge-session-rejected", sessionDecision, rejectedOutcome, "jika sesi tidak berlaku", "indicated", 70));
  bookEdgeIds.push(addEdge("edge-booking-loan-store", bookingService, loanStore, "menyimpan peminjaman", "proven", 61));
  bookEdgeIds.push(addEdge("edge-loan-outcome", loanStore, loanOutcome, "menghasilkan", "proven", 67));
  features.push({ id: bookFeatureId, label: "Peminjaman buku", entryNodeIds: [firstStep], nodeIds: bookNodeIds, edgeIds: bookEdgeIds, evidence: [evidence(bookPath, 11)] });

  const authNodeIds: string[] = [];
  const authEdgeIds: string[] = [];
  const admin = addNode("actor-admin", "actor", "Administrator", authFeatureId, "proven", 3);
  const authComponent = addNode("component-auth", "component", "SessionService", authFeatureId, "proven", 5);
  const sessionStore = addNode("store-session", "store", "Session records", authFeatureId, "proven", 9);
  const tokenConcept = addNode("concept-session-token", "concept", "Sesi OAuth", authFeatureId, "indicated", 12);
  authNodeIds.push(admin, authComponent, sessionStore, tokenConcept);
  authEdgeIds.push(addEdge("edge-admin-session", admin, authComponent, "mengelola sesi", "proven", 3, authPath));
  authEdgeIds.push(addEdge("edge-session-storage", authComponent, sessionStore, "membaca sesi", "proven", 9, authPath));
  authEdgeIds.push(addEdge("edge-session-token", authComponent, tokenConcept, "memvalidasi token", "indicated", 12, authPath));
  const crossFeatureEdge = addEdge("edge-booking-auth", bookingService, authComponent, "meminta pemeriksaan sesi", "proven", 56);
  bookEdgeIds.push(crossFeatureEdge);
  authEdgeIds.push(crossFeatureEdge);
  const reverseCrossFeatureEdge = addEdge("edge-auth-booking", authComponent, bookingService, "mengirim hasil sesi", "proven", 57, authPath);
  bookEdgeIds.push(reverseCrossFeatureEdge);
  authEdgeIds.push(reverseCrossFeatureEdge);
  const sharedConcept = addNode("concept-shared-policy", "concept", "Kebijakan peminjaman", null, "proven", 63);
  bookNodeIds.push(sharedConcept);
  authNodeIds.push(sharedConcept);
  const sharedConceptEdge = addEdge("edge-booking-policy", bookingService, sharedConcept, "menerapkan kebijakan", "proven", 63);
  bookEdgeIds.push(sharedConceptEdge);
  authEdgeIds.push(sharedConceptEdge);
  features.push({ id: authFeatureId, label: "Autentikasi", entryNodeIds: [authComponent], nodeIds: authNodeIds, edgeIds: authEdgeIds, evidence: [evidence(authPath, 3)] });

  return {
    analysisId,
    accountKey,
    modelHash: "b".repeat(64),
    revision: 0,
    overlay: { labels: {}, groups: {} },
    model: {
      schemaVersion: "sage-semantic-v1",
      extractorVersion: "qa-controlled-fixture-v1",
      sourceCkgHash: "d".repeat(64),
      snapshot: { repository, branch: "main", commitSha },
      nodes,
      edges,
      features,
      frameworks: ["Next.js App Router"],
      limitations: [{ filePath: bookPath, reason: "Pemanggilan helper dinamis pada fixture tidak membuktikan urutan aktivitas selanjutnya." }],
    },
  };
}

function buildLargeEvidenceFixture(): SemanticPayload {
  const payload = buildFixture();
  const sourceSpans = Array.from({ length: 101 }, (_, index) => evidence(`src/features/source-${String(index + 1).padStart(3, "0")}.ts`, index + 1));
  payload.model.nodes[0]!.evidence = sourceSpans;
  payload.model.edges[0]!.evidence = sourceSpans;
  payload.model.features[0]!.evidence = sourceSpans;
  return payload;
}

function liveGraphFixture(): unknown {
  return {
    analysisId,
    accountKey,
    ckgSha256: "e".repeat(64),
    configurationHash: "f".repeat(64),
    snapshot: { repository, branch: "main", commitSha },
    provenance: {},
    canonicalCounts: { nodes: 1, edges: 0, containmentEdges: 0, referenceEdges: 0, exactEdges: 0, unresolvedEdges: 0 },
    filteredCounts: { nodes: 1, edges: 0 },
    returnedCounts: { nodes: 1, edges: 0 },
    paginated: false,
    limitations: [],
    graph: {
      repository,
      branch: "main",
      commitSha,
      nodes: [{ id: "module-private-fixture", name: "private fixture", label: "private fixture", kind: "Module", category: "Berkas", origin: "repository", qualifiedName: "private fixture", filePath: "src/private.ts", line: 1 }],
      edges: [],
    },
  };
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
  return port;
}

function testRouteSource(): string {
  return `"use client";
import { useCallback, useState } from "react";
import { SemanticWorkspace } from "../../components/semantic-workspace/semantic-workspace.tsx";
export default function SemanticWorkspaceQaPage() {
  const [mode, setMode] = useState<"flow" | "graph">("flow");
  const [revision, setRevision] = useState<number | null>(null);
  const receiveRevision = useCallback((detail: { revision: number; modelHash: string }) => setRevision(detail.revision), []);
  return <main style={{ maxWidth: 1080, margin: "32px auto", padding: "0 16px" }}>
    <p data-testid="fixture-note">QA page: semantic API responses are intercepted; no live worker or database.</p>
    <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
      <button data-testid="mode-flow" type="button" aria-pressed={mode === "flow"} onClick={() => setMode("flow")}>Alur software</button>
      <button data-testid="mode-graph" type="button" aria-pressed={mode === "graph"} onClick={() => setMode("graph")}>Knowledge graph</button>
      <span data-testid="fixture-revision">Revisi fixture: {revision ?? "belum dimuat"}</span>
    </div>
    <SemanticWorkspace key={mode} analysisId="${analysisId}" accountKey="${accountKey}" repository="${repository}" commitSha="${commitSha}" mode={mode} onRevision={receiveRevision} />
  </main>;
}
`;
}

function liveGraphRouteSource(): string {
  return `"use client";
import { LiveGraphClient } from "../../components/live-graph/live-graph-client.tsx";
export default function LiveGraphQaPage() {
  return <main style={{ maxWidth: 1080, margin: "32px auto", padding: "0 16px" }}>
    <p data-testid="fixture-note">QA page: owner-bound graph and semantic responses are intercepted.</p>
    <LiveGraphClient analysisId="${analysisId}" accountKey="${accountKey}" />
  </main>;
}
`;
}

async function startNext(port: number, appRoot: string): Promise<{ child: ChildProcess; output: string[]; initialOutput: string[] }> {
  const nextBin = resolve(projectRoot, "node_modules/next/dist/bin/next");
  const bundlerArgs = process.env.SAGE_SEMANTIC_NEXT_BUNDLER === "turbopack" ? [] : ["--webpack"];
  const child = spawn(process.execPath, [nextBin, "dev", ...bundlerArgs, "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: appRoot,
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output: string[] = [];
  const initialOutput: string[] = [];
  const append = (chunk: Buffer) => {
    const lines = chunk.toString("utf8").split(/\r?\n/u).filter(Boolean);
    if (initialOutput.length < 40) initialOutput.push(...lines.slice(0, 40 - initialOutput.length));
    output.push(...lines);
    if (output.length > 200) output.splice(0, output.length - 200);
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  return { child, output, initialOutput };
}

async function waitForNext(port: number, child: ChildProcess, output: string[], initialOutput: string[]): Promise<void> {
  const deadline = Date.now() + 90_000;
  let lastError = "";
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Next QA server exited with code ${child.exitCode}.\n${initialOutput.join("\n")}\n${output.slice(-20).join("\n")}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/qa-semantic-workspace`);
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) { lastError = error instanceof Error ? error.message : String(error); }
    await new Promise(resolveDelay => setTimeout(resolveDelay, 400));
  }
  throw new Error(`Next QA server did not become ready (${lastError}).\nStartup:\n${initialOutput.join("\n")}\nRecent:\n${output.slice(-20).join("\n")}`);
}

async function stopNext(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.killed) return;
  try {
    if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGTERM");
    else child.kill("SIGTERM");
  } catch { /* The process may have exited between the state check and signal. */ }
  await Promise.race([
    new Promise<void>(resolveExit => child.once("exit", () => resolveExit())),
    new Promise<void>(resolveDelay => setTimeout(resolveDelay, 8_000)),
  ]);
  if (child.exitCode === null) {
    try {
      if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
      else child.kill("SIGKILL");
    } catch { /* Already stopped. */ }
  }
}

async function installBrowserContractsShim(appRoot: string): Promise<void> {
  const contractsShimPath = resolve(appRoot, "qa-contracts-browser.ts");
  const browserSafeValues = { LANGUAGES, NODE_KINDS, EDGE_KINDS, NODE_ORIGINS, EDGE_RESOLUTIONS, UNRESOLVED_REASONS, EVIDENCE_ROLES };
  const shim = Object.entries(browserSafeValues).map(([name, values]) => `export const ${name} = ${JSON.stringify(values)} as const;`).join("\n") + "\n";
  await writeFile(contractsShimPath, shim, { flag: "wx" });
  const configPath = resolve(appRoot, "next.config.ts");
  const originalConfig = await readFile(configPath, "utf8");
  const insertionPoint = "const nextConfig: NextConfig = {";
  assert.ok(originalConfig.includes(insertionPoint), "the QA copy keeps the expected Next config shape before adding its browser-only package alias");
  const browserAlias = JSON.stringify(contractsShimPath);
  const patchedConfig = originalConfig.replace(insertionPoint, `${insertionPoint}\n  webpack(config, { isServer }) {\n    if (!isServer) config.resolve.alias = { ...(config.resolve.alias ?? {}), "@sage/contracts": ${browserAlias} };\n    return config;\n  },`);
  await writeFile(configPath, patchedConfig);
}

async function fulfillJson(route: Route, status: number, body: unknown): Promise<void> {
  await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body), headers: { "Cache-Control": "no-store" } });
}

async function readPerpusCorpus(): Promise<SemanticPayload | null> {
  let raw: Buffer;
  try { raw = await readFile(perpusCorpusPath); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const model = JSON.parse(raw.toString("utf8")) as SemanticModel;
  return {
    analysisId,
    accountKey,
    modelHash: createHash("sha256").update(raw).digest("hex"),
    revision: 0,
    overlay: { labels: {}, groups: {} },
    model,
  };
}

function expectedSourceFlowNodeIds(model: SemanticModel, feature: SemanticFeature, entryId: string): Set<string> {
  const nodeIds = new Set(feature.nodeIds);
  const edgeIds = new Set(feature.edgeIds);
  const nodeById = new Map(model.nodes.map(node => [node.id, node]));
  const edges = model.edges.filter(edge => edgeIds.has(edge.id) && nodeIds.has(edge.source) && nodeIds.has(edge.target));
  const included = new Set([entryId]);
  for (const edge of edges) if (edge.target === entryId && nodeById.get(edge.source)?.kind === "actor") included.add(edge.source);
  const queue = [entryId];
  const outgoing = new Map<string, SemanticEdge[]>();
  for (const edge of edges) outgoing.set(edge.source, [...(outgoing.get(edge.source) ?? []), edge]);
  for (let index = 0; index < queue.length; index += 1) {
    for (const edge of outgoing.get(queue[index]!) ?? []) {
      if (included.has(edge.target)) continue;
      included.add(edge.target);
      if (nodeById.get(edge.target)?.kind !== "actor") queue.push(edge.target);
    }
  }
  return included;
}

async function verifyActualFeatureFlow(page: Page, payload: SemanticPayload, feature: SemanticFeature): Promise<{ entryId: string; scopeIds: Set<string> }> {
  const card = page.locator(`[data-testid="semantic-feature-overview"] [data-feature-id="${feature.id}"]`);
  await card.click();
  await page.getByTestId("semantic-flow-canvas").waitFor();
  const selector = page.getByRole("combobox", { name: "Mulai alur dari" });
  const entryId = await selector.inputValue();
  const nodeById = new Map(payload.model.nodes.map(node => [node.id, node]));
  const entryNode = nodeById.get(entryId);
  assert.ok(entryNode && entryNode.kind === "step", `${feature.label} selects a real action/API step as its flow entry`);
  const featureEdges = new Set(feature.edgeIds);
  const featureNodes = new Set(feature.nodeIds);
  const actorEntry = payload.model.edges.find(edge => featureEdges.has(edge.id) && featureNodes.has(edge.source) && featureNodes.has(edge.target) && edge.target === entryId && nodeById.get(edge.source)?.kind === "actor");
  const actorEntryEdge = actorEntry !== undefined;
  assert.ok(actorEntryEdge || feature.entryNodeIds.includes(entryId), `${feature.label} entry is evidenced by an actor relationship or declared feature entry`);
  const scopeIds = expectedSourceFlowNodeIds(payload.model, feature, entryId);
  const displayedIds = await page.locator("[data-testid='semantic-flow-canvas'] g[data-node-id]").evaluateAll(elements => elements.map(element => element.getAttribute("data-node-id")).filter((value): value is string => value !== null));
  assert.ok(displayedIds.includes(entryId), `${feature.label} entry action appears in the first flow window`);
  assert.ok(displayedIds.length <= 24, "a real feature flow remains bounded to one 24-node window");
  assert.ok(displayedIds.every(id => scopeIds.has(id)), `${feature.label} contains only nodes reachable along stored directed source edges`);
  const renderedEdges = await page.locator("[data-testid='semantic-flow-canvas'] g[data-edge-id]").evaluateAll(elements => elements.map(element => ({
    inlineLabel: element.getAttribute("data-inline-label"),
    sourceKind: element.getAttribute("data-source-kind"),
    targetKind: element.getAttribute("data-target-kind"),
    sourcePortOffset: element.getAttribute("data-source-port-offset"),
    targetPortOffset: element.getAttribute("data-target-port-offset"),
    title: element.querySelector("title")?.textContent ?? "",
    accessibleName: element.getAttribute("aria-label") ?? "",
  })));
  assert.ok(renderedEdges.length > 0 && renderedEdges.every(edge => edge.title.length > 0 && edge.accessibleName.length > 0), `${feature.label} source edges keep an accessible relation label and explanation`);
  if (renderedEdges.length > 5) assert.equal(renderedEdges.filter(edge => edge.inlineLabel === "true").length, 0, `${feature.label} omits all inline labels when the diagram is too dense to keep them collision-free`);
  assert.ok(renderedEdges.filter(edge => edge.sourceKind === "decision").every(edge => edge.sourcePortOffset === "54" || edge.sourcePortOffset === "78"), `${feature.label} uses the actual 54px diamond vertical port (or its 78px side port)`);
  assert.ok(renderedEdges.filter(edge => edge.targetKind === "decision").every(edge => edge.targetPortOffset === "54" || edge.targetPortOffset === "78"), `${feature.label} uses the actual 54px diamond vertical port (or its 78px side port)`);
  if (actorEntry) {
    assert.ok(displayedIds.includes(actorEntry.source), `${feature.label} flow includes its source-backed actor before the entry action`);
    assert.ok(displayedIds.indexOf(actorEntry.source) < displayedIds.indexOf(entryId), `${feature.label} flow lays out the actor before the selected action`);
  }
  if (feature.label === "Books") {
    const visibleDecisions = displayedIds.filter(id => nodeById.get(id)?.kind === "decision");
    assert.ok(visibleDecisions.length > 0, "the default actual Books flow shows a source-backed decision when the selected path contains one");
  }
  await page.getByText(new RegExp(`Jendela ini menampilkan ${displayedIds.length} dari`, "u")).waitFor();
  return { entryId, scopeIds };
}

async function assertNoHorizontalOverflow(page: Page, label: string): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 1, `${label} must not overflow horizontally (measured ${overflow}px)`);
}

async function verifyLargeEvidenceFixture(page: Page, setPayload: (next: SemanticPayload) => void): Promise<void> {
  const largePayload = buildLargeEvidenceFixture();
  setPayload(largePayload);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/qa-semantic-workspace");
  const feature = page.getByTestId("semantic-feature-overview").getByRole("button", { name: /Peminjaman buku/u });
  await feature.getByText(/101 file sumber/u).waitFor();
  assert.equal(largePayload.model.nodes[0]?.evidence.length, 101, "the large evidence fixture uses 101 source spans on one node");
  assert.equal(largePayload.model.edges[0]?.evidence.length, 101, "the large evidence fixture uses 101 source spans on one relation");
  assert.equal(new Set(largePayload.model.features[0]?.evidence.map(item => item.filePath)).size, 101, "the large evidence fixture uses 101 distinct source files for one feature");
  await page.screenshot({ path: resolve(artifactDirectory, "semantic-over-100-source-files.png"), fullPage: true });
}

async function verifyLiveGraphIdentityIsolation(page: Page, livePayload: SemanticPayload, control: { switchSession: boolean; graphUnavailable: boolean; mismatchStarted: (() => void) | null; releaseMismatch: Promise<void> | null }): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/qa-live-graph");
  const featureCircle = page.locator("svg[aria-label='Jaringan cluster fitur, konsep, komponen, dan relasi source'] g[data-feature-id='feature-books']");
  try { await featureCircle.waitFor({ timeout: 10_000 }); }
  catch (error) {
    await page.screenshot({ path: resolve(artifactDirectory, "live-graph-identity-failed.png"), fullPage: true });
    throw new Error(`Live semantic graph did not render: ${await page.locator("body").innerText()}\n${error instanceof Error ? error.message : String(error)}`);
  }
  assert.ok((await featureCircle.getAttribute("aria-label"))?.startsWith(`${privateAccountMarker},`), "the authenticated fixture account label is visible before switching accounts");

  let releaseSwitch!: () => void;
  control.releaseMismatch = new Promise<void>(resolve => { releaseSwitch = resolve; });
  const switchStarted = new Promise<void>(resolve => { control.mismatchStarted = resolve; });
  control.switchSession = true;
  const initialUrl = page.url();
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await switchStarted;
  await featureCircle.waitFor({ state: "detached" });
  assert.equal(await page.url(), initialUrl, "semantic private labels disappear before the delayed account check navigates");
  assert.equal(await page.locator("[aria-label='Knowledge graph fitur dan konsep']").count(), 0, "parent identity recheck unmounts the child semantic state while it is pending");

  const navigation = page.waitForNavigation();
  control.graphUnavailable = true;
  releaseSwitch();
  await navigation;
  control.switchSession = false;
  await page.getByTestId("fixture-note").waitFor();
  const technicalErrorDisclosure = page.locator("summary").filter({ hasText: "Graph teknis belum tersedia" });
  await technicalErrorDisclosure.waitFor();
  const restoredCircle = page.locator("svg[aria-label='Jaringan cluster fitur, konsep, komponen, dan relasi source'] g[data-feature-id='feature-books']");
  await restoredCircle.waitFor();
  assert.ok((await restoredCircle.getAttribute("aria-label"))?.startsWith(`${privateAccountMarker},`), "a verified semantic model remains available when the technical graph endpoint returns 503");
  await technicalErrorDisclosure.click();
  await page.getByText("Graph sementara tidak dapat dibaca.", { exact: true }).waitFor();
  await page.screenshot({ path: resolve(artifactDirectory, "live-graph-semantic-503-fallback.png"), fullPage: true });
}

async function verifyActualPerpusCorpus(page: Page, payload: SemanticPayload, setPayload: (next: SemanticPayload) => void): Promise<void> {
  setPayload(payload);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/qa-semantic-workspace");
  await page.getByRole("heading", { name: "Fitur dan alur pengguna" }).waitFor();
  await waitForFixtureRevision(page, 0);

  for (const featureLabel of ["Auth", "Bookings", "Books"]) {
    const feature = payload.model.features.find(item => item.label === featureLabel);
    assert.ok(feature, `stored Perpus corpus contains ${featureLabel}`);
    const { entryId } = await verifyActualFeatureFlow(page, payload, feature);
    await assertNoHorizontalOverflow(page, `desktop ${featureLabel} flow`);
    if (featureLabel === "Books") {
      const entrySelector = page.getByRole("combobox", { name: "Mulai alur dari" });
      await entrySelector.selectOption("__all_feature_facts__");
      await page.getByText(new RegExp(`Peta semua ${feature.nodeIds.length} fakta fitur`, "u")).waitFor();
      const allFactsIds = await page.locator("[data-testid='semantic-flow-canvas'] g[data-node-id]").evaluateAll(elements => elements.map(element => element.getAttribute("data-node-id")).filter((value): value is string => value !== null));
      assert.ok(allFactsIds.every(id => feature.nodeIds.includes(id)), "the all-facts view remains within its selected feature");
      assert.ok(allFactsIds.length <= 24, "the real all-facts catalog is explicitly windowed");
      await entrySelector.selectOption(entryId);
      await page.locator(`[data-testid='semantic-flow-canvas'] g[data-node-id="${entryId}"]`).waitFor();
      await page.screenshot({ path: resolve(artifactDirectory, "semantic-flow-perpus-books-desktop.png"), fullPage: true });

      await page.locator(`[data-testid='semantic-flow-canvas'] g[data-node-id="${entryId}"]`).click();
      const evidenceHref = await page.locator("[aria-labelledby='semantic-inspector-heading'] a.sageEvidenceLink").first().getAttribute("href");
      assert.ok(evidenceHref?.startsWith(`https://github.com/${payload.model.snapshot.repository}/blob/${payload.model.snapshot.commitSha}/`), "real evidence links target the corpus repository and pinned commit");
      const entryEvidence = payload.model.nodes.find(node => node.id === entryId)?.evidence[0];
      assert.ok(entryEvidence && evidenceHref?.includes(`#L${entryEvidence.startLine}`), "the evidence link keeps the real source line anchor");
    }
    await page.getByRole("button", { name: "Semua fitur" }).click();
  }

  await page.getByTestId("mode-graph").click();
  await page.getByRole("heading", { name: "Fitur dan konsep repository" }).waitFor();
  const booksFeature = payload.model.features.find(item => item.label === "Books")!;
  const graph = page.locator("svg[aria-label='Jaringan cluster fitur, konsep, komponen, dan relasi source']");
  const booksCluster = graph.locator(`g[data-feature-id="${booksFeature.id}"]`);
  await booksCluster.focus();
  await page.keyboard.press("Enter");
  assert.equal(await booksCluster.getAttribute("aria-expanded"), "true", "the actual Books cluster expands by keyboard");
  assert.ok(await graph.locator("g[data-kind='component'], g[data-kind='store'], g[data-kind='concept']").count() > 0, "the real expanded graph exposes principal concept/component/store nodes");
  await assertNoHorizontalOverflow(page, "desktop corpus graph");
  await page.screenshot({ path: resolve(artifactDirectory, "semantic-graph-perpus-books-expanded.png"), fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByTestId("mode-flow").click();
  await page.getByRole("heading", { name: "Fitur dan alur pengguna" }).waitFor();
  const mobileBooks = payload.model.features.find(item => item.label === "Books")!;
  await verifyActualFeatureFlow(page, payload, mobileBooks);
  await assertNoHorizontalOverflow(page, "mobile corpus flow");
  await page.screenshot({ path: resolve(artifactDirectory, "semantic-flow-perpus-books-mobile.png"), fullPage: true });
}

async function waitForFixtureRevision(page: Page, revision: number): Promise<void> {
  await page.waitForFunction(value => document.querySelector("[data-testid='fixture-revision']")?.textContent?.includes(`Revisi fixture: ${value}`) ?? false, revision);
}

async function verifyDesktopFlowAndOverlay(page: Page, getPayload: () => SemanticPayload, setPayload: (next: SemanticPayload) => void, fixtureControl: { conflictNext: boolean; getCount: number; patchCount: number }): Promise<void> {
  await page.goto("/qa-semantic-workspace");
  await page.getByTestId("fixture-note").waitFor();
  await page.getByRole("heading", { name: "Fitur dan alur pengguna" }).waitFor();
  await page.waitForTimeout(500);
  const overview = page.getByTestId("semantic-feature-overview");
  if (await overview.count() === 0) {
    await page.screenshot({ path: resolve(artifactDirectory, "semantic-flow-error.png"), fullPage: true });
    throw new Error(`Semantic flow overview did not render: ${await page.locator("body").innerText()}`);
  }
  assert.equal(await page.locator("[aria-label^='Aktor yang terhubung']").count(), 2, "overview lists each source-backed actor alongside its feature");
  assert.equal(await page.getByText(/Anggota terautentikasi/u).count(), 1);
  await waitForFixtureRevision(page, 0);

  const featureCard = page.getByTestId("semantic-feature-overview").getByRole("button", { name: /Peminjaman buku/u });
  await featureCard.focus();
  await page.keyboard.press("Enter");
  await page.getByTestId("semantic-flow-canvas").waitFor();
  const entrySelector = page.getByRole("combobox", { name: "Mulai alur dari" });
  const selectedEntryId = await entrySelector.inputValue();
  const selectedEntry = getPayload().model.nodes.find(node => node.id === selectedEntryId);
  assert.equal(selectedEntry?.kind, "step", "the default flow starts at a modeled user action or API entry");
  assert.ok(getPayload().model.edges.some(edge => edge.target === selectedEntryId && getPayload().model.nodes.find(node => node.id === edge.source)?.kind === "actor"), "the chosen action has a source-backed incoming actor relationship");
  await page.getByRole("button", { name: "Jendela berikutnya" }).waitFor();
  await page.getByRole("button", { name: "Perbesar diagram alur" }).click();
  await page.getByText("Zoom 110%", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Sesuaikan diagram" }).click();
  const fitLabel = await page.getByRole("group", { name: "Kontrol diagram alur" }).getByText(/Zoom \d+%/u).textContent();
  assert.ok(fitLabel && Number(fitLabel.match(/\d+/u)?.[0]) <= 100, "fit-to-view must return to an at-most-100-percent scale");

  const search = page.getByRole("searchbox", { name: "Cari langkah atau bukti" });
  await search.fill("Cari buku tahap 26");
  await page.getByText(/1 dari \d+ node cocok dengan pencarian\./u).waitFor();
  assert.equal(await page.locator("[data-testid='semantic-flow-canvas'] g[role='button']").count(), 1, "a targeted search narrows the flow without making shortcut edges");
  await search.fill("");
  await entrySelector.selectOption("__all_feature_facts__");
  await page.getByText(/Peta semua \d+ fakta fitur/u).waitFor();
  assert.equal(await page.locator("[data-testid='semantic-flow-canvas'] g[role='button']").count(), 24, "the optional all-facts view keeps its explicit 24-node window");
  await entrySelector.selectOption(selectedEntryId);
  await page.getByRole("button", { name: "Jendela berikutnya" }).click();
  await page.getByText(/Jendela 2 dari/u).waitFor();
  await page.getByRole("button", { name: "Jendela sebelumnya" }).click();
  await page.getByText(/Jendela 1 dari/u).waitFor();

  const indicationToggle = page.getByRole("checkbox", { name: "Tampilkan indikasi" });
  await indicationToggle.uncheck();
  await page.getByText(/node indikasi disembunyikan/u).waitFor();
  await indicationToggle.check();
  const stepEvidenceDisclosure = page.locator("summary").filter({ hasText: /Daftar langkah dan evidence/u });
  await stepEvidenceDisclosure.click();
  await page.getByRole("group", { name: "Navigasi daftar langkah" }).waitFor();
  await page.getByText("1–6 dari 24 langkah", { exact: true }).waitFor();
  assert.equal(await page.locator("[aria-label='Langkah alur dan bukti'] > article").count(), 6, "the alternate accessible flow list is paginated to six entries");
  await page.getByRole("button", { name: "Langkah berikutnya" }).click();
  await page.getByText("7–12 dari 24 langkah", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Langkah sebelumnya" }).click();
  await page.getByRole("link", { name: /api\/books\/route\.ts · baris/u }).first().waitFor();
  await stepEvidenceDisclosure.click();
  await page.locator("summary").filter({ hasText: /Evidence relasi/u }).first().click();
  await page.getByRole("link", { name: /api\/books\/route\.ts · baris/u }).first().waitFor();

  await page.screenshot({ path: resolve(artifactDirectory, "semantic-flow-desktop.png"), fullPage: true });

  await page.getByTestId("mode-graph").click();
  await page.getByRole("heading", { name: "Fitur dan konsep repository" }).waitFor();
  const graphCanvas = page.getByRole("region", { name: /Kanvas cluster knowledge graph/u });
  await graphCanvas.waitFor();
  const firstFeatureCircle = page.locator("svg[aria-label^='Jaringan cluster'] g[aria-expanded]").first();
  await firstFeatureCircle.focus();
  await page.keyboard.press("Enter");
  assert.equal(await firstFeatureCircle.getAttribute("aria-expanded"), "true", "the feature cluster responds to keyboard activation");
  assert.ok(await page.locator("svg g[data-kind='component'], svg g[data-kind='store'], svg g[data-kind='concept']").count() >= 2, "expanding a feature draws principal node circles inside the graph");
  assert.ok(await page.locator("svg path[marker-end]").count() > 0, "the expanded graph draws real source relationships between its node circles");
  assert.ok((await page.locator("svg title").allTextContents()).some(label => label.includes("bukan relasi kode")), "feature membership links are labeled separately from source relationships");
  const crossFeatureCanvas = page.locator("svg[aria-label='Jaringan cluster fitur, konsep, komponen, dan relasi source']");
  assert.equal(await crossFeatureCanvas.locator("g[data-source-id='feature-books'][data-target-id='feature-auth']").count(), 1, "cross-feature relationships retain the books-to-auth direction");
  assert.equal(await crossFeatureCanvas.locator("g[data-source-id='feature-auth'][data-target-id='feature-books']").count(), 1, "the reverse source relationship remains a separate directed edge");
  assert.equal(await crossFeatureCanvas.locator("g[data-inline-label='true']").count(), 0, "opposite cross-feature arrows omit colliding inline labels while keeping accessible titles");
  assert.equal(await crossFeatureCanvas.locator("g[role='img'][aria-label]").count(), 2, "each directed cross-feature edge remains available to assistive technology");
  await page.screenshot({ path: resolve(artifactDirectory, "semantic-graph-expanded-desktop.png"), fullPage: true });
  const bookCard = page.locator("#semantic-cluster-feature-books");
  await bookCard.getByRole("button", { name: "Fokus tetangga", exact: true }).click();
  await page.getByRole("button", { name: "Tampilkan semua fitur" }).waitFor();
  await page.getByRole("button", { name: "Tampilkan semua fitur" }).click();
  await page.getByRole("button", { name: "Perbesar knowledge graph" }).click();
  await page.getByText("Zoom 110%", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Atur ulang graph" }).click();
  await page.getByText("Zoom 100%", { exact: true }).waitFor();
  await page.getByRole("searchbox", { name: "Cari fitur, konsep, atau komponen" }).fill("Sesi OAuth");
  await page.getByText(/^1 dari 2 fitur · \d+ fakta semantik\.$/u).waitFor();
  await page.getByRole("searchbox", { name: "Cari fitur, konsep, atau komponen" }).fill("");
  await bookCard.getByRole("button", { name: /Peminjaman buku/u }).click();
  await page.locator("svg g[data-kind='component']").first().click();
  await page.getByText(/Fokus node:/u).waitFor();
  await page.getByRole("button", { name: "Atur ulang graph" }).click();
  await bookCard.getByRole("button", { name: /Peminjaman buku/u }).click();

  const componentButton = bookCard.locator("button[data-kind='component']").first();
  await componentButton.click();
  await page.getByRole("heading", { name: "BookingService" }).waitFor();
  const labelInput = page.getByRole("textbox", { name: "Nama tampilan" });
  await labelInput.fill("Layanan peminjaman v2");
  await page.getByRole("button", { name: "Simpan koreksi" }).click();
  await page.getByText(/Koreksi disimpan · revisi 1/u).waitFor();
  assert.equal(getPayload().overlay.labels["component-booking"], "Layanan peminjaman v2", "the correction request persists the displayed label to the fixture API");
  await page.getByRole("button", { name: "Kembalikan otomatis" }).click();
  await page.getByText(/Koreksi disimpan · revisi 2/u).waitFor();
  assert.equal(getPayload().overlay.labels["component-booking"], undefined, "reset removes only the label correction");

  const groupSelect = page.getByRole("combobox", { name: "Kelompok fitur" });
  await groupSelect.selectOption("feature-auth");
  await page.getByRole("button", { name: "Simpan koreksi" }).click();
  await page.getByText(/Koreksi disimpan · revisi 3/u).waitFor();
  assert.equal(getPayload().overlay.groups["component-booking"], "feature-auth", "group corrections are persisted as an overlay");
  await page.getByRole("button", { name: "Kembalikan otomatis" }).click();
  await page.getByText(/Koreksi disimpan · revisi 4/u).waitFor();
  assert.equal(getPayload().overlay.groups["component-booking"], undefined, "reset restores the source-derived feature group");

  await bookCard.locator("button[data-kind='concept']").click();
  await page.getByRole("heading", { name: "Kebijakan peminjaman" }).waitFor();
  await page.getByRole("combobox", { name: "Kelompok fitur" }).selectOption("feature-auth");
  await page.getByRole("button", { name: "Simpan koreksi" }).click();
  await page.getByText(/Koreksi disimpan · revisi 5/u).waitFor();
  assert.equal(getPayload().overlay.groups["concept-shared-policy"], "feature-auth", "an unassigned shared concept can be moved into a feature group");
  await page.getByRole("button", { name: "Kembalikan otomatis" }).click();
  await page.getByText(/Koreksi disimpan · revisi 6/u).waitFor();
  assert.equal(getPayload().overlay.groups["concept-shared-policy"], undefined, "reset restores shared feature membership from the model");

  fixtureControl.conflictNext = true;
  await page.getByRole("textbox", { name: "Nama tampilan" }).fill("Conflict test label");
  await page.getByRole("button", { name: "Simpan koreksi" }).click();
  await page.getByText(/Koreksi berubah di sesi lain/u).waitFor();
  assert.equal(getPayload().revision, 6, "a 409 conflict does not overwrite the latest stored revision");
  await page.getByRole("button", { name: "Muat ulang model" }).click();
  await waitForFixtureRevision(page, 6);
  await page.locator("svg[aria-label^='Jaringan cluster']").waitFor();
  assert.ok(fixtureControl.getCount >= 2 && fixtureControl.patchCount >= 7, "the browser exercised GET and PATCH fixture endpoints");
  await page.screenshot({ path: resolve(artifactDirectory, "semantic-graph-desktop.png"), fullPage: true });
  setPayload(getPayload());
}

async function main(): Promise<void> {
  await mkdir(artifactDirectory, { recursive: true });
  const isolatedRoot = await mkdtemp(resolve(tmpdir(), "sage-semantic-workspace-"));
  const appRoot = resolve(isolatedRoot, "apps/web");
  const testPageDirectory = resolve(appRoot, "app/qa-semantic-workspace");
  const testPagePath = resolve(testPageDirectory, "page.tsx");
  const liveGraphPageDirectory = resolve(appRoot, "app/qa-live-graph");
  const liveGraphPagePath = resolve(liveGraphPageDirectory, "page.tsx");
  let child: ChildProcess | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    await mkdir(resolve(isolatedRoot, "apps"), { recursive: true });
    await cp(sourceAppRoot, appRoot, {
      recursive: true,
      filter: source => {
        const path = relative(sourceAppRoot, source);
        return path !== "node_modules" && path !== ".next" && !path.startsWith(".next/");
      },
    });
    await symlink(resolve(projectRoot, "node_modules"), resolve(isolatedRoot, "node_modules"), "dir");
    await symlink(resolve(projectRoot, "packages"), resolve(isolatedRoot, "packages"), "dir");
    await installBrowserContractsShim(appRoot);
    await mkdir(testPageDirectory, { recursive: true });
    await mkdir(liveGraphPageDirectory, { recursive: true });
    await writeFile(testPagePath, testRouteSource(), { flag: "wx" });
    await writeFile(liveGraphPagePath, liveGraphRouteSource(), { flag: "wx" });
    const port = await availablePort();
    const server = await startNext(port, appRoot);
    child = server.child;
    await waitForNext(port, child, server.output, server.initialOutput);

    let payload = buildFixture();
    const actualCorpusPayload = await readPerpusCorpus();
    const fixtureControl = { conflictNext: false, getCount: 0, patchCount: 0 };
    const livePayload = buildFixture();
    livePayload.model.features[0]!.label = privateAccountMarker;
    const liveGraphControl: { switchSession: boolean; graphUnavailable: boolean; mismatchStarted: (() => void) | null; releaseMismatch: Promise<void> | null } = {
      switchSession: false, graphUnavailable: false, mismatchStarted: null, releaseMismatch: null,
    };
    browser = await chromium.launch({ headless: true, args: ["--disable-background-networking", "--disable-default-apps"] });
    const context = await browser.newContext({ baseURL: `http://127.0.0.1:${port}`, viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
    const page = await context.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", error => pageErrors.push(error.message));
    await page.route("**/api/auth/session", async route => {
      assert.equal(route.request().headers()["x-sage-account"], accountKey, "session reads must use the expected owner header");
      if (liveGraphControl.switchSession) {
        liveGraphControl.mismatchStarted?.();
        await liveGraphControl.releaseMismatch;
        liveGraphControl.switchSession = false;
        liveGraphControl.mismatchStarted = null;
        liveGraphControl.releaseMismatch = null;
        await fulfillJson(route, 200, { data: { accountKey: "qa-different-account" } });
        return;
      }
      await fulfillJson(route, 200, { data: { accountKey } });
    });
    await page.route(`**/api/analyses/${analysisId}/graph`, async route => {
      assert.equal(route.request().headers()["x-sage-account"], accountKey, "technical graph reads must use the expected owner header");
      if (liveGraphControl.graphUnavailable) {
        await fulfillJson(route, 503, { error: { code: "GRAPH_UNAVAILABLE", message: "Fixture graph service unavailable." } });
        return;
      }
      await fulfillJson(route, 200, { data: liveGraphFixture() });
    });
    await page.route(`**/api/analyses/${analysisId}/semantic**`, async route => {
      assert.equal(route.request().headers()["x-sage-account"], accountKey, "semantic reads must use the expected owner header");
      if (route.request().frame().url().includes("/qa-live-graph")) {
        assert.equal(route.request().method(), "GET", "the live-graph security fixture only needs a semantic read");
        await fulfillJson(route, 200, { data: livePayload });
        return;
      }
      if (route.request().method() === "GET") {
        fixtureControl.getCount += 1;
        await fulfillJson(route, 200, { data: payload });
        return;
      }
      assert.equal(route.request().method(), "PATCH");
      fixtureControl.patchCount += 1;
      const body = route.request().postDataJSON() as { expectedRevision?: number; overlay?: PresentationOverlay };
      if (fixtureControl.conflictNext) {
        fixtureControl.conflictNext = false;
        await fulfillJson(route, 409, { error: { code: "REVISION_CONFLICT", message: "Fixture overlay revision is stale." } });
        return;
      }
      if (body.expectedRevision !== payload.revision) {
        await fulfillJson(route, 409, { error: { code: "REVISION_CONFLICT", message: "Fixture overlay revision is stale." } });
        return;
      }
      payload = { ...payload, revision: payload.revision + 1, overlay: body.overlay ?? payload.overlay };
      await fulfillJson(route, 200, { data: payload });
    });
    await page.route("https://**/*", route => route.abort());

    const securityOnly = process.env.SAGE_SEMANTIC_UI_SECURITY_ONLY === "1";
    if (!securityOnly) {
      await verifyDesktopFlowAndOverlay(page, () => payload, next => { payload = next; }, fixtureControl);

      await page.setViewportSize({ width: 390, height: 844 });
      await page.getByTestId("mode-flow").click();
      await page.getByRole("heading", { name: "Fitur dan alur pengguna" }).waitFor();
      const mobileCard = page.getByTestId("semantic-feature-overview").getByRole("button", { name: /Peminjaman buku/u });
      await mobileCard.focus();
      await page.keyboard.press("Enter");
      await page.getByTestId("semantic-flow-canvas").waitFor();
      const mobileOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      const overflowElements = mobileOverflow > 1 ? await page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>("body *")).flatMap(element => { const box = element.getBoundingClientRect(); return box.right > window.innerWidth + 1 ? [{ tag: element.tagName, className: typeof element.className === "string" ? element.className : "", right: Math.round(box.right * 10) / 10, width: Math.round(box.width * 10) / 10, text: element.innerText?.slice(0, 80) ?? "" }] : []; }).slice(0, 10)) : [];
      const layoutSizes = mobileOverflow > 1 ? await page.evaluate(() => [document.documentElement, document.body, document.querySelector("main"), document.querySelector("section[aria-label='Alur fitur berbasis source']")].filter((element): element is HTMLElement => element instanceof HTMLElement).map(element => { const box = element.getBoundingClientRect(), style = getComputedStyle(element); return { tag: element.tagName, className: typeof element.className === "string" ? element.className : "", left: box.left, right: box.right, width: box.width, clientWidth: element.clientWidth, boxSizing: style.boxSizing, padding: style.padding, margin: style.margin }; })) : [];
      assert.ok(mobileOverflow <= 1, `mobile page must not overflow horizontally (measured ${mobileOverflow}px; elements=${JSON.stringify(overflowElements)}; layout=${JSON.stringify(layoutSizes)})`);
      await page.screenshot({ path: resolve(artifactDirectory, "semantic-flow-mobile.png"), fullPage: true });
      await verifyLargeEvidenceFixture(page, next => { payload = next; });
    }
    await verifyLiveGraphIdentityIsolation(page, livePayload, liveGraphControl);
    if (actualCorpusPayload && !securityOnly) await verifyActualPerpusCorpus(page, actualCorpusPayload, next => { payload = next; });
    assert.deepEqual(pageErrors, [], "the browser should not emit uncaught client exceptions");
    await context.close();
    process.stdout.write(`Semantic workspace browser fixture passed: GET=${fixtureControl.getCount}, PATCH=${fixtureControl.patchCount}, screenshots=${artifactDirectory}\n`);
    process.stdout.write("Synthetic fixture scope: real Next dev page/component + intercepted deterministic HTTP fixtures; no database, analyzer worker, or real model integration.\n");
    if (actualCorpusPayload) process.stdout.write(`Stored-corpus smoke passed: ${perpusCorpusPath}; ${actualCorpusPayload.model.nodes.length} nodes, ${actualCorpusPayload.model.edges.length} edges, ${actualCorpusPayload.model.features.length} features; snapshot ${actualCorpusPayload.model.snapshot.repository}@${actualCorpusPayload.model.snapshot.commitSha}. This reuses saved analyzer output and does not run a fresh analysis.\n`);
    else process.stdout.write(`Stored-corpus smoke skipped: ${perpusCorpusPath} is missing; set SAGE_SEMANTIC_CORPUS to an available semantic model JSON.\n`);
  } finally {
    if (browser) await browser.close();
    if (child) await stopNext(child);
    await rm(isolatedRoot, { recursive: true, force: true });
  }
}

await main();
