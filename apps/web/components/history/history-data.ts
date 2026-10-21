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
};

/** Profil fetch yang dipakai klien riwayat: cukup `ok` + `json()` agar test bisa memalsukan respons. */
export type HistoryFetch = (input: string, init: RequestInit) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;

type HistoryPageBody = { data: { analyses: HistoryItem[]; nextCursor: string | null } };

/** Perubahan state yang dilaporkan data layer ke pemilik state (HistoryClient). */
export type HistoryDataPatch = {
  /** Ganti seluruh daftar (respons filter baru). */
  items?: HistoryItem[];
  /** Tambah ke daftar (respons "Muat lebih banyak"). */
  appendItems?: HistoryItem[];
  /** Selalu dipakai saat kuncinya eksplisit ada (termasuk null) — dicek via `"nextCursor" in patch`. */
  nextCursor?: string | null;
  error?: boolean;
  loaded?: boolean;
};

/** Antar muka pemilik state yang butuh updater untuk append agar merge memakai daftar terkini. */
export type HistoryPatchTarget = {
  updateItems: (updater: (previous: HistoryItem[] | null) => HistoryItem[]) => void;
  setItems: (items: HistoryItem[] | null) => void;
  setNextCursor: (cursor: string | null) => void;
  setError: (error: boolean) => void;
  setLoaded: (loaded: boolean) => void;
};

export function applyHistoryPatch(target: HistoryPatchTarget, patch: HistoryDataPatch): void {
  const appendItems = patch.appendItems;
  if (appendItems) {
    target.updateItems(previous => [...(previous ?? []), ...appendItems]);
  }
  if (patch.items !== undefined && !appendItems) {
    target.setItems(patch.items);
  }
  if ("nextCursor" in patch) target.setNextCursor(patch.nextCursor ?? null);
  if (patch.error !== undefined) target.setError(patch.error);
  if (patch.loaded !== undefined) target.setLoaded(patch.loaded);
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
};

/** Mesin state daftar riwayat. Setiap permintaan (filter dan pagination) diberi nomor generasi
 * dari filter aktif; respons yang datang saat generasi sudah berganti (misalnya pengguna
 * mengubah query/status) dibuang, sehingga halaman dua filter lama tidak pernah bercampur. */
export function createHistoryData(options: HistoryDataOptions) {
  let generation = 0;
  return {
    reload(accountKey: string, query: string, status: string, signal: AbortSignal): void {
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
          options.apply({ error: false, items: body.data.analyses, nextCursor: body.data.nextCursor });
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
          options.apply({ error: false, appendItems: body.data.analyses, nextCursor: body.data.nextCursor });
        } catch {
          if (current === generation) options.apply({ error: true, nextCursor: cursor });
        }
      })();
    },
  };
}
