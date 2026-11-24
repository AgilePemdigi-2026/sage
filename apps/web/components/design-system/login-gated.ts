/** Halaman yang butuh login → tujuan /login langsung saat belum login (tanpa render redirect perantara). */
const LOGIN_GATED: Readonly<Record<string, "repository" | "history">> = {
  "/workspace/repositories": "repository",
  "/workspace/history": "history",
};

/**
 * Href untuk link ke halaman yang butuh login. Tanpa sesi, link langsung ke /login?reason=auth-required&from=…
 * sehingga navigasi klien tidak melewati redirect server (yang sesaat merender segmen kosong).
 * Guard server di halaman tetap berlaku untuk akses langsung/URL lama.
 */
export function loginGatedHref(href: string, signedIn: boolean): string {
  const from = LOGIN_GATED[href];
  return signedIn || !from ? href : `/login?reason=auth-required&from=${from}`;
}
