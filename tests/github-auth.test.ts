import assert from "node:assert/strict";
import test from "node:test";
import { parseGitHubAuthConfig } from "../apps/web/lib/auth/config.ts";
import {
  createGitHubCallbackHandler,
  createGitHubLogoutHandler,
  createGitHubReadOnlyLoginHandler,
  createGitHubStartHandler,
  getUniqueCookie,
  type GitHubAuthHandlerDependencies,
} from "../apps/web/lib/auth/handlers.ts";
import { challengeForVerifier } from "../apps/web/lib/auth/provider.ts";

const browserToken = "b".repeat(43);
const state = "s".repeat(43);
const verifier = "v".repeat(43);
const sessionToken = "t".repeat(43);
const now = new Date("2026-10-19T00:00:00.000Z");
const expiresAt = new Date(now.getTime() + 8 * 60 * 60 * 1000);
const env = {
  AUTH_BASE_URL: "http://localhost:3000",
  GITHUB_APP_CLIENT_ID: "client-id",
  GITHUB_APP_CLIENT_SECRET: "server-secret",
};

function oauthCookie(value = browserToken): string {
  return `sage_oauth_browser=${value}`;
}

function makeDependencies(overrides: Partial<GitHubAuthHandlerDependencies> = {}) {
  const consumed: Array<{ state: string; browserToken: string }> = [];
  const defaults: GitHubAuthHandlerDependencies = {
    env,
    createAttempt: async () => ({ state, browserToken, codeChallenge: challengeForVerifier(verifier) }),
    consumeAttempt: async (input) => {
      consumed.push(input);
      return { codeVerifier: verifier };
    },
    completeLogin: async () => ({ sessionToken, expiresAt, user: { id: "user-1", login: "octocat", displayName: "Mona" } }),
    revokeSession: async () => true,
    now: () => new Date(now),
  };
  return {
    consumed,
    deps: { ...defaults, ...overrides },
  };
}

test("trusted auth base requires an origin and permits HTTP only on loopback", () => {
  assert.equal(parseGitHubAuthConfig(env)?.callbackUrl, "http://localhost:3000/auth/github/callback");
  assert.equal(parseGitHubAuthConfig({ ...env, AUTH_BASE_URL: "http://127.5.6.7:3000" })?.secureCookies, false);
  assert.equal(parseGitHubAuthConfig({ ...env, AUTH_BASE_URL: "https://sage.example" })?.secureCookies, true);
  for (const base of [
    "http://sage.example",
    "https://sage.example/path",
    "https://sage.example/?next=https://attacker.test",
    "https://sage.example/#fragment",
    "https://user:pass@sage.example",
    "file:///tmp/sage",
  ]) assert.equal(parseGitHubAuthConfig({ ...env, AUTH_BASE_URL: base }), null, base);
});

test("POST login creates a browser-bound PKCE redirect and sets secure flow cookie flags", async () => {
  const { deps } = makeDependencies();
  let createCount = 0;
  deps.createAttempt = async () => {
    createCount++;
    return { state, browserToken, codeChallenge: challengeForVerifier(verifier) };
  };
  const response = await createGitHubStartHandler(deps)(new Request("http://localhost:3000/auth/github", {
    method: "POST",
    headers: { Origin: "http://localhost:3000" },
  }));
  const location = new URL(response.headers.get("location") ?? "");
  assert.equal(response.status, 303);
  assert.equal(location.origin, "https://github.com");
  assert.equal(location.pathname, "/login/oauth/authorize");
  assert.equal(location.searchParams.get("state"), state);
  assert.equal(location.searchParams.get("code_challenge"), challengeForVerifier(verifier));
  assert.equal(location.searchParams.get("code_challenge_method"), "S256");
  assert.equal(location.searchParams.has("scope"), false);
  assert.equal(location.searchParams.get("redirect_uri"), "http://localhost:3000/auth/github/callback");
  assert.match(response.headers.get("set-cookie") ?? "", /sage_oauth_browser=b{43}; Path=\/auth\/github; HttpOnly; SameSite=Lax; Max-Age=600/);
  assert.doesNotMatch(response.headers.get("set-cookie") ?? "", /; Secure/);
  assert.equal(createCount, 1);

  const secureDeps = makeDependencies({ env: { ...env, AUTH_BASE_URL: "https://sage.example" } }).deps;
  const secureResponse = await createGitHubStartHandler(secureDeps)(new Request("https://sage.example/auth/github", {
    method: "POST", headers: { Origin: "https://sage.example" },
  }));
  assert.match(secureResponse.headers.get("set-cookie") ?? "", /sage_oauth_browser=.*; Secure/);

  const denied = await createGitHubStartHandler(deps)(new Request("http://localhost:3000/auth/github", {
    method: "POST", headers: { Origin: "https://attacker.test" },
  }));
  assert.equal(denied.status, 403);
  assert.equal(denied.headers.get("location"), null);
  assert.equal(createCount, 1);
});

