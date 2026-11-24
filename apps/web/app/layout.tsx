import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";
import { AccountProvider } from "../components/design-system/account-context.tsx";
import { CookieNotice } from "../components/design-system/ui.tsx";
import { readHeaderAccount } from "../lib/auth/header-account.ts";

/*
 * Font self-host lewat next/font/local: woff2 subset latin, hanya weight yang dipakai, font-display swap, dan font
 * fallback ber-metrik (size-adjust/ascent-override dari next/font) agar pergantian font tidak menggeser layout.
 * @font-face disisipkan ke CSS utama (tanpa file CSS font terpisah yang render-blocking). Lisensi: app/fonts/OFL-*.txt.
 */
const jakarta = localFont({
  src: [
    { path: "./fonts/plus-jakarta-sans-latin-400-normal.woff2", weight: "400", style: "normal" },
    { path: "./fonts/plus-jakarta-sans-latin-500-normal.woff2", weight: "500", style: "normal" },
    { path: "./fonts/plus-jakarta-sans-latin-600-normal.woff2", weight: "600", style: "normal" },
    { path: "./fonts/plus-jakarta-sans-latin-700-normal.woff2", weight: "700", style: "normal" },
    { path: "./fonts/plus-jakarta-sans-latin-800-normal.woff2", weight: "800", style: "normal" },
  ],
  variable: "--font-jakarta",
  display: "swap",
  // Teks UI (termasuk headline 800, elemen LCP) memakai keluarga ini: di-preload agar umumnya sudah tersedia sebelum
  // cat pertama, sehingga swap tidak memicu reflow/CLS. JetBrains Mono tidak di-preload (bukan teks LCP).
  preload: true,
  adjustFontFallback: "Arial",
});
const jetbrainsMono = localFont({
  src: [
    { path: "./fonts/jetbrains-mono-latin-400-normal.woff2", weight: "400", style: "normal" },
    { path: "./fonts/jetbrains-mono-latin-500-normal.woff2", weight: "500", style: "normal" },
    { path: "./fonts/jetbrains-mono-latin-600-normal.woff2", weight: "600", style: "normal" },
    { path: "./fonts/jetbrains-mono-latin-700-normal.woff2", weight: "700", style: "normal" },
  ],
  variable: "--font-jetbrains-mono",
  display: "swap",
  preload: false,
  adjustFontFallback: "Arial",
});

export const metadata: Metadata = {
  // Halaman lain cukup mengisi `title` (tanpa suffix); template menambahkan " | SAGE".
  title: { default: "SAGE", template: "%s | SAGE" },
  description: "Dokumentasi arsitektur berbasis source code: telusuri struktur kode dan dokumentasi arsitektur dengan bukti langsung dari source code.",
};

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const account = await readHeaderAccount();
  return (
    <html lang="id" className={`${jakarta.variable} ${jetbrainsMono.variable}`}>
      <body>
        <AccountProvider account={account}>
          {children}
          <CookieNotice />
        </AccountProvider>
      </body>
    </html>
  );
}
