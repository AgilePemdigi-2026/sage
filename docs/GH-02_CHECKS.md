# GH-02 — Akses repository

Implementasi daftar instalasi, repository instalasi, dan resolve public/private tersedia. **Acceptance private provider nyata belum dijalankan**: App saat pemeriksaan mengembalikan nol instalasi dan fixture private belum ditentukan. PR memakai `Refs #6`; issue tetap terbuka sampai private berizin/tanpa izin benar-benar diperiksa. Base `970bb7267c291b6a295107ecd4d68008f54e2daf`. Penanggung jawab paket/identitas commit `rizqy-fadhil`; implementasi, pengujian, dan review terpisah dilakukan secara otomatis.

## Perilaku dan batas

- Seluruh endpoint memakai session yang valid dan credential aktif milik user dari session; klien tidak memilih userId/connectionId/token.
- `/workspace/repositories` memisahkan daftar instalasi App dari input public. Public diperiksa tanpa Authorization; URL hanya menerima HTTPS github.com atau owner/name. Private diperiksa melalui daftar instalasi dan repository yang tersedia untuk user token, ditambah Contents read/write, instalasi tidak suspended, serta user pull permission.
- Record Repository/Installation lokal bukan bukti izin. Setiap request memeriksa GitHub; output hanya metadata aman. Tidak ada token pada UI, JSON, atau laporan.
- Endpoint fixed api.github.com, redirect ditolak, batas respons JSON 2 MiB dan timeout per request 10 detik. Setiap instance client memiliki budget 30 request/60 detik; scan resolve maksimal 10 halaman per koleksi. Scan terpotong dilaporkan unavailable, bukan hasil lengkap.
- Pagination 30 item/halaman; endpoint menerima halaman 1–100 dan `nextPage`. Resolve POST memakai Origin tepercaya, content type JSON dan payload maksimal 1 KiB. Input tidak valid tidak membuat job.
- Error Indonesia membedakan input, sesi, permission/not-found ambigu, rate limit, dan unavailable tanpa raw respons GitHub. Tidak melakukan retry otomatis pada rate limit.
- Link pengaturan App hanya membuka GitHub; pemilik akun menentukan sendiri instalasi dan repository. Tidak ada grant otomatis. Pemilihan branch/commit mengikuti #7, snapshot #8, consumer pipeline #16.

## Bukti

| Pemeriksaan | Hasil |
| --- | --- |
| Provider nyata: daftar instalasi | PASS, HTTP 200, nol instalasi |
| Provider nyata: public pihak lain `octocat/Hello-World` | PASS |
| Provider nyata: private berizin/tanpa izin | NOT_RUN, menunggu fixture dan instalasi pilihan pemilik |
| Unit boundary public/private/permission/rate limit/outage/SSRF | PASS |
| Handler Origin/session/input/payload/error aman | PASS |
| Build dan HTTP image final | PASS; Docker production build dengan 109 tes (101 utama + 8 DB), enam pemeriksaan HTTP |

Laporan lokal diabaikan Git: `artifacts/gh-02/live-report.json` dan `http-report.json`. Live probe server memakai credential existing yang terenkripsi; session HTTP dibuat sementara melalui helper server lalu dihapus. Ini dibedakan dari browser login nyata yang dibuktikan pada GH-01. Private/rate-limit/outage yang memakai stub tidak diklaim sebagai hasil provider nyata.

Perintah: `npm run check`, `docker compose build`; sesudah image terbaru berjalan, jalankan `SAGE_TEST_LOGIN=<akun> npm run test:repositories:live` dan `npm run test:repositories:http` pada runtime Node 24 dengan konfigurasi privat/DB lokal. Probe private tambahan menerima `SAGE_TEST_PRIVATE_REPOSITORY` hanya sesudah pemilik menentukan fixture. Jangan mengirim secret melalui chat atau commit.

## Referensi API

[Instalasi user token](https://docs.github.com/en/rest/apps/installations?apiVersion=2026-03-10), [repository](https://docs.github.com/en/rest/repos/repos?apiVersion=2026-03-10), dan [error/rate limit](https://docs.github.com/en/rest/using-the-rest-api/troubleshooting-the-rest-api). Endpoint `/repos/{owner}/{repo}/installation` memerlukan JWT App sehingga tidak dipakai untuk user access token.
