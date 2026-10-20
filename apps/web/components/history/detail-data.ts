/** Logika polling halaman detail, terpisah dari render AnalysisDetailClient supaya bisa diuji
 * sebagai harness murni (tanpa React/CSS/next): interval diinjeksi, fetch diinjeksi, dan
 * penerapan snapshot dipagari nomor permintaan (sequence) yang monoton supaya respons usang
 * gagal mengembalikan tahap COMPLETED ke PENDING/RUNNING. */
import type { AnalysisDetailView } from "../../lib/analyses/presenters.ts";

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
};

export function createDetailPoller(options: DetailPollerOptions) {
  let handle: number | null = null;
  async function tick(): Promise<void> {
    const sequence = options.touchSequence();
    try {
      const response = await options.fetch(`/api/analyses/${options.analysisId}`, {
        headers: { "X-SAGE-Account": options.accountKey }, cache: "no-store",
      });
      const data = response.ok
        ? ((await response.json()) as { data: AnalysisDetailView }).data
        : null;
      // Guard utama: respons hanya berlaku bila permintaannya masih yang terakhir.
      // Cek stateVersion tetap dipertahankan sebagai jaring tangan kedua.
      if (!options.isLatestSequence(sequence)) return;
      if (!response.ok || !data) { options.setFetchError(true); return; }
      options.setFetchError(false);
      options.setDetail(previous => previous && data.stateVersion < previous.stateVersion ? previous : data);
    } catch {
      if (options.isLatestSequence(sequence)) options.setFetchError(true);
    }
  }
  return {
    start(): void {
      if (handle !== null) return;
      handle = options.scheduleInterval(() => { void tick(); }, options.intervalMs);
    },
    stop(): void {
      if (handle === null) return;
      options.cancelInterval(handle);
      handle = null;
    },
  };
}
