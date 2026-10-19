# Pemeriksaan frontend Figma Sprint 1

Tanggal: 20 Oktober 2026. Paket UI-02 (#59, Valentina) dan UI-03 (#60, Zarra). Sumber desain: [Data Mockup SAGE](https://www.figma.com/design/OrNk1caXIrsdC0tG4axfSA/Data-Mockup-SAGE?node-id=47-2).

## Scope dan asal data

Figma MCP dipakai untuk membaca halaman Screens, metadata, konteks layout, dan screenshot landing (47:4), repository (57:102), progres (65:875), history (79:1222), graph (117:2116), serta dokumen (119:7425), termasuk varian error/empty/source/diagram. Token navy/teal, Inter/JetBrains Mono, kartu, header, dan hierarki diadaptasi ke Next.js. Ikon SVG statis dari respons Figma disimpan lokal dengan dimensi intrinsik pada manifest; aset yang tidak dipakai dikeluarkan.

Landing, login, workspace, dan pemilihan repository mempertahankan kontrak autentikasi serta API nyata yang sudah ada. Progress/history/graph/dokumen tersedia di `/preview/*` dan selalu diberi label data contoh. Sembilan tahap pada progres adalah skenario ilustratif; tidak menjalankan pekerjaan atau menulis status. Consumer pipeline tetap belum aktif.

Konten teknis dinamis memakai fixture `contoh/report-service`, branch `fixture`, commit `a136f9c488b04116ac641732e451d2c4a8b6291e`: 3 file, 10 node, 9 relasi, dengan source bytes/evidence yang divalidasi kontrak CCM. Data ini menggantikan ilustrasi OrderService 37 node/88 relasi pada Figma; angka dan fakta ilustrasi tidak diperlakukan sebagai hasil analisis. Diagram diproyeksikan dari fixture yang sama. Markdown adalah unduhan contoh lokal; PDF produk belum tersedia.

## Verifikasi

Run aktual lulus pada 20 Oktober 2026 (Asia/Jakarta):

| Pemeriksaan | Hasil |
| --- | --- |
| `npm run check` | Lint/typecheck, 165 tes utama dan 8 tes data lulus |
| Build Docker web/worker | Lulus; standalone web menyertakan folder `public` |
| `npm run test:figma:ui` | Lima viewport lulus: 360/390/768/1024/1440 px; enam layar, sembilan stage/icon, state, query AND kategori, zoom/fit/fokus, source dialog Tab/Escape/restore, tab dokumen, byte Markdown, PDF disabled, dan konteks analysis tidak cocok |
| Salin SHA | Handler diuji memakai clipboard write double; SHA lengkap sesuai snapshot |
| `SAGE_TEST_FIXTURE_USER=1 npm run test:target:ui` | Lima viewport lulus: search, selection, slash branch, validasi, reset stale target, retry/error/empty, tanpa overflow atau error JavaScript |
| `npm run smoke` | 16 pemeriksaan lulus |
| Review kode independen | Tidak ada temuan material; auth/target contracts, cleanup fixture, provenance diagram dan deployment aset ditinjau |
| Pemeriksaan dokumentasi/aset | 72 ID SRS unik, tautan relatif valid, manifest SVG sesuai dimensi root, `git diff --check` lulus |

Screenshot desktop dan mobile ditinjau langsung, termasuk graph, catalog, struktur dan UML. Temuan yang diperbaiki: aset SVG 404 pada image standalone, ikon selesai yang belum terpetakan, ukuran heading dokumen, serta pembagian kolom graph. Diagram/source pada layar kecil memakai scroll internal agar konten tetap dapat ditelusuri. Kontras sampel teks/background: navy/putih 16,51:1; muted/putih 6,12:1; navy/teal 7,69:1; notice 8,80:1; error 7,40:1. Ini pemeriksaan pasangan warna utama, bukan sertifikasi aksesibilitas seluruh produk.

 Skrip replay: `npm run check`, `npm run test:figma:ui`, `npm run test:target:ui`, `npm run smoke`. Browser memakai Chromium dalam Docker. Pengujian target UI memakai identitas fixture sementara dan sesi valid pada database lokal (`SAGE_TEST_FIXTURE_USER=1`), dihapus setelah run. Respons provider dikontrol; pemeriksaan ini tidak mengulang login/provider live atau acceptance pipeline penuh.

Laporan JSON dan screenshot per viewport disimpan lokal di `artifacts/ui-02` dan `artifacts/rep-01` (diabaikan Git). Independent review memeriksa auth/target regression, konteks analysis, provenance diagram, serta focus dialog; tidak menemukan masalah material sebelum pemeriksaan browser.

## Batas penerimaan

UI-02/UI-03 menutup fase frontend saja. ANA-07, GRAPH-01/02/03, DOC-01/02, HIST-01, EXP-01/02 dan QA-03 tetap membutuhkan hasil analisis nyata serta verifikasi produk pada Sprint 2. Status fixture bukan acceptance fitur tersebut.