test("GET /auth/github is read-only and never creates an OAuth attempt", async () => {
  const response = await createGitHubReadOnlyLoginHandler()();
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "/login");
});

test("denied callback consumes the attempt, clears its cookie, and replay is rejected", async () => {
  const { deps, consumed } = makeDependencies();
  const handler = createGitHubCallbackHandler(deps);
  const request = () => new Request(`http://localhost:3000/auth/github/callback?state=${state}&error=access_denied`, {
    headers: { Cookie: oauthCookie() },
  });
  const first = await handler(request());
  assert.equal(first.headers.get("location"), "http://localhost:3000/login?error=denied");
  assert.match(first.headers.get("set-cookie") ?? "", /sage_oauth_browser=; Path=\/auth\/github; HttpOnly; SameSite=Lax; Max-Age=0/);

  deps.consumeAttempt = async (input) => {
    consumed.push(input);
    return null;
  };
  const replay = await createGitHubCallbackHandler(deps)(request());
  assert.equal(replay.headers.get("location"), "http://localhost:3000/login?error=expired");
  assert.equal(consumed.length, 2);

  const secureDeps = makeDependencies({
    env: { ...env, AUTH_BASE_URL: "https://sage.example" },
    consumeAttempt: async () => ({ codeVerifier: verifier }),
  }).deps;
  const secureDenied = await createGitHubCallbackHandler(secureDeps)(new Request(
    `https://sage.example/auth/github/callback?state=${state}&error=access_denied`,
    { headers: { Cookie: oauthCookie() } },
  ));
  assert.match(secureDenied.headers.get("set-cookie") ?? "", /sage_oauth_browser=; Path=\/auth\/github; HttpOnly; SameSite=Lax; Max-Age=0; Expires=.*; Secure/);
});

