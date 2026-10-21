# Fondasi lokal

Scope: ENV-01 ([#2](https://github.com/AgilePemdigi-2026/sage/issues/2)), DATA-01 ([#3](https://github.com/AgilePemdigi-2026/sage/issues/3)), dan seed QA-01 ([#4](https://github.com/AgilePemdigi-2026/sage/issues/4)). Tersedia halaman awal berbahasa Indonesia, PostgreSQL, worker, schema/migrasi produk, helper session/kredensial, query owner-scoped, dan probe syntax/renderer. Login GitHub nyata, akses public/instalasi, validasi repository/branch/full SHA, submission idempotent ke queue, serta pengambilan snapshot immutable memiliki bukti masing-masing. Setiap instalasi lokal tetap memerlukan konfigurasi App sendiri. Consumer analisis sembilan tahap masih nonaktif (`workerQueueEnabled=false`), sehingga submit belum menghasilkan analisis lengkap.

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

Folder `artifacts/` diabaikan Git. PDF/SVG tersebut hanya sample kompatibilitas yang berasal dari data tepercaya, bukan dokumentasi hasil analisis repository. DOC-01 menyediakan model dan halaman tiga artefak untuk hasil canonical tersimpan yang sukses; ekspor terotorisasi masih mengikuti EXP-01/EXP-02.

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

Schema/migrasi menyediakan User, Session, GitHubConnection, GitHubInstallation, Repository, Analysis, Job, AnalysisStage, SourceFile, AnalysisLimitation, GraphBundle, ArchitectureDocument, Export, StorageObject, dan WorkerSlot serta mempertahankan `WorkerHeartbeat`. `migrate deploy` berjalan otomatis ketika stack dimulai; perubahan database yang membutuhkan koordinasi diterangkan pada PR. ANA-01 menyediakan enqueue/claim/lease/recovery dan partial index global; ANA-07-S1 menyediakan runner/persistensi stage pada scope terbatas. Consumer produk tetap dimatikan (`workerQueueEnabled=false`) sampai ANA-07 #16 menghubungkan seluruh sembilan tahap dan publikasi hasil. Lihat [hasil pengujian antrean](ANA-01_CHECKS.md).

Untuk tooling pada host gunakan Node 24 dan npm yang tercantum pada `package.json`, lalu `npm ci` dan `npm run db:generate`. Integration test DATA-01 harus dijalankan pada database uji terisolasi yang sama dengan guard di atas; ia menguji dua user yang memakai repository publik sama, session expiry/revocation, token terenkripsi/tampering, owner predicates, composite foreign keys, dan constraints. Pemeriksaan runtime PHP/PDF/database direkomendasikan melalui container agar versi sama. Build web tidak memerlukan koneksi database ataupun GitHub App.

## Batas awal dan pekerjaan tersisa

Compose membatasi web 768 MiB, worker 2 GiB, dan database 384 MiB. Web/worker berjalan non-root dengan capabilities dihapus. Volume storage hanya dibaca oleh web dan dapat ditulis worker.

`config/analysis-limits.json` memuat batas konservatif: archive 25 MiB, extracted 100 MiB, file source 1 MiB, 2.000 file, rasio ekstraksi 20, timeout parser 10 detik, dan analisis 300 detik. Kebijakan source diterapkan pada jalur snapshot immutable; lihat batas bukti REP-02. Karena consumer sembilan tahap nonaktif, nilai batas lintas pipeline belum terverifikasi sebagai proteksi analisis penuh. Consumer pipeline #16, lifecycle deletion #23, ekspor produk #20–21, dan validasi isi tiga artefak dokumen #15 tetap menunggu issue masing-masing. API claim/recovery #9 sudah diuji terpisah. Parser PHP memiliki timeout sendiri.

Mermaid memakai strict mode. Modul DOC-02 menambahkan encoding label, pembatasan diagram, blokir jaringan, pengujian label berbahaya, serta validasi SVG; lihat [bukti DOC-02](DOC-02_CHECKS.md). DOC-01 merender diagram lokal dari dokumen canonical; integrasi ekspor produk tetap diuji pada EXP-01/EXP-02. Chromium tidak boleh dipakai membuka URL bebas dari input pengguna.

Status acceptance produk mengikuti [test plan](TEST_PLAN.md) dan bukti per issue. Login/repository nyata, target branch/full SHA, dan snapshot telah diuji pada slice GH-01/02 serta REP-01/02; history dan graph membaca hasil tersimpan, dengan bukti [GRAPH-01](GRAPH-01_CHECKS.md). Submission sampai hasil graph/dokumen/ekspor penuh tetap menunggu pipeline aktif. Bukti fondasi dicatat terpisah dalam [pemeriksaan environment](ENVIRONMENT_CHECKS.md); QA-01 tetap terbuka untuk kelengkapan oracle semantik dan review tim.

## Referensi implementasi

Runtime mengikuti [instalasi Next.js](https://nextjs.org/docs/app/getting-started/installation), [Prisma 7](https://www.prisma.io/docs/orm/v7), [Playwright Docker](https://playwright.dev/docs/docker), dan [nikic/PHP-Parser](https://github.com/nikic/PHP-Parser). Versi aktual tersedia pada lockfile dan digest image; dokumentasi upstream bukan bukti bahwa fitur SAGE sudah lulus pengujian.

## Login GitHub App

Lihat [panduan bootstrap App](GITHUB_APP_SETUP.md) dan [bukti GH-01](GH-01_CHECKS.md). `AUTH_BASE_URL` adalah origin tepercaya untuk callback, redirect, dan pemeriksaan Origin; nilainya tidak diambil dari header Host. Bootstrap pengembangan memakai localhost port 3000. Client ID/secret hanya diteruskan ke server web saat runtime, tidak ke build atau variabel `NEXT_PUBLIC`.

Setelah konfigurasi `.env` tersimpan, recreate web dengan `docker compose up -d --force-recreate --no-deps web`. Session lokal dan credential dibatasi paling lama delapan jam atau masa berlaku token yang lebih pendek; login ulang diperlukan setelahnya. Refresh token otomatis belum diimplementasikan. Logout mencabut session SAGE, tidak mencabut otorisasi atau instalasi App di GitHub.

## Akses repository

Setelah login, buka `/workspace/repositories` untuk memuat instalasi atau memeriksa public milik siapa saja. Link pengaturan App memakai `GITHUB_APP_SLUG`; setelah mengubahnya, recreate web. Private memerlukan instalasi yang dipilih pemilik akun dan izin user serta Contents read. Status verifikasi dan batasnya ada di [GH-02](GH-02_CHECKS.md). Pemeriksaan akses belum menjalankan job analisis.
