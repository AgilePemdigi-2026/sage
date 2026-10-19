import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { chromium } from "playwright";

const base = process.env.SAGE_HTTP_BASE_URL ?? "http://web:3000";
const output = "artifacts/ui-02";
const sha = "a136f9c488b04116ac641732e451d2c4a8b6291e";
const browser = await chromium.launch({ headless: true });
const checks: string[] = [];
await mkdir(output, { recursive: true });
try {
  for (const width of [360, 390, 768, 1024, 1440]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, acceptDownloads: true });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    let mutations = 0;
    page.on("request", request => { if (request.method() !== "GET") mutations++; });
    for (const path of ["/", "/login", "/preview/progress", "/preview/history", "/preview/graph?analysis=fixture-report", "/preview/document?analysis=fixture-report"]) {
      const response = await page.goto(`${base}${path}`);
      assert.equal(response?.status(), 200, path);
      await page.getByRole("heading", { level: 1 }).waitFor();
      await page.evaluate(() => document.fonts.ready);
      if (path.startsWith("/preview/")) await page.getByText("Data contoh, bukan hasil analisis.", { exact: true }).waitFor();
      if (path.startsWith("/preview/graph")) await page.locator('[aria-label="Kanvas knowledge graph"] canvas').first().waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${path} overflow at ${width}`);
      const assets = await page.locator('img[src^="/design/figma/"]').evaluateAll(images => images.map(image => {
        const img = image as HTMLImageElement;
        return { src: img.getAttribute("src"), loaded: img.complete && img.naturalWidth > 0, width: img.getAttribute("width"), height: img.getAttribute("height") };
      }));
      assert.ok(assets.every(asset => asset.loaded && Number(asset.width) > 0 && Number(asset.height) > 0), `${path} static assets`);
      await page.screenshot({ path: `${output}/${path.split("?")[0].replaceAll("/", "-") || "landing"}-${width}.png`, fullPage: true });
    }
    await page.goto(`${base}/preview/progress`);
    await page.getByText("Ubah skenario tampilan", { exact: true }).click();
    for (const name of ["Menunggu", "Gagal", "Selesai", "Selesai dengan batasan", "Berjalan"]) {
      await page.getByRole("button", { name, exact: true }).click();
      assert.equal(await page.locator("[data-stage-key]").count(), 9);
      assert.equal(await page.locator("[data-stage-key] img").count(), 9);
    }
    await page.goto(`${base}/preview/history`);
    await page.getByLabel("Cari repository, branch, atau SHA").fill("not-present");
    await page.getByText("Tidak ada hasil untuk", { exact: false }).waitFor();
    await page.getByRole("button", { name: "Hapus pencarian" }).click();
    await page.getByRole("link", { name: "Lihat graph", exact: true }).waitFor();
    await page.getByText("Ubah skenario tampilan", { exact: true }).click();
    for (const name of ["Memuat", "Kosong", "Error", "Data fixture"]) await page.getByRole("button", { name, exact: true }).click();
    await page.getByRole("link", { name: "Lihat graph", exact: true }).click();
    await page.waitForURL("**/preview/graph?analysis=fixture-report");
    assert.equal(new URL(page.url()).searchParams.get("analysis"), "fixture-report");
    await page.evaluate(`Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
      writeText: async (text) => { document.documentElement.dataset.copiedSha = text; }
    } })`);
    await page.getByRole("button", { name: "Salin SHA lengkap", exact: true }).click();
    assert.equal(await page.evaluate(() => document.documentElement.dataset.copiedSha), sha);
    const query = page.getByLabel("Cari node", { exact: true });
    await page.getByRole("button", { name: "Perbesar", exact: true }).click();
    await page.getByRole("button", { name: "Perkecil", exact: true }).click();
    await page.getByRole("button", { name: "Sesuaikan tampilan", exact: true }).click();
    await query.fill("ReportService");
    await page.getByLabel("Simbol", { exact: true }).uncheck();
    await page.getByLabel("Struktur", { exact: true }).uncheck();
    await page.getByText("Tidak ada node yang cocok", { exact: false }).waitFor();
    await page.getByLabel("Struktur", { exact: true }).check();
    await page.getByRole("button", { name: "Buka bukti deklarasi", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.waitFor();
    assert.match(await dialog.innerText(), /src\/report\.ts/);
    await page.keyboard.press("Shift+Tab");
    assert.equal(await page.getByLabel("Cuplikan source code").evaluate(el => el === document.activeElement), true);
    await page.keyboard.press("Tab");
    assert.equal(await page.getByRole("button", { name: "Tutup bukti sumber" }).evaluate(el => el === document.activeElement), true);
    await page.keyboard.press("Escape");
    assert.equal(await dialog.count(), 0);
    assert.equal(await page.getByRole("button", { name: "Buka bukti deklarasi", exact: true }).evaluate(el => el === document.activeElement), true);
    await query.fill("");
    await page.getByLabel("Simbol", { exact: true }).check();
    await page.getByRole("button", { name: "Fokus node", exact: true }).click();
    await page.getByRole("button", { name: "Semua relasi", exact: true }).click();
    await page.goto(`${base}/preview/document?analysis=fixture-report`);
    await page.getByRole("tab", { name: /Interface Catalog/ }).focus();
    await page.keyboard.press("ArrowDown");
    assert.equal(await page.getByRole("tab", { name: /Software Engineering Diagram/ }).getAttribute("aria-selected"), "true");
    await page.screenshot({ path: `${output}/document-structure-${width}.png`, fullPage: true });
    await page.keyboard.press("ArrowDown");
    assert.equal(await page.getByRole("tab", { name: /UML Class Diagram/ }).getAttribute("aria-selected"), "true");
    await page.screenshot({ path: `${output}/document-uml-${width}.png`, fullPage: true });
    await page.getByRole("tab", { name: /Interface Catalog/ }).click();
    const source = page.getByRole("button", { name: /^Buka bukti / }).first();
    await source.click();
    await page.getByRole("dialog").waitFor();
    await page.keyboard.press("Escape");
    assert.equal(await page.getByRole("dialog").count(), 0);
    assert.equal(await source.evaluate(el => el === document.activeElement), true);
    const downloadEvent = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export Markdown", exact: true }).click();
    const download = await downloadEvent;
    const downloadPath = await download.path(); assert.ok(downloadPath);
    const markdown = await readFile(downloadPath, "utf8");
    assert.ok(markdown.includes(sha) && markdown.includes("fixture") && markdown.includes("ReportService"));
    assert.equal(await page.getByRole("button", { name: "Export PDF", exact: true }).isDisabled(), true);
    await page.getByText("Uji state pratinjau", { exact: true }).click();
    const state = page.getByLabel("State layar");
    await state.selectOption("error");
    await page.getByRole("button", { name: "Coba lagi di pratinjau" }).click();
    await state.selectOption("unavailable");
    await page.getByText("Dokumen untuk analisis ini tidak tersedia", { exact: true }).waitFor();
    for (const path of ["graph", "document"]) {
      const response = await page.goto(`${base}/preview/${path}?analysis=another-analysis`);
      if (path === "graph") assert.equal(response?.status(), 404, "Unknown graph context must not show fixture");
      else { assert.equal(response?.status(), 200); await page.getByText("Analisis tidak ditemukan", { exact: true }).waitFor(); assert.equal(await page.getByRole("tab").count(), 0); }
    }
    assert.equal(mutations, 0, "Fixture UI must not submit jobs or mutate user data");
    assert.deepEqual(errors, []);
    checks.push(`${width}px: six screens, local SVG geometry, no overflow/JS errors; history search/states; graph query AND category, focus, source/Escape/restore; document keyboard tabs, source, Markdown bytes, disabled PDF, retry/unavailable; unknown analysis rejected; no mutations`);
    await context.close();
  }
  const report = { checkedAt: new Date().toISOString(), scope: "Figma presentation and validated CCM fixture; no live provider or pipeline acceptance", checks };
  await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report));
} finally { await browser.close(); }
