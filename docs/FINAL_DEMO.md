# Final demo dan replay regression

Refs #28. Panduan ini belum merupakan signoff final: #27, #39 dan #40 tetap menjadi dependensi penerimaan.

## Demo aplikasi

Buka https://sage.caiis.ai.id melalui HTTPS. Hubungkan GitHub, pilih repository dan commit/branch yang diizinkan, lalu submit analisis. Tunggu pipeline mencapai hasil; buka Code Knowledge untuk komponen/dependency dan Software Engineering Diagram untuk alur yang dikenali. Periksa evidence file/baris pada commit analisis, lalu ekspor Markdown/PDF. Periksa status job ekspor sampai selesai sebelum mengunduh. Gunakan history untuk menemukan analisis tersebut. Jangan menghapus analisis orang lain atau data produksi untuk demo.

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

Command suite dan retest di atas benar-benar dijalankan pada 15 November 2026. Run penuh: 56/57 lulus karena parameter fixture private terlewat; retest provider: 2/2 lulus. Host run memakai Node 26.4.0, sehingga replay pada Node 24 tetap diperlukan untuk acceptance environment resmi. Ini bukan satu run penuh yang bersih.

Jika Docker hanya dinyalakan untuk QA ini dan tidak dipakai pekerjaan lain, `colima stop --profile sage` menghentikan VM tanpa menghapus volume. Jangan menghentikan Docker bersama ketika proses lain masih berjalan.
