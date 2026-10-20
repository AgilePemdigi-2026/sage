import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { resolve } from "node:path";
import { createSession, database, disconnectDatabase } from "@sage/database";
import { chromium, request, type BrowserContext, type Page } from "playwright";

const browserOrigin = new URL(process.env.SAGE_HTTP_BASE_URL ?? "http://localhost:3000");
const transportOrigin = new URL(process.env.SAGE_HTTP_TRANSPORT_BASE_URL ?? browserOrigin.origin);
if (browserOrigin.pathname !== "/" || browserOrigin.search || browserOrigin.hash
  || transportOrigin.pathname !== "/" || transportOrigin.search || transportOrigin.hash) {
  throw new Error("Auth UI test origins must contain only an origin.");
}

const artifactDirectory = resolve(process.env.AUTH_UI_EVIDENCE_DIR ?? process.env.SAGE_AUTH_UI_ARTIFACT_DIR ?? "artifacts/auth-ui-regression");
const reportPath = resolve(artifactDirectory, "report.json");
const viewports = [360, 390, 768, 1024, 1440];
const checks: string[] = [];
const screenshots: string[] = [];
const oauthFlows: Array<{ state: string; browserToken: string }> = [];
const oauthAttemptStateHashes: string[] = [];
let githubRequestsBlocked = 0;
let interceptOAuthStart = false;
let fixtureUserId: string | undefined;
const fixtureSessionIds: string[] = [];
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let api: Awaited<ReturnType<typeof request.newContext>> | undefined;
let localProxy: ReturnType<typeof createServer> | undefined;
const db = database();
let runSucceeded = false;

function saveScreenshotName(name: string): string {
  screenshots.push(name);
  return resolve(artifactDirectory, name);
}

async function startLocalTransportProxy(): Promise<ReturnType<typeof createServer>> {
  if (browserOrigin.origin === transportOrigin.origin) {
    throw new Error("Run auth UI regression in the Docker worker with SAGE_HTTP_BASE_URL=http://localhost:3000 and SAGE_HTTP_TRANSPORT_BASE_URL=http://web:3000.");
  }
  if (browserOrigin.protocol !== "http:" || transportOrigin.protocol !== "http:"
    || !["localhost", "127.0.0.1"].includes(browserOrigin.hostname)) {
    throw new Error("The auth UI transport proxy requires local HTTP origins.");
  }

  const proxy = createServer((incoming, outgoing) => {
    const incomingUrl = new URL(incoming.url ?? "/", browserOrigin.origin);
    const headers = { ...incoming.headers };
    delete headers.host;
    headers.host = transportOrigin.host;
    const forwardedPath = `${incomingUrl.pathname}${incomingUrl.search}`;
    const upstream = httpRequest({
      hostname: transportOrigin.hostname,
      port: Number(transportOrigin.port || 80),
      path: forwardedPath,
      method: incoming.method,
      headers,
    }, (response) => {
      const responseHeaders: Record<string, string | string[]> = {};
      for (const [name, value] of Object.entries(response.headers)) {
        if (value !== undefined) responseHeaders[name] = value;
      }

      if (interceptOAuthStart && incoming.method === "POST" && incomingUrl.pathname === "/auth/github"
        && response.statusCode === 303) {
        const location = responseHeaders.location;
        const setCookie = responseHeaders["set-cookie"];
        if (typeof location !== "string" || !setCookie) {
          response.resume();
          outgoing.writeHead(502, { "Cache-Control": "no-store" });
          outgoing.end("Local auth test proxy rejected the OAuth response.");
          return;
        }
        let authorizeUrl: URL;
        try {
          authorizeUrl = new URL(location);
        } catch {
          response.resume();
          outgoing.writeHead(502, { "Cache-Control": "no-store" });
          outgoing.end("Local auth test proxy rejected the OAuth response.");
          return;
        }
        const state = authorizeUrl.searchParams.get("state");
        const cookieText = Array.isArray(setCookie) ? setCookie.join("\n") : setCookie;
        const cookieMatch = /(?:^|[\n,]\s*)sage_oauth_browser=([A-Za-z0-9_-]{43})(?:;|$)/.exec(cookieText);
        const browserToken = cookieMatch?.[1];
        if (state) oauthAttemptStateHashes.push(createHash("sha256").update(state).digest("hex"));
        if (authorizeUrl.origin !== "https://github.com" || authorizeUrl.pathname !== "/login/oauth/authorize"
          || !state || !browserToken) {
          response.resume();
          outgoing.writeHead(502, { "Cache-Control": "no-store" });
          outgoing.end("Local auth test proxy rejected the OAuth response.");
          return;
        }
        oauthFlows.push({ state, browserToken });
        const localDenial = new URL("/auth/github/callback", browserOrigin.origin);
        localDenial.searchParams.set("state", state);
        localDenial.searchParams.set("error", "access_denied");
        responseHeaders.location = localDenial.toString();
      }

      outgoing.statusCode = response.statusCode ?? 502;
      if (response.statusMessage) outgoing.statusMessage = response.statusMessage;
      outgoing.writeHead(outgoing.statusCode, responseHeaders);
      response.pipe(outgoing);
    });

    upstream.on("error", () => {
      if (!outgoing.headersSent) outgoing.writeHead(502, { "Cache-Control": "no-store" });
      outgoing.end("Local auth test transport is unavailable.");
    });
    incoming.pipe(upstream);
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    proxy.once("error", rejectListen);
    proxy.listen(Number(browserOrigin.port || 80), "127.0.0.1", () => {
      proxy.removeListener("error", rejectListen);
      resolveListen();
    });
  });
  return proxy;
}

