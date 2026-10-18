# Alur kontribusi

Status: aturan kerja untuk implementasi mendatang; baseline pertama berisi dokumentasi planning.

## Tanggung jawab

Implementasi inti dikoordinasikan oleh Iltizam Muhammad Hasan. Paket file dapat disiapkan terpusat, kemudian diserahkan kepada anggota yang bertanggung jawab melakukan verifikasi dan integrasi. Peran pada issue dan laporan mengikuti pekerjaan yang benar-benar dilakukan.

| Anggota | Tanggung jawab paket dan verifikasi |
| --- | --- |
| Iltizam Muhammad Hasan | Arsitektur, implementasi inti, GitHub, worker, analyzer, integrasi, dan review teknis |
| Rizqy Fadhil Athallah | Handoff alur repository, progress, dan history; pemeriksaan user story serta integrasi paket terkait |
| Valentina Hermawan | Kesesuaian desain, mobile/desktop, teks UI, graph/inspector, serta bukti uji antarmuka |
| Zarra Firdaus Ananda Salia | Fixture dan expected output, model data, dokumen/ekspor, pengujian, serta dokumentasi hasil |

Penanggung jawab handoff tidak harus menulis seluruh kode pada paketnya. Catat pelaksana implementasi, pemeriksa, hasil verifikasi, dan pengirim commit secara terpisah jika orangnya berbeda. Akun GitHub tiga anggota lain masih perlu dipetakan sebelum assignment di GitHub.

## Issues dan milestone

- Satu issue memiliki satu deliverable yang dapat diperiksa dan satu penanggung jawab utama.
- Gunakan ID backlog internal dari [product backlog](docs/PRODUCT_BACKLOG.md); nomor issue GitHub ditambahkan setelah issue benar-benar dibuat.
- Cantumkan requirement, scope, file yang terkait, dependensi, acceptance criteria, dan bukti yang harus dilampirkan.
- Milestone: `Sprint 1`, `Sprint 2`, `Sprint 3` dengan tanggal akhir review masing-masing.
- Label yang direncanakan: `planning`, `github`, `repository`, `analyzer`, `graph`, `document`, `export`, `data`, `testing`, `ui`, `bug`, `blocked`.
- Status kerja: `Backlog`, `Ready`, `In progress`, `In review`, `Done`; pekerjaan dengan dependensi belum terpenuhi diberi `blocked`.
- Template task dan bug tersedia di [.github/ISSUE_TEMPLATE](.github/ISSUE_TEMPLATE).

Dokumentasi ini tidak berarti Issues, label, milestone, atau Projects sudah dibuat di GitHub.

## Paket handoff

Setiap paket berisi ID backlog/issue, base commit, daftar file, tujuan perubahan, dependensi paket, instruksi menjalankan, checklist verifikasi, dan saran satu pesan commit. Lampirkan diff yang dapat diperiksa; hindari menyalin seluruh checkout yang dapat menimpa perubahan anggota lain.

Penerima memperbarui branch dari base yang sesuai, memeriksa diff, menjalankan checklist, dan menyertakan hasil aktual pada PR. Bila belum berhasil diuji, catat kegagalannya dan biarkan issue terbuka.

## Branch dan PR

Gunakan branch seperti `feat/12-github-callback`, `fix/34-source-preview`, atau `docs/56-test-plan`; nomor hanya contoh dan harus diganti dengan nomor issue nyata. Satu branch berfokus pada satu paket atau beberapa issue yang memiliki dependensi kuat.

Alur kerja: issue siap -> paket perubahan -> verifikasi penerima -> commit -> PR -> review Iltizam -> merge ke `main`. Commit awal baseline planning dibuat langsung pada repository yang masih kosong.

PR menjelaskan perubahan, ID requirement, issue, dan bukti pengujian. Gunakan `Closes #N` hanya ketika acceptance criteria issue sudah terpenuhi dan PR ditujukan ke default branch. Untuk pekerjaan parsial, gunakan `Refs #N`. Penutupan issue harus mencerminkan hasil review, termasuk saat menggunakan otomatisasi GitHub.

Utamakan merge yang mempertahankan commit anggota yang telah direview. Jangan mengubah author atau menulis ulang commit yang sudah dibagikan tanpa kebutuhan yang disepakati tim. Jumlah commit tidak menggantikan bukti hasil kerja; ketentuan penilaian mengikuti rubrik dosen.

## Format commit

Ikuti [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/) dengan satu baris berisi satu kalimat singkat:

```text
<type>(<scope>): <ringkasan perubahan>
```

Type yang digunakan: `docs`, `feat`, `fix`, `test`, `refactor`, `perf`, `build`, `ci`, dan `chore`. Scope disesuaikan dengan modul. Pesan commit tidak memakai body atau footer; rincian dan bukti diletakkan pada issue/PR. Gunakan `!` pada header bila perubahan memutus kontrak dan jelaskan migrasinya di PR.

Contoh:

```text
docs(planning): susun baseline perencanaan SAGE
feat(auth): tangani callback otorisasi GitHub (#12)
test(analyzer): tambahkan fixture namespace PHP (#34)
```

Gunakan identitas Git milik pengirim yang sudah diperiksa. Secret, token, private key, snapshot repository, hasil ekspor, dan log yang mengandung source private tidak dimasukkan ke commit.

## Review dokumentasi

Periksa tautan relatif, kelengkapan requirement, kesamaan enum/API, kalender, dan status bukti. Perubahan scope atau keputusan harus memperbarui [decision log](docs/DECISIONS.md), traceability, backlog, dan test plan yang terdampak.
