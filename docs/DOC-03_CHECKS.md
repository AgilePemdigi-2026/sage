# Pemeriksaan README dan use flow

Tanggal: 20 Oktober 2026. Paket DOC-03, issue [#62](https://github.com/AgilePemdigi-2026/sage/issues/62), penanggung jawab Rizqy (`rizqy-fadhil`).

## Perubahan

Emoji dekoratif dihapus dari judul, tabel, navigasi dan teks. Pembuka menggunakan judul, ringkasan, sepuluh logo teknologi lokal dan tautan dokumentasi yang terpusat; tidak memakai badge statistik/fitur yang belum dibuktikan. Rincian implementasi tetap tersedia dalam bagian yang dapat dibuka agar status preview dan consumer nonaktif tetap jelas.

Flowchart Mermaid memisahkan login/izin repository/pemilihan target/full SHA yang tersedia dari pipeline dan hasil yang masih menunggu integrasi Sprint 2. Queue/API sudah ada, tetapi pemilih target belum memanggil submission dan consumer belum aktif. Perapian README tidak mengubah acceptance backend.

Panduan Docker menjelaskan `docker compose stop`, `docker compose start`, serta penggunaan `up` untuk container yang belum dibuat atau telah dihapus. Saat web berhenti, localhost SAGE tidak tersedia; Docker Desktop/Colima boleh tetap aktif. Perintah stop mempertahankan data volume. Layanan yang sedang berjalan tidak dihentikan untuk pemeriksaan dokumentasi ini.

## Referensi yang diperiksa

- [AppFlowy README](https://github.com/AppFlowy-IO/AppFlowy/blob/main/README.md): hierarki pembuka, ringkasan dan navigasi terpusat; teks/klaim/emoji proyek tersebut tidak disalin.
- [Supabase README](https://github.com/supabase/supabase/blob/master/README.md): ringkasan produk, diagram penjelas dan rujukan dokumentasi.
- Docker Docs: [compose stop](https://docs.docker.com/reference/cli/docker/compose/stop/) dan [compose start](https://docs.docker.com/reference/cli/docker/compose/start/).

## Verifikasi

README diproses melalui GitHub Markdown API (`gfm`) untuk memeriksa HTML yang disanitasi. Hasil ditinjau di Chromium pada 390 dan 1440 px dengan stylesheet lokal; diagram dirender memakai Mermaid yang dipin dalam project. Ini preview HTML tersanitasi dengan CSS pemeriksaan lokal, bukan klaim pemeriksaan UI GitHub langsung.

Pemeriksaan mencakup judul terpusat, sepuluh logo termuat, diagram sembilan node valid, tidak ada overflow dokumen atau error JavaScript, tidak ada emoji dekoratif, path aset/tautan lokal valid, dan `git diff --check`. Screenshot, SVG hasil render dan laporan berada di `artifacts/doc-03` yang diabaikan Git. Tidak ada perubahan runtime, sehingga tes backend tidak diulang.