async function installExternalRequestBlocker(context: BrowserContext): Promise<void> {
  await context.route("**/*", async (route) => {
    const incoming = new URL(route.request().url());
    if (incoming.origin !== browserOrigin.origin) {
      if (incoming.hostname === "github.com" || incoming.hostname.endsWith(".github.com")) githubRequestsBlocked++;
      await route.abort();
      return;
    }
    await route.continue();
  });
}

async function expectLogin(page: Page, error?: string): Promise<void> {
  const location = new URL(page.url());
  assert.equal(location.origin, browserOrigin.origin, "redirect must stay on the local app origin");
  assert.equal(location.pathname, "/login", "protected route must redirect to login");
  if (error) assert.equal(location.searchParams.get("error"), error, "login should expose only the expected safe error code");
}

async function assertNoHorizontalOverflow(page: Page): Promise<void> {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true,
    "page should fit the selected viewport width");
}

async function assertSafeLoginMessage(page: Page, expected: string): Promise<void> {
  const alert = page.locator("p[role=\"alert\"]");
  await alert.waitFor();
  assert.equal((await alert.textContent())?.trim(), expected, "login should show the safe Indonesian message");
}

function sessionCookie(value: string) {
  return {
    name: "sage_session",
    value,
    url: browserOrigin.origin,
    httpOnly: true,
    sameSite: "Lax" as const,
    secure: browserOrigin.protocol === "https:",
  };
}

async function assertUnauthorizedApi(path: string, method: "GET" | "POST", data?: unknown, idempotencyKey?: string): Promise<void> {
  assert.ok(api);
  const response = method === "GET"
    ? await api.get(path)
    : await api.post(path, {
      data,
      headers: {
        Origin: browserOrigin.origin,
        ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
      },
    });
  assert.equal(response.status(), 401, `${method} ${path} should reject an anonymous request`);
  const payload = await response.json() as { error?: { code?: string; message?: string }; requestId?: string };
  assert.equal(payload.error?.code, "AUTH_REQUIRED", `${method} ${path} should return a safe auth error`);
  assert.equal(payload.error?.message, "Sesi berakhir. Masuk lagi dengan GitHub.", "anonymous API response should not expose credential data");
  assert.equal(typeof payload.requestId, "string", "API error should include a request id");
}

await mkdir(artifactDirectory, { recursive: true });

