# Sprint 2 Cucumber BDD

Suite ini menguji 14 skenario sumber SRS **B.7.4–B.7.6** dalam Gherkin berbahasa Inggris, dengan parameter berpetik dua. Pemeriksaan teknis pendukung diberi tag terpisah; ID `T-*` pada test plan bukan nomor skenario SRS.

## Menjalankan suite

Gunakan Node.js 24 sesuai `engines`, dependency dari `npm ci`, PHP lokal, GitHub CLI, Docker/Colima, dan Chromium Playwright yang sudah terpasang. Akun CLI untuk run ini adalah Rizqy. OAuth aplikasi memakai Iltizam dan merupakan pemeriksaan live terpisah.

```bash
colima start --profile sage
docker context use colima-sage
gh auth switch --hostname github.com --user rizqy-fadhil
SAGE_BDD_PRIVATE_REPOSITORY=iltizamhasan3/sage npm run test:bdd:sprint2
gh auth switch --hostname github.com --user iltizamhasan3
colima stop --profile sage
```

Fixture private tersebut sudah diizinkan untuk project ini. Untuk penggunaan lain, isi variabel hanya dengan repository private yang memang diizinkan dan dapat dibaca akun penguji. Jangan memasukkan token ke command atau laporan. Langkah OAuth live tidak dijalankan otomatis oleh command BDD ini: runner memakai session sintetis untuk tes deterministik dan tidak menyalin credential aplikasi.

Runner membuat container PostgreSQL miliknya sendiri dengan port loopback acak, menjalankan migrasi pada database disposable, membangun aplikasi production dari source saat ini, menyiapkan tiga corpus pada commit beku, lalu menjalankan Cucumber. Ke-14 skenario SRS memakai server Next, worker, database, dan storage sementara bersama, dengan akun, analisis, serta browser context tersendiri per skenario. Suite browser pendukung memakai server/database/storage sementara masing-masing. Suite ekspor/pipeline menggunakan worker sebenarnya. Container dan storage milik run dibersihkan setelah selesai; database aplikasi dan volume Compose tidak dipakai.

Laporan unik tersedia di `artifacts/bdd/sprint2-<timestamp>/`: `cucumber.html`, `cucumber.json`, TAP, laporan browser, screenshot, dan manifest runtime/hash. Run gagal tetap menyimpan bukti kegagalan. Untuk pemeriksaan kontrak saja:

```bash
npm run test:bdd:sprint2 -- --contracts-only
```

Mode tersebut menguji 24 kasus pendukung dan **bukan** acceptance semua skenario SRS.

Untuk mengulang seluruh workflow browser (15 skenario), gunakan `npm run test:bdd:sprint2 -- --browser-only`. Untuk satu kelompok yang sedang diperbaiki, misalnya dokumen, gunakan `npm run test:bdd:sprint2 -- --browser-case=document`. Pilihan lain: `graph`, `markdown`, `pdf`, `history`, dan `pipeline`. Hasil subset tetap dicatat sebagai subset, bukan full run.

## Contoh penulisan seperti Sprint 1

```gherkin
Scenario: [SRS B.7.4.2] Search nodes in Knowledge Graph
  Given I am signed in as a synthetic owner with a completed analysis
  And I am viewing the completed analysis on "Code Knowledge"
  When I press the button "Detail AST"
  And I fill in "Cari node" with "Endpoint"
  Then the available focus nodes should match "Endpoint"
```

`Background` di file feature menyiapkan akun/snapshot untuk setiap skenario, bukan sekali untuk seluruh feature. Semua judul membawa referensi SRS; teks UI tetap mengikuti label aplikasi yang aktual. Pada skenario export error, worker tes dijeda saat POST enqueue, checksum archive disposable diubah, lalu worker dilanjutkan agar kegagalan berasal dari consumer sebenarnya. Checksum dipulihkan sebelum pengguna menekan retry.

## Pemetaan skenario sumber

