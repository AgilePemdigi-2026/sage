import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright";

const baseUrl = process.env.BASE_URL ?? "http://web:3000";
const output = join(process.env.STORAGE_ROOT ?? "artifacts", "environment");
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  const checks = [];
  for (const width of [360, 390, 768, 1024, 1440]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 } });
    const failures: string[] = [];
    page.on("pageerror", (error) => failures.push(error.message));
    const response = await page.goto(baseUrl, { waitUntil: "networkidle" });
    assert.equal(response?.status(), 200);
    assert.equal(await page.locator("html").getAttribute("lang"), "id");
    assert.equal(await page.getByRole("heading", { level: 1 }).count(), 1);
    assert.ok(await page.getByText("Akses analisis segera tersedia").isVisible());
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    assert.deepEqual(failures, []);
    const health = await page.request.get(`${baseUrl}/api/health`);
    assert.equal(health.status(), 200);
    assert.equal((await health.json()).database, "ok");
    await page.screenshot({ path: join(output, `home-${width}.png`), fullPage: true });
    checks.push({ width, status: "PASS", horizontalOverflow: false, pageErrors: 0 });
    await page.close();
  }
  await writeFile(join(output, "browser-report.json"), JSON.stringify({ date: new Date().toISOString(), scope: "Foundation page only; full T-UI-01 NOT_RUN", checks }, null, 2) + "\n");
  console.log(JSON.stringify({ status: "PASS", checks }));
} finally {
  await browser.close();
}
