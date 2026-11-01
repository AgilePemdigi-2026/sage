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
const artifactDirectory = resolve(projectRoot, "artifacts/semantic-workspace/connected-overview-20261101");
const accountKey = "qa-semantic-account";
const analysisId = "qa-semantic-analysis";
const repository = "AgilePemdigi-2026/sage";
const commitSha = "a".repeat(40);
const perpusCorpusPath = process.env.SAGE_SEMANTIC_CORPUS ?? resolve(projectRoot, "artifacts/semantic/container-final/sistem-informasi-perpus-semantic.json");
const emosyncCorpusPath = process.env.SAGE_SEMANTIC_EMOSYNC_CORPUS ?? resolve(projectRoot, "artifacts/semantic/readability-20261101/emosync-backend-semantic.json");
const sageCorpusPath = process.env.SAGE_SEMANTIC_SAGE_CORPUS ?? resolve(projectRoot, "artifacts/semantic/readability-20261101/sage-semantic.json");
const perpusMobileCorpusPath = process.env.SAGE_SEMANTIC_PERPUS_MOBILE_CORPUS ?? resolve(projectRoot, "artifacts/semantic/readability-20261101/sistem-informasi-perpus-semantic.json");
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
  // A real search refinement loop exercises cycle condensation in the renderer:
  // users may change a filter and revisit the matching step before continuing.
  bookEdgeIds.push(addEdge("edge-search-refine", "step-search-25", "step-search-19", "memperbarui filter pencarian", "proven", 45));
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

async function openOverviewFeature(page: Page, featureId: string): Promise<void> {
  const card = page.locator(`[data-testid="architecture-node"][data-kind="feature"][data-node-id="${featureId}"]`);
  await card.click();
  await page.getByRole("button", { name: "Open detailed flow" }).click();
  await page.getByTestId("semantic-flow-canvas").waitFor();
}

async function readCorpus(path: string): Promise<SemanticPayload | null> {
  let raw: Buffer;
  try { raw = await readFile(path); }
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
  await openOverviewFeature(page, feature.id);
  if (payload.model.snapshot.repository === "iltizamhasan3/sistem-informasi-perpus") {
    const viewport = await page.evaluate(() => window.innerWidth);
    await page.screenshot({ path: resolve(artifactDirectory, `semantic-flow-perpus-${feature.label.toLowerCase()}-${viewport < 640 ? "mobile" : "desktop"}-initial.png`), fullPage: true });
  }
  const selector = page.getByRole("combobox", { name: "Start flow from" });
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
  assert.ok(displayedIds.includes(entryId), `${feature.label} entry action appears in its flow`);
  if ((await page.evaluate(() => window.innerWidth)) < 640) {
    const primaryCards = await page.locator(`[data-testid='semantic-flow-canvas'] g[data-node-id="${actorEntry?.source ?? entryId}"], [data-testid='semantic-flow-canvas'] g[data-node-id="${entryId}"]`).evaluateAll(elements => elements.map(element => {
      const box = element.getBoundingClientRect();
      const canvas = element.closest("[data-testid='semantic-flow-canvas']")!.getBoundingClientRect();
      return { id: element.getAttribute("data-node-id"), left: box.left, right: box.right, canvasLeft: canvas.left, canvasRight: canvas.right };
    }));
    for (const card of primaryCards) assert.ok(card.left >= card.canvasLeft - 1 && card.right <= card.canvasRight + 1, `mobile primary path card ${card.id} stays fully visible inside its canvas after initial fit`);
  }
  assert.ok(displayedIds.every(id => scopeIds.has(id)), `${feature.label} contains only nodes reachable along stored directed source edges`);
  assert.deepEqual(new Set(displayedIds), scopeIds, `${feature.label} renders every source-reachable flow node without dropping later windows`);
  const renderedEdges = await page.locator("[data-testid='semantic-flow-canvas'] g[data-edge-id]").evaluateAll(elements => elements.map(element => ({
    id: element.getAttribute("data-edge-id"),
    sourceId: element.getAttribute("data-source-id"),
    targetId: element.getAttribute("data-target-id"),
    inlineLabel: element.getAttribute("data-inline-label"),
    sourceKind: element.getAttribute("data-source-kind"),
    targetKind: element.getAttribute("data-target-kind"),
    sourcePortOffset: element.getAttribute("data-source-port-offset"),
    targetPortOffset: element.getAttribute("data-target-port-offset"),
    title: element.querySelector("title")?.textContent ?? "",
    accessibleName: element.getAttribute("aria-label") ?? "",
  })));
  const expectedEdgeIds = payload.model.edges.filter(edge => feature.edgeIds.includes(edge.id) && scopeIds.has(edge.source) && scopeIds.has(edge.target)).map(edge => edge.id);
  assert.deepEqual(new Set(renderedEdges.map(edge => edge.id)), new Set(expectedEdgeIds), `${feature.label} keeps every real relationship whose endpoints are in the selected connected flow`);
  assert.ok(renderedEdges.every(edge => scopeIds.has(edge.sourceId ?? "") && scopeIds.has(edge.targetId ?? "")), `${feature.label} renders no edges with hidden endpoints`);
  const nodeBoxes = await page.locator("[data-testid='semantic-flow-canvas'] g[data-node-id]").evaluateAll(elements => elements.map(element => {
    const box = (element as SVGGElement).getBBox();
    return { id: element.getAttribute("data-node-id"), x: box.x, y: box.y, right: box.x + box.width, bottom: box.y + box.height };
  }));
  for (let leftIndex = 0; leftIndex < nodeBoxes.length; leftIndex += 1) for (let rightIndex = leftIndex + 1; rightIndex < nodeBoxes.length; rightIndex += 1) {
    const left = nodeBoxes[leftIndex]!, right = nodeBoxes[rightIndex]!;
    const overlaps = left.x < right.right && left.right > right.x && left.y < right.bottom && left.bottom > right.y;
    assert.equal(overlaps, false, `${feature.label} places nodes ${left.id} and ${right.id} without overlap`);
  }
  if (nodeById.has("step-search-19") && nodeById.has("step-search-25")) {
    const cycleNodeBoxes = nodeBoxes.filter(box => ["step-search-19", "step-search-25"].includes(box.id ?? ""));
    assert.equal(cycleNodeBoxes.length, 2, `${feature.label} fixture includes the search-refinement cycle endpoints`);
    assert.ok(Math.abs(cycleNodeBoxes[0]!.y - cycleNodeBoxes[1]!.y) < 1, `${feature.label} lays out strongly connected retry steps in the same reading layer`);
  }
  assert.ok(renderedEdges.length > 0 && renderedEdges.every(edge => edge.title.length > 0 && edge.accessibleName.length > 0), `${feature.label} source edges keep an accessible relation label and explanation`);
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
  return { entryId, scopeIds };
}

async function assertNoHorizontalOverflow(page: Page, label: string): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 1, `${label} must not overflow horizontally (measured ${overflow}px)`);
}

async function assertGraphCardLabelsFit(page: Page, label: string): Promise<void> {
  const overflowing = await page.locator("svg[aria-label^='Feature, concept, component'] [data-testid='semantic-feature-card'], svg[aria-label^='Feature, concept, component'] [data-testid='semantic-graph-node']").evaluateAll(cards => cards.flatMap(card => {
    const rect = card.querySelector("rect");
    if (!rect) return [{ id: card.getAttribute("data-node-id") ?? card.getAttribute("data-feature-id"), problem: "missing card frame" }];
    const frame = rect.getBBox();
    return Array.from(card.querySelectorAll("text")).map(text => {
      const bounds = text.getBBox();
      return { id: card.getAttribute("data-node-id") ?? card.getAttribute("data-feature-id"), x: bounds.x, y: bounds.y, right: bounds.x + bounds.width, bottom: bounds.y + bounds.height,
        left: frame.x, top: frame.y, frameRight: frame.x + frame.width, frameBottom: frame.y + frame.height };
    }).filter(bounds => bounds.x < bounds.left - 1 || bounds.y < bounds.top - 1 || bounds.right > bounds.frameRight + 1 || bounds.bottom > bounds.frameBottom + 1)
      .map(bounds => ({ id: bounds.id, problem: JSON.stringify(bounds) }));
  }));
  assert.deepEqual(overflowing, [], `${label} keeps node labels and confidence badges inside their card frames`);
}

