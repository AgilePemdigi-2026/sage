import { createHash } from "node:crypto";
import type { GitHubAuthConfig } from "./config.ts";

const AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const TOKEN_URL = "https://github.com/login/oauth/access_token";
const USER_URL = "https://api.github.com/user";
const RESPONSE_LIMIT_BYTES = 32 * 1024;
const PROVIDER_TIMEOUT_MS = 10_000;
const MAX_CREDENTIAL_TTL_MS = 8 * 60 * 60 * 1000;

export type OAuthAttempt = {
  readonly state: string;
  readonly browserToken: string;
  readonly codeChallenge: string;
};

export type GitHubProfile = {
  readonly githubUserId: string;
  readonly login: string;
  readonly displayName: string | null;
};

export type GitHubAuthorization = GitHubProfile & {
  readonly accessToken: string;
  readonly tokenExpiresAt: Date;
};

export class GitHubProviderError extends Error {
  constructor() {
    super("GitHub authorization failed");
    this.name = "GitHubProviderError";
  }
}

export function createAuthorizationUrl(config: GitHubAuthConfig, attempt: OAuthAttempt): string {
  if (!/^[A-Za-z0-9_-]{43}$/.test(attempt.state)
    || !/^[A-Za-z0-9_-]{43}$/.test(attempt.codeChallenge)
    || !/^[A-Za-z0-9_-]{43}$/.test(attempt.browserToken)) {
    throw new Error("Invalid OAuth attempt");
  }
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.callbackUrl);
  url.searchParams.set("state", attempt.state);
  url.searchParams.set("code_challenge", attempt.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

function timeoutSignal(): AbortSignal {
  return AbortSignal.timeout(PROVIDER_TIMEOUT_MS);
}

async function readBoundedJson(response: Response): Promise<Record<string, unknown>> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!/^application\/(?:[a-z0-9.+-]*\+)?json(?:\s*;|$)/i.test(contentType)) throw new GitHubProviderError();
  const contentLength = response.headers.get("content-length");
  if (contentLength && (!/^\d+$/.test(contentLength) || Number(contentLength) > RESPONSE_LIMIT_BYTES)) {
    throw new GitHubProviderError();
  }
  if (!response.body) throw new GitHubProviderError();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > RESPONSE_LIMIT_BYTES) {
        await reader.cancel();
        throw new GitHubProviderError();
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof GitHubProviderError) throw error;
    throw new GitHubProviderError();
  }

  try {
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new GitHubProviderError();
    return parsed as Record<string, unknown>;
  } catch {
    throw new GitHubProviderError();
  }
}

function validAccessToken(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4096 && /^[\x21-\x7e]+$/.test(value);
}

function parseUserId(value: unknown): string | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === "string" && /^\d{1,32}$/.test(value) && /[1-9]/.test(value)) return value;
  return null;
}

function parseLogin(value: unknown): string | null {
  if (typeof value !== "string" || value.length < 1 || value.length > 39 || !/^[A-Za-z0-9-]+$/.test(value)) return null;
  return value;
}

function parseDisplayName(value: unknown): string | null | undefined {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && value.length <= 255) return value;
  return undefined;
}

export async function authorizeGitHubUser(
  config: GitHubAuthConfig,
  input: { code: string; codeVerifier: string; now?: Date; fetcher?: typeof fetch },
): Promise<GitHubAuthorization> {
  const fetcher = input.fetcher ?? fetch;
  const now = input.now ?? new Date();
  if (!Number.isFinite(now.getTime()) || input.code.length > 2048 || !input.code || !/^[A-Za-z0-9_-]{43,128}$/.test(input.codeVerifier)) {
    throw new GitHubProviderError();
  }

  const tokenBody = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    code: input.code,
    redirect_uri: config.callbackUrl,
    code_verifier: input.codeVerifier,
  });

  let tokenResponse: Response;
  try {
    tokenResponse = await fetcher(TOKEN_URL, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body: tokenBody,
      signal: timeoutSignal(),
      cache: "no-store",
      redirect: "error",
    });
  } catch {
    throw new GitHubProviderError();
  }
  if (!tokenResponse.ok) throw new GitHubProviderError();
  const tokenPayload = await readBoundedJson(tokenResponse);
  if (tokenPayload.error !== undefined || tokenPayload.token_type !== "bearer" || !validAccessToken(tokenPayload.access_token)) {
    throw new GitHubProviderError();
  }

  // GitHub App user access tokens normally include expires_in. If an app is
  // configured without expiring credentials, an eight-hour expiry forces a
  // fresh authorization instead of leaving an unbounded local credential.
  const expiresIn = tokenPayload.expires_in;
  const providerTtl = typeof expiresIn === "number" && Number.isSafeInteger(expiresIn) && expiresIn > 0
    ? Math.min(expiresIn, MAX_CREDENTIAL_TTL_MS / 1000) * 1000
    : null;
  if (expiresIn !== undefined && providerTtl === null) throw new GitHubProviderError();
  const tokenExpiresAt = new Date(now.getTime() + Math.min(providerTtl ?? MAX_CREDENTIAL_TTL_MS, MAX_CREDENTIAL_TTL_MS));

  let userResponse: Response;
  try {
    userResponse = await fetcher(USER_URL, {
      method: "GET",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${tokenPayload.access_token}`,
        "X-GitHub-Api-Version": "2026-03-10",
      },
      signal: timeoutSignal(),
      cache: "no-store",
      redirect: "error",
    });
  } catch {
    throw new GitHubProviderError();
  }
  if (!userResponse.ok) throw new GitHubProviderError();
  const profile = await readBoundedJson(userResponse);
  const githubUserId = parseUserId(profile.id);
  const login = parseLogin(profile.login);
  const displayName = parseDisplayName(profile.name);
  if (!githubUserId || !login || displayName === undefined) throw new GitHubProviderError();

  return { githubUserId, login, displayName, accessToken: tokenPayload.access_token, tokenExpiresAt };
}

export function challengeForVerifier(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}
