import test from "node:test";
import assert from "node:assert/strict";
import { statusLabel, statusTone, formatDateTime } from "../apps/web/components/history/format.ts";
import { applyHistoryPatch, createHistoryData } from "../apps/web/components/history/history-data.ts";
import type { HistoryDataPatch, HistoryFetch, HistoryItem, HistoryPatchTarget } from "../apps/web/components/history/history-data.ts";
import { createDetailPoller } from "../apps/web/components/history/detail-data.ts";
import type { AnalysisDetailView } from "../apps/web/lib/analyses/presenters.ts";
import { ANALYSIS_STAGE_DEFINITIONS } from "@sage/contracts";

test("status labels and tones cover every analysis status", () => {
  assert.equal(statusLabel("QUEUED"), "Menunggu");
  assert.equal(statusLabel("RUNNING"), "Berjalan");
  assert.equal(statusLabel("COMPLETED"), "Selesai");
  assert.equal(statusLabel("COMPLETED_WITH_LIMITATIONS"), "Selesai dengan batasan");
  assert.equal(statusLabel("FAILED"), "Gagal");
  for (const unknown of ["UNKNOWN", ""]) assert.equal(statusLabel(unknown), null);
  assert.equal(statusTone("QUEUED"), "info");
  assert.equal(statusTone("RUNNING"), "info");
  assert.equal(statusTone("COMPLETED"), "success");
  assert.equal(statusTone("COMPLETED_WITH_LIMITATIONS"), "warning");
  assert.equal(statusTone("FAILED"), "error");
  assert.equal(statusTone("UNKNOWN"), null);
});
test("datetime formats id-ID in Asia/Jakarta", () => {
  const value = formatDateTime("2026-10-19T01:01:00Z");
  assert.match(value, /2026/);
  assert.match(value, /08[.:]01|08\.01|08:01/);
  assert.match(value, /Okt|Oct/);
});
test("formatDateTime tolerates null and invalid", () => {
  assert.equal(formatDateTime(null), "—");
  assert.equal(formatDateTime(undefined), "—");
  assert.equal(formatDateTime("not-a-date"), "—");
});

/** Harness ala reviewer: komponen dijalankan lewat mesin state hasil ekstraksi
 * (history-data.ts / detail-data.ts) dengan fetch palsu + timer manual, tanpa React/CSS. */

function drain(): Promise<void> {
  return new Promise(setImmediate);
}

type PendingFetch = (response: Response) => void;

function historyItem(id: string): HistoryItem {
  return {
    id, repository: { fullName: `acme/${id}` }, branch: "main", commitSha: `sha-${id}`,
    status: "QUEUED", errorCode: null, queuedAt: "2026-10-20T00:00:00Z", startedAt: null,
    completedAt: null, retryOfAnalysisId: null,
  };
}

/** Fetch palsu dibuat per-harness di bawah; respons disetel manual oleh test. */

type HistoryState = { items: HistoryItem[] | null; nextCursor: string | null; error: boolean; loaded: boolean };

