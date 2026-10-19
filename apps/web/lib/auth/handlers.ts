import { parseAuthBaseConfig, parseGitHubAuthConfig, isSameOriginPost, type AuthBaseConfig } from "./config.ts";
import { authorizeGitHubUser, createAuthorizationUrl, type OAuthAttempt } from "./provider.ts";

export const OAUTH_BROWSER_COOKIE = "sage_oauth_browser";
export const SESSION_COOKIE = "sage_session";
const OPAQUE_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const FLOW_COOKIE_TTL_SECONDS = 10 * 60;

export type LoginCompletion = {
  readonly sessionToken: string;
  readonly expiresAt: Date;
  readonly user: { readonly id: string; readonly login: string; readonly displayName: string | null };
};

export type GitHubAuthHandlerDependencies = {
  readonly env: Record<string, string | undefined>;
  readonly createAttempt: () => Promise<OAuthAttempt & { readonly browserToken: string; readonly expiresAt?: Date }>;
  readonly consumeAttempt: (input: { state: string; browserToken: string }) => Promise<{ codeVerifier: string } | null>;
  readonly completeLogin: (input: { githubUserId: string; login: string; displayName: string | null; accessToken: string; tokenExpiresAt: Date }) => Promise<LoginCompletion>;
  readonly revokeSession: (token: string) => Promise<boolean>;
  readonly fetcher?: typeof fetch;
  readonly now?: () => Date;
};

export function isValidOpaqueToken(value: unknown): value is string {
  return typeof value === "string" && OPAQUE_TOKEN.test(value);
}

