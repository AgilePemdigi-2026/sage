# Pemeriksaan HIST-01 — riwayat analysis per pengguna

Tanggal: 8 November 2026, Asia/Jakarta. Issue [#22](https://github.com/AgilePemdigi-2026/sage/issues/22). Base: `d553d32b08c2e60ac3b3f303a54b8947f46a3924`. Paket ini mencatat pemeriksaan query, handler, state UI, dan isolasi PostgreSQL untuk implementasi history yang sudah tersedia.

Runtime tes: Node.js 24.11.0, TypeScript/tsx dari lockfile repository, PostgreSQL 17. Nama database QA dibatasi oleh integration guard `sage_hist01_fresh`.

## Pemeriksaan yang dijalankan

| Command | Expected | Actual |
| --- | --- | --- |
| `node node_modules/tsx/dist/cli.mjs --test tests/history.test.ts tests/history-handlers.test.ts tests/history-ui.test.ts` | Cursor/filter, autentikasi dan validasi handler, format/status, state pencarian/paginasi dan polling detail | **23/23 lulus**, 0 gagal/skip |
| `DATABASE_URL=postgresql://sage:<test-password>@127.0.0.1:55441/sage_hist01_fresh npm run migrate --workspace @sage/database` pada PostgreSQL 17 baru | Semua migrasi berjalan pada database kosong yang diizinkan | **PASS**, seluruh migrasi sukses |
| `SAGE_HISTORY_TESTS=1 DATABASE_URL=postgresql://sage:<test-password>@127.0.0.1:55441/sage_hist01_fresh npm run test:history:integration` | Query owner-scoped, pencarian, filter status, cursor stabil, detail 9 tahap dan isolasi pemilik | **5/5 lulus** |

Integrasi memakai PostgreSQL 17 disposable, port loopback 55441, database `sage_hist01_fresh`, dan `tmpfs`; tidak menyentuh database aplikasi. Fixture membuat dua pemilik dan 22 analysis, lalu menghapus semua record sesudah pengujian. Setelah cleanup, jumlah baris `Analysis`, `User`, dan `Repository` masing-masing **0**. Container uji serta VM disposable dihentikan setelah pemeriksaan.

Hasil yang diamati: halaman pertama mengembalikan 20 dari 22 record, halaman berikutnya mengembalikan 2 record tanpa overlap; filter repository, branch, SHA dan status bekerja; detail membentuk sembilan tahap dan mengembalikan `null` lintas pemilik. Unit handler memeriksa session, validasi parameter, no-store dan 404. Tes UI memeriksa mesin state/history dan polling, termasuk respons usang dan pemulihan cursor.

## Batas bukti

Suite UI di atas menjalankan mesin state dengan fetch terkontrol, bukan browser terhadap halaman yang dirender. `scripts/test-history-http.ts`, server web, sesi login nyata, GitHub provider dan navigasi browser tidak dijalankan pada paket ini. Halaman graph/dokumen dan ekspor tetap dibuktikan pada issue masing-masing. Karena itu, laporan ini **bukan** fresh-run acceptance seluruh T-HIST-01 atau QA-02/QA-03, dan issue #22 tetap terbuka sampai integrasi HTTP/browser dan review pemilik paket diterima.
