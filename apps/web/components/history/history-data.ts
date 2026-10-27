/** Logika data daftar riwayat, terpisah dari render HistoryClient supaya bisa diuji
 * sebagai harness murni (tanpa React/CSS/next): generasi filter, guard respons usang,
 * append halaman, dan pemulihan cursor saat "Muat lebih banyak" gagal. */

export type HistoryItem = {
  id: string;
  repository: { fullName: string };
  branch: string;
  commitSha: string;
  status: string;
  errorCode: string | null;
  queuedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  retryOfAnalysisId: string | null;
  deletion?: HistoryDeletion | null;
};

export type HistoryDeletion = {
  jobId: string;
  analysisId: string;
  status: "QUEUED" | "RUNNING" | "FAILED" | "COMPLETED";
  errorCode: string | null;
};

export type HistoryDeletionAction = {
  phase: "submitting" | "pending" | "failed";
  message: string | null;
  errorCode: string | null;
};

export type HistoryDeletionControls = {
  pending: boolean;
  failed: boolean;
  deleteDisabled: boolean;
};

/** Server status wins over a pending action left by a poll that has already settled. */
export function historyDeletionControls(item: HistoryItem, action: HistoryDeletionAction | undefined, requestActive: boolean): HistoryDeletionControls {
  const deletionStatus = item.deletion?.status;
  const analysisActive = item.status === "QUEUED" || item.status === "RUNNING";
  const pendingFromServer = deletionStatus === "QUEUED" || deletionStatus === "RUNNING";
  const pendingFromAction = action?.phase === "submitting" || (action?.phase === "pending" && requestActive);
  const pending = pendingFromServer || pendingFromAction;
  const failed = deletionStatus === "FAILED" || action?.phase === "failed";
  return { pending, failed, deleteDisabled: analysisActive || pending };
}

/** Profil fetch yang dipakai klien riwayat: cukup `ok`, `status`, dan `json()` agar test bisa memalsukan respons. */
export type HistoryFetch = (input: string, init: RequestInit) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

type HistoryPageBody = { data: { analyses: HistoryItem[]; nextCursor: string | null } };

/** Perubahan state yang dilaporkan data layer ke pemilik state (HistoryClient). */
export type HistoryDataPatch = {
  /** Ganti seluruh daftar (respons filter baru). */
  items?: HistoryItem[] | null;
  /** Tambah ke daftar (respons "Muat lebih banyak"). */
  appendItems?: HistoryItem[];
  /** Selalu dipakai saat kuncinya eksplisit ada (termasuk null) — dicek via `"nextCursor" in patch`. */
  nextCursor?: string | null;
  error?: boolean;
  loaded?: boolean;
  deletion?: { analysisId: string; value: HistoryDeletion | null };
  deletionAction?: { analysisId: string; value: HistoryDeletionAction | null };
  clearDeletionActions?: boolean;
  removeAnalysisId?: string;
};

/** Antar muka pemilik state yang butuh updater untuk append agar merge memakai daftar terkini. */
export type HistoryPatchTarget = {
  updateItems: (updater: (previous: HistoryItem[] | null) => HistoryItem[]) => void;
  setItems: (items: HistoryItem[] | null) => void;
  setNextCursor: (cursor: string | null) => void;
  setError: (error: boolean) => void;
  setLoaded: (loaded: boolean) => void;
  setDeletion?: (analysisId: string, deletion: HistoryDeletion | null) => void;
  setDeletionAction?: (analysisId: string, action: HistoryDeletionAction | null) => void;
  clearDeletionActions?: () => void;
};

