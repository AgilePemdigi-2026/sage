import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { completeGitHubLogin, database, disconnectDatabase, resolveSession } from "../packages/database/src/index.ts";

if (process.env.SAGE_OAUTH_TESTS !== "1" || !process.env.DATABASE_URL || new URL(process.env.DATABASE_URL).pathname !== "/sage_oauth05") {
  throw new Error("HTTP auth tests require the isolated sage_oauth05 database and SAGE_OAUTH_TESTS=1.");
}
const base = new URL(process.env.AUTH_BASE_URL ?? "http://localhost:3000");
if (base.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(base.hostname)) throw new Error("HTTP auth test server must be loopback.");
const output = resolve("artifacts/gh-01/http-report.json");
const checks: string[] = [];
const states: string[] = [];
const db = database();
let userId: string | undefined;
const safeRequest = (path: string, init: RequestInit = {}) => fetch(new URL(path, base), { ...init, redirect: "manual", signal: AbortSignal.timeout(10_000) });
const isRedirect = (response: Response) => assert.ok([302, 303, 307].includes(response.status), "Expected safe redirect.");
const localLocation = (response: Response) => { const location = new URL(response.headers.get("location") ?? "", base); assert.equal(location.origin, base.origin); return location; };
const flowCookie = (response: Response) => { const cookie = response.headers.getSetCookie().find(value => value.startsWith("sage_oauth_browser=")); assert.ok(cookie, "Flow cookie required."); assert.match(cookie, /HttpOnly/i); assert.match(cookie, /SameSite=Lax/i); return cookie.split(";")[0]; };