/** Gabungan fetch palsu + pemegang state; urutan patch juga direkam agar keputusan data layer bisa diperiksa. */
function historyHarness() {
  const pendingFetches: PendingFetch[] = [];
  const urls: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- profil fetch serupa NamedParameter; hanya input yang dipakai
  const fetch: HistoryFetch = (input: string, _init: RequestInit) => new Promise<Response>(resolve => {
    urls.push(input);
    pendingFetches.push(resolve);
  });
  function resolveAt(index: number, body: unknown, status = 200): void {
    pendingFetches[index](new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
  }
  const state: HistoryState = { items: null, nextCursor: null, error: false, loaded: false };
  const target: HistoryPatchTarget = {
    updateItems: updater => { state.items = updater(state.items); },
    setItems: value => { state.items = value; },
    setNextCursor: value => { state.nextCursor = value; },
    setError: value => { state.error = value; },
    setLoaded: value => { state.loaded = value; },
  };
  const patches: HistoryDataPatch[] = [];
  const controller = createHistoryData({
    fetch,
    apply: patch => {
      patches.push(patch);
      applyHistoryPatch(target, patch);
    },
  });
  return { state, controller, resolveAt, urls, patches };
}

test("respons halaman dua filter lama dibuang, daftar & cursor filter baru utuh", async () => {
  const { state, controller, resolveAt } = historyHarness();
  const a1 = historyItem("analyses-first-a00");
  const b1 = historyItem("analyses-first-b00");

  controller.reload("acc-1", "", "", new AbortController().signal);   // filter A, halaman 1
  await drain();
  resolveAt(0, { data: { analyses: [a1], nextCursor: "CUR-A" } });
  await drain();
  assert.deepEqual(state.items, [a1]);
  assert.equal(state.nextCursor, "CUR-A");
  assert.equal(state.error, false);
  assert.equal(state.loaded, true);

  controller.loadMore("acc-1", "", "", "CUR-A");            // halaman 2 filter A — masih terbang
  controller.reload("acc-1", "report-service", "", new AbortController().signal); // filter B diganti pengguna
  await drain();
  resolveAt(2, { data: { analyses: [b1], nextCursor: "CUR-B" } });
  await drain();
  assert.deepEqual(state.items, [b1], "filter B dirender bersih");
  assert.equal(state.nextCursor, "CUR-B");
  assert.equal(state.error, false);

  // Respons halaman 2 filter A akhirnya datang — harus dibuang.
  resolveAt(1, { data: { analyses: [historyItem("analyses-stale-a00")], nextCursor: "CUR-A2" } });
  await drain();
  assert.deepEqual(state.items, [b1], "item usang tidak masuk daftar filter B");
  assert.equal(state.nextCursor, "CUR-B", "cursor filter B tidak tertimpa");
  assert.equal(state.error, false);
});

test("kegagalan muat lebih banyak menjaga baris, memulihkan cursor, dan bisa diulang", async () => {
  const { state, controller, resolveAt, urls } = historyHarness();
  const a1 = historyItem("analyses-first-a00");
  const a2 = historyItem("analyses-second-b0");

  controller.reload("acc-1", "", "", new AbortController().signal);
  await drain();
  resolveAt(0, { data: { analyses: [a1], nextCursor: "CUR-A" } });
  await drain();
  assert.deepEqual(state.items, [a1]);

  controller.loadMore("acc-1", "", "", "CUR-A");
  await drain();
  resolveAt(1, { data: { error: "boom" } }, 503);
  await drain();
  assert.deepEqual(state.items, [a1], "baris yang sudah dimuat tetap tampil saat loadMore gagal");
  assert.equal(state.nextCursor, "CUR-A", "cursor dipulihkan agar tombol Muat lebih banyak kembali");
  assert.equal(state.error, true, "notifikasi error ditampilkan meski daftar sudah ada");

  controller.loadMore("acc-1", "", "", "CUR-A");           // percobaan ulang
  await drain();
  resolveAt(2, { data: { analyses: [a2], nextCursor: null } });
  await drain();
  assert.deepEqual(state.items, [a1, a2]);
  assert.equal(state.nextCursor, null);
  assert.equal(state.error, false, "keberhasilan ulang menghapus notifikasi");
  assert.match(urls.at(-1)!, /cursor=CUR-A$/);
});

test("tombol pagination nonaktif selama halaman pertama filter baru masih pending", async () => {
  const { state, controller, resolveAt, patches } = historyHarness();
  const a1 = historyItem("analyses-first-a00");
  const b1 = historyItem("analyses-first-b00");

  controller.reload("acc-1", "", "", new AbortController().signal);   // filter A, halaman 1
  await drain();
  resolveAt(0, { data: { analyses: [a1], nextCursor: "CUR-A" } });
  await drain();
  assert.equal(state.nextCursor, "CUR-A");

  controller.reload("acc-1", "report-service", "", new AbortController().signal); // filter B mulai
  assert.equal(state.nextCursor, null, "cursor filter lama dinonaktifkan saat reload dimulai");

  // Coba muat lebih banyak dengan cursor lama: tombol tidak ada (cursor null), dan
  // loadMore sendiri menolak cursor kosong sehingga tidak ada request keempat.
  controller.loadMore("acc-1", "report-service", "", "");
  await drain();
  assert.equal(patches.filter(patch => patch.appendItems).length, 0, "tanpa append dari cursor usang");

  resolveAt(1, { data: { analyses: [b1], nextCursor: "CUR-B" } });
  await drain();
  assert.deepEqual(state.items, [b1]);
  assert.equal(state.nextCursor, "CUR-B", "cursor hanya hidup lagi bersama filter yang berhasil dimuat");
});


type DetailState = { detail: AnalysisDetailView | null; fetchError: boolean };

const HARNESS_STAGE_KEYS = [
  "SNAPSHOT", "LANGUAGE_DETECTION", "STATIC_ANALYSIS", "COMMON_CODE_MODEL", "KNOWLEDGE_GRAPH",
  "INTERFACE_CATALOG", "SOFTWARE_ENGINEERING_DIAGRAM", "UML_CLASS_DIAGRAM", "ARCHITECTURE_DOCUMENT",
] as const;

// Label tahap memakai ANALYSIS_STAGE_DEFINITIONS agar tipe AnalysisDetailView valid.
const stageLabels = new Map(ANALYSIS_STAGE_DEFINITIONS.map(stage => [stage.key, stage.label] as const));

function detailView(input: { stateVersion: number; firstStage: string }): AnalysisDetailView {
  return {
    stateVersion: input.stateVersion,
    updatedAt: "2026-10-20T00:00:00.000Z",
    context: { repositoryFullName: "acme/demo", branchName: "main", commitSha: "abcdef1234" },
    status: "RUNNING",
    errorCode: null,
    retryOfAnalysisId: null,
    timestamps: { queuedAt: "2026-10-20T00:00:00Z", startedAt: null, completedAt: null },
    stages: Array.from({ length: 9 }, (_, index) => ({
      sequence: index + 1,
      key: HARNESS_STAGE_KEYS[index],
      label: stageLabels.get(HARNESS_STAGE_KEYS[index]) ?? HARNESS_STAGE_KEYS[index],
      status: index === 0 ? input.firstStage : "PENDING",
      errorCode: null,
      startedAt: null,
      finishedAt: null,
    })),
    limitations: [],
    results: null,
  };
}

/** DetailHarness: interval manual + fetch palsu; compose persis seperti wiring AnalysisDetailClient. */
function detailHarness(initial: AnalysisDetailView) {
  const state: DetailState = { detail: initial, fetchError: false };
  let sequence = 0;
  let ticker: (() => void) | null = null;
  let cancelled = false;
  const scheduledMs: number[] = [];
  const pendingFetches: PendingFetch[] = [];
  const poller = createDetailPoller({
    analysisId: "hist-detail-0001x", accountKey: "acc-1", intervalMs: 3000,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- profil fetch serupa NamedParameter; hanya input yang dipakai
    fetch: (_input, _init) => new Promise<Response>(resolve => { pendingFetches.push(resolve); }),
    scheduleInterval: (callback, ms) => { ticker = callback; scheduledMs.push(ms); return 1; },
    cancelInterval: () => { cancelled = true; },
    touchSequence: () => { sequence += 1; return sequence; },
    isLatestSequence: candidate => sequence === candidate,
    setFetchError: value => { state.fetchError = value; },
    setDetail: updater => { state.detail = updater(state.detail); },
  });
  function fire(): void { ticker?.(); }
  function resolveAt(index: number, body: unknown, status = 200): void {
    pendingFetches[index](new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
  }
  return {
    state, poller, fire, resolveAt, scheduledMs,
    get cancelled() { return cancelled; },
    get sequence() { return sequence; },
  };
}

test("poll detail: dua poll tumpang tindih, respons usang terakhir tidak me-revert tahap selesai", async () => {
  const harness = detailHarness(detailView({ stateVersion: 1000, firstStage: "RUNNING" }));
  const newer = detailView({ stateVersion: 1000, firstStage: "COMPLETED" });
  const stale = detailView({ stateVersion: 1000, firstStage: "PENDING" });

  harness.poller.start();
  assert.deepEqual(harness.scheduledMs, [3000]);
  harness.fire();                          // poll 1: lambat, masih di jalan saat interval berikut
  harness.fire();                          // poll 2 terbit sebelum respons poll 1 tiba
  assert.equal(harness.sequence, 2);

  harness.resolveAt(1, { data: newer });   // snapshot TERBARUNYA datang lebih dulu
  await drain();
  assert.equal(harness.state.detail?.stages[0]?.status, "COMPLETED", "snapshot baru diterapkan walau stateVersion sama");

  harness.resolveAt(0, { data: stale });   // respons lama datang belakangan, stateVersion identik
  await drain();
  assert.equal(harness.state.detail?.stages[0]?.status, "COMPLETED", "snapshot usang ditolak, tahap selesai tetap utuh");
  assert.equal(harness.state.fetchError, false);
  harness.poller.stop();
});

test("poll detail: stateVersion lebih lama tetap ditolak meski permintaannya terbaru", async () => {
  const harness = detailHarness(detailView({ stateVersion: 2000, firstStage: "COMPLETED" }));

  harness.poller.start();
  harness.fire();
  harness.resolveAt(0, { data: detailView({ stateVersion: 3000, firstStage: "RUNNING" }) });
  await drain();
  assert.equal(harness.state.detail?.stateVersion, 3000);

  harness.fire();                          // poll berikutnya masih permintaan terbaru (seq 2)
  harness.resolveAt(1, { data: detailView({ stateVersion: 1500, firstStage: "QUEUED" }) });
  await drain();
  assert.equal(harness.state.detail?.stateVersion, 3000, "stateVersion mundur ditolak");
  assert.equal(harness.state.detail?.stages[0]?.status, "RUNNING");
  harness.poller.stop();
});

test("poll detail: semua respons lebih lambat dari interval tetap memperbarui UI", async () => {
  const harness = detailHarness(detailView({ stateVersion: 1000, firstStage: "RUNNING" }));

  harness.poller.start();
  for (let index = 0; index < 6; index += 1) harness.fire();  // enam interval, tiap respons > interval
  assert.equal(harness.sequence, 6);

  // Lima respons sukses tiba berurutan (konsisten lebih lambat dari interval).
  for (let reply = 0; reply < 5; reply += 1) {
    harness.resolveAt(reply, { data: detailView({ stateVersion: 2000 + reply * 100, firstStage: reply === 4 ? "COMPLETED" : "RUNNING" }) });
    await drain();
  }
  assert.equal(harness.state.fetchError, false, "tanpa fetch error palsu saat UI lambat");
  assert.equal(harness.state.detail?.stateVersion, 2400, "lima snapshot sukses tetap diterapkan");
  assert.equal(harness.state.detail?.stages[0]?.status, "COMPLETED", "UI tidak macet di RUNNING");
  harness.poller.stop();
});

test("poll detail: respons instance lama dibuang setelah stop dan recreate effect", async () => {
  const state: DetailState = { detail: detailView({ stateVersion: 1000, firstStage: "RUNNING" }), fetchError: false };
  let sequence = 0;
  let ticker: (() => void) | null = null;
  type RecreatedInstance = {
    poller: ReturnType<typeof createDetailPoller>;
    fire: () => void;
    resolveAt: (index: number, body: unknown) => void;
  };
  const makeInstance = (): RecreatedInstance => {
    const pending: PendingFetch[] = [];
    const poller = createDetailPoller({
      analysisId: "hist-detail-0001x", accountKey: "acc-1", intervalMs: 3000,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars -- profil fetch serupa NamedParameter; hanya input yang dipakai
      fetch: (_input, _init) => new Promise<Response>(resolve => { pending.push(resolve); }),
      scheduleInterval: callback => { ticker = callback; return 1; },
      cancelInterval: () => { ticker = null; },
      touchSequence: () => { sequence += 1; return sequence; },
      isLatestSequence: candidate => sequence === candidate,
      setFetchError: value => { state.fetchError = value; },
      setDetail: updater => { state.detail = updater(state.detail); },
    });
    return {
      poller,
      fire: () => { ticker?.(); },
      resolveAt: (index, body) => {
        pending[index](new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }));
      },
    };
  };

  // Instance A: dua tick, keduanya masih di jalan.
  const instanceA = makeInstance();
  instanceA.poller.start();
  instanceA.fire();                       // seq 1
  instanceA.fire();                       // seq 2
  assert.equal(sequence, 2);
  instanceA.resolveAt(0, { data: detailView({ stateVersion: 1000, firstStage: "RUNNING" }) });
  await drain();
  assert.equal(state.detail?.stages[0]?.status, "RUNNING");

  // Cleanup effect membuat instance B (deteksi detail baru ter-apply).
  instanceA.poller.stop();
  const instanceB = makeInstance();
  instanceB.poller.start();
  instanceB.fire();                       // seq 3
  assert.equal(sequence, 3, "nomor urut tetap monoton melintasi recreate");
  instanceB.resolveAt(0, { data: detailView({ stateVersion: 1000, firstStage: "COMPLETED" }) });
  await drain();
  assert.equal(state.detail?.stateVersion, 1000);
  assert.equal(state.detail?.stages[0]?.status, "COMPLETED", "instance B membawa tahap berjalan selesai");

  // Respons lama instance A (seq 2) datang terseokseok: stateVersion induk sama
  // (transisi tahap memutakhirkan AnalysisStage saja), lastAppliedSequence milik A
  // masih 1 — tanpa invalidasi lifecycle tahap akan kembali PENDING.
  instanceA.resolveAt(1, { data: detailView({ stateVersion: 1000, firstStage: "PENDING" }) });
  await drain();
  assert.equal(state.detail?.stages[0]?.status, "COMPLETED", "respons instance yang sudah di stop dibuang");
  assert.equal(state.fetchError, false);
  instanceB.poller.stop();
});
