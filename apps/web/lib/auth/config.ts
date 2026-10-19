export type AuthBaseConfig = {
  readonly origin: string;
  readonly callbackUrl: string;
  readonly secureCookies: boolean;
};

export type GitHubAuthConfig = AuthBaseConfig & {
  readonly clientId: string;
  readonly clientSecret: string;
};

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "localhost" || normalized.endsWith(".localhost") || normalized === "::1") return true;
  const octets = normalized.split(".");
  return octets.length === 4 && octets.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
    && Number(octets[0]) === 127;
}

export function parseAuthBaseConfig(env: Record<string, string | undefined>): AuthBaseConfig | null {
  const base = env.AUTH_BASE_URL;
  if (!base) return null;

  let parsed: URL;
  try {
    parsed = new URL(base);
  } catch {
    return null;
  }

  if (parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== "/") return null;
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  if (parsed.protocol === "http:" && !isLoopbackHostname(parsed.hostname)) return null;
  if (parsed.origin === "null") return null;

  const origin = parsed.origin;
  return {
    origin,
    callbackUrl: `${origin}/auth/github/callback`,
    secureCookies: parsed.protocol === "https:",
  };
}

export function parseGitHubAuthConfig(env: Record<string, string | undefined>): GitHubAuthConfig | null {
  const base = parseAuthBaseConfig(env);
  const clientId = env.GITHUB_APP_CLIENT_ID;
  const clientSecret = env.GITHUB_APP_CLIENT_SECRET;
  if (!base || !clientId || !clientSecret || clientId.length > 256 || clientSecret.length > 4096) return null;
  return { ...base, clientId, clientSecret };
}

export function isSameOriginPost(request: Request, config: Pick<AuthBaseConfig, "origin">): boolean {
  return request.headers.get("origin") === config.origin;
}

export const SAFE_AUTH_ERRORS = ["denied", "expired", "github", "invalid", "unavailable", "session", "logout"] as const;
export type SafeAuthError = typeof SAFE_AUTH_ERRORS[number];

export function safeAuthErrorMessage(value: string | string[] | undefined): string | null {
  const code = Array.isArray(value) ? null : value;
  switch (code) {
    case "denied": return "Permintaan akses GitHub dibatalkan. Kamu bisa memulai login lagi kapan saja.";
    case "expired": return "Permintaan login sudah kedaluwarsa atau sudah digunakan. Mulai login baru.";
    case "github": return "GitHub tidak dapat menyelesaikan login saat ini. Coba lagi.";
    case "invalid": return "Respons login tidak valid. Mulai login baru.";
    case "unavailable": return "Login GitHub belum tersedia karena konfigurasi aplikasi belum lengkap.";
    case "session": return "Sesi SAGE berakhir. Masuk lagi dengan GitHub.";
    case "logout": return "SAGE belum dapat mencabut sesi saat ini. Coba keluar lagi.";
    default: return null;
  }
}
