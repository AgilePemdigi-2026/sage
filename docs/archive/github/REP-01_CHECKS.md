# REP-01 — Pemilihan target repository

Scope #7: pencarian repository yang sudah dimuat, pemilihan branch aktual dan commit opsional, serta validasi ulang izin dan riwayat branch. Validasi ini tidak membuat analysis/job; submission dan snapshot immutable berada pada REP-02.

## Perilaku

- `/workspace/repositories` memerlukan session aktif. Daftar instalasi/repository mengikuti GH-02; public pihak lain dapat dimasukkan melalui slug atau URL GitHub.
- Pencarian diberi label sesuai cakupan halaman yang sudah dimuat. Pagination tetap tersedia.
- Branch berasal dari GitHub, termasuk branch dengan slash. Repository tanpa branch menampilkan state kosong; kegagalan menyediakan muat ulang.
- Commit kosong memakai full SHA HEAD branch yang dibaca pada request. Prefix 7–40 heksadesimal atau SHA 64 karakter harus tidak ambigu, terselesaikan ke full SHA, dan berada pada riwayat branch tersebut.
- Pergantian repository/branch/commit membatalkan hasil validasi lama. Cursor direset ketika berganti pilihan agar halaman lama tidak terbawa saat request gagal.
- Target hanya metadata aman; access token tetap server-side. Origin, payload terbatas, query, session dan izin diperiksa. Error provider tidak diteruskan mentah.

## Verifikasi

19 Oktober 2026: build produksi Docker lulus; enam pemeriksaan HTTP dengan provider/private fixture asli dan lima skenario viewport UI lulus. Lint dan typecheck lulus; suite utama 120 test dan suite database 8 test lulus (128 total). Review independen memeriksa respons GitHub aktual dan memperbaiki field merge-base serta pagination numeric repository sebelum acceptance.

Jalankan `npm run check`, build web Docker, `npm run test:target:http` dan `npm run test:target:ui` di lingkungan Docker Node 24. Probe HTTP/UI membutuhkan akun fixture yang sudah login; `SAGE_TEST_LOGIN` hanya nama akun, bukan credential. Probe membuat session sementara melalui helper server dan menghapusnya setelah selesai.

- Unit client mencakup public/private, branch slash, HEAD/prefix/full SHA, commit di luar branch, ambigu, repository kosong, respons provider rusak, pagination canonical GitHub, dan penolakan input.
- Handler mencakup session, Origin, payload asing/terlalu besar, query/pagination, serta error tanpa secret.
- Probe HTTP memakai GitHub asli untuk branch dan commit, termasuk fixture private berizin. Jumlah analysis sebelum/sesudah harus sama.
- Probe UI memakai halaman produksi dan respons API terkontrol pada lebar 360, 390, 768, 1024 dan 1440; memeriksa pencarian, pemilihan, reset target, error/retry, empty, overflow, dan error JavaScript.

Bukti lokal disimpan pada `artifacts/rep-01/` yang diabaikan Git. Respons API terkontrol pada uji UI bukan bukti provider asli; probe HTTP adalah bukti provider. Pengujian commit di luar branch dan respons ambigu memakai fixture terkontrol. Tidak ada source private yang disalin ke laporan.
