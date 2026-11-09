import { Given, When, Then, After, AfterAll } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { projectCcmForGraph } from "../../../apps/web/components/graph-foundation/graph-projection.ts";
import type { IWorld } from "@cucumber/cucumber";
import { createFixture, setArchiveFault, exportRecord, stopFixtureServer, pauseFixtureWorker, type ScenarioFixture } from "./browser-fixture.ts";
interface SrsWorld extends IWorld { fixture: ScenarioFixture; pendingFault?: boolean; downloaded?: { format: string; bytes: Buffer } }
const current = (world: SrsWorld) => { assert.ok(world.fixture, "Initialize the scenario's synthetic owner first"); return world.fixture; };

Given("I am signed in as a synthetic owner with a completed analysis", async function (this: SrsWorld) {
  this.fixture = await createFixture(false);
});
Given("I am signed in as a synthetic owner without saved analyses", async function (this: SrsWorld) {
  this.fixture = await createFixture(true);
});
Given("I am viewing the completed analysis on {string}", async function (this: SrsWorld, screen: string) {
  const f = current(this);
  assert.ok(["Code Knowledge", "Architecture Definition Document"].includes(screen));
  await f.page.goto(`${f.base}/analyses/${f.analysisId}/${screen === "Code Knowledge" ? "graph" : "document"}`);
  await f.page.getByRole("heading", { name: screen === "Code Knowledge" ? "Struktur source code" : screen, exact: true }).waitFor();
  if (screen === "Architecture Definition Document") await f.page.getByRole("button", { name: "Ekspor PDF", exact: true }).waitFor();
});
When("I open the completed analysis results", async function (this: SrsWorld) {
  const f = current(this);
  await f.page.goto(`${f.base}/analyses/${f.analysisId}`);
  await f.page.getByRole("link", { name: "Buka knowledge graph", exact: true }).waitFor();
});
When("I follow the link {string}", async function (this: SrsWorld, label: string) {
  await current(this).page.getByRole("link", { name: label, exact: true }).click();
});
When("I press the button {string}", async function (this: SrsWorld, label: string) {
  const f = current(this);
  if (this.pendingFault) {
    assert.equal(label, "Ekspor PDF");
    const response = f.page.waitForResponse(response => new URL(response.url()).pathname === `/api/analyses/${f.analysisId}/exports` && response.request().method() === "POST");
    try {
      await f.page.getByRole("button", { name: label, exact: true }).click();
      assert.equal((await response).status(), 202);
      await setArchiveFault(f, true);
      this.pendingFault = false;
    } finally { pauseFixtureWorker(false); }
  } else await f.page.getByRole("button", { name: label, exact: true }).click();
});
When("I fill in {string} with {string}", async function (this: SrsWorld, label: string, value: string) {
  await current(this).page.getByLabel(label, { exact: true }).fill(value);
});
When("I select AST category {string}", async function (this: SrsWorld, kind: string) {
  const page = current(this).page;
  const disclosure = page.getByTestId("graph-kind-filters-disclosure");
  if (await disclosure.getAttribute("open") === null) await disclosure.locator("summary").click();
  await page.getByLabel(kind, { exact: true }).check();
});
When("I select node {string} from {string}", async function (this: SrsWorld, name: string, label: string) {
  const f = current(this);
  const node = f.graph!.ccm.nodes.find(node => node.name === name && node.kind === "Class");
  assert.ok(node, `Fixture must contain Class ${name}`);
  await f.page.getByLabel(label, { exact: true }).selectOption(node.id);
});
When("I open my analysis history", async function (this: SrsWorld) {
  const f = current(this);
  await f.page.goto(`${f.base}/workspace/history`);
});
When("I search my analysis history for {string}", async function (this: SrsWorld, value: string) {
  const f = current(this);
  const response = f.page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.pathname === "/api/analyses" && url.searchParams.get("query") === value && response.status() === 200;
  });
  await f.page.getByRole("searchbox").fill(value);
  await response;
});
Then("I should see the heading {string}", async function (this: SrsWorld, text: string) {
  await current(this).page.getByRole("heading", { name: text, exact: true }).waitFor();
});
Then("I should see the message {string}", async function (this: SrsWorld, text: string) {
  await current(this).page.getByText(text, { exact: true }).waitFor();
});
Then("I should see a graph canvas with source nodes and relationships", async function (this: SrsWorld) {
  const f = current(this);
  await f.page.getByRole("region", { name: "Kanvas knowledge graph", exact: true }).locator("canvas").first().waitFor();
  assert.ok(f.graph!.counts.nodes > 0 && f.graph!.counts.edges > 0);
  await f.page.getByTestId("canonical-counts").waitFor();
});
Then("the available focus nodes should match {string}", async function (this: SrsWorld, query: string) {
  const f = current(this);
  const picker = f.page.getByLabel("Pilih node fokus", { exact: true });
  const expected = projectCcmForGraph(f.graph!.ccm).nodes.filter(node =>
    [node.name, node.kind, node.qualifiedName, node.filePath ?? ""].some(value => value.toLowerCase().includes(query.toLowerCase()))
  ).map(node => node.id).sort();
  assert.ok(expected.length > 0);
  await f.page.waitForFunction(ids => {
    const select = document.querySelector('[data-testid="graph-node-picker"]') as HTMLSelectElement | null;
    return JSON.stringify(Array.from(select?.options ?? []).map(o => o.value).filter(Boolean).sort()) === JSON.stringify(ids);
  }, expected);
  assert.ok(await picker.locator("option").count() > 0);
});
Then("the graph focus picker should include node {string}", async function (this: SrsWorld, name: string) {
  const f = current(this);
  const node = f.graph!.ccm.nodes.find(node => node.name === name && node.kind === "Class");
  assert.ok(node);
  await f.page.getByLabel("Pilih node fokus", { exact: true }).locator(`option[value="${node.id}"]`).waitFor({ state: "attached" });
});
Then("only AST category {string} should be available for focus", async function (this: SrsWorld, kind: string) {
  const f = current(this);
  const picker = f.page.getByLabel("Pilih node fokus", { exact: true });
  const expected = f.graph!.ccm.nodes.filter(node => node.kind === kind).map(node => node.id).sort();
  await f.page.waitForFunction(({ ids }) => {
    const picker = document.querySelector('[data-testid="graph-node-picker"]') as HTMLSelectElement | null;
    return JSON.stringify(Array.from(picker?.options ?? []).map(o => o.value).filter(Boolean).sort()) === JSON.stringify(ids);
  }, { ids: expected });
  assert.ok(await picker.locator("option").count() > 0);
});
Then("the node inspector should show {string} and its source location", async function (this: SrsWorld, name: string) {
  const f = current(this);
  await f.page.getByTestId("node-inspector-title").filter({ hasText: name }).waitFor();
  await f.page.getByLabel("Lokasi AST node", { exact: true }).waitFor();
  await f.page.getByTestId("node-inspector-source").first().waitFor();
});
Then("no graph nodes should be available for focus", async function (this: SrsWorld) {
  const options = current(this).page.getByLabel("Pilih node fokus", { exact: true }).locator("option");
  assert.deepEqual(await options.evaluateAll(options => options.map(o => (o as HTMLOptionElement).value).filter(Boolean)), []);
});
When("I open documentation section {string}", async function (this: SrsWorld, section: string) {
  const label = current(this).page.getByRole("button").filter({ hasText: section });
  await label.click();
});
Then("my history should show repository {string} and branch {string}", async function (this: SrsWorld, repository: string, branch: string) {
  const page = current(this).page;
  await page.getByText(repository, { exact: true }).waitFor();
  await page.getByText(branch, { exact: true }).waitFor();
});
Then("my history should show language {string} and the completed commit", async function (this: SrsWorld, language: string) {
  const page = current(this).page;
  await page.getByText(language, { exact: true }).waitFor();
  await page.getByText("aaaaaaa", { exact: true }).waitFor();
});
Then("my history should contain no analysis rows", async function (this: SrsWorld) {
  assert.equal(await current(this).page.getByRole("link", { name: "Buka", exact: true }).count(), 0);
});
Then("I should be on {string}", async function (this: SrsWorld, path: string) {
  const f = current(this);
  await f.page.waitForURL(`${f.base}${path}`);
});
Then("I should be on the completed analysis detail page", async function (this: SrsWorld) {
  const f = current(this);
  await f.page.waitForURL(`${f.base}/analyses/${f.analysisId}`);
});
Then("the link {string} should be available", async function (this: SrsWorld, label: string) {
  await current(this).page.getByRole("link", { name: label, exact: true }).waitFor();
});
Given("the export worker will encounter an invalid test archive checksum", function (this: SrsWorld) {
  current(this);
  pauseFixtureWorker(true);
  this.pendingFault = true;
});
Then("the PDF export should fail with a retry action", async function (this: SrsWorld) {
  const f = current(this);
  await f.page.getByRole("button", { name: "Coba ekspor PDF lagi", exact: true }).waitFor();
  const row = await exportRecord(f, "PDF");
  assert.equal(row.status, "FAILED");
  assert.equal(row.errorCode, "EXPORT_FAILED");
});
When("the test archive checksum is restored", async function (this: SrsWorld) {
  await setArchiveFault(current(this), false);
});
Then("the {string} download should become available", async function (this: SrsWorld, format: string) {
  assert.ok(["PDF", "Markdown"].includes(format));
  const f = current(this);
  await f.page.getByRole("button", { name: `Unduh ${format}`, exact: true }).waitFor({ timeout: 60000 });
  assert.equal((await exportRecord(f, format)).status, "READY");
});
When("I download the {string} document", async function (this: SrsWorld, format: string) {
  const f = current(this);
  assert.ok(["PDF", "Markdown"].includes(format));
  const next = f.page.waitForEvent("download");
  await f.page.getByRole("button", { name: `Unduh ${format}`, exact: true }).click();
  const download = await next;
  assert.equal(await download.failure(), null);
  const path = await download.path();
  assert.ok(path);
  this.downloaded = { format, bytes: await readFile(path) };
});
Then("the downloaded {string} file should match the completed export", async function (this: SrsWorld, format: string) {
  const f = current(this);
  assert.equal(this.downloaded?.format, format);
  assert.ok(this.downloaded);
  const bytes = this.downloaded.bytes;
  const record = await exportRecord(f, format);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), record.contentHash);
  if (format === "PDF") assert.equal(bytes.subarray(0, 5).toString(), "%PDF-");
  else assert.match(bytes.toString(), /Interface Catalog/);
  this.attach(JSON.stringify({ format, bytes: bytes.byteLength, checksumMatches: true }), "application/json");
});
After({ tags: "@srs" }, async function (this: SrsWorld, { pickle, result }) {
  if (!this.fixture) return;
  try {
    pauseFixtureWorker(false);
    this.attach(await this.fixture.page.screenshot({ fullPage: true }), "image/png");
    assert.deepEqual(this.fixture.errors, [], "No uncaught browser errors");
    this.attach(JSON.stringify({ scenario: pickle.name, status: result?.status,
      scope: "Independent browser context and synthetic owner; canonical analyzer fixture; production Next, PostgreSQL and worker; no live OAuth" }), "application/json");
  } finally { await this.fixture.context.close(); }
});
AfterAll(async () => { await stopFixtureServer(); });
