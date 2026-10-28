# EXP-03 — PDF compact dengan proyeksi yang dibatasi

Issue [#101](https://github.com/AgilePemdigi-2026/sage/issues/101), pelaksana Rizqy; review/merge Iltizam. Scope PDF saja: canonical CKG/ADD, Markdown lengkap, ownership dan mekanisme antrean tetap memakai kontrak sebelumnya. Persiapan Coolify bukan deployment.

## Reproduksi

Pengukuran sebelum perbaikan menggunakan image worker lokal sebelumnya, satu container offline baru per corpus, 1 CPU, 2 GiB tanpa swap, PID 256, shm 256 MiB, tmpfs 256 MiB dan supervisor 180 detik. Dua manifest yang dipin sama dengan PERF-02. Keduanya gagal `PDF_DIAGRAM_SOURCE_LIMIT_EXCEEDED` pada tahap PDF; adapter, canonical dan Markdown selesai. Tidak ada OOM atau kegagalan cleanup. TS: 12 file / 53.099 byte, 799 node / 982 relasi. PHP: 24 file / 43.704 byte, 352 node / 448 relasi. Bukti mentah lokal: `artifacts/exp03/baseline.json`.

Penyebab: batas renderer diperiksa pada diagram canonical lengkap sebelum tampilan manusia dibuat. PDF memerlukan proyeksi tampilan terpisah agar sesuai satu diagram A4.

## Kontrak proyeksi

Proyeksi PDF memilih simbol serta relasi yang bersumber dari model yang sama, secara deterministik. Struktur memilih komponen terhubung terbesar, lalu tetangga berdasarkan kelompok relasi berbeda dan urutan source sebagai pembeda; UML mengutamakan class/interface nyata serta target Unresolved yang terhubung. Prioritas ini menunjukkan keterhubungan source. Isi yang tidak ditampilkan, anggota yang diringkas serta label yang dipendekkan dijelaskan kepada pembaca. Ringkasan bukan model canonical baru, bukan klaim seluruh repository atau relasi runtime.

Batas Mermaid, SVG, HTML, PDF, jaringan offline, sanitasi dan deadline tetap berlaku pada input renderer. Full-document size cap tetap berlaku sebelum pembuatan proyeksi. ID/hash teknis tetap berada di Markdown. Versi renderer berubah agar ekspor lama tidak dideduplikasi sebagai hasil tampilan baru.

Renderer **2.1.0** membatasi struktur pada 8 node terlihat, 12 kelompok relasi dan 500 catatan relasi source; UML maksimal 6 classifier/target dengan 3 anggota per classifier. Kelompok mempertahankan endpoint, kind dan status; pengelompokan struktur mengalihkan tampilan anggota ke pemiliknya. Catatan anggota tetap utuh untuk evidence, sedangkan batas 500 node renderer menghitung mapping kotak yang benar-benar digambar. Katalog maksimal 30 simbol, kontrak 400 karakter dan 6 anggota per ringkasan. Nama/path/signature panjang memakai pemendekan eksplisit; Markdown tetap memuat nilai penuh.

## Verifikasi

[Bukti terstruktur](evidence/exp03-compact-pdf-2026-10-28.json) memuat keenam sampel, replay, perbandingan hash, versi/image dan batas bukti. Pengukuran akhir dilakukan berurutan setelah stack QA dibersihkan, pada batas container yang sama dengan baseline; aplikasi produk tetap berjalan dan stack QA sudah berhenti. Lingkungan ARM64 Colima lokal, bukan x86_64 server bersama.

| Corpus | Hasil PDF | Core elapsed | Peak charged memory | Ukuran PDF |
| --- | --- | --- | --- | --- |
| TS menengah | 3/3 pass | 2,24–11,25 detik | 500,2–623,8 MiB | 79.289–79.305 byte |
| PHP menengah | 3/3 pass | 2,41–3,19 detik | 478,4–484,3 MiB | 89.560–89.705 byte |

Tidak ada OOM, timeout atau cleanup failure pada keenam sampel akhir. Peak charged mencakup Node/PHP/Chromium dan page cache, bukan hanya heap; CPU delta dimulai setelah import modul. Core elapsed adalah jumlah fase yang diukur, bukan waktu keseluruhan container. Hash input/CCM/CKG/ADD/Markdown cocok dengan baseline pada seluruh iterasi. PDF berbeda metadata antar render sehingga hash/ukuran PDF tidak dijadikan equality replay.

- Node 24: lint, typecheck, **375 unit test**, 8 database foundation test dan Next.js production build pass; tidak ada fail/skip. Build Docker standar target `web` dan `worker` juga lulus pada ARM64 lokal, termasuk pengulangan check/build dalam Dockerfile. Image ini belum dipublish dan tidak membuktikan linux/amd64 atau deployment Coolify.
- PostgreSQL disposable: 2 integrasi Markdown dan 1 integrasi PDF pass, meliputi deduplikasi, penyimpanan privat, checksum, lease fencing, stale-writer cleanup dan retry.
- Next/worker/Chromium nyata: PDF dan Markdown pada 390px/1440px pass; owner/foreign account, pergantian akun saat transfer attachment, format/header/checksum, archive corruption, retry nyata dan pemulihan lease diuji. Tidak ada request provider/off-origin atau uncaught page error. Sesi/provider sintetis, bukan login GitHub baru.
- PDF corpus TS: 6 halaman; PHP: 5 halaman. Semua halaman A4 landscape, tanpa image raster. Seluruh 11 halaman dirender ke PNG dan diperiksa; setiap diagram satu SVG utuh, tanpa potongan A1/A2. Teks label diagram dalam area figure sekitar 8,52/10,39 pt (TS struktur/UML) dan 9,56/8,75 pt (PHP); footer 6 pt dilaporkan terpisah. Pemeriksaan visual tidak menemukan pemotongan/overlap tabel atau diagram. Hash canonical/Markdown sebelum/sesudah render tetap sama.
- Review PR menemukan 602 record evidence method dapat diringkas menjadi dua kotak, tetapi masih terkena batas node. Batas kini menghitung mapping hasil proyeksi yang baru dibuat, bukan mapping tersimpan dari input; regresi mempertahankan 300 edge source asli dan tetap menolak 501 kotak.

Bukti mentah lokal berada di `artifacts/exp03`: baseline, resource sequential final, inspeksi dan PDF corpus, laporan browser PDF/Markdown, serta log build/QA. Dua kegagalan awal berasal dari harness (file Next generated read-only dan SQL migrasi image QA lama tidak terpasang); diperbaiki dengan snapshot source lengkap dan database disposable baru. Percobaan resource yang sempat bersamaan dengan QA dihentikan dan dikecualikan; partial report menyimpan satu kegagalan PDF kecil `PDF_RENDER_FAILED`. Tidak dianggap sebagai pass atau disembunyikan; hasil final menengah diulang setelah QA selesai.

## Batas penerimaan

Source penuh tetap dibatasi 12 MiB pada renderer. Repository lebih besar, label sangat kompleks atau guard lain masih dapat menghasilkan kegagalan eksplisit. Pemilihan subset terhubung bukan gambaran keseluruhan atau penentuan layanan bisnis. Pengukuran tidak melintasi seluruh pipeline sembilan tahap, queue, persistence, jaringan GitHub atau concurrent users. Kuota runtime tetap seperti sebelumnya; peak 624 MiB bukan alasan mengurangi cap worker 2 GiB. Tidak ada deployment Coolify, publish registry, OAuth baru atau acceptance kapasitas server bersama.

Saat QA/build lokal berat, worker produk lama sempat restart dan mencatat `ENVIRONMENT_UNAVAILABLE`; health kemudian pulih. Penyebab spesifik belum diketahui. Temuan terpisah [OPS-01 #104](https://github.com/AgilePemdigi-2026/sage/issues/104), ditugaskan ke Iltizam, perlu diagnostik aman dan uji ketahanan sebelum menyatakan kapasitas server bersama. Ini tidak mengubah hasil enam sampel PDF medium yang diukur setelah QA berhenti.