function responseHeaders(): Headers {
  const headers = new Headers({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
  return headers;
}

function loginLocation(config: AuthBaseConfig | null, query: Record<string, string> = {}): string {
  const url = new URL("/login", config?.origin ?? "http://relative.invalid");
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return config ? url.toString() : `${url.pathname}${url.search}`;
}

function workspaceLocation(config: AuthBaseConfig): string {
  return new URL("/workspace", config.origin).toString();
}

function redirect(location: string, status = 303, headers = responseHeaders()): Response {
  headers.set("Location", location);
  return new Response(null, { status, headers });
}

function cookieHeader(name: string, value: string, attributes: string[]): string {
  return `${name}=${value}; ${attributes.join("; ")}`;
}

export function makeFlowCookie(browserToken: string, secure: boolean): string {
  if (!OPAQUE_TOKEN.test(browserToken)) throw new Error("Invalid browser token");
  const attributes = ["Path=/auth/github", "HttpOnly", "SameSite=Lax", `Max-Age=${FLOW_COOKIE_TTL_SECONDS}`];
  if (secure) attributes.push("Secure");
  return cookieHeader(OAUTH_BROWSER_COOKIE, browserToken, attributes);
}

export function clearFlowCookie(secure: boolean): string {
  const attributes = ["Path=/auth/github", "HttpOnly", "SameSite=Lax", "Max-Age=0", "Expires=Thu, 01 Jan 1970 00:00:00 GMT"];
  if (secure) attributes.push("Secure");
  return cookieHeader(OAUTH_BROWSER_COOKIE, "", attributes);
}

export function makeSessionCookie(sessionToken: string, expiresAt: Date, now: Date, secure: boolean): string {
  if (!OPAQUE_TOKEN.test(sessionToken) || !Number.isFinite(expiresAt.getTime()) || expiresAt <= now) {
    throw new Error("Invalid session");
  }
  const maxAge = Math.max(1, Math.floor((expiresAt.getTime() - now.getTime()) / 1000));
  const attributes = ["Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${maxAge}`, `Expires=${expiresAt.toUTCString()}`];
  if (secure) attributes.push("Secure");
  return cookieHeader(SESSION_COOKIE, sessionToken, attributes);
}

export function getUniqueCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  let seen = false;
  let found: string | null = null;
  for (const chunk of header.split(";")) {
    const separator = chunk.indexOf("=");
    if (separator < 0) continue;
    if (chunk.slice(0, separator).trim() !== name) continue;
    if (seen) return null;
    seen = true;
    const value = chunk.slice(separator + 1).trim();
    if (!OPAQUE_TOKEN.test(value)) return null;
    found = value;
  }
  return found;
}

function uniqueParam(url: URL, name: string): { readonly present: boolean; readonly value: string | null; readonly valid: boolean } {
  const values = url.searchParams.getAll(name);
  if (values.length > 1) return { present: true, value: null, valid: false };
  if (values.length === 0) return { present: false, value: null, valid: true };
  return { present: true, value: values[0] ?? "", valid: true };
}

function appendClearFlowCookie(headers: Headers, config: AuthBaseConfig | null): void {
  headers.append("Set-Cookie", clearFlowCookie(config?.secureCookies ?? false));
}

function callbackFailure(config: AuthBaseConfig | null, code: string, status = 303): Response {
  const headers = responseHeaders();
  appendClearFlowCookie(headers, config);
  return redirect(loginLocation(config, { error: code }), status, headers);
}

export function createGitHubStartHandler(dependencies: GitHubAuthHandlerDependencies) {
  return async function POST(request: Request): Promise<Response> {
    const config = parseGitHubAuthConfig(dependencies.env);
    if (!config) return redirect(loginLocation(null, { error: "unavailable" }));
    if (!isSameOriginPost(request, config)) return new Response(null, { status: 403, headers: responseHeaders() });

    try {
      const attempt = await dependencies.createAttempt();
      const location = createAuthorizationUrl(config, attempt);
      const headers = responseHeaders();
      headers.append("Set-Cookie", makeFlowCookie(attempt.browserToken, config.secureCookies));
      return redirect(location, 303, headers);
    } catch {
      return redirect(loginLocation(config, { error: "unavailable" }));
    }
  };
}

export function createGitHubReadOnlyLoginHandler() {
  return async function GET(): Promise<Response> {
    return redirect("/login", 303);
  };
}

export function createGitHubCallbackHandler(dependencies: GitHubAuthHandlerDependencies) {
  return async function GET(request: Request): Promise<Response> {
    const config = parseGitHubAuthConfig(dependencies.env);
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return callbackFailure(config, "invalid");
    }

    const stateParam = uniqueParam(url, "state");
    const codeParam = uniqueParam(url, "code");
    const errorParam = uniqueParam(url, "error");
    const browserToken = getUniqueCookie(request.headers.get("cookie"), OAUTH_BROWSER_COOKIE);
    if (!stateParam.valid || !codeParam.valid || !errorParam.valid
      || !stateParam.value || stateParam.value.length > 128 || !OPAQUE_TOKEN.test(stateParam.value)
      || !browserToken) {
      return callbackFailure(config, "invalid");
    }
    if ((errorParam.present && (!errorParam.value || errorParam.value.length > 128))
      || (errorParam.present && codeParam.present)
      || (!errorParam.present && (!codeParam.value || codeParam.value.length > 2048))) {
      return callbackFailure(config, "invalid");
    }

    let consumed: { codeVerifier: string } | null;
    try {
      consumed = await dependencies.consumeAttempt({ state: stateParam.value, browserToken });
    } catch {
      return callbackFailure(config, "unavailable");
    }
    if (!consumed) return callbackFailure(config, "expired");

    // A denial still consumes the browser-bound attempt, preventing it from
    // being replayed if the same callback URL is opened again.
    if (errorParam.present) {
      return callbackFailure(config, errorParam.value === "access_denied" ? "denied" : "github");
    }
    if (!config) return callbackFailure(null, "unavailable");

    const now = dependencies.now?.() ?? new Date();
    try {
      const authorization = await authorizeGitHubUser(config, {
        code: codeParam.value as string,
        codeVerifier: consumed.codeVerifier,
        now,
        fetcher: dependencies.fetcher,
      });
      const completed = await dependencies.completeLogin(authorization);
      const headers = responseHeaders();
      appendClearFlowCookie(headers, config);
      headers.append("Set-Cookie", makeSessionCookie(completed.sessionToken, completed.expiresAt, now, config.secureCookies));
      return redirect(workspaceLocation(config), 303, headers);
    } catch {
      return callbackFailure(config, "github");
    }
  };
}

export function createGitHubLogoutHandler(dependencies: GitHubAuthHandlerDependencies) {
  return async function POST(request: Request): Promise<Response> {
    const config = parseAuthBaseConfig(dependencies.env);
    if (!config) return new Response("Logout tidak tersedia.", { status: 503, headers: responseHeaders() });
    if (!isSameOriginPost(request, config)) return new Response(null, { status: 403, headers: responseHeaders() });

    const token = getUniqueCookie(request.headers.get("cookie"), SESSION_COOKIE);
    if (token) {
      try {
        await dependencies.revokeSession(token);
      } catch {
        const retryUrl = new URL("/workspace?error=logout", config.origin);
        return redirect(retryUrl.toString());
      }
    }
    const headers = responseHeaders();
    headers.append("Set-Cookie", cookieHeader(SESSION_COOKIE, "", [
      "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0", "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
      ...(config.secureCookies ? ["Secure"] : []),
    ]));
    return redirect(loginLocation(config, { status: "logged-out" }), 303, headers);
  };
}

export function methodNotAllowed(): Response {
  return new Response(null, { status: 405, headers: { Allow: "POST", "Cache-Control": "no-store" } });
}
