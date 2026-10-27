import { randomUUID } from "node:crypto";
import type { CleanupSnapshot } from "@sage/database";
import { AnalysisDeletionActiveError, AnalysisDeletionNotFoundError } from "@sage/database";
import { isSameOriginPost, parseAuthBaseConfig } from "../auth/config.ts";
import type { AnalysisSession } from "./handlers.ts";

export interface CleanupHandlerDependencies {
  env: Record<string, string | undefined>;
  readSession(request: Request): Promise<AnalysisSession | null>;
  requestDeletion(ownerUserId: string, analysisId: string): Promise<CleanupSnapshot>;
  findJob(ownerUserId: string, jobId: string): Promise<CleanupSnapshot | null>;
}
const ID = /^[A-Za-z0-9_-]{8,64}$/;
const HEADERS = { "Cache-Control": "private, no-store", Vary: "Cookie, X-SAGE-Account", "X-Content-Type-Options": "nosniff" };
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: HEADERS });
const error = (code: string, message: string, status: number) => json({ error: { code, message, details: {} }, requestId: randomUUID() }, status);
const publicSnapshot = (value: CleanupSnapshot) => ({ jobId: value.jobId, analysisId: value.analysisId, status: value.status, errorCode: value.errorCode });

async function emptyObject(request: Request): Promise<boolean> {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") ?? "")) return false;
  const reader = request.body?.getReader();
  if (!reader) return false;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 512) { await reader.cancel(); return false; }
      chunks.push(part.value);
    }
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0;
  } catch { return false; } finally { reader.releaseLock(); }
}

export function createCleanupHandlers(deps: CleanupHandlerDependencies) {
  async function identity(request: Request) {
    const session = await deps.readSession(request);
    return session && (!request.headers.has("x-sage-account") || request.headers.get("x-sage-account") === session.githubUserId) ? session : null;
  }
  const valid = (request: Request, id: string) => ID.test(id) && new URL(request.url).search === "";
  return {
    async remove(request: Request, analysisId: string): Promise<Response> {
      if (request.method !== "DELETE" || !valid(request, analysisId)) return error("INVALID_INPUT", "Permintaan penghapusan tidak valid.", 400);
      try {
        const session = await identity(request);
        if (!session) return error("AUTH_REQUIRED", "Sesi berakhir atau akun berubah. Masuk lagi.", 401);
        const config = parseAuthBaseConfig(deps.env);
        if (!config) return error("CLEANUP_UNAVAILABLE", "Penghapusan belum tersedia. Coba lagi.", 503);
        if (!isSameOriginPost(request, config)) return error("FORBIDDEN_ORIGIN", "Asal permintaan tidak diizinkan.", 403);
        if (!await emptyObject(request)) return error("INVALID_INPUT", "Body penghapusan harus object JSON kosong.", 400);
        const deletion = await deps.requestDeletion(session.userId, analysisId);
        if (deletion.analysisId !== analysisId) return error("CLEANUP_UNAVAILABLE", "Penghapusan belum dapat diproses. Coba lagi.", 503);
        const current = await identity(request);
        if (!current || current.userId !== session.userId || current.githubUserId !== session.githubUserId) return error("AUTH_REQUIRED", "Sesi berakhir atau akun berubah. Masuk lagi.", 401);
        if (deletion.status === "COMPLETED") return new Response(null, { status: 204, headers: HEADERS });
        return json({ data: { analysisId, accountKey: session.githubUserId, deletion: publicSnapshot(deletion) } }, 202);
      } catch (cause) {
        if (cause instanceof AnalysisDeletionNotFoundError) return error("ANALYSIS_NOT_FOUND", "Analisis tidak ditemukan.", 404);
        if (cause instanceof AnalysisDeletionActiveError) return error(cause.code, cause.code === "ANALYSIS_ACTIVE" ? "Analisis masih aktif. Tunggu hingga selesai." : "Ekspor masih aktif. Tunggu hingga selesai.", 409);
        return error("CLEANUP_UNAVAILABLE", "Penghapusan belum dapat diproses. Coba lagi.", 503);
      }
    },
    async job(request: Request, jobId: string): Promise<Response> {
      if (request.method !== "GET" || !valid(request, jobId)) return error("INVALID_INPUT", "ID job tidak valid.", 400);
      try {
        const session = await identity(request);
        if (!session) return error("AUTH_REQUIRED", "Sesi berakhir atau akun berubah. Masuk lagi.", 401);
        const deletion = await deps.findJob(session.userId, jobId);
        if (!deletion) return error("JOB_NOT_FOUND", "Job penghapusan tidak ditemukan.", 404);
        const current = await identity(request);
        if (!current || current.userId !== session.userId || current.githubUserId !== session.githubUserId) return error("AUTH_REQUIRED", "Sesi berakhir atau akun berubah. Masuk lagi.", 401);
        return json({ data: { analysisId: deletion.analysisId, accountKey: session.githubUserId, deletion: publicSnapshot(deletion) } });
      } catch { return error("CLEANUP_UNAVAILABLE", "Status penghapusan belum dapat dibaca. Coba lagi.", 503); }
    },
  };
}