export function applyHistoryPatch(target: HistoryPatchTarget, patch: HistoryDataPatch): void {
  const appendItems = patch.appendItems;
  if (appendItems) {
    target.updateItems(previous => [...(previous ?? []), ...appendItems]);
  }
  if (patch.items !== undefined && !appendItems) {
    target.setItems(patch.items);
  }
  if (patch.removeAnalysisId) {
    target.updateItems(previous => (previous ?? []).filter(item => item.id !== patch.removeAnalysisId));
  }
  if ("nextCursor" in patch) target.setNextCursor(patch.nextCursor ?? null);
  if (patch.error !== undefined) target.setError(patch.error);
  if (patch.loaded !== undefined) target.setLoaded(patch.loaded);
  if (patch.deletion) target.setDeletion?.(patch.deletion.analysisId, patch.deletion.value);
  if (patch.clearDeletionActions) target.clearDeletionActions?.();
  if (patch.deletionAction) target.setDeletionAction?.(patch.deletionAction.analysisId, patch.deletionAction.value);
}

function listUrl(query: string, status: string, cursor?: string): string {
  const params = new URLSearchParams();
  const search = query.trim();
  if (search) params.set("query", search);
  if (status) params.set("status", status);
  if (cursor) params.set("cursor", cursor);
  return `/api/analyses${params.size ? `?${params.toString()}` : ""}`;
}

export type HistoryDataOptions = {
  fetch: HistoryFetch;
  apply: (patch: HistoryDataPatch) => void;
  onAnalysisDeleted?: (analysisId: string) => void;
  waitForDeletionPoll?: (signal: AbortSignal, delayMs: number) => Promise<void>;
  maxDeletionPolls?: number;
};

const DELETION_POLL_INTERVAL_MS = 2000;
const MAX_DELETION_POLLS = 60;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function deletionFromBody(value: unknown): HistoryDeletion | null {
  if (!isRecord(value) || !isRecord(value.data) || !isRecord(value.data.deletion)) return null;
  const deletion = value.data.deletion;
  if (typeof deletion.jobId !== "string" || typeof deletion.analysisId !== "string") return null;
  if (!(deletion.status === "QUEUED" || deletion.status === "RUNNING" || deletion.status === "FAILED" || deletion.status === "COMPLETED")) return null;
  if (deletion.errorCode !== null && typeof deletion.errorCode !== "string") return null;
  return {
    jobId: deletion.jobId,
    analysisId: deletion.analysisId,
    status: deletion.status,
    errorCode: deletion.errorCode,
  };
}

function errorFromBody(value: unknown): { code: string | null; message: string | null } {
  if (!isRecord(value) || !isRecord(value.error)) return { code: null, message: null };
  const { code, message } = value.error;
  return {
    code: typeof code === "string" ? code : null,
    message: typeof message === "string" ? message : null,
  };
}

function deletionErrorMessage(code: string | null, fallback: string): string {
  if (code === "ANALYSIS_ACTIVE") return "Analisis masih berjalan dan belum dapat dihapus.";
  if (code === "EXPORT_ACTIVE") return "Ekspor analisis masih berjalan. Coba lagi setelah ekspor selesai.";
  if (code === "AUTH_REQUIRED") return "Sesi akun tidak valid. Periksa akun aktif lalu coba lagi.";
  if (code === "ANALYSIS_NOT_FOUND") return "Analisis sudah tidak tersedia. Muat ulang riwayat.";
  return fallback;
}

function waitForPoll(signal: AbortSignal, delayMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timeout);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Mesin state daftar riwayat. Setiap permintaan (filter dan pagination) diberi nomor generasi
 * dari filter aktif; respons yang datang saat generasi sudah berganti (misalnya pengguna
 * mengubah query/status) dibuang, sehingga halaman dua filter lama tidak pernah bercampur. */
