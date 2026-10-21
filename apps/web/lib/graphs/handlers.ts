import { randomUUID } from "node:crypto";
import type { AnalysisSession } from "../analyses/handlers.ts";
import type { GraphReadState } from "./types.ts";

export type GraphHandlerDependencies = {
  readSession: (request: Request) => Promise<AnalysisSession | null>;
  readGraph: (ownerUserId: string, analysisId: string) => Promise<GraphReadState>;
};

const ANALYSIS_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

function json(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "private, no-store",
      Vary: "Cookie, X-SAGE-Account",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function failure(code: string, message: string, status: number) {
  return json({ error: { code, message, details: {} }, requestId: randomUUID() }, status);
}

function hasNoQueryParams(request: Request): boolean {
  return [...new URL(request.url).searchParams.keys()].length === 0;
}

export function createGraphHandlers(deps: GraphHandlerDependencies) {
  return {
    async get(request: Request, analysisId: string) {
      if (typeof analysisId !== "string" || !ANALYSIS_ID_PATTERN.test(analysisId) || !hasNoQueryParams(request)) {
        return failure("INVALID_INPUT", "Permintaan graph tidak valid.", 400);
      }

      try {
        const session = await deps.readSession(request);
        if (!session) return failure("AUTH_REQUIRED", "Sesi berakhir. Masuk lagi dengan GitHub.", 401);
        if (request.headers.has("x-sage-account") && request.headers.get("x-sage-account") !== session.githubUserId) {
          return failure("AUTH_REQUIRED", "Akun GitHub berubah. Muat ulang halaman.", 401);
        }

        const state = await deps.readGraph(session.userId, analysisId);
        if (state.kind === "not-found") return failure("ANALYSIS_NOT_FOUND", "Analisis tidak ditemukan.", 404);
        if (state.kind === "not-ready") return failure("RESULT_NOT_READY", "Graph belum tersedia untuk analisis ini.", 409);
        return json({ data: { ...state.value, accountKey: session.githubUserId } });
      } catch {
        return failure("GRAPH_UNAVAILABLE", "Graph belum dapat dibaca. Coba lagi.", 503);
      }
    },
  };
}
