# Final demo dan replay regression

Panduan final untuk #28. Penerimaan regression dan review akhir dicatat pada FIN-01_CHECKS.md, FIN-03_CHECKS.md dan FIN-04_CHECKS.md; penutupan mengikuti review PR final.

## Demo aplikasi

Buka https://sage.caiis.ai.id melalui HTTPS. Hubungkan GitHub, pilih repository dan commit/branch yang diizinkan, lalu submit analisis. Setelah pipeline selesai, buka Code Knowledge sebagai visual pendamping dan pilih **Generate ADD** untuk membuat baseline Data Architecture serta Application Architecture. Periksa katalog, ArchiMate views, relasi, limitations, dan evidence yang menunjuk ke commit analisis. Ekspor Markdown atau LaTeX, atau gunakan print-to-PDF dari halaman ADD. Source LaTeX berhasil dikompilasi dengan Tectonic menjadi fixture A4 19 halaman; halaman diagram dan catalog perwakilan sudah diperiksa, dengan warning overfull-box kecil tetapi tanpa clipping yang terlihat. Pemeriksaan ini belum mencakup semua repository/output. PDF dibuat melalui browser print dan bukan hasil kompilasi LaTeX. Gunakan history untuk menemukan analisis tersebut. Jangan menghapus analisis orang lain atau data produksi untuk demo.

Hasil kosong pada model semantik tidak berarti repository tidak memiliki alur: framework/pola source harus didukung. Snapshot besar dapat menghasilkan error ukuran ekspor; jangan menyebut job gagal sebagai file berhasil. Source evidence dan resolver Exact/Unresolved tetap berbeda dari keyakinan semantik Proven/Indicated.

## Replay lokal terisolasi

Gunakan dependency proyek dan Node 24 sesuai `package.json`. Jalankan dari root checkout, dengan Docker/Colima serta browser Playwright tersedia. CLI GitHub harus memiliki akses ke fixture yang secara eksplisit diizinkan.

```sh
colima start --profile sage
docker context use colima-sage
gh auth switch --hostname github.com --user rizqy-fadhil
SAGE_BDD_PRIVATE_REPOSITORY=iltizamhasan3/sage npm run test:bdd:sprint2
gh auth switch --hostname github.com --user iltizamhasan3
```

Runner membuat database/storage sementara dan membersihkan resource miliknya. Ini tidak menyalakan stack aplikasi utama. Jangan memakai database produksi sebagai pengganti database disposable. OAuth live memakai akun Iltizam sebagai pemeriksaan terpisah; sesi sintetis pada BDD tidak membuktikan login provider nyata.

Buka `cucumber.html` pada direktori run terbaru di `artifacts/bdd/sprint2-<timestamp>/`. Simpan hasil gagal, jalankan retest pada direktori baru, dan catat keduanya. Pemeriksaan provider saja dapat diulang dengan:

```sh
SAGE_BDD_PRIVATE_REPOSITORY=iltizamhasan3/sage SAGE_BDD_REPORT_DIR=artifacts/bdd/provider-retest-baru node --import tsx node_modules/@cucumber/cucumber/bin/cucumber.js --config cucumber-sprint2.mjs --tags @live_cli
```

Suite dijalankan pada 15 November 2026 tanpa parameter fixture private; command di atas menyertakan parameter yang diperlukan untuk replay. Retest provider menggunakan parameter tersebut dan lulus. Run penuh: 56/57 lulus karena parameter fixture private terlewat; retest provider: 2/2 lulus. Host run memakai Node 26.4.0, sehingga replay pada Node 24 tetap diperlukan untuk acceptance environment resmi. Ini bukan satu run penuh yang bersih.

Jika Docker hanya dinyalakan untuk QA ini dan tidak dipakai pekerjaan lain, `colima stop --profile sage` menghentikan VM tanpa menghapus volume. Jangan menghentikan Docker bersama ketika proses lain masih berjalan.

## Replay final yang lulus

Run bersih pada Node 24.22.3, application commit `43a48340477c824cf98fc792a232794796276b84`, memakai command lengkap di atas dan akun CLI Rizqy: **57 skenario / 220 langkah lulus, tanpa skip**. Folder bukti: `artifacts/bdd/sprint2-2026-11-15T10-47-22-227Z`; manifest aman ada di [FIN-03 final](../evidence/FIN-03-final-20261115.json). Laporan gagal awal tetap disimpan sebagai riwayat.

Demo otomatis melalui real Next/database/worker mencakup submit target, kemajuan analisis, hasil graph/dokumen, ekspor Markdown/PDF, error/retry, history dan deletion pada data disposable. Provider aplikasi memakai fixture dan sesi sintetis; provider public/private CLI memakai API GitHub nyata. Ini bukan login OAuth baru pada produksi. OAuth produksi dan kapasitas server bersama tidak diklaim oleh regression lokal ini.

Matriks lima viewport dan 12 halaman PDF sampel diterima pada [FIN-04](../archive/release/FIN-04_CHECKS.md). Resource/worker diterima pada [FIN-01](../archive/release/FIN-01_CHECKS.md). Batas analyzer dan error ekspor ukuran besar tetap dijelaskan kepada pengguna. Tidak ada perubahan deployment Coolify dalam paket ini.
