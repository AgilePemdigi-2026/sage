# Pemeriksaan HIST-01 — riwayat analysis per pengguna

Tanggal: 8 November 2026, Asia/Jakarta. Issue [#22](https://github.com/AgilePemdigi-2026/sage/issues/22). Base: `d553d32b08c2e60ac3b3f303a54b8947f46a3924`. Paket ini mencatat pemeriksaan query, handler, state UI, dan isolasi PostgreSQL untuk implementasi history yang sudah tersedia.

Runtime tes: Node.js 24.11.0, TypeScript/tsx dari lockfile repository, PostgreSQL 17. Nama database QA dibatasi oleh integration guard `sage_hist01_fresh`.

## Pemeriksaan yang dijalankan

| Command | Expected | Actual |
| --- | --- | --- |
| `node node_modules/tsx/dist/cli.mjs --test tests/history.test.ts tests/history-handlers.test.ts tests/history-ui.test.ts` | Cursor/filter, autentikasi dan validasi handler, format/status, state pencarian/paginasi dan polling detail | **23/23 lulus**, 0 gagal/skip |
| `DATABASE_URL=postgresql://sage:<test-password>@127.0.0.1:55441/sage_hist01_fresh npm run migrate --workspace @sage/database` pada PostgreSQL 17 baru | Semua migrasi berjalan pada database kosong yang diizinkan | **PASS**, seluruh migrasi sukses |
| `SAGE_HISTORY_TESTS=1 DATABASE_URL=postgresql://sage:<test-password>@127.0.0.1:55441/sage_hist01_fresh npm run test:history:integration` | Query owner-scoped, pencarian, filter status, cursor stabil, detail 9 tahap dan isolasi pemilik | **5/5 lulus** |
| `SAGE_HTTP_BASE_URL=http://127.0.0.1:3101 SAGE_TEST_LOGIN=sage-history-qa-20261108 DATABASE_URL=postgresql://sage:<test-password>@127.0.0.1:55442/sage_hist01_fresh node node_modules/tsx/dist/cli.mjs scripts/test-history-http.ts` | Endpoint riwayat dengan session, tanpa session, filter, query dan detail | **5 pemeriksaan lulus** pada server Next.js lokal |
| Smoke browser Chromium headless (Playwright 1.64.1) terhadap server lokal di port 3101 | Render history, cari repository, empty search/reset, navigasi detail, sembilan label tahap, tanpa error browser | **6 pemeriksaan lulus** |

Integrasi memakai PostgreSQL 17 disposable, port loopback 55441, database `sage_hist01_fresh`, dan `tmpfs`; tidak menyentuh database aplikasi. Fixture membuat dua pemilik dan 22 analysis, lalu menghapus semua record sesudah pengujian. Setelah cleanup, jumlah baris `Analysis`, `User`, dan `Repository` masing-masing **0**. Container uji serta VM disposable dihentikan setelah pemeriksaan.

HTTP/browser memakai instance PostgreSQL 17 disposable kedua di port loopback 55442 dan server Next.js lokal `127.0.0.1:3101`. User/repository/analysis fixture dan session dibuat khusus untuk run ini; koneksi GitHub tiruan dienkripsi dengan key sementara. Tidak ada token provider nyata atau panggilan ke GitHub. Chromium membuka `/workspace/history`, mencari `acme/report-service`, menampilkan empty state untuk query tanpa hasil, menghapus filter, lalu membuka halaman detail dan memeriksa sembilan label tahap. Endpoint session mengembalikan 200; tidak ada console/page error. Session, koneksi, container, server, dan VM disposable telah dibersihkan atau dihentikan. Ini smoke test satu record berstatus `COMPLETED`, bukan coverage browser semua status.

Hasil yang diamati: halaman pertama mengembalikan 20 dari 22 record, halaman berikutnya mengembalikan 2 record tanpa overlap; filter repository, branch, SHA dan status bekerja; detail membentuk sembilan tahap dan mengembalikan `null` lintas pemilik. Unit handler memeriksa session, validasi parameter, no-store dan 404. Tes UI memeriksa mesin state/history dan polling, termasuk respons usang dan pemulihan cursor.

## Batas bukti

Smoke browser mencakup satu record completed dan navigasi ke halaman detail/progres; browser tidak menjalankan Graph, tidak membuat run queued/running/failed, dan tidak menghubungi GitHub. Status/filter, cursor, SHA search, detail sembilan tahap dan owner isolation dibuktikan terpisah lewat PostgreSQL/HTTP serta suite unit. UI error network dan empty-history tanpa record sama sekali belum menjadi bagian smoke browser ini. QA-02/QA-03 tetap punya cakupan sendiri. Bukti HIST-01 kini mencakup query, handler, PostgreSQL, HTTP, dan browser; issue #22 sudah ditutup setelah review acceptance. Pengujian browser tambahan untuk lima skenario SRS, bahasa source, empty history, dan retry dicatat di [BDD Sprint 2](BDD_SPRINT2.md).
