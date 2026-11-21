# Deployment Coolify

Runbook aplikasi pada [sage.caiis.ai.id](https://sage.caiis.ai.id/). Pemeriksaan baca-saja 20 November 2026 menerima HTTP 404 dari `/api/health`, bukan payload health SAGE yang diharapkan. Pemeriksaan 15 November sebelumnya menerima HTTP 200, sehingga kondisi publik saat ini belum siap dinyatakan sehat; penyebab pada route, proxy, atau origin belum ditentukan. Tidak ada setting Coolify yang diubah dan tidak ada deployment yang dijalankan. Server 16 CPU/14 GB dipakai bersama; angka itu bukan quota SAGE. [Bukti pemeriksaan terbaru](../evidence/deployment-health-2026-11-20.json) dan [catatan rollout 10 November](../archive/operations/COOLIFY_ROLLOUT_2026-11-10.md) tetap tersedia.

## Bentuk deployment

Gunakan **compose.coolify.yaml** sebagai file Compose tersendiri, bukan override compose.yaml lokal. Empat service: PostgreSQL `db`, migrasi one-shot, Next `web`, dan `worker` (Node/PHP/Chromium). Migrasi menunggu database healthy; aplikasi menunggu migrasi exit 0. Tidak ada port host yang dipublish. Hubungkan domain HTTPS hanya ke komponen web pada port internal 3000. Database/worker tetap melalui network stack; jangan mengaktifkan public port database.

Image web dan worker harus berasal dari commit release yang sama, dibangun untuk **linux/amd64** sesuai x86_64 server, lalu tersedia pada registry yang dapat dibaca host. Siapkan build di CI atau mesin terpisah agar proses build tidak berebut RAM server bersama. Compose produksi hanya menarik image prebuilt. Catat digest kedua image; worker dan migrate harus memakai digest worker yang sama. [Bukti kesiapan 10 November](../evidence/deployment-readiness-2026-11-10.json) adalah catatan historis; buat ulang image dan verifikasi digest untuk commit yang akan dirilis.

Contoh perintah build pada builder yang mendukung target tersebut (ganti registry dan release):

```sh
docker buildx build --platform linux/amd64 --target web -t <registry>/sage-web:<release> --push .
docker buildx build --platform linux/amd64 --target worker -t <registry>/sage-worker:<release> --push .
```

Selesaikan test/review dahulu dan pastikan autentikasi registry privat tersedia pada host Coolify. Gunakan hasil digest registry, bukan hash source Git atau tag `latest`, untuk `SAGE_WEB_IMAGE` dan `SAGE_WORKER_IMAGE`.

## Environment privat

| Variabel | Nilai yang diperlukan |
| --- | --- |
| SAGE_WEB_IMAGE / SAGE_WORKER_IMAGE | Registry image `@sha256:<digest>`, release yang sama dan linux/amd64 |
| POSTGRES_PASSWORD | Password baru yang kuat; format hex minimal 32 karakter agar aman digunakan dalam URI database |
| CREDENTIAL_ENCRYPTION_KEY | Base64 kanonis dari 32 byte; sama di web/worker; simpan aman untuk pemulihan |
| AUTH_BASE_URL | Origin HTTPS publik tanpa path/query/fragment; tidak berakhir dengan slash |
| GITHUB_APP_CLIENT_ID / GITHUB_APP_CLIENT_SECRET | Kredensial App privat yang sudah digunakan integrasi produk |
| GITHUB_APP_SLUG | Slug App untuk tautan pemasangan, jika dipakai |

Masukkan melalui Environment Variables Coolify atau private env file di luar Git. Jangan memasukkan database URL/token/secret ke build args, README atau screenshot. Database hanya menerima password PostgreSQL; key kredensial diberikan ke web dan worker. Kehilangan atau mengganti key secara langsung membuat ciphertext GitHub lama tidak dapat didekripsi. Pertahankan key saat restore; rotasi memerlukan proses tersendiri.

Tambahkan callback **https://<domain>/auth/github/callback** pada GitHub App dan cocokkan origin dengan AUTH_BASE_URL. Callback localhost yang masih dipakai lokal dapat dipertahankan; tidak perlu menggantinya dengan wildcard. Callback tambahan untuk `https://sage.caiis.ai.id` sudah disimpan; callback localhost dipertahankan dan wildcard nonaktif.

## Resource awal

Batas runtime mempertahankan konfigurasi lokal: web 768 MiB/0,75 CPU, worker 2 GiB/1,5 CPU, database 1 GiB/0,5 CPU. Worker mempunyai shm 256 MiB. Migrasi sementara dibatasi terpisah dan selesai sebelum web/worker mulai. CPU/memory cap bukan reservasi host atau jaminan kapasitas; shm/tmpfs juga memakai memori, bukan tambahan memori gratis.

[Bukti benchmark core lokal PERF-02](../archive/performance/PERF-02_CHECKS.md) mencatat peak tertinggi sekitar 655 MiB pada sampel serta penolakan PDF medium; tindak lanjut [EXP-03](../archive/documents/EXP-03_CHECKS.md) meluluskan PDF kedua corpus menengah dengan proyeksi terbatas dan peak tertinggi sekitar 624 MiB. PDF menerima canonical input sampai 32 MiB, membatasi HTML hasil proyeksi sampai 12 MiB, dan output PDF sampai 32 MiB. Ukuran besar dan guard lain tetap dapat menolak export. Hasil tersebut tidak mengukur database, antrean/duplikasi validasi sembilan tahap atau perebutan resource dari kelompok lain. Jangan mengurangi RAM hanya berdasarkan idle, atau menyatakan ceiling 2.000 file sebagai kapasitas deployment teruji. Operator perlu menyepakati quota runtime dan disk/backups sebelum deploy.

## Pemeriksaan dan urutan rollout

1. Tetapkan domain, quota SAGE, disk yang tersedia serta lokasi backup di luar server bersama operator.
2. Bangun/publikasi image release, periksa arsitektur dan akses pull; simpan kedua digest di environment.
3. Jalankan `npm run deployment:check -- --env-file /path/private.env` pada mesin ber-Docker untuk memvalidasi Compose tanpa start service. Output hanya kode pemeriksaan; file privat tidak boleh di-commit. Pemeriksaan ini tidak membuktikan registry dapat dipull, arsitektur image, kesesuaian semantic dua image atau domain/callback sudah aktif.
4. Pilih file compose.coolify.yaml di resource Compose Coolify, isi environment, pasang domain web port 3000, dan deploy melalui Coolify. Pastikan db healthy, migrate exit 0, web/worker healthy; exclude migrate dari aggregate health bila UI menganggap exited sebagai gagal.
5. Jalankan smoke read-only dengan project dan file Compose hasil deployment yang tepat: `npm run deployment:smoke -- --project <project> --compose <file>`; jangan membuat project Compose kedua pada volume server yang sama. Gunakan opsi URL publik jika tersedia pada CLI.
6. Uji manual GitHub nyata: login dua akun terpisah, daftar public/private berizin, penolakan private tanpa izin, analisis source kecil, history owner, download Markdown/PDF dan logout/pergantian akun. Tambahkan uji repo menengah setelah memeriksa quota. Smoke tidak memberi acceptance OAuth atau isolasi dua akun.

## Backup dan restore

Named volume `database` menyimpan PostgreSQL 17; `storage` menyimpan archive source dan file ekspor. Coolify dapat memberi prefix nama volume: gunakan mount aktual dari resource itu, bukan nama lokal `sage_storage`. Web memasang storage read-only; worker read/write. Persistent volume tetap bukan backup.

Untuk backup yang konsisten, hentikan penulisan aplikasi (web/worker) melalui resource yang benar, pastikan job aktif selesai, kemudian simpan `pg_dump -Fc` dan archive volume storage pada titik waktu yang sama. Gunakan direktori privat dengan umask 077. Simpan key kredensial dalam secret manager terpisah. Salin backup terenkripsi ke lokasi di luar host dan catat versi PostgreSQL, commit, image digest, hash/ukuran dump dan archive. Memeriksa file lokal saja belum membuktikan salinan off-server berhasil.

Contoh backup CLI berikut memerlukan file/environment dan project aktual yang sudah diverifikasi operator. Hentikan writer dahulu; jangan jalankan dengan project baru yang tidak sama dengan resource Coolify.

```sh
set -eu
umask 077
mkdir -p "$SAGE_BACKUP_DIR"
docker compose --project-name "$SAGE_PROJECT" --env-file "$SAGE_PRIVATE_ENV" -f "$SAGE_DEPLOY_FILE" stop web worker
docker compose --project-name "$SAGE_PROJECT" --env-file "$SAGE_PRIVATE_ENV" -f "$SAGE_DEPLOY_FILE" exec -T db pg_dump -U sage -d sage -Fc > "$SAGE_BACKUP_DIR/database.dump"
docker compose --project-name "$SAGE_PROJECT" --env-file "$SAGE_PRIVATE_ENV" -f "$SAGE_DEPLOY_FILE" run --rm -T --no-deps --entrypoint tar worker -C /app/storage -cf - . > "$SAGE_BACKUP_DIR/storage.tar"
sha256sum "$SAGE_BACKUP_DIR/database.dump" "$SAGE_BACKUP_DIR/storage.tar" > "$SAGE_BACKUP_DIR/SHA256SUMS"
```

Setelah backup berhasil dan file/hash diperiksa, nyalakan kembali writer lewat resource Coolify yang sama. Simpan pula key kredensial di tempat privat terpisah; key tersebut tidak berada dalam backup volume. Uji restore lokal DEP-01 memakai alur dump/tar ini, tetapi hanya dengan data synthetic.

Restore dilakukan terlebih dahulu pada resource/volume kosong yang terpisah: start hanya db, `pg_restore --no-owner --no-acl` ke database kosong, restore archive dengan owner/permission worker (UID 1000), pasang key yang sama, lalu jalankan migrasi release yang kompatibel dan start web/worker. Bandingkan jumlah record, hash source/file ekspor, izin baca serta health. Jangan menimpa volume aktif untuk latihan restore. Penjadwalan/frekuensi dan backup off-server masih keputusan operator.

Layout canonical 2 tidak kompatibel dengan reader lama yang hanya memahami layout 1. Rollback memakai image yang mendukung layout 1/2 atau pasangan backup database+storage yang cocok; mengganti image lama saja bukan rollback yang aman.

## Bukti lokal dan batas

Hasil pengujian Compose, smoke, persistence dan restore tercatat pada [DEP-01_CHECKS](../archive/operations/DEP-01_CHECKS.md); pengujian tersebut bukan bukti bahwa domain dan origin masih sehat saat ini. Rollout 10 November mencatat runtime pernah healthy. Pemeriksaan publik terbaru pada 20 November menerima HTTP 404 dari `/api/health`, sehingga status sehat sebelumnya tidak berlaku sebagai verifikasi terkini. Lihat [bukti terbaru](../evidence/deployment-health-2026-11-20.json). Penyebab route, proxy, atau origin belum diketahui. OAuth produksi, resource quota SAGE, beban bersama, dan restore off-server belum disahkan.

## Referensi

- [Coolify Compose](https://coolify.io/docs/services/configuration/docker-compose), [networking](https://coolify.io/docs/services/configuration/networking), [environment](https://coolify.io/docs/services/configuration/environment-variables).
- [Coolify Compose build](https://coolify.io/docs/applications/builds/docker-compose), [registry](https://coolify.io/docs/applications/builds/docker-registries), [resource limits](https://coolify.io/docs/applications/configuration/resource-limits).
- [Persistent storage](https://coolify.io/docs/services/configuration/persistent-storage), [database backups](https://coolify.io/docs/databases/backups).
- [Docker Compose services](https://docs.docker.com/reference/compose-file/services/), [GitHub App callback](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/about-the-user-authorization-callback-url).

## Release images otomatis

Workflow `.github/workflows/release-images.yml` dapat dijalankan melalui Actions → Release images → Run workflow pada commit yang sudah direview, atau tag `v*`. GitHub runner membangun target web dan worker untuk `linux/amd64`, termasuk pemeriksaan yang diwajibkan Dockerfile. Kredensial aplikasi tidak diberikan ke build; publikasi GHCR memakai token job sementara dengan `packages: write`.

Setelah kedua image dipublish, runner menarik ulang image berdasarkan digest, memeriksa arsitektur dan label commit, menjalankan migrasi serta health/storage smoke dengan Compose produksi pada database disposable. Artifact `sage-release-<commit>` hanya diterbitkan setelah smoke lulus, berisi `images.env` (dua digest) dan `manifest.json` (commit/platform/status). Kredensial smoke bersifat synthetic dan tidak masuk artifact. Ini belum menguji domain atau OAuth produksi.

Paket GHCR baru dapat bersifat private. Pastikan host Coolify memiliki akses pull; jangan mengubah visibility atau membuat token baru tanpa memeriksa akses organisasi. Jangan salin token GitHub pribadi ke repository. Jika salah satu build/smoke gagal, jangan menggunakan manifest dari run atau commit lain sebagai penggantinya.

Konfigurasi produksi membatasi log Docker menjadi tiga file masing-masing 10 MB per service. Batas ini hanya untuk log, bukan kuota database/storage; hasil analisis tetap disimpan sampai pengguna menghapusnya.

## Backup manual ke laptop

Untuk tahap awal, pilihan pemilik project adalah backup manual ke laptop. `npm run deployment:backup -- --context <docker-context-server> --project <project-aktual> --compose <compose-aktual> --env-file <private-env> --output <direktori-baru-di-laptop>` menjalankan preflight dan smoke terhadap context/project eksplisit, menghentikan web/worker, lalu mengalirkan `pg_dump -Fc` serta archive storage langsung ke disk laptop tanpa memuat seluruh backup ke RAM. Script selalu mencoba menyalakan kembali writer meskipun stop/copy gagal. Tidak ada volume yang dihapus.

Context harus benar-benar menunjuk Docker server tujuan melalui akses operator yang sudah tersedia; jangan memakai context Colima untuk backup server dosen. File Compose/environment harus sesuai resource aktual, termasuk penamaan volume hasil Coolify. Script menolak direktori output yang sudah ada. Manifest menyimpan ukuran/hash dan status copy; kegagalan menyimpan artefak parsial dengan status `incomplete`, bukan menandainya sebagai backup berhasil. Key enkripsi/kredensial disimpan privat secara terpisah.

Pengujian transport terkontrol memeriksa copy, penolakan target, penolakan overwrite, serta restart writer setelah kegagalan stop/dump/tar. Pengujian itu tidak membuktikan akses Docker remote atau restore server. Setelah copy nyata, verifikasi hash dan lakukan restore pada volume disposable; jangan menganggap `copied` sebagai signoff restore. SSH/Docker context remote untuk laptop belum tersedia pada konfigurasi yang diperiksa.


## Routing dan registry

Domain diarahkan hanya ke web pada port internal 3000; tidak ada public port untuk db/worker. Registry publik release tersedia melalui [repository build Iltizam](https://github.com/iltizamhasan3/sage-release-images); pilih digest web/worker dari source release yang sama. Jangan menyalin digest historis tanpa memverifikasi release tujuan.

Redirect HTTPS Coolify dinonaktifkan pada rollout lanjutan untuk mengatasi redirect loop di jalur Cloudflare. Mode SSL/TLS Cloudflare belum diverifikasi melalui dashboard; HTTPS publik yang berhasil tidak membuktikan enkripsi koneksi Cloudflare–origin. Jangan mengubah aturan global zone/server bersama. Operator domain perlu menilai HTTPS ke origin dan Full (strict) khusus hostname sebelum mewajibkan redirect kembali.

[Beranda operasi](README.md) · [Arsip rollout](../archive/operations/COOLIFY_ROLLOUT_2026-11-10.md)

### Kuota GitHub untuk repository public

Request metadata, branch, commit, dan arsip melalui `api.github.com` memakai token pengguna yang sedang login, termasuk untuk repository public. Ini menghindari ketergantungan pada kuota anonim IP server yang digunakan bersama. Token tidak diteruskan ke host unduhan `codeload.github.com`; pemeriksaan instalasi App dan izin pengguna untuk repository private tetap berlaku. Bila kuota pengguna sendiri habis, aplikasi tetap melaporkan rate limit dan tidak mengulang request lewat kuota anonim. Lihat [ketentuan rate limit GitHub](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api).
