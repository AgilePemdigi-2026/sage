/** Logika polling halaman detail, terpisah dari render AnalysisDetailClient supaya bisa diuji
 * sebagai harness murni (tanpa React/CSS/next): interval diinjeksi, fetch diinjeksi, dan
 * penerapan snapshot dipagari nomor permintaan (sequence) yang monoton supaya respons usang
 * gagal mengembalikan tahap COMPLETED ke PENDING/RUNNING. */
import type { AnalysisDetailView } from "../../lib/analyses/presenters.ts";

const POLLING_STATUSES = ["QUEUED", "RUNNING"] as const;
export function shouldPollAnalysisDetail(status: string): boolean {
  return (POLLING_STATUSES as readonly string[]).includes(status);
}

/** Seconds since the job was queued. Terminal states use the persisted finish time,
 * so the value remains stable after polling stops. When a legacy terminal record has
 * no finish time, the caller supplies the instant the terminal state was observed. */
export function elapsedAnalysisSeconds(
  timestamps: { queuedAt: string; completedAt: string | null },
  status: string,
  nowMs: number,
): number | null {
  const start = Date.parse(timestamps.queuedAt);
  if (!Number.isFinite(start)) return null;
  const completed = isTerminalAnalysisStatus(status) && timestamps.completedAt
    ? Date.parse(timestamps.completedAt)
    : Number.NaN;
  const end = Number.isFinite(completed) ? completed : nowMs;
  if (!Number.isFinite(end)) return null;
  return Math.max(0, Math.floor((end - start) / 1000));
}

function isTerminalAnalysisStatus(status: string): boolean {
  return !shouldPollAnalysisDetail(status);
}

export function formatElapsedDuration(totalSeconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const seconds = safeSeconds % 60;
  return [hours, minutes, seconds].map(value => String(value).padStart(2, "0")).join(":");
}

/** Profil fetch yang dipakai klien detail: cukup `ok` + `json()` agar test bisa memalsukan respons. */
export type DetailFetch = (input: string, init: RequestInit) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;

export type DetailPollerOptions = {
  analysisId: string;
  accountKey: string;
  fetch: DetailFetch;
  intervalMs: number;
  /** Pasangan timer diinjeksi agar test mengendalikan kapan tick berjalan. */
  scheduleInterval: (callback: () => void, ms: number) => number;
  cancelInterval: (handle: number) => void;
  /** Menahan nomor permintaan berikutnya dari sumber monoton milik pemilik state. */
  touchSequence: () => number;
  isLatestSequence: (sequence: number) => boolean;
  setFetchError: (value: boolean) => void;
  setDetail: (updater: (previous: AnalysisDetailView | null) => AnalysisDetailView | null) => void;
  /** Re-check the cookie identity after reading each response body before publishing detail data. */
  verifySession?: () => Promise<boolean>;
  onAccountMismatch?: () => void;
};

export function createDetailPoller(options: DetailPollerOptions) {
  let handle: number | null = null;
  /** Instance hidup mulai start() sampai stop(). Effect pemilik melingkar (halaman berubah tiap
   * snapshot diterapkan) berhenti dan membuat instance baru; respons fetch yang masih di jalan
   * dari instance tua tidak boleh menyentuh state lagi. lastAppliedSequence milik instance ini
   * saja sehingga token lifecycle jadi pengaman lintas instance. */
  let alive = false;
  /** Sequence dari respons terakhir yang benar-benar diterapkan. Snapshot hanya ditolak
   * bila respons yang lebih baru sudah diterapkan — interval terus menerbitkan permintaan
   * meski respons lebih lambat, sehingga membandingkan dengan permintaan terbaru saja
   * membuat UI macet saat semua respons melebihi interval. */
  let lastAppliedSequence = 0;
  async function tick(): Promise<void> {
    const sequence = options.touchSequence();
    try {
      const response = await options.fetch(`/api/analyses/${options.analysisId}`, {
        headers: { "X-SAGE-Account": options.accountKey }, cache: "no-store", credentials: "same-origin",
      });
      let body: unknown = null;
      let bodyRead = true;
      try { body = await response.json(); } catch { bodyRead = false; }
      // Guard lifecycle dulu: instance yang sudah di stop tidak mengubah state apa pun,
      // sekalipun lastAppliedSequence miliknya masih memungkinkan snapshot diterima.
      if (!alive) return;
      if (options.verifySession && !(await options.verifySession())) {
        if (alive) options.onAccountMismatch?.();
        return;
      }
      if (!alive) return;
      const data = response.ok && bodyRead && body && typeof body === "object" && !Array.isArray(body)
        ? (body as { data?: AnalysisDetailView }).data ?? null
        : null;
      if (!response.ok || !data) {
        if (options.isLatestSequence(sequence)) options.setFetchError(true);
        return;
      }
      // Guard urutan: tolak snapshot bila respons permintaan yang lebih baru sudah
      // diterapkan. Cek stateVersion tetap dipertahankan sebagai jaring tangan kedua.
      if (sequence < lastAppliedSequence) return;
      options.setFetchError(false);
      options.setDetail(previous => previous && data.stateVersion < previous.stateVersion ? previous : data);
      lastAppliedSequence = sequence;
    } catch {
      if (alive && options.isLatestSequence(sequence)) options.setFetchError(true);
    }
  }
  return {
    start(): void {
      if (handle !== null) return;
      alive = true;
      handle = options.scheduleInterval(() => { void tick(); }, options.intervalMs);
    },
    stop(): void {
      alive = false;
      if (handle === null) return;
      options.cancelInterval(handle);
      handle = null;
    },
  };
}
