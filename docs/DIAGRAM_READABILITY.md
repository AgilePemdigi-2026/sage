# Revisi keterbacaan diagram

## Audit referensi

Referensi: [Archify](https://github.com/tt-a1i/archify), ditinjau pada commit `a4065941f12be7967436261d9934784e381d423c` (1 November 2026).

Archify menggunakan agent untuk membaca source dan menyusun diagram JSON, lalu memvalidasi serta merender hasilnya. Ia bukan analyzer AST mandiri yang dapat langsung menggantikan extractor SAGE. Peninjauan ini tidak memasang skill Archify, menyalin renderer, atau menambahkan layanan AI ke pipeline.

Prinsip yang digunakan dari [repository authoring](https://github.com/tt-a1i/archify/blob/a4065941f12be7967436261d9934784e381d423c/archify/references/repository-authoring.md) dan [design](https://github.com/tt-a1i/archify/blob/a4065941f12be7967436261d9934784e381d423c/DESIGN.md): mulai dari entry point, telusuri hubungan yang benar-benar terhubung hingga operasi/hasil, catat evidence pada source, pertahankan ketidakpastian, dan buka detail setelah pengguna memilih bagian yang ingin dipelajari.

## Masalah sebelumnya

- Diagram interaktif memotong kumpulan node menjadi jendela 24 node. Edge dengan endpoint di jendela berbeda tidak terlihat; potongan tersebut tidak selalu merupakan satu alur bermakna.
- Penempatan empat kolom tetap tidak mengikuti lebar alur. Graph memperlakukan cluster dan anaknya sebagai baris tabel.
- Diagram tidak otomatis menyesuaikan lebar saat alur dipilih; pembaca harus merapikan viewport sendiri.
- Istilah seperti “ikhtisar” dan terjemahan status resolver mengaburkan istilah yang digunakan developer.

## Arah visual yang direvisi

Arahan terbaru pengguna pada 1 November 2026 menggantikan persyaratan bentuk lingkaran sebelumnya. Feature/domain ditampilkan sebagai kelompok tanggung jawab dengan architecture card yang dapat diperluas, label yang terbaca, dan hubungan berarah dari source. Bentuk lingkaran dan orbit tidak menjadi kriteria penerimaan. Flow tetap membedakan actor/action, decision, komponen dan outcome; posisi bukan bukti urutan eksekusi.

## Batas kontrak

Perbaikan tampilan tidak mengubah fakta canonical, evidence, kepemilikan akun atau revisi overlay. Label source tetap utuh; istilah kontrol mengikuti [bahasa antarmuka](UI_LANGUAGE.md). Analisis lama tidak otomatis memperoleh hasil extractor versi baru: jalankan analisis ulang.

Alur statis bukan simulasi runtime lengkap. Closure yang hanya dideklarasikan bukan bukti suatu aktivitas telah dijalankan. Dukungan framework masih terbatas pada pola yang diuji; tidak menyatakan kesetaraan kemampuan pemahaman agent Archify.

PDF tetap menggunakan halaman A4 dan aturan kepadatan sendiri; perubahan continuous canvas berlaku untuk frontend. Batas ekspor besar pada [issue #113](https://github.com/AgilePemdigi-2026/sage/issues/113) tetap terbuka sampai ada pengujian ekspor baru yang lulus. Tidak ada perubahan Coolify pada revisi ini.

## Pemeriksaan 1 November 2026

- `npm run check` pada Node 24.11.0: lint, TypeScript, 477 tes unit dan 8 tes database unit lulus. Ini bukan tes database/provider live.
- `npm run test:bdd:semantic`: 3 scenario dan 17 step lulus (Gherkin Inggris dengan parameter berpetik).
- Reviewer independen: 48/48 tes Next.js/Laravel lulus, termasuk query variable Emosync, deferred closure/arrow/function, reassignment dan unknown-call escape.
- Ekstraksi baru pada tiga source snapshot beku, container 2 GiB/1,5 CPU tanpa jaringan, dengan development source overlay yang mempertahankan dependency image: seluruhnya lulus. Oracle evidence/claim terbatas: 39/39. Log/model baru berada di `artifacts/semantic/readability-20261101/`.

| Corpus | Source analysis | Semantic extraction | Feature / node / edge |
| --- | ---: | ---: | ---: |
| Perpus | 2,86 s | 0,89 s | 17 / 616 / 653 |
| SAGE | 145,93 s | 1,59 s | 14 / 192 / 218 |
| Emosync | 2,09 s | 0,16 s | 14 / 233 / 350 |

Pengukuran ini source-only; tidak mengulang ekspor lengkap dan tidak mengubah hasil gagal ekspor besar pada #113. Angka waktunya khusus mesin/run ini, bukan jaminan latensi produksi. Model Perpus yang digunakan tes browser untuk penilaian visual adalah hasil source tersimpan; API browser dikendalikan fixture dan tidak menjalankan OAuth/provider/database live.

### Browser dan pemeriksaan visual

Playwright lulus pada 1440×1000 dan 390×844 menggunakan API fixture terkontrol serta model Perpus hasil ekstraksi baru di atas (616 node, 653 edge, 17 fitur; source commit tetap beku). Run browser memakai ulang JSON hasil ekstraksi tersebut, tidak menjalankan ulang analyzer atau OAuth live. Pemeriksaan mencakup topology alur utuh/cycle, actor/entry yang terlihat setelah fit, feature/child card yang terlihat setelah perluasan, text bounds, manual zoom, keyboard, overlay conflict, pergantian akun dan fallback saat graph teknis tidak tersedia.

Jalur hubungan termasuk yang Indicated diperiksa melalui computed style `fill: none`, sehingga kurva tidak menghasilkan bidang hitam yang menutup diagram. Bukti screenshot diperiksa secara visual; group yang lebar pada mobile tetap menggunakan pan internal agar label terbaca. Daftar fallback fitur/evidence tertutup secara default dan tidak memaksa scroll halaman saat group dipilih. Respons fixture tercatat GET=9/PATCH=7, bukan hitungan endpoint produksi yang telah diuji.

Source UI yang diuji memiliki SHA-256 TSX `8f84dc13f1b758024d0f6d593d4c9300c60f7187cf73cfbb6c75dede699e4943` dan CSS `a8d619d0489d74dfec95c966082df9fd27d180bc43c82ef615032f0301a2fdba`; hash sama sebelum/sesudah run. Screenshot: `artifacts/semantic-workspace/readability-20261101/`.

Hubungan antar-child dalam fitur menggunakan gutter antarkolom. Tes browser mengambil sampel sepanjang path SVG dan menolak path yang masuk ke card lain selain endpoint, pada Books sintetis serta Perpus desktop/mobile. Pemeriksaan ini tidak menyatakan semua hubungan lintas fitur bebas dari persilangan.
