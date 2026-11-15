# REP-02 — Target immutable dan snapshot aman

Scope #8 mencakup submission terotorisasi, target full SHA persisten sebelum antrean, deduplikasi request, serta handler SNAPSHOT yang dapat dipakai runner tahap. Consumer pipeline sembilan tahap tetap #16; fitur ini tidak menyatakan analisis produk selesai.

## Kontrak implementasi

- `POST /api/analyses` menerima repository/branch/commit dan `Idempotency-Key`. Session menentukan pemilik; Origin, JSON maksimal 2 KiB dan field yang diizinkan diperiksa sebelum enqueue.
- GitHub memeriksa ulang target/izin. Full SHA, config/version, Analysis dan Job tersimpan atomik. Repository metadata global bukan grant akses.
- Key di-hash per pemilik. Request hash memakai payload kanonis sebelum resolve HEAD. Key/payload sama mengembalikan target asli dan status persisten; payload berbeda menghasilkan 409. Lock FIFO dan unique constraint mencegah duplikasi concurrent.
- Snapshot menggunakan SHA persisten, tidak membaca HEAD ulang. Izin akun/App diperiksa lagi dan numeric repository ID harus tetap sama. Token hanya dikirim ke API GitHub untuk private; redirect terbatas ke path codeload GitHub yang cocok, tanpa meneruskan Authorization.
- Batas: archive 25 MiB, extracted source 100 MiB, 2.000 file, entry/header terbatas, rasio source/archive 20, deadline snapshot 60 detik. Batas per-source dan exclusion ditangani #10; deadline seluruh pipeline/ekspor masih menunggu integrasi masing-masing.
- Tar dibaca sebagai data dengan tar-stream yang dipin. Path traversal/absolute/backslash/control, duplikasi/collision Unicode atau case, link/device dan tipe unsupported ditolak. Tidak ada checkout, dependency install, konfigurasi atau script target yang dieksekusi.
- SHA-256 archive dan tiap file dibedakan dari commit SHA Git. Arsip disimpan pada direktori privat acak, file 0600, dengan metadata owner/analysis di StorageObject. Output stage hanya referensi opaque dan ringkasan; source tidak disalin ke progress/log.
- Registrasi storage memerlukan claim/token/attempt/lease aktif dan stage SNAPSHOT RUNNING di bawah lock antrean. Klaim usang atau gagal menyebabkan file sementara dibersihkan. Pembacaan memeriksa owner/analysis, status, ukuran, checksum dan menolak symlink.

## Verifikasi dan batas bukti

19 Oktober 2026: lint/typecheck, 154 test utama + 8 test database, dua skenario integrasi PostgreSQL, build produksi web, serta probe live public/private dan submission HTTP lulus. Regresi insert 1,5 detik melampaui lease 1 detik membuktikan rollback, heartbeat gagal dan cleanup file. Build runtime worker diverifikasi bersama image web sebelum integrasi; 16 pemeriksaan smoke runtime (termasuk PHP dan Chromium/PDF) lulus, dan tiga service sehat.

`npm run check`, build Docker, `npm run test:snapshot:integration` pada database terisolasi `sage_snapshot08` dengan `SAGE_SNAPSHOT_TESTS=1`, dan `npm run test:snapshot:live` pada akun fixture yang sudah login. Jangan menjalankan fixture integrasi destruktif pada database aplikasi.

Probe live memakai `SAGE_TEST_LOGIN` dan `SAGE_TEST_PRIVATE_REPOSITORY`, membuat session/analysis sementara miliknya sendiri lalu membersihkannya. Laporan agregat berada di `artifacts/rep-02/` yang diabaikan Git. Credential dan source private tidak disalin ke laporan. Perubahan HEAD, concurrency, arsip berbahaya dan lease stale memakai fixture terkontrol; download public/private dan HTTP submission memakai GitHub asli. Handler/storage diuji melalui PostgreSQL terisolasi; consumer pipeline belum berjalan otomatis.

Referensi: [GitHub archive API](https://docs.github.com/en/rest/repos/contents?apiVersion=2026-03-10#download-a-repository-archive-tar), [tar-stream](https://github.com/mafintosh/tar-stream).
