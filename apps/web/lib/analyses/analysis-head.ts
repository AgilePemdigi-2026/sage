import { getAnalysisDetailForUser, type database } from "@sage/database";
import { presentAnalysisDetail } from "./presenters.ts";

/** Data page head analisis (Progres / TOGAF ADD / Code Knowledge), owner-scoped lewat presenter detail yang sama. */
export type AnalysisHeadData = {
  repositoryFullName: string;
  branchName: string;
  commitSha: string;
  status: string;
  limitationsCount: number;
  resultsAvailable: boolean;
};

export function analysisHeadFromView(view: ReturnType<typeof presentAnalysisDetail>): AnalysisHeadData {
  return {
    repositoryFullName: view.context.repositoryFullName,
    branchName: view.context.branchName,
    commitSha: view.context.commitSha,
    status: view.status,
    limitationsCount: view.limitations.length,
    resultsAvailable: Boolean(view.results),
  };
}

export async function readAnalysisHead(db: ReturnType<typeof database>, userId: string, analysisId: string): Promise<AnalysisHeadData | null> {
  const detail = await getAnalysisDetailForUser(db, userId, analysisId);
  return detail ? analysisHeadFromView(presentAnalysisDetail(detail)) : null;
}
