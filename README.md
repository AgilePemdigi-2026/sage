# SAGE

Source-code Architecture Graph Extraction for Evidence-Grounded Software Architecture Documentation.

SAGE dikembangkan sebagai aplikasi web untuk menganalisis repository GitHub, menampilkan Code Knowledge Graph yang dapat ditelusuri ke source code, dan menghasilkan dokumentasi arsitektur dalam Markdown serta PDF.

**Status per 18 Oktober 2026: fondasi Sprint 1 (ENV-01 dan seed QA-01).** Workspace web/worker, Docker Compose, migrasi infrastruktur, parser probe, dan seed fixture tersedia. Login, pemilihan repository, pipeline analisis, graph, history, dan ekspor produk masih berada pada issue terpisah. Probe kompatibilitas bukan bukti bahwa fitur MVP telah selesai.

## Menjalankan fondasi lokal

Siapkan Docker Engine/Compose lalu jalankan dari root repository:

```sh
node scripts/setup-local.mjs
docker compose build
docker compose up --wait --wait-timeout 180
```

Buka [SAGE lokal](http://localhost:3000). Script setup menggunakan Node untuk membuat `.env` dengan password acak tanpa menimpa konfigurasi lama. PHP, PostgreSQL, dependency aplikasi, dan Chromium berada di container.

Command, migrasi, smoke test, dan batas pengujian dijelaskan pada [setup lokal](docs/LOCAL_SETUP.md). Mapping 39 Issues serta milestone ada di [product backlog](docs/PRODUCT_BACKLOG.md); pembagian deliverable tiap anggota ada di [alokasi sprint](docs/SPRINT_ALLOCATION.md).

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
| [Alokasi sprint](docs/SPRINT_ALLOCATION.md) | Scope tiap anggota, issue fase/integrasi, serta bukti kontribusi |
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

Dependency aplikasi dipin pada lockfile; base image dipin dengan digest pada Dockerfile/Compose. Mermaid diuji sebagai renderer SVG/PDF; generator artefak produk tetap masuk DOC-01. Batas awal dan hasil spike dicatat pada panduan lokal serta bukti ENV-01.

## Kalender

Semua tanggal mengikuti zona waktu Asia/Jakarta. Satu siklus terdiri atas dua minggu pengerjaan dan satu minggu review user story.

| Sprint | Pengerjaan | Review |
| --- | --- | --- |
| 1 | 12-25 Oktober 2026 | 26 Oktober-1 November 2026 |
| 2 | 2-15 November 2026 | 16-22 November 2026 |
| 3 | 23 November-6 Desember 2026 | 7-13 Desember 2026 |

Baseline planning disusun pada 18 Oktober 2026. Tanggal sprint bukan bukti bahwa pekerjaan pada tanggal sebelumnya telah selesai.

## Pelaksanaan berikutnya

1. Review bukti ENV-01 dan seed fixture/oracle QA-01.
2. Implementasikan entitas produk, isolasi user, dan credential/session storage pada DATA-01.
3. Lengkapi GitHub App untuk GH-01 tanpa menyimpan secret di Git.
4. Tutup setiap paket setelah acceptance dan review terpenuhi.
