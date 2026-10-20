import { randomUUID } from "node:crypto";
import { HistoryQueryError } from "@sage/database";
import type { AnalysisDetailRecord, HistoryListResult } from "@sage/database";
import { presentAnalysisDetail, presentHistoryList } from "./presenters.ts";

/** Re-export presenter agar test & route bisa memakai satu titik impor dari handlers. */
export { presentAnalysisDetail, presentHistoryList } from "./presenters.ts";

export const ANALYSIS_STATUSES = ["QUEUED", "RUNNING", "COMPLETED", "COMPLETED_WITH_LIMITATIONS", "FAILED"] as const;
export type AnalysisSession = { userId: string; githubUserId: string };
export type HistoryHandlerDependencies = {
  readSession: (request: Request) => Promise<AnalysisSession | null>;
  list: (userId: string, options: { query?: string; status?: string; cursor?: string }) => Promise<HistoryListResult>;
  detail: (userId: string, analysisId: string) => Promise<AnalysisDetailRecord | null>;
};

function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "private, no-store", Vary: "Cookie", "X-Content-Type-Options": "nosniff" } });
}
function failure(code: string, message: string, status: number) {
  return json({ error: { code, message, details: {} }, requestId: randomUUID() }, status);
}

function listParams(request: Request): { query?: string; status?: string; cursor?: string } | null {
  const params = new URL(request.url).searchParams;
  const allowed = ["query", "status", "cursor"];
  if (allowed.some(key => params.getAll(key).length > 1) || [...params.keys()].some(key => !allowed.includes(key))) return null;
  const query = params.get("query") ?? undefined;
  const status = params.get("status") ?? undefined;
  const cursor = params.get("cursor") ?? undefined;
  if (query !== undefined && (query.length === 0 || query.length > 200)) return null;
  if (status !== undefined && !(ANALYSIS_STATUSES as readonly string[]).includes(status)) return null;
  if (cursor !== undefined && (cursor.length === 0 || cursor.length > 512 || !/^[A-Za-z0-9_-]+$/.test(cursor))) return null;
  return { query, status, cursor };
}

const ANALYSIS_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

export function createHistoryHandlers(deps: HistoryHandlerDependencies) {
  return {
    async list(request: Request) {
      const session = await deps.readSession(request);
      if (!session) return failure("AUTH_REQUIRED", "Sesi berakhir. Masuk lagi dengan GitHub.", 401);
      const params = listParams(request);
      if (!params) return failure("INVALID_INPUT", "Parameter pencarian tidak valid.", 400);
      try {
        return json({ data: presentHistoryList(await deps.list(session.userId, params)) });
      } catch (error) {
        if (error instanceof HistoryQueryError) return failure("INVALID_INPUT", error.message, 400);
        return failure("HISTORY_UNAVAILABLE", "Riwayat belum dapat dibaca. Coba lagi.", 503);
      }
    },
    async detail(request: Request, analysisId: string) {
      if (typeof analysisId !== "string" || !ANALYSIS_ID_PATTERN.test(analysisId)) {
        return failure("INVALID_INPUT", "ID analisis tidak valid.", 400);
      }
      const session = await deps.readSession(request);
      if (!session) return failure("AUTH_REQUIRED", "Sesi berakhir. Masuk lagi dengan GitHub.", 401);
      try {
        const detail = await deps.detail(session.userId, analysisId);
        if (!detail) return failure("ANALYSIS_NOT_FOUND", "Analisis tidak ditemukan.", 404);
        return json({ data: presentAnalysisDetail(detail) });
      } catch {
        return failure("HISTORY_UNAVAILABLE", "Analisis belum dapat dibaca. Coba lagi.", 503);
      }
    },
  };
}
