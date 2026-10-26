# Verifikasi inspector dan source evidence GRAPH-03

Issue [#19](https://github.com/AgilePemdigi-2026/sage/issues/19), requirement SAGE-FR-GRAPH-06/07/08/09/10, APP-11, NFR-02 dan T-GRAPH-03. Base `de37213a61fe5ef0ceeeaec810f7c21d5732cd63`. Pengiriman: Valentina (`liliks13`); review/merge: Iltizam (`iltizamhasan3`).

## Scope

Inspector hasil analisis menampilkan node yang dipilih, lokasi dan bounds AST, relasi incoming/outgoing beserta resolution/reason serta evidence canonical. Source preview berasal dari archive snapshot analisis yang sama; pembacaan canonical/hash tetap memeriksa pemilik dan status publikasi sebelum akses archive. Endpoint source menerima ID berkas canonical, bukan path atau URL dari pengguna.

Query/filter graph tetap merupakan subset tampilan; relasi inspector berasal dari hasil canonical lengkap sehingga relasi yang tidak sedang dirender tetap dapat ditelusuri. Node tanpa deklarasi source menampilkan kondisi unavailable yang jelas. Source bukan kode yang dijalankan atau HTML yang dirender.

## Verifikasi

Verifikasi 27 Oktober 2026 selesai pada content commit `b704958ffed46272dcccdd9d5d356e0ef4b8324f` (commit berikutnya hanya dokumentasi/bukti).

- Lint, typecheck root/web, 311 tes utama, 8 tes data, dan production build lulus. Setelah perbaikan CSS nomor baris, lint dan production build dijalankan kembali.
- Image final `sha256:d36ef503b951491741017229861a90d50a42160356e06a8ac8893ffa5af78b20` diuji dengan Next production dan PostgreSQL 17.11 sementara. Skrip browser final dipasang read-only, lalu lulus lint/typecheck sebelum dijalankan.
- Playwright/API: 25 kelompok lulus, nol kegagalan, nol browser page errors, nol request provider; viewport 360/390/768/1024/1440.
- API memeriksa node/relasi canonical, ownership sebelum storage, binding akun, status, query ketat, header privat, archive rusak, serta teks source BOM/Unicode/CRLF dan hash kedua berkas. Unit reader mencakup batas 200 baris/128 KiB.
- Browser memeriksa pemilihan keyboard dan klik canvas nyata, inspector/source, nomor baris, Escape dan pengembalian fokus, unresolved tanpa request source, retry 503, respons node terlambat, dan pergantian akun saat dialog terbuka.
- Source menyorot seluruh baris evidence, bukan substring byte/kolom; bounds AST tetap ditampilkan. Relasi inspector tidak terpotong oleh filter graph.

Laporan lokal final: `artifacts/graph-19/2026-10-27-run3/report.json`; screenshot inspector/source tersedia pada folder yang sama. Ringkasan dan fingerprint terlacak: [evidence JSON](evidence/GRAPH-03-2026-10-27.json). Container, database sementara dan network pengujian sudah dihapus.

Dua run browser awal berhenti setelah 15 kelompok pada asumsi koordinat/sinkronisasi klik canvas desktop. Visual QA juga menemukan nomor baris tertutup CSS reset; styling diperbaiki, kemudian run final memakai posisi render Cytoscape dan klik mouse nyata setelah layout stabil. Akses `_cyreg.cy` hanya untuk membaca posisi dalam tes, terikat versi dependency; pemilihan tidak dipicu secara programatis. Riwayat run gagal tetap disimpan, dan assertion klik tidak dilewati.

## Batas bukti

Fixture browser dibuat oleh adapter TypeScript nyata dan disimpan langsung sebagai canonical bundle serta archive pada PostgreSQL sementara. Ini menguji pembacaan hasil tersimpan, ownership, inspector dan source; bukan OAuth GitHub nyata atau run baru pipeline sembilan tahap. Kasus kegagalan/respons tertunda yang dikendalikan browser harus ditandai terpisah dari pembacaan API sukses. Signoff formal tim terhadap oracle analyzer tetap mengikuti QA-01 #4.
