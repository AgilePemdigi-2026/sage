import type { Metadata } from "next";
import Link from "next/link";
import { authRequiredMessage, parseGitHubAuthConfig, safeAuthErrorMessage } from "../../lib/auth/config.ts";
import { Button, DesignFrame, Panel } from "../../components/design-system/ui.tsx";
import { Icon } from "../../components/design-system/icons.tsx";

export const metadata: Metadata = {
  title: "Masuk",
  robots: { index: false, follow: false },
};
export const dynamic = "force-dynamic";

type LoginPageProps = {
  readonly searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const params = await searchParams;
  const message = safeAuthErrorMessage(params?.error);
  const loggedOut = params?.status === "logged-out";
  const authRequired = message ? null : authRequiredMessage(params?.reason, params?.from);
  const ready = parseGitHubAuthConfig(process.env) !== null;

  return (
    <DesignFrame>
      <div className="mx-auto flex min-h-[calc(100dvh-170px)] w-full max-w-[560px] flex-col justify-center py-6 sm:py-12">
        <Panel>
          <h1 className="text-h1 text-ink">Masuk dengan GitHub</h1>
          <p className="mt-3 text-body text-muted">
            SAGE memakai GitHub App untuk menghubungkan akunmu. Token disimpan dan digunakan hanya di server.
            Sesi lokal berakhir paling lambat dalam delapan jam; setelah itu, masuk lagi untuk mengotorisasi ulang.
          </p>
          {loggedOut ? <p role="status" className="mt-6 rounded-control bg-success-fill px-4 py-3 text-body-sm font-semibold text-success">Kamu sudah keluar dari SAGE.</p> : null}
          {authRequired ? <p role="status" className="mt-6 rounded-control bg-info-fill px-4 py-3 text-body-sm font-semibold text-info">{authRequired}</p> : null}
          {message ? <p role="alert" className="mt-6 rounded-control bg-warning-fill px-4 py-3 text-body-sm font-semibold text-warning">{message}</p> : null}
          <form className="mt-7" action="/auth/github" method="post">
            <Button type="submit" variant="github" size="lg" block disabled={!ready}>
              <Icon name="github" />Masuk dengan GitHub
            </Button>
            <p className="mt-3 text-body-sm text-ink">
              Sebelum masuk, baca <Link className="underline underline-offset-4" href="/policies#ketentuan">ketentuan layanan</Link> dan <Link className="underline underline-offset-4" href="/policies#privasi">kebijakan privasi</Link>.
            </p>
          </form>
          {!ready && !message ? <p className="mt-4 text-caption text-warning">Login GitHub belum tersedia karena konfigurasi aplikasi belum lengkap.</p> : null}
          <p className="mt-7 border-t border-border-soft pt-5 text-caption text-subtle">
            Login hanya meminta akses profil GitHub. SAGE belum menjalankan analisis repository dari halaman ini.
          </p>
        </Panel>
      </div>
    </DesignFrame>
  );
}
