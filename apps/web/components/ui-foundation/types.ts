export type Screen = "login" | "repository" | "progress";
export type LoadState<T> =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "empty" }
  | { status: "error"; message: string }
  | { status: "ready"; data: T };
export type LoginState = "idle" | "loading" | "denied" | "error" | "connected";
export interface Repository {
  fullName: string;
  description: string;
  visibility: "public" | "private" | "unverified";
  language: string;
}
export interface AnalysisTarget {
  repository: string;
  branch: string;
  commit: string | null;
}
export type AnalysisStatus = "QUEUED" | "RUNNING" | "COMPLETED" | "COMPLETED_WITH_LIMITATIONS" | "FAILED";
export type StageStatus = "PENDING" | "RUNNING" | "COMPLETED" | "FAILED";
export interface AnalysisStage { key: string; label: string; status: StageStatus }
export interface AnalysisProgress {
  analysisId: string;
  repository: string;
  branch: string;
  fullSha: string;
  status: AnalysisStatus;
  stages: readonly AnalysisStage[];
  limitations: readonly string[];
  error?: string;
}
