import type { Prisma, PrismaClient } from "../generated/client.ts";
import type { AnalysisStatus } from "../generated/enums.ts";
import type { CleanupSnapshot } from "./cleanup.ts";

export class HistoryQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HistoryQueryError";
  }
}

export const HISTORY_STATUS_FILTERS = ["QUEUED", "RUNNING", "COMPLETED", "COMPLETED_WITH_LIMITATIONS", "FAILED"] as const;
export type HistoryStatusFilter = (typeof HISTORY_STATUS_FILTERS)[number];

const PAGE_SIZE = 20;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

// PENTING: urutan kunci ini harus identik dengan tabel sembilan tahap di docs/ARCHITECTURE.md
// dan ANALYSIS_STAGE_DEFINITIONS pada packages/contracts/src/stages.ts.
const STAGE_KEYS_BY_SEQUENCE = [
  "SNAPSHOT", "LANGUAGE_DETECTION", "STATIC_ANALYSIS", "COMMON_CODE_MODEL", "KNOWLEDGE_GRAPH",
  "INTERFACE_CATALOG", "SOFTWARE_ENGINEERING_DIAGRAM", "UML_CLASS_DIAGRAM", "ARCHITECTURE_DOCUMENT",
] as const;
function stageKeyBySequence(sequence: number): string {
  return STAGE_KEYS_BY_SEQUENCE[sequence - 1] ?? `STAGE_${sequence}`;
}

function requireOwner(userId: string): void {
  if (typeof userId !== "string" || userId.trim().length === 0) throw new HistoryQueryError("Pemilik data tidak valid.");
}

export function encodeHistoryCursor(cursor: { createdAt: Date; id: string }): string {
  if (!(cursor.createdAt instanceof Date) || Number.isNaN(cursor.createdAt.getTime()) || cursor.createdAt.getTime() === 0
    || typeof cursor.id !== "string" || !ID_PATTERN.test(cursor.id)) {
    throw new HistoryQueryError("Cursor tidak valid.");
  }
  return Buffer.from(JSON.stringify({ c: cursor.createdAt.toISOString(), i: cursor.id }), "utf8").toString("base64url");
}

export function parseHistoryCursor(value: string): { createdAt: Date; id: string } | null {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as { c?: unknown; i?: unknown };
    if (typeof parsed.c !== "string" || typeof parsed.i !== "string" || !ID_PATTERN.test(parsed.i)) return null;
    const createdAt = new Date(parsed.c);
    if (Number.isNaN(createdAt.getTime()) || createdAt.getTime() === 0) return null;
    return { createdAt, id: parsed.i };
  } catch {
    return null;
  }
}

export interface HistoryListItem {
  id: string; repositoryFullName: string; branchName: string; commitSha: string;
  status: string; errorCode: string | null; queuedAt: Date; startedAt: Date | null;
  completedAt: Date | null; retryOfAnalysisId: string | null;
  deletion?: CleanupSnapshot | null;
}
export interface HistoryListResult {
  items: HistoryListItem[];
  nextCursor: string | null;
  pageSize: number;
}
export type HistoryListOptions = { query?: string | undefined; status?: string | undefined; cursor?: string | undefined };

