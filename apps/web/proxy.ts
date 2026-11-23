import { NextResponse } from "next/server";
import { strictTransportSecurity } from "./lib/security-headers.ts";

/** Hanya menambah HSTS saat runtime (AUTH_BASE_URL https). Tidak mengubah routing atau autentikasi. */
export function proxy() {
  const response = NextResponse.next();
  const hsts = strictTransportSecurity(process.env.AUTH_BASE_URL);
  if (hsts) response.headers.set("Strict-Transport-Security", hsts);
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image).*)"],
};
