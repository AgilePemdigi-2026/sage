# Regression Playwright lintas fitur

Tanggal: 20 Oktober 2026 (Asia/Jakarta). Paket QA-04-S1, issue [#66](https://github.com/AgilePemdigi-2026/sage/issues/66), penanggung jawab Valentina (`liliks13`). Implementasi dan pengujian dilakukan secara otomatis; review/merge mengikuti akun Iltizam.

## Cakupan

| Fitur | Pemeriksaan | Batas bukti |
| --- | --- | --- |
| Landing dan navigasi | Heading/bahasa, CTA login/preview, aset/font, health, lima viewport | Route aplikasi dan database nyata |
| Login, workspace, logout | Guard anonim, API 401, pesan Indonesia, start OAuth, denial/replay/retry, callback invalid, workspace dan navigasi, logout/cookie, sesi expired/revoked | Identitas sementara pada database nyata; redirect otorisasi dialihkan ke callback denial lokal. Tidak ada persetujuan/token exchange GitHub baru |
| Repository dan target | Search, public form, private card, tiga pagination, branch deduplication, commit kosong/eksplisit, stale reset, error/empty/retry, tidak membuat job | UI serta guard nyata; respons API provider terkontrol |
| Provider GitHub | Instalasi/repository berizin, public pihak lain, private berizin, branch, full SHA/prefix, Origin/input invalid, tanpa session ditolak | Playwright APIRequestContext menuju Next/GitHub nyata, sesi sementara pada otorisasi existing. Bukan login OAuth baru atau browser sebagai user kedua |
| Progres dan history | Lima status progres, sembilan stage, search/empty/error/loading, navigasi snapshot | Fixture berlabel; bukan progres job atau history pengguna |
| Graph dan source | Query AND kategori, zoom/fit/fokus/relasi, node keyboard, dialog source/Escape/focus restore, context salah ditolak | Fixture tervalidasi 10 node/9 relasi, bukan hasil analisis repository |
| Dokumen dan Markdown | Tab keyboard, diagram, evidence/source, isi unduhan Markdown, unavailable/retry, PDF disabled | Markdown contoh lokal; bukan ekspor produk |
| UI awal/kompatibilitas | `/ui-preview`, `/graph-preview`, state/keyboard/zoom/resize, kontras teks DOM dan kontrol | Canvas pixels/seluruh aksesibilitas tidak tersertifikasi |
| Analisis penuh, graph/dokumen produk, PDF, history/delete | Belum dapat diuji sebagai alur produk | Consumer masih nonaktif dan integrasi belum diimplementasikan; acceptance Sprint 2 tetap terbuka |

Viewport Chromium: **360, 390, 768, 1024, 1440 px**. Error provider pada UI diuji sebagai respons terkontrol; pengujian nyata dilakukan terpisah. Source/private metadata, state OAuth, cookie dan token tidak dimasukkan ke laporan publik.

## Perubahan pengujian

- Smoke lama mengacu teks landing yang sudah dihapus; diganti pemeriksaan CTA, label preview dan hasil navigasi aktual.
- Repository UI diperluas untuk public input, pagination instalasi/repository/branch, branch duplikat, payload commit dan error/retry.
- Suite auth baru memakai identitas unik serta sesi sementara, dan membersihkan hanya data yang dibuat oleh pengujian. Origin tepercaya dipertahankan melalui reverse proxy loopback sementara di container pengujian. Suite auth dijalankan dalam worker Docker, bukan langsung pada host yang port aplikasinya sedang digunakan. Runner mengatur browser Origin sesuai `AUTH_BASE_URL` dan transport ke layanan `web`.
- `test:browser` menggabungkan tujuh suite, melanjutkan suite berikutnya ketika ada kegagalan, dan keluar nonzero jika satu suite gagal. Laporan per run memuat tanggal, base commit, hash script/lockfile, runtime dan lokasi bukti.
- Image worker menyertakan fixture graph dan stylesheet yang dibaca suite baseline; screenshot/laporan disimpan pada volume yang dapat ditulis.

## Replay Docker

Setelah setup lokal, konfigurasi GitHub App dan layanan web/database berjalan:

```sh
docker compose build worker
docker compose run --rm --no-deps worker npm run test:browser
```

Bukti tersimpan di `/app/storage/browser-regression/<run-id>` pada volume lokal. Untuk menyalinnya ke host:

```sh
mkdir -p artifacts
docker compose cp worker:/app/storage/browser-regression ./artifacts/
```

Untuk run dari source yang sudah memiliki dependency Node 24, gunakan bind mount agar script terbaru dan bukti berada di checkout:

```sh
docker compose run --rm --no-deps -v "$PWD:/app" \
  -e STORAGE_ROOT=/app/artifacts \
  -e QA_APP_COMMIT_SHA="$(git rev-parse HEAD)" \
  worker npm run test:browser
```

Provider nyata adalah pemeriksaan terpisah yang memerlukan otorisasi akun existing dan fixture private yang disetujui pemilik. Nilai berikut adalah placeholder, bukan credential:

```sh
docker compose run --rm --no-deps \
  -e SAGE_TEST_LOGIN='akun-yang-sudah-login' \
  -e SAGE_TEST_PRIVATE_REPOSITORY='owner/repo-yang-diizinkan' \
  worker npm run test:provider:playwright
```

Ganti placeholder sebelum menjalankan perintah; jangan mengirim token/secret melalui argumen atau chat. Probe membuat sesi sementara, hanya membaca/memvalidasi target, lalu menghapus sesi tersebut. Ia tidak membuat job atau memperbarui credential existing.

## Hasil run

Base aplikasi yang diperiksa: `ba47ee08fc7bdd93bbd6f60c28946ffcb939dad9`; tidak ada perubahan runtime web dalam paket ini. Image web yang melayani pengujian: `sha256:179f028b00881d15cf0712601842785512e4a36ee8036e290c43f41c3044e755`.

Run awal `2026-10-20-browser-01` menghasilkan enam suite PASS dan auth FAIL karena redirect localhost pada transport pengujian. Bukti awal tetap disimpan. Transport auth diperbaiki dengan proxy loopback dan lulus pemeriksaan tersendiri (enam kelompok pemeriksaan, 19 screenshot). Tes pagination baru juga diperbaiki agar menunggu opsi hasil request sebelum menghitung DOM; ini sinkronisasi tes, bukan perubahan produk.

`npm run check` pada source lulus: lint/typecheck, 165 tes utama dan delapan tes data. Probe Playwright provider nyata lulus lima kelompok pemeriksaan, termasuk public pihak lain dan private yang telah disetujui pemilik, pada 20 Oktober pukul 00:53 WIB (`2026-10-19T17:53:55.387Z`), sebelum jeda limit. Hasil tersebut tersimpan di `artifacts/browser-provider/report.json`; bukan klaim login/provider live baru setelah jeda. Review kode independen meninjau cleanup, credential boundary, cakupan, direktori run eksklusif dan packaging.

Verifikasi akhir dari image worker `sha256:39ea116e74a33c456c9976f03ecb75e0b477669aeb10b02bf815c08281918fc2` lulus tanpa bind mount source: **7/7 suite PASS**, lima viewport, run `2026-10-20-browser-02` pada 20 Oktober 17:32–17:33 WIB. Laporan dan screenshot disalin ke `artifacts/browser-regression/2026-10-20-browser-02/`; laporan utama mencatat hash setiap script dan lockfile. Probe fondasi tambahan `npm run smoke` dari image yang sama juga lulus **16 pemeriksaan**; hasilnya berada di subdirektori `backend-probe/environment`. Probe Mermaid/PDF merupakan verifikasi dependency, bukan acceptance ekspor PDF produk. Scope produk yang belum tersedia tetap terpisah dari hasil regression.
