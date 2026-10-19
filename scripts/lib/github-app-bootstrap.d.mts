export type GitHubAppEnvironment = Readonly<{
  GITHUB_APP_ID: string;
  GITHUB_APP_CLIENT_ID: string;
  GITHUB_APP_CLIENT_SECRET: string;
  GITHUB_APP_PRIVATE_KEY_BASE64: string;
  GITHUB_APP_SLUG: string;
  GITHUB_APP_URL: string;
  AUTH_BASE_URL: string;
}>;

export const LOOPBACK_HOST: "127.0.0.1";
export const LOOPBACK_PORT: 7010;
export const SETUP_URL: string;
export const REDIRECT_URL: string;
export const AUTH_BASE_URL: string;
export const OAUTH_CALLBACK_URL: string;
export const APP_HOME_URL: string;
export const STATE_TTL_MS: number;
export const CONVERSION_TIMEOUT_MS: number;
export const ENV_KEYS: readonly string[];

export function validateAppName(name: unknown): name is string;
export function validateManifestCode(code: unknown): code is string;
export function createManifest(name: string, state: string): Record<string, unknown>;
export function createOneTimeState(options?: {
  token?: string;
  now?: number;
  ttlMs?: number;
}): Readonly<{
  token: string;
  expiresAt: number;
  consume(candidate: unknown, currentTime?: number): boolean;
  readonly consumed: boolean;
}>;
export function escapeHtml(value: unknown): string;
export function createRegistrationPage(name: string, state: string): string;
export function isAllowedHostHeader(hostHeader: unknown): boolean;
export function normalizeAppResponse(payload: unknown): GitHubAppEnvironment & { appName: string };
export function convertManifestCode(code: string, options?: {
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): Promise<GitHubAppEnvironment & { appName: string }>;
export function formatEnvValue(value: string): string;
export function mergeEnvContent(content: string, values: Partial<GitHubAppEnvironment>): string;
export function assertEnvTargetReady(projectRoot: string, options?: { filesystem?: unknown }): Promise<string>;
export function persistAppConfig(
  projectRoot: string,
  values: GitHubAppEnvironment,
  options?: { filesystem?: unknown; randomBytes?: (size: number) => Buffer },
): Promise<void>;
