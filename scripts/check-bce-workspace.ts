import assert from "node:assert/strict";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import type { Page } from "playwright";

/** The browser reads a real owner-bound ADD; only its source snapshot is a test fixture. */
export async function checkBceWorkspace(page: Page, base: string, analysisId: string, output: string, width: number) {
  await page.goto(`${base}/analyses/${analysisId}/document`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "UML Class Diagram", exact: true }).click();
  await page.getByTestId("uml-bce-summary").waitFor();
  assert.match(await page.getByTestId("uml-bce-summary").innerText(), /5 dari 5 class\/interface/);
  const image = page.getByRole("img", { name: "UML Class Diagram", exact: true });
  await image.waitFor({ timeout: 30_000 });
  const result = await image.evaluate(async el => {
    const svg = await fetch(el.getAttribute("src")!).then(r => r.text());
    const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
    const viewBox = doc.documentElement.getAttribute("viewBox")!.split(/[ ,]+/).map(Number);
    return { svg, text: doc.documentElement.textContent ?? "", ratio: viewBox[2]! / viewBox[3]!, paths: doc.querySelectorAll("path").length };
  });
  for (const name of ["OrderEntity", "OrderService", "OrderController", "OrderView", "PriorityOrder", "boundary", "control", "entity", "calls"]) {
    assert.ok(result.text.includes(name), `real UML SVG contains ${name}`);
  }
  assert.ok(result.paths > 0, "UML has rendered relationship paths");
  const viewport = page.getByTestId("document-diagram-viewport");
  assert.ok(await viewport.evaluate(el => el.scrollHeight <= el.clientHeight + 2 && el.scrollWidth <= el.clientWidth + 2), "default fit must show the entire UML without internal scrolling");

  assert.ok(result.ratio <= 1.8, `main BCE UML must fit a portrait reading area; ratio=${result.ratio}`);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "BCE document has no page overflow");
  await writeFile(join(output, `bce-uml-${width}.svg`), result.svg);
  await page.screenshot({ path: join(output, `bce-uml-${width}.png`), fullPage: true });
}
