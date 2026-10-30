import { randomUUID } from "node:crypto";
import { MARKDOWN_RENDERER_VERSION } from "../../../../packages/documents/src/markdown.ts";
import type { ExportSnapshot } from "@sage/database";
import type { ExportFormat } from "@sage/database";
import { PDF_RENDERER_VERSION } from "../../../../packages/documents/src/pdf-version.ts";
import { isSameOriginPost, parseAuthBaseConfig } from "../auth/config.ts";
import type { AnalysisSession } from "../analyses/handlers.ts";
import type { DocumentReadState } from "../documents/types.ts";
import type { ExportDownloadState } from "./reader.ts";

export interface ExportHandlerDependencies {
  env: Record<string, string | undefined>;
  readSession(request: Request): Promise<AnalysisSession | null>;
  readDocument(ownerUserId: string, analysisId: string): Promise<DocumentReadState>;
  enqueue(input: { ownerUserId: string; analysisId: string; format: ExportFormat; documentHash: string; rendererVersion: string }): Promise<{ export: ExportSnapshot; created: boolean }>;
  find(ownerUserId: string, analysisId: string, exportId: string): Promise<ExportSnapshot | null>;
  retry(input: { ownerUserId: string; analysisId: string; exportId: string }): Promise<ExportSnapshot>;
  readDownload(ownerUserId: string, analysisId: string, exportId: string): Promise<ExportDownloadState>;
}

const ANALYSIS_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
const EXPORT_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
const RESPONSE_HEADERS = {
  "Cache-Control": "private, no-store",
  Vary: "Cookie, X-SAGE-Account",
  "X-Content-Type-Options": "nosniff",
} as const;

function json(value: unknown, status = 200) {
  return Response.json(value, { status, headers: RESPONSE_HEADERS });
}

function error(code: string, message: string, status: number) {
  return json({ error: { code, message, details: {} }, requestId: randomUUID() }, status);
}

function hasNoQueryParams(request: Request): boolean {
  return [...new URL(request.url).searchParams.keys()].length === 0;
}

async function readJsonObject(request: Request): Promise<Record<string, unknown> | null> {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") ?? "")) return null;
  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > 512) {
        await reader.cancel();
        return null;
      }
      chunks.push(part.value);
    }
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    if (Reflect.ownKeys(value).some(key => typeof key !== "string")) return null;
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function readEmptyJsonObject(request: Request): Promise<boolean> {
  const value = await readJsonObject(request);
  return value !== null && Reflect.ownKeys(value).length === 0;
}

function exportPayload(analysisId: string, accountKey: string, value: ExportSnapshot) {
  return { data: { analysisId, accountKey, export: value } };
}

