# Seed fixture QA-01

Source dibuat khusus untuk pengujian lokal dan tidak berasal dari repository private. `manifest.json` mencatat SHA-256, ukuran byte, hasil syntax yang diharapkan, serta draft evidence declaration/reference yang diturunkan dari pembacaan source. Expected fact dipilih terpisah dari output parser; lokasi byte/Unicode dihitung dari snippet literal.

Jalankan `npm run fixtures:verify` untuk memeriksa integritas hash/snippet/bounds. `npm run smoke` di worker menambah pemeriksaan syntax parser, diagram, dan PDF. Keduanya belum membandingkan CCM/graph semantik; ANA-03/04/05 masih terbuka.

File mengandung `throw`, konfigurasi executable, dan script Composer sebagai canary. Seluruh source diperlakukan sebagai data; jangan menjalankan file atau package manager dari folder fixture. Composer hanya dipakai untuk dependency adapter tepercaya pada `packages/analyzer-php/`.

Review tim belum dilakukan (`DRAFT_AWAITING_TEAM_REVIEW`). QA-01 tetap terbuka sampai oracle deklarasi/relasi lengkap, capability matrix, fixture berbahaya tambahan, dan benchmark representatif selesai. Angka waktu pada seed kecil bukan estimasi performa repository nyata.
