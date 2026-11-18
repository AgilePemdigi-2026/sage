import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { chromium, type Route } from "playwright";
import type { CcmV1 } from "@sage/contracts";
import { buildAddBaseline } from "../packages/documents/src/baseline-add.ts";
import { emptyAddReviewOverlay } from "../packages/documents/src/add-overlay.ts";
import type { SemanticEdge, SemanticFeature, SemanticModel, SemanticNode } from "../packages/documents/src/semantic/model.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const appRootSource = resolve(projectRoot, "apps/web");
const reportDirectory = resolve(process.env.SAGE_ADD_UI_REPORT_DIR ?? resolve(projectRoot, "artifacts/add-workspace/20261119"));
const analysisId = "qa-add-analysis-01";
const accountKey = "qa-add-account";
const sourceCkgHash = "c".repeat(64);
const addModelHash = "e".repeat(64);
const commitSha = "b".repeat(40);
const fixturePath = "src/app/api/books/route.ts";
const fixtureEvidence = {
  filePath: fixturePath, fileSha256: "a".repeat(64), startByte: 0, endByte: 14,
  startLine: 1, endLine: 1, startColumn: 1, endColumn: 15, role: "declaration" as const,
};

function fixtureModel() {
  const nodes: SemanticNode[] = [
    { id: "actor:member", kind: "actor", label: "Authenticated member", featureId: null, confidence: "proven", reason: "Actor in test fixture.", evidence: [fixtureEvidence], technicalNodeIds: [] },
    { id: "feature:catalog", kind: "feature", label: "Book catalog", featureId: "feature:catalog", confidence: "proven", reason: "Feature in test fixture.", evidence: [fixtureEvidence], technicalNodeIds: [] },
    { id: "route:books", kind: "step", label: "GET /api/books", featureId: "feature:catalog", confidence: "proven", reason: "Literal route declaration.", evidence: [fixtureEvidence], technicalNodeIds: [] },
    { id: "component:list-books", kind: "component", label: "listBooks", featureId: "feature:catalog", confidence: "proven", reason: "Handler in test fixture.", evidence: [fixtureEvidence], technicalNodeIds: [] },
    { id: "store:book", kind: "store", label: "Book", featureId: "feature:catalog", confidence: "proven", reason: "Data access in test fixture.", evidence: [fixtureEvidence], technicalNodeIds: [] },
    { id: "store:author", kind: "store", label: "Author", featureId: "feature:catalog", confidence: "proven", reason: "Data access in test fixture.", evidence: [fixtureEvidence], technicalNodeIds: [] },
  ];
  const edges: SemanticEdge[] = [
    { id: "edge:feature-route", source: "feature:catalog", target: "route:books", label: "has entry point", confidence: "proven", reason: "Feature and route are directly linked.", evidence: [fixtureEvidence] },
    { id: "edge:route-handler", source: "route:books", target: "component:list-books", label: "invokes handler", confidence: "proven", reason: "Route points to its handler.", evidence: [fixtureEvidence] },
    { id: "edge:handler-data", source: "component:list-books", target: "store:book", label: "reads records", confidence: "proven", reason: "Handler reads the data object.", evidence: [fixtureEvidence] },
    { id: "edge:book-author", source: "store:book", target: "store:author", label: "references data object", confidence: "proven", reason: "An explicit schema reference links books to authors.", evidence: [fixtureEvidence] },
    { id: "edge:actor-route", source: "actor:member", target: "route:books", label: "requests", confidence: "proven", reason: "Actor uses the declared route.", evidence: [fixtureEvidence] },
  ];
  const snapshot = { repository: "sample/library", branch: "main", commitSha };
  const ccm = { schemaVersion: 1, snapshot, provenance: { analyzer: { name: "fixture", version: "1" }, resolver: { name: "fixture", version: "1" }, configHash: "d".repeat(64) }, files: [], nodes: [], edges: [], limitations: [] } as unknown as CcmV1;
  const feature: SemanticFeature = { id: "feature:catalog", label: "Book catalog", entryNodeIds: ["route:books"], nodeIds: nodes.map(node => node.id), edgeIds: edges.map(edge => edge.id), evidence: [fixtureEvidence] };
  const semantic: SemanticModel = { schemaVersion: "sage-semantic-v2", extractorVersion: "test-fixture", sourceCkgHash, snapshot, nodes, edges, features: [feature], frameworks: ["Next.js App Router"], limitations: [] };
  const model = buildAddBaseline({ ccm, semantic, sourceCkgHash });
  const applicationId = model.catalogs.applicationPortfolio[0]!.elementId;
  for (let index = 0; index < 44; index++) {
    const interfaceId = `fixture-interface-${index}`;
    model.elements.push({ id: interfaceId, type: "ApplicationInterface", name: `GET /api/books/${index}`, description: "Large-fixture interface.", origin: "source", featureGroup: "Book catalog", evidence: [fixtureEvidence], review: "unreviewed" });
    model.catalogs.interfaces.push({ elementId: interfaceId, protocol: "HTTP", contract: `GET /api/books/${index}` });
    model.views.applicationCooperation.elementIds.push(interfaceId);
    const relationId = `fixture-interface-relation-${index}`;
    model.relationships.push({ id: relationId, type: "CompositionRelationship", sourceId: applicationId, targetId: interfaceId, label: "has interface", origin: "source", confidence: "proven", reason: "Large-fixture interface relationship.", evidence: [fixtureEvidence], review: "unreviewed" });
    model.views.applicationCooperation.relationshipIds.push(relationId);
  }
  return model;
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((yes, no) => { server.once("error", no); server.listen(0, "127.0.0.1", yes); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((yes, no) => server.close(error => error ? no(error) : yes()));
  return port;
}

function addPageSource(): string {
  return `import { AddWorkspace } from "../../components/add-workspace/add-workspace.tsx";
export default function AddQaPage() { return <main style={{ maxWidth: 1280, margin: "32px auto", padding: "0 16px" }}><p data-testid="fixture-note">Disposable browser fixture; no product database or worker.</p><AddWorkspace analysisId="${analysisId}" accountKey="${accountKey}" /></main>; }
`;
}

async function startNext(port: number, appRoot: string): Promise<{ child: ChildProcess; logs: string[] }> {
  const nextBin = resolve(projectRoot, "node_modules/next/dist/bin/next");
  const child = spawn(process.execPath, [nextBin, "dev", "--webpack", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: appRoot, env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" }, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
  });
  const logs: string[] = [];
  const append = (chunk: Buffer) => { logs.push(...chunk.toString("utf8").split(/\r?\n/u).filter(Boolean)); if (logs.length > 80) logs.splice(0, logs.length - 80); };
  child.stdout?.on("data", append); child.stderr?.on("data", append);
  return { child, logs };
}

async function waitForNext(port: number, child: ChildProcess, logs: string[]): Promise<void> {
  const deadline = Date.now() + 90_000; let last = "not responding";
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Next test server exited (${child.exitCode}): ${logs.join("\n")}`);
    let response: Response | undefined;
    try {
      response = await fetch(`http://127.0.0.1:${port}/qa-add-workspace`);
    } catch (error) { last = error instanceof Error ? error.message : String(error); }
    if (response?.ok) return;
    if (response && response.status >= 500) throw new Error(`Next test page returned ${response.status}: ${(await response.text()).slice(0, 6000)}\n${logs.join("\n")}`);
    if (response) last = `HTTP ${response.status}`;
    await new Promise(resolveDelay => setTimeout(resolveDelay, 400));
  }
  throw new Error(`Next test server did not become ready (${last}): ${logs.join("\n")}`);
}

