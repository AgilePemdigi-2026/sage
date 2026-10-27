# DATA-02 — Penghapusan analisis dan cleanup storage

Issue: [#23](https://github.com/AgilePemdigi-2026/sage/issues/23). Base implementasi: `3c7b6676f75dd7dc4e090ddd72da92affcf856be`.

## Perilaku

Pemilik menghapus analisis terminal dari history melalui konfirmasi eksplisit. API menolak analisis atau ekspor aktif. Tombstone hasil dan manifest cleanup disimpan atomik sebelum `202`; graph, source, dokumen, download, dan retry analisis kemudian ditolak. History tetap menampilkan status pending/failed agar retry tersedia setelah reload. Satu cleanup job dipakai kembali; `204` hanya diberikan setelah cleanup selesai.

Worker menghapus file terdaftar dan terreservasi, lalu folder kosong, sebelum menghapus record turunan. Token/attempt/lease mengikuti waktu database. Kegagalan menghasilkan `FAILED`; DELETE ulang mengantrekan job yang sama. Claim kedaluwarsa menjadi failed yang dapat dicoba lagi, tanpa memberikan claim lama hak menerbitkan hasil. Retry child, user lain, akun/session, dan metadata repository global tetap ada.

Penulis snapshot dan ekspor mereservasi path sebelum menulis byte, termasuk path ekspor sementara `.pending`. Ini menutup celah crash sebelum file terdaftar di StorageObject. Tidak ada sweep rekursif, penghapusan otomatis berdasarkan umur, atau penebakan kepemilikan file lama.

## Pemeriksaan terisolasi

Gunakan Node 24, dependency lock repository, PostgreSQL 17, production build Next.js, worker aplikasi, dan Chromium Playwright. Suite destructive memerlukan `SAGE_CLEANUP_TESTS=1` dan database **tepat** `sage_cleanup23`; storage harus direktori sementara privat. Database/volume aplikasi pengguna tidak digunakan.

```sh
npm run db:generate
npm run typecheck
npm test
npm run test:data
npm run db:migrate
npm run test:cleanup:integration
npm run build
```

Untuk browser, jalankan production Next dan worker dengan `DATABASE_URL`, `STORAGE_ROOT`, dan konfigurasi test-only yang sama. Set `AUTH_BASE_URL=http://127.0.0.1:3000`, `SAGE_CLEANUP_BASE_URL=http://127.0.0.1:3000`, dan `SAGE_CLEANUP_ARTIFACT_DIR` ke direktori bukti baru, kemudian `npm run test:cleanup:live`. Jangan salin session, key atau konfigurasi privat ke Git. Script menyiapkan akun/session dan file sintetis, lalu membersihkan fixture miliknya.

| Kelompok | Pemeriksaan |
| --- | --- |
| API | Session, akun lama, origin, body kosong/batas ukuran, owner 404, job privat, kode error aman, replay 204 |
| Database | Penolakan analisis/ekspor aktif, tombstone atomik, manifest storage/reservasi, retry child, FK/cascade, kelengkapan sebelum complete, stale lease/token, pemulihan dan retry job yang sama |
| Storage | Exact generated key, file hilang idempotent, traversal/symlink ditolak, file asing tidak disentuh, folder tak kosong menyebabkan retry |
| UI | Konfirmasi/batal, status pending/failed, retry, row target dihapus setelah complete, respons lama setelah pergantian akun dibuang |
| Browser | API/worker/PostgreSQL nyata; history pada 390 × 844 dan 1440 × 960; symlink failure dan retry dengan canary di luar storage tetap utuh |
| Regresi | Pipeline snapshot dan ekspor Markdown/PDF memakai reservasi baru tanpa mengubah keluaran canonical |

## Hasil aktual — 27 Oktober 2026

Source terverifikasi: `c0d70945b9f9a08bca7fddc98beafe97d8bb3cee`. Semua pemeriksaan berikut lulus tanpa skipped:

- Full ESLint, TypeScript root/web, dan production build.
- 350 tes utama + 8 tes fondasi database.
- 3 integrasi cleanup PostgreSQL; 2 integrasi pipeline; 2 integrasi Markdown (termasuk writer kedaluwarsa yang dilanjutkan setelah cleanup); 1 integrasi PDF.
- Browser cleanup: 6 kelompok; Markdown: 20 kelompok; PDF: 15 kelompok.

Browser cleanup memakai enam analisis sintetis/dua akun, dua cleanup job, satu kegagalan symlink terkontrol, dan satu retry. Hasil: archive, ekspor Markdown, file `.pending`, dan row turunan hilang sebelum status selesai; retry child serta canary akun lain/di luar storage tetap utuh. Dua temuan review PR (urutan mkdir/reservasi dan retry setelah polling timeout) diperbaiki serta dilindungi regresi.

Lingkungan: Node 24.22.0, PostgreSQL 17, Next 16.4.2, Prisma 7.10.1, Playwright 1.64.1. [Ringkasan bukti aman](evidence/DATA-02-2026-10-27.json) mencatat jumlah tes, source commit/hash dan batas. Laporan dan screenshot lokal tersimpan di `artifacts/cleanup23/run1` yang diabaikan Git. Run fixture awal sempat gagal pada setup queue sequence/lease, urutan teardown FK, dan koneksi GitHub sintetis; perbaikannya tidak melonggarkan guard produk. Pemeriksaan final di atas dijalankan setelah perbaikan.

## Batas

- Browser memakai session dan input sintetis, tidak membuktikan OAuth/izin GitHub live atau beban produksi multi-kelompok.
- Respons/byte yang sudah diterima client sebelum delete tidak dapat ditarik kembali. Reader file memeriksa tombstone sebelum dan setelah I/O.
- File legacy tanpa metadata/reservasi tidak disapu otomatis; key tidak dikenal memerlukan tindakan operator yang eksplisit. Penghapusan backup eksternal mengikuti kebijakan operator.
- Satu tombstone CLEANUP minimal tetap disimpan untuk status/idempotensi; manifest dan relasi analysis dihapus setelah sukses.
- Penghapusan ini tidak melakukan deduplikasi canonical graph/document atau menjamin ukuran file database langsung menyusut. Batas resource Coolify dan benchmark beban tetap pekerjaan sebelum deployment.