| SRS | Skenario Gherkin | Bukti yang dieksekusi |
| --- | --- | --- |
| B.7.4.1 | Display Code Knowledge Graph | Graph asli dari API/PostgreSQL; context snapshot dan render lima ukuran; fresh live run membuka graph dari progress selesai |
| B.7.4.2 | Search nodes in Knowledge Graph | Query node dengan keyboard, hitungan dan opsi fokus konsisten |
| B.7.4.3 | Filter nodes by AST category | Query AND jenis AST, API canonical tetap utuh |
| B.7.4.4 | View node details | Inspector, lokasi canonical, direct relations, immutable source evidence; canvas click dan keyboard |
| B.7.4.5 | Node not found | Query tanpa hasil, reset, dan graph kosong |
| B.7.5.1 | Open Architecture Definition Document | API dokumen, snapshot, katalog, evidence link, navigasi graph–dokumen, keyboard dan diagram |
| B.7.5.2 | Successfully export documentation to PDF | POST asli, worker, browser download, tipe/signature PDF dan SHA-256 |
| B.7.5.3 | Successfully export documentation to Markdown | POST asli, worker, browser download, SHA-256 dan kesamaan renderer canonical |
| B.7.5.4 | Document generation fails and is retried | Kerusakan checksum fixture membuat worker gagal; checksum dipulihkan; retry asli menghasilkan PDF valid |
| B.7.6.1 | Display analysis history | Repository, branch, commit, bahasa source, status, tanggal; lima ukuran |
| B.7.6.2 | Search analysis history | Search, pagination 22 record, dan reset melalui API owner-scoped |
| B.7.6.3 | Open completed analysis details | Buka record selesai, lalu tautan graph dan dokumentasi tersedia |
| B.7.6.4 | Analysis history not found | Search tanpa hasil menghilangkan record lama dan memberi feedback |
| B.7.6.5 | No saved analysis history | History kosong milik user baru; tindakan membuka pemilihan repository |

`graph.feature`, `document.feature`, dan `history.feature` memuat 14 skenario SRS dengan judul `[SRS B.7.x.y]`, langkah pengguna berbahasa Inggris, serta nilai UI aktual berpetik dua. `Given` menyiapkan pemilik sintetis dan snapshot canonical, `When` menjalankan aksi Playwright langsung, dan `Then` memeriksa UI/hasil aktual. Setiap skenario memiliki pemilik, analisis, dan browser context sendiri; server Next, database disposable, dan worker dipakai bersama dalam run. Tidak ada cache hasil suite untuk meluluskan langkah SRS. Screenshot tiap skenario dilampirkan dalam laporan Cucumber.

`srs-cases.json` hanya mengindeks judul dan kelompok untuk menghitung subset. Pemeriksaan kontrak, database, live CLI, semantic workspace, pipeline dan lima regresi browser yang lebih luas tetap ada di `acceptance.feature` sebagai supporting checks. Supporting checks tersebut dapat berbagi eksekusi regresi, tetapi tidak digunakan sebagai pengganti langkah SRS.

## Penyesuaian terhadap contoh SRS

- Route aktual history adalah `/workspace/history`, pemilihan repository `/workspace/repositories`, dan progress `/analyses/{id}`. Tujuannya sama dengan contoh route SRS.
- Label aktual memakai `Code Knowledge`, `Cari node`, `Buka inspector node`, `Dokumentasi`, serta tindakan ekspor dan download terpisah. Keberhasilan dibuktikan oleh file unduhan, bukan sekadar pesan sukses.
- Contoh `Service` pada SRS dipetakan ke kategori AST aktual `Class`; SAGE tidak mengarang kategori AST bisnis baru. Fixture browser memakai deklarasi analyzer nyata dan query yang cocok dengan fixture tersebut.
- Hash canonical diverifikasi melalui API dan file; UI manusia menampilkan metadata ringkas serta evidence GitHub pada commit/rentang baris yang tepat.
- Pengujian error terkontrol ditandai jelas. Fault ekspor melewati worker sebenarnya; tes error UI tertentu mengintersep satu respons 503, kemudian retry kembali ke API sebenarnya.

## Hasil revisi Gherkin