try {
  const unauthenticated = await safeRequest("/workspace");
  isRedirect(unauthenticated); assert.equal(localLocation(unauthenticated).pathname, "/login");
  checks.push("workspace rejects unauthenticated requests");

  const before = await db.gitHubOAuthAttempt.count();
  const forbidden = await safeRequest("/auth/github", { method: "POST", headers: { Origin: "https://attacker.invalid" } });
  if (forbidden.status !== 403) { isRedirect(forbidden); assert.equal(localLocation(forbidden).searchParams.get("error"), "origin"); }
  assert.equal(await db.gitHubOAuthAttempt.count(), before);
  checks.push("cross-origin login POST cannot create an OAuth attempt");

  const started = await safeRequest("/auth/github", { method: "POST", headers: { Origin: base.origin } });
  isRedirect(started);
  const authorize = new URL(started.headers.get("location") ?? "");
  assert.equal(authorize.origin, "https://github.com"); assert.equal(authorize.pathname, "/login/oauth/authorize");
  assert.equal(authorize.searchParams.get("code_challenge_method"), "S256");
  assert.match(authorize.searchParams.get("code_challenge") ?? "", /^[A-Za-z0-9_-]{43}$/);
  assert.equal(authorize.searchParams.get("redirect_uri"), new URL("/auth/github/callback", base).href);
  const state = authorize.searchParams.get("state"); assert.ok(state); states.push(state);
  const cookie = flowCookie(started);
  assert.ok(!authorize.searchParams.has("client_secret") && !authorize.searchParams.has("code_verifier"));
  checks.push("real HTTP login start binds browser and uses S256 without exposing secrets");

  const wrongBrowser = await safeRequest(`/auth/github/callback?state=${encodeURIComponent(state)}&error=access_denied`, { headers: { Cookie: `sage_oauth_browser=${"X".repeat(43)}` } });
  isRedirect(wrongBrowser); assert.equal(localLocation(wrongBrowser).pathname, "/login");
  const attempt = await db.gitHubOAuthAttempt.findUnique({ where: { stateHash: createHash("sha256").update(state).digest("hex") } });
  assert.ok(attempt); assert.equal(attempt.consumedAt, null);
  checks.push("wrong browser cannot consume another browser's OAuth attempt");

  const denied = await safeRequest(`/auth/github/callback?state=${encodeURIComponent(state)}&error=access_denied`, { headers: { Cookie: cookie } });
  isRedirect(denied); const denialLocation = localLocation(denied); assert.equal(denialLocation.pathname, "/login");
  assert.ok(denialLocation.searchParams.has("error"));
  const consumed = await db.gitHubOAuthAttempt.findUniqueOrThrow({ where: { stateHash: createHash("sha256").update(state).digest("hex") } });
  assert.ok(consumed.consumedAt);
  const replay = await safeRequest(`/auth/github/callback?state=${encodeURIComponent(state)}&error=access_denied`, { headers: { Cookie: cookie } });
  isRedirect(replay); const replayLocation = localLocation(replay);
  assert.equal(replayLocation.pathname, "/login"); assert.notEqual(replayLocation.searchParams.get("error"), denialLocation.searchParams.get("error"));
  checks.push("denial consumes state once and replay is rejected by actual Next routes/database");

  const page = await safeRequest(denialLocation.pathname + denialLocation.search);
  assert.equal(page.status, 200); const html = await page.text(); assert.ok(html.includes("GitHub")); assert.ok(!html.includes(state));
  checks.push("denial returns a recoverable login page without reflecting raw state");

  const fixtureId = randomUUID();
  const login = await completeGitHubLogin(db, { githubUserId: String(Number.parseInt(fixtureId.replaceAll("-", "").slice(0, 12), 16) + 1), login: "sage-http-test", displayName: "Synthetic HTTP test", accessToken: "synthetic-test-token-not-a-GitHub-token", tokenExpiresAt: new Date(Date.now() + 60_000) });
  userId = login.user.id;
  const sessionCookie = `sage_session=${login.sessionToken}`;
  const workspace = await safeRequest("/workspace", { headers: { Cookie: sessionCookie } });
  assert.equal(workspace.status, 200); const workspaceHtml = await workspace.text(); assert.ok(workspaceHtml.includes("sage-http-test"));
  assert.ok(!workspaceHtml.includes("synthetic-test-token-not-a-GitHub-token") && !workspaceHtml.includes(login.sessionToken));
  checks.push("synthetically seeded session reaches workspace without exposing credentials; not a real GitHub login");

  const deniedLogout = await safeRequest("/auth/logout", { method: "POST", headers: { Origin: "https://attacker.invalid", Cookie: sessionCookie } });
  if (deniedLogout.status !== 403) { isRedirect(deniedLogout); assert.equal(localLocation(deniedLogout).searchParams.get("error"), "origin"); }
  assert.ok(await resolveSession(db, login.sessionToken));
  const logout = await safeRequest("/auth/logout", { method: "POST", headers: { Origin: base.origin, Cookie: sessionCookie } });
  isRedirect(logout); assert.equal(localLocation(logout).pathname, "/login"); assert.equal(await resolveSession(db, login.sessionToken), null);
  assert.ok(logout.headers.getSetCookie().some(value => value.startsWith("sage_session=") && /Max-Age=0|Expires=Thu, 01 Jan 1970/i.test(value)));
  checks.push("logout rejects cross-origin POST and revokes the local session on valid POST");

  await mkdir(resolve("artifacts/gh-01"), { recursive: true });
  await writeFile(output, JSON.stringify({ status: "PASS", date: new Date().toISOString(), scope: "Actual Next HTTP and isolated PostgreSQL; denial/replay and seeded session only. GitHub authorization/token exchange NOT_RUN.", checks, runtime: { node: process.version, platform: process.platform }, applicationBaseCommitSha: process.env.QA_APP_COMMIT_SHA ?? null }, null, 2) + "\n");
  console.log(JSON.stringify({ status: "PASS", checks: checks.length, realGitHubLogin: "NOT_RUN", report: output }));
} finally {
  if (states.length) await db.gitHubOAuthAttempt.deleteMany({ where: { stateHash: { in: states.map(state => createHash("sha256").update(state).digest("hex")) } } });
  if (userId) { await db.session.deleteMany({ where: { userId } }); await db.gitHubConnection.deleteMany({ where: { userId } }); await db.user.delete({ where: { id: userId } }); }
  await disconnectDatabase();
}
