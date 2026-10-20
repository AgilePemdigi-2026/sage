# GH-03-S1 — Public milik akun dan isolasi pergantian sesi

Tanggal: 20 Oktober 2026. Penanggung jawab: Valentina (`liliks13`), issue [#68](https://github.com/AgilePemdigi-2026/sage/issues/68). Implementasi dan pengujian otomatis; review teknis serta merge melalui Iltizam.

## Temuan dan perubahan

Daftar sebelumnya hanya mengambil repository pada instalasi App. Daftar public milik akun belum tersedia. Query credential sudah terikat user dan tidak ditemukan bukti token kedua akun tercampur; UI tab yang tetap terbuka belum menginvalidasi daftar/target saat cookie akun berubah.

- `GET /api/repositories/public?page=1..100` memakai login dari koneksi sesi, bukan parameter owner. Provider hanya menerima permintaan ke API GitHub tetap tanpa token untuk daftar public, lalu server memfilter public dan pemilik yang sesuai serta menormalisasi metadata. Pagination divalidasi dan respons tidak di-cache.
- Public milik akun dimuat otomatis dengan pencarian pada halaman yang dimuat, pagination, retry dan pemilihan branch. Kegagalan/ketiadaan instalasi tidak menghalangi daftar public.
- `GET /api/auth/session` mengembalikan ID GitHub akun dan login tanpa credential. UI mengikat permintaan ke ID tersebut lewat `X-SAGE-Account`; cookie tetap sumber autentikasi. Header akun lama ditolak sebelum akses provider. Connection juga harus cocok dengan ID GitHub user.
- Tab memeriksa identitas saat fokus/visible dan berkala. Pergantian akun menghapus repository, branch, commit, target serta respons tertunda sebelum memuat ulang halaman. Fokus pada akun yang sama mempertahankan input target. Provider 401 untuk akun yang sama menampilkan aksi login ulang dan tidak menyebabkan loop reload.
- Daftar instalasi diberi label akses App/shared. Repository collaborator/organisasi yang benar-benar berizin tetap dapat muncul; ini berbeda dari daftar public milik akun.

Perilaku API mengikuti dokumentasi resmi [public repositories for a user](https://docs.github.com/en/rest/repos/repos#list-repositories-for-a-user) dan [installations accessible to the user](https://docs.github.com/en/rest/apps/installations#list-app-installations-accessible-to-the-user-access-token).

## Pengujian dan replay

```sh
docker compose build web worker
docker compose up -d --no-deps web
docker compose run --rm --no-deps worker npm run test:accounts:ui
docker compose run --rm --no-deps worker npm run test:browser
```

`test:accounts:ui` membuat identitas/credential sintetis terenkripsi dan sesi disposable; seluruh resource tersebut dibersihkan sesudah run. Identity endpoint, SSR guard dan penolakan backend memakai Next serta database nyata. Metadata repository/branch pada browser dikontrol; bukan bukti OAuth/GitHub live dua akun. Lima viewport: 360, 390, 768, 1024 dan 1440 px. Kasus mencakup identitas dua sesi, header akun lama, override owner, connection dengan ID berbeda, credential kedaluwarsa, public tanpa instalasi, input saat fokus tetap, perpindahan cookie serta respons akun lama yang terlambat.

`test:target:ui` memeriksa public pagination/direct selection, error/retry, provider 401 tanpa loop reload, instalasi/private terkontrol, branch/commit dan validasi target. Runner `test:browser` kini mencakup delapan suite, menambahkan isolasi akun pada tujuh suite QA-04 sebelumnya. Laporan run QA-04 awal tetap merupakan bukti historis tujuh suite.

Probe `test:provider:playwright` terpisah menggunakan akun existing yang masih memiliki otorisasi valid. Credential, payload private dan token sesi tidak ditulis ke bukti publik. Audit lokal hanya memeriksa metadata koneksi: ID user/connection kedua akun cocok; otorisasi Rizqy sudah kedaluwarsa ketika audit, sehingga diperlukan login ulang SAGE untuk probe provider nyata melalui akun tersebut. Tidak ada credential pengguna yang diganti untuk pengujian. Pemeriksaan read-only melalui GitHub CLI sebagai Rizqy juga mengembalikan `private: true` dan `permissions.pull: true` untuk fixture yang sudah diizinkan pemilik, `iltizamhasan3/sage`. Ini membuktikan izin baca akun di GitHub, bukan OAuth/App live baru sebagai Rizqy; repo tersebut boleh berada di bagian akses bersama, terpisah dari public milik akun sendiri.

## Hasil

Build Docker lulus: lint/typecheck, **169 tes utama + 8 tes data (177 total)**, dan kompilasi Next. Image web yang diuji: `sha256:6d21174b84c008fa29379ce7e89e22c6735cee9cfcd27d67e16cb5f568a365e1`; worker: `sha256:bf6056ca5e14513523f5e30784dcd20bf232d886c7d73e94a515c333de8b2629`.

Run source terbaru menggunakan bind mount ke worker Node 24, terhadap web production baru:

```sh
docker compose run --rm --no-deps -v "$PWD:/app" \
  -e STORAGE_ROOT=/app/artifacts -e QA_RUN_ID=2026-10-20-account-01 \
  worker npm run test:browser
```

Run tersebut mencatat **7 suite PASS dan repository-target FAIL** karena selector pencarian lama. Laporan awal tetap disimpan di `artifacts/browser-regression/2026-10-20-account-01/report.json`. Suite isolasi akun lulus pada kelima viewport, termasuk respons lama yang ditunda dan ditunggu penyelesaiannya. Replay target pertama menemukan selector alert ambigu dengan route announcer Next; selector tersebut diperbaiki tanpa perubahan runtime aplikasi. Replay kedua menemukan teks empty instalasi yang juga sudah berubah; selector disesuaikan. **Replay target terakhir PASS pada lima viewport** (`2026-10-20T10:58:18.506Z`), termasuk kasus provider 401 dengan identitas sama tanpa reload loop, public pagination dan direct selection. Bukti: `artifacts/account-target-replay-03/ui-report.json`. Ketujuh suite lain sudah PASS pada run aggregate; laporan aggregate awal tetap FAIL dan tidak ditimpa menjadi PASS. Seluruh pemeriksaan yang diwajibkan selesai melalui run awal serta replay terarah. Tidak ada build ulang tambahan setelah koreksi selector-only; tes replay memakai source terbaru melalui bind mount seperti perintah di atas.

Probe GitHub nyata melalui Playwright **6 kelompok PASS** pada `2026-10-20T10:56:55.884Z`: identitas sesi dan daftar public milik akun, header lama ditolak, akses instalasi, public pihak lain, branch/commit public dan private yang disetujui, serta tidak membuat job. Bukti: `artifacts/account-provider-live/report.json`. Review independen tidak menyisakan temuan material setelah perbaikan kasus provider 401.

## Batas

Memilih repo saat ini memuat branch dan memvalidasi target. Consumer pipeline analisis penuh belum aktif; perbaikan ini tidak mengklaim job sampai hasil graph/dokumen nyata, ekspor PDF atau history/delete sudah selesai. Mengganti akun GitHub di situs GitHub saja tidak mengganti cookie SAGE: keluar dari SAGE, lalu login GitHub melalui SAGE kembali.
