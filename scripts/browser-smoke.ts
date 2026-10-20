import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Page, type Request } from "playwright";

const baseUrl = process.env.BASE_URL ?? "http://web:3000";
const baseOrigin = new URL(baseUrl).origin;
const output = join(process.env.STORAGE_ROOT ?? "artifacts", "environment");
const assetTypes = new Set(["font", "image", "script", "stylesheet"]);
const outputScope =
  "Real landing, login CTA destination, fixture-only preview labels, responsive assets and overflow, browser errors, and API health; full acceptance not run.";

await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });

function isAppAsset(request: Request) {
  return assetTypes.has(request.resourceType()) && new URL(request.url()).origin === baseOrigin;
}

async function assertNoHorizontalOverflow(page: Page, route: string) {
  const dimensions = await page.evaluate(() => ({
    body: document.body.scrollWidth,
    document: document.documentElement.scrollWidth,
    viewport: window.innerWidth,
  }));
  assert.ok(
    dimensions.document <= dimensions.viewport && dimensions.body <= dimensions.viewport,
    `${route} overflows horizontally: ${JSON.stringify(dimensions)}`,
  );
}

try {
  const checks = [];
  for (const width of [360, 390, 768, 1024, 1440]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 } });
    const pageErrors: string[] = [];
    const consoleErrors: string[] = [];
    const failedAssets: string[] = [];
    const loadedAssetTypes = new Set<string>();
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("requestfailed", (request) => {
      if (isAppAsset(request)) failedAssets.push(`${request.resourceType()} ${request.url()}`);
    });
    page.on("response", (response) => {
      const request = response.request();
      if (!isAppAsset(request)) return;
      if (response.status() >= 400) {
        failedAssets.push(`${request.resourceType()} ${response.status()} ${response.url()}`);
      } else {
        loadedAssetTypes.add(request.resourceType());
      }
    });

    const response = await page.goto(baseUrl, { waitUntil: "networkidle" });
    assert.equal(response?.status(), 200);
    assert.equal(await page.locator("html").getAttribute("lang"), "id");
    const landingHeading = page.getByRole("heading", { level: 1 });
    assert.equal(await landingHeading.count(), 1);
    assert.equal((await landingHeading.innerText()).replace(/\s+/g, " ").trim(), "Pahami arsitektur. Telusuri buktinya.");
    await page.evaluate(() => document.fonts.ready);
    await assertNoHorizontalOverflow(page, "landing");
    assert.ok(loadedAssetTypes.has("stylesheet"), "Landing stylesheet did not load");
    assert.ok(loadedAssetTypes.has("script"), "Landing JavaScript did not load");
    assert.ok(loadedAssetTypes.has("font"), "Landing font assets did not load");
    assert.deepEqual(failedAssets, [], "App assets failed to load");

    const loginCta = page.getByRole("link", { name: "Hubungkan GitHub", exact: true });
    assert.equal(await loginCta.getAttribute("href"), "/login");
    await loginCta.click();
    await page.waitForURL((url) => url.pathname === "/login");
    assert.equal(await page.getByRole("heading", { level: 1 }).innerText(), "Masuk dengan GitHub");
    await assertNoHorizontalOverflow(page, "login");

    await page.goto(baseUrl, { waitUntil: "networkidle" });
    const previewCta = page.getByRole("link", { name: "Lihat pratinjau", exact: true });
    assert.equal(await previewCta.getAttribute("href"), "/preview/progress");
    await previewCta.click();
    await page.waitForURL((url) => url.pathname === "/preview/progress");
    assert.equal(await page.getByRole("heading", { level: 1 }).innerText(), "Progres analisis");
    assert.ok(await page.getByText("Mode pratinjau", { exact: true }).isVisible());
    const fixtureNotice = page.getByRole("note");
    assert.ok(await fixtureNotice.isVisible());
    assert.ok(await fixtureNotice.getByText("Data contoh, bukan hasil analisis.", { exact: true }).isVisible());
    assert.ok(await fixtureNotice.getByText("tidak terhubung ke GitHub dan tidak menjalankan job.").isVisible());
    await page.evaluate(() => document.fonts.ready);
    await assertNoHorizontalOverflow(page, "fixture preview");

    const health = await page.request.get(`${baseUrl}/api/health`);
    assert.equal(health.status(), 200);
    assert.equal((await health.json()).database, "ok");
    assert.deepEqual(failedAssets, [], "App assets failed to load during navigation");
    assert.deepEqual(pageErrors, [], "Browser page errors occurred");
    assert.deepEqual(consoleErrors, [], "Browser console errors occurred");

    await page.goto(baseUrl, { waitUntil: "networkidle" });
    await page.screenshot({ path: join(output, `home-${width}.png`), fullPage: true });
    checks.push({
      width,
      status: "PASS",
      loginCta: "navigated to /login",
      previewCta: "navigated to labelled fixture-only /preview/progress",
      loadedAssetTypes: [...loadedAssetTypes].sort(),
      horizontalOverflow: false,
      pageErrors: 0,
      consoleErrors: 0,
      apiHealth: "ok",
    });
    await page.close();
  }

  await writeFile(
    join(output, "browser-report.json"),
    JSON.stringify({ date: new Date().toISOString(), scope: outputScope, fullAcceptance: "NOT_RUN", checks }, null, 2) + "\n",
  );
  console.log(JSON.stringify({ status: "PASS", scope: outputScope, checks }));
} finally {
  await browser.close();
}
