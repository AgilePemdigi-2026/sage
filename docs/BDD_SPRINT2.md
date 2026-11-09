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

Runner membuat container PostgreSQL miliknya sendiri dengan port loopback acak, menjalankan migrasi pada database disposable, membangun aplikasi production dari source saat ini, menyiapkan tiga corpus pada commit beku, lalu menjalankan Cucumber. Masing-masing suite browser memakai server Next, database, dan storage sementara yang sesuai. Suite ekspor/pipeline menggunakan worker sebenarnya. Container dan storage milik run dibersihkan setelah selesai; database aplikasi dan volume Compose tidak dipakai.

Laporan unik tersedia di `artifacts/bdd/sprint2-<timestamp>/`: `cucumber.html`, `cucumber.json`, TAP, laporan browser, screenshot, dan manifest runtime/hash. Run gagal tetap menyimpan bukti kegagalan. Untuk pemeriksaan kontrak saja:

```bash
npm run test:bdd:sprint2 -- --contracts-only
```

Mode tersebut menguji 24 kasus pendukung dan **bukan** acceptance semua skenario SRS.

Untuk mengulang seluruh workflow browser (15 skenario), gunakan `npm run test:bdd:sprint2 -- --browser-only`. Untuk satu kelompok yang sedang diperbaiki, misalnya dokumen, gunakan `npm run test:bdd:sprint2 -- --browser-case=document`. Pilihan lain: `graph`, `markdown`, `pdf`, `history`, dan `pipeline`. Hasil subset tetap dicatat sebagai subset, bukan full run.

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

`srs.feature` memuat 14 nama di atas. `srs-cases.json` menghubungkan tiap skenario ke checkpoint browser yang wajib hadir dalam laporan PASS. Skenario terkait berbagi satu eksekusi suite agar pengujian ekspor/worker yang mahal tidak diulang; ini bukan 14 lingkungan browser independen. Suite yang gagal menyebabkan seluruh skenario yang bergantung padanya gagal, tanpa retry otomatis atau skip. Pemeriksaan kontrak, database, live CLI, semantic workspace, dan pipeline tambahan ada di `acceptance.feature`.

## Penyesuaian terhadap contoh SRS

- Route aktual history adalah `/workspace/history`, pemilihan repository `/workspace/repositories`, dan progress `/analyses/{id}`. Tujuannya sama dengan contoh route SRS.
- Label aktual memakai `Code Knowledge`, `Cari node`, `Buka inspector node`, `Dokumentasi`, serta tindakan ekspor dan download terpisah. Keberhasilan dibuktikan oleh file unduhan, bukan sekadar pesan sukses.
- Contoh `Service` pada SRS dipetakan ke kategori AST aktual `Class`; SAGE tidak mengarang kategori AST bisnis baru. Fixture browser memakai deklarasi analyzer nyata dan query yang cocok dengan fixture tersebut.
- Hash canonical diverifikasi melalui API dan file; UI manusia menampilkan metadata ringkas serta evidence GitHub pada commit/rentang baris yang tepat.
- Pengujian error terkontrol ditandai jelas. Fault ekspor melewati worker sebenarnya; tes error UI tertentu mengintersep satu respons 503, kemudian retry kembali ke API sebenarnya.

## Hasil dan batas bukti

Run final 9 November 2026: **52/52 skenario, 154/154 langkah, tanpa skip**. Termasuk 14 skenario SRS, 24 kontrak, 10 integrasi PostgreSQL, dua probe CLI GitHub, satu semantic workspace, dan satu pipeline browser. Enam suite production browser berbagi eksekusi untuk checkpoint SRS terkait. [Manifest hasil final](evidence/BDD-Sprint2-2026-11-09.json) mencatat hash source yang diuji; base commit bukan klaim bahwa perubahan belum di-commit sudah berada di commit tersebut.

Verifikasi tambahan: **538 tes unit lulus**, typecheck dan production build lulus; lint tanpa error, dengan tiga warning React Hooks yang sudah ada. Perbaikan produk menambahkan bahasa source pada history dan pesan empty state sesuai SRS. Kegagalan awal pada skrip browser diperbaiki untuk mengikuti disclosure, pagination, metadata manusia, serta keyboard native Chromium; run final mengulang seluruh suite setelah perbaikan.

[Pemeriksaan OAuth live terpisah](evidence/BDD-Sprint2-live-oauth-2026-11-09.json) memakai Iltizam, GitHub asli, worker, serta unduhan PDF/Markdown. Delapan checkpoint lulus; run tersebut mendahului perbaikan tampilan history terakhir. Laporan browser terkontrol tidak diperlakukan sebagai bukti OAuth nyata. Keberhasilan pipeline dengan status `COMPLETED_WITH_LIMITATIONS` tidak menyatakan semua referensi dapat di-resolve atau semua perilaku aplikasi dikenali.

Suite ini tidak membuktikan deployment Coolify, backup restore, beban server bersama, atau login OAuth sebagai Rizqy. Credential GitHub tidak masuk Git. CLI Rizqy digunakan untuk commit/push; login aplikasi pada pemeriksaan live menggunakan Iltizam sesuai arahan pengguna.
