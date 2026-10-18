/** Stable pipeline order shared by the worker, persistence layer, and clients. */
export const ANALYSIS_STAGE_DEFINITIONS = [
  { sequence: 1, key: "SNAPSHOT", label: "Mengambil snapshot repository" },
  { sequence: 2, key: "LANGUAGE_DETECTION", label: "Mendeteksi bahasa dan struktur proyek" },
  { sequence: 3, key: "STATIC_ANALYSIS", label: "Menjalankan analisis statis" },
  { sequence: 4, key: "COMMON_CODE_MODEL", label: "Membentuk Common Code Model" },
  { sequence: 5, key: "KNOWLEDGE_GRAPH", label: "Membangun Code Knowledge Graph" },
  { sequence: 6, key: "INTERFACE_CATALOG", label: "Menghasilkan Interface Catalog" },
  { sequence: 7, key: "SOFTWARE_ENGINEERING_DIAGRAM", label: "Menghasilkan Software Engineering Diagram" },
  { sequence: 8, key: "UML_CLASS_DIAGRAM", label: "Menghasilkan UML Class Diagram" },
  { sequence: 9, key: "ARCHITECTURE_DOCUMENT", label: "Menyusun Architecture Definition Document" },
] as const;

export const ANALYSIS_STAGE_KEYS = ANALYSIS_STAGE_DEFINITIONS.map(({ key }) => key);
export type AnalysisStageKey = (typeof ANALYSIS_STAGE_DEFINITIONS)[number]["key"];
export const ANALYSIS_STAGE_STATUSES = ["PENDING", "RUNNING", "COMPLETED", "FAILED"] as const;
export type AnalysisStageStatus = (typeof ANALYSIS_STAGE_STATUSES)[number];

export interface AnalysisStageProgress {
  readonly sequence: number;
  readonly key: AnalysisStageKey;
  readonly status: AnalysisStageStatus;
  readonly startedAt: Date | null;
  readonly finishedAt: Date | null;
  readonly errorCode: string | null;
}

/** This reports stage execution only; it does not publish a completed analysis result. */
export interface AnalysisStagesResult {
  readonly stagesFinished: boolean;
  readonly stages: readonly AnalysisStageProgress[];
}
