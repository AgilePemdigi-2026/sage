import type { Metadata } from "next";
import "@fontsource/plus-jakarta-sans/400.css";
import "@fontsource/plus-jakarta-sans/500.css";
import "@fontsource/plus-jakarta-sans/600.css";
import "@fontsource/plus-jakarta-sans/700.css";
import "@fontsource/plus-jakarta-sans/800.css";
import "./globals.css";
import { AccountProvider } from "../components/design-system/account-context.tsx";
import { readHeaderAccount } from "../lib/auth/header-account.ts";

export const metadata: Metadata = {
  // Halaman lain cukup mengisi `title` (tanpa suffix); template menambahkan " | SAGE".
  title: { default: "SAGE", template: "%s | SAGE" },
  description: "Dokumentasi arsitektur berbasis source code: telusuri struktur kode dan dokumentasi arsitektur dengan bukti langsung dari source code.",
};

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const account = await readHeaderAccount();
  return (
    <html lang="id">
      <body>
        <AccountProvider account={account}>
          {children}
        </AccountProvider>
      </body>
    </html>
  );
}
