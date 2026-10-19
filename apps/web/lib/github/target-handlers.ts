import { randomUUID } from "node:crypto";
import { parseAuthBaseConfig, isSameOriginPost } from "../auth/config.ts";
import { GitHubRepositoryClient, GitHubRepositoryError } from "./client.ts";

export type TargetHandlerDependencies = {
  env: Record<string, string | undefined>;
  readSession: (request: Request) => Promise<{ userId: string; accessToken: string } | null>;
  createClient?: (token: string) => Pick<GitHubRepositoryClient, "listBranches" | "resolveTarget">;
};
function json(value: unknown, status = 200) {
  return Response.json(value, { status, headers: { "Cache-Control": "private, no-store", Vary: "Cookie", "X-Content-Type-Options": "nosniff" } });
}
function error(code: string, message: string, status: number) {
  return json({ error: { code, message, details: {} }, requestId: randomUUID() }, status);
}
export function createTargetHandlers(deps: TargetHandlerDependencies) {
  async function run(request: Request, action: (client: Pick<GitHubRepositoryClient, "listBranches" | "resolveTarget">) => Promise<unknown>) {
    try {
      const session = await deps.readSession(request);
      if (!session) return error("AUTH_REQUIRED", "Sesi berakhir. Masuk lagi dengan GitHub.", 401);
      return json({ data: await action(deps.createClient?.(session.accessToken) ?? new GitHubRepositoryClient({ accessToken: session.accessToken })) });
    } catch (e) {
      if (e instanceof GitHubRepositoryError) return error(e.code, e.message, e.status);
      return error("GITHUB_UNAVAILABLE", "Target belum dapat diperiksa. Coba lagi.", 503);
    }
  }
  return {
    branches(request: Request) {
      const query = new URL(request.url).searchParams;
      const page = query.get("page") ?? "1";
      const repository = query.get("repository");
      if (!repository || !/^[1-9][0-9]?$|^100$/.test(page) || [...query.keys()].some(key => !["page", "repository"].includes(key))
        || query.getAll("repository").length > 1 || query.getAll("page").length > 1) return Promise.resolve(error("INVALID_INPUT", "Repository atau halaman tidak valid.", 400));
      return run(request, client => client.listBranches(repository, { page: Number(page) }));
    },
    async target(request: Request) {
      const config = parseAuthBaseConfig(deps.env);
      if (!config) return error("GITHUB_UNAVAILABLE", "Konfigurasi aplikasi belum tersedia.", 503);
      if (!isSameOriginPost(request, config)) return error("ORIGIN_DENIED", "Asal permintaan tidak diizinkan.", 403);
      if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") ?? "")) return error("INVALID_INPUT", "Gunakan payload JSON.", 400);
      let payload: unknown;
      const reader = request.body?.getReader();
      if (!reader) return error("INVALID_INPUT", "Target wajib diisi.", 400);
      try {
        const chunks: Uint8Array[] = []; let total = 0;
        while (true) {
          const part = await reader.read(); if (part.done) break;
          total += part.value.byteLength;
          if (total > 2048) { await reader.cancel(); return error("INVALID_INPUT", "Payload terlalu besar.", 400); }
          chunks.push(part.value);
        }
        payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch { return error("INVALID_INPUT", "Target tidak valid.", 400); }
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) return error("INVALID_INPUT", "Target tidak valid.", 400);
      const input = payload as Record<string, unknown>;
      if (Object.keys(input).some(key => !["repository", "branch", "commit"].includes(key))
        || typeof input.repository !== "string" || typeof input.branch !== "string"
        || (input.commit !== undefined && input.commit !== null && typeof input.commit !== "string")) return error("INVALID_INPUT", "Target tidak valid.", 400);
      return run(request, client => client.resolveTarget({ repository: input.repository as string, branch: input.branch as string, commit: input.commit as string | null | undefined }));
    },
  };
}
