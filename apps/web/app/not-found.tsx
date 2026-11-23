import type { Metadata } from "next";
import { Button, DesignFrame, EmptyState } from "../components/design-system/ui.tsx";
import { loginGatedHref } from "../components/design-system/login-gated.ts";
import { readHeaderAccount } from "../lib/auth/header-account.ts";

export const metadata: Metadata = { title: "Halaman tidak ditemukan" };

export default async function NotFound() {
  const signedIn = Boolean(await readHeaderAccount());
  return <DesignFrame>
    <EmptyState
      variant="page"
      icon={{ group: "repository", name: "imgSearch" }}
      title="Halaman tidak ditemukan"
      action={<>
        <Button href="/" arrow>Kembali ke beranda</Button>
        <Button href={loginGatedHref("/workspace/history", signedIn)} variant="secondary">Buka Riwayat</Button>
      </>}
    >Alamat ini tidak tersedia atau sudah dipindahkan. Periksa kembali tautannya, atau lanjutkan dari beranda.</EmptyState>
  </DesignFrame>;
}
