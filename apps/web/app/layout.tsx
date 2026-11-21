import type { Metadata } from "next";
import "@fontsource/plus-jakarta-sans/400.css";
import "@fontsource/plus-jakarta-sans/500.css";
import "@fontsource/plus-jakarta-sans/600.css";
import "@fontsource/plus-jakarta-sans/700.css";
import "@fontsource/plus-jakarta-sans/800.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "./globals.css";
import { AccountProvider } from "../components/design-system/account-context.tsx";
import { readHeaderAccount } from "../lib/auth/header-account.ts";

export const metadata: Metadata = {
  title: "SAGE — Dokumentasi arsitektur berbasis source code",
  description: "Telusuri struktur kode dan dokumentasi arsitektur dengan bukti langsung dari source code.",
};

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const account = await readHeaderAccount();
  return <html lang="id"><body><AccountProvider account={account}>{children}</AccountProvider></body></html>;
}
