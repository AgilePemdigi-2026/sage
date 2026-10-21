# Desain HIST-01 — History per user, search, empty/error, navigasi

Issue: [#22](https://github.com/AgilePemdigi-2026/sage/issues/22) · Requirement: SAGE-FR-HIST-01..11 · APP-01
Penanggung jawab: rizqy-fadhil · Sprint 2 · Ukuran scope sisa: M
Status: Desain disetujui pembicaraan pada 20 Oktober 2026, menunggu review spec.

## 1. Tujuan

Halaman produk Riwayat Analisis yang membaca data nyata dari PostgreSQL (bukan fixture), dengan:

- List analisis milik satu pengguna (owner-scoped).
- Pencarian nama repository / branch / SHA, filter status.
- State lengkap: loading, daftar, kosong, no-match, gagal memuat.
- Navigasi: `QUEUED`/`RUNNING`/`FAILED` → halaman detail/progress nyata; `COMPLETED`/`COMPLETED_WITH_LIMITATIONS` → detail yang menyatakan hasil tersedia beserta link canonical graph.

Di luar scope (tidak kena pada paket ini): `POST /analyses/{id}/retry` (ANA-07), `DELETE` (DATA-02), export (EXP-*), graph produk (GRAPH-01), polling list real-time.

## 2. Komponen

| Bagian | File | Peran |
| --- | --- | --- |
| Query DB | `packages/database/src/history.ts` (baru) | `listAnalysesForUser`, `getAnalysisDetailForUser` — murni data, tanpa HTTP |
| API handler | `apps/web/lib/analyses/handlers.ts` (baru) | Handler GET dengan deps injection (mengikuti pola `target-handlers.ts`) |
| Route API | `apps/web/app/api/analyses/route.ts` (GET), `apps/web/app/api/analyses/[analysisId]/route.ts` (GET) | Rute Next.js |
| Halaman | `apps/web/app/workspace/history/page.tsx` (baru) | Server component, redirect ke `/login` saat tanpa sesi |
| Client UI | `apps/web/components/history/history-client.tsx` (baru) | Adaptasi `HistoryScreen` dari `sprint-ui/preview-client.tsx` |
| Halaman detail | `apps/web/app/analyses/[analysisId]/page.tsx` (baru) | Detail progress nyata, minimal |
| Nav | `apps/web/components/design-system/ui.tsx` | Link “Riwayat” → `/workspace/history` |
| Test | `tests/history.test.ts`, `tests/history-handlers.test.ts`, `scripts/test-history-http.ts` | Unit contract + HTTP handler |

## 3. Kontrak endpoint

### `GET /api/analyses`

Pemilik selalu dari session server; `userId` apa pun pada request tidak dipercaya.

- Query parameter: `query` (opsional), `status` (opsional, satu nilai enum), `cursor` (opsional).
- Validasi: `status` di luar enum → `400 INVALID_INPUT`; parameter tak dikenal → `400`; `cursor` rusak → `400 INVALID_INPUT`.
- Sort: `createdAt DESC`, tiebreak `id DESC` (memanfaatkan `@@index([ownerUserId, createdAt])`).
- `query` dicocokkan case-insensitive substring atas `repository.fullName`, `branchName`, `commitSha`.
- Cursor keyset: `(createdAt, id)` pasangan terakhir halaman sebelumnya; halaman berikut mulai murni setelah pasangan itu. `nextCursor: null` berarti habis.
- Batas halaman: 20 record; disebut di kontrak API dokumen.

Payload record: `{ id, repository: { fullName }, branchName, commitSha, status, errorCode?: string, queuedAt, startedAt?: string, completedAt?: string, retryOfAnalysisId?: string }`.
Envelope: `{ data: { analyses: [...], nextCursor: string | null } }`.

### `GET /api/analyses/{analysisId}`

- Owner-scoped; analisis milik user lain → `404 ANALYSIS_NOT_FOUND` (bukan 403, agar keberadaan tidak terkabarkan).
- Payload: context (`repository.fullName`, `branchName`, `commitSha` full), `status`, `errorCode`, `retryOfAnalysisId`, timestamps, `stages` (9 entri: key, label, status, errorCode — urutan tetap dari `ANALYSIS_STAGE_DEFINITIONS`), `limitations` (dari `AnalysisLimitation`: stageKey, code, safeExplanation), serta `resultUrl` untuk `graph` dan `document` **hanya** saat `COMPLETED`/`COMPLETED_WITH_LIMITATIONS`, dengan format canonical `/analyses/{id}/graph` dan `/analyses/{id}/document` (rute graph/document mengikuti GRAPH-01/DOC-01 nantinya).
- Response memuat `updatedAt` dan `stateVersion` monoton (turunan dari `updatedAt` analysis) sesuai kontrak API; UI tidak menerima versi yang lebih tua.

Error envelope mengikuti pola existing: `{ error: { code, message, details: {} }, requestId }`, header `Cache-Control: private, no-store`, `Vary: Cookie`, `X-Content-Type-Options: nosniff`.

## 4. Navigasi

- Record number pada list → `/analyses/{analysisId}`: `queued/running/failed` membuka detail progress nyata; `completed/*` membuka detail yang menyatakan hasil tersedia + tautan graph.
- Tombol graph pada `completed` dirender sebagai link canonical `/analyses/{id}/graph`. Karena rute graph produk belum ada, keadaan awal halaman graph tidak tersedia — PR mencatat limitation ini; tautan tetap canonical sehingga tidak perlu diubah ketika GRAPH-01 selesai.
- Halaman detail melakukan polling ringan `GET /api/analyses/{id}` (interval ~3 detik) hanya saat status non-terminal, menghormati `stateVersion`. Halaman list tanpa polling; status diperbarui saat pengguna kembali dari detail.

## 5. State UI

Dipersilakan dari fixture `HistoryScreen` (state ready/empty/no-match/error):

- Loading · daftar · kosong (“belum ada analisis”) · no-match (query tidak cocok, tombol reset) · gagal memuat.
- Kolom: Repository + commit · Branch · Status · Aksi (Buka). Tanggal format `id-ID`, zona `Asia/Jakarta`.
- Breadcrumb: `Workspace / Riwayat`. Nav header berubah dari `/preview/history` ke `/workspace/history`.
- Elemen preview dihapus dari jalur produk; halaman `/preview/*` tetap utuh untuk keperluan QA-03/UI-02.

## 6. Keamanan

- Owner dari session server, tidak dari input request.
- Query DB selalu di-predicate `(ownerUserId, ...)`.
- 404 untuk record milik user lain.
- Tanpa token/private key/kredensial tersaji ke browser.
- Header no-store pada semua response history.

## 7. Testing

- Unit/contract `tests/history.test.ts`: filter status, filter query (nama/branch/SHA), cursor keyset (urutan stabil, tidak ada duplikat/terlewat), empty.
- Handler `tests/history-handlers.test.ts`: auth, parameter tidak valid, 404 lintas user, header response, bentuk envelope dan payload.
- HTTP `scripts/test-history-http.ts` (pola `test-target-http.ts`): dev server dan user fixture, dua user untuk isolasi.
- Integration (pola `database.integration.ts`): isolation owner pada Postgres nyata.
- T-HIST-01 dipetakan: empty history, list berbagai status, query nama/SHA, buka record, navigasi berdasarkan status (graph link tercatat sebagai limitation sampai GRAPH-01).
- Semua suite baru didaftarkan pada `npm test` di `package.json`.

## 8. Risiko dan catatan

1. Cursor berbasis `createdAt` (mengikuti index yang ada), bukan `queuedAt` — disebut eksplisit pada PR.
2. Halaman detail progress bersifat minimal dan fungsional; kosmetik menyusul pada QA-03/Valentina.
3. `AnalysisLimitation` saat ini belum ada penulisnya (consumer nonaktif); field tetap ditampilkan jika ada.
4. Participant baru bisa melihat list nyata setelah submission menghasilkan record analysis; halaman tetap dapat diuji menggunakan record dari test/integration submission yang tersedia.

## 9. Acceptance criteria (dari issue #22)

- [ ] Search nama/SHA benar, context dan tanggal benar.
- [ ] Navigasi: queued/running/failed ke progress (halaman detail nyata), completed ke link graph canonical.
- [ ] Hanya milik user (owner-scoped, 404 lintas user).
- [ ] Kontrak dan dokumentasi terdampak diperbarui (`API_CONTRACT.md`, bila perlu `DATA_MODEL.md`).
- [ ] Bukti aktual: expected vs actual, command dijalankan, hash SHA uji, limitations dicatat.
