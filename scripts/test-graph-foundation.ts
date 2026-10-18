import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, type Page } from "playwright";

const baseUrl = (process.env.BASE_URL ?? "http://127.0.0.1:3000").replace(/\/$/, "");
const output = resolve(process.env.GRAPH_EVIDENCE_DIR ?? "artifacts/graph-01-s1");
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const checks: string[] = [];
const errors: string[] = [];
const productRequests: string[] = [];
async function check(name: string, action: () => Promise<void>) {
  await action();
  checks.push(name);
}
async function zoom(page: Page) {
  return Number((await page.getByLabel("Tingkat zoom", { exact: true }).innerText()).replace("%", ""));
}
async function screenshot(page: Page, file: string) {
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: resolve(output, file), fullPage: true });
}
try {
  for (const width of [360, 390, 768, 1024, 1440]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 }, reducedMotion: "reduce" });
    page.on("pageerror", error => errors.push(`${width}: ${error.message}`));
    page.on("request", request => {
      const url = new URL(request.url());
      if (url.pathname.startsWith("/api/") || url.hostname.endsWith("github.com")) productRequests.push(request.url());
    });
    await page.goto(`${baseUrl}/graph-preview`, { waitUntil: "networkidle" });
    const canvas = page.getByRole("region", { name: "Kanvas knowledge graph", exact: true });
    const list = page.getByRole("group", { name: "Pilih node untuk melihat detail", exact: true });
    const options = list.getByRole("button");
    const details = page.getByRole("region", { name: "Node terpilih", exact: true });
    await check(`${width}: valid fixture, categories, resolution labels, and canvas`, async () => {
      assert.equal(await page.locator("html").getAttribute("lang"), "id");
      await page.getByText("Fixture tervalidasi · Tidak terhubung ke GitHub", { exact: true }).waitFor();
      await canvas.locator("canvas").first().waitFor();
      assert.equal(await options.count(), 10);
      const legend = page.getByLabel("Kategori node dan jenis relasi", { exact: true });
      for (const label of ["Berkas", "Struktur", "Simbol", "Belum terpecahkan", "Exact", "Unresolved"]) {
        assert.ok((await legend.innerText()).includes(label));
      }
      assert.equal(await page.getByText("Fixture graph tidak dapat ditampilkan", { exact: true }).count(), 0);
    });
    await check(`${width}: zoom buttons alter the rendered viewport`, async () => {
      const before = await zoom(page);
      await page.getByRole("button", { name: "Perbesar", exact: true }).click();
      assert.ok(await zoom(page) > before);
      const larger = await zoom(page);
      await page.getByRole("button", { name: "Perkecil", exact: true }).click();
      assert.ok(await zoom(page) < larger);
      await page.getByRole("button", { name: "Perbesar", exact: true }).click();
      const changed = await zoom(page);
      await page.getByRole("button", { name: "Sesuaikan tampilan", exact: true }).click();
      assert.ok(await zoom(page) < changed);
    });
    await screenshot(page, `graph-${width}.png`);
    await check(`${width}: keyboard selection updates exactly one pressed button and source context`, async () => {
      const first = options.first();
      await first.focus();
      await page.keyboard.press("Enter");
      assert.equal(await first.getAttribute("aria-pressed"), "true");
      assert.equal(await list.locator('[aria-pressed="true"]').count(), 1);
      await details.getByText("src/report.ts:1", { exact: true }).waitFor();
      const next = options.nth(1);
      await next.focus();
      await page.keyboard.press("Space");
      assert.equal(await next.getAttribute("aria-pressed"), "true");
      assert.equal(await first.getAttribute("aria-pressed"), "false");
      assert.equal(await list.locator('[aria-pressed="true"]').count(), 1);
      const focus = await next.evaluate(element => ({ active: document.activeElement === element, outline: getComputedStyle(element).outlineStyle }));
      assert.equal(focus.active, true);
      assert.notEqual(focus.outline, "none");
    });
    await check(`${width}: unresolved selection never invents a declaration`, async () => {
      const unresolved = options.filter({ hasText: "UnresolvedReference" });
      await unresolved.focus();
      await page.keyboard.press("Enter");
      assert.equal(await unresolved.getAttribute("aria-pressed"), "true");
      await details.getByText("Tidak memiliki deklarasi source; target relasi belum terpecahkan.", { exact: true }).waitFor();
    });
    await check(`${width}: selection survives viewport resize`, async () => {
      await page.setViewportSize({ width: width + 17, height: 1000 });
      assert.equal(await list.locator('[aria-pressed="true"]').count(), 1);
      await details.getByText("formatter.format", { exact: true }).waitFor();
      await page.setViewportSize({ width, height: 1000 });
    });
    await check(`${width}: page has no horizontal overflow`, async () => {
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
    });
    if (width === 360) await check("360: zoom limits and fit remain usable", async () => {
      for (let index = 0; index < 30; index++) await page.getByRole("button", { name: "Perkecil", exact: true }).click();
      assert.equal(await zoom(page), 10);
      for (let index = 0; index < 40; index++) await page.getByRole("button", { name: "Perbesar", exact: true }).click();
      assert.equal(await zoom(page), 250);
      await page.getByRole("button", { name: "Sesuaikan tampilan", exact: true }).click();
      assert.ok(await zoom(page) > 10 && await zoom(page) < 250);
    });
    await screenshot(page, `graph-selected-${width}.png`);
    await page.close();
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(productRequests, []);
  const report = { status: "PASS", viewports: 5, checks: checks.length, pageErrors: errors.length, productRequests: productRequests.length, details: checks };
  await writeFile(resolve(output, "browser-report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ ...report, details: undefined }));
} finally {
  await browser.close();
}
