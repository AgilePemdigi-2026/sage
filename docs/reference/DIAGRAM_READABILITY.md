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

### Pemeriksaan image lokal

Build worker awal gagal saat instalasi Chromium karena filesystem VM Docker 30 GiB penuh; signature checking tetap diaktifkan. Pembersihan dibatasi pada cache build yang tidak terpakai serta tiga image QA lama yang tidak digunakan container (`sage-bdd-f076bbb11d-bdd`, `sage-bdd-8c8ba75b3f-bdd`, `sage-graph18-qa`). Image runtime/rollback dan volume tetap disimpan; resource limit tidak dinaikkan. Build web final menggunakan Dockerfile normal dan mencakup kembali 477+8 tes serta build produksi.

Build worker ulang juga lulus dengan Dockerfile normal. Smoke import extractor 0.2.0 sempat ditolak `ENOSPC` setelah unpack image; setelah cache build dibersihkan (2,977 GB), smoke import lulus tanpa jaringan pada 512 MiB/1 CPU. Image web: `sha256:4400740476905b6d36c9c998ba23b1ac43fc0ab387f39f0ec19547d3e5c862bd`; worker: `sha256:fca5a79c53789a52b5ff90fe0f3932b5d41d51011f1c9cc84a7d0035d5f3cfbc`. Ini verifikasi ARM64 lokal, bukan deployment atau bukti kapasitas produksi.

## Koreksi tampilan awal setelah PR #115

Screenshot Emosync menunjukkan bahwa tes setelah expand tidak membuktikan keterbacaan saat pertama dibuka. Snapshot memiliki 350 edge tetapi tidak ada direct edge feature-ke-feature. Proyeksi lama membuang actor/store/middleware bersama dengan `featureId: null`; default collapsed kemudian menghasilkan frame tanpa hubungan. Ini kegagalan presentasi, bukan ketiadaan semua fakta source.

Overview baru menampilkan aktor/services bersama di kiri, ringkasan endpoint/controller dalam feature frame di tengah, dan domain/data store di kanan. Pada mobile aktor tampil di atas fitur; data lane dapat dipan secara internal. Panah feature frame adalah agregasi hubungan ke/dari anggota source, bukan node aktivitas atau urutan bisnis baru. Setiap panah menyimpan ID edge serta pasangan endpoint source asli, confidence, alasan dan evidence commit. Pemakaian data store bersama tidak membuat hubungan panggilan antarfitur. Branch/validation detail tetap pada detailed flow. Frame dan jalur utama tidak memerlukan expand.

Hasil tersimpan yang sudah memiliki model semantik bisa memakai overview baru tanpa analisis ulang. Tidak ada perubahan extractor, skema database, worker, atau hasil ekspor pada koreksi ini. Archify tetap menjadi referensi pengarang diagram/source evidence dan vocabulary visual; ini bukan integrasi layanan AI atau pengganti engine dengan agent Archify.

Referensi aktor/store/concept yang berlabel sama dapat dikelompokkan pada tampilan dengan nama dan jumlah referensi. Ini bukan penggabungan identitas canonical atau pembuktian satu database. ID node asal, pasangan endpoint edge, confidence, serta evidence tetap utuh. Label pada jalur padat dibuka melalui focus/inspector agar tidak menimpa card; semua panah tetap terlihat.

| Source snapshot tersimpan | Fitur | Elemen visual | Panah agregat | Relasi source diwakili / total |
| --- | ---: | ---: | ---: | ---: |
| Emosync | 14 | 26 | 38 | 149 / 350 |
| Perpus | 17 | 38 | 67 | 189 / 653 |
| SAGE | 14 | 31 | 37 | 91 / 218 |

Angka ini mengukur proyeksi tampilan, bukan ekstraksi baru atau penambahan fakta. Relasi internal tersisa tersedia pada detailed flow/evidence. SAGE snapshot ini tidak mengenali node store; renderer tidak menambahkan datastore buatan.

### Verifikasi koreksi tampilan awal

Pada source product `06df140`, typecheck dan Playwright lengkap lulus (GET=21/PATCH=7 pada API fixture). Pemeriksaan tanpa klik mencakup Emosync flow/graph pada desktop 1440×1000 dan mobile 390×844, serta Perpus/SAGE flow/graph mobile. Tes memakai intersection dengan jendela browser sebenarnya, bukan hanya canvas; aktor/service, fitur dan garis awal terlihat. Label aktor muat dalam card, lane heading tidak menimpa card, path menghindari card lain, dan label edge tidak saling menimpa atau tertutup card. Koreksi/reset, konflik revisi, keyboard, zoom/filter, evidence besar, isolasi akun serta fallback graph teknis tetap diuji.

Screenshot: `artifacts/semantic-workspace/connected-overview-20261101/`. Corpus adalah model hasil analyzer tersimpan pada commit beku dengan API fixture terkontrol; run ini tidak mengeksekusi analyzer/worker baru atau OAuth/database live. Semua 485 tes unit dan 8 tes database unit lokal lulus; semantic BDD 3 scenario/17 step lulus. Lint memiliki 0 error dan 3 warning hook-dependency yang sudah ada pada detailed renderer.

SHA-256 sumber yang dipakai screenshot: overview TSX `960bc52f352a24bf56edf59e58d0faf6e28cd2d6d7a1077d0fc0c63a7b92b678`, CSS `8493a30635642d9ffb65dae2d36b0b92fcef3750652a1deed64981fb87319941`, projection `8916dcd38f2d3a6d62d0a68e1f20584c41ade44399e6c595b30d6339b9ab1297`.
