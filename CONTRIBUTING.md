# Alur kontribusi

Status: workflow aktif; milestone dan Issues telah dibuat. Fondasi ENV-01 dan seed QA-01 sedang dikerjakan melalui branch/PR.

## Tanggung jawab

Pekerjaan direncanakan berdasarkan modul, deliverable, dan dependensi antar-issue. Setiap paket memiliki penanggung jawab serta kriteria penerimaan yang jelas. Iltizam Muhammad Hasan bertanggung jawab melakukan review teknis dan merge PR ke `main`. Peran pada issue dan laporan mengikuti pekerjaan yang benar-benar dilakukan.

| Anggota | Rencana tanggung jawab modul dan deliverable |
| --- | --- |
| Iltizam Muhammad Hasan | Arsitektur/CCM, adapter JS/TS, canonical CKG, login/snapshot, review teknis dan merge PR |
| Rizqy Fadhil Athallah | Akses/target repository, queue, runner/pipeline/progress, history, dan regression integrasi |
| Valentina Hermawan | Shell UI/mobile/desktop, graph/inspector, proyeksi diagram, PDF, dan regression visual |
| Zarra Firdaus Ananda Salia | Model data/session/credential, oracle, adapter PHP, catalog/ADD, Markdown, cleanup, dan panduan/demo |

Pembagian di atas merupakan rencana tanggung jawab. Setiap issue/PR mencatat scope, pelaksana, pemeriksa, dan hasil aktualnya. Akun GitHub yang dipetakan adalah Iltizam `iltizamhasan3`, Rizqy `rizqy-fadhil`, dan Valentina `liliks13`. Penanggung jawab Zarra tetap tercantum pada paketnya, dengan assignee GitHub kosong sampai undangan diterima. Scope tiap sprint mengikuti [alokasi sprint](docs/SPRINT_ALLOCATION.md).

## Issues dan milestone

- Satu issue memiliki satu deliverable yang dapat diperiksa dan satu penanggung jawab utama.
- Gunakan ID backlog internal dari [product backlog](docs/PRODUCT_BACKLOG.md); nomor issue GitHub ditambahkan setelah issue benar-benar dibuat.
- Cantumkan requirement, scope, file yang terkait, dependensi, acceptance criteria, dan bukti yang harus dilampirkan.
- Milestone: `Sprint 1`, `Sprint 2`, `Sprint 3` dengan tanggal akhir review masing-masing.
- Label area: `planning`, `github`, `repository`, `analyzer`, `graph`, `document`, `export`, `data`, `testing`, `ui`, `bug`, `blocked`.
- Status kerja: `Backlog`, `Ready`, `In progress`, `In review`, `Done`; pekerjaan dengan dependensi belum terpenuhi diberi `blocked`.
- Template task dan bug tersedia di [.github/ISSUE_TEMPLATE](.github/ISSUE_TEMPLATE).

39 Issues, label, dan tiga milestone telah dibuat; mapping ada di product backlog. Delapan sub-issue memiliki parent native GitHub. Ukuran parent setelah pemisahan adalah scope sisa; bukti anak dapat dirujuk tanpa menghitung bobot yang sama dua kali. Issue `*-S1` memakai milestone Sprint 1, sedangkan parent lintas sprint tetap Sprint 2 sampai acceptance lengkap.

Dasar review pembagian adalah bobot pekerjaan dan bukti kontribusi tiap sprint, bukan jumlah issue/commit yang sama. Catat perubahan substantif, pelaksana/pemeriksa aktual, dan hasil pengujian; reestimasi bila kapasitas atau dependensi berubah. Label `P0`/`P1`/`P2`, `ready`, `in-progress`, dan `blocked` menandai prioritas serta kesiapan. GitHub Projects belum dibuat dan bukan syarat workflow ini.

## Paket pekerjaan

Setiap paket berisi ID backlog/issue, base commit, daftar file, tujuan perubahan, dependensi paket, instruksi menjalankan, checklist verifikasi, dan saran satu pesan commit. Lampirkan diff yang dapat diperiksa; hindari menyalin seluruh checkout yang dapat menimpa perubahan anggota lain.

Penanggung jawab paket memperbarui branch dari base yang sesuai, memeriksa diff, menjalankan checklist, dan menyertakan hasil aktual pada PR. Bila belum berhasil diuji, catat kegagalannya dan biarkan issue terbuka.

## Branch dan PR

Gunakan branch seperti `feat/12-github-callback`, `fix/34-source-preview`, atau `docs/56-test-plan`; nomor hanya contoh dan harus diganti dengan nomor issue nyata. Satu branch berfokus pada satu paket atau beberapa issue yang memiliki dependensi kuat.

Alur kerja: issue siap -> pengerjaan paket -> verifikasi -> commit -> PR -> review teknis oleh Iltizam -> merge oleh Iltizam ke `main`. Commit awal baseline planning dibuat langsung pada repository yang masih kosong. Proteksi `main` kini mewajibkan PR, satu approval yang diperbarui setelah perubahan, serta penyelesaian percakapan review; force push dan penghapusan diblokir. Akun yang terdaftar untuk push/merge adalah `iltizamhasan3`; administrator tetap dapat mengubah pengaturan proteksi. Pemeriksaan wajib CI ditambahkan setelah workflow CI tersedia.

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
