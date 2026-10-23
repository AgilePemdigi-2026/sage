# Acceptance Cucumber BDD Sprint 1

Dokumen ini mencatat contoh acceptance Gherkin yang ditambahkan untuk Sprint 1. Cakupannya adalah alur browser dengan API terkendali, pemeriksaan domain source, antrean PostgreSQL, dan kontrak runner tahap. Ini adalah bukti verifikasi tambahan yang dikerjakan pada 23 Oktober 2026 sebagai bagian dari [issue #82](https://github.com/AgilePemdigi-2026/sage/issues/82), bukan catatan bahwa pekerjaan tersebut sudah terjadi pada tanggal Sprint 1.

## Batas suite

Skenario browser menggunakan session sintetis dan respons API yang dikendalikan. Request ke origin lain diblokir; suite tidak membuktikan OAuth, izin repository, atau metadata GitHub nyata. Skenario domain membaca snapshot fixture statis. Tes runner memakai sembilan handler uji tepercaya untuk menguji urutan dan persistensi stage; hasilnya tidak berarti consumer pipeline, graph, atau dokumen produk telah diterima. Tes antrean dan runner memerlukan PostgreSQL disposable bernama `sage_bdd_sprint1`; fixture yang dibuat suite dibersihkan per skenario.

Contoh BDD ini memberi bukti pada sebagian kontrak yang dirujuk. Ia tidak menutup keseluruhan `T-*`, acceptance backlog, QA-01 signoff, atau gate release `T-REL-01`. Run terverifikasi pada 23 Oktober 2026: **PASS — 18 skenario, 108 langkah** pada Node.js 24.22.0, PostgreSQL 17, PHP 8.4.26, dan Chromium headless. Run `2026-10-23T14-19-08-140Z` menjalankan server Next.js production serta database uji terpisah. Laporan lokal tersimpan di `artifacts/bdd/<run-id>/`; direktori tersebut diabaikan Git. Dry-run terpisah mengenali 18 skenario/108 langkah dengan status `VALIDATED_ONLY`. Lint, typecheck, 292 tes utama, dan 8 tes data juga lulus. Guard menolak database selain `sage_bdd_sprint1` sebelum akses data; pemilihan tag tanpa skenario ditolak agar tidak menghasilkan bukti PASS kosong. Replay Docker `2026-10-23T14-23-50-467Z` juga lulus 18/108 dan membersihkan project uji otomatis. Kontrol negatif port 3000 yang sudah terpakai ditolak sebelum migrasi; kontrol positif konfigurasi Composer valid berhasil menulis canary ketika hook sengaja dijalankan di container terpisah.

## Menjalankan

Gunakan Node.js versi `>=24.11.0 <25` dan dependency project yang sudah dipasang.

| Command | Kebutuhan | Arti hasil |
| --- | --- | --- |
| `npm run test:bdd:dry` | Tidak memerlukan database atau browser | Memeriksa parsing feature/step dengan dry-run; tidak menjalankan assertion perilaku. Status laporan `VALIDATED_ONLY`. |
| `npm run test:bdd` | `SAGE_BDD_TESTS=1`, `DATABASE_URL` menuju DB disposable `sage_bdd_sprint1` yang sudah dimigrasikan, dan server Next.js tersedia di `SAGE_BDD_BASE_URL` | Menjalankan skenario browser dan domain pada layanan yang dituju. `AUTH_BASE_URL` dan `SAGE_BDD_BASE_URL` harus sama-sama menunjuk ke origin HTTP loopback yang sama. `DATABASE_URL` dan `CREDENTIAL_ENCRYPTION_KEY` juga harus sama untuk Next.js dan runner. Gunakan hanya DB/key uji khusus. |
| `npm run test:bdd:docker` | Docker Compose tersedia | Membuat project Compose bernama unik, menjalankan DB disposable, membangun target BDD, lalu menjalankan server production lokal di container runner tanpa host port. Project, volume dan network milik run ini dibersihkan setelah selesai. |

Untuk mode langsung, siapkan file privat lokal `.env.bdd.local` (diabaikan Git) berisi konfigurasi khusus test: `DATABASE_URL` dengan nama `sage_bdd_sprint1`, `AUTH_BASE_URL` dan `SAGE_BDD_BASE_URL` ke origin loopback yang sama, serta `CREDENTIAL_ENCRYPTION_KEY` test-only. Gunakan key 32 byte Base64 dan source file yang sama sebelum menjalankan Next.js production server serta runner, sehingga keduanya membaca database, origin, dan key yang sama. Jangan menyalin nilai key ke dokumentasi atau chat.

Contoh mode langsung:

```sh
set -a
. ./.env.bdd.local
set +a
export SAGE_BDD_TESTS=1
npm run test:bdd
```

Runner menolak database dengan nama selain `sage_bdd_sprint1`. Mode langsung tidak memigrasikan database atau menyalakan server; siapkan database uji dan server production terlebih dahulu. Mode Docker membuat nilai AUTH/key sintetis khusus di dalam runner dan menyiapkan database serta server sendiri. Jangan arahkan suite ke database atau aplikasi pengguna.

Setiap run membuat folder baru di `artifacts/bdd/<run-id>` dan tidak menimpa laporan lama. Laporan Cucumber HTML/JSON dan `run.json` menyimpan mode, status, kode keluar, versi Node, hash lockfile, commit aplikasi bila tersedia, serta batas suite. Kegagalan browser dapat menyertakan screenshot tanpa cookie, header, token, atau URL callback. Artefak ini merupakan bukti run tersebut; daftar skenario atau dry-run sendiri bukan bukti lulus.

## Tag dan traceability

- `@sprint1` memilih cakupan default. `@browser`, `@domain`, `@database`, dan `@controlled` menjelaskan jenis boundary utama; `@database` menandai pemeriksaan state queue/runner, sementara skenario browser juga memakai DB hanya untuk fixture session/OAuth.
- `@US_*` adalah label user story lokal yang diturunkan untuk mengelompokkan contoh acceptance di suite ini. Label itu bukan ID user story asli dari SRS dan tidak menyatakan pekerjaan Sprint 1 selesai secara retrospektif.
- `@SAGE_FR_*` menulis ID normatif SRS dengan underscore agar mudah digunakan sebagai tag; tabel di bawah menampilkan ID kanonis `SAGE-FR-*`.
- Tag `@issue_*` pada fitur berlaku untuk semua skenario di file tersebut; tag pada skenario berlaku hanya untuk skenario itu. Nomor issue merujuk backlog GitHub dan bukan ID SRS.
- `Positif`, `Alternatif/pemulihan`, dan `Gagal/guard` menjelaskan jenis contoh yang dicakup, bukan hasil run.

| Fitur dan skenario | User story lokal | ID SRS kanonis | Issue | Kasus test plan | Jenis contoh |
| --- | --- | --- | --- | --- | --- |
| [github.feature](../tests/bdd/features/github.feature) — callback penolakan yang aman dan retry login | `@US_GH_01` | SAGE-FR-GH-01, SAGE-FR-GH-03, SAGE-FR-GH-08, SAGE-FR-GH-10 | #5 | T-GH-02 | Alternatif/pemulihan |
| [ui.feature](../tests/bdd/features/ui.feature) — workspace mengarahkan pengguna tanpa session ke login | `@US_GH_01` | SAGE-FR-GH-09 | #5 | T-GH-02 | Gagal/guard |
| [repository.feature](../tests/bdd/features/repository.feature) — daftar public/private terotorisasi dan pencarian tanpa hasil | `@US_REP_01` | SAGE-FR-REP-01, SAGE-FR-REP-02, SAGE-FR-REP-13, SAGE-FR-GH-05, SAGE-FR-GH-06 | #7, #66 | T-GH-03, T-REP-01 | Positif + alternatif |
| [repository.feature](../tests/bdd/features/repository.feature) — branch terpilih, commit kosong atau full SHA eksplisit | `@US_REP_02` | SAGE-FR-REP-05, SAGE-FR-REP-06, SAGE-FR-REP-07, SAGE-FR-REP-08, SAGE-FR-REP-09 | #7, #66 | T-REP-01, T-REP-02 | Positif + alternatif |
| [repository.feature](../tests/bdd/features/repository.feature) — kegagalan branch/validasi target dan retry | `@US_REP_02` | SAGE-FR-REP-05, SAGE-FR-REP-09 | #7, #66 | T-REP-01, T-REP-02 | Alternatif/pemulihan |
| [repository.feature](../tests/bdd/features/repository.feature) — kegagalan daftar repository public dan retry | `@US_REP_01` | SAGE-FR-REP-01, SAGE-FR-GH-05 | #7, #66 | T-GH-03, T-REP-01 | Alternatif/pemulihan |
| [repository.feature](../tests/bdd/features/repository.feature) — repository tanpa branch menahan validasi sampai reload | `@US_REP_02` | SAGE-FR-REP-05, SAGE-FR-REP-09 | #7, #66 | T-REP-01, T-REP-02 | Alternatif/guard |
| [repository.feature](../tests/bdd/features/repository.feature) — session berganti dan daftar akun lama dibersihkan | `@US_REP_01` | SAGE-FR-REP-01, SAGE-FR-GH-05 | #7, #66 | T-GH-03, T-REP-01 | Gagal/guard |
| [source.feature](../tests/bdd/features/source.feature) — adapter JavaScript dan PHP menghasilkan CCM yang tervalidasi | `@US_AnalyzeSource` | SAGE-FR-ANA-04 | #33, #34 | T-ANA-03 | Positif |
| [source.feature](../tests/bdd/features/source.feature) — source terdukung diproses dan generated/metadata/dependency dikecualikan | `@US_DetectAndExcludeSource` | SAGE-FR-ANA-03, SAGE-FR-ANA-12 | #10 | T-ANA-05 | Alternatif/policy |
| [source.feature](../tests/bdd/features/source.feature) — file valid tetap diproses ketika sibling syntax-invalid | `@US_PartialAnalysis` | SAGE-FR-ANA-13 | #10, #33, #34 | T-ANA-05 | Alternatif/parsial |
| [source.feature](../tests/bdd/features/source.feature) — konfigurasi Composer tidak dieksekusi | `@US_SafeSourceAnalysis` | SAGE-FR-ANA-12 | #10 | T-SEC-01 | Gagal/guard |
| [queue.feature](../tests/bdd/features/queue.feature) — dua pemilik memakai satu slot global dan FIFO | `@US_QueueAnalysis` | SAGE-FR-REP-11 | #9 | T-ANA-01 | Positif/concurrency |
| [queue.feature](../tests/bdd/features/queue.feature) — replay idempotency mempertahankan full SHA dan tetap owner-scoped | `@US_IdempotentAnalysisSubmission` | SAGE-FR-REP-11 | #8 | T-REP-02, T-ANA-01 | Alternatif/replay |
| [queue.feature](../tests/bdd/features/queue.feature) — lease lama tidak dapat mengubah job baru | `@US_QueueLeaseSafety` | SAGE-FR-REP-11 | #9 | T-ANA-01, T-ANA-06 | Gagal/guard |
| [runner.feature](../tests/bdd/features/runner.feature) — sembilan handler uji dipersistenkan berurutan | `@US_TrackAnalysisProgress` | SAGE-FR-REP-12, SAGE-FR-ANA-11 | #35 | T-ANA-02 | Positif |
| [runner.feature](../tests/bdd/features/runner.feature) — kegagalan handler menghentikan stage downstream | `@US_TrackAnalysisProgress` | SAGE-FR-REP-12, SAGE-FR-ANA-11, SAGE-FR-ANA-13 | #35 | T-ANA-02, T-ANA-05 | Gagal/propagasi |
| [runner.feature](../tests/bdd/features/runner.feature) — lease kedaluwarsa mencegah handler stale berjalan | `@US_QueueLeaseSafety` | SAGE-FR-REP-12, SAGE-FR-ANA-11 | #35 | T-ANA-02, T-ANA-06 | Gagal/guard |

Sumber tag dan nama skenario adalah berkas `.feature`; bila skenario berubah, perbarui baris traceability ini. Untuk SRS kanonis, backlog dan acceptance sistem lengkap, lihat [requirement traceability](REQUIREMENTS_TRACEABILITY.md), [product backlog](PRODUCT_BACKLOG.md), dan [test plan](TEST_PLAN.md).

## Referensi Cucumber

Suite memakai [Cucumber-JS](https://github.com/cucumber/cucumber-js) dan sintaks [Gherkin](https://cucumber.io/docs/gherkin/reference/). File feature menggunakan lokalisasi keyword Indonesia (`# language: id`).
