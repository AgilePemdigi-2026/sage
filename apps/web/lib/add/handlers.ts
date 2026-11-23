import { randomUUID } from "node:crypto";
import type { CcmV1 } from "@sage/contracts";
import type { SemanticModel } from "../../../../packages/documents/src/semantic/model.ts";
import { buildAddBaseline } from "../../../../packages/documents/src/baseline-add.ts";
import { emptyAddReviewOverlay, parseAddReviewOverlay } from "../../../../packages/documents/src/add-overlay.ts";
import { enrichAddNarrative } from "../../../../packages/documents/src/baseline-llm.ts";
import type { AnalysisSession } from "../analyses/handlers.ts";
import { isSameOriginPost, parseAuthBaseConfig } from "../auth/config.ts";

const ID = /^[A-Za-z0-9_-]{8,64}$/;
const headers = { "Cache-Control": "private, no-store", Vary: "Cookie, X-SAGE-Account", "X-Content-Type-Options": "nosniff" };
const json = (value: unknown, status = 200) => Response.json(value, { status, headers });
const failure = (code: string, message: string, status: number) => json({ error: { code, message, details: {} }, requestId: randomUUID() }, status);

export type AddHandlerDependencies = {
  env: Record<string, string | undefined>;
  readSession: (request: Request) => Promise<AnalysisSession | null>;
  readInputs: (ownerUserId: string, analysisId: string) => Promise<{ ckg: CcmV1; ckgHash: string; semantic: SemanticModel } | null>;
  readBaseline: (ownerUserId: string, analysisId: string) => Promise<null | { id: string; modelHash: string; sourceCkgHash: string; model: unknown; revision: number; overlay: unknown }>;
  saveBaseline: (input: { ownerUserId: string; analysisId: string; model: ReturnType<typeof buildAddBaseline> }) => Promise<{ id: string; modelHash: string; created: boolean; model: unknown }>;
  saveRevision: (input: { ownerUserId: string; analysisId: string; expectedRevision: number; overlay: unknown }) => Promise<{ id: string; revision: number; overlay: unknown; contentHash: string }>;
};
type AuthorizationResult = { response: Response; session?: undefined } | { session: AnalysisSession; response?: undefined };

async function parseBoundedJson(request: Request, maxBytes: number): Promise<unknown | null> {
  if (!/^application\/json(?:\s*;|$)/iu.test(request.headers.get("content-type") ?? "")) return null;
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d+$/u.test(length) || Number(length) > maxBytes)) return null;
  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) { await reader.cancel(); return null; }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch { return null; }
  finally { reader.releaseLock(); }
}

async function parseBody(request: Request): Promise<{ allowLlm: boolean } | null> {
  const value = await parseBoundedJson(request, 1024);
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 1 || typeof record.allowLlm !== "boolean") return null;
  return { allowLlm: record.allowLlm };
}

async function parseReviewBody(request: Request): Promise<{ expectedRevision: number; overlay: unknown } | null> {
  const value = await parseBoundedJson(request, 256_000);
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 2 || !Number.isSafeInteger(record.expectedRevision) || Number(record.expectedRevision) < 0 || !record.overlay || typeof record.overlay !== "object" || Array.isArray(record.overlay)) return null;
  return { expectedRevision: Number(record.expectedRevision), overlay: record.overlay };
}

