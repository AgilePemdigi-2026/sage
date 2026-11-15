# UI-05 — Workspace nyata dan eksplorasi hasil

Issue: #105. Perubahan: tampilan nyata menggantikan mode pratinjau publik, konten terpusat pada lebar maksimum 1.200 px, graph jaringan, dokumen bertahap, dan alur repository ke analisis.

## Perilaku

- Route `/preview/*`, `/ui-preview`, dan `/graph-preview` dihapus (404). Fixture source-backed dipindahkan ke `tests/fixtures/ui`; komponen produksi tidak mengambil data fixture.
- Memilih repository public, private berizin, atau public pihak lain membuka langkah target. Fokus keyboard berpindah ke judul target; branch/commit tetap divalidasi dan analisis dimulai lewat tombol eksplisit.
- Progres memiliki indikator aktif dan waktu sejak diantrekan berdasarkan timestamp server. Waktu berhenti pada status terminal. Animasi loading dan interaksi tombol menghormati `prefers-reduced-motion`.
- Graph memakai jaringan node lingkaran berwarna, zoom/pan, dan sorotan tetangga. Nama lengkap tersedia lewat inspector dan picker keyboard. Filter jenis AST dibuka sesuai kebutuhan. Perhitungan layout terbatas; canonical graph tidak berubah dan budget mode 200 node/500 edge dipertahankan. Pilihan node pada Ikhtisar serta resize tidak mengatur ulang pan/zoom.
- Katalog dapat dicari menurut simbol, jenis, dan berkas. Katalog ditampilkan per lima item; relasi, anggota, evidence tambahan, dan mapping diagram per 10 item. Detail tertutup tidak memasang seluruh tabel ke DOM. Batasan dikelompokkan menurut tahap/alasan dengan path yang dibuka bertahap.
- Evidence membuka `github.com/owner/repo/blob/<commit>/file#Lx-Ly` dengan path yang di-encode serta validasi host, SHA, path, dan rentang baris. Tautan private tetap memerlukan izin GitHub; tautan tidak memberikan akses tambahan.
- Budget diagram diperiksa sesudah proyeksi manusia. Jika tampilan penuh melewati budget browser, layar mencoba ikhtisar terbatas dengan keterangan jumlah yang ditampilkan. Katalog dan evidence tetap lengkap melalui pagination. Sanitasi SVG, abort saat akun berubah, serta batas SVG 4 MiB tetap aktif.
- Isi canonical dan ekspor Markdown/PDF tidak diubah oleh perapian UI. Markdown tetap lengkap; PDF tetap ringkas pada A4.

## Verifikasi

Pemeriksaan 29 Oktober 2026 memakai Node 24 dan build Next produksi: ESLint, TypeScript, 381 tes unit, 8 tes fondasi database, serta `next build` lulus. Bukti lokal run berada di `artifacts/ui105` (diabaikan Git); laporan historis preview tidak dianggap sebagai bukti workspace saat ini.

Percobaan awal mengungkap selector lama yang tidak mengikuti langkah target baru, identitas repository fixture yang tidak sesuai snapshot, dan fixture progres `RUNNING` tanpa job/slot worker. Test diperbaiki tanpa melonggarkan aturan worker; probe waktu kini memakai `QUEUED` dan mengembalikan record terminal sesudah pemeriksaan. Assertion pencarian menunggu hasil render React. Assertion graph membuka rincian jumlah/filter terlebih dahulu dan memverifikasi hash pada API/metadata inspector, sesuai tampilan baca tanpa hash. Satu run browser terhenti saat container QA dijeda untuk menyimpan checkpoint image; build yang sama diuji ulang tanpa jeda tersebut.

Hasil browser yang lulus pada build produksi yang sama:

| Pemeriksaan | Bukti lokal | Hasil |
| --- | --- | --- |
| Landing/login, asset, overflow, enam route preview 404 pada 360/390/768/1024/1440 px | `environment/report.json` | Lulus |
| Repository public/private/pihak lain, perpindahan fokus target, validasi branch/commit dan retry pada lima viewport | `repository/report.json` | Lulus |
| Cookie/session nyata dengan metadata provider terkontrol, respons akun lama tertunda dan pergantian akun saat target aktif pada lima viewport | `accounts/report.json` | Lulus |
| Katalog lima baris, pencarian/pagination, evidence SHA+baris, graph zoom/fit, elapsed aktif/terminal dan reduced motion pada 390/1440 px | `live/report.json` | Lulus |
| POST/worker/unduhan PDF dan Markdown nyata, checksum/deduplikasi, ownership/account switch, gangguan integritas dan retry/lease | `live/report.json` | Lulus |
| Graph/source API nyata, 25 pemeriksaan termasuk lima viewport, filter keyboard, inspector, canvas click, source/Escape, integritas dan respons akun tertunda | `graph/report.json` | Lulus |

Screenshot katalog desktop/mobile, jaringan mobile dan progres desktop diperiksa secara visual. Graph memakai layout jaringan berwarna, katalog memiliki whitespace dan lebar baca terpusat, serta waktu progres tampil bersama indikator aktif. Tata letak jaringan dihitung pada node yang diizinkan budget; label ringkas dapat diperbesar dan nama lengkap dibaca melalui inspector/picker.

Suite utama: `npm run check`, `npm run build`, `scripts/browser-smoke.ts`, `scripts/test-target-ui.ts`, `scripts/test-account-ui.ts`, `scripts/test-pdf-export.ts`, dan `scripts/test-live-graph.ts`. Suite live memakai database PostgreSQL disposable, sesi sintetis, dan archive source fixture. GitHub/provider hanya dikontrol pada suite pemilihan repository; pengujian ini tidak mengklaim login OAuth GitHub baru atau eksekusi pipeline sembilan tahap untuk repository nyata.

Perintah legacy `test:figma:ui`, `test:ui`, `test:graph`, dan `test:ui:baseline` sekarang hanya menjalankan smoke landing/login dan route pratinjau 404. `test:browser` menggabungkan empat suite: landing, autentikasi/workspace, target repository, serta isolasi akun. Graph/dokumen/ekspor mempunyai suite live terpisah.
