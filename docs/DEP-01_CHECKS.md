# DEP-01 — Persiapan Coolify dan pemeriksaan operasional

Issue [#99](https://github.com/AgilePemdigi-2026/sage/issues/99), pelaksana Rizqy. Mendukung #24/#26 tanpa menutup acceptance release atau mengubah deployment server. Scope: file Compose produksi, preflight/smoke read-only dan panduan operator. [Bukti agregat](evidence/dep01-local-readiness-2026-10-28.json).

## Konfigurasi

compose.coolify.yaml berdiri sendiri, memakai image web/worker digest immutable yang disediakan operator. Migrasi memakai image worker sama, menunggu db healthy, dan harus exit 0 sebelum web/worker. PostgreSQL 17 dipin digest. Tidak ada host ports, build, container_name, external volume atau public database. Web memasang volume storage read-only dan expose metadata 3000; worker memasang read/write. Volume memakai namespace project.

Resource ceiling: web 768 MiB/0,75 CPU, worker 2 GiB/1,5 CPU, db 1 GiB/0,5 CPU. Migrasi one-shot 512 MiB/0,5 CPU, terpisah dari steady-state aplikasi. Batas PID dan shm worker juga dicatat. Ini bukan quota operator atau hasil benchmark server bersama. Domain routing, registry pull serta actual Coolify-generated volume/project naming tetap perlu diverifikasi pada deployment.

Preflight menjalankan docker compose config tanpa start, menangkap data interpolasi privat dan hanya mengeluarkan kode aman. Ia memeriksa service/image/environment, format key, kesamaan DB URI/key, startup order, kesehatan, volume dan batas. Dengan tidak adanya --env-file, private .env repository tidak dibaca otomatis. Smoke memerlukan --project eksplisit, memeriksa state migrasi/health, /api/health, heartbeat worker serta mount aktual; opsional --url memeriksa HTTPS tanpa mengikuti redirect. Kedua tool bukan penerimaan login GitHub atau seluruh use case.

## Eksekusi lokal

| Pemeriksaan | Hasil |
| --- | --- |
| Node 24 lint/typecheck/unit pada paket sebelum integrasi main | 362 pass, termasuk 7 test konfigurasi; 0 fail/skip |
| Preflight dengan dummy immutable registry digest dan synthetic env | Pass; tidak pull image atau menghubungi registry |
| Stack disposable dengan image lokal ARM64 | db/web/worker healthy, migrate exit 0; tanpa host ports |
| Smoke sebelum/sesudah restore | Pass |
| Storage | Worker berhasil menulis marker synthetic; web membaca marker dan gagal menulis (RO) |
| Persistensi | Fixture database tetap ada setelah container db dibuat ulang; marker storage tetap ada setelah restart aplikasi |
| Backup/restore | pg_dump custom di-restore ke database lain; tar di-restore ke volume lain; satu fixture user dan hash marker identik |
| Data produk | Database/volume aplikasi asli tidak dipakai atau dihapus |

Runtime fixture mengganti image registry digest dummy dengan tag image lokal yang sudah tersedia dan memakai network internal, hanya untuk pengujian offline. Preflight produksi tetap menolak mutable tag. Fixture menggunakan project sage-deploy99 dan volume berbeda; tidak memakai akun, source atau credential pengguna. Backup uji berisi data synthetic dan disimpan privat, tidak di-commit.

Integrasi gabungan dengan baseline benchmark terbaru lulus lint, typecheck serta **370 unit test, 0 fail/skip** pada Node 24; 6 test benchmark dan 9 test konfigurasi termasuk di dalamnya. Container/volume disposable sudah dibersihkan setelah bukti disimpan. Build Docker standar target `build` juga lulus pada ARM64: lint, typecheck, 370 unit test, 8 database foundation test dan Next.js production build. Dockerfile menyertakan manifest corpus publik agar test benchmark dapat berjalan di konteks build standar. Ini belum membangun final image web/worker release atau image linux/amd64 dan bukan bukti deployment. Renderer PDF nyata sudah diukur pada image worker yang sama oleh PERF-02; ini tidak menggantikan smoke pada image release linux/amd64.

## Batas dan langkah deployment

Panduan operator ada di [COOLIFY](COOLIFY.md). Belum ada image registry yang dipublish, public TLS/domain, callback GitHub App produksi, OAuth live, off-server backup atau runtime x86_64 yang diuji. Server 16 CPU/14 GB dipakai bersama, bukan resource milik SAGE. PDF corpus menengah gagal guard pada [PERF-02](PERF-02_CHECKS.md), tindak lanjut [EXP-03 #101](https://github.com/AgilePemdigi-2026/sage/issues/101); jangan menganggap release atau kemampuan PDF medium diterima dari paket konfigurasi ini.

Review independen menemukan bahwa named volume dapat menyamarkan host bind lewat driver_opts. Preflight dan smoke kini menolak driver/driver_opts yang tidak didukung serta nama di luar namespace project; smoke juga memeriksa driver dan options volume aktual. Dua test regresi ditambahkan, preflight dan smoke stack disposable dijalankan ulang dengan hasil pass. Tidak ada guard yang dimatikan untuk membuat test lulus.
