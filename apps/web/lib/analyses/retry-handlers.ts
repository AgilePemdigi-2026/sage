import { createHash, randomUUID } from "node:crypto";
import {
  AnalysisIdempotencyConflictError,
  AnalysisRetryConflictError,
  type AnalysisRetryTarget,
  type EnqueuedAnalysis,
} from "@sage/database";
import { GitHubRepositoryClient, GitHubRepositoryError } from "../github/client.ts";
import { isSameOriginPost, parseAuthBaseConfig } from "../auth/config.ts";

type ResolvedTarget = Awaited<ReturnType<GitHubRepositoryClient["resolveTarget"]>>;

export type AnalysisRetryHandlerDependencies = {
  env: Record<string, string | undefined>;
  readSession(request: Request): Promise<{ userId: string; accessToken: string } | null>;
  findParent(ownerUserId: string, analysisId: string): Promise<AnalysisRetryTarget | null>;
  replay(ownerUserId: string, keyHash: string, requestHash: string): Promise<EnqueuedAnalysis | null>;
  resolve(token: string, input: { repository: string; branch: string; commit: string }): Promise<ResolvedTarget>;
  enqueue(ownerUserId: string, parent: AnalysisRetryTarget, idempotency: { keyHash: string; requestHash: string }): Promise<EnqueuedAnalysis>;
};

function json(value: unknown, status: number) {
  return Response.json(value, { status, headers: { "Cache-Control": "private, no-store", Vary: "Cookie", "X-Content-Type-Options": "nosniff" } });
}

function error(code: string, message: string, status: number) {
  return json({ error: { code, message, details: {} }, requestId: randomUUID() }, status);
}

const hash = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const ANALYSIS_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

async function readEmptyJsonObject(request: Request): Promise<boolean> {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") ?? "")) return false;
  const reader = request.body?.getReader();
  if (!reader) return false;
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > 512) {
        await reader.cancel();
        return false;
      }
      chunks.push(part.value);
    }
  } catch {
    return false;
  } finally {
    reader.releaseLock();
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return Boolean(value && typeof value === "object" && !Array.isArray(value) && Reflect.ownKeys(value).length === 0);
  } catch {
    return false;
  }
}

function requestHash(parent: AnalysisRetryTarget): string {
  return hash(JSON.stringify({
    retryParentId: parent.analysisId,
    repositoryId: parent.repositoryId,
    repositoryGitHubId: parent.repositoryGitHubId,
    branchName: parent.branchName,
    commitSha: parent.commitSha,
    configurationHash: parent.configurationHash,
    analyzerVersion: parent.analyzerVersion,
    schemaVersion: parent.schemaVersion,
  }));
}

export function createAnalysisRetryHandler(deps: AnalysisRetryHandlerDependencies) {
  return async (request: Request, analysisId: string) => {
    try {
      const config = parseAuthBaseConfig(deps.env);
      if (!config) return error("GITHUB_UNAVAILABLE", "Konfigurasi belum tersedia.", 503);
      if (!isSameOriginPost(request, config)) return error("ORIGIN_DENIED", "Asal permintaan tidak diizinkan.", 403);
      const session = await deps.readSession(request);
      if (!session) return error("AUTH_REQUIRED", "Sesi berakhir atau akun GitHub berubah. Masuk lagi untuk melanjutkan.", 401);
      if (!ANALYSIS_ID_PATTERN.test(analysisId)) return error("INVALID_INPUT", "ID analisis tidak valid.", 400);
      const key = request.headers.get("idempotency-key");
      if (!key || !/^[A-Za-z0-9_-]{16,128}$/.test(key)) return error("INVALID_INPUT", "Idempotency-Key wajib 16–128 karakter huruf, angka, underscore atau minus.", 400);
      if (!(await readEmptyJsonObject(request))) return error("INVALID_INPUT", "Permintaan ulang harus berupa object JSON kosong.", 400);

      const parent = await deps.findParent(session.userId, analysisId);
      if (!parent) return error("ANALYSIS_NOT_FOUND", "Analisis tidak ditemukan.", 404);
      if (parent.status !== "FAILED") return error("ANALYSIS_NOT_RETRYABLE", "Hanya analisis gagal yang dapat diulang.", 409);

      // Re-resolve the stored repository and full SHA with the current credential on every attempt,
      // including idempotent replays, so old permission or repository identity cannot be reused.
      const target = await deps.resolve(session.accessToken, {
        repository: parent.repositoryFullName,
        branch: parent.branchName,
        commit: parent.commitSha,
      });
      if (target.repository.id !== parent.repositoryGitHubId
        || target.branch !== parent.branchName
        || target.commitSha.toLowerCase() !== parent.commitSha.toLowerCase()) {
        return error("RETRY_TARGET_CHANGED", "Repository atau commit target sudah berubah; analisis lama tidak dapat diulang.", 409);
      }

      const idempotency = { keyHash: hash(key), requestHash: requestHash(parent) };
      const prior = await deps.replay(session.userId, idempotency.keyHash, idempotency.requestHash);
      if (prior) return json({ data: { ...prior, replayed: true } }, 200);
      const queued = await deps.enqueue(session.userId, parent, idempotency);
      return json({ data: { ...queued } }, queued.replayed ? 200 : 202);
    } catch (cause) {
      if (cause instanceof AnalysisIdempotencyConflictError) return error("IDEMPOTENCY_CONFLICT", "Key sudah digunakan untuk permintaan ulang yang berbeda.", 409);
      if (cause instanceof AnalysisRetryConflictError) return error("ANALYSIS_NOT_RETRYABLE", "Analisis sebelumnya berubah atau tidak lagi dapat diulang.", 409);
      if (cause instanceof GitHubRepositoryError) return error(cause.code, cause.message, cause.status);
      return error("RETRY_UNAVAILABLE", "Analisis belum dapat diulang. Coba lagi dengan key yang sama.", 503);
    }
  };
}