export function createAddHandlers(deps: AddHandlerDependencies) {
  async function authorize(request: Request, analysisId: string): Promise<AuthorizationResult> {
    if (!ID.test(analysisId)) return { response: failure("INVALID_INPUT", "ID analisis tidak valid.", 400) };
    const session = await deps.readSession(request);
    if (!session) return { response: failure("AUTH_REQUIRED", "Sesi berakhir. Masuk lagi dengan GitHub.", 401) };
    if (request.headers.has("x-sage-account") && request.headers.get("x-sage-account") !== session.githubUserId) return { response: failure("AUTH_REQUIRED", "Akun GitHub berubah. Muat ulang halaman.", 401) };
    return { session };
  }
  return {
    async get(request: Request, analysisId: string): Promise<Response> {
      if (request.method !== "GET" || new URL(request.url).search !== "") return failure("INVALID_INPUT", "Permintaan ADD tidak valid.", 400);
      try {
        const auth = await authorize(request, analysisId); if (auth.response) return auth.response;
        const baseline = await deps.readBaseline(auth.session.userId, analysisId);
        if (baseline) return json({ data: { ...baseline, analysisId, accountKey: auth.session.githubUserId } });
        const inputs = await deps.readInputs(auth.session.userId, analysisId);
        if (!inputs) return failure("ADD_NOT_READY", "Analisis belum memiliki hasil yang dapat digunakan untuk membuat ADD.", 409);
        return json({ data: { status: "not-generated", accountKey: auth.session.githubUserId } }, 409);
      } catch { return failure("ADD_UNAVAILABLE", "Baseline ADD sementara tidak dapat dibaca.", 503); }
    },
    async generate(request: Request, analysisId: string): Promise<Response> {
      if (request.method !== "POST" || new URL(request.url).search !== "") return failure("INVALID_INPUT", "Permintaan Generate ADD tidak valid.", 400);
      try {
        const auth = await authorize(request, analysisId); if (auth.response) return auth.response;
        const config = parseAuthBaseConfig(deps.env);
        if (!config) return failure("ADD_UNAVAILABLE", "Konfigurasi keamanan belum tersedia.", 503);
        if (!isSameOriginPost(request, config)) return failure("FORBIDDEN_ORIGIN", "Asal permintaan tidak diizinkan.", 403);
        const body = await parseBody(request);
        if (!body) return failure("INVALID_INPUT", "Permintaan Generate ADD tidak valid.", 400);
        const existing = await deps.readBaseline(auth.session.userId, analysisId);
        if (existing) return json({ data: { ...existing, analysisId, accountKey: auth.session.githubUserId, created: false } });
        const inputs = await deps.readInputs(auth.session.userId, analysisId);
        if (!inputs || inputs.semantic.sourceCkgHash !== inputs.ckgHash) return failure("ADD_NOT_READY", "Hasil analisis belum lengkap atau tidak cocok dengan source snapshot.", 409);
        let model = buildAddBaseline({ ccm: inputs.ckg, semantic: inputs.semantic, sourceCkgHash: inputs.ckgHash });
        if (body.allowLlm) {
          const result = await enrichAddNarrative({ model, env: deps.env, signal: request.signal });
          model = { ...result.model, generation: { ...result.model.generation, llmOutcome: result.outcome } };
        } else model = { ...model, generation: { ...model.generation, llmOutcome: "not-requested" } };
        const saved = await deps.saveBaseline({ ownerUserId: auth.session.userId, analysisId, model });
        if (!saved.created) {
          const current = await deps.readBaseline(auth.session.userId, analysisId);
          if (!current) return failure("ADD_UNAVAILABLE", "Baseline ADD sementara tidak dapat dibaca.", 503);
          return json({ data: { ...current, analysisId, accountKey: auth.session.githubUserId, created: false } });
        }
        return json({ data: { ...saved, analysisId, revision: 0, overlay: emptyAddReviewOverlay(), accountKey: auth.session.githubUserId, generated: true } }, saved.created ? 201 : 200);
      } catch { return failure("ADD_GENERATION_FAILED", "ADD tidak dapat dibuat sekarang. Analisis tersimpan dan bisa dicoba kembali.", 503); }
    },
    async updateReview(request: Request, analysisId: string): Promise<Response> {
      if (request.method !== "PATCH" || new URL(request.url).search !== "") return failure("INVALID_INPUT", "Permintaan review ADD tidak valid.", 400);
      const config = parseAuthBaseConfig(deps.env);
      if (!config) return failure("ADD_UNAVAILABLE", "Konfigurasi keamanan belum tersedia.", 503);
      if (!isSameOriginPost(request, config)) return failure("FORBIDDEN_ORIGIN", "Asal permintaan tidak diizinkan.", 403);
      try {
        const auth = await authorize(request, analysisId); if (auth.response) return auth.response;
        const body = await parseReviewBody(request);
        if (!body) return failure("INVALID_INPUT", "Permintaan review ADD tidak valid.", 400);
        const baseline = await deps.readBaseline(auth.session.userId, analysisId);
        if (!baseline) return failure("ADD_NOT_READY", "Generate ADD sebelum menyimpan review.", 409);
        const model = baseline.model as ReturnType<typeof buildAddBaseline>;
        const raw = body.overlay as Record<string, unknown>;
        const overlay = parseAddReviewOverlay(model, { ...raw, revision: body.expectedRevision + 1 }, body.expectedRevision + 1);
        const saved = await deps.saveRevision({ ownerUserId: auth.session.userId, analysisId, expectedRevision: body.expectedRevision, overlay });
        return json({ data: { ...saved, analysisId, accountKey: auth.session.githubUserId } }, 201);
      } catch (cause) {
        if (cause instanceof Error && cause.name === "AddBaselineConflictError") return failure("ADD_REVISION_CONFLICT", "Review ADD berubah di sesi lain. Muat ulang sebelum menyimpan lagi.", 409);
        if (cause instanceof Error && cause.message === "ADD_REVIEW_INVALID") return failure("INVALID_INPUT", "Koreksi ADD tidak valid atau merujuk elemen di luar source snapshot.", 422);
        return failure("ADD_REVIEW_FAILED", "Review ADD belum dapat disimpan. Coba lagi.", 503);
      }
    },
  };
}
