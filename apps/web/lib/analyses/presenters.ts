import { ANALYSIS_STAGE_DEFINITIONS } from "@sage/contracts";
import type { AnalysisDetailRecord, HistoryListResult } from "@sage/database";

const stageLabels = new Map(ANALYSIS_STAGE_DEFINITIONS.map(stage => [stage.key, stage.label] as const));
const stageKeys = ANALYSIS_STAGE_DEFINITIONS.map(stage => stage.key);

export function presentHistoryList(result: HistoryListResult) {
  return {
    analyses: result.items.map(item => ({
      id: item.id,
      repository: { fullName: item.repositoryFullName },
      branch: item.branchName,
      commitSha: item.commitSha,
      status: item.status,
      errorCode: item.errorCode,
      queuedAt: item.queuedAt.toISOString(),
      startedAt: item.startedAt ? item.startedAt.toISOString() : null,
      completedAt: item.completedAt ? item.completedAt.toISOString() : null,
      retryOfAnalysisId: item.retryOfAnalysisId,
    })),
    nextCursor: result.nextCursor,
  };
}

export function presentAnalysisDetail(detail: AnalysisDetailRecord) {
  const stored = new Map(detail.stages.map(stage => [stage.key, stage] as const));
  return {
    stateVersion: detail.stateVersion,
    updatedAt: detail.updatedAt.toISOString(),
    context: {
      repositoryFullName: detail.repositoryFullName,
      branchName: detail.branchName,
      commitSha: detail.commitSha,
    },
    status: detail.status,
    errorCode: detail.errorCode,
    retryOfAnalysisId: detail.retryOfAnalysisId,
    timestamps: {
      queuedAt: detail.queuedAt.toISOString(),
      startedAt: detail.startedAt ? detail.startedAt.toISOString() : null,
      completedAt: detail.completedAt ? detail.completedAt.toISOString() : null,
    },
    stages: stageKeys.map((key, index) => {
      const found = stored.get(key);
      return {
        sequence: index + 1,
        key,
        label: stageLabels.get(key) ?? key,
        status: found?.status ?? "PENDING",
        errorCode: found?.errorCode ?? null,
        startedAt: found?.startedAt ? found.startedAt.toISOString() : null,
        finishedAt: found?.finishedAt ? found.finishedAt.toISOString() : null,
      };
    }),
    limitations: detail.limitations.map(limitation => ({
      stageKey: limitation.stageKey, code: limitation.code, safeExplanation: limitation.safeExplanation,
    })),
    results: detail.results,
  };
}

/** Bentuk payload yang dikirim ke klien detail; dipakai tipe DetailView pada components/history/detail-client.tsx. */
export type AnalysisDetailView = ReturnType<typeof presentAnalysisDetail>;