async function stopNext(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.killed) return;
  try { if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGTERM"); else child.kill("SIGTERM"); } catch { /* Process already exited. */ }
  await Promise.race([new Promise<void>(resolveExit => child.once("exit", () => resolveExit())), new Promise<void>(resolveDelay => setTimeout(resolveDelay, 8_000))]);
  if (child.exitCode === null) try { if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); } catch { /* Process already exited. */ }
}

async function fulfill(route: Route, status: number, body: unknown): Promise<void> {
  await route.fulfill({ status, contentType: "application/json", headers: { "Cache-Control": "no-store" }, body: JSON.stringify(body) });
}

async function main(): Promise<void> {
  await mkdir(reportDirectory, { recursive: true });
  const tempRoot = await mkdtemp(resolve(tmpdir(), "sage-add-workspace-"));
  const appRoot = resolve(tempRoot, "apps/web");
  const pagePath = resolve(appRoot, "app/qa-add-workspace/page.tsx");
  const model = fixtureModel();
  const initialOverlay = emptyAddReviewOverlay();
  let overlay = initialOverlay;
  let patchCount = 0;
  let baselineGenerated = false;
  let generateCount = 0;
  let consentReceived: boolean | null = null;
  let delayPatch = false;
  let resolvePatchStarted!: () => void;
  const patchStarted = new Promise<void>(resolve => { resolvePatchStarted = resolve; });
  let releasePatch!: () => void;
  const patchGate = new Promise<void>(resolve => { releasePatch = resolve; });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let child: ChildProcess | undefined;
  try {
    await mkdir(resolve(tempRoot, "apps"), { recursive: true });
    await cp(appRootSource, appRoot, { recursive: true, filter: source => { const path = relative(appRootSource, source); return path !== "node_modules" && path !== ".next" && !path.startsWith(".next/"); } });
    await symlink(resolve(projectRoot, "node_modules"), resolve(tempRoot, "node_modules"), "dir");
    await symlink(resolve(projectRoot, "packages"), resolve(tempRoot, "packages"), "dir");
    await mkdir(dirname(pagePath), { recursive: true });
    await writeFile(pagePath, addPageSource(), { flag: "wx" });
    const port = await availablePort();
    const server = await startNext(port, appRoot); child = server.child;
    await waitForNext(port, child, server.logs);
    browser = await chromium.launch({ headless: true, args: ["--disable-background-networking", "--disable-default-apps"] });
    const context = await browser.newContext({ baseURL: `http://127.0.0.1:${port}`, viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce", acceptDownloads: true });
    const page = await context.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", error => pageErrors.push(error.message));
    await page.addInitScript(() => { (window as unknown as { __printCount?: number }).__printCount = 0; window.print = () => { (window as unknown as { __printCount: number }).__printCount += 1; }; });
    await page.route("**/api/auth/session", async route => {
      assert.equal(route.request().headers()["x-sage-account"], accountKey, "session identity request is bound to expected account");
      await fulfill(route, 200, { data: { accountKey } });
    });
    await page.route(`**/api/analyses/${analysisId}/add`, async route => {
      assert.equal(route.request().headers()["x-sage-account"], accountKey, "ADD request is bound to expected account");
      if (route.request().method() === "GET") {
        if (!baselineGenerated) {
          await fulfill(route, 409, { data: { status: "not-generated", accountKey } });
          return;
        }
      await fulfill(route, 200, { data: { id: "add-fixture-01", analysisId, accountKey, modelHash: addModelHash, sourceCkgHash, model, revision: overlay.revision, overlay } });
        return;
      }
      if (route.request().method() === "POST") {
        const request = route.request().postDataJSON() as { allowLlm?: unknown };
        assert.equal(typeof request.allowLlm, "boolean", "ADD generation requires an explicit boolean consent value");
        generateCount += 1;
        consentReceived = request.allowLlm === true;
        baselineGenerated = true;
        await fulfill(route, 201, { data: { id: "add-fixture-01", analysisId, accountKey, modelHash: addModelHash, sourceCkgHash, model, revision: overlay.revision, overlay, generated: true } });
        return;
      }
      assert.equal(route.request().method(), "PATCH");
      patchCount += 1;
      if (delayPatch) { resolvePatchStarted(); await patchGate; }
      const request = route.request().postDataJSON() as { expectedRevision: number; overlay: Omit<typeof overlay, "revision"> };
      assert.equal(request.expectedRevision, overlay.revision, "review update uses optimistic revision");
      overlay = { ...request.overlay, revision: overlay.revision + 1 };
      await fulfill(route, 201, { data: { id: "revision-fixture-01", accountKey, revision: overlay.revision, overlay, contentHash: "f".repeat(64) } });
    });
    await page.route("https://**/*", route => route.abort());
    await page.goto("/qa-add-workspace");
    const generateButton = page.getByRole("button", { name: "Generate Phase C baseline" });
    await generateButton.waitFor();
    const consentCheckbox = page.getByRole("checkbox", { name: /Enable optional LLM narrative assistance/iu });
    assert.equal(await consentCheckbox.isChecked(), false, "LLM assistance is opt-in and disabled by default");
    await generateButton.click();
    await page.getByRole("heading", { name: "Architecture Definition Document" }).waitFor();
    await page.getByRole("heading", { name: "Baseline Data Architecture" }).waitFor();
    await page.getByRole("heading", { name: "Application Design (Baseline)" }).waitFor();
    assert.equal(generateCount, 1, "the ADD page generates its baseline without requiring a Code Knowledge visit");
    assert.equal(consentReceived, false, "unchecked LLM consent is sent as allowLlm:false");
    assert.ok(await page.locator('#logical-data-model svg g[class*="edgeSource"] > path').count() > 0, "Data Structure view renders source relationships");
    assert.ok(await page.locator('#application-design svg g[class*="edgeSource"] > path').count() > 0, "Application Cooperation view renders source relationships");
    await page.getByRole("searchbox", { name: "Search data" }).fill("no-such-data-entity");
    assert.ok((await page.locator('#business-data-model [class*="screenDataCatalog"]').innerText()).includes("No data object matches this search."), "on-screen data entity search can filter the catalog");
    await page.emulateMedia({ media: "print" });
    const printPages = page.locator('#application-design section[class*="printDiagramPage"]');
    const printPageCount = await printPages.count();
    assert.ok(printPageCount >= 6, `large application diagrams are paginated into readable A4-sized subsets (found ${printPageCount} pages)`);
    const printedDiagramRelationshipIds = new Set(await printPages.locator("svg g[data-relationship-id]").evaluateAll(nodes => nodes.map(node => node.getAttribute("data-relationship-id")).filter((id): id is string => Boolean(id))));
    const paginatedInterfaceRelationshipIds = model.relationships.filter(edge => edge.id.startsWith("fixture-interface-relation-")).map(edge => edge.id);
    assert.ok(paginatedInterfaceRelationshipIds.every(id => printedDiagramRelationshipIds.has(id)), "source-supported interface edges remain drawn on their paginated diagram pages");
    const contextualPage = printPages.nth(1).locator("svg");
    const contextualViewBox = await contextualPage.getAttribute("viewBox");
    assert.ok(Number(contextualViewBox?.split(/\s+/u)[2]) < 1240, `sparse print pages compact their active ArchiMate lanes (viewBox=${contextualViewBox})`);
    assert.ok((await contextualPage.locator("text").allTextContents()).some(text => text.trim() === "library"), "each interface page repeats the application scope element for context");
    assert.ok(await contextualPage.locator("path").count() > 0, "repeated scope element remains linked to its interfaces on every print page");
    assert.equal(await page.locator('#application-design [class*="diagramNodeName"]').first().evaluate(node => getComputedStyle(node).fontSize), "18px", "printed node text keeps its minimum vector font size");
    assert.equal(await page.locator('#application-design [class*="diagramViewport"]').evaluate(node => getComputedStyle(node).display), "none", "the unpaginated screen SVG is excluded from print");
    const printRegister = page.locator('[class*="printRelationshipRegister"]');
    assert.equal(await printRegister.evaluate(node => getComputedStyle(node).display), "block", "print output includes the complete relationship register");
    const printRegisterIds = await printRegister.locator("tr[data-relationship-id]").evaluateAll(rows => rows.map(row => row.getAttribute("data-relationship-id")));
    assert.deepEqual([...printRegisterIds].sort(), model.relationships.map(edge => edge.id).sort(), "the print register includes every model relationship, including links outside each diagram view");
    const expectedRelationshipEvidenceCount = model.relationships.reduce((count, edge) => count + edge.evidence.length, 0);
    assert.equal(await printRegister.locator('[class*="evidenceList"] li').count(), expectedRelationshipEvidenceCount, "the complete relationship register includes every source evidence span");
    const printedDataEntityIds = await page.locator('#business-data-model [class*="printDataCatalog"] tr[data-element-id]').evaluateAll(rows => rows.map(row => row.getAttribute("data-element-id")));
    assert.deepEqual([...printedDataEntityIds].sort(), model.catalogs.dataEntities.map(row => row.elementId).sort(), "print output includes all data entities while the on-screen catalog search is filtering");
    assert.equal(await page.locator('#business-data-model [class*="screenDataCatalog"]').evaluate(node => getComputedStyle(node).display), "none", "the filtered screen catalog is excluded from print");
    assert.equal(await page.locator('#business-data-model [class*="printDataCatalog"]').evaluate(node => getComputedStyle(node).display), "block", "the full data entity catalog is enabled in print");
    assert.equal(await page.locator('#review [class*="reviewRows"]').evaluate(node => getComputedStyle(node).display), "none", "review controls are excluded from print output");
    await page.emulateMedia({ media: "screen" });
    await page.getByRole("searchbox", { name: "Search data" }).fill("");
    assert.ok(await page.getByRole("link", { name: /route.ts:1–1/ }).count() > 0, "source evidence links include line ranges");
    await page.screenshot({ path: resolve(reportDirectory, "add-workspace-desktop.png"), fullPage: true });

    await page.setViewportSize({ width: 390, height: 844 });
    const mobileOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(mobileOverflow <= 1, `mobile document should not overflow horizontally: ${mobileOverflow}px`);
    const diagramRegion = page.getByRole("region", { name: /DATA STRUCTURE VIEW diagram/iu });
    assert.equal(await diagramRegion.getAttribute("tabindex"), "0", "diagram can be focused and scrolled with a keyboard");
    await page.screenshot({ path: resolve(reportDirectory, "add-workspace-mobile.png"), fullPage: true });

    const review = page.locator("#review");
    const displayName = review.getByLabel("Display name").first();
    await displayName.fill("Library Application");
    await review.getByRole("button", { name: "Mark document reviewed" }).click();
    delayPatch = true;
    await review.getByRole("button", { name: "Save review" }).click();
    await patchStarted;
    assert.equal(await displayName.isDisabled(), true, "review edits are frozen while optimistic save is pending");
    assert.equal(await review.getByRole("button", { name: "Reopen as draft" }).isDisabled(), true);
    releasePatch();
    await review.getByRole("status").filter({ hasText: "revision 1" }).waitFor();
    assert.equal(await displayName.inputValue(), "Library Application", "the saved response retains the submitted edit");
    assert.equal(patchCount, 1, "review was persisted through the versioned PATCH contract");
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download Markdown" }).click();
    const download = await downloadPromise;
    const markdownPath = resolve(reportDirectory, "add-workspace-reviewed.md");
    await download.saveAs(markdownPath);
    const markdown = await readFile(markdownPath, "utf8");
    assert.ok(markdown.includes("Library Application"), "Markdown export uses corrected display name");
    assert.ok(markdown.includes("Review overlay | reviewed, revision 1"), "Markdown export uses the saved review revision");
    assert.ok(markdown.includes(`ADD model SHA-256 | ${addModelHash}`), "Markdown export identifies the canonical ADD model");
    const latexPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download LaTeX" }).click();
    const latexDownload = await latexPromise;
    const latexPath = resolve(reportDirectory, "add-workspace-reviewed.tex");
    await latexDownload.saveAs(latexPath);
    const latex = await readFile(latexPath, "utf8");
    assert.ok(latex.includes(addModelHash), "LaTeX export identifies the canonical ADD model");
    assert.ok(latex.includes("reviewed, revision 1"), "LaTeX export uses the saved review revision");
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.emulateMedia({ media: "screen" });
    await page.getByRole("button", { name: "Print / Save as PDF" }).click();
    assert.equal(await page.evaluate(() => (window as unknown as { __printCount: number }).__printCount), 1, "PDF print action uses the current reviewed page snapshot");
    await page.emulateMedia({ media: "print" });
    const printableSourceNotes = await page.locator("#source-notes").innerText();
    assert.ok(printableSourceNotes.includes(addModelHash), "PDF print view identifies the canonical ADD model");
    assert.ok(printableSourceNotes.includes("reviewed, revision 1"), "PDF print view uses the saved review revision");
    const pdfPath = resolve(reportDirectory, "add-workspace-reviewed.pdf");
    await page.pdf({ path: pdfPath, format: "A4", printBackground: true, preferCSSPageSize: true });
    const pdfBytes = await readFile(pdfPath);
    assert.ok(pdfBytes.subarray(0, 5).toString("ascii") === "%PDF-", "browser produces a real PDF artifact");

    baselineGenerated = false;
    const consentPage = await context.newPage();
    await consentPage.route("**/api/auth/session", route => fulfill(route, 200, { data: { accountKey } }));
    await consentPage.route(`**/api/analyses/${analysisId}/add`, async route => {
      assert.equal(route.request().headers()["x-sage-account"], accountKey);
      if (route.request().method() === "GET" && !baselineGenerated) {
        await fulfill(route, 409, { data: { status: "not-generated", accountKey } });
        return;
      }
      if (route.request().method() === "POST") {
        const request = route.request().postDataJSON() as { allowLlm?: unknown };
        assert.equal(typeof request.allowLlm, "boolean");
        generateCount += 1;
        consentReceived = request.allowLlm === true;
        baselineGenerated = true;
        await fulfill(route, 201, { data: { id: "add-fixture-01", analysisId, accountKey, modelHash: addModelHash, sourceCkgHash, model, revision: overlay.revision, overlay, generated: true } });
        return;
      }
      await fulfill(route, 200, { data: { id: "add-fixture-01", analysisId, accountKey, modelHash: addModelHash, sourceCkgHash, model, revision: overlay.revision, overlay } });
    });
    await consentPage.route("https://**/*", route => route.abort());
    await consentPage.goto("/qa-add-workspace");
    const optIn = consentPage.getByRole("checkbox", { name: /Enable optional LLM narrative assistance/iu });
    await optIn.waitFor();
    await optIn.check();
    await consentPage.getByRole("button", { name: "Generate Phase C baseline" }).click();
    await consentPage.getByRole("heading", { name: "Baseline Data Architecture" }).waitFor();
    assert.equal(consentReceived, true, "LLM facts are sent only after explicit checkbox consent");
    assert.equal(generateCount, 2);
    await consentPage.close();
    assert.deepEqual(pageErrors, [], "browser must not report uncaught client exceptions");
    await context.close();
    process.stdout.write(`ADD workspace Playwright passed: primary ADD generation and LLM opt-in, 2 ArchiMate views with relationships, 45+ interface pagination, evidence links, mobile/keyboard, optimistic review save, model/revision-consistent Markdown/LaTeX/PDF, and A4 PDF artifact; artifacts=${reportDirectory}\n`);
    process.stdout.write("Scope: real AddWorkspace and CSS on a disposable Next dev page; API responses are intercepted fixtures. This does not test PostgreSQL persistence, export worker, OAuth, or production pipeline integration.\n");
  } finally {
    if (browser) await browser.close();
    if (child) await stopNext(child);
    await rm(tempRoot, { recursive: true, force: true });
  }
}

await main();
