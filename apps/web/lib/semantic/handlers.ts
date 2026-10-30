import { randomUUID } from "node:crypto";
import type { AnalysisSession } from "../analyses/handlers.ts";
import type { PresentationOverlay, SemanticModel } from "../../../../packages/documents/src/semantic/model.ts";
import { isPresentationOverlay } from "../../../../packages/documents/src/semantic/validation.ts";
import { isSameOriginPost, parseAuthBaseConfig } from "../auth/config.ts";

const ID = /^[A-Za-z0-9_-]{8,64}$/;
const RESPONSE_HEADERS = {
  "Cache-Control": "private, no-store",
  Vary: "Cookie, X-SAGE-Account",
  "X-Content-Type-Options": "nosniff",
};
const MAX_PATCH_BYTES = 256 * 1024;

export type SemanticReadValue = {
  id: string;
  modelHash: string;
  model: SemanticModel;
  revision: number;
  overlay: PresentationOverlay;
};

export type SemanticHandlerDependencies = {
  env: Record<string, string | undefined>;
  readSession: (request: Request) => Promise<AnalysisSession | null>;
  readSemantic: (ownerUserId: string, analysisId: string, revision?: number) => Promise<SemanticReadValue | null>;
  readState: (ownerUserId: string, analysisId: string) => Promise<"missing" | "legacy" | "ready">;
  savePresentation: (input: { ownerUserId: string; analysisId: string; expectedRevision: number; overlay: unknown }) => Promise<SemanticReadValue>;
};

function json(value: unknown, status = 200) {
  return Response.json(value, { status, headers: RESPONSE_HEADERS });
}

function failure(code: string, message: string, status: number) {
  return json({ error: { code, message, details: {} }, requestId: randomUUID() }, status);
}

function accountIsCurrent(request: Request, session: AnalysisSession): boolean {
  return !request.headers.has("x-sage-account") || request.headers.get("x-sage-account") === session.githubUserId;
}

function parseRevision(request: Request): { valid: true; revision?: number } | { valid: false } {
  const params = new URL(request.url).searchParams;
  const entries = [...params.entries()];
  if (entries.length === 0) return { valid: true };
  if (entries.length !== 1 || entries[0]?.[0] !== "revision" || !/^(?:0|[1-9]\d{0,7})$/.test(entries[0][1])) return { valid: false };
  const revision = Number(entries[0][1]);
  return Number.isSafeInteger(revision) ? { valid: true, revision } : { valid: false };
}

function exactRecord(value: unknown, fields: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const keys = Reflect.ownKeys(value);
  return keys.length === fields.length && keys.every(key => {
    if (typeof key !== "string" || !fields.includes(key)) return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return !!descriptor && descriptor.enumerable && "value" in descriptor;
  });
}

async function boundedJson(request: Request): Promise<unknown | null> {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") ?? "")) return null;
  const header = request.headers.get("content-length");
  if (header !== null && (!/^\d+$/.test(header) || Number(header) > MAX_PATCH_BYTES)) return null;
  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > MAX_PATCH_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(part.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
}

function publicValue(analysisId: string, accountKey: string, value: SemanticReadValue) {
  return { analysisId, accountKey, modelHash: value.modelHash, model: value.model, revision: value.revision, overlay: value.overlay };
}

function unavailableState(state: "missing" | "legacy" | "ready"): Response {
  if (state === "legacy") return failure("SEMANTIC_REANALYSIS_REQUIRED", "Analisis lama belum memiliki model alur semantik. Jalankan analisis ulang untuk melihat hasil baru.", 409);
  return failure("ANALYSIS_NOT_FOUND", "Analisis tidak ditemukan.", 404);
}

export function createSemanticHandlers(deps: SemanticHandlerDependencies) {
  return {
    async get(request: Request, analysisId: string): Promise<Response> {
      if (request.method !== "GET" || !ID.test(analysisId)) return failure("INVALID_INPUT", "Permintaan model semantik tidak valid.", 400);
      const parsedRevision = parseRevision(request);
      if (!parsedRevision.valid) return failure("INVALID_INPUT", "Versi koreksi tidak valid.", 400);
      try {
        const session = await deps.readSession(request);
        if (!session || !accountIsCurrent(request, session)) return failure("AUTH_REQUIRED", "Sesi berakhir atau akun berubah. Masuk lagi.", 401);
        const value = await deps.readSemantic(session.userId, analysisId, parsedRevision.revision);
        if (!value) return unavailableState(await deps.readState(session.userId, analysisId));
        return json({ data: publicValue(analysisId, session.githubUserId, value) });
      } catch {
        return failure("SEMANTIC_UNAVAILABLE", "Model semantik tidak konsisten atau sementara tidak dapat dibaca. Coba lagi.", 503);
      }
    },

    async patchPresentation(request: Request, analysisId: string): Promise<Response> {
      if (request.method !== "PATCH" || !ID.test(analysisId) || new URL(request.url).search !== "") {
        return failure("INVALID_INPUT", "Permintaan koreksi semantik tidak valid.", 400);
      }
      try {
        const session = await deps.readSession(request);
        if (!session || !accountIsCurrent(request, session)) return failure("AUTH_REQUIRED", "Sesi berakhir atau akun berubah. Masuk lagi.", 401);
        const config = parseAuthBaseConfig(deps.env);
        if (!config) return failure("SEMANTIC_UNAVAILABLE", "Koreksi semantik belum tersedia. Coba lagi.", 503);
        if (!isSameOriginPost(request, config)) return failure("FORBIDDEN_ORIGIN", "Asal permintaan tidak diizinkan.", 403);
        const body = await boundedJson(request);
        if (!exactRecord(body, ["expectedRevision", "overlay"]) || !Number.isSafeInteger(body.expectedRevision) ||
            Number(body.expectedRevision) < 0 || Number(body.expectedRevision) > 10_000_000) {
          return failure("INVALID_INPUT", "Body koreksi semantik tidak valid.", 400);
        }
        const current = await deps.readSemantic(session.userId, analysisId);
        if (!current) return unavailableState(await deps.readState(session.userId, analysisId));
        if (!isPresentationOverlay(body.overlay, current.model)) return failure("INVALID_INPUT", "Label atau kelompok koreksi tidak sesuai dengan model semantik.", 400);
        const saved = await deps.savePresentation({
          ownerUserId: session.userId,
          analysisId,
          expectedRevision: Number(body.expectedRevision),
          overlay: body.overlay,
        });
        return json({ data: publicValue(analysisId, session.githubUserId, saved) });
      } catch (cause) {
        if (cause instanceof Error && cause.name === "SemanticPresentationConflictError") {
          return failure("PRESENTATION_REVISION_CONFLICT", "Koreksi berubah di tab lain. Muat ulang sebelum menyimpan lagi.", 409);
        }
        if (cause instanceof Error && cause.name === "SemanticAnalysisNotFoundError") {
          const session = await deps.readSession(request).catch(() => null);
          if (session) return unavailableState(await deps.readState(session.userId, analysisId).catch(() => "missing"));
          return failure("AUTH_REQUIRED", "Sesi berakhir atau akun berubah. Masuk lagi.", 401);
        }
        return failure("SEMANTIC_UNAVAILABLE", "Koreksi semantik belum dapat disimpan. Coba lagi.", 503);
      }
    },
  };
}