Run lengkap pada source commit `490d77d`: **57/57 skenario, 220/220 langkah, tanpa skip**. Di dalamnya ada **14 skenario SRS / 98 langkah**, serta 43 supporting checks. Lima supporting regression browser ditambahkan agar coverage luas sebelumnya tetap berjalan setelah skenario SRS beralih ke interaksi langsung. Typecheck dan production build lulus; lint tanpa error dengan tiga warning React Hooks yang sudah ada. [Manifest revisi](evidence/BDD-Sprint2-Gherkin-2026-11-09.json) mencatat hash dan cakupannya.

Laporan full run tersimpan di `artifacts/bdd/sprint2-2026-11-09T03-17-09-036Z/cucumber.html`. Laporan `cucumber-srs.html` pada direktori yang sama hanya menampilkan tiga feature / 14 skenario SRS dari eksekusi tersebut; hasil dan screenshot dipertahankan. Dalam laporan lengkap, filter tag `@srs` untuk menyembunyikan supporting checks. Ini bukan pengujian OAuth live baru.

Review independen menemukan cleanup yang dapat terlewati saat proses dihentikan. Handler idempoten sekarang menutup Chromium, melanjutkan worker yang sedang dijeda sebelum terminasi, menunggu proses selesai, serta menghapus storage sementara. Tes lifecycle dengan Next/worker/PostgreSQL nyata lulus untuk **SIGTERM normal** dan **SIGINT saat worker berstatus stopped**; kedua kasus memastikan PID service sudah hilang dan folder sementara sudah dihapus. Command: `node --import tsx scripts/test-bdd-fixture-lifecycle.ts` (Node 24, Docker, production build tersedia; macOS/Linux). Full run 57 skenario di atas diulang setelah fix tersebut.

Run awal untuk step baru menemukan kontrak lokasi archive fixture, heading aktual, tab dokumen yang perlu dibuka, dan penempatan fault yang harus sesudah enqueue. Semuanya diperbaiki; run lengkap di atas mengulang source yang sudah stabil. Laporan run gagal tetap tersedia lokal.

## Hasil sebelumnya dan batas bukti

Run sebelum revisi penulisan 9 November 2026: **52/52 skenario, 154/154 langkah, tanpa skip**. Termasuk 14 skenario SRS, 24 kontrak, 10 integrasi PostgreSQL, dua probe CLI GitHub, satu semantic workspace, dan satu pipeline browser. Enam suite production browser berbagi eksekusi untuk checkpoint SRS terkait. [Manifest hasil final](evidence/BDD-Sprint2-2026-11-09.json) mencatat hash source yang diuji; base commit bukan klaim bahwa perubahan belum di-commit sudah berada di commit tersebut.

Verifikasi tambahan: **538 tes unit lulus**, typecheck dan production build lulus; lint tanpa error, dengan tiga warning React Hooks yang sudah ada. Perbaikan produk menambahkan bahasa source pada history dan pesan empty state sesuai SRS. Kegagalan awal pada skrip browser diperbaiki untuk mengikuti disclosure, pagination, metadata manusia, serta keyboard native Chromium; run final mengulang seluruh suite setelah perbaikan.

[Pemeriksaan OAuth live terpisah](evidence/BDD-Sprint2-live-oauth-2026-11-09.json) memakai Iltizam, GitHub asli, worker, serta unduhan PDF/Markdown. Delapan checkpoint lulus; run tersebut mendahului perbaikan tampilan history terakhir. Laporan browser terkontrol tidak diperlakukan sebagai bukti OAuth nyata. Keberhasilan pipeline dengan status `COMPLETED_WITH_LIMITATIONS` tidak menyatakan semua referensi dapat di-resolve atau semua perilaku aplikasi dikenali.

Review independen menemukan label cakupan subset yang terlalu luas pada manifest runner. Label tersebut sudah diperbaiki dengan `mode`, `browserCase`, dan scope sesuai pilihan run; keempat kombinasi metadata diperiksa. Setelah perubahan metadata saja ini, subset dokumen diulang: **1/1 skenario, 3/3 langkah lulus**. Full run 52 skenario di atas mendahului koreksi metadata runner tersebut.

Suite ini tidak membuktikan deployment Coolify, backup restore, beban server bersama, atau login OAuth sebagai Rizqy. Credential GitHub tidak masuk Git. CLI Rizqy digunakan untuk commit/push; login aplikasi pada pemeriksaan live menggunakan Iltizam sesuai arahan pengguna.
