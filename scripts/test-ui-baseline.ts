import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { createGraphFixture } from "../apps/web/app/graph-preview/fixture-data.ts";

const baseUrl = (process.env.BASE_URL ?? "http://127.0.0.1:3000").replace(/\/$/, "");
const output = resolve(process.env.QA03_EVIDENCE_DIR ?? "artifacts/qa-03-s1");
const viewports = [360, 390, 768, 1024, 1440];
const checks: Array<{ name: string; viewport: number; expected: unknown; actual: unknown; status: "PASS" | "FAIL" }> = [];
const errors: string[] = [];
const productRequests: string[] = [];
const browser = await chromium.launch({ headless: true });
await mkdir(output, { recursive: true });

async function record<T>(name: string, viewport: number, expected: unknown, collect: () => Promise<T>, passes: (actual: T) => boolean) {
  try {
    const actual = await collect();
    const status = passes(actual) ? "PASS" : "FAIL";
    checks.push({ name, viewport, expected, actual, status });
  } catch (error) {
    checks.push({ name, viewport, expected, actual: { error: error instanceof Error ? error.message : String(error) }, status: "FAIL" });
  }
}

async function zoom(page: import("playwright").Page): Promise<number> {
  return Number((await page.getByLabel("Tingkat zoom", { exact: true }).innerText()).replace("%", ""));
}

const fixture = createGraphFixture();
const fixtureFiles = fixture.payload.files.map(({ path, sha256, sizeBytes }) => ({ path, sha256, sizeBytes }));
const fixtureManifestSha256 = createHash("sha256").update(JSON.stringify(fixtureFiles), "utf8").digest("hex");
const startedAt = new Date().toISOString();
const stylesheetSha256 = createHash("sha256").update(await readFile("apps/web/components/graph-foundation/graph-foundation.module.css")).digest("hex");

