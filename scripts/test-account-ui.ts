import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createSession, database, storeGitHubCredential } from "@sage/database";
import { chromium, request, type BrowserContext } from "playwright";

// Real application/session checks, controlled repository metadata. No OAuth token
// is borrowed from another user and no provider permissions are simulated as live.
const db = database();
const base = process.env.SAGE_HTTP_BASE_URL ?? "http://web:3000";
const output = resolve(process.env.ACCOUNT_UI_EVIDENCE_DIR ?? resolve(process.env.STORAGE_ROOT ?? "artifacts", "account-isolation"));
const users: string[] = [];
const sessions: string[] = [];
const browser = await chromium.launch({ headless: true });
const api = await request.newContext({ baseURL: base });
const checks: string[] = [];
let failed = false;
try {
  await mkdir(output, { recursive: true });
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  async function fixture(label: string) {
    const login = `${label}-${suffix}`;
    const accountKey = `account-ui-${login}`;
    const user = await db.user.create({ data: { login, githubUserId: accountKey } });
    users.push(user.id);
    await storeGitHubCredential(db, user.id, { githubUserId: accountKey, githubLogin: login, accessToken: `synthetic-not-provider-${label}` });
    const session = await createSession(db, user.id, { ttlMs: 600_000 });
    sessions.push(session.session.sessionId);
    return { login, accountKey, token: session.token };
  }
  const a = await fixture("alpha"); const b = await fixture("beta");
  const headers = (account: typeof a, expected = account.accountKey) => ({ Cookie: `sage_session=${account.token}`, "X-SAGE-Account": expected });
  assert.equal((await api.get("/api/auth/session")).status(), 401);
  for (const account of [a, b, a]) {
    const response = await api.get("/api/auth/session", { headers: headers(account) });
    assert.equal(response.status(), 200);
    assert.deepEqual((await response.json()).data, { accountKey: account.accountKey, login: account.login });
    assert.match(response.headers()["cache-control"], /no-store/);
  }
  for (const path of ["/api/auth/session", "/api/repositories/public", "/api/github/installations", "/api/repositories/branches?repository=octocat/Hello-World"]) {
    const response = await api.get(path, { headers: headers(b, a.accountKey) });
    assert.equal(response.status(), 401, `old account binding must be rejected: ${path}`);
    const text = await response.text();
    assert.ok(!text.includes(a.token) && !text.includes(b.token) && !text.includes("synthetic-not-provider"));
  }
  assert.equal((await api.get("/api/repositories/public?owner=other", { headers: headers(a) })).status(), 400);
  const corrupt = await fixture("mismatch");
  await db.gitHubConnection.updateMany({ where: { userId: users[2] }, data: { githubUserId: a.accountKey } });
  assert.equal((await api.get("/api/auth/session", { headers: headers(corrupt) })).status(), 401);
  const expired = await fixture("expired");
  await db.gitHubConnection.updateMany({ where: { userId: users[3] }, data: { tokenExpiresAt: new Date(Date.now() - 60_000) } });
  assert.equal((await api.get("/api/auth/session", { headers: headers(expired) })).status(), 401);
  checks.push("real Next/DB: two session identities stay separate; stale account headers rejected before provider access; owner override rejected; no secrets in JSON");
  checks.push("real Next/DB: mismatched connection identity and expired provider authorization rejected");

  for (const width of [360, 390, 768, 1024, 1440]) {
    const context: BrowserContext = await browser.newContext({ viewport: { width, height: 1000 } });
    const cookie = (account: typeof a) => ({ name: "sage_session", value: account.token, url: base, httpOnly: true, sameSite: "Lax" as const });
    await context.addCookies([cookie(a)]);
    const page = await context.newPage(); page.setDefaultTimeout(20_000);
    let releaseOldResponse: () => void = () => {};
    let oldResponseFinished: () => void = () => {};
    let oldRequestStarted: () => void = () => {};
    const oldRequest = new Promise<void>(done => { oldRequestStarted = done; });
    const oldResponse = new Promise<void>(done => { releaseOldResponse = done; });
    const oldResponseDone = new Promise<void>(done => { oldResponseFinished = done; });
    const pageErrors: string[] = [];
    page.on("pageerror", error => pageErrors.push(error.message));
    // Only repository/provider responses are controlled. The identity endpoint
    // and SSR guard remain genuine, including account-header mismatch checks.
    await page.route("**/api/github/installations?*", route => route.fulfill({ json: { data: { items: [], nextPage: null } } }));
    await page.route("**/api/repositories/public?*", async route => {
      const accountKey = route.request().headers()["x-sage-account"];
      const account = accountKey === b.accountKey ? b : a;
      if (account === a && new URL(route.request().url()).searchParams.get("page") === "2") {
        oldRequestStarted();
        await oldResponse;
        try { await route.fulfill({ json: { data: { items: [{ id: "99", fullName: `${a.login}/late-result`, private: false, defaultBranch: "main" }], nextPage: null } } }); }
        catch { /* Navigation may have cancelled the old request, which is safe. */ }
        finally { oldResponseFinished(); }
        return;
      }
      const item = { id: account === a ? "1" : "2", fullName: `${account.login}/public-code`, private: false, defaultBranch: "main" };
      await route.fulfill({ json: { data: { items: [item], nextPage: account === a ? 2 : null } } });
    });
    await page.route("**/api/repositories/branches?*", route => route.fulfill({ json: { data: { items: [{ name: "main", commitSha: "a".repeat(40) }], nextPage: null } } }));
    await page.goto(`${base}/workspace/repositories`);
    const oldName = `${a.login}/public-code`; const newName = `${b.login}/public-code`;
    await page.getByRole("button", { name: `Pilih ${oldName}`, exact: true }).click();
    await page.getByRole("heading", { name: `Versi kode: ${oldName}`, exact: true }).waitFor();
    await page.getByLabel("Branch", { exact: true }).locator('option[value="main"]').waitFor({ state: "attached" });
    await page.getByLabel("Commit (opsional)").fill("aaaaaaa");
    const sameAccountCheck = page.waitForResponse(response => new URL(response.url()).pathname === "/api/auth/session");
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await sameAccountCheck;
    await page.getByLabel("Commit (opsional)").waitFor();
    assert.equal(await page.getByLabel("Commit (opsional)").inputValue(), "aaaaaaa", "returning focus with the same account preserves target input");
    await page.getByRole("button", { name: "Repository public berikutnya", exact: true }).click();
    await oldRequest;
    // Simulate a login in another tab by replacing the browser's shared cookie.
    // The tab stays mounted until its real identity check forces a fresh page.
    await context.addCookies([cookie(b)]);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await page.getByRole("button", { name: `Pilih ${newName}`, exact: true }).waitFor();
    releaseOldResponse();
    await oldResponseDone;
    await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
    assert.ok((await page.locator("body").textContent())?.includes(`@${b.login}`));
    assert.equal(await page.getByText(oldName, { exact: true }).count(), 0);
    assert.equal(await page.getByText(`${a.login}/late-result`, { exact: true }).count(), 0);
    assert.equal(await page.getByRole("heading", { name: `Versi kode: ${oldName}`, exact: true }).count(), 0);
    assert.equal(await page.getByRole("button", { name: "Periksa target", exact: true }).count(), 0);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "no horizontal overflow");
    assert.deepEqual(pageErrors, []);
    await page.screenshot({ path: resolve(output, `account-switch-${width}.png`), fullPage: true });
    checks.push(`${width}px: own public list without installations, direct branch selection, same-account focus preserves commit, shared-cookie account switch clears prior repository/target including pending old response, no overflow/page errors`);
    await context.close();
  }
} catch (error) {
  failed = true;
  console.error(error instanceof Error ? error.message : "Account regression failed");
} finally {
  await browser.close();
  await api.dispose();
  try { if (sessions.length) await db.session.deleteMany({ where: { id: { in: sessions } } }); }
  finally {
    try { if (users.length) await db.gitHubConnection.deleteMany({ where: { userId: { in: users } } }); }
    finally { if (users.length) await db.user.deleteMany({ where: { id: { in: users } } }); await db.$disconnect(); }
  }
  await mkdir(output, { recursive: true });
  const report = { checkedAt: new Date().toISOString(), status: failed ? "FAIL" : "PASS", checks, scope: "Real Next session/cookie/backend account boundaries with disposable identities; controlled repository/branch metadata, no live OAuth or pipeline acceptance" };
  await writeFile(resolve(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report));
}
if (failed) process.exitCode = 1;