try {
  browser = await chromium.launch({ headless: true, args: ["--host-resolver-rules=MAP localhost 127.0.0.1"] });
  localProxy = await startLocalTransportProxy();
  api = await request.newContext({
    baseURL: transportOrigin.origin,
    extraHTTPHeaders: { Accept: "application/json" },
    timeout: 15_000,
  });

  // Exercise the production handlers with a cookie-free API client. Valid request
  // shapes ensure the handlers reach the session check before input validation.
  await assertUnauthorizedApi("/api/github/installations?page=1", "GET");
  await assertUnauthorizedApi("/api/github/installations/1/repositories?page=1", "GET");
  await assertUnauthorizedApi("/api/repositories/branches?repository=example/sample&page=1", "GET");
  await assertUnauthorizedApi("/api/repositories/resolve", "POST", { repository: "example/sample" });
  await assertUnauthorizedApi("/api/repositories/target", "POST", { repository: "example/sample", branch: "main" });
  await assertUnauthorizedApi("/api/analyses", "POST", { repository: "example/sample", branch: "main" }, `authui-${randomUUID()}`);
  checks.push("anonymous repository and analysis APIs return safe 401 responses");

  const fixtureNonce = randomUUID();
  const fixtureSuffix = fixtureNonce.replaceAll("-", "").slice(0, 12);
  const fixtureLogin = `ui-${fixtureSuffix}`;
  const fixtureConnectionLogin = `fixture-${fixtureSuffix}`;
  const fixtureUser = await db.user.create({
    data: {
      githubUserId: `auth-ui-${fixtureNonce}`,
      login: fixtureLogin,
      displayName: `SAGE UI ${fixtureSuffix}`,
    },
  });
  fixtureUserId = fixtureUser.id;
  await db.gitHubConnection.create({
    data: {
      userId: fixtureUser.id,
      githubUserId: fixtureUser.githubUserId,
      githubLogin: fixtureConnectionLogin,
      encryptedToken: "synthetic-fixture-no-provider-token",
      tokenNonce: "synthetic-fixture",
      tokenAuthTag: "synthetic-fixture",
      encryptionKeyId: "synthetic-fixture",
    },
  });

  const activeSession = await createSession(db, fixtureUser.id, { ttlMs: 60 * 60 * 1000 });
  fixtureSessionIds.push(activeSession.session.sessionId);
  const expiredSession = await createSession(db, fixtureUser.id, {
    now: new Date(Date.now() - 60_000),
    ttlMs: 30_000,
  });
  fixtureSessionIds.push(expiredSession.session.sessionId);

  for (const width of viewports) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    await installExternalRequestBlocker(context);
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    let pageErrors = 0;
    page.on("pageerror", () => { pageErrors++; });

    await page.goto(new URL("/workspace", browserOrigin).toString(), { waitUntil: "domcontentloaded" });
    await expectLogin(page, "session");
    await assertNoHorizontalOverflow(page);
    await page.goto(new URL("/workspace/repositories", browserOrigin).toString(), { waitUntil: "domcontentloaded" });
    await expectLogin(page, "session");
    await assertNoHorizontalOverflow(page);
    await page.screenshot({ path: saveScreenshotName(`anonymous-${width}.png`), fullPage: true });
    assert.equal(pageErrors, 0, "anonymous protected-route redirects should not produce browser errors");
    await context.close();
  }
  checks.push("anonymous workspace and repository routes redirect to login across five viewports");

  // The proxy keeps the browser on the trusted local origin. It rewrites only
  // the app's GitHub authorization redirect to a local denial callback, so no
  // request reaches GitHub and no token exchange can run.
  const loginContext = await browser.newContext({ viewport: { width: 390, height: 900 } });
  await installExternalRequestBlocker(loginContext);
  const loginPage = await loginContext.newPage();
  loginPage.setDefaultTimeout(15_000);
  let loginPageErrors = 0;
  loginPage.on("pageerror", () => { loginPageErrors++; });

  await loginPage.goto(new URL("/login?error=denied", browserOrigin).toString(), { waitUntil: "domcontentloaded" });
  await assertSafeLoginMessage(loginPage, "Permintaan akses GitHub dibatalkan. Kamu bisa memulai login lagi kapan saja.");
  await loginPage.goto(new URL("/auth/github", browserOrigin).toString(), { waitUntil: "domcontentloaded" });
  await expectLogin(loginPage);
  assert.equal(oauthFlows.length, 0, "read-only GET login must not start an OAuth attempt");

  await loginPage.goto(new URL("/login?error=denied", browserOrigin).toString(), { waitUntil: "domcontentloaded" });
  interceptOAuthStart = true;
  const firstNavigation = loginPage.waitForNavigation({ waitUntil: "domcontentloaded" });
  await loginPage.getByRole("button", { name: "Masuk dengan GitHub", exact: true }).click();
  await firstNavigation;
  await expectLogin(loginPage, "denied");
  await assertSafeLoginMessage(loginPage, "Permintaan akses GitHub dibatalkan. Kamu bisa memulai login lagi kapan saja.");
  assert.equal(await loginPage.getByRole("button", { name: "Masuk dengan GitHub", exact: true }).isEnabled(), true,
    "login form should remain available to retry after denial");
  assert.equal(oauthFlows.length, 1, "one retryable login should start one browser-bound OAuth attempt");

  const replayFlow = oauthFlows[0];
  assert.ok(replayFlow);
  await loginContext.addCookies([{
    name: "sage_oauth_browser",
    value: replayFlow.browserToken,
    domain: browserOrigin.hostname,
    path: "/auth/github",
    httpOnly: true,
    sameSite: "Lax",
    secure: browserOrigin.protocol === "https:",
  }]);
  const replayUrl = new URL("/auth/github/callback", browserOrigin.origin);
  replayUrl.searchParams.set("state", replayFlow.state);
  replayUrl.searchParams.set("error", "access_denied");
  await loginPage.goto(replayUrl.toString(), { waitUntil: "domcontentloaded" });
  await expectLogin(loginPage, "expired");
  await assertSafeLoginMessage(loginPage, "Permintaan login sudah kedaluwarsa atau sudah digunakan. Mulai login baru.");

  const retryNavigation = loginPage.waitForNavigation({ waitUntil: "domcontentloaded" });
  await loginPage.getByRole("button", { name: "Masuk dengan GitHub", exact: true }).click();
  await retryNavigation;
  await expectLogin(loginPage, "denied");
  await assertSafeLoginMessage(loginPage, "Permintaan akses GitHub dibatalkan. Kamu bisa memulai login lagi kapan saja.");
  assert.equal(oauthFlows.length, 2, "retry after an expired callback should start a fresh OAuth attempt");
  assert.notEqual(oauthFlows[0]?.state, oauthFlows[1]?.state, "OAuth retry should use fresh state");
  interceptOAuthStart = false;
  assert.equal(githubRequestsBlocked, 0, "the test must never contact GitHub");
  assert.equal(await loginContext.cookies(browserOrigin.origin).then(cookies => cookies.some(cookie => cookie.name === "sage_session")), false,
    "denial and replay must not create a SAGE session cookie");
  await assertNoHorizontalOverflow(loginPage);
  await loginPage.screenshot({ path: saveScreenshotName("login-denied-retry.png"), fullPage: true });
  assert.equal(loginPageErrors, 0, "login denial and retry should not produce browser errors");
  await loginContext.close();
  checks.push("login errors stay safe and Indonesian; GET is read-only; denial replay is rejected and retry creates fresh state without provider traffic");

  const invalidContext = await browser.newContext({ viewport: { width: 390, height: 900 } });
  await installExternalRequestBlocker(invalidContext);
  const invalidPage = await invalidContext.newPage();
  invalidPage.setDefaultTimeout(15_000);
  let invalidPageErrors = 0;
  invalidPage.on("pageerror", () => { invalidPageErrors++; });
  const sessionsBeforeInvalidCallback = await db.session.count({ where: { userId: fixtureUser.id } });
  await invalidPage.goto(new URL("/auth/github/callback?state=invalid&error=access_denied", browserOrigin).toString(), { waitUntil: "domcontentloaded" });
  await expectLogin(invalidPage, "invalid");
  await assertSafeLoginMessage(invalidPage, "Respons login tidak valid. Mulai login baru.");
  assert.equal((await invalidContext.cookies(browserOrigin.origin)).some(cookie => cookie.name === "sage_session"), false,
    "invalid callback must not set a session cookie");
  assert.equal(await db.session.count({ where: { userId: fixtureUser.id } }), sessionsBeforeInvalidCallback,
    "invalid callback must not create a database session");
  await invalidPage.screenshot({ path: saveScreenshotName("callback-invalid.png"), fullPage: true });
  assert.equal(invalidPageErrors, 0, "invalid callback should not produce browser errors");
  await invalidContext.close();
  checks.push("invalid callback returns a safe login error without setting or creating a session");

  for (const width of viewports) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    await installExternalRequestBlocker(context);
    await context.addCookies([sessionCookie(activeSession.token)]);
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    let pageErrors = 0;
    page.on("pageerror", () => { pageErrors++; });

    await page.goto(new URL("/workspace", browserOrigin).toString(), { waitUntil: "domcontentloaded" });
    assert.equal(new URL(page.url()).pathname, "/workspace", "synthetic session should pass the genuine server guard");
    await page.getByRole("heading", { name: `Halo, SAGE UI ${fixtureSuffix}.`, exact: true }).waitFor();
    assert.ok((await page.locator("body").textContent())?.includes(`Terhubung sebagai @${fixtureConnectionLogin}.`),
      "workspace should show the synthetic connection label");
    await assertNoHorizontalOverflow(page);
    await page.screenshot({ path: saveScreenshotName(`workspace-${width}.png`), fullPage: true });

    await page.getByRole("link", { name: "Buka repository", exact: true }).click();
    await page.waitForURL(url => url.pathname === "/workspace/repositories");
    assert.equal(new URL(page.url()).pathname, "/workspace/repositories", "workspace navigation should open repositories");
    await page.getByRole("heading", { name: "Pilih repository", exact: true }).waitFor();
    assert.ok((await page.locator("body").textContent())?.includes(`Terhubung sebagai @${fixtureConnectionLogin}.`),
      "repository navigation should keep the synthetic connection context");
    await assertNoHorizontalOverflow(page);
    await page.screenshot({ path: saveScreenshotName(`repositories-${width}.png`), fullPage: true });

    if (width === viewports[viewports.length - 1]) {
      await page.getByRole("link", { name: "Kembali ke workspace", exact: true }).click();
      await page.getByRole("heading", { name: `Halo, SAGE UI ${fixtureSuffix}.`, exact: true }).waitFor();
      const logoutNavigation = page.waitForNavigation({ waitUntil: "domcontentloaded" });
      await page.getByRole("button", { name: "Keluar", exact: true }).click();
      await logoutNavigation;
      const loggedOutLocation = new URL(page.url());
      assert.equal(loggedOutLocation.pathname, "/login", "logout should return to login");
      assert.equal(loggedOutLocation.searchParams.get("status"), "logged-out", "logout should show the completion status");
      await page.getByRole("status").getByText("Kamu sudah keluar dari SAGE.", { exact: true }).waitFor();
      assert.equal((await context.cookies(browserOrigin.origin)).some(cookie => cookie.name === "sage_session"), false,
        "logout should clear the browser session cookie");
      const revoked = await db.session.findUnique({ where: { id: activeSession.session.sessionId }, select: { revokedAt: true } });
      assert.ok(revoked?.revokedAt, "logout should revoke the synthetic session in the database");

      await context.addCookies([sessionCookie(activeSession.token)]);
      await page.goto(new URL("/workspace", browserOrigin).toString(), { waitUntil: "domcontentloaded" });
      await expectLogin(page, "session");
      await assertSafeLoginMessage(page, "Sesi SAGE berakhir. Masuk lagi dengan GitHub.");
      await page.screenshot({ path: saveScreenshotName("revoked-session.png"), fullPage: true });
    }

    assert.equal(pageErrors, 0, "authenticated workspace navigation should not produce browser errors");
    await context.close();
  }
  checks.push("synthetic server-guarded session shows the login label, navigates to repositories, and logout revokes it and clears its cookie");

  const expiredContext = await browser.newContext({ viewport: { width: 390, height: 900 } });
  await installExternalRequestBlocker(expiredContext);
  await expiredContext.addCookies([sessionCookie(expiredSession.token)]);
  const expiredPage = await expiredContext.newPage();
  expiredPage.setDefaultTimeout(15_000);
  let expiredPageErrors = 0;
  expiredPage.on("pageerror", () => { expiredPageErrors++; });
  await expiredPage.goto(new URL("/workspace", browserOrigin).toString(), { waitUntil: "domcontentloaded" });
  await expectLogin(expiredPage, "session");
  await assertSafeLoginMessage(expiredPage, "Sesi SAGE berakhir. Masuk lagi dengan GitHub.");
  const persistedExpiredSession = await db.session.findUnique({
    where: { id: expiredSession.session.sessionId },
    select: { expiresAt: true },
  });
  assert.ok(persistedExpiredSession && persistedExpiredSession.expiresAt.getTime() < Date.now(),
    "expired fixture should be past its database expiry");
  await expiredPage.screenshot({ path: saveScreenshotName("expired-session.png"), fullPage: true });
  assert.equal(expiredPageErrors, 0, "expired session rejection should not produce browser errors");
  await expiredContext.close();
  checks.push("expired synthetic session is rejected by the server workspace guard");
  runSucceeded = true;
} finally {
  const cleanupFailures: unknown[] = [];
  try { await api?.dispose(); } catch (error) { cleanupFailures.push(error); }
  try { await browser?.close(); } catch (error) { cleanupFailures.push(error); }
  try {
    if (localProxy?.listening) {
      await new Promise<void>((resolveClose, rejectClose) => {
        localProxy?.close(error => error ? rejectClose(error) : resolveClose());
      });
    }
  } catch (error) { cleanupFailures.push(error); }
  try {
    if (oauthAttemptStateHashes.length > 0) {
      await db.gitHubOAuthAttempt.deleteMany({ where: { stateHash: { in: oauthAttemptStateHashes } } });
    }
  } catch (error) { cleanupFailures.push(error); }
  try {
    if (fixtureUserId && fixtureSessionIds.length > 0) {
      await db.session.deleteMany({ where: { id: { in: fixtureSessionIds } } });
    }
  } catch (error) { cleanupFailures.push(error); }
  try {
    if (fixtureUserId) await db.gitHubConnection.deleteMany({ where: { userId: fixtureUserId } });
  } catch (error) { cleanupFailures.push(error); }
  try {
    if (fixtureUserId) await db.user.deleteMany({ where: { id: fixtureUserId } });
  } catch (error) { cleanupFailures.push(error); }
  try { await disconnectDatabase(); } catch (error) { cleanupFailures.push(error); }

  const report = {
    status: runSucceeded && cleanupFailures.length === 0 ? "PASS" : "FAIL",
    checkedAt: new Date().toISOString(),
    scope: "Running Next app with a synthetic user and local OAuth denial/replay; GitHub requests and token exchange were not performed.",
    checks,
    viewports,
    screenshots,
    runtime: { node: process.version, platform: process.platform },
  };
  try {
    await mkdir(artifactDirectory, { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  } catch (error) { cleanupFailures.push(error); }
  if (cleanupFailures.length > 0) throw new Error("Auth UI regression cleanup or report writing failed.");
}

console.log(JSON.stringify({ status: "PASS", checks: checks.length, report: reportPath, screenshots: screenshots.length }));
