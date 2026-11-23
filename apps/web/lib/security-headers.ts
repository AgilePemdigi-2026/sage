/**
 * Header keamanan HTTP untuk semua route.
 *
 * Statis (next.config.ts → headers(), dievaluasi saat build). HSTS bergantung pada AUTH_BASE_URL yang baru
 * tersedia saat runtime container, jadi dipasang terpisah oleh proxy.ts lewat `strictTransportSecurity()`.
 *
 * CSP masih Report-Only: Next.js menyisipkan skrip inline (payload RSC) sehingga `script-src 'self'` murni
 * belum bisa di-enforce tanpa nonce. Pelanggaran muncul di console browser tanpa memblokir apa pun.
 */
export const contentSecurityPolicy = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https://avatars.githubusercontent.com",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  // POST /auth/github dialihkan ke github.com; Chrome menerapkan form-action pada redirect itu.
  "form-action 'self' https://github.com",
  "frame-ancestors 'none'",
].join("; ");

export const securityHeaders: ReadonlyArray<{ key: string; value: string }> = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  { key: "Content-Security-Policy-Report-Only", value: contentSecurityPolicy },
];

/** Nilai HSTS bila AUTH_BASE_URL memakai https; null untuk origin http (pengembangan lokal). */
export function strictTransportSecurity(authBaseUrl: string | undefined): string | null {
  if (!authBaseUrl) return null;
  try {
    return new URL(authBaseUrl).protocol === "https:" ? "max-age=31536000; includeSubDomains" : null;
  } catch {
    return null;
  }
}