async function assertGraphRelationshipPathsUnfilled(page: Page, label: string): Promise<void> {
  const paths = await page.locator("svg[aria-label^='Feature, concept, component'] path[marker-end]").evaluateAll(elements => elements.map(element => ({
    fill: getComputedStyle(element).fill,
    relation: element.closest("g")?.getAttribute("aria-label") ?? element.closest("g")?.getAttribute("class") ?? "source relationship",
    path: element.getAttribute("d"),
  })));
  assert.ok(paths.length > 0, `${label} renders relationship paths with arrowheads`);
  assert.deepEqual(paths.filter(item => item.fill !== "none"), [], `${label} keeps relationship curves unfilled so they cannot paint over the graph`);
}

async function assertIntraFeaturePathsAvoidUnrelatedCards(page: Page, featureId: string, label: string): Promise<void> {
  const result = await page.locator("svg[aria-label^='Feature, concept, component']").evaluate((svg, requestedFeatureId) => {
    const cards = Array.from(svg.querySelectorAll<SVGGElement>("[data-testid='semantic-graph-node']")).flatMap(element => {
      const id = element.getAttribute("data-node-id");
      const rect = element.querySelector("rect");
      if (!id || !rect) return [];
      const bounds = rect.getBBox();
      return [{ id, left: bounds.x, top: bounds.y, right: bounds.x + bounds.width, bottom: bounds.y + bounds.height }];
    });
    const edges = Array.from(svg.querySelectorAll<SVGGElement>("g[data-scope-feature-id][data-edge-id]"))
      .filter(group => group.getAttribute("data-scope-feature-id") === requestedFeatureId);
    const violations: Array<{ edgeId: string | null; sourceId: string | null; targetId: string | null; obstacleId: string; fraction: number; x: number; y: number }> = [];
    for (const edge of edges) {
      const path = edge.querySelector("path[marker-end]") as SVGPathElement | null;
      if (!path) {
        violations.push({ edgeId: edge.getAttribute("data-edge-id"), sourceId: edge.getAttribute("data-source-id"), targetId: edge.getAttribute("data-target-id"), obstacleId: "missing relationship path", fraction: 0, x: 0, y: 0 });
        continue;
      }
      const length = path.getTotalLength();
      if (!Number.isFinite(length) || length <= 0) {
        violations.push({ edgeId: edge.getAttribute("data-edge-id"), sourceId: edge.getAttribute("data-source-id"), targetId: edge.getAttribute("data-target-id"), obstacleId: "empty relationship path", fraction: 0, x: 0, y: 0 });
        continue;
      }
      const sourceId = edge.getAttribute("data-source-id");
      const targetId = edge.getAttribute("data-target-id");
      const samples = Math.max(20, Math.ceil(length / 12));
      for (let index = 1; index < samples; index += 1) {
        const fraction = index / samples;
        const point = path.getPointAtLength(length * fraction);
        const obstacle = cards.find(card => card.id !== sourceId && card.id !== targetId
          && point.x >= card.left && point.x <= card.right && point.y >= card.top && point.y <= card.bottom);
        if (obstacle) {
          violations.push({ edgeId: edge.getAttribute("data-edge-id"), sourceId, targetId, obstacleId: obstacle.id, fraction, x: point.x, y: point.y });
          break;
        }
      }
    }
    return { edgeCount: edges.length, cardCount: cards.length, violations };
  }, featureId);
  assert.ok(result.edgeCount > 0, `${label} renders intra-feature relationship paths for ${featureId}`);
  assert.ok(result.cardCount > 0, `${label} renders card rectangles for intersection checks`);
  assert.deepEqual(result.violations, [], `${label} routes every intra-feature edge clear of unrelated visible node cards`);
}

async function assertGraphFeatureChildVisible(page: Page, feature: SemanticFeature, label: string): Promise<void> {
  const graph = page.locator("svg[aria-label^='Feature, concept, component']");
  const viewport = page.locator("[role='region'][aria-label^='Knowledge graph canvas']");
  const viewportBounds = await viewport.boundingBox();
  assert.ok(viewportBounds, `${label} graph viewport has measurable bounds`);
  const visibleChildIds = await graph.locator("[data-testid='semantic-graph-node']").evaluateAll((elements, ids) => elements.flatMap(element => {
    const id = element.getAttribute("data-node-id");
    if (!id || !ids.includes(id)) return [];
    const bounds = element.getBoundingClientRect();
    return [{ id, left: bounds.left, top: bounds.top, right: bounds.right, bottom: bounds.bottom, width: bounds.width, height: bounds.height }];
  }), feature.nodeIds);
  const readableChildren = visibleChildIds.filter(card => card.left >= viewportBounds!.x - 1 && card.right <= viewportBounds!.x + viewportBounds!.width + 1
    && card.top >= viewportBounds!.y - 1 && card.bottom <= viewportBounds!.y + viewportBounds!.height + 1
    && card.width >= 90 && card.height >= 50);
  assert.ok(readableChildren.length > 0, `${label} shows at least one fully readable ${feature.label} child inside the graph viewport; visible candidate bounds: ${JSON.stringify(visibleChildIds)}`);
}

async function verifyLargeEvidenceFixture(page: Page, setPayload: (next: SemanticPayload) => void): Promise<void> {
  const largePayload = buildLargeEvidenceFixture();
  setPayload(largePayload);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/qa-semantic-workspace");
  await openOverviewFeature(page, "feature-books");
  const actorNode = page.locator("[data-testid='semantic-flow-canvas'] g[data-node-id='actor-member']");
  await actorNode.waitFor();
  await actorNode.click();
  await page.locator("aside[aria-labelledby='semantic-inspector-heading']").waitFor();
  assert.equal(await page.locator("aside[aria-labelledby='semantic-inspector-heading'] a.sageEvidenceLink").count(), 101, "the evidence inspector renders 101 source links without truncating the validated model");
  assert.equal(largePayload.model.nodes[0]?.evidence.length, 101, "the large evidence fixture uses 101 source spans on one node");
  assert.equal(largePayload.model.edges[0]?.evidence.length, 101, "the large evidence fixture uses 101 source spans on one relation");
  assert.equal(new Set(largePayload.model.features[0]?.evidence.map(item => item.filePath)).size, 101, "the large evidence fixture uses 101 distinct source files for one feature");
  await page.screenshot({ path: resolve(artifactDirectory, "semantic-over-100-source-files.png"), fullPage: true });
}

async function verifyLiveGraphIdentityIsolation(page: Page, livePayload: SemanticPayload, control: { switchSession: boolean; graphUnavailable: boolean; mismatchStarted: (() => void) | null; releaseMismatch: Promise<void> | null }): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/qa-live-graph", { waitUntil: "domcontentloaded" });
  await page.locator("summary").filter({ hasText: "Explore individual concepts and components" }).click();
  const featureCircle = page.locator("svg[aria-label^='Feature, concept, component'] g[data-feature-id='feature-books']");
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
  await page.locator("summary").filter({ hasText: "Explore individual concepts and components" }).click();
  const technicalErrorDisclosure = page.locator("summary").filter({ hasText: "Graph teknis belum tersedia" });
  await technicalErrorDisclosure.waitFor();
  const restoredCircle = page.locator("svg[aria-label^='Feature, concept, component'] g[data-feature-id='feature-books']");
  await restoredCircle.waitFor();
  assert.ok((await restoredCircle.getAttribute("aria-label"))?.startsWith(`${privateAccountMarker},`), "a verified semantic model remains available when the technical graph endpoint returns 503");
  await technicalErrorDisclosure.click();
  await page.getByText("Graph sementara tidak dapat dibaca.", { exact: true }).waitFor();
  await page.screenshot({ path: resolve(artifactDirectory, "live-graph-semantic-503-fallback.png"), fullPage: true });
}