export function createExportHandlers(deps: ExportHandlerDependencies) {
  async function readIdentity(request: Request): Promise<AnalysisSession | Response> {
    const session = await deps.readSession(request);
    if (!session) return error("AUTH_REQUIRED", "Sesi berakhir atau akun GitHub berubah. Masuk lagi untuk melanjutkan.", 401);
    if (request.headers.has("x-sage-account") && request.headers.get("x-sage-account") !== session.githubUserId) {
      return error("AUTH_REQUIRED", "Akun GitHub berubah. Muat ulang halaman.", 401);
    }
    return session;
  }

  return {
    async post(request: Request, analysisId: string) {
      if (typeof analysisId !== "string" || !ANALYSIS_ID_PATTERN.test(analysisId) || !hasNoQueryParams(request)) {
        return error("INVALID_INPUT", "Permintaan ekspor tidak valid.", 400);
      }
      const config = parseAuthBaseConfig(deps.env);
      if (!config) return error("EXPORT_UNAVAILABLE", "Ekspor belum tersedia. Coba lagi nanti.", 503);
      if (!isSameOriginPost(request, config)) return error("ORIGIN_DENIED", "Asal permintaan tidak diizinkan.", 403);
      try {
        const identity = await readIdentity(request);
        if (identity instanceof Response) return identity;
        const body = await readJsonObject(request);
        if (!body || Reflect.ownKeys(body).length !== 1 || !Object.hasOwn(body, "format")) {
          return error("INVALID_INPUT", "Permintaan ekspor harus berisi format yang didukung.", 400);
        }
        if (body.format !== "MARKDOWN" && body.format !== "PDF") return error("EXPORT_FORMAT_UNSUPPORTED", "Format ekspor tidak didukung.", 422);
        const format = body.format;
        const document = await deps.readDocument(identity.userId, analysisId);
        if (document.kind === "not-found") return error("ANALYSIS_NOT_FOUND", "Analisis tidak ditemukan.", 404);
        if (document.kind === "not-ready") return error("RESULT_NOT_READY", "Hasil analisis belum siap untuk diekspor.", 409);
        const result = await deps.enqueue({
          ownerUserId: identity.userId,
          analysisId,
          format,
          documentHash: document.value.contentHash,
          rendererVersion: format === "PDF" ? PDF_RENDERER_VERSION : MARKDOWN_RENDERER_VERSION,
        });
        return json(exportPayload(analysisId, identity.githubUserId, result.export), result.created ? 202 : 200);
      } catch (cause) {
        const name = cause instanceof Error ? cause.name : "";
        if (name === "ExportAnalysisNotFoundError") return error("ANALYSIS_NOT_FOUND", "Analisis tidak ditemukan.", 404);
        if (name === "ExportResultNotReadyError") return error("RESULT_NOT_READY", "Hasil analisis belum siap untuk diekspor.", 409);
        if (name === "ExportDocumentChangedError") return error("DOCUMENT_CHANGED", "Dokumen analisis berubah. Muat ulang lalu coba lagi.", 409);
        return error("EXPORT_UNAVAILABLE", "Ekspor belum dapat diantrekan. Coba lagi.", 503);
      }
    },

    async get(request: Request, analysisId: string, exportId: string) {
      if (typeof analysisId !== "string" || !ANALYSIS_ID_PATTERN.test(analysisId)
        || typeof exportId !== "string" || !EXPORT_ID_PATTERN.test(exportId) || !hasNoQueryParams(request)) {
        return error("INVALID_INPUT", "Permintaan status ekspor tidak valid.", 400);
      }
      try {
        const identity = await readIdentity(request);
        if (identity instanceof Response) return identity;
        const value = await deps.find(identity.userId, analysisId, exportId);
        if (!value) return error("EXPORT_NOT_FOUND", "Ekspor tidak ditemukan.", 404);
        return json(exportPayload(analysisId, identity.githubUserId, value));
      } catch {
        return error("EXPORT_UNAVAILABLE", "Status ekspor belum dapat dibaca. Coba lagi.", 503);
      }
    },

    async retry(request: Request, analysisId: string, exportId: string) {
      if (typeof analysisId !== "string" || !ANALYSIS_ID_PATTERN.test(analysisId)
        || typeof exportId !== "string" || !EXPORT_ID_PATTERN.test(exportId) || !hasNoQueryParams(request)) {
        return error("INVALID_INPUT", "Permintaan ekspor ulang tidak valid.", 400);
      }
      const config = parseAuthBaseConfig(deps.env);
      if (!config) return error("EXPORT_UNAVAILABLE", "Ekspor belum tersedia. Coba lagi nanti.", 503);
      if (!isSameOriginPost(request, config)) return error("ORIGIN_DENIED", "Asal permintaan tidak diizinkan.", 403);
      try {
        const identity = await readIdentity(request);
        if (identity instanceof Response) return identity;
        if (!(await readEmptyJsonObject(request))) return error("INVALID_INPUT", "Permintaan ekspor ulang harus berupa object JSON kosong.", 400);
        const value = await deps.retry({ ownerUserId: identity.userId, analysisId, exportId });
        return json(exportPayload(analysisId, identity.githubUserId, value), 202);
      } catch (cause) {
        const name = cause instanceof Error ? cause.name : "";
        if (name === "ExportAnalysisNotFoundError") return error("EXPORT_NOT_FOUND", "Ekspor tidak ditemukan.", 404);
        if (name === "ExportRetryConflictError") return error("EXPORT_RETRY_CONFLICT", "Ekspor hanya dapat diulang setelah gagal.", 409);
        if (name === "ExportResultNotReadyError") return error("RESULT_NOT_READY", "Hasil analisis belum siap untuk diekspor.", 409);
        if (name === "ExportDocumentChangedError") return error("DOCUMENT_CHANGED", "Snapshot dokumen sudah berubah dan tidak dapat diulang.", 409);
        return error("EXPORT_UNAVAILABLE", "Ekspor belum dapat diulang. Coba lagi.", 503);
      }
    },

    async download(request: Request, analysisId: string, exportId: string) {
      if (typeof analysisId !== "string" || !ANALYSIS_ID_PATTERN.test(analysisId)
        || typeof exportId !== "string" || !EXPORT_ID_PATTERN.test(exportId) || !hasNoQueryParams(request)) {
        return error("INVALID_INPUT", "Permintaan unduh ekspor tidak valid.", 400);
      }
      try {
        const identity = await readIdentity(request);
        if (identity instanceof Response) return identity;
        const result = await deps.readDownload(identity.userId, analysisId, exportId);
        if (result.kind === "not-found") return error("EXPORT_NOT_FOUND", "Ekspor tidak ditemukan.", 404);
        if (result.kind === "not-ready") return error("EXPORT_NOT_READY", "Ekspor belum siap diunduh.", 409);
        return new Response(Buffer.from(result.value.bytes) as unknown as BodyInit, {
          status: 200,
          headers: {
            ...RESPONSE_HEADERS,
            "Content-Type": result.value.format === "PDF" ? "application/pdf" : "text/markdown; charset=utf-8",
            "Content-Length": String(result.value.bytes.byteLength),
            "Content-Disposition": `attachment; filename="${result.value.filename}"`,
          },
        });
      } catch {
        return error("EXPORT_UNAVAILABLE", "Berkas ekspor belum dapat dibaca. Coba lagi.", 503);
      }
    },
  };
}
