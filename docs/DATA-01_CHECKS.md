# Pemeriksaan DATA-01

Tanggal: 18 Oktober 2026, Asia/Jakarta. Issue [#3](https://github.com/AgilePemdigi-2026/sage/issues/3); requirement `APP-01`, `APP-05`, `NFR-05`; test ID `T-DATA-01`. Base implementasi: `ca7827406e1170d07298210c6993d94b25a27568`; full SHA perubahan dicatat pada PR. Penanggung jawab/pengirim: Zarra (`zarrrafirdaus`). Verifier aktual: Node test runner, Prisma, TypeScript, ESLint, dan pemeriksaan PostgreSQL di bawah; review penerimaan dan merge masih menunggu.

## Hasil aktual

| Pemeriksaan | Expected | Actual |
| --- | --- | --- |
| Migrasi database kosong | Dua migrasi membuat fondasi + 15 tabel produk | PASS |
| Upgrade dari heartbeat ENV-01 | Migrasi DATA-01 dapat ditambahkan | PASS |
| Diff database terhadap schema final | Tidak ada drift pada kedua database | PASS |
| `npm run check` | Lint, typecheck root/web, unit/integrity lulus | PASS: 10 baseline + 8 unit DATA |
| `npm run test:data:integration` | Dua user, sesi, kredensial, constraint PostgreSQL | PASS: satu kelompok integrasi nyata |
| `npm run build` | Build produksi Next.js berhasil | PASS |
| Seed → recreate container DB → check | Data dan credential tetap tersedia | PASS |
| Setup `.env` dan Compose | Key aman, konfigurasi lama bertahan, Compose valid | PASS |
| `git diff --check` | Tidak ada kesalahan whitespace | PASS |

Pengujian berjalan pada Docker Linux arm64, Node 24.22.0, npm 11.17.0, Prisma 7.10.1 dan PostgreSQL 17.11. Integration test memakai fixture sintetis dua pengguna yang berbagi repository publik. Seluruh lookup hasil dibatasi pemilik; cross-owner child ditolak dengan FK PostgreSQL `P2003`, dan unique constraint diuji sebagai `P2002`. Ini bukan hasil analisis repository GitHub nyata.

Session mengembalikan token acak 256-bit saat dibuat dan menyimpan hash saja; expiry/revocation diuji. Kredensial diuji untuk ciphertext, nonce/tag, pemilik/konteks, tampering, key tidak valid, expiry/revocation, refresh/reconnect, dan penolakan owner kosong. Key dari environment server tidak disimpan di database atau dipublikasikan ke browser. OAuth/cookie/CSRF HTTP tetap GH-01.

Persistensi diuji dengan menghapus dan membuat ulang **container database uji**, sambil mempertahankan named volume. Sebelum cleanup fixture, dump konten database (baris kontrol acak pg_dump dikecualikan) memiliki SHA-256 yang identik sebelum dan sesudah recreate: `f0c7b09e52aa6c3bf5699e20a64f5cd5475a618d4afc66bb4bb610ff359d02d7`. Sesudah restart, helper membaca user, analysis, metadata file, graph, tiga artefak dokumen sintetis, hash sesi dan mendekripsi token; fixture lalu dihapus. Bukti terstruktur dan hash input tersedia pada [evidence JSON](evidence/DATA-01-2026-10-18.json).

Setup diperiksa pada direktori uji terpisah: `.env` baru memiliki key 32 byte dan mode 0600, pemanggilan ulang tidak mengubah nilai, upgrade mempertahankan password/port, serta symlink ditolak. Perbaikan selama verifikasi mencakup nama delegate Prisma `gitHubConnection`/`gitHubInstallation`, owner guard runtime, replacement token dengan ID stabil, dan tiga kolom artefak yang sesuai SAGE.

## Mengulang pengujian

Untuk unit/build: gunakan Node 24, jalankan `npm ci`, `npm run db:generate`, `npm run check`, lalu `npm run build`. Untuk pengujian database, siapkan PostgreSQL terisolasi dengan nama `sage_data01` atau `sage_data01_fresh`, `SAGE_DATABASE_TESTS=1`, `DATABASE_URL`, serta `CREDENTIAL_ENCRYPTION_KEY` acak base64 32 byte pada file environment privat di luar Git. Jangan menunjuk stack/data pengguna.

Image pengembangan yang memiliki dependency terkunci dapat dibuat dengan `docker build --target build -t sage-data-tests:local .`. Sambungkan image ini dan PostgreSQL uji pada network Docker terpisah. Command aktual memakai environment privat tersebut:

```sh
npm run db:migrate
npm run test:data:integration
node --import tsx scripts/data-check.ts seed
# Buat ulang container PostgreSQL uji dengan named volume dan key yang sama.
node --import tsx scripts/data-check.ts check
```

`STORAGE_ROOT` untuk fase persistensi harus menunjuk volume/direktori uji yang bertahan antarfase. Script menolak database di luar allowlist; marker hanya berisi ID fixture. Migrasi diulang pada database kosong dan database yang sudah memiliki migrasi heartbeat. Bandingkan schema dengan `prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code` dari workspace database.

## Batas dan tindak lanjut

Schema menyediakan ownership/FK dan penyimpanan; model saja tidak membuktikan sembilan tahap analisis, lock queue global (#9), snapshot aman (#8), cleanup/deletion (#23), atau otorisasi filesystem. Isi JSON graph/dokumen dan publikasi bundle atomik tetap memerlukan implementasi generator/validator terkait. Primitive session/credential belum menyediakan login GitHub HTTP (#5). Perubahan key tunggal memerlukan reautentikasi/re-enkripsi; rotasi multi-key transparan belum tersedia.

Sesudah merge, jalankan `npm run setup:local` sebelum rebuild/start Compose agar `.env` lama mendapat key tanpa mengganti password. SQL dan schema di-commit bersama, migrasi lama dipertahankan, dan database uji terpisah dari stack aplikasi lokal.
