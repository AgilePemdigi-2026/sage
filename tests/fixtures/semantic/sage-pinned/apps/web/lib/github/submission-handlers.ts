import { createHash, randomUUID } from "node:crypto";
import { GitHubRepositoryClient, GitHubRepositoryError } from "./client.ts";
import { AnalysisIdempotencyConflictError, type EnqueuedAnalysis } from "@sage/database";
import { parseAuthBaseConfig, isSameOriginPost } from "../auth/config.ts";

type Target = Awaited<ReturnType<GitHubRepositoryClient["resolveTarget"]>>;
export type SubmissionDependencies = {
  env: Record<string, string | undefined>;
  readSession(request: Request): Promise<{ userId: string; accessToken: string } | null>;
  replay(owner: string, keyHash: string, requestHash: string): Promise<EnqueuedAnalysis | null>;
  resolve(token: string, input: { repository: string; branch: string; commit?: string | null }): Promise<Target>;
  enqueue(owner: string, target: Target, idempotency: { keyHash: string; requestHash: string }): Promise<EnqueuedAnalysis>;
};
function json(value: unknown, status: number) { return Response.json(value, { status, headers: { "Cache-Control": "private, no-store", Vary: "Cookie", "X-Content-Type-Options": "nosniff" } }); }
function error(code: string, message: string, status: number) { return json({ error: { code, message, details: {} }, requestId: randomUUID() }, status); }
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
export function createSubmissionHandler(deps: SubmissionDependencies) {
  return async (request: Request) => {
    try {
      const config = parseAuthBaseConfig(deps.env);
      if (!config) return error("GITHUB_UNAVAILABLE", "Konfigurasi belum tersedia.", 503);
      if (!isSameOriginPost(request, config)) return error("ORIGIN_DENIED", "Asal permintaan tidak diizinkan.", 403);
      const session = await deps.readSession(request);
      if (!session) return error("AUTH_REQUIRED", "Sesi berakhir. Masuk lagi dengan GitHub.", 401);
      const key = request.headers.get("idempotency-key");
      if (!key || !/^[A-Za-z0-9_-]{16,128}$/.test(key)) return error("INVALID_INPUT", "Idempotency-Key wajib 16–128 karakter huruf, angka, underscore atau minus.", 400);
      if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") ?? "")) return error("INVALID_INPUT", "Gunakan payload JSON.", 400);
      const reader = request.body?.getReader(); if (!reader) return error("INVALID_INPUT", "Target wajib diisi.", 400);
      const chunks: Uint8Array[] = []; let bytes = 0;
      try { while (true) { const part = await reader.read(); if (part.done) break; bytes += part.value.byteLength; if (bytes > 2048) { await reader.cancel(); return error("INVALID_INPUT", "Payload terlalu besar.", 400); } chunks.push(part.value); } }
      finally { reader.releaseLock(); }
      let input: Record<string, unknown>;
      try { const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8")); if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(); input = value as Record<string, unknown>; }
      catch { return error("INVALID_INPUT", "Target tidak valid.", 400); }
      if (Object.keys(input).some(k => !["repository", "branch", "commit"].includes(k)) || typeof input.repository !== "string" || typeof input.branch !== "string" || (input.commit != null && typeof input.commit !== "string")) return error("INVALID_INPUT", "Target tidak valid.", 400);
      const targetInput = { repository: input.repository as string, branch: input.branch as string, commit: input.commit as string | null | undefined ?? null };
      const idempotency = { keyHash: hash(key), requestHash: hash(JSON.stringify(targetInput)) };
      const prior = await deps.replay(session.userId, idempotency.keyHash, idempotency.requestHash);
      if (prior) return json({ data: { ...prior, replayed: true } }, 200);
      const target = await deps.resolve(session.accessToken, targetInput);
      const queued = await deps.enqueue(session.userId, target, idempotency);
      return json({ data: { ...queued } }, queued.replayed ? 200 : 202);
    } catch (e) {
      if (e instanceof AnalysisIdempotencyConflictError) return error("IDEMPOTENCY_CONFLICT", "Key sudah digunakan untuk target berbeda.", 409);
      if (e instanceof GitHubRepositoryError) return error(e.code, e.message, e.status);
      return error("SUBMISSION_UNAVAILABLE", "Analisis belum dapat diantrekan. Coba lagi dengan key yang sama.", 503);
    }
  };
}