try {
  for (const width of viewports) {
    const page = await browser.newPage({ viewport: { width, height: 1000 }, reducedMotion: "reduce" });
    // tsx preserves function names with this helper inside serialized callbacks.
    // Install it only in the test browser; it does not change application code.
    await page.addInitScript("globalThis.__name = (value) => value;");
    page.on("pageerror", error => errors.push(`${width}: ${error.message}`));
    page.on("request", request => {
      const url = new URL(request.url());
      if (url.pathname.startsWith("/api/") || url.hostname.endsWith("github.com")) productRequests.push(request.url());
    });
    await page.goto(`${baseUrl}/graph-preview`, { waitUntil: "networkidle" });
    await page.evaluate(() => document.fonts.ready);

    await record("graph accessible labels and focus route", width,
      { lang: "id", canvasRegion: "Kanvas knowledge graph", describedHelp: true, nodeList: "Pilih node untuk melihat detail", details: "Node terpilih", skipLinkFocusesMain: true },
      async () => {
        const canvas = page.getByRole("region", { name: "Kanvas knowledge graph", exact: true });
        const list = page.getByRole("group", { name: "Pilih node untuk melihat detail", exact: true });
        const details = page.getByRole("region", { name: "Node terpilih", exact: true });
        await page.keyboard.press("Tab");
        const firstFocus = await page.evaluate(() => (document.activeElement as HTMLElement | null)?.textContent?.trim() ?? "");
        await page.keyboard.press("Enter");
        return {
          lang: await page.locator("html").getAttribute("lang"),
          canvasName: await canvas.getAttribute("aria-label"),
          canvasHelp: await canvas.getAttribute("aria-describedby"),
          helpText: await page.locator("#graph-canvas-help").innerText(),
          listName: await list.getAttribute("aria-label"),
          detailsHeading: await details.locator("h2").innerText(),
          firstFocus,
          mainFocused: await page.evaluate(() => document.activeElement?.id === "graph-content"),
        };
      },
      actual => actual.lang === "id" && actual.canvasName === "Kanvas knowledge graph" && actual.canvasHelp === "graph-canvas-help" && actual.helpText.includes("gunakan daftar node") && actual.listName === "Pilih node untuk melihat detail" && actual.detailsHeading === "Node terpilih" && actual.firstFocus === "Lewati navigasi" && actual.mainFocused,
    );

    await record("node list Enter/Space selection and visible focus", width,
      { tenNamedButtons: true, EnterSelectsSourceNode: true, SpaceSelectsUnresolved: true, onePressed: true, focusIndicatorVisible: true },
      async () => {
        const list = page.getByRole("group", { name: "Pilih node untuk melihat detail", exact: true });
        const buttons = list.getByRole("button");
        const first = buttons.first();
        await first.focus(); await page.keyboard.press("Enter");
        const firstPressed = await first.getAttribute("aria-pressed");
        const sourceVisible = await page.getByRole("region", { name: "Node terpilih" }).innerText();
        const unresolved = buttons.filter({ hasText: "UnresolvedReference" });
        await unresolved.focus(); await page.keyboard.press("Space");
        const focus = await unresolved.evaluate(element => ({ active: document.activeElement === element, outline: getComputedStyle(element).outlineStyle }));
        return { count: await buttons.count(), names: await buttons.allTextContents(), firstPressed, sourceVisible, unresolvedPressed: await unresolved.getAttribute("aria-pressed"), pressedCount: await list.locator('[aria-pressed="true"]').count(), unresolvedVisible: await page.getByText("Tidak memiliki deklarasi source; target relasi belum terpecahkan.", { exact: true }).count(), focus };
      },
      actual => actual.count === 10 && actual.names.every((name: string) => name.trim().length > 0) && actual.firstPressed === "true" && actual.sourceVisible.includes("src/report.ts:1") && actual.unresolvedPressed === "true" && actual.pressedCount === 1 && actual.unresolvedVisible === 1 && actual.focus.active && actual.focus.outline !== "none",
    );

    await record("zoom controls are named, keyboard-operable, and focused visibly", width,
      { buttons: ["Perbesar", "Perkecil", "Sesuaikan tampilan"], keyboardChangesZoom: true, focusOutline: "visible, at least 3:1" },
      async () => {
        const increase = page.getByRole("button", { name: "Perbesar", exact: true });
        const before = await zoom(page); await increase.focus(); await page.keyboard.press("Enter");
        await page.waitForFunction(previous => Number(document.querySelector('[aria-label="Tingkat zoom"]')?.textContent?.replace("%", "")) > previous, before);
        const increased = await zoom(page);
        const focus = await increase.evaluate(element => {
          const style = getComputedStyle(element);
          const parse = (value: string) => (value.match(/[\d.]+/g) ?? []).map(Number);
          const rgb = parse(style.outlineColor); const bg = parse(getComputedStyle(element.closest('section[aria-label="Knowledge graph contoh"]')!).backgroundColor);
          const lum = (c: number[]) => c.slice(0, 3).map(v => { const x = v / 255; return x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4; }).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
          const a = lum(rgb), b = lum(bg);
          return { active: document.activeElement === element, style: style.outlineStyle, width: style.outlineWidth, color: style.outlineColor, contrast: (Math.max(a, b) + .05) / (Math.min(a, b) + .05) };
        });
        const decrease = page.getByRole("button", { name: "Perkecil", exact: true });
        await decrease.focus(); await page.keyboard.press("Space");
        await page.waitForFunction(previous => Number(document.querySelector('[aria-label="Tingkat zoom"]')?.textContent?.replace("%", "")) < previous, increased);
        const decreased = await zoom(page);
        const fit = page.getByRole("button", { name: "Sesuaikan tampilan", exact: true });
        const beforeFit = await fit.getAttribute("aria-label"); await fit.focus(); await page.keyboard.press("Enter");
        return { names: await page.getByRole("button").allTextContents(), before, increased, decreased, fitName: beforeFit, focus };
      },
      actual => actual.increased > actual.before && actual.decreased < actual.increased && actual.fitName === "Sesuaikan tampilan" && actual.focus.active && actual.focus.style !== "none" && Number.parseFloat(actual.focus.width) >= 2 && actual.focus.contrast >= 3,
    );

    await record("visible DOM text contrast; canvas pixels excluded", width,
      { visibleDomText: "at least 4.5:1, or 3:1 for large text", canvasPixelAudit: "NOT_CHECKED" },
      async () => page.evaluate(() => {
        const parse = (value: string) => (value.match(/[\d.]+/g) ?? []).map(Number);
        const luminance = (color: number[]) => color.slice(0, 3).map(v => { const c = v / 255; return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4; }).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
        const background = (element: Element) => {
          const layers: Element[] = []; for (let node: Element | null = element; node; node = node.parentElement) layers.unshift(node);
          let color = [255, 255, 255];
          for (const layer of layers) { const values = parse(getComputedStyle(layer).backgroundColor); if (values.length >= 3) { const alpha = values[3] ?? 1; color = values.slice(0, 3).map((v, i) => v * alpha + color[i] * (1 - alpha)); } }
          return color;
        };
        const failures: string[] = []; let textNodes = 0; let minimumRatio = 100;
        for (const element of Array.from(document.body.querySelectorAll<HTMLElement>("*"))) {
          if (element.closest("canvas,[aria-hidden='true']") || !element.getClientRects().length) continue;
          const text = Array.from(element.childNodes).filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent ?? "").join("").trim();
          const style = getComputedStyle(element); if (!text || style.display === "none" || style.visibility === "hidden") continue;
          const foreground = luminance(parse(style.color)); const behind = luminance(background(element));
          const ratio = (Math.max(foreground, behind) + .05) / (Math.min(foreground, behind) + .05);
          const large = parseFloat(style.fontSize) >= 24 || parseFloat(style.fontSize) >= 18.66 && Number(style.fontWeight) >= 700;
          textNodes++; minimumRatio = Math.min(minimumRatio, ratio);
          if (ratio + .01 < (large ? 3 : 4.5)) failures.push(`${text.slice(0, 60)} (${ratio.toFixed(2)}:1)`);
        }
        return { textNodes, minimumRatio: Number(minimumRatio.toFixed(2)), failures, canvasElementsExcluded: document.querySelectorAll("canvas").length, canvasPixelAudit: "NOT_CHECKED" };
      }),
      actual => actual.textNodes > 0 && actual.failures.length === 0 && actual.canvasPixelAudit === "NOT_CHECKED",
    );

    await record("font loading and non-text control contrast inspection", width,
      { fonts: ["Inter", "JetBrains Mono"], outlineContrast: "at least 3:1", controlBorderContrast: "at least 3:1", selectedStateBorderContrast: "at least 3:1" },
      async () => {
        const button = page.getByRole("button", { name: "Perbesar", exact: true });
        await button.focus();
        const styles = await button.evaluate(element => {
          const familyNames: string[] = [];
          document.fonts.forEach(face => { if (face.status === "loaded") familyNames.push(face.family.replace(/["']/g, "")); });
          const style = getComputedStyle(element); const parent = getComputedStyle(element.closest('section[aria-label="Knowledge graph contoh"]')!);
          return { loadedFonts: [...new Set(familyNames)], bodyFamily: getComputedStyle(document.body).fontFamily, controlFamily: style.fontFamily, border: style.borderTopColor, surface: parent.backgroundColor, selectedBorder: getComputedStyle(document.querySelector('[role="group"] button[aria-pressed="true"]')!).borderTopColor, selectedFill: getComputedStyle(document.querySelector('[role="group"] button[aria-pressed="true"]')!).backgroundColor };
        });
        const ratios = await button.evaluate(element => {
          const parse = (value: string) => (value.match(/[\d.]+/g) ?? []).map(Number);
          const lum = (value: string) => { const rgb = parse(value).slice(0, 3).map(v => { const c = v / 255; return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4; }); return rgb.reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0); };
          const ratio = (a: string, b: string) => { const x = lum(a), y = lum(b); return Number(((Math.max(x, y) + .05) / (Math.min(x, y) + .05)).toFixed(2)); };
          return { controlBorder: ratio(getComputedStyle(element).borderTopColor, getComputedStyle(element).backgroundColor), selectedStateBorder: ratio(getComputedStyle(document.querySelector('[role="group"] button[aria-pressed="true"]')!).borderTopColor, getComputedStyle(document.querySelector('[role="group"] button[aria-pressed="true"]')!).backgroundColor), focusOutline: ratio(getComputedStyle(element).outlineColor, getComputedStyle(element.closest('section[aria-label="Knowledge graph contoh"]')!).backgroundColor) };
        });
        return { ...styles, ratios, note: "Control borders and focus indicators measured from computed CSS; canvas label pixels are outside this DOM contrast audit." };
      },
      actual => actual.loadedFonts.some((family: string) => family.includes("Inter")) && actual.loadedFonts.some((family: string) => family.includes("JetBrains Mono")) && actual.bodyFamily.includes("Inter") && actual.controlFamily.includes("Inter") && actual.ratios.focusOutline >= 3 && actual.ratios.controlBorder >= 3 && actual.ratios.selectedStateBorder >= 3,
    );

    await record("viewport fit and isolated fixture behavior", width,
      { horizontalOverflow: false, apiOrGitHubRequests: 0, canvasTextPixelsAudited: false },
      async () => ({ overflow: await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), fixtureLabel: await page.getByText("Fixture tervalidasi · Tidak terhubung ke GitHub", { exact: true }).count(), canvasCount: await page.locator("canvas").count(), canvasTextPixelsAudited: false, requests: productRequests.length }),
      actual => !actual.overflow && actual.fixtureLabel === 1 && actual.canvasCount > 0 && actual.requests === 0 && !actual.canvasTextPixelsAudited,
    );
    if (width === 360 || width === 1440) await page.screenshot({ path: resolve(output, `graph-addon-${width}.png`), fullPage: true });
    await page.close();
  }
} finally {
  await browser.close();
}

const fixtureManifest = { snapshotSha: fixture.payload.snapshot.commitSha, files: fixtureFiles, manifestSha256: fixtureManifestSha256 };
const report = {
  startedAt, completedAt: new Date().toISOString(), status: checks.every(check => check.status === "PASS") && errors.length === 0 && productRequests.length === 0 ? "PASS" : "FAIL",
  scope: "QA-03-S1 graph/UI foundation addon; fixture-only browser review. Full UI product acceptance remains open under QA-03 (#25).",
  command: "npx tsx scripts/test-ui-baseline.ts",
  baseUrl, viewports, checks, errors, productRequests,
  environment: { node: process.version, platform: process.platform, arch: process.arch, browser: browser.version(), applicationBaseCommitSha: process.env.QA_APP_COMMIT_SHA ?? null, stylesheetSha256, runId: process.env.QA_RUN_ID ?? null },
  fixture: fixtureManifest,
  limitations: ["Canvas-rendered graph label pixels were excluded; contrast checks cover visible DOM text and computed CSS control/focus colors.", "Fixture routes do not exercise GitHub, repository, queue, analysis, or result integrations."],
};
await writeFile(resolve(output, "baseline-addon-report.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ status: report.status, checks: checks.length, failures: checks.filter(check => check.status === "FAIL").length, viewports: viewports.length, fixtureManifestSha256, report: resolve(output, "baseline-addon-report.json") }));
if (report.status !== "PASS") process.exitCode = 1;
