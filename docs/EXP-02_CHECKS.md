# Verifikasi ekspor PDF EXP-02

Issue [#21](https://github.com/AgilePemdigi-2026/sage/issues/21), SAGE-FR-EXP-05/07/08/09/10, APP-11, NFR-09; T-EXP-02 dan T-EXP-03. Base `4a0c7a7f7e9ed122fd3226d3ddd512693e1aa4f2`. Pengiriman: Valentina (`liliks13`); review/merge: Iltizam (`iltizamhasan3`).

## Perilaku

PDF dibuat dari ADD canonical yang sama dengan tampilan dokumen dan Markdown. Format memiliki record deduplikasi sendiri, memakai antrean ekspor durable yang sama, serta download privat dengan pemeriksaan ukuran/checksum. Retry tetap mempertahankan dokumen, format dan versi renderer; hasil analisis tidak dianalisis ulang.

PDF memuat katalog, diagram struktur, UML, evidence, metadata snapshot dan keterbatasan. Diagram besar memakai overview serta detail bertumpang tindih; batas renderer gagal eksplisit agar fakta tidak dipotong diam-diam. Label repository diperlakukan sebagai teks, bukan HTML/URL bebas.

## Menjalankan verifikasi

Gunakan Node 24 dengan dependency lockfile dan Prisma client yang sudah dibuat. `npm run check` mencakup lint, typecheck, unit/integrity tests; `npm run build` mengompilasi web production.

`npm run test:pdf:integration` memerlukan `SAGE_PDF_TESTS=1` dan database disposable bernama tepat `sage_pdf21`. `npm run test:pdf:live` memakai database yang sama, web production serta consumer worker aktif, `AUTH_BASE_URL`/`SAGE_PDF_BASE_URL`, `CREDENTIAL_ENCRYPTION_KEY` lokal, `STORAGE_ROOT` privat kosong, dan `SAGE_PDF_ARTIFACT_DIR` baru. Jangan arahkan pengujian fixture ini ke database/storage produk. Pengujian Markdown terpisah memakai guard `SAGE_EXPORT_TESTS=1` dan database `sage_export20`.

Untuk inspeksi lokal, ekstrak teks menggunakan `pdftotext`, render semua halaman memakai `pdftoppm -png`, lalu bandingkan hasil dengan `expected-document.json` yang disimpan runner browser. Verifikasi teks tidak menggantikan pemeriksaan visual.

## Verifikasi

- Build awal: `npm run db:generate`, `npm run check`, `npm run build` lulus di image QA Node 24.22.0; pemeriksaan awal memuat 329 main tests dan 8 data tests. Pada source akhir, seluruh main/data tests dan build production dijalankan ulang: **332/332 main tests dan 8/8 data tests lulus**. Lint terarah, full TypeScript, dan 21 focused export tests juga lulus di container dengan dependency lengkap.
- Dua database disposable memisahkan integrasi PDF (`sage_pdf21`) dan regresi Markdown (`sage_export20`): masing-masing **1/1 integrasi PostgreSQL lulus** tanpa skip.
- Next production, consumer worker produk, PostgreSQL dan Chromium nyata: **14 kelompok PDF** dan **20 kelompok regresi Markdown lulus**, viewport 390/1440 px, nol page errors/request provider/request off-origin. Guard pemilik/akun, CSRF, format, dedup lintas format, attachment/checksum/storage privat, pergantian akun ketika body masih tertunda, archive rusak, lease recovery dan retry diuji. Hash hasil analisis/CKG/ADD tetap.
- Parser independen: `python3 scripts/check-pdf-export.py artifacts/pdf-21/2026-10-27-run5` memakai pdfplumber dengan text-flow agar baris dalam kolom tabel dibaca dalam urutan konten; objek atribut JSON diperiksa dari kolom tabel, termasuk fragmen yang berlanjut ke halaman berikutnya. Negative control dengan atribut canary yang tidak ada ditolak. Metadata, 20 ID node, 38 nama unik, 6 signature, 7 objek atribut unik, 27 ID edge, semua evidence/range yang diharapkan, serta limitation cocok. Canary source/URL dan replacement glyph tidak muncul; teks PDF retry sama.
- Poppler merender **40/40 halaman** ke PNG pada 90 dpi. Seluruh 40 halaman sampel akhir diperiksa visual, termasuk overview/detail dua diagram dan kelanjutan tabel pada batas halaman. Kotak abu-abu UML sudah hilang; header/footer, penomoran, tabel dan diagram tidak bertumpuk. Area pada batas tile dilanjutkan di tile tetangga dan overview menampilkan diagram lengkap. File akhir 328.449 byte, SHA-256 `0e893293ec3b66ba22171999d65d3238a3300180573a720292a7989f444741fc`.
- Worker dengan production dependencies berhasil mengimpor handler PDF; tidak bergantung pada dev dependency dari web.

Lingkungan: Node 24.22.0, npm 11.17.0, Next 16.4.2, Prisma 7.10.1, PostgreSQL 17.11, Playwright 1.64.1, Chromium 156, Mermaid 12.2.0; Poppler 26.05.0 untuk render PNG. Log dan file besar tersimpan di folder ignored `artifacts/pdf-21/`; ringkasan aman/hash ada pada `docs/evidence/EXP-02-2026-10-27.json`.

## Temuan dan pengujian ulang

Run awal menolak dekorasi SVG Mermaid (`filter`, gradient) sebelum file READY. Renderer sekarang membatasi gradient lokal dan memvalidasi lalu membuang drop shadow dekoratif; script, event, href dan URL eksternal tetap ditolak. Overview root markup serta normalisasi kode error browser diperbaiki.

Run browser berikutnya lulus tetapi menghasilkan 156 halaman karena evidence/card berulang. Shared register mempertahankan semua fakta dan evidence dengan referensi deterministik sehingga sampel menjadi 39 halaman. Pemeriksaan visual berikutnya mendapati latar label UML memanjang; perubahan ukuran SVG harus dibatasi pada opening tag root agar ukuran rect anak tidak tertimpa. Run akhir mengulang 332 main tests, 8 data tests, build, dua integrasi database serta seluruh 34 kelompok browser/API. Pemeriksaan teks dan visual final lulus. Token underscore Mermaid dinormalisasi hanya pada salinan source PDF sebelum rendering; pengujian aktual memakai path literal `src/export-contract#95;.ts` untuk membuktikan underscore hasil escaping dan teks literal `#95;` tetap berbeda. Pemeriksa teks diagram dan paired regression lulus.

Batas renderer: 50.000 karakter/byte Mermaid per diagram, 500 node dan 500 edge per diagram, 24 tile detail per diagram, SVG 4 MiB, HTML 12 MiB, file PDF 32 MiB, dan deadline rendering 45 detik. Melewati batas menghasilkan kegagalan eksplisit; ini bukan jaminan kapasitas maksimum pada setiap laptop.

## Batas bukti

Fixture memakai analyzer nyata dan hasil terminal yang disimpan langsung; bukan login OAuth GitHub live atau run pipeline sembilan tahap baru. Fault archive/lease dan respons tertunda dilabeli sebagai kasus terkontrol. Penerimaan analyzer lintas repository serta signoff oracle tetap mengikuti QA-01/QA-02.
