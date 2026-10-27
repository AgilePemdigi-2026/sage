# Verifikasi ekspor Markdown EXP-01

Issue [#20](https://github.com/AgilePemdigi-2026/sage/issues/20), SAGE-FR-EXP-06/07/08/09/10, APP-11, NFR-09; T-EXP-01 dan T-EXP-03. Base implementasi `263bed6e8dbb068a7529e6f8c9ed68bc61ea117e`. Pengiriman: Zarra (`zarrrafirdaus`); review/merge: Iltizam (`iltizamhasan3`).

## Perilaku

File Markdown mandiri memuat Interface Catalog, Software Engineering Diagram, UML Class Diagram, evidence, konteks snapshot dan keterbatasan. Source Mermaid serta data relasi tersedia dalam file; viewer yang tidak mendukung Mermaid tetap dapat membaca source dan bukti tekstual. Tidak ada ketergantungan gambar/path lokal atau URL aset eksternal.

Ekspor memakai hasil canonical tersimpan; proses ekspor tidak menjalankan analisis ulang dan tidak mengubah graph/dokumen. Worker ekspor memiliki antrean terpisah dengan status QUEUED/GENERATING/READY/FAILED. Publikasi file memeriksa hash dan storage sebelum READY; unduhan tetap memeriksa pemilik dan integritas. Deduplikasi dan retry mengikat dokumen serta renderer yang sama.

## Verifikasi

Verifikasi 27 Oktober 2026: PASS pada content commit `1f31f875d172081f407781eb13cb8413bdc456f7`. Commit berikutnya hanya dokumentasi/bukti.

- Lint, typecheck root/web, 322 tes utama, 8 tes data dan production build lulus pada image QA berbasis dependency terkunci yang sudah tersedia.
- Satu tes integrasi PostgreSQL 17.11 lulus, mencakup concurrent enqueue/claim, archive rusak, retry, unduhan checksummed, fencing claim lama, recovery WORKER_INTERRUPTED serta isolasi antrean ANALYSIS.
- Dua puluh kelompok Playwright/API lulus dengan server Next production dan consumer worker nyata; nol page errors, nol request provider/off-origin. Viewport produk 390 dan 1440 px.
- Tombol create/download/retry benar-benar memanggil HTTP. Request ganda browser/API menghasilkan satu ekspor/job. Unduhan browser mobile, desktop, API dan setelah retry identik dengan renderer canonical: 126.877 byte, SHA-256 `d745a0a14ee0cf9aeb9d61fb670495aa911dac7e4ab2d82152386aa22e68cccc`.
- Fixture lease aktif merupakan pengatur waktu khusus tes. Digest archive sengaja dirusak setelah enqueue, consumer nyata gagal aman sebagai EXPORT_FAILED, lalu digest dipulihkan dan retry memakai ID/hash dokumen sama. Status/result hash analisis, CKG dan ADD tetap identik.
- Respons READY dan attachment nyata sengaja ditunda saat akun berganti; UI membuang kontrol lama dan pemeriksaan session setelah body menolak unduhan akun lama.
- File unduhan dibuka di Chromium offline dengan parser Marked 16.4.2 dari dependency Mermaid terkunci, CSP ketat dan tanpa plugin Mermaid. Ketiga artefak, dua source Mermaid lengkap serta metadata/evidence terbaca; tidak ada elemen HTML aktif atau aset/link eksternal. Newline pembungkus code fence tetap diperhitungkan saat membandingkan source.
- Visual QA memeriksa kontrol ekspor mobile, wrapping hash dan viewer bersih. Import modul ekspor pada image dengan dependency runtime worker produksi juga lulus; modul tidak bergantung pada web source yang tidak dikirim ke image worker.

Laporan final lokal: `artifacts/export-20/2026-10-27-run4/report.json`; unduhan Markdown, viewer HTML offline serta screenshot berada di folder yang sama dan diabaikan Git. Fingerprint aman tersimpan pada [evidence JSON](evidence/EXP-01-2026-10-27.json). Container, database/volume sementara dan network QA telah dibersihkan.

Command aktual build: `npm run db:generate`, `npm run check`, `npm run build`. Runner final menjalankan lint untuk skrip browser/tes integrasi, `tsc --noEmit`, `npm run db:migrate`, `node --import tsx --test --test-concurrency=1 tests/exports.integration.ts`, server standalone, consumer `apps/worker/src/index.ts` dan `node --import tsx scripts/test-markdown-export.ts`. Alias repository: `npm run test:exports:integration` dan `npm run test:exports:live`. Keduanya wajib opt-in `SAGE_EXPORT_TESTS=1`, database disposable `sage_export20`; browser membutuhkan STORAGE_ROOT sementara kosong/0700, CREDENTIAL_ENCRYPTION_KEY khusus tes yang sama dengan server, serta SAGE_EXPORT_BASE_URL. Jangan gunakan database aplikasi.

Riwayat perbaikan tes disimpan: build pertama berhenti pada lint dua interface kosong; run integrasi awal memakai ID CCM lama setelah mengganti snapshot sehingga fixture diubah untuk menjalankan analyzer nyata. Run browser awal memperbaiki seed blocker menjadi transaksi dengan queueSequence, asumsi filename menjadi short SHA tujuh karakter, serta perbandingan newline code fence pada viewer. Assertion tidak dilewati; run final menjalankan semua kelompok ulang.

Lingkungan: Node 24.22, npm 11.17.0, Next 16.4.2, Prisma 7.10.1, PostgreSQL 17.11, Mermaid 12.2.0. QA memakai image dependency lokal terverifikasi lalu menyalin source saat ini, bukan clean install jaringan dari nol. Skrip/tes integrasi final dipasang read-only dan lulus lint/typecheck sebelum runtime.

## Batas bukti

Fixture pengujian menggunakan output analyzer nyata yang disimpan langsung sebagai hasil terminal. Ini menguji ekspor dari hasil tersimpan, bukan OAuth GitHub live atau run baru pipeline sembilan tahap. Kasus fault/penundaan terkontrol dilabeli terpisah. Ekspor PDF memiliki bukti terpisah pada [EXP-02_CHECKS](EXP-02_CHECKS.md); signoff oracle analyzer mengikuti QA-01.
