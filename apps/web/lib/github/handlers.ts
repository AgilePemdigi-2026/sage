import { randomUUID } from "node:crypto";
import { isSameOriginPost, parseAuthBaseConfig } from "../auth/config.ts";
import { GitHubRepositoryClient, GitHubRepositoryError } from "./client.ts";

export type RepositorySession = { userId: string; githubUserId: string; githubLogin: string; accessToken: string };
export type RepositoryHandlerDependencies = {
  readSession: (request: Request) => Promise<RepositorySession | null>;
  env: Record<string, string | undefined>;
  createClient?: (token: string) => Pick<GitHubRepositoryClient, "listInstallations" | "listInstallationRepositories" | "listPublicRepositories" | "resolveRepository">;
};

function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "private, no-store", Vary: "Cookie, X-SAGE-Account", "X-Content-Type-Options": "nosniff" } });
}
function failure(code: string, message: string, status: number) {
  return json({ error: { code, message, details: {} }, requestId: randomUUID() }, status);
}
function pageOf(request: Request): number | null {
  const params = new URL(request.url).searchParams;
  if ([...params.keys()].some(key => key !== "page") || params.getAll("page").length > 1) return null;
  const page = params.get("page") ?? "1";
  return /^[1-9][0-9]?$|^100$/.test(page) ? Number(page) : null;
}

export function createRepositoryHandlers(deps: RepositoryHandlerDependencies) {
  async function run(request: Request, action: (client: Pick<GitHubRepositoryClient, "listInstallations" | "listInstallationRepositories" | "listPublicRepositories" | "resolveRepository">, session: RepositorySession) => Promise<unknown>) {
    try {
      const session = await deps.readSession(request);
      if (!session) return failure("AUTH_REQUIRED", "Sesi berakhir. Masuk lagi dengan GitHub.", 401);
      if (request.headers.has("x-sage-account") && request.headers.get("x-sage-account") !== session.githubUserId) {
        return failure("AUTH_REQUIRED", "Akun GitHub berubah. Muat ulang halaman.", 401);
      }
      const client = deps.createClient?.(session.accessToken) ?? new GitHubRepositoryClient({ accessToken: session.accessToken });
      return json({ data: await action(client, session) });
    } catch (error) {
      if (error instanceof GitHubRepositoryError) return failure(error.code, error.message, error.status);
      return failure("GITHUB_UNAVAILABLE", "Layanan repository belum tersedia. Coba lagi.", 503);
    }
  }
  return {
    session(request: Request) {
      return (async () => {
        try {
          const session = await deps.readSession(request);
          if (!session) return failure("AUTH_REQUIRED", "Sesi berakhir atau akun GitHub berubah. Muat ulang halaman.", 401);
          if (request.headers.has("x-sage-account") && request.headers.get("x-sage-account") !== session.githubUserId) {
            return failure("AUTH_REQUIRED", "Akun GitHub berubah. Muat ulang halaman.", 401);
          }
          return json({ data: { accountKey: session.githubUserId, login: session.githubLogin } });
        } catch {
          return failure("GITHUB_UNAVAILABLE", "Sesi belum dapat diperiksa. Coba lagi.", 503);
        }
      })();
    },
    installations(request: Request) {
      const page = pageOf(request);
      if (!page) return Promise.resolve(failure("INVALID_INPUT", "Halaman tidak valid.", 400));
      return run(request, client => client.listInstallations({ page }));
    },
    installationRepositories(request: Request, id: string) {
      const page = pageOf(request);
      if (!page || !/^[1-9][0-9]{0,15}$/.test(id)) return Promise.resolve(failure("INVALID_INPUT", "Instalasi atau halaman tidak valid.", 400));
      return run(request, client => client.listInstallationRepositories(id, { page }));
    },
    publicRepositories(request: Request) {
      const page = pageOf(request);
      if (!page) return Promise.resolve(failure("INVALID_INPUT", "Halaman tidak valid.", 400));
      return run(request, (client, session) => client.listPublicRepositories(session.githubLogin, { page }));
    },
    async resolve(request: Request) {
      const config = parseAuthBaseConfig(deps.env);
      if (!config) return failure("GITHUB_UNAVAILABLE", "Konfigurasi aplikasi belum tersedia.", 503);
      if (!isSameOriginPost(request, config)) return failure("ORIGIN_DENIED", "Asal permintaan tidak diizinkan.", 403);
      if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") ?? "")) return failure("INVALID_INPUT", "Gunakan payload JSON.", 400);
      // Stream bounded independently of Content-Length, which an untrusted client can omit.
      let body: unknown;
      const reader = request.body?.getReader();
      if (!reader) return failure("INVALID_INPUT", "Repository wajib diisi.", 400);
      try {
        const chunks: Uint8Array[] = []; let length = 0;
        while (true) {
          const part = await reader.read(); if (part.done) break;
          length += part.value.byteLength;
          if (length > 1024) { await reader.cancel(); return failure("INVALID_INPUT", "Payload terlalu besar.", 400); }
          chunks.push(part.value);
        }
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch { return failure("INVALID_INPUT", "Payload tidak valid.", 400); }
      if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(key => key !== "repository")
        || typeof (body as { repository?: unknown }).repository !== "string") return failure("INVALID_INPUT", "Repository wajib diisi.", 400);
      return run(request, client => client.resolveRepository((body as { repository: string }).repository));
    },
  };
}
