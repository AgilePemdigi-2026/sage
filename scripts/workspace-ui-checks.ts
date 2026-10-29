import assert from "node:assert/strict";
import { join } from "node:path";
import type { Page } from "playwright";
import type { ArchitectureDocumentV1 } from "@sage/documents/model";

/** Real owner-scoped pages, seeded through the PDF regression's dedicated database. */
export async function checkWorkspaceExperience(page: Page, base: string, analysisId: string, model: ArchitectureDocumentV1, output: string, width: number, clockProbe: { start(): Promise<void>; finish(): Promise<void> }): Promise<void> {
  await page.emulateMedia({ reducedMotion: width === 390 ? "no-preference" : "reduce" });
  const assertGeometry = async () => {
    const geometry = await page.evaluate(() => {
      const main = document.querySelector("main")!.getBoundingClientRect();
      return { viewport: innerWidth, left: main.left, right: innerWidth - main.right, width: main.width, overflow: document.documentElement.scrollWidth > innerWidth + 1 };
    });
    assert.equal(geometry.overflow, false, `${width}px page must not overflow horizontally`);
    assert.ok(Math.abs(geometry.left - geometry.right) < 2, "main content must be centered");
    assert.ok(geometry.width <= 1200, "workspace must keep a readable maximum width");
  };
  await page.getByLabel("Cari simbol", { exact: true }).waitFor();
  const evidence = page.locator('a[href^="https://github.com/"]').first();
  const href = await evidence.getAttribute("href");
  assert.ok(href?.startsWith(`https://github.com/${model.snapshot.repository}/blob/${model.snapshot.commitSha}/`), "evidence must link to the immutable snapshot");
  assert.match(href!, /#L\d+(?:-L\d+)?$/);
  assert.equal(await evidence.getAttribute("rel"), "noopener noreferrer");
  assert.equal(await evidence.getAttribute("target"), "_blank");
  assert.ok(await page.locator("tbody tr").count() <= 5, "initial catalog must be bounded and closed relations lazy-mounted");
  const nextPage = page.getByRole("button", { name: "Berikutnya", exact: true });
  if (model.interfaceCatalog.entries.length > 5) {
    const firstRow = await page.locator("tbody tr").first().innerText();
    await nextPage.click();
    assert.notEqual(await page.locator("tbody tr").first().innerText(), firstRow, "pagination must reveal different declarations");
    await page.getByRole("button", { name: "Sebelumnya", exact: true }).click();
  }
  const relationSummary = page.locator("summary", { hasText: /^Relasi dan evidence \(/ });
  if (model.interfaceCatalog.relations.length) {
    await relationSummary.click();
    const relationTable = page.getByRole("table").filter({ has: page.getByRole("columnheader", { name: "Source", exact: true }) });
    await relationTable.waitFor();
    assert.ok(await relationTable.locator("tbody tr").count() <= 10);
    await relationSummary.click();
    assert.equal(await relationTable.count(), 0, "closing relations must unmount their rows");
  }
  const search = page.getByLabel("Cari simbol", { exact: true });
  await search.fill("UI05_NO_SUCH_SYMBOL");
  await page.waitForFunction(() => document.querySelectorAll("tbody tr").length === 0);
  assert.equal(await page.locator("tbody tr").count(), 0, "search must filter catalog rows");
  await search.fill("");
  await page.locator("tbody tr").first().waitFor();
  await assertGeometry();
  assert.equal(await page.getByRole("link", { name: /pratinjau/i }).count(), 0);
  await page.screenshot({ path: join(output, `workspace-catalog-${width}.png`), fullPage: true });

  await page.goto(`${base}/analyses/${analysisId}/graph`, { waitUntil: "networkidle" });
  const canvas = page.getByRole("region", { name: "Kanvas knowledge graph", exact: true });
  await canvas.locator("canvas").first().waitFor();
  await assertGeometry();
  await page.getByRole("button", { name: "Perbesar", exact: true }).click();
  await page.getByRole("button", { name: "Sesuaikan tampilan", exact: true }).click();
  await page.screenshot({ path: join(output, `workspace-network-${width}.png`), fullPage: true });

  await clockProbe.start();
  await page.goto(`${base}/analyses/${analysisId}`, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: model.snapshot.repository, exact: true }).waitFor();
  await assertGeometry();
  const timer = page.getByRole("timer");
  await timer.waitFor();
  const animation = await timer.locator('span[aria-hidden="true"]').evaluate(el => getComputedStyle(el).animationName);
  assert.equal(animation === "none", width !== 390, "loading animation must respect reduced motion");
  const firstTime = await timer.getAttribute("aria-label");
  await page.waitForFunction(label => document.querySelector('[role="timer"]')?.getAttribute("aria-label") !== label, firstTime);
  await page.screenshot({ path: join(output, `workspace-progress-${width}.png`), fullPage: true });
  await clockProbe.finish();
  await page.waitForFunction(() => document.querySelector('[role="timer"]')?.getAttribute("aria-label")?.startsWith("Durasi analisis:"));
  const terminalTime = await timer.getAttribute("aria-label");
  await page.waitForTimeout(1250);
  assert.equal(await timer.getAttribute("aria-label"), terminalTime, "terminal duration must stop ticking");
  await page.goto(`${base}/analyses/${analysisId}/document`, { waitUntil: "networkidle" });
  await page.getByLabel("Cari simbol", { exact: true }).waitFor();
}
