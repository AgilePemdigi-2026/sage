# SAGE

Source-code Architecture Graph Extraction for Evidence-Grounded Software Architecture Documentation.

SAGE direncanakan sebagai aplikasi web untuk menganalisis repository GitHub, menampilkan Code Knowledge Graph yang dapat ditelusuri ke source code, dan menghasilkan dokumentasi arsitektur dalam Markdown serta PDF.

**Status per 18 Oktober 2026: baseline planning.** Repository ini belum berisi aplikasi, Docker Compose yang dapat dijalankan, migrasi database, atau hasil pengujian fitur. Seluruh contoh kontrak dan struktur direktori aplikasi dalam dokumentasi adalah rancangan implementasi.

## Keputusan utama

- MVP harus berfungsi penuh di lokal melalui Docker Compose.
- Login GitHub wajib; pengguna dapat menganalisis repository publik milik pihak lain dan repository private yang telah diotorisasi.
- PHP dan JavaScript/TypeScript dikembangkan paralel melalui adapter analyzer terpisah dengan kontrak hasil yang sama.
- Maksimal satu analisis repository aktif di seluruh aplikasi; sembilan tahap pipeline berjalan berurutan.
- Fakta teknis berasal dari static analysis; klasifikasi resolusi hanya `Exact` dan `Unresolved`.
- Keluaran mencakup Interface Catalog, Software Engineering Diagram, UML Class Diagram, Markdown, dan PDF.
- Antarmuka berbahasa Indonesia, mobile first, dengan pengalaman desktop sebagai penggunaan utama.
- Data disimpan sampai pemilik menghapusnya; kredensial mengikuti masa berlaku dan pencabutan aksesnya.
- Target seluruh fitur MVP selesai pada Sprint 2; Sprint 3 untuk penyempurnaan.
- LLM ditunda sampai MVP freeze; deployment dan anggaran produksi menunggu keputusan dosen.

## Dokumen planning

| Dokumen | Kegunaan |
| --- | --- |
| [PRD](docs/PRD.md) | Tujuan, cakupan produk, pengguna, dan batas MVP |
| [Requirement traceability](docs/REQUIREMENTS_TRACEABILITY.md) | Pemetaan 72 requirement SRS ke backlog dan pengujian |
| [Arsitektur](docs/ARCHITECTURE.md) | Komponen aplikasi, stack, pipeline, dan lingkungan lokal |
| [Spesifikasi analisis](docs/ANALYSIS_SPEC.md) | CCM, node, edge, evidence, cakupan analyzer, dan artefak |
| [Model data](docs/DATA_MODEL.md) | Entitas penyimpanan, relasi, lifecycle, dan penghapusan |
| [Kontrak API](docs/API_CONTRACT.md) | Endpoint, payload, otorisasi, status, dan error |
| [Design guidelines](docs/DESIGN_GUIDELINES.md) | Acuan Figma, token, bahasa UI, state, dan responsivitas |
| [Product backlog](docs/PRODUCT_BACKLOG.md) | Paket pekerjaan, dependensi, acceptance criteria, dan penanggung jawab |
| [Sprint plan](docs/SPRINT_PLAN.md) | Kalender pengerjaan/review dan target setiap sprint |
| [Definition of Done](docs/DEFINITION_OF_DONE.md) | Syarat sebuah deliverable dan MVP dinyatakan selesai |
| [Test plan](docs/TEST_PLAN.md) | Fixture, test case, integrasi GitHub, dan verifikasi ekspor |
| [Keputusan dan risiko](docs/DECISIONS.md) | Keputusan yang disepakati, rancangan awal, TBD, dan risiko |
| [Sumber](docs/SOURCES.md) | Identitas sumber PDF, Figma, referensi teknis, dan urutan acuan |
| [Kontribusi](CONTRIBUTING.md) | Pembagian modul, paket pekerjaan, Issues, PR, commit, dan alur review/merge |

Mulai dari PRD, keputusan, spesifikasi analisis, lalu backlog dan sprint plan. Kontrak API dan model data harus diperbarui bersama jika implementasi mengubah kontrak awal.

## Stack yang disepakati

| Bagian | Pilihan |
| --- | --- |
| Web dan API | Next.js App Router, TypeScript, Tailwind CSS |
| Pemrosesan | Worker Node.js terpisah dari proses web |
| Database | PostgreSQL dan Prisma ORM |
| Analyzer JavaScript/TypeScript | TypeScript Compiler API |
| Analyzer PHP | nikic/PHP-Parser melalui runtime PHP pada worker |
| Graph interaktif | Cytoscape.js |
| Ekspor PDF | Playwright/Chromium dari halaman cetak terkontrol |
| Lingkungan lokal | Docker Compose dan persistent volumes |

Versi dependency, renderer diagram statis, dan batas resource akan dipin setelah compatibility spike. Tidak ada klaim bahwa integrasi stack telah lulus pengujian pada baseline planning ini.

## Kalender

Semua tanggal mengikuti zona waktu Asia/Jakarta. Satu siklus terdiri atas dua minggu pengerjaan dan satu minggu review user story.

| Sprint | Pengerjaan | Review |
| --- | --- | --- |
| 1 | 12-25 Oktober 2026 | 26 Oktober-1 November 2026 |
| 2 | 2-15 November 2026 | 16-22 November 2026 |
| 3 | 23 November-6 Desember 2026 | 7-13 Desember 2026 |

Baseline planning disusun pada 18 Oktober 2026. Tanggal sprint bukan bukti bahwa pekerjaan pada tanggal sebelumnya telah selesai.

## Pelaksanaan berikutnya

1. Turunkan backlog menjadi GitHub Issues menggunakan template yang tersedia.
2. Lengkapi konfigurasi GitHub App dan repository uji tanpa menyimpan secret di Git.
3. Buktikan compatibility stack dan setup Docker sebelum menambah fitur.
4. Jalankan acceptance criteria dan lampirkan bukti sebelum mengubah status pekerjaan menjadi Done.

Panduan menjalankan aplikasi akan ditambahkan ketika command, image, dan konfigurasi yang dirujuk sudah benar-benar tersedia.