test("valid callback exchanges PKCE code server-side and sets only an opaque session cookie", async () => {
  const { deps, consumed } = makeDependencies();
  const providerRequests: Array<{ url: string; init?: RequestInit }> = [];
  deps.fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    providerRequests.push({ url, init });
    if (url === "https://github.com/login/oauth/access_token") {
      return new Response(JSON.stringify({
        access_token: "gho_server_side_secret",
        token_type: "bearer",
        expires_in: 28_800,
        refresh_token: "unused-refresh-secret",
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ id: 1234, login: "octocat", name: "Mona Octocat" }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  let storedInput: Parameters<typeof deps.completeLogin>[0] | undefined;
  deps.completeLogin = async (input) => {
    storedInput = input;
    return { sessionToken, expiresAt, user: { id: "user-1", login: "octocat", displayName: "Mona Octocat" } };
  };
  const response = await createGitHubCallbackHandler(deps)(new Request(
    `http://localhost:3000/auth/github/callback?state=${state}&code=temporary-code`,
    { headers: { Cookie: oauthCookie() } },
  ));

  assert.equal(response.headers.get("location"), "http://localhost:3000/workspace");
  assert.equal(consumed.length, 1);
  assert.equal(providerRequests.length, 2);
  const tokenRequest = providerRequests[0];
  assert.equal(tokenRequest?.url, "https://github.com/login/oauth/access_token");
  assert.equal(tokenRequest?.init?.method, "POST");
  assert.equal(tokenRequest?.init?.redirect, "error");
  const tokenBody = new URLSearchParams(String(tokenRequest?.init?.body));
  assert.equal(tokenBody.get("code_verifier"), verifier);
  assert.equal(tokenBody.get("redirect_uri"), "http://localhost:3000/auth/github/callback");
  assert.equal(tokenBody.get("client_secret"), "server-secret");
  assert.equal(providerRequests[1]?.url, "https://api.github.com/user");
  assert.equal(providerRequests[1]?.init?.redirect, "error");
  assert.equal(new Headers(providerRequests[1]?.init?.headers).get("X-GitHub-Api-Version"), "2026-03-10");
  assert.equal(storedInput?.githubUserId, "1234");
  assert.equal(storedInput?.login, "octocat");
  assert.equal(storedInput?.accessToken, "gho_server_side_secret");
  assert.equal((storedInput?.tokenExpiresAt as Date).getTime(), expiresAt.getTime());
  const setCookies = response.headers.get("set-cookie") ?? "";
  assert.match(setCookies, /sage_oauth_browser=; Path=\/auth\/github/);
  assert.match(setCookies, /sage_session=t{43}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=28800/);
  assert.doesNotMatch(response.headers.get("location") ?? "", /secret|gho_/);
  assert.doesNotMatch(setCookies, /gho_|unused-refresh/);
});

test("duplicate callback values, wrong browser cookies, and hostile provider bodies fail safely", async () => {
  let exchanges = 0;
  const { deps } = makeDependencies({ fetcher: (async () => {
    exchanges++;
    return new Response(JSON.stringify({ error: "bad_verification_code", error_description: "private provider detail" }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch });
  const handler = createGitHubCallbackHandler(deps);
  const duplicate = await handler(new Request(`http://localhost:3000/auth/github/callback?state=${state}&state=${state}&code=abc`, {
    headers: { Cookie: oauthCookie() },
  }));
  assert.equal(duplicate.headers.get("location"), "http://localhost:3000/login?error=invalid");
  assert.equal(exchanges, 0);

  const wrongBrowserDeps = makeDependencies({ consumeAttempt: async () => null }).deps;
  const wrongBrowser = await createGitHubCallbackHandler(wrongBrowserDeps)(new Request(`http://localhost:3000/auth/github/callback?state=${state}&code=abc`, {
    headers: { Cookie: oauthCookie("x".repeat(43)) },
  }));
  assert.equal(wrongBrowser.headers.get("location"), "http://localhost:3000/login?error=expired");
  assert.equal(exchanges, 0);

  const hostile = await handler(new Request(`http://localhost:3000/auth/github/callback?state=${state}&code=abc`, {
    headers: { Cookie: oauthCookie() },
  }));
  assert.equal(hostile.headers.get("location"), "http://localhost:3000/login?error=github");
  assert.doesNotMatch(hostile.headers.get("location") ?? "", /private|bad_verification/);
  assert.equal(exchanges, 1);
});

test("logout validates Origin, revokes a valid local token, and clears the HttpOnly cookie", async () => {
  const revoked: string[] = [];
  const { deps } = makeDependencies({ revokeSession: async (token: string) => { revoked.push(token); return true; } });
  const handler = createGitHubLogoutHandler(deps);
  const badOrigin = await handler(new Request("http://localhost:3000/auth/logout", {
    method: "POST", headers: { Origin: "https://attacker.test", Cookie: `sage_session=${sessionToken}` },
  }));
  assert.equal(badOrigin.status, 403);
  assert.equal(revoked.length, 0);

  const response = await handler(new Request("http://localhost:3000/auth/logout", {
    method: "POST", headers: { Origin: "http://localhost:3000", Cookie: `sage_session=${sessionToken}` },
  }));
  assert.equal(response.headers.get("location"), "http://localhost:3000/login?status=logged-out");
  assert.deepEqual(revoked, [sessionToken]);
  assert.match(response.headers.get("set-cookie") ?? "", /sage_session=; Path=\/; HttpOnly; SameSite=Lax; Max-Age=0/);
});

test("logout revocation failure preserves the session cookie so the user can retry", async () => {
  const { deps } = makeDependencies({ revokeSession: async () => { throw new Error("database detail must stay private"); } });
  const request = () => new Request("http://localhost:3000/auth/logout", {
    method: "POST", headers: { Origin: "http://localhost:3000", Cookie: `sage_session=${sessionToken}` },
  });
  const failed = await createGitHubLogoutHandler(deps)(request());
  assert.equal(failed.headers.get("location"), "http://localhost:3000/workspace?error=logout");
  assert.equal(failed.headers.get("set-cookie"), null);
  assert.doesNotMatch(failed.headers.get("location") ?? "", /database detail/);

  const retriedTokens: string[] = [];
  deps.revokeSession = async (token) => { retriedTokens.push(token); return true; };
  const retried = await createGitHubLogoutHandler(deps)(request());
  assert.deepEqual(retriedTokens, [sessionToken]);
  assert.equal(retried.headers.get("location"), "http://localhost:3000/login?status=logged-out");
  assert.match(retried.headers.get("set-cookie") ?? "", /sage_session=;/);
});

test("local logout does not depend on GitHub OAuth client configuration", async () => {
  const revoked: string[] = [];
  const { deps } = makeDependencies({
    env: { AUTH_BASE_URL: env.AUTH_BASE_URL },
    revokeSession: async (token) => { revoked.push(token); return true; },
  });
  const response = await createGitHubLogoutHandler(deps)(new Request("http://localhost:3000/auth/logout", {
    method: "POST", headers: { Origin: "http://localhost:3000", Cookie: `sage_session=${sessionToken}` },
  }));
  assert.equal(response.headers.get("location"), "http://localhost:3000/login?status=logged-out");
  assert.deepEqual(revoked, [sessionToken]);
});

test("duplicate cookies are rejected rather than selecting an attacker-controlled value", () => {
  assert.equal(getUniqueCookie(`sage_oauth_browser=${browserToken}; sage_oauth_browser=${"x".repeat(43)}`, "sage_oauth_browser"), null);
  assert.equal(getUniqueCookie(`sage_oauth_browser=bad; sage_oauth_browser=${browserToken}`, "sage_oauth_browser"), null);
  assert.equal(getUniqueCookie(`other=value; sage_oauth_browser=${browserToken}`, "sage_oauth_browser"), browserToken);
});