async function verifyConnectedArchitecture(page: Page, payload: SemanticPayload, setPayload: (next: SemanticPayload) => void, viewport: { width: number; height: number }, mode: "flow" | "graph"): Promise<void> {
  setPayload(payload);
  await page.setViewportSize(viewport);
  await page.goto("/qa-semantic-workspace");
  if (mode === "graph") await page.getByTestId("mode-graph").click();
  else await page.getByTestId("mode-flow").click();
  await page.getByTestId("architecture-overview").waitFor();
  const root = page.getByTestId("architecture-overview");
  const actors = root.locator("[data-testid='architecture-node'][data-kind='actor']");
  const features = root.locator("[data-testid='architecture-node'][data-kind='feature']");
  const stores = root.locator("[data-testid='architecture-node'][data-kind='store']");
  const edges = root.locator("[data-testid='architecture-edge']");
  assert.equal(await features.count(), payload.model.features.length, `${mode} first render shows every filtered feature without clicking`);
  assert.equal(await actors.count(), 3, `${mode} first render shows all three shared actors`);
  assert.equal(await stores.count(), 8, `${mode} first render shows all eight shared stores`);
  assert.ok(await root.locator("[data-testid='architecture-node'][data-kind='component']").count() >= 1, `${mode} first render shows shared middleware`);
  assert.equal(await edges.count(), 38, `${mode} first render projects connected source-backed relations immediately`);
  const clippedActorLabels = await actors.evaluateAll(elements => {
    const clipped: string[] = [];
    for (const element of elements) {
      const label = element.querySelector("strong");
      if (label && label.scrollHeight > label.clientHeight + 1) clipped.push(label.textContent ?? "(unnamed actor)");
    }
    return clipped;
  });
  assert.deepEqual(clippedActorLabels, [], `${mode} actor labels fit their card height`);

  const edgeRows = await edges.evaluateAll(elements => elements.map(element => ({
    source: element.getAttribute("data-source"), target: element.getAttribute("data-target"),
    confidence: element.getAttribute("data-confidence"), sourceEdgeIds: (element.getAttribute("data-source-edge-ids") ?? "").split(/\s+/u).filter(Boolean),
  })));
  const modelEdges = new Map(payload.model.edges.map(edge => [edge.id, edge]));
  const mapEndpoint = (edgeId: string, nodeId: string): string => {
    const node = payload.model.nodes.find(item => item.id === nodeId)!;
    const memberships = payload.model.features.filter(feature => feature.edgeIds.includes(edgeId) && (node.featureId === feature.id || feature.nodeIds.includes(nodeId)));
    const shared = node.kind === "actor" || node.kind === "store" || node.kind === "concept"
      || (node.kind === "component" && payload.model.features.filter(feature => feature.nodeIds.includes(nodeId)).length > 1);
    if (shared) return nodeId;
    assert.equal(memberships.length, 1, `source endpoint ${nodeId} belongs to one feature scope for ${edgeId}`);
    return memberships[0]!.id;
  };
  assert.ok(edgeRows.every(row => row.sourceEdgeIds.length > 0 && row.sourceEdgeIds.every(id => modelEdges.has(id))), `${mode} every visible line retains one or more real source edge IDs`);
  assert.ok(edgeRows.every(row => row.source !== null && row.target !== null), `${mode} each projected relationship names visible endpoint cards`);
  const displayedSources = new Set(edgeRows.flatMap(row => row.sourceEdgeIds));
  for (const row of edgeRows) for (const id of row.sourceEdgeIds) {
    const source = modelEdges.get(id)!;
    assert.equal(row.source, mapEndpoint(id, source.source), `${mode} source endpoint is the actual source node or its owning feature frame (${id})`);
    assert.equal(row.target, mapEndpoint(id, source.target), `${mode} target endpoint is the actual target node or its owning feature frame (${id})`);
  }
  assert.ok(edgeRows.some(row => row.source === "sem_actor_895313a4beab6c338da0659a" && row.target!.startsWith("sem_feature_") && row.sourceEdgeIds.some(id => modelEdges.get(id)?.source === row.source)), `${mode} visibly connects a real authenticated actor to a feature endpoint`);
  assert.ok(edgeRows.some(row => row.target === "sem_store_99bf1919b8215005bd8b3a28" && row.source!.startsWith("sem_feature_") && row.sourceEdgeIds.some(id => modelEdges.get(id)?.target === row.target)), `${mode} visibly connects a feature to the real check-in store`);
  assert.equal(edgeRows.filter(row => row.source!.startsWith("sem_feature_") && row.target!.startsWith("sem_feature_")).length, 0, `${mode} does not invent feature-to-feature calls from shared stores`);
  assert.ok(displayedSources.size >= 38, `${mode} preserves every raw source edge behind its connected overview arrows`);

  const firstFeature = features.first();
  const firstActor = actors.first();
  const firstEdge = edges.first();
  const visibleInitial = await page.evaluate(() => {
    const viewport = document.querySelector<HTMLElement>("[data-testid='architecture-overview'] [aria-label*='architecture canvas']");
    const box = viewport?.getBoundingClientRect();
    if (!box) return null;
    const featureRects = Array.from(document.querySelectorAll<HTMLElement>("[data-testid='architecture-node'][data-kind='feature']"));
    const actorRects = Array.from(document.querySelectorAll<HTMLElement>("[data-testid='architecture-node'][data-kind='actor']"));
    const edgeRects = Array.from(document.querySelectorAll<HTMLElement>("[data-testid='architecture-edge']"));
    const featureVisible = featureRects.some(element => { const rect = element.getBoundingClientRect(); return rect.width > 0 && rect.height > 0 && rect.left < box.right && rect.right > box.left && rect.top < box.bottom && rect.bottom > box.top; });
    const actorVisible = actorRects.some(element => { const rect = element.getBoundingClientRect(); return rect.width > 0 && rect.height > 0 && rect.left < box.right && rect.right > box.left && rect.top < box.bottom && rect.bottom > box.top; });
    const edgeVisible = edgeRects.some(element => { const rect = element.getBoundingClientRect(); return rect.width > 0 && rect.height > 0 && rect.left < box.right && rect.right > box.left && rect.top < box.bottom && rect.bottom > box.top; });
    return { hasFeature: featureVisible, hasActor: actorVisible, hasEdge: edgeVisible };
  });
  assert.ok(visibleInitial?.hasFeature && visibleInitial.hasActor && visibleInitial.hasEdge, `${mode} at ${viewport.width}px shows a feature, actor, and connecting arrow on initial screen: ${JSON.stringify(visibleInitial)}`);
  const firstScreen = await page.evaluate(() => {
    let feature = false, actor = false, edge = false;
    for (const element of Array.from(document.querySelectorAll("[data-testid='architecture-node'][data-kind='feature']"))) { const rect = element.getBoundingClientRect(); if (rect.width > 0 && rect.height > 0 && rect.left < window.innerWidth && rect.right > 0 && rect.top < window.innerHeight && rect.bottom > 0) feature = true; }
    for (const element of Array.from(document.querySelectorAll("[data-testid='architecture-node'][data-kind='actor']"))) { const rect = element.getBoundingClientRect(); if (rect.width > 0 && rect.height > 0 && rect.left < window.innerWidth && rect.right > 0 && rect.top < window.innerHeight && rect.bottom > 0) actor = true; }
    for (const element of Array.from(document.querySelectorAll("[data-testid='architecture-edge']"))) { const rect = element.getBoundingClientRect(); if (rect.width > 0 && rect.height > 0 && rect.left < window.innerWidth && rect.right > 0 && rect.top < window.innerHeight && rect.bottom > 0) edge = true; }
    return { feature, actor, edge };
  });
  assert.ok(firstScreen.feature && firstScreen.actor && firstScreen.edge, `${mode} at ${viewport.width}px shows a connected architecture path above the browser fold: ${JSON.stringify(firstScreen)}`);
  const cardBounds = await firstFeature.boundingBox();
  assert.ok(cardBounds && cardBounds.width >= (viewport.width < 640 ? 180 : 260) && cardBounds.height >= 80, `${mode} first feature remains readable at ${viewport.width}px`);
  assert.ok(await firstActor.count() > 0 && await firstEdge.count() > 0);

  const geometry = await root.locator("svg[aria-label='Source architecture relationships']").evaluate(svg => {
    const visibleCards = Array.from(document.querySelectorAll<HTMLElement>("[data-testid='architecture-node']")).map(element => {
      const rect = element.getBoundingClientRect();
      return { id: element.getAttribute("data-node-id"), left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
    });
    const paths = Array.from(svg.querySelectorAll<SVGGElement>("[data-testid='architecture-edge']"));
    const errors: string[] = [];
    for (const edge of paths) {
      const path = edge.querySelector<SVGPathElement>("path[marker-end]");
      if (!path) { errors.push("missing line"); continue; }
      const length = path.getTotalLength();
      const samples = Math.max(20, Math.ceil(length / 12));
      for (let i = 1; i < samples; i += 1) {
        const point = path.getPointAtLength(length * i / samples);
        const screen = new DOMPoint(point.x, point.y).matrixTransform(path.getScreenCTM()!);
        const obstacle = visibleCards.find(card => card.id !== edge.getAttribute("data-source") && card.id !== edge.getAttribute("data-target")
          && screen.x > card.left + 2 && screen.x < card.right - 2 && screen.y > card.top + 2 && screen.y < card.bottom - 2);
        if (obstacle) { errors.push(`${edge.getAttribute("data-source")}→${edge.getAttribute("data-target")} enters ${obstacle.id}`); break; }
      }
    }
    return errors;
  });
  assert.deepEqual(geometry, [], `${mode} sampled SVG lines must not pass behind unrelated cards`);
  const headingGeometry = await root.locator("[class*='laneHeading']").evaluateAll(headings => {
    const cards = Array.from(document.querySelectorAll<HTMLElement>("[data-testid='architecture-node']")).map(card => {
      const rect = card.getBoundingClientRect();
      return { id: card.getAttribute("data-node-id"), left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
    });
    const errors: string[] = [];
    for (const heading of Array.from(headings)) {
      const rect = heading.getBoundingClientRect();
      const collision = cards.find(card => rect.left < card.right - 1 && rect.right > card.left + 1 && rect.top < card.bottom - 1 && rect.bottom > card.top + 1);
      if (collision) errors.push(`${heading.textContent?.trim() ?? "lane heading"} overlaps ${collision.id}`);
    }
    return errors;
  });
  assert.deepEqual(headingGeometry, [], `${mode} lane headings remain clear of architecture cards`);
  await page.screenshot({ path: resolve(artifactDirectory, `emosync-architecture-${mode}-${viewport.width}-initial.png`), fullPage: true });
  const labelGeometry = await root.locator("svg[aria-label='Source architecture relationships']").evaluate(svg => {
    const visibleCards = Array.from(document.querySelectorAll<HTMLElement>("[data-testid='architecture-node']")).map(element => {
      const rect = element.getBoundingClientRect();
      return { id: element.getAttribute("data-node-id"), left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
    });
    const labels = Array.from(svg.querySelectorAll<SVGTextElement>("[data-testid='architecture-edge'] text")).filter(label => {
      const style = getComputedStyle(label);
      const rect = label.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    }).map(label => {
      const rect = label.getBoundingClientRect();
      const edge = label.closest<SVGGElement>("[data-testid='architecture-edge']")!;
      return { text: label.textContent ?? "", source: edge.getAttribute("data-source"), target: edge.getAttribute("data-target"), left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
    });
    const errors: string[] = [];
    for (let i = 0; i < labels.length; i += 1) {
      const label = labels[i]!;
      const card = visibleCards.find(item => item.id !== label.source && item.id !== label.target
        && label.left < item.right - 2 && label.right > item.left + 2 && label.top < item.bottom - 2 && label.bottom > item.top + 2);
      if (card) errors.push(`label “${label.text}” is obscured by ${card.id}`);
      for (let j = i + 1; j < labels.length; j += 1) {
        const other = labels[j]!;
        if (label.left < other.right - 2 && label.right > other.left + 2 && label.top < other.bottom - 2 && label.bottom > other.top + 2) {
          errors.push(`labels “${label.text}” and “${other.text}” overlap`);
        }
      }
    }
    return errors;
  });
  assert.deepEqual(labelGeometry, [], `${mode} visible edge labels must avoid cards and one another`);
  if (mode === "flow") {
    await firstFeature.focus();
    await page.keyboard.press("Enter");
    await page.getByRole("button", { name: "Open detailed flow" }).waitFor();
    await page.getByRole("button", { name: "Open detailed flow" }).click();
    await page.getByTestId("semantic-flow-canvas").waitFor();
    await page.getByRole("button", { name: "All features" }).click();
  }
  const indication = root.getByRole("checkbox", { name: "Show indicated relationships" });
  await indication.uncheck();
  const provenCount = await root.locator("[data-testid='architecture-edge'][data-confidence='proven']").count();
  assert.ok(provenCount > 0 && await root.locator("[data-testid='architecture-edge'][data-confidence='indicated']").count() === 0, `${mode} hides indicated source paths while preserving proven paths`);
  await indication.check();
  const zoom = Number((await root.locator("output").textContent())?.replace("%", ""));
  assert.ok(Number.isFinite(zoom), `${mode} exposes its current auto-fit zoom`);
  await root.getByRole("button", { name: "Zoom in architecture" }).click();
  await root.getByText(`${zoom + 10}%`, { exact: true }).waitFor();
  await root.screenshot({ path: resolve(artifactDirectory, `emosync-architecture-${mode}-${viewport.width}.png`) });
}

async function verifyActualEmosyncArchitecture(page: Page, payload: SemanticPayload, setPayload: (next: SemanticPayload) => void): Promise<void> {
  assert.equal(payload.model.snapshot.repository, "iltizamhasan3/emosync-backend");
  await verifyConnectedArchitecture(page, payload, setPayload, { width: 1440, height: 1000 }, "flow");
  await verifyConnectedArchitecture(page, payload, setPayload, { width: 1440, height: 1000 }, "graph");
  await verifyConnectedArchitecture(page, payload, setPayload, { width: 390, height: 844 }, "flow");
  await verifyConnectedArchitecture(page, payload, setPayload, { width: 390, height: 844 }, "graph");
}

async function verifyStoredCorpusMobileOverview(page: Page, payload: SemanticPayload, setPayload: (next: SemanticPayload) => void, name: "perpus" | "sage", mode: "flow" | "graph"): Promise<void> {
  setPayload(payload);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/qa-semantic-workspace");
  await page.getByTestId(mode === "flow" ? "mode-flow" : "mode-graph").click();
  const root = page.getByTestId("architecture-overview");
  await root.waitFor();
  const features = root.locator("[data-testid='architecture-node'][data-kind='feature']");
  const actors = root.locator("[data-testid='architecture-node'][data-kind='actor']");
  const inputs = root.locator("[data-testid='architecture-node'][data-kind='actor'],[data-testid='architecture-node'][data-kind='component']");
  const stores = root.locator("[data-testid='architecture-node'][data-kind='store']");
  const edges = root.locator("[data-testid='architecture-edge']");
  assert.equal(await features.count(), payload.model.features.length, `${name} ${mode} initial mobile overview retains every feature`);
  assert.ok(await inputs.count() > 0, `${name} ${mode} initial mobile overview includes a shared actor or service`);
  const clippedActorLabels = await actors.evaluateAll(elements => {
    const clipped: string[] = [];
    for (const element of elements) {
      const label = element.querySelector("strong");
      if (label && label.scrollHeight > label.clientHeight + 1) clipped.push(label.textContent ?? "(unnamed actor)");
    }
    return clipped;
  });
  assert.deepEqual(clippedActorLabels, [], `${name} ${mode} actor labels fit their mobile cards`);
  const expectedStores = payload.model.nodes.filter(node => node.kind === "store").length;
  assert.equal(await stores.count() > 0, expectedStores > 0, `${name} ${mode} only shows data-store cards when the source model contains data stores`);
  assert.ok(await edges.count() > 0, `${name} ${mode} initial mobile overview has source relationships before any node click`);
  const displayedNodes = await root.locator("[data-testid='architecture-node']").evaluateAll(elements => elements.map(element => ({ id: element.getAttribute("data-node-id"), kind: element.getAttribute("data-kind") })));
  const displayedById = new Map(displayedNodes.map(node => [node.id, node.kind]));
  const modelEdgeIds = new Set(payload.model.edges.map(edge => edge.id));
  const edgeRows = await edges.evaluateAll(elements => elements.map(element => ({
    source: element.getAttribute("data-source"), target: element.getAttribute("data-target"),
    ids: (element.getAttribute("data-source-edge-ids") ?? "").split(/\s+/u).filter(Boolean),
  })));
  assert.ok(edgeRows.every(edge => edge.source && edge.target && displayedById.has(edge.source) && displayedById.has(edge.target)), `${name} ${mode} every drawn relationship terminates at visible source cards`);
  assert.ok(edgeRows.every(edge => edge.ids.length > 0 && edge.ids.every(id => modelEdgeIds.has(id))), `${name} ${mode} drawn relationships carry real source edge IDs`);
  assert.ok(edgeRows.some(edge => [edge.source, edge.target].some(id => displayedById.get(id) === "feature")
    && [edge.source, edge.target].some(id => displayedById.get(id) === "actor" || displayedById.get(id) === "component")), `${name} ${mode} connects at least one real actor/service to a feature frame`);
  const initiallyVisible = await page.evaluate(() => {
    let feature = false, input = false, edge = false;
    for (const element of Array.from(document.querySelectorAll("[data-testid='architecture-node'][data-kind='feature']"))) { const rect = element.getBoundingClientRect(); if (rect.width > 0 && rect.height > 0 && rect.left < window.innerWidth && rect.right > 0 && rect.top < window.innerHeight && rect.bottom > 0) feature = true; }
    for (const element of Array.from(document.querySelectorAll("[data-testid='architecture-node'][data-kind='actor'],[data-testid='architecture-node'][data-kind='component']"))) { const rect = element.getBoundingClientRect(); if (rect.width > 0 && rect.height > 0 && rect.left < window.innerWidth && rect.right > 0 && rect.top < window.innerHeight && rect.bottom > 0) input = true; }
    for (const element of Array.from(document.querySelectorAll("[data-testid='architecture-edge']"))) { const rect = element.getBoundingClientRect(); if (rect.width > 0 && rect.height > 0 && rect.left < window.innerWidth && rect.right > 0 && rect.top < window.innerHeight && rect.bottom > 0) edge = true; }
    return {
      feature,
      input,
      edge,
    };
  });
  assert.ok(initiallyVisible.feature && initiallyVisible.input && initiallyVisible.edge, `${name} ${mode} mobile first viewport shows a feature, actor/service, and relationship without scrolling: ${JSON.stringify(initiallyVisible)}`);
  await page.screenshot({ path: resolve(artifactDirectory, `${name}-architecture-${mode}-390-initial.png`), fullPage: true });
}

async function verifyActualPerpusCorpus(page: Page, payload: SemanticPayload, setPayload: (next: SemanticPayload) => void): Promise<void> {
  setPayload(payload);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/qa-semantic-workspace");
  await page.getByTestId("mode-flow").click();
  await page.getByRole("heading", { name: "User flows" }).waitFor();
  await waitForFixtureRevision(page, 0);

  for (const featureLabel of ["Auth", "Bookings", "Books"]) {
    const feature = payload.model.features.find(item => item.label === featureLabel);
    assert.ok(feature, `stored Perpus corpus contains ${featureLabel}`);
    const { entryId } = await verifyActualFeatureFlow(page, payload, feature);
    await assertNoHorizontalOverflow(page, `desktop ${featureLabel} flow`);
    if (featureLabel === "Books") {
      const entrySelector = page.getByRole("combobox", { name: "Start flow from" });
      await entrySelector.selectOption("__all_feature_facts__");
      assert.equal(await entrySelector.inputValue(), "__all_feature_facts__", "the complete feature overview is selectable on the real corpus");
      const allFactsIds = await page.locator("[data-testid='semantic-flow-canvas'] g[data-node-id]").evaluateAll(elements => elements.map(element => element.getAttribute("data-node-id")).filter((value): value is string => value !== null));
      assert.ok(allFactsIds.every(id => feature.nodeIds.includes(id)), "the all-facts view remains within its selected feature");
      assert.deepEqual(new Set(allFactsIds), new Set(feature.nodeIds), "the all-facts view renders the complete selected feature without artificial pagination");
      const expectedAllFactEdges = payload.model.edges.filter(edge => feature.edgeIds.includes(edge.id) && feature.nodeIds.includes(edge.source) && feature.nodeIds.includes(edge.target)).map(edge => edge.id);
      const displayedAllFactEdges = await page.locator("[data-testid='semantic-flow-canvas'] g[data-edge-id]").evaluateAll(elements => elements.map(element => element.getAttribute("data-edge-id")).filter((value): value is string => value !== null));
      assert.deepEqual(new Set(displayedAllFactEdges), new Set(expectedAllFactEdges), "the all-facts view preserves every stored feature relationship");
      await entrySelector.selectOption(entryId);
      await page.locator(`[data-testid='semantic-flow-canvas'] g[data-node-id="${entryId}"]`).waitFor();
      await page.screenshot({ path: resolve(artifactDirectory, "semantic-flow-perpus-books-desktop.png"), fullPage: true });

      await page.locator(`[data-testid='semantic-flow-canvas'] g[data-node-id="${entryId}"]`).click();
      const evidenceHref = await page.locator("[aria-labelledby='semantic-inspector-heading'] a.sageEvidenceLink").first().getAttribute("href");
      assert.ok(evidenceHref?.startsWith(`https://github.com/${payload.model.snapshot.repository}/blob/${payload.model.snapshot.commitSha}/`), "real evidence links target the corpus repository and pinned commit");
      const entryEvidence = payload.model.nodes.find(node => node.id === entryId)?.evidence[0];
      assert.ok(entryEvidence && evidenceHref?.includes(`#L${entryEvidence.startLine}`), "the evidence link keeps the real source line anchor");
    }
  await page.getByRole("button", { name: "All features" }).click();
  }

  await page.getByTestId("mode-graph").click();
  await page.getByRole("heading", { name: "Repository concepts" }).waitFor();
  await page.locator("summary").filter({ hasText: "Explore individual concepts and components" }).click();
  const booksFeature = payload.model.features.find(item => item.label === "Books")!;
  const graph = page.locator("svg[aria-label^='Feature, concept, component']");
  const booksCluster = graph.locator(`g[data-feature-id="${booksFeature.id}"]`);
  await booksCluster.focus();
  await page.keyboard.press("Enter");
  assert.equal(await booksCluster.getAttribute("aria-expanded"), "true", "the actual Books cluster expands by keyboard");
  await page.screenshot({ path: resolve(artifactDirectory, "semantic-graph-perpus-books-expanded-initial.png"), fullPage: true });
  await assertGraphFeatureChildVisible(page, booksFeature, "desktop corpus graph");
  await assertIntraFeaturePathsAvoidUnrelatedCards(page, booksFeature.id, "desktop Perpus Books graph");
  assert.ok(await graph.locator("g[data-kind='component'], g[data-kind='store'], g[data-kind='concept']").count() > 0, "the real expanded graph exposes principal concept/component/store nodes");
  await assertGraphRelationshipPathsUnfilled(page, "desktop corpus graph");
  await assertNoHorizontalOverflow(page, "desktop corpus graph");
  await assertGraphCardLabelsFit(page, "desktop corpus graph");
  await page.screenshot({ path: resolve(artifactDirectory, "semantic-graph-perpus-books-expanded.png"), fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByTestId("mode-flow").click();
  await page.getByRole("heading", { name: "User flows" }).waitFor();
  const mobileBooks = payload.model.features.find(item => item.label === "Books")!;
  await verifyActualFeatureFlow(page, payload, mobileBooks);
  await assertNoHorizontalOverflow(page, "mobile corpus flow");
  await page.screenshot({ path: resolve(artifactDirectory, "semantic-flow-perpus-books-mobile.png"), fullPage: true });

  await page.getByTestId("mode-graph").click();
  await page.getByRole("heading", { name: "Repository concepts" }).waitFor();
  await page.locator("summary").filter({ hasText: "Explore individual concepts and components" }).click();
  const mobileBooksCluster = page.locator(`svg[aria-label^='Feature, concept, component'] [data-testid='semantic-feature-card'][data-feature-id="${mobileBooks.id}"]`);
  await mobileBooksCluster.focus();
  await page.keyboard.press("Enter");
  assert.ok(await page.locator("svg [data-testid='semantic-graph-node']").count() > 0, "mobile knowledge graph reveals source-backed cards by keyboard");
  await page.screenshot({ path: resolve(artifactDirectory, "semantic-graph-perpus-books-mobile.png"), fullPage: true });
  await assertGraphFeatureChildVisible(page, mobileBooks, "mobile corpus graph");
  await assertIntraFeaturePathsAvoidUnrelatedCards(page, mobileBooks.id, "mobile Perpus Books graph");
  await assertGraphRelationshipPathsUnfilled(page, "mobile corpus graph");
  await assertGraphCardLabelsFit(page, "mobile corpus graph");
  await assertNoHorizontalOverflow(page, "mobile corpus graph");
}

async function waitForFixtureRevision(page: Page, revision: number): Promise<void> {
  await page.waitForFunction(value => document.querySelector("[data-testid='fixture-revision']")?.textContent?.includes(`Revisi fixture: ${value}`) ?? false, revision);
}

async function verifyDesktopFlowAndOverlay(page: Page, getPayload: () => SemanticPayload, setPayload: (next: SemanticPayload) => void, fixtureControl: { conflictNext: boolean; getCount: number; patchCount: number }): Promise<void> {
  await page.goto("/qa-semantic-workspace");
  await page.getByTestId("fixture-note").waitFor();
  await page.getByRole("heading", { name: "User flows" }).waitFor();
  await page.waitForTimeout(500);
  const overview = page.getByTestId("architecture-overview");
  if (await overview.count() === 0) {
    await page.screenshot({ path: resolve(artifactDirectory, "semantic-flow-error.png"), fullPage: true });
    throw new Error(`Semantic flow overview did not render: ${await page.locator("body").innerText()}`);
  }
  assert.ok(await page.locator("[data-testid='architecture-node'][data-kind='actor']").count() >= 2, "the initial architecture shows shared source-backed actors");
  assert.ok(await page.locator("[data-testid='architecture-edge']").count() > 0, "the initial architecture shows source-backed connections before interaction");
  await waitForFixtureRevision(page, 0);

  const featureCard = page.locator("[data-testid='architecture-node'][data-kind='feature'][data-node-id='feature-books']");
  await featureCard.focus();
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Open detailed flow" }).click();
  await page.getByTestId("semantic-flow-canvas").waitFor();
  const entrySelector = page.getByRole("combobox", { name: "Start flow from" });
  const selectedEntryId = await entrySelector.inputValue();
  const selectedEntry = getPayload().model.nodes.find(node => node.id === selectedEntryId);
  assert.equal(selectedEntry?.kind, "step", "the default flow starts at a modeled user action or API entry");
  assert.ok(getPayload().model.edges.some(edge => edge.target === selectedEntryId && getPayload().model.nodes.find(node => node.id === edge.source)?.kind === "actor"), "the chosen action has a source-backed incoming actor relationship");
  const automaticZoom = await page.getByRole("group", { name: "User flow diagram controls" }).getByText(/Zoom \d+%/u).textContent();
  assert.ok(automaticZoom && Number(automaticZoom.match(/\d+/u)?.[0]) >= 30 && Number(automaticZoom.match(/\d+/u)?.[0]) <= 100, "newly selected flows automatically fit the canvas at a readable scale");
  const automaticPercent = Number(automaticZoom!.match(/\d+/u)?.[0]);
  await page.getByRole("button", { name: "Zoom in user flow" }).click();
  await page.getByText(`Zoom ${Math.min(150, automaticPercent + 10)}%`, { exact: true }).waitFor();
  await page.getByRole("button", { name: "Fit diagram" }).click();
  const fitLabel = await page.getByRole("group", { name: "User flow diagram controls" }).getByText(/Zoom \d+%/u).textContent();
  assert.ok(fitLabel && Number(fitLabel.match(/\d+/u)?.[0]) >= 30 && Number(fitLabel.match(/\d+/u)?.[0]) <= 100, "fit-to-view keeps the whole selected flow within the supported scale");

  const search = page.getByRole("searchbox", { name: "Search steps or evidence" });
  await search.fill("Cari buku tahap 26");
  await page.getByText(/1 of \d+ nodes match\./u).waitFor();
  assert.equal(await page.locator("[data-testid='semantic-flow-canvas'] g[role='button']").count(), 1, "a targeted search narrows the flow without making shortcut edges");
  await search.fill("");
  await entrySelector.selectOption("__all_feature_facts__");
  assert.equal(await entrySelector.inputValue(), "__all_feature_facts__", "the all-feature overview can be selected from the flow entry control");
  const allFactNodeCount = await page.locator("[data-testid='semantic-flow-canvas'] g[data-node-id]").count();
  assert.equal(allFactNodeCount, getPayload().model.features.find(feature => feature.id === selectedEntry?.featureId)?.nodeIds.length, "the all-facts view exposes the whole feature graph without page windows");
  await entrySelector.selectOption(selectedEntryId);

  const indicationToggle = page.getByRole("checkbox", { name: "Show indicated relationships" });
  await indicationToggle.uncheck();
  await page.getByText(/indicated nodes are hidden/u).waitFor();
  await indicationToggle.check();
  const stepEvidenceDisclosure = page.locator("summary").filter({ hasText: /Flow nodes and evidence/u });
  await stepEvidenceDisclosure.click();
  await page.getByRole("group", { name: "Flow step navigation" }).waitFor();
  const firstListPage = await page.getByRole("group", { name: "Flow step navigation" }).innerText();
  assert.match(firstListPage, /^Previous\s+1–6 of \d+ items\s+Next$/u);
  assert.equal(await page.locator("[aria-label='Flow nodes and evidence'] > article").count(), 6, "the alternate accessible source list is paginated to six entries");
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await page.getByText(/7–12 of \d+ items/u).waitFor();
  await page.getByRole("button", { name: "Previous", exact: true }).click();
  await page.getByRole("link", { name: /api\/books\/route\.ts · baris/u }).first().waitFor();
  await stepEvidenceDisclosure.click();
  await page.locator("summary").filter({ hasText: /Relationship evidence/u }).first().click();
  await page.getByRole("link", { name: /api\/books\/route\.ts · baris/u }).first().waitFor();

  await page.screenshot({ path: resolve(artifactDirectory, "semantic-flow-desktop.png"), fullPage: true });

  await page.getByRole("button", { name: "All features" }).click();
  await page.getByTestId("mode-graph").click();
  await page.getByRole("heading", { name: "Repository concepts" }).waitFor();
  await page.locator("summary").filter({ hasText: "Explore individual concepts and components" }).click();
  const graphCanvas = page.getByRole("region", { name: /Knowledge graph canvas/u });
  await graphCanvas.waitFor();
  const firstFeatureCard = page.locator("svg[aria-label^='Feature, concept, component'] [data-testid='semantic-feature-card']").first();
  await firstFeatureCard.focus();
  await page.keyboard.press("Enter");
  assert.equal(await firstFeatureCard.getAttribute("aria-expanded"), "true", "the feature group responds to keyboard activation");
  assert.ok(await page.locator("svg [data-testid='semantic-graph-node'][data-kind='component'], svg [data-testid='semantic-graph-node'][data-kind='store'], svg [data-testid='semantic-graph-node'][data-kind='concept']").count() >= 2, "expanding a feature reveals its principal source-backed cards");
  const graphCardGeometry = await page.locator("svg[aria-label^='Feature, concept, component']").evaluate(svg => {
    const featureCards = Array.from(svg.querySelectorAll<SVGGElement>("[data-testid='semantic-feature-card']")).map(element => {
      const box = element.getBBox();
      const rect = element.querySelector("rect");
      return { id: element.getAttribute("data-node-id") ?? element.getAttribute("data-feature-id"), x: box.x, y: box.y, right: box.x + box.width, bottom: box.y + box.height,
        card: rect ? { left: Number(rect.getAttribute("x")), top: Number(rect.getAttribute("y")), right: Number(rect.getAttribute("x")) + Number(rect.getAttribute("width")), bottom: Number(rect.getAttribute("y")) + Number(rect.getAttribute("height")) } : null,
        labels: Array.from(element.querySelectorAll("text")).map(label => { const bounds = label.getBBox(); return { x: bounds.x, y: bounds.y, right: bounds.x + bounds.width, bottom: bounds.y + bounds.height }; }) };
    });
    const nodeCards = Array.from(svg.querySelectorAll<SVGGElement>("[data-testid='semantic-graph-node']")).map(element => {
      const box = element.getBBox();
      const rect = element.querySelector("rect");
      return { id: element.getAttribute("data-node-id"), x: box.x, y: box.y, right: box.x + box.width, bottom: box.y + box.height,
        card: rect ? { left: Number(rect.getAttribute("x")), top: Number(rect.getAttribute("y")), right: Number(rect.getAttribute("x")) + Number(rect.getAttribute("width")), bottom: Number(rect.getAttribute("y")) + Number(rect.getAttribute("height")) } : null,
        labels: Array.from(element.querySelectorAll("text")).map(label => { const bounds = label.getBBox(); return { x: bounds.x, y: bounds.y, right: bounds.x + bounds.width, bottom: bounds.y + bounds.height }; }) };
    });
    const cards = [...featureCards, ...nodeCards].flatMap(item => item.card ? [item.card] : []);
    const edges = Array.from(svg.querySelectorAll<SVGPathElement>("path[marker-end]")).map(path => {
      const length = path.getTotalLength();
      const start = path.getPointAtLength(0);
      const end = path.getPointAtLength(length);
      return { start: { x: start.x, y: start.y }, end: { x: end.x, y: end.y } };
    });
    return { featureCards, nodeCards, cards, edges };
  });
  assert.ok(graphCardGeometry.nodeCards.length >= 2, "expanded features render multiple rectangular graph nodes");
  for (const card of [...graphCardGeometry.featureCards, ...graphCardGeometry.nodeCards]) {
    assert.ok(card.card && card.labels.every(label => label.x >= card.card!.left - 1 && label.y >= card.card!.top - 1 && label.right <= card.card!.right + 1 && label.bottom <= card.card!.bottom + 1), `all text remains inside graph card ${card.id}`);
  }
  for (const cards of [graphCardGeometry.featureCards, graphCardGeometry.nodeCards]) for (let left = 0; left < cards.length; left += 1) for (let right = left + 1; right < cards.length; right += 1) {
    const a = cards[left]!, b = cards[right]!;
    assert.ok(!(a.x < b.right && a.right > b.x && a.y < b.bottom && a.bottom > b.y), `knowledge graph cards ${a.id} and ${b.id} do not overlap`);
  }
  const pointOnRectBoundary = (point: { x: number; y: number }) => graphCardGeometry.cards.some(card => {
    const withinX = point.x >= card.left - 1 && point.x <= card.right + 1;
    const withinY = point.y >= card.top - 1 && point.y <= card.bottom + 1;
    return (withinX && (Math.abs(point.y - card.top) <= 1 || Math.abs(point.y - card.bottom) <= 1)) ||
      (withinY && (Math.abs(point.x - card.left) <= 1 || Math.abs(point.x - card.right) <= 1));
  });
  assert.ok(graphCardGeometry.edges.length > 0 && graphCardGeometry.edges.every(edge => pointOnRectBoundary(edge.start) && pointOnRectBoundary(edge.end)), "source arrows meet card boundaries instead of disappearing under card fills");
  assert.ok(await page.locator("svg path[marker-end]").count() > 0, "the expanded graph draws source relationships between its feature and concept cards");
  await assertGraphRelationshipPathsUnfilled(page, "synthetic expanded graph");
  assert.match(await page.locator("[aria-label='Knowledge graph legend']").innerText(), /Feature frames group related responsibilities/u, "feature grouping is explained separately from source relationships");
  const crossFeatureCanvas = page.locator("svg[aria-label^='Feature, concept, component']");
  assert.equal(await crossFeatureCanvas.locator("g[data-source-id='feature-books'][data-target-id='feature-auth']").count(), 1, "cross-feature relationships retain the books-to-auth direction");
  assert.equal(await crossFeatureCanvas.locator("g[data-source-id='feature-auth'][data-target-id='feature-books']").count(), 1, "the reverse source relationship remains a separate directed edge");
  assert.equal(await crossFeatureCanvas.locator("g[data-inline-label='true']").count(), 0, "opposite cross-feature arrows omit colliding inline labels while keeping accessible titles");
  assert.equal(await crossFeatureCanvas.locator("g[role='img'][aria-label]").count(), 2, "each directed cross-feature edge remains available to assistive technology");
  await page.screenshot({ path: resolve(artifactDirectory, "semantic-graph-expanded-desktop.png"), fullPage: true });
  await page.locator("details[data-testid='semantic-feature-browser'] > summary").click();
  const bookCard = page.locator("#semantic-cluster-feature-books");
  await bookCard.getByRole("button", { name: "Focus neighbors", exact: true }).click();
  await page.getByRole("button", { name: "Show all features and nodes" }).waitFor();
  await page.getByRole("button", { name: "Show all features and nodes" }).click();
  const graphZoomBefore = await page.getByRole("group", { name: "Knowledge graph controls" }).getByText(/Zoom \d+%/u).textContent();
  const graphPercentBefore = Number(graphZoomBefore?.match(/\d+/u)?.[0]);
  await page.getByRole("button", { name: "Zoom in knowledge graph" }).click();
  await page.getByText(`Zoom ${Math.min(150, graphPercentBefore + 10)}%`, { exact: true }).waitFor();
  await page.getByRole("button", { name: "Reset graph" }).click();
  const resetZoom = await page.getByRole("group", { name: "Knowledge graph controls" }).getByText(/Zoom \d+%/u).textContent();
  assert.ok(resetZoom && Number(resetZoom.match(/\d+/u)?.[0]) >= 30 && Number(resetZoom.match(/\d+/u)?.[0]) <= 100, "reset restores a fitted knowledge graph view");
  await page.getByRole("searchbox", { name: "Search features, concepts, or components" }).fill("Sesi OAuth");
  await page.getByText(/^1 of 2 features · \d+ semantic nodes\.$/u).waitFor();
  await page.getByRole("searchbox", { name: "Search features, concepts, or components" }).fill("");
  await bookCard.getByRole("button", { name: /Peminjaman buku/u }).click();
  await assertIntraFeaturePathsAvoidUnrelatedCards(page, "feature-books", "synthetic Books graph");
  await page.locator("svg g[data-kind='component']").first().click();
  await page.getByText(/Focused node:/u).waitFor();
  await page.getByRole("button", { name: "Reset graph" }).click();
  await bookCard.getByRole("button", { name: /Peminjaman buku/u }).click();

  const componentButton = bookCard.locator("button[data-kind='component']").first();
  await componentButton.click();
  await page.getByRole("heading", { name: "BookingService" }).waitFor();
  const labelInput = page.getByRole("textbox", { name: "Display name" });
  await labelInput.fill("Layanan peminjaman v2");
  await page.getByRole("button", { name: "Save changes" }).click();
  await page.getByText(/Koreksi disimpan · revisi 1/u).waitFor();
  assert.equal(getPayload().overlay.labels["component-booking"], "Layanan peminjaman v2", "the correction request persists the displayed label to the fixture API");
  await page.getByRole("button", { name: "Restore automatic" }).click();
  await page.getByText(/Koreksi disimpan · revisi 2/u).waitFor();
  assert.equal(getPayload().overlay.labels["component-booking"], undefined, "reset removes only the label correction");

  const groupSelect = page.getByRole("combobox", { name: "Feature group" });
  await groupSelect.selectOption("feature-auth");
  await page.getByRole("button", { name: "Save changes" }).click();
  await page.getByText(/Koreksi disimpan · revisi 3/u).waitFor();
  assert.equal(getPayload().overlay.groups["component-booking"], "feature-auth", "group corrections are persisted as an overlay");
  await page.getByRole("button", { name: "Restore automatic" }).click();
  await page.getByText(/Koreksi disimpan · revisi 4/u).waitFor();
  assert.equal(getPayload().overlay.groups["component-booking"], undefined, "reset restores the source-derived feature group");

  await bookCard.locator("button[data-kind='concept']").click();
  await page.getByRole("heading", { name: "Kebijakan peminjaman" }).waitFor();
  await page.getByRole("combobox", { name: "Feature group" }).selectOption("feature-auth");
  await page.getByRole("button", { name: "Save changes" }).click();
  await page.getByText(/Koreksi disimpan · revisi 5/u).waitFor();
  assert.equal(getPayload().overlay.groups["concept-shared-policy"], "feature-auth", "an unassigned shared concept can be moved into a feature group");
  await page.getByRole("button", { name: "Restore automatic" }).click();
  await page.getByText(/Koreksi disimpan · revisi 6/u).waitFor();
  assert.equal(getPayload().overlay.groups["concept-shared-policy"], undefined, "reset restores shared feature membership from the model");

  fixtureControl.conflictNext = true;
  await page.getByRole("textbox", { name: "Display name" }).fill("Conflict test label");
  await page.getByRole("button", { name: "Save changes" }).click();
  await page.getByText(/Koreksi berubah di sesi lain/u).waitFor();
  assert.equal(getPayload().revision, 6, "a 409 conflict does not overwrite the latest stored revision");
  await page.getByRole("button", { name: "Reload model" }).click();
  await waitForFixtureRevision(page, 6);
  await page.locator("summary").filter({ hasText: "Explore individual concepts and components" }).click();
  await page.locator("svg[aria-label^='Feature, concept, component']").waitFor();
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
    const actualCorpusPayload = await readCorpus(perpusCorpusPath);
    const actualEmosyncPayload = await readCorpus(emosyncCorpusPath);
    const actualSagePayload = await readCorpus(sageCorpusPath);
    const actualPerpusMobilePayload = await readCorpus(perpusMobileCorpusPath);
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
      if (actualEmosyncPayload) await verifyActualEmosyncArchitecture(page, actualEmosyncPayload, next => { payload = next; });
      if (actualPerpusMobilePayload) {
        await verifyStoredCorpusMobileOverview(page, actualPerpusMobilePayload, next => { payload = next; }, "perpus", "flow");
        await verifyStoredCorpusMobileOverview(page, actualPerpusMobilePayload, next => { payload = next; }, "perpus", "graph");
      }
      if (actualSagePayload) {
        await verifyStoredCorpusMobileOverview(page, actualSagePayload, next => { payload = next; }, "sage", "flow");
        await verifyStoredCorpusMobileOverview(page, actualSagePayload, next => { payload = next; }, "sage", "graph");
      }
      payload = buildFixture();
      await verifyDesktopFlowAndOverlay(page, () => payload, next => { payload = next; }, fixtureControl);

      await page.setViewportSize({ width: 390, height: 844 });
      await page.getByTestId("mode-flow").click();
      await page.getByRole("heading", { name: "User flows" }).waitFor();
      await openOverviewFeature(page, "feature-books");
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
    if (actualEmosyncPayload) process.stdout.write(`Stored Emosync architecture smoke passed: ${emosyncCorpusPath}; ${actualEmosyncPayload.model.nodes.length} nodes, ${actualEmosyncPayload.model.edges.length} edges, ${actualEmosyncPayload.model.features.length} features; connected overview checks ran before interaction on desktop/mobile. This reuses saved analyzer output and does not run a fresh analysis.\n`);
    else process.stdout.write(`Stored Emosync architecture smoke skipped: ${emosyncCorpusPath} is missing.\n`);
    if (actualPerpusMobilePayload) process.stdout.write(`Stored Perpus initial mobile overview passed: ${perpusMobileCorpusPath}; flow and graph modes were checked without selecting a feature.\n`);
    else process.stdout.write(`Stored Perpus initial mobile overview skipped: ${perpusMobileCorpusPath} is missing.\n`);
    if (actualSagePayload) process.stdout.write(`Stored SAGE initial mobile overview passed: ${sageCorpusPath}; flow and graph modes were checked without selecting a feature.\n`);
    else process.stdout.write(`Stored SAGE initial mobile overview skipped: ${sageCorpusPath} is missing.\n`);
    if (actualCorpusPayload) process.stdout.write(`Stored-corpus smoke passed: ${perpusCorpusPath}; ${actualCorpusPayload.model.nodes.length} nodes, ${actualCorpusPayload.model.edges.length} edges, ${actualCorpusPayload.model.features.length} features; snapshot ${actualCorpusPayload.model.snapshot.repository}@${actualCorpusPayload.model.snapshot.commitSha}. This reuses saved analyzer output and does not run a fresh analysis.\n`);
    else process.stdout.write(`Stored-corpus smoke skipped: ${perpusCorpusPath} is missing; set SAGE_SEMANTIC_CORPUS to an available semantic model JSON.\n`);
  } finally {
    if (browser) await browser.close();
    if (child) await stopNext(child);
    await rm(isolatedRoot, { recursive: true, force: true });
  }
}

await main();
