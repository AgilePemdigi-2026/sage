import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { database, createSession } from "@sage/database";
import { chromium } from "playwright";
const db = database(); let sessionId: string | undefined;
const browser = await chromium.launch({ headless: true });
const base = process.env.SAGE_HTTP_BASE_URL ?? "http://web:3000";
const sha = "a".repeat(40);
const repo = { id: "1", fullName: "example/sample", private: false, defaultBranch: "main" };
const checks: string[] = [];
try {
  const user = await db.user.findFirst({ where: { login: process.env.SAGE_TEST_LOGIN ?? "" }, select: { id: true } }); assert.ok(user);
  const session = await createSession(db, user.id, { ttlMs: 180_000 }); sessionId = session.session.sessionId;
  await mkdir("artifacts/rep-01", { recursive: true });
  for (const width of [360, 390, 768, 1024, 1440]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 } });
    await context.addCookies([{ name: "sage_session", value: session.token, url: base, httpOnly: true, sameSite: "Lax" }]);
    const page = await context.newPage(); const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
    let mode = "ready";
    await page.route("**/api/**", async route => {
      const url = new URL(route.request().url()); let data: unknown;
      if (url.pathname === "/api/github/installations") data = { items: [{ id: "1", accountLogin: "example" }], nextPage: null };
      else if (url.pathname.endsWith("/repositories")) data = { items: [repo], nextPage: null };
      else if (url.pathname.endsWith("/branches")) {
        if (mode === "error") return route.fulfill({ status: 503, json: { error: { message: "Branch belum dapat dimuat." } } });
        data = { items: mode === "empty" ? [] : [{ name: "main", commitSha: sha }, { name: "feature/demo", commitSha: sha }], nextPage: null };
      } else if (url.pathname.endsWith("/target")) data = { repository: repo, branch: JSON.parse(route.request().postData()!).branch, commitSha: sha, branchHeadSha: sha };
      else return route.abort();
      await route.fulfill({ json: { data } });
    });
    await page.goto(`${base}/workspace/repositories`);
    await page.getByRole("button", { name: "example", exact: true }).click();
    const search = page.getByLabel("Cari pada repository yang sudah dimuat");
    await search.fill("missing"); await page.getByText("Tidak ada hasil pencarian pada halaman yang dimuat.").waitFor();
    await search.fill("sample"); await page.getByRole("button", { name: "Pilih example/sample", exact: true }).click();
    await page.getByLabel("Branch", { exact: true }).selectOption("feature/demo");
    await page.getByLabel("Commit (opsional)").fill("aaaaaaa");
    await page.getByRole("button", { name: "Periksa target", exact: true }).click();
    await page.getByText("Target tervalidasi", { exact: true }).waitFor();
    await page.getByLabel("Commit (opsional)").fill("bbbbbbb"); assert.equal(await page.getByText("Target tervalidasi", { exact: true }).count(), 0);
    await page.getByLabel("Branch", { exact: true }).selectOption("main"); assert.equal(await page.getByLabel("Commit (opsional)").inputValue(), "");
    mode = "error"; await page.getByRole("button", { name: "Muat ulang branch" }).click(); await page.getByRole("alert").waitFor();
    assert.equal(await page.getByRole("button", { name: "Periksa target", exact: true }).isDisabled(), true);
    mode = "empty"; await page.getByRole("button", { name: "Muat ulang branch" }).click(); await page.getByText("Repository ini belum memiliki branch.", { exact: false }).waitFor();
    mode = "ready"; await page.getByRole("button", { name: "Muat ulang branch" }).click(); await page.getByLabel("Branch", { exact: true }).selectOption("main");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.deepEqual(errors, []); checks.push(`${width}: search, selection, slash branch, target, stale reset, retry, empty, no overflow or JS errors`);
    await page.screenshot({ path: `artifacts/rep-01/target-${width}.png`, fullPage: true });
    await context.close();
  }
  const report = { checkedAt: new Date().toISOString(), scope: "Production UI with controlled API responses; real provider tested separately through HTTP", checks };
  await writeFile("artifacts/rep-01/ui-report.json", JSON.stringify(report, null, 2) + "\n"); console.log(JSON.stringify(report));
} finally { await browser.close(); if (sessionId) await db.session.deleteMany({ where: { id: sessionId } }); await db.$disconnect(); }
