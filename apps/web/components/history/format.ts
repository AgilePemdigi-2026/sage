export type AnalysisStatusView = "QUEUED" | "RUNNING" | "COMPLETED" | "COMPLETED_WITH_LIMITATIONS" | "FAILED";
export type StatusTone = "info" | "success" | "warning" | "error";

const LABELS: Record<AnalysisStatusView, string> = {
  QUEUED: "Menunggu",
  RUNNING: "Berjalan",
  COMPLETED: "Selesai",
  COMPLETED_WITH_LIMITATIONS: "Selesai dengan batasan",
  FAILED: "Gagal",
};
const TONES: Record<AnalysisStatusView, StatusTone> = {
  QUEUED: "info", RUNNING: "info", COMPLETED: "success",
  COMPLETED_WITH_LIMITATIONS: "warning", FAILED: "error",
};

export function statusLabel(status: string): string | null {
  return (LABELS as Record<string, string>)[status] ?? null;
}
export function statusTone(status: string): StatusTone | null {
  return (TONES as Record<string, StatusTone>)[status] ?? null;
}

const formatter = new Intl.DateTimeFormat("id-ID", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Jakarta" });
export function formatDateTime(value: string | Date | null | undefined): string {
  if (!value) return "—";
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : formatter.format(date);
}

/** Label + tone badge status yang sama untuk Riwayat dan Progres (QUEUED tampil "Antre", netral). */
export function analysisStatusBadge(status: string): { label: string; tone: StatusTone | "neutral" } {
  if (status === "QUEUED") return { label: "Antre", tone: "neutral" };
  return { label: statusLabel(status) ?? status, tone: statusTone(status) ?? "neutral" };
}
