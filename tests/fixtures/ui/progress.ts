import type { AnalysisProgress, AnalysisStatus, Repository } from "../../../apps/web/components/ui-foundation/types";
export const repositories: readonly Repository[] = [
  { fullName: "contoh/arsitektur-aplikasi", description: "Contoh struktur aplikasi untuk menjelajahi alur antarmuka.", visibility: "public", language: "TypeScript" },
  { fullName: "contoh/layanan-php", description: "Contoh repository private dengan akses yang disimulasikan.", visibility: "private", language: "PHP" },
  { fullName: "contoh/katalog-interface", description: "Contoh module JavaScript dan dokumentasi antarmuka.", visibility: "public", language: "JavaScript" },
];
export const stageDefinitions = [
  ["SNAPSHOT", "Mengambil snapshot repository"],
  ["LANGUAGE_DETECTION", "Mendeteksi bahasa dan struktur proyek"],
  ["STATIC_ANALYSIS", "Menjalankan analisis statis"],
  ["COMMON_CODE_MODEL", "Membentuk Common Code Model"],
  ["KNOWLEDGE_GRAPH", "Membangun Code Knowledge Graph"],
  ["INTERFACE_CATALOG", "Menghasilkan Interface Catalog"],
  ["SOFTWARE_ENGINEERING_DIAGRAM", "Menghasilkan Software Engineering Diagram"],
  ["UML_CLASS_DIAGRAM", "Menghasilkan UML Class Diagram"],
  ["ARCHITECTURE_DOCUMENT", "Menyusun Architecture Definition Document"],
] as const;
export function progressFixture(status: AnalysisStatus, retry = false): AnalysisProgress {
  const complete = status === "COMPLETED" || status === "COMPLETED_WITH_LIMITATIONS";
  return {
    analysisId: retry ? "fixture-analysis-retry" : "fixture-analysis-001",
    repository: repositories[0].fullName, branch: "main", fullSha: "a1b2c3d4e5f678901234567890abcdef12345678", status,
    stages: stageDefinitions.map(([key, label], index) => ({ key, label, status: complete || status !== "QUEUED" && index < 2 ? "COMPLETED" : index === 2 && status === "RUNNING" ? "RUNNING" : index === 2 && status === "FAILED" ? "FAILED" : "PENDING" })),
    limitations: status === "COMPLETED_WITH_LIMITATIONS" ? ["Contoh: pemanggilan dinamis tetap Unresolved; antarmuka tidak menebak target relasinya."] : [],
    ...(status === "FAILED" ? { error: "Contoh kegagalan: source tidak berhasil diproses pada tahap analisis statis." } : {}),
  };
}
