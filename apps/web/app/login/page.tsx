import type { Metadata } from "next";
import { parseGitHubAuthConfig, safeAuthErrorMessage } from "../../lib/auth/config.ts";
import { DesignFrame, Panel } from "../../components/design-system/ui.tsx";

export const metadata: Metadata = {
  title: "Masuk — SAGE",
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
  const ready = parseGitHubAuthConfig(process.env) !== null;

  return (
    <DesignFrame>
      <div className="mx-auto flex min-h-[calc(100dvh-140px)] w-full max-w-3xl flex-col justify-center py-10">
      <Panel className="p-7 sm:p-10">
        <p className="font-mono text-xs tracking-wide text-ink/55">AKSES WORKSPACE</p>
        <h1 className="mt-3 text-[28px] leading-9 font-semibold tracking-tight">Masuk dengan GitHub</h1>
        <p className="mt-4 max-w-xl text-sm leading-6 text-ink/65">
          SAGE memakai GitHub App untuk menghubungkan akunmu. Token disimpan dan digunakan hanya di server.
          Sesi lokal berakhir paling lambat dalam delapan jam; setelah itu, masuk lagi untuk mengotorisasi ulang.
        </p>
        {loggedOut ? <p role="status" className="mt-6 rounded-lg bg-emerald-50 px-4 py-3 text-sm text-emerald-900">Kamu sudah keluar dari SAGE.</p> : null}
        {message ? <p role="alert" className="mt-6 rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-950">{message}</p> : null}
        <form className="mt-8" action="/auth/github" method="post">
          <button
            className="inline-flex min-h-12 items-center justify-center rounded-lg bg-ink px-5 py-3 text-sm font-semibold text-white transition hover:bg-ink/90 disabled:cursor-not-allowed disabled:opacity-50"
            type="submit"
            disabled={!ready}
          >
            Masuk dengan GitHub
          </button>
        </form>
        {!ready && !message ? <p className="mt-4 text-sm text-amber-900">Login GitHub belum tersedia karena konfigurasi aplikasi belum lengkap.</p> : null}
        <p className="mt-8 border-t border-ink/10 pt-5 text-xs leading-5 text-ink/55">
          Login hanya meminta akses profil GitHub. SAGE belum menjalankan analisis repository dari halaman ini.
        </p>
      </Panel>
      </div>
    </DesignFrame>
  );
}
