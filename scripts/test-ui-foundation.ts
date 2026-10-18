import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, type Page } from "playwright";
const baseUrl = (process.env.BASE_URL ?? "http://127.0.0.1:3000").replace(/\/$/, "");
const output = resolve(process.env.UI_EVIDENCE_DIR ?? "artifacts/ui-01");
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const checks: { name: string; status: string }[] = [];
const contrastAudits: { scenario: string; textNodes: number; minimumRatio: number }[] = [];
const errors: string[] = []; const productRequests: string[] = [];
async function check(name: string, action: () => Promise<void>) { await action(); checks.push({ name, status: "PASS" }); }
async function scenario(page: Page, value: string) { await page.getByLabel("Kondisi pratinjau").selectOption(value); }
async function navigate(page: Page, label: string) { await page.getByRole("navigation", { name: "Navigasi pratinjau" }).getByRole("button", { name: label }).click(); await page.waitForFunction(() => document.activeElement?.id === "konten-utama"); }
async function visible(page: Page, text: string) { await page.getByText(text, { exact: true }).filter({ visible: true }).first().waitFor({ state: "visible" }); }
async function screenshot(page: Page, file: string) { await page.evaluate(() => window.scrollTo(0, 0)); await page.screenshot({ path: resolve(output, file), fullPage: true }); }
try {
  for (const width of [360, 390, 768, 1024, 1440]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 }, reducedMotion: "reduce" });
    page.on("pageerror", error => errors.push(`${width}: ${error.message}`));
    page.on("request", request => { if (new URL(request.url()).pathname.startsWith("/api/") || new URL(request.url()).hostname.endsWith("github.com")) productRequests.push(request.url()); });
    await page.goto(`${baseUrl}/ui-preview`, { waitUntil: "networkidle" });
    await check(`${width}: Indonesian fixture banner and skip link`, async () => {
      assert.equal(await page.locator("html").getAttribute("lang"), "id");
      await visible(page, "Data contoh · Tidak terhubung ke GitHub");
      await page.keyboard.press("Tab"); assert.equal(await page.evaluate(() => document.activeElement?.textContent), "Lewati navigasi");
      await page.keyboard.press("Enter"); assert.equal(await page.evaluate(() => document.activeElement?.id), "konten-utama");
    });
    await check(`${width}: login loading/denial/error/retry/connected`, async () => {
      await scenario(page, "loading"); assert.equal(await page.getByRole("button", { name: "Menghubungkan…", exact: true }).isDisabled(), true);
      await scenario(page, "denied"); await visible(page, "Izin GitHub belum diberikan");
      await scenario(page, "error"); await visible(page, "Koneksi GitHub gagal");
      await page.getByRole("button", { name: "Coba Lagi", exact: true }).click(); await visible(page, "Contoh koneksi berhasil");
      await scenario(page, "idle"); await screenshot(page, `login-${width}.png`);
    });
    await navigate(page, "Pilih Repository");
    await check(`${width}: keyboard navigation focus`, async () => {
      assert.equal(await page.evaluate(() => document.activeElement?.id), "konten-utama");
      await page.getByRole("navigation").getByRole("button", { name: "Pilih Repository" }).focus();
      await page.keyboard.press("ArrowRight"); // Native buttons retain normal Tab order; no custom arrow-key trap.
      await page.keyboard.press("Tab"); assert.match(await page.evaluate(() => document.activeElement?.textContent ?? ""), /Progres Analisis/);
      assert.equal(await page.evaluate(() => getComputedStyle(document.activeElement!).outlineStyle), "solid");
    });
    await check(`${width}: repository loading/empty/error/retry/search`, async () => {
      await scenario(page, "loading"); await visible(page, "Memuat daftar repository…");
      await scenario(page, "empty"); await visible(page, "Belum ada repository terotorisasi");
      await scenario(page, "error"); await visible(page, "Daftar repository gagal dimuat");
      await page.getByRole("button", { name: "Coba Lagi", exact: true }).click();
      assert.equal(await page.getByLabel("Cari repository terotorisasi").evaluate(element => element === document.activeElement), true);
      await page.getByLabel("Cari repository terotorisasi").fill("tidak-ada"); await visible(page, "Repository tidak ditemukan");
      await page.getByRole("button", { name: "Reset pencarian" }).click(); assert.equal(await page.getByRole("radio").count(), 3);
    });
    await check(`${width}: selected target + invalid/valid commit and public input`, async () => {
      const submit = page.getByRole("button", { name: "Pratinjau target analisis", exact: true });
      assert.equal(await submit.isDisabled(), true);
      await page.getByRole("radio").first().check(); await page.getByLabel("Commit", { exact: false }).fill("bukan-sha"); await submit.click();
      await visible(page, "Commit harus berisi 7–40 karakter heksadesimal, atau kosongkan.");
      assert.equal(await page.getByLabel("Commit", { exact: false }).evaluate(element => element === document.activeElement), true);
      await page.getByLabel("Commit", { exact: false }).fill("a1b2c3d"); await submit.click(); await visible(page, "Target contoh valid secara format");
      await page.getByLabel("Branch", { exact: true }).selectOption("develop"); assert.equal(await page.getByLabel("Commit", { exact: false }).inputValue(), "");
      await page.getByLabel("Owner/repository atau URL GitHub").fill("https://evil.test/owner/repo"); await page.getByRole("button", { name: "Gunakan target publik" }).click();
      await visible(page, "Gunakan owner/repository atau URL HTTPS github.com yang valid.");
      await page.getByLabel("Owner/repository atau URL GitHub").fill("https://github.com/owner/" + "r".repeat(100)); await page.getByRole("button", { name: "Gunakan target publik" }).click();
      await visible(page, "Target contoh · belum diverifikasi ke GitHub");
      await screenshot(page, `repository-${width}.png`);
    });
    await check(`${width}: branch loading/empty/error/retry and stale target`, async () => {
      await scenario(page, "branch-loading"); await visible(page, "Memuat branch…");
      await scenario(page, "branch-empty"); await visible(page, "Repository ini belum memiliki branch.");
      await scenario(page, "branch-error"); await visible(page, "Branch gagal dimuat");
      await page.getByRole("button", { name: "Coba Lagi", exact: true }).click(); assert.equal(await page.getByLabel("Branch", { exact: true }).isDisabled(), false);
      await scenario(page, "branch-stale"); assert.equal(await page.getByLabel("Branch", { exact: true }).isDisabled(), true); assert.equal(await page.getByRole("button", { name: "Pratinjau target analisis", exact: true }).isDisabled(), true);
    });
    await check(`${width}: form usable with keyboard only`, async () => {
      await scenario(page, "ready");
      await page.getByRole("radio").first().focus(); await page.keyboard.press("Space"); assert.equal(await page.getByRole("radio").first().isChecked(), true);
      await page.getByLabel("Branch", { exact: true }).focus(); await page.keyboard.press("ArrowDown"); await page.keyboard.press("Enter");
      await page.getByLabel("Commit", { exact: false }).focus(); await page.keyboard.type("a1b2c3d"); await page.keyboard.press("Enter"); await visible(page, "Target contoh valid secara format");
      await page.getByLabel("Branch", { exact: true }).selectOption("main"); assert.equal(await page.getByText("Target contoh valid secara format", { exact: true }).count(), 0);
    });
    await navigate(page, "Progres Analisis");
    await check(`${width}: queue/running/failure, downstream pending and retry`, async () => {
      await scenario(page, "QUEUED"); assert.equal(await page.locator("[data-stage-state='PENDING']").count(), 9);
      await scenario(page, "RUNNING"); assert.equal(await page.locator("[aria-current='step']").count(), 1);
      await scenario(page, "FAILED"); assert.equal(await page.locator("[data-stage-state='FAILED']").count(), 1); assert.equal(await page.locator("[data-stage-state='PENDING']").count(), 6);
      assert.equal(await page.getByRole("button", { name: "Lihat Hasil Analisis" }).isDisabled(), true);
      await screenshot(page, `progress-failed-${width}.png`);
      await page.getByRole("button", { name: "Simulasikan Coba Lagi" }).click(); await visible(page, "fixture-analysis-retry");
      await visible(page, "a1b2c3d4e5f678901234567890abcdef12345678");
    });
    await check(`${width}: completed/limitations, no fake result + loading/error/empty`, async () => {
      await scenario(page, "COMPLETED"); assert.equal(await page.locator("[data-stage-state='COMPLETED']").count(), 9);
      assert.equal(await page.getByRole("button", { name: "Lihat Hasil Analisis" }).isDisabled(), true);
      await scenario(page, "COMPLETED_WITH_LIMITATIONS"); await visible(page, "Contoh: pemanggilan dinamis tetap Unresolved; antarmuka tidak menebak target relasinya.");
      await screenshot(page, `progress-completed-${width}.png`);
      await scenario(page, "loading"); await visible(page, "Memuat progres analisis…");
      await scenario(page, "error"); await visible(page, "Progres belum dapat dimuat"); await page.getByRole("button", { name: "Coba Lagi", exact: true }).click();
      await scenario(page, "empty"); await visible(page, "Belum ada analisis dipilih"); await page.locator("main").getByRole("button", { name: "Pilih Repository", exact: true }).click();
    });
    await check(`${width}: every screen/scenario without page overflow`, async () => {
      for (const [label, values] of [["Koneksi GitHub", ["idle", "loading", "denied", "error", "connected"]], ["Pilih Repository", ["ready", "loading", "empty", "error", "branch-loading", "branch-empty", "branch-error", "branch-stale"]], ["Progres Analisis", ["QUEUED", "RUNNING", "FAILED", "COMPLETED", "COMPLETED_WITH_LIMITATIONS", "loading", "error", "empty"]]] as const) {
        await navigate(page, label);
        for (const value of values) {
          await scenario(page, value);
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${width}:${label}:${value}`);
          assert.equal(await page.getByRole("heading", { level: 1 }).count(), 1);
          const audit = await page.evaluate<{ failures: string[]; textNodes: number; minimumRatio: number }>(String.raw`(() => {
            const body = document.body;
            const rgb = (value) => (value.match(/[\d.]+/g) ?? []).map(Number);
            const luminance = (color) => color.slice(0, 3).map(v => { const c = v / 255; return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4; }).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
            const background = (node) => { if (!node) return [255, 255, 255]; const color = rgb(getComputedStyle(node).backgroundColor); const alpha = color.length > 3 ? color[3] : 1; const behind = alpha < 1 ? background(node.parentElement) : [255, 255, 255]; return color.slice(0, 3).map((v, i) => v * alpha + behind[i] * (1 - alpha)); };
            const failures = []; let textNodes = 0; let minimumRatio = 100;
            for (const node of Array.from(body.querySelectorAll("*"))) {
              if (node.closest('[aria-hidden="true"], button:disabled, input:disabled, select:disabled') || !node.getClientRects().length) continue;
              const ownText = Array.from(node.childNodes).filter(child => child.nodeType === Node.TEXT_NODE).map(child => child.textContent ?? "").join("").trim();
              const style = getComputedStyle(node);
              if (!ownText || style.visibility === "hidden" || style.display === "none") continue;
              const foreground = luminance(rgb(style.color)), behind = luminance(background(node));
              const ratio = (Math.max(foreground, behind) + .05) / (Math.min(foreground, behind) + .05);
              const large = parseFloat(style.fontSize) >= 24 || parseFloat(style.fontSize) >= 18.66 && Number(style.fontWeight) >= 700;
              textNodes++; minimumRatio = Math.min(minimumRatio, ratio);
              if (ratio + .01 < (large ? 3 : 4.5)) failures.push(ownText.slice(0, 70) + ": " + ratio.toFixed(2));
            }
            return { failures, textNodes, minimumRatio };
          })()`);
          assert.deepEqual(audit.failures, [], `Text contrast ${width}:${label}:${value}`);
          contrastAudits.push({ scenario: `${width}:${label}:${value}`, textNodes: audit.textNodes, minimumRatio: Number(audit.minimumRatio.toFixed(2)) });
        }
      }
    });
    await page.close();
  }
  await check("no browser errors or product/GitHub requests", async () => { assert.deepEqual(errors, []); assert.deepEqual(productRequests, []); });
  await writeFile(resolve(output, "browser-report.json"), JSON.stringify({ date: new Date().toISOString(), scope: "UI-01 component fixtures only; GitHub/API/analysis integration NOT_RUN", checks, pageErrors: errors, productRequests, contrastAudits, viewports: [360, 390, 768, 1024, 1440] }, null, 2) + "\n");
  console.log(JSON.stringify({ status: "PASS", checks: checks.length, contrastScenarios: contrastAudits.length, viewports: 5, productRequests: 0, pageErrors: 0 }));
} finally { await browser.close(); }
