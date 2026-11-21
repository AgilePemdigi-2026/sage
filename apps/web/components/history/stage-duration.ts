/** Durasi tahap untuk tampilan progres. Hanya memakai startedAt/finishedAt dari presenter; tanpa data → null ("—"). */
export type StageTiming = { status: string; startedAt: string | null; finishedAt: string | null };

export function stageDurationSeconds(stage: StageTiming, nowMs: number): number | null {
  const start = stage.startedAt ? Date.parse(stage.startedAt) : Number.NaN;
  if (!Number.isFinite(start)) return null;
  const finished = stage.finishedAt ? Date.parse(stage.finishedAt) : Number.NaN;
  if (Number.isFinite(finished)) return Math.max(0, Math.floor((finished - start) / 1000));
  if (stage.status !== "RUNNING" || !Number.isFinite(nowMs) || nowMs <= 0) return null;
  return Math.max(0, Math.floor((nowMs - start) / 1000));
}

/** "12 dtk", "1 mnt 4 dtk", "2 mnt", "1 j 5 mnt"; null → "—". */
export function formatStageDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return "—";
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  if (hours > 0) return minutes > 0 ? `${hours} j ${minutes} mnt` : `${hours} j`;
  if (minutes > 0) return rest > 0 ? `${minutes} mnt ${rest} dtk` : `${minutes} mnt`;
  return `${rest} dtk`;
}
