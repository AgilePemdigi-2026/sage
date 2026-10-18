# Fondasi lokal

Scope: ENV-01 ([#2](https://github.com/AgilePemdigi-2026/sage/issues/2)), DATA-01 ([#3](https://github.com/AgilePemdigi-2026/sage/issues/3)), dan seed QA-01 ([#4](https://github.com/AgilePemdigi-2026/sage/issues/4)). Tersedia halaman awal berbahasa Indonesia, PostgreSQL, heartbeat worker, schema/migrasi produk, helper session dan kredensial, query owner-scoped, serta probe syntax dan renderer. Login GitHub HTTP dan analisis repository belum tersedia.

## Prasyarat dan menjalankan

Gunakan Docker Engine dengan Compose yang mendukung `service_completed_successfully`, `--wait`, dan `--wait-timeout`. Setup awal menggunakan Node untuk menulis `.env`; tidak memerlukan instalasi npm/PHP/PostgreSQL pada host. Node 24 menjadi runtime aplikasi yang dipin dalam image.

```sh
node scripts/setup-local.mjs
docker compose config --quiet
docker compose build
docker compose up --wait --wait-timeout 180
docker compose ps
```

Script membuat password PostgreSQL acak serta `CREDENTIAL_ENCRYPTION_KEY` base64 acak 32 byte, kemudian membatasi izin `.env` hanya untuk pemilik. Jika `.env` sudah ada, password dan key yang sudah ada dipertahankan; nilai yang belum ada ditambahkan tanpa menampilkan rahasia. Compose memberikan key ke web dan worker saja, tidak ke container database. Jangan salin placeholder `.env.example` menjadi konfigurasi aktif. Ubah `WEB_PORT` pada `.env` jika port 3000 terpakai, lalu recreate container web.

Buka [http://localhost:3000](http://localhost:3000). Hanya web dipublikasikan, pada loopback host. Database tidak memiliki port host. `migrate` selesai dengan exit 0 sebelum web/worker dimulai; status Exited (0) pada service ini sesuai rancangan.

Pada macOS yang memakai Colima, mulai VM sebelum command Compose. Lingkungan pemeriksaan menggunakan profile `sage`, 2 CPU, dan RAM 4 GiB:

```sh
colima start --profile sage --cpu 2 --memory 4 --disk 30 --vm-type vz --mount-type virtiofs
docker context use colima-sage
```

Docker Desktop/Engine yang sudah berfungsi tidak memerlukan Colima. Run ulang spike dimulai dengan sekitar 12 GiB disk host bebas; percobaan ketika sisa ruang menipis mengalami EIO. Periksa ruang host dan VM bila build gagal menulis; jangan menghapus volume data aplikasi untuk mengatasi cache build. Alokasi tersebut adalah lingkungan spike, bukan hardware minimum produk yang telah dibenchmark.

## Pemeriksaan

```sh
docker compose build
docker compose exec -T worker npm run fixtures:verify
docker compose exec -T worker npm run smoke
docker compose exec -T worker npm run smoke:browser
```

Build menjalankan `npm run check` (lint, typecheck, dan unit/integrity tests) sebelum kompilasi web. Tooling pengembangan tidak dimasukkan ke image runtime. `smoke` menguji koneksi database, migrasi/heartbeat, syntax valid/invalid PHP/JS/TS, integritas fixture, SVG Mermaid, dan file PDF Chromium nyata. `smoke:browser` memeriksa halaman awal pada lebar 360/390/768/1024/1440 px, error JavaScript, health endpoint, dan overflow horizontal.

Bukti tersimpan di volume worker `/app/storage/environment/`. Untuk inspeksi lokal:

```sh
mkdir -p artifacts
docker compose cp worker:/app/storage/environment artifacts/
```

Folder `artifacts/` diabaikan Git. PDF/SVG tersebut hanya sample kompatibilitas yang berasal dari data tepercaya, bukan dokumentasi hasil analisis repository. Ketiga artefak produk dan ekspor terotorisasi masih mengikuti DOC-01/EXP-01/EXP-02.

## Restart dan persistensi

```sh
docker compose exec -T worker node --import tsx scripts/persistence.ts seed
docker compose down
docker compose up --wait --wait-timeout 180
docker compose exec -T worker node --import tsx scripts/persistence.ts check
```

Probe ENV-01 menulis marker heartbeat ke database, memeriksa marker setelah container dibuat ulang, lalu menghapusnya. Named volumes `sage_database` dan `sage_storage` tetap ada setelah `down`. Jangan menambahkan flag `-v` kecuali memang hendak menghapus database dan artefak lokal.

Pemeriksaan persistensi DATA-01 tersedia pada `scripts/data-check.ts` dengan fase `seed` dan `check`. Fase ini menyimpan fixture user, session hash, kredensial terenkripsi, analysis, metadata file, graph, dan dokumen di PostgreSQL. File marker berisi ID fixture disimpan di `STORAGE_ROOT` untuk pemeriksaan sesudah restart. Jalankan hanya melalui harness database terisolasi: script mewajibkan `SAGE_DATABASE_TESTS=1` dan nama database `sage_data01` atau `sage_data01_fresh`; database stack lokal biasa ditolak. Setelah container database dibuat ulang tanpa menghapus named volume, jalankan fase `check`; pemeriksaan sukses menghapus fixture dan marker volume.

## Migrasi dan pengembangan

Schema/migrasi menyediakan User, Session, GitHubConnection, GitHubInstallation, Repository, Analysis, Job, AnalysisStage, SourceFile, AnalysisLimitation, GraphBundle, ArchitectureDocument, Export, StorageObject, dan WorkerSlot serta mempertahankan `WorkerHeartbeat`. `migrate deploy` berjalan otomatis ketika stack dimulai; perubahan database yang membutuhkan koordinasi diterangkan pada PR. WorkerSlot belum menjalankan claim/lock, dan model tersimpan belum berarti semua lifecycle tersedia.

Untuk tooling pada host gunakan Node 24 dan npm yang tercantum pada `package.json`, lalu `npm ci` dan `npm run db:generate`. Integration test DATA-01 harus dijalankan pada database uji terisolasi yang sama dengan guard di atas; ia menguji dua user yang memakai repository publik sama, session expiry/revocation, token terenkripsi/tampering, owner predicates, composite foreign keys, dan constraints. Pemeriksaan runtime PHP/PDF/database direkomendasikan melalui container agar versi sama. Build web tidak memerlukan koneksi database ataupun GitHub App.

## Batas awal dan pekerjaan tersisa

Compose membatasi web 768 MiB, worker 2 GiB, dan database 384 MiB. Web/worker berjalan non-root dengan capabilities dihapus. Volume storage hanya dibaca oleh web dan dapat ditulis worker.

`config/analysis-limits.json` memuat calon batas konservatif: archive 25 MiB, extracted 100 MiB, file source 1 MiB, 2.000 file, rasio ekstraksi 20, timeout parser 10 detik, dan analisis 300 detik. Batas repository tersebut **belum diterapkan** karena snapshot/pipeline belum ada; REP-02/ANA-02/ANA-07 harus menerapkan dan mengujinya sebelum menerima repository arbitrer. Login/OAuth HTTP, claim/recovery queue #9, lifecycle deletion #23, penyimpanan berkas nyata, dan validasi isi tiga artefak dokumen masih menunggu issue masing-masing. Probe PHP memiliki timeout sendiri dan hanya dipakai untuk fixture tepercaya pada tahap ini.

Mermaid memakai strict mode pada sample tepercaya. Escape label/source, pembatasan ukuran diagram, pengujian injeksi, serta validasi output untuk konten repository tetap wajib pada DOC-01/EXP-02. Chromium tidak boleh dipakai membuka URL bebas dari input pengguna.

Semua 24 acceptance test produk pada test plan tetap NOT_RUN sampai alur terkait tersedia. Bukti fondasi dicatat terpisah dalam [pemeriksaan environment](ENVIRONMENT_CHECKS.md); QA-01 tetap terbuka karena oracle semantik lengkap dan review tim belum selesai.

## Referensi implementasi

Runtime mengikuti [instalasi Next.js](https://nextjs.org/docs/app/getting-started/installation), [Prisma 7](https://www.prisma.io/docs/orm/v7), [Playwright Docker](https://playwright.dev/docs/docker), dan [nikic/PHP-Parser](https://github.com/nikic/PHP-Parser). Versi aktual tersedia pada lockfile dan digest image; dokumentasi upstream bukan bukti bahwa fitur SAGE sudah lulus pengujian.
