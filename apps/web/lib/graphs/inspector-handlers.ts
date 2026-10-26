import { randomUUID } from "node:crypto";
import type { AnalysisSession } from "../analyses/handlers.ts";
import type { NodeInspectorReadState, SourceReadState } from "./inspector-types.ts";
import { SOURCE_PREVIEW_MAX_LINES } from "./inspector-types.ts";

export type InspectorHandlerDependencies = {
  readSession: (request: Request) => Promise<AnalysisSession | null>;
  readNode: (ownerUserId: string, analysisId: string, nodeId: string) => Promise<NodeInspectorReadState>;
  readSource: (
    ownerUserId: string,
    analysisId: string,
    fileId: string,
    startLine: number,
    endLine: number,
  ) => Promise<SourceReadState>;
};

const ANALYSIS_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
const NODE_ID_PATTERN = /^node_[a-f0-9]{64}$/;
const FILE_ID_PATTERN = /^file-[a-f0-9]{64}$/;

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

function parseLineRange(request: Request): { startLine: number; endLine: number } | null {
  const params = new URL(request.url).searchParams;
  const keys = [...params.keys()];
  if (keys.length !== 2 || keys.some(key => key !== "startLine" && key !== "endLine") ||
      params.getAll("startLine").length !== 1 || params.getAll("endLine").length !== 1) return null;

  const rawStart = params.get("startLine");
  const rawEnd = params.get("endLine");
  if (rawStart === null || rawEnd === null || !/^[1-9][0-9]*$/.test(rawStart) || !/^[1-9][0-9]*$/.test(rawEnd)) return null;
  const startLine = Number(rawStart);
  const endLine = Number(rawEnd);
  if (!Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine) || endLine < startLine ||
      endLine - startLine + 1 > SOURCE_PREVIEW_MAX_LINES) return null;
  return { startLine, endLine };
}

async function readAuthorizedSession(request: Request, readSession: InspectorHandlerDependencies["readSession"]) {
  const session = await readSession(request);
  if (!session) return { failure: failure("AUTH_REQUIRED", "Sesi berakhir. Masuk lagi dengan GitHub.", 401) };
  if (request.headers.has("x-sage-account") && request.headers.get("x-sage-account") !== session.githubUserId) {
    return { failure: failure("AUTH_REQUIRED", "Akun GitHub berubah. Muat ulang halaman.", 401) };
  }
  return { session };
}

function mapState(state: NodeInspectorReadState | SourceReadState, item: "node" | "file") {
  if (state.kind === "not-found") return failure("ANALYSIS_NOT_FOUND", "Analisis tidak ditemukan.", 404);
  if (state.kind === "not-ready") return failure("RESULT_NOT_READY", "Graph belum tersedia untuk analisis ini.", 409);
  if (state.kind === "item-not-found") {
    return item === "node"
      ? failure("NODE_NOT_FOUND", "Node tidak ditemukan.", 404)
      : failure("FILE_NOT_FOUND", "File sumber tidak ditemukan.", 404);
  }
  if (state.kind === "range-invalid") return failure("INVALID_INPUT", "Rentang baris sumber tidak valid.", 400);
  if (state.kind === "range-too-large") return failure("SOURCE_RANGE_TOO_LARGE", "Rentang sumber terlalu besar untuk ditampilkan.", 413);
  return null;
}

/** HTTP boundary for private, read-only node details and bounded source previews. */
export function createInspectorHandlers(deps: InspectorHandlerDependencies) {
  return {
    async getNode(request: Request, analysisId: string, nodeId: string) {
      if (!ANALYSIS_ID_PATTERN.test(analysisId) || !NODE_ID_PATTERN.test(nodeId) || !hasNoQueryParams(request)) {
        return failure("INVALID_INPUT", "Permintaan detail node tidak valid.", 400);
      }

      try {
        const auth = await readAuthorizedSession(request, deps.readSession);
        if (!auth.session) return auth.failure;

        const state = await deps.readNode(auth.session.userId, analysisId, nodeId);
        const mapped = mapState(state, "node");
        if (mapped) return mapped;
        if (state.kind !== "ready") return failure("NODE_INSPECTOR_UNAVAILABLE", "Detail node belum dapat dibaca. Coba lagi.", 503);
        return json({ data: { ...state.value, accountKey: auth.session.githubUserId } });
      } catch {
        return failure("NODE_INSPECTOR_UNAVAILABLE", "Detail node belum dapat dibaca. Coba lagi.", 503);
      }
    },

    async getSource(request: Request, analysisId: string, fileId: string) {
      const range = parseLineRange(request);
      if (!ANALYSIS_ID_PATTERN.test(analysisId) || !FILE_ID_PATTERN.test(fileId) || !range) {
        return failure("INVALID_INPUT", "Permintaan sumber tidak valid.", 400);
      }

      try {
        const auth = await readAuthorizedSession(request, deps.readSession);
        if (!auth.session) return auth.failure;

        const state = await deps.readSource(
          auth.session.userId,
          analysisId,
          fileId,
          range.startLine,
          range.endLine,
        );
        const mapped = mapState(state, "file");
        if (mapped) return mapped;
        if (state.kind !== "ready") return failure("SOURCE_UNAVAILABLE", "Sumber sementara tidak dapat dibaca. Coba lagi.", 503);
        return json({ data: { ...state.value, accountKey: auth.session.githubUserId } });
      } catch {
        return failure("SOURCE_UNAVAILABLE", "Sumber sementara tidak dapat dibaca. Coba lagi.", 503);
      }
    },
  };
}
