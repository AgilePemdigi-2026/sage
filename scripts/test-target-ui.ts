import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { database, createSession } from "@sage/database";
import { chromium } from "playwright";
const db = database(); let sessionId: string | undefined; let fixtureUserId: string | undefined;
const browser = await chromium.launch({ headless: true });
const base = process.env.SAGE_HTTP_BASE_URL ?? "http://web:3000";
const sha = "a".repeat(40);
const repo = { id: "1", fullName: "example/sample", private: false, defaultBranch: "main" };
const publicRepo = { id: "3", fullName: "octocat/Hello-World", private: false, defaultBranch: "main" };
const checks: string[] = [];
const output = process.env.TARGET_UI_EVIDENCE_DIR ?? "artifacts/rep-01";
try {
  // Controlled API replay can use a disposable identity without changing real OAuth credentials.
  if (process.env.SAGE_TEST_FIXTURE_USER === "1") {
    const suffix = randomUUID();
    const fixture = await db.user.create({ data: { githubUserId: `ui-${suffix}`, login: `ui-${suffix}` } });
    fixtureUserId = fixture.id;
    await db.gitHubConnection.create({ data: {
      userId: fixture.id, githubUserId: `ui-${suffix}`, githubLogin: "example",
      encryptedToken: "controlled-ui-fixture-not-a-token", tokenNonce: "fixture", tokenAuthTag: "fixture", encryptionKeyId: "fixture",
    } });
  }
  const user = fixtureUserId ? { id: fixtureUserId } : await db.user.findFirst({ where: { login: process.env.SAGE_TEST_LOGIN ?? "" }, select: { id: true } }); assert.ok(user);
  const session = await createSession(db, user.id, { ttlMs: 180_000 }); sessionId = session.session.sessionId;
  await mkdir(output, { recursive: true });
  for (const width of [360, 390, 768, 1024, 1440]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 } });
    await context.addCookies([{ name: "sage_session", value: session.token, url: base, httpOnly: true, sameSite: "Lax" }]);
    const page = await context.newPage(); const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
    let mode = "ready";
    let installationMode = "ready";
    let resolveFails = false;
    let targetFails = false;
    let analysisRequests = 0;
    const submittedTargets: Array<{ repository: string; branch: string; commit: string | null }> = [];
    page.on("request", request => { if (new URL(request.url()).pathname === "/api/analyses") analysisRequests++; });
    await page.route("**/api/**", async route => {
      const url = new URL(route.request().url()); let data: unknown;
      if (url.pathname === "/api/github/installations") {
        if (installationMode === "error") return route.fulfill({ status: 503, json: { error: { message: "Instalasi belum tersedia." } } });
        data = { items: installationMode === "empty" ? [] : url.searchParams.get("page") === "2" ? [{ id: "2", accountLogin: "other" }] : [{ id: "1", accountLogin: "example" }], nextPage: installationMode === "empty" || url.searchParams.get("page") === "2" ? null : 2 };
      }
      else if (url.pathname.endsWith("/repositories")) data = { items: url.searchParams.get("page") === "2" ? [{ ...repo, id: "2", fullName: "example/private", private: true }] : [repo], nextPage: url.searchParams.get("page") === "2" ? null : 2 };
      else if (url.pathname.endsWith("/resolve")) {
        if (resolveFails) return route.fulfill({ status: 400, json: { error: { message: "Gunakan URL github.com yang valid." } } });
        data = publicRepo;
      }
      else if (url.pathname.endsWith("/branches")) {
        if (mode === "error") return route.fulfill({ status: 503, json: { error: { message: "Branch belum dapat dimuat." } } });
        data = { items: mode === "empty" ? [] : url.searchParams.get("page") === "2" ? [{ name: "feature/demo", commitSha: sha }, { name: "release", commitSha: sha }] : [{ name: "main", commitSha: sha }, { name: "feature/demo", commitSha: sha }], nextPage: mode === "empty" || url.searchParams.get("page") === "2" ? null : 2 };
      } else if (url.pathname.endsWith("/target")) {
        const payload = JSON.parse(route.request().postData()!); submittedTargets.push(payload);
        if (targetFails) return route.fulfill({ status: 400, json: { error: { message: "Commit tidak berada pada branch ini." } } });
        data = { repository: payload.repository === publicRepo.fullName ? publicRepo : repo, branch: payload.branch, commitSha: sha, branchHeadSha: sha };
      }
      else return route.abort();
      await route.fulfill({ json: { data } });
    });
    await page.goto(`${base}/workspace/repositories`);
    await page.getByRole("button", { name: "Instalasi berikutnya", exact: true }).click();
    await page.getByRole("button", { name: "other", exact: true }).waitFor();
    await page.getByRole("button", { name: "example", exact: true }).click();
    await page.getByRole("button", { name: "Repository berikutnya", exact: true }).click();
    await page.getByRole("button", { name: "Pilih example/private", exact: true }).waitFor();
    const search = page.getByLabel("Cari pada repository yang sudah dimuat");
    await search.fill("missing"); await page.getByText("Tidak ada hasil pencarian pada halaman yang dimuat.").waitFor();
    await search.fill("sample"); await page.getByRole("button", { name: "Pilih example/sample", exact: true }).click();
    await page.getByRole("button", { name: "Muat branch berikutnya", exact: true }).click();
    await page.getByLabel("Branch", { exact: true }).locator('option[value="release"]').waitFor({ state: "attached" });
    assert.equal(await page.getByLabel("Branch", { exact: true }).locator('option[value="feature/demo"]').count(), 1);
    assert.equal(await page.getByLabel("Branch", { exact: true }).locator('option[value="release"]').count(), 1);
    await page.getByLabel("Branch", { exact: true }).selectOption("feature/demo");
    await page.getByLabel("Commit (opsional)").fill("aaaaaaa");
    await page.getByRole("button", { name: "Periksa target", exact: true }).click();
    await page.getByText("Target tervalidasi", { exact: true }).waitFor();
    assert.deepEqual(submittedTargets.at(-1), { repository: repo.fullName, branch: "feature/demo", commit: "aaaaaaa" });
    await page.getByLabel("Commit (opsional)").fill("bbbbbbb"); assert.equal(await page.getByText("Target tervalidasi", { exact: true }).count(), 0);
    await page.getByLabel("Branch", { exact: true }).selectOption("main"); assert.equal(await page.getByLabel("Commit (opsional)").inputValue(), "");
    mode = "error"; await page.getByRole("button", { name: "Muat ulang branch" }).click(); await page.getByRole("alert").waitFor();
    assert.equal(await page.getByRole("button", { name: "Periksa target", exact: true }).isDisabled(), true);
    mode = "empty"; await page.getByRole("button", { name: "Muat ulang branch" }).click(); await page.getByText("Repository ini belum memiliki branch.", { exact: false }).waitFor();
    mode = "ready"; await page.getByRole("button", { name: "Muat ulang branch" }).click(); await page.getByLabel("Branch", { exact: true }).selectOption("main");
    const publicInput = page.getByLabel("Nama atau URL GitHub");
    resolveFails = true; await publicInput.fill("https://127.0.0.1/private");
    await page.getByRole("button", { name: "Periksa repository", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "Gunakan URL github.com" }).waitFor();
    resolveFails = false; await publicInput.fill("https://github.com/octocat/Hello-World");
    await page.getByRole("button", { name: "Periksa repository", exact: true }).click();
    await page.getByRole("button", { name: "Pilih octocat/Hello-World", exact: true }).click();
    await page.getByRole("button", { name: "Periksa target", exact: true }).click();
    await page.getByText("Target tervalidasi", { exact: true }).waitFor();
    assert.deepEqual(submittedTargets.at(-1), { repository: publicRepo.fullName, branch: "main", commit: null });
    targetFails = true; await page.getByLabel("Commit (opsional)").fill("bbbbbbb");
    await page.getByRole("button", { name: "Periksa target", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "Commit tidak berada" }).waitFor();
    assert.equal(await page.getByText("Target tervalidasi", { exact: true }).count(), 0);
    targetFails = false; await page.getByRole("button", { name: "Periksa target", exact: true }).click();
    await page.getByText("Target tervalidasi", { exact: true }).waitFor();
    installationMode = "error"; await page.getByRole("button", { name: "Muat ulang instalasi", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "Instalasi belum tersedia" }).waitFor();
    installationMode = "empty"; await page.getByRole("button", { name: "Muat ulang instalasi", exact: true }).click();
    await page.getByText("Belum ada instalasi yang dapat diakses.", { exact: false }).waitFor();
    installationMode = "ready"; await page.getByRole("button", { name: "Muat ulang instalasi", exact: true }).click();
    await page.getByRole("button", { name: "example", exact: true }).waitFor();
    assert.equal(analysisRequests, 0, "Target validation must not submit analysis jobs");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.deepEqual(errors, []); checks.push(`${width}: installation/repository/branch pagination, branch deduplication, search, private card, public form and invalid URL feedback, slash branch, explicit/empty commit payload, stale reset, target error/retry, branch/installation error/empty/retry, no analysis submission, no overflow or JS errors`);
    await page.screenshot({ path: `${output}/target-${width}.png`, fullPage: true });
    await context.close();
  }
  const report = { checkedAt: new Date().toISOString(), scope: "Production UI with controlled API responses; real provider tested separately through HTTP", checks };
  await writeFile(`${output}/ui-report.json`, JSON.stringify(report, null, 2) + "\n"); console.log(JSON.stringify(report));
} finally { await browser.close(); if (sessionId) await db.session.deleteMany({ where: { id: sessionId } }); if (fixtureUserId) await db.user.delete({ where: { id: fixtureUserId } }); await db.$disconnect(); }