export async function listAnalysesForUser(db: PrismaClient, userId: string, options: HistoryListOptions = {}): Promise<HistoryListResult> {
  requireOwner(userId);
  const where: Prisma.AnalysisWhereInput = { ownerUserId: userId };
  if (options.status !== undefined) {
    if (typeof options.status !== "string" || !(HISTORY_STATUS_FILTERS as readonly string[]).includes(options.status)) {
      throw new HistoryQueryError("Status filter tidak valid.");
    }
    where.status = options.status as AnalysisStatus;
  }
  if (options.query !== undefined && options.query.trim().length > 200) throw new HistoryQueryError("Query pencarian terlalu panjang.");
  const query = typeof options.query === "string" ? options.query.trim() : "";
  if (query) {
    where.OR = [
      { repository: { is: { fullName: { contains: query, mode: "insensitive" } } } },
      { branchName: { contains: query, mode: "insensitive" } },
      { commitSha: { contains: query, mode: "insensitive" } },
    ];
  }
  if (options.cursor !== undefined) {
    const cursor = parseHistoryCursor(options.cursor);
    if (!cursor) throw new HistoryQueryError("Cursor tidak valid.");
    where.AND = [{
      OR: [
        { createdAt: { lt: cursor.createdAt } },
        { createdAt: { equals: cursor.createdAt }, id: { lt: cursor.id } },
      ],
    }];
  }
  const rows = await db.analysis.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: PAGE_SIZE + 1,
    select: {
      id: true, branchName: true, commitSha: true, status: true, errorCode: true,
      queuedAt: true, startedAt: true, completedAt: true, retryParentId: true, createdAt: true,
      deletionRequestedAt: true,
      repository: { select: { fullName: true } },
    },
  });
  const hasMore = rows.length > PAGE_SIZE;
  const page = hasMore ? rows.slice(0, PAGE_SIZE) : rows;
  const cleanupJobs = page.length === 0 ? [] : await db.job.findMany({
    where: { ownerUserId: userId, type: "CLEANUP", cleanupAnalysisId: { in: page.map(row => row.id) } },
    select: { id: true, analysisId: true, cleanupAnalysisId: true, status: true, errorCode: true },
  });
  const cleanupByAnalysis = new Map(cleanupJobs.map(job => [job.cleanupAnalysisId, {
    jobId: job.id,
    analysisId: job.analysisId ?? job.cleanupAnalysisId!,
    status: job.status,
    errorCode: job.errorCode,
  }] as const));
  const items = page.map(pageRow => ({
    id: pageRow.id,
    repositoryFullName: pageRow.repository.fullName,
    branchName: pageRow.branchName,
    commitSha: pageRow.commitSha,
    status: pageRow.status,
    errorCode: pageRow.errorCode,
    queuedAt: pageRow.queuedAt,
    startedAt: pageRow.startedAt,
    completedAt: pageRow.completedAt,
    retryOfAnalysisId: pageRow.retryParentId ?? null,
    ...(pageRow.deletionRequestedAt ? { deletion: cleanupByAnalysis.get(pageRow.id) ?? null } : {}),
  }));
  const last = page.at(-1);
  return {
    items, pageSize: PAGE_SIZE,
    nextCursor: hasMore && last ? encodeHistoryCursor({ createdAt: last.createdAt, id: last.id }) : null,
  };
}

export interface AnalysisStageRecord {
  sequence: number; key: string; status: string; errorCode: string | null;
  startedAt: Date | null; finishedAt: Date | null;
}
export interface AnalysisDetailRecord {
  id: string; repositoryFullName: string; branchName: string; commitSha: string;
  status: string; errorCode: string | null; retryOfAnalysisId: string | null;
  queuedAt: Date; startedAt: Date | null; completedAt: Date | null; updatedAt: Date;
  stateVersion: number;
  stages: AnalysisStageRecord[];
  limitations: { stageKey: string; code: string; safeExplanation: string }[];
  results: { graphUrl: string; documentUrl: string } | null;
}

const TERMINAL_SUCCESS = ["COMPLETED", "COMPLETED_WITH_LIMITATIONS"] as const;

export async function getAnalysisDetailForUser(db: PrismaClient, userId: string, analysisId: string): Promise<AnalysisDetailRecord | null> {
  requireOwner(userId);
  if (typeof analysisId !== "string" || analysisId.trim().length === 0) throw new HistoryQueryError("ID analisis tidak valid.");
  const row = await db.analysis.findFirst({
    where: { id: analysisId, ownerUserId: userId, deletionRequestedAt: null },
    select: {
      id: true, branchName: true, commitSha: true, status: true, errorCode: true, retryParentId: true,
      queuedAt: true, startedAt: true, completedAt: true, updatedAt: true,
      repository: { select: { fullName: true } },
      stages: { orderBy: { sequence: "asc" }, select: { sequence: true, key: true, status: true, errorCode: true, startedAt: true, finishedAt: true } },
      limitations: { orderBy: { createdAt: "desc" }, select: { stageKey: true, code: true, safeExplanation: true } },
    },
  });
  if (!row) return null;
  const stored = new Map(row.stages.map(stage => [stage.key, stage] as const));
  const stages: AnalysisStageRecord[] = Array.from({ length: 9 }, (_, index) => {
    const found = stored.get(stageKeyBySequence(index + 1));
    return found ?? { sequence: index + 1, key: stageKeyBySequence(index + 1), status: "PENDING", errorCode: null, startedAt: null, finishedAt: null };
  });
  const terminalSuccess = (TERMINAL_SUCCESS as readonly string[]).includes(row.status);
  return {
    id: row.id, repositoryFullName: row.repository.fullName, branchName: row.branchName, commitSha: row.commitSha,
    status: row.status, errorCode: row.errorCode, retryOfAnalysisId: row.retryParentId ?? null,
    queuedAt: row.queuedAt, startedAt: row.startedAt, completedAt: row.completedAt, updatedAt: row.updatedAt,
    stateVersion: row.updatedAt.getTime(), stages, limitations: row.limitations,
    results: terminalSuccess ? { graphUrl: `/analyses/${row.id}/graph`, documentUrl: `/analyses/${row.id}/document` } : null,
  };
}