export function createHistoryData(options: HistoryDataOptions) {
  let generation = 0;
  let accountGeneration = 0;
  let activeAccountKey: string | null = null;
  const deletionRequests = new Map<string, AbortController>();

  function isActiveAccount(accountKey: string, version: number): boolean {
    return activeAccountKey === accountKey && accountGeneration === version;
  }

  function removeDeletionRequest(analysisId: string, controller: AbortController): void {
    if (deletionRequests.get(analysisId) === controller) deletionRequests.delete(analysisId);
  }

  function finishDeletion(analysisId: string, accountKey: string, version: number, controller: AbortController): void {
    if (!isActiveAccount(accountKey, version) || deletionRequests.get(analysisId) !== controller) return;
    removeDeletionRequest(analysisId, controller);
    controller.abort();
    generation += 1;
    options.apply({ removeAnalysisId: analysisId, deletionAction: { analysisId, value: null } });
    options.onAnalysisDeleted?.(analysisId);
  }

  return {
    isAccountActive(accountKey: string): boolean {
      return activeAccountKey === accountKey;
    },
    isDeletionActive(analysisId: string): boolean {
      return deletionRequests.has(analysisId);
    },
    reload(accountKey: string, query: string, status: string, signal: AbortSignal): void {
      if (activeAccountKey !== accountKey) {
        const switchedFromAccount = activeAccountKey !== null;
        activeAccountKey = accountKey;
        accountGeneration += 1;
        generation += 1;
        for (const controller of deletionRequests.values()) controller.abort();
        deletionRequests.clear();
        if (switchedFromAccount) {
          options.apply({ items: null, nextCursor: null, error: false, loaded: false, clearDeletionActions: true });
        }
      }
      const current = ++generation;
      // Nonaktifkan pagination sejak reload dimulai: cursor milik filter lama tidak
      // boleh dipakai bersama query filter baru, meski halaman pertama belum selesai.
      options.apply({ nextCursor: null });
      void (async () => {
        try {
          const response = await options.fetch(listUrl(query, status), {
            headers: { "X-SAGE-Account": accountKey }, cache: "no-store", signal,
          });
          if (current !== generation) return;
          if (!response.ok) { options.apply({ error: true }); return; }
          const body = (await response.json()) as HistoryPageBody;
          if (current !== generation) return;
          for (const item of body.data.analyses) {
            if (item.deletion?.status === "FAILED" && !deletionRequests.has(item.id)) {
              options.apply({ deletionAction: { analysisId: item.id, value: null } });
            }
          }
          options.apply({
            error: false,
            items: body.data.analyses.filter(item => item.deletion?.status !== "COMPLETED"),
            nextCursor: body.data.nextCursor,
          });
        } catch (caught) {
          if ((caught as Error).name !== "AbortError" && current === generation) options.apply({ error: true });
        } finally {
          if (current === generation) options.apply({ loaded: true });
        }
      })();
    },
    /** Muat halaman berikutnya. Cursor disimpan dan dipulihkan pada kegagalan; daftar dan
     * cursor hanya berubah bila respons masih generasi filter yang aktif. */
    loadMore(accountKey: string, query: string, status: string, cursor: string): void {
      if (!cursor) return;
      const current = generation;
      options.apply({ nextCursor: null });
      void (async () => {
        try {
          const response = await options.fetch(listUrl(query, status, cursor), {
            headers: { "X-SAGE-Account": accountKey }, cache: "no-store",
          });
          if (current !== generation) return;
          if (!response.ok) { options.apply({ error: true, nextCursor: cursor }); return; }
          const body = (await response.json()) as HistoryPageBody;
          if (current !== generation) return;
          options.apply({
            error: false,
            appendItems: body.data.analyses.filter(item => item.deletion?.status !== "COMPLETED"),
            nextCursor: body.data.nextCursor,
          });
        } catch {
          if (current === generation) options.apply({ error: true, nextCursor: cursor });
        }
      })();
    },
    /** Kirim permintaan penghapusan dan ikuti job sampai selesai, gagal, atau batas polling tercapai. */
    deleteAnalysis(accountKey: string, analysisId: string): void {
      if (activeAccountKey !== accountKey || deletionRequests.has(analysisId)) return;
      const version = accountGeneration;
      const controller = new AbortController();
      deletionRequests.set(analysisId, controller);
      const isCurrent = () => isActiveAccount(accountKey, version) && deletionRequests.get(analysisId) === controller;
      const setAction = (value: HistoryDeletionAction | null) => {
        if (isCurrent()) options.apply({ deletionAction: { analysisId, value } });
      };
      const setDeletion = (value: HistoryDeletion) => {
        if (isCurrent()) options.apply({ deletion: { analysisId, value } });
      };
      const fail = (code: string | null, message: string) => {
        if (!isCurrent()) return;
        setAction({ phase: "failed", errorCode: code, message: deletionErrorMessage(code, message) });
        removeDeletionRequest(analysisId, controller);
      };

      setAction({ phase: "submitting", errorCode: null, message: null });
      void (async () => {
        try {
          const response = await options.fetch(`/api/analyses/${encodeURIComponent(analysisId)}`, {
            method: "DELETE",
            headers: { "Content-Type": "application/json", "X-SAGE-Account": accountKey },
            body: "{}",
            cache: "no-store",
            credentials: "same-origin",
            signal: controller.signal,
          });
          if (!isCurrent()) return;
          if (response.status === 204) {
            finishDeletion(analysisId, accountKey, version, controller);
            return;
          }
          const body = await response.json().catch(() => null);
          if (!isCurrent()) return;
          if (!response.ok) {
            const error = errorFromBody(body);
            fail(error.code, error.message ?? "Penghapusan analisis gagal. Coba lagi.");
            return;
          }
          const deletion = deletionFromBody(body);
          if (!deletion || deletion.analysisId !== analysisId) {
            fail(null, "Status penghapusan belum dapat dibaca. Coba lagi.");
            return;
          }
          if (deletion.status === "COMPLETED") {
            setDeletion(deletion);
            finishDeletion(analysisId, accountKey, version, controller);
            return;
          }
          setDeletion(deletion);
          if (deletion.status === "FAILED") {
            setAction({
              phase: "failed", errorCode: deletion.errorCode,
              message: deletionErrorMessage(deletion.errorCode, "Penghapusan gagal. Coba lagi untuk mengulang pembersihan."),
            });
            removeDeletionRequest(analysisId, controller);
            return;
          }
          setAction({ phase: "pending", errorCode: null, message: null });

          const pollLimit = options.maxDeletionPolls ?? MAX_DELETION_POLLS;
          for (let attempt = 0; attempt < pollLimit && isCurrent(); attempt += 1) {
            try {
              await (options.waitForDeletionPoll ?? waitForPoll)(controller.signal, DELETION_POLL_INTERVAL_MS);
            } catch (cause) {
              if ((cause as Error).name === "AbortError") return;
              continue;
            }
            if (!isCurrent()) return;
            try {
              const poll = await options.fetch(`/api/jobs/${encodeURIComponent(deletion.jobId)}`, {
                headers: { "X-SAGE-Account": accountKey },
                cache: "no-store",
                credentials: "same-origin",
                signal: controller.signal,
              });
              if (!isCurrent()) return;
              if (!poll.ok) continue;
              const pollBody = await poll.json();
              if (!isCurrent()) return;
              const latest = deletionFromBody(pollBody);
              if (!latest || latest.analysisId !== analysisId || latest.jobId !== deletion.jobId) continue;
              setDeletion(latest);
              if (latest.status === "COMPLETED") {
                finishDeletion(analysisId, accountKey, version, controller);
                return;
              }
              if (latest.status === "FAILED") {
                setAction({
                  phase: "failed", errorCode: latest.errorCode,
                  message: deletionErrorMessage(latest.errorCode, "Penghapusan gagal. Coba lagi untuk mengulang pembersihan."),
                });
                removeDeletionRequest(analysisId, controller);
                return;
              }
            } catch (cause) {
              if ((cause as Error).name === "AbortError") return;
            }
          }
          if (isCurrent()) {
            setAction({
              phase: "pending", errorCode: null,
              message: "Penghapusan masih berjalan. Muat ulang riwayat untuk melihat status terbaru.",
            });
            removeDeletionRequest(analysisId, controller);
          }
        } catch (cause) {
          if ((cause as Error).name === "AbortError" || !isCurrent()) return;
          fail(null, "Permintaan penghapusan gagal dikirim. Coba lagi.");
        } finally {
          if (isCurrent() && deletionRequests.get(analysisId) === controller) {
            // The cleanup job is still queued/running; its row status keeps the action disabled.
            setAction({ phase: "pending", errorCode: null, message: null });
          }
        }
      })();
    },
  };
}
