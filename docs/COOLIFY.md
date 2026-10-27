# Deployment Coolify

Paket DEP-01 [#99](https://github.com/AgilePemdigi-2026/sage/issues/99), penanggung jawab Rizqy. Status: persiapan lokal; belum melakukan deployment, publish image, perubahan GitHub App atau konfigurasi server dosen. Server 16 CPU/14 GB dipakai bersama; angka itu bukan quota SAGE.

## Bentuk deployment

Gunakan **compose.coolify.yaml** sebagai file Compose tersendiri, bukan override compose.yaml lokal. Empat service: PostgreSQL `db`, migrasi one-shot, Next `web`, dan `worker` (Node/PHP/Chromium). Migrasi menunggu database healthy; aplikasi menunggu migrasi exit 0. Tidak ada port host yang dipublish. Hubungkan domain HTTPS hanya ke komponen web pada port internal 3000. Database/worker tetap melalui network stack; jangan mengaktifkan public port database.

Image web dan worker harus berasal dari commit release yang sama, dibangun untuk **linux/amd64** sesuai x86_64 server, lalu tersedia pada registry yang dapat dibaca host. Siapkan build di CI atau mesin terpisah agar proses build tidak berebut RAM server bersama. Compose produksi hanya menarik image prebuilt. Catat digest kedua image; worker dan migrate harus memakai digest worker yang sama. Paket ini belum mempublikasikan image.

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

Tambahkan callback **https://<domain>/auth/github/callback** pada GitHub App dan cocokkan origin dengan AUTH_BASE_URL. Callback localhost yang masih dipakai lokal dapat dipertahankan; tidak perlu menggantinya dengan wildcard. Paket ini tidak mengubah App karena domain deployment belum ditetapkan.

## Resource awal

Batas runtime mempertahankan konfigurasi lokal: web 768 MiB/0,75 CPU, worker 2 GiB/1,5 CPU, database 1 GiB/0,5 CPU. Worker mempunyai shm 256 MiB. Migrasi sementara dibatasi terpisah dan selesai sebelum web/worker mulai. CPU/memory cap bukan reservasi host atau jaminan kapasitas; shm/tmpfs juga memakai memori, bukan tambahan memori gratis.

[Bukti benchmark core lokal PERF-02](PERF-02_CHECKS.md) mencatat peak tertinggi sekitar 655 MiB pada sampel serta penolakan PDF medium; cap dipertahankan. Ia tidak mengukur database, antrean/duplikasi validasi sembilan tahap atau perebutan resource dari kelompok lain. Jangan mengurangi RAM hanya berdasarkan idle, atau menyatakan ceiling 2.000 file sebagai kapasitas deployment teruji. Batas PDF dapat menolak hasil analisis besar. Operator perlu menyepakati quota runtime dan disk/backups sebelum deploy.

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

Hasil pengujian Compose, smoke, persistence dan restore tercatat pada [DEP-01_CHECKS](DEP-01_CHECKS.md). Domain, callback produksi, TLS, registry pull, linux/amd64 runtime dan server bersama belum diverifikasi.

## Referensi

- [Coolify Compose](https://coolify.io/docs/services/configuration/docker-compose), [networking](https://coolify.io/docs/services/configuration/networking), [environment](https://coolify.io/docs/services/configuration/environment-variables).
- [Coolify Compose build](https://coolify.io/docs/applications/builds/docker-compose), [registry](https://coolify.io/docs/applications/builds/docker-registries), [resource limits](https://coolify.io/docs/applications/configuration/resource-limits).
- [Persistent storage](https://coolify.io/docs/services/configuration/persistent-storage), [database backups](https://coolify.io/docs/databases/backups).
- [Docker Compose services](https://docs.docker.com/reference/compose-file/services/), [GitHub App callback](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/about-the-user-authorization-callback-url).
