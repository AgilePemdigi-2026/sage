# GH-01 — Login GitHub App

Status 19 Oktober 2026: implementasi, pemeriksaan lokal, serta login/logout GitHub nyata **PASS**. App `SAGE-I2-iltizamhasan3` telah dibuat oleh pemilik akun; login browser berhasil sebagai `iltizamhasan3`, logout mencabut sesi, dan workspace menolak sesi yang sudah dicabut. Base implementasi `9792e95e349103be2f04d1875cd476fdef522f29`. Penanggung jawab paket/identitas commit: `iltizamhasan3`. Implementasi, pengujian, dan review kode terpisah dilakukan secara otomatis; bukan klaim review manual anggota.

## Perilaku

`POST /auth/github` memeriksa Origin, membuat state dan bukti browser acak 256-bit serta PKCE S256, lalu mengarahkan ke GitHub. Database hanya menyimpan hash state/bukti browser dan verifier terenkripsi AES-GCM. State berlaku 10 menit menurut waktu database dan hanya dapat dikonsumsi sekali, termasuk saat pengguna menolak akses. GET route login tidak membuat state.

Callback memakai endpoint GitHub tetap, menolak redirect provider, membatasi ukuran respons dan waktu fetch, memverifikasi identitas melalui `/user`, lalu menulis User, credential terenkripsi, dan session hash dalam satu transaksi. Tidak meminta scope email atau OAuth App tambahan. Cookie HttpOnly/SameSite=Lax menjadi Secure pada HTTPS; session dan credential paling lama delapan jam atau expiry provider yang lebih pendek. Refresh otomatis belum tersedia; pengguna login ulang setelah expiry.

Logout memakai POST dengan Origin tepercaya dan mencabut sesi lokal. Ia tidak memerlukan client secret provider. Kegagalan revokasi mempertahankan cookie agar pengguna dapat mencoba lagi; tidak dinyatakan sebagai logout berhasil. Pemilihan/instalasi repository dan pipeline analisis belum diaktifkan oleh paket ini.

## Expected dan actual

| Pemeriksaan | Expected | Actual |
| --- | --- | --- |
| `npm run check` | Lint, typecheck, dan seluruh unit suite lulus | PASS; 72 tes utama + 8 tes database pada Node 24 |
| `npm run build` | Production build dan route dinamis auth lulus tanpa App secret | PASS |
| `docker compose build` | Semua tes PHP/JS/TS dan build final web/worker berjalan dengan versi runtime yang sama | PASS; 80 tes juga lulus di stage build |
| Migrasi | Empat migrasi dapat diterapkan pada database kosong | PASS pada PostgreSQL terisolasi `sage_oauth05` |
| Drift schema | Schema Prisma sesuai database setelah migrasi | PASS; `No difference detected` |
| `npm run test:oauth:integration` | State/hash, browser binding, expiry, replay, PKCE, reconnect, credential/session storage benar | PASS; PostgreSQL nyata, delapan consumer serentak hanya satu menerima verifier |
| Rollback login | Kegagalan INSERT Session setelah penulisan User/credential membatalkan seluruh transaksi | PASS; trigger hanya untuk identitas fixture, kemudian dilepas; tidak ada User/credential/session tersisa |
| `npm run test:auth:http` | Endpoint Next pada image final menolak CSRF, wrong browser, denial/replay, serta mengakhiri sesi lokal | PASS; delapan pemeriksaan HTTP dengan PostgreSQL terisolasi |
| Callback HTTP | Denial kembali ke halaman login yang dapat dipulihkan tanpa memantulkan state | PASS; tidak menghubungi provider GitHub |
| Workspace/logout HTTP | Session sintetis dapat membuka workspace tanpa token di HTML; logout valid mencabut hash session | PASS; session dibuat oleh helper test, bukan login GitHub nyata |
| Bootstrap App | Form/izin minimum, state, error, `.env` ignore/tracked/symlink, mode 0600 dan merge aman | PASS; 11 tes dalam direktori Git sementara |
| Bootstrap HTTP lokal | Callback, malformed Unicode, penghentian server, dan penyimpanan konfigurasi bekerja | PASS; tujuh pemeriksaan dengan pertukaran manifest **palsu** dan `.env` sementara |
| Runtime final worker | PHP parser, fixture, database/heartbeat dan renderer SVG/PDF tetap bekerja | PASS; 16 pemeriksaan smoke pada image baru; ini kompatibilitas environment, bukan ekspor produk |
| Login/logout GitHub nyata | Callback provider membuat session; logout mencabutnya; workspace kembali meminta login | PASS; browser GitHub sebagai `iltizamhasan3`, credential terenkripsi tersimpan, satu session aktif setelah login menjadi nol setelah logout, `/workspace` mengarah ke `/login?error=session` |

## Lingkungan dan bukti

Node.js 24.22.0, PHP 8.4.26, PostgreSQL 17, Next.js 16.4.2, Prisma 7.10.1, Linux arm64. Integrasi memakai network/container database uji tanpa port database host; tidak memakai database aplikasi. Key enkripsi pengujian sintetis, bukan konfigurasi privat pengguna. Pemeriksaan login/logout provider nyata dilakukan terpisah pada aplikasi lokal dengan konfigurasi App privat; hanya metadata aman dicatat.

Bukti lokal yang diabaikan Git: `artifacts/gh-01/http-report.json`, `bootstrap-http-report.json`, `real-oauth-report.json`, dan `environment/report.json` beserta SVG/PDF smoke. Laporan provider nyata hanya memuat akun, URL App publik, dan status pemeriksaan; tidak menyimpan token, cookie, code, atau state. Log pemeriksaan ada pada `/tmp/sage-tools/5-*.log`. SHA-256 migrasi OAuth: `0d6429bc1526a86632707d5492e60b8c94e9c5cb336e20db0edd8ff5a6406db9`.

Review memperbaiki logout saat revokasi gagal, penolakan cookie duplikat, redirect fetch provider, validasi state Unicode, dan pemeriksaan ignore `.env` memakai Git sebenarnya. Build Docker sebelumnya tidak menyediakan PHP di stage pengujian; stage sekarang memakai PHP 8.4 + Node 24 serta vendor parser terkunci sebelum menjalankan seluruh suite, sementara runtime web tetap image Node terpisah.

## Prasyarat eksternal

Ikuti [setup GitHub App](GITHUB_APP_SETUP.md). Pembuatan App dan pemberian akses baru memerlukan konfirmasi pemilik akun. Secret/private key diterima callback dan disimpan langsung dalam `.env` privat; jangan dikirim melalui chat. Saat menyiapkan App publik, `Contents: read` dan `Metadata: read` menjadi izin minimum; pemasangan ke repository dipilih terpisah. Alur nyata sudah lulus sehingga PR dapat menutup #5 setelah review. Browser memakai grant yang tersedia; klik penolakan pada layar consent GitHub tidak diuji langsung. Denial/failure/replay tetap dibuktikan melalui pengujian unit, HTTP terkontrol, dan PostgreSQL. Instalasi repository merupakan scope #6.
