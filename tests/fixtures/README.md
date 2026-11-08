# Seed fixture QA-01

Source dibuat khusus untuk pengujian lokal dan tidak berasal dari repository private. `manifest.json` mencatat SHA-256, ukuran byte, hasil syntax yang diharapkan, serta oracle minimum yang dipilih dari pembacaan source secara manual. Setiap oracle mempertahankan `path`, `kind`, `target`, `snippet`, dan `evidence`; `role` menandai fakta sebagai `declaration`, `reference`, atau `context`. Lokasi byte memakai UTF-8, sedangkan baris/kolom memakai baris berbasis LF dan kolom karakter Unicode mulai dari 1. Expected fact tidak dihasilkan dari parser yang sedang diuji.

Bagian `languageCoverage` mensyaratkan sedikitnya satu declaration dan satu reference untuk JavaScript, TypeScript, dan PHP. `limitations` menunjuk ke oracle reference unresolved yang sama dan menyimpan alasan source-only; contohnya `import(name)` tidak menentukan satu path module dan pemanggilan melalui receiver umum tidak membuktikan implementasi konkret. Metadata ini menjelaskan batas fixture kecil, bukan klaim dukungan lengkap suatu bahasa.

Jalankan `npm run fixtures:verify` untuk memeriksa struktur manifest, path aman, cakupan per bahasa, hash, snippet, batas UTF-8, serta posisi. `npm run smoke` di worker menambah pemeriksaan syntax parser, diagram, dan PDF. Keduanya belum membandingkan CCM/graph semantik; ANA-03/04/05 masih terbuka.

File mengandung `throw`, konfigurasi executable, dan script Composer sebagai canary. Seluruh source diperlakukan sebagai data; jangan menjalankan file atau package manager dari folder fixture. Composer hanya dipakai untuk dependency adapter tepercaya pada `packages/analyzer-php/`.

Review source tim dicatat pada 8 November 2026 (`TEAM_REVIEWED`, `reviewedBy: iltizamhasan3`) berdasarkan [review oracle QA-01](../../docs/QA-01_ORACLE_REVIEW.md). Ini menerima akurasi oracle source dan evidence yang tercakup; bukan klaim seluruh semantik adapter diterima. Verifier integritas tetap melaporkan `semanticAcceptance: NOT_RUN`. Batas kapasitas dekat ceiling dan pengujian OOM tetap belum tercakup.

Bukti paket minimum dan batas review tersedia pada [pemeriksaan QA-01-S1](../../docs/QA-01-S1_CHECKS.md).
