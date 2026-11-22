import { cache } from "react";
import { headers } from "next/headers";
import { getUniqueCookie, isValidOpaqueToken, SESSION_COOKIE } from "./handlers.ts";
import type { LoginFromPage } from "./config.ts";
import { readWorkspaceContext } from "./server-session.ts";

/** readWorkspaceContext tanpa perubahan logika, di-dedupe per request (root layout + halaman = satu query session). */
export const readWorkspaceContextCached = cache(readWorkspaceContext);

/**
 * Tujuan redirect ke /login saat konteks workspace tidak tersedia.
 * Cookie sesi ada tetapi tidak valid lagi → sesi berakhir (error=session); tanpa cookie → perlu masuk (reason netral).
 */
export async function loginRedirectPath(from: LoginFromPage): Promise<string> {
  const token = getUniqueCookie((await headers()).get("cookie"), SESSION_COOKIE);
  return isValidOpaqueToken(token) ? "/login?error=session" : `/login?reason=auth-required&from=${from}`;
}
