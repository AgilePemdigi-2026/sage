# Bukti fondasi ENV-01 dan seed QA-01

Tanggal: 18 Oktober 2026, Asia/Jakarta. Scope perubahan: fondasi runtime lokal, parser syntax probe, renderer sample tepercaya, serta integritas seed fixture. Acuan baseline: `9689776a1d16224e7ff117fa442d168c80219334`; commit implementasi dan hasil review ditautkan pada PR terkait [ENV-01 #2](https://github.com/AgilePemdigi-2026/sage/issues/2) / [QA-01 #4](https://github.com/AgilePemdigi-2026/sage/issues/4).

## Lingkungan dan versi

Host pemeriksaan: macOS arm64 dengan RAM fisik 8 GiB. Container berjalan pada Colima profile `sage`, 2 CPU dan RAM VM 4 GiB. Dockerfile memakai digest multi-architecture; run pada arsitektur lain tetap harus diverifikasi.

| Komponen | Versi/pin |
| --- | --- |
| Node | 24.22.0; digest image pada Dockerfile |
| npm | 11.17.0 |
| Next.js / React | 16.4.2 / 19.3.1 |
| TypeScript Compiler API | 5.9.3 |
| Tailwind | 4.3.3 |
| Prisma / adapter pg | 7.10.1 |
| PostgreSQL | 17.11; digest image pada Compose |
| PHP | 8.4.26; digest image pada Dockerfile |
| nikic/PHP-Parser / Composer | 5.9.0 / 2.9.7 |
| Playwright / Mermaid | 1.64.1 / 12.2.0 |

ESLint 9.39.5 dipin karena peer dependency plugin preset Next masih memakai ESLint 9. Upgrade tooling ditinjau ketika seluruh preset kompatibel; instalasi tidak memerlukan `--legacy-peer-deps` atau `--force`.

## Hasil pemeriksaan

| Pemeriksaan | Status | Batas kesimpulan |
| --- | --- | --- |
| Lint dan typecheck | PASS pada host dan build Linux | Runtime aplikasi diverifikasi pada Node 24.22.0 |
| Unit/integrity tests | PASS: 3 kasus | Parse source sebagai data, syntax invalid, hash/evidence Unicode/CRLF |
| Seed fixture | PASS: 15 file, 11 evidence span | Integritas oracle; semantic CCM/edge acceptance NOT_RUN |
| Build Docker bersih | PASS | Dua image berhasil dibangun dari VM baru; hasil hanya Linux arm64 |
| Readiness/migrasi/non-root | PASS | Migrasi exit 0; web/worker/db healthy; web/worker UID 1000 |
| Probe parser/renderer/PDF | PASS: 16 pemeriksaan | Sample tepercaya; PDF satu halaman A4, teks/diagram diperiksa |
| Browser lima viewport | PASS | 360/390/768/1024/1440 px; tanpa overflow horizontal atau page error |
| Persistensi setelah recreate | PASS | Marker database bertahan; hash PDF di storage identik |
| Database tidak tersedia | PASS | Health HTTP 503 aman; setelah recreate kembali 200 |

Ringkasan terstruktur, versi, hash source yang diuji, dan hasil aktual tersedia di [evidence JSON](evidence/ENV-01-2026-10-18.json). Pemeriksaan visual mencakup halaman awal 360/1440 px dan sampel PDF; penerimaan layout dokumen produk tetap berada pada EXP-02.

Percobaan awal gagal EIO saat ruang disk host/VM menipis. VM khusus setup yang belum berisi data aplikasi dihapus, image dipisahkan dari tooling pengembangan, dan run bersih diulang sampai seluruh pemeriksaan fondasi lulus. Cache build percobaan dibersihkan. Ini bukan bukti hardware minimum atau kapasitas repository nyata.

Command yang dapat direplay tersedia di [setup lokal](LOCAL_SETUP.md). Bukti runtime JSON, SVG/PDF, dan screenshot disimpan pada volume `/app/storage/environment`, lalu dapat disalin ke `artifacts/environment/` yang diabaikan Git. Waktu probe mencakup startup/runtime pada fixture kecil. Angka RSS pada report berasal dari proses Node runner dan tidak mencakup seluruh child process PHP/Chromium.

## Status scope berikutnya

QA-01 tetap terbuka: oracle belum direview tim, expected declaration/edge belum lengkap, benchmark repository representatif belum ada, dan fixture archive berbahaya/recovery belum selesai. Tidak ada klaim bahwa parser probe menghasilkan CCM atau resolver sesuai capability matrix.

Seluruh acceptance test produk T-GH/T-REP/T-ANA/T-GRAPH/T-DOC/T-EXP/T-HIST/T-DATA/T-UI/T-SEC/T-REL tetap NOT_RUN. Login nyata, private access, queue global, source isolation, analisis sembilan tahap, tiga artefak produk, serta export/history/delete masih memerlukan implementasi dan pengujian pada paket masing-masing.

Batas repository pada `config/analysis-limits.json` baru nilai awal dan belum diterapkan. Penetapan kapasitas/performa produk menunggu benchmark yang lebih representatif dan tidak diturunkan dari seed kecil.

## Tinjauan kapasitas Sprint 1

Fase pengerjaan tersisa 19-25 Oktober (tujuh hari kalender). Fondasi ENV-01 siap direview; jalur kritis berikutnya DATA-01 -> GH-01 -> GH-02/REP-01 -> REP-02, dengan queue/kontrak/fixture dapat disiapkan mengikuti dependensinya. Satu spike belum memberikan velocity untuk mengubah ukuran L/XXL menjadi hari atau menjanjikan semua paket Sprint 1 selesai. Jadwal tetap mengikuti sprint plan; estimasi ditinjau lagi dari hasil paket implementasi berikutnya, tanpa mencatat fitur yang belum ada sebagai selesai.
