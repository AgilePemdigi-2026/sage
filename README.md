# 🌿 SAGE

![SAGE — Pahami struktur kode, telusuri buktinya](docs/assets/readme-banner.svg)

**Source-code Architecture Graph Extraction for Evidence-Grounded Software Architecture Documentation.**

SAGE dikembangkan untuk membantu memahami arsitektur repository GitHub melalui **Code Knowledge Graph** dan dokumentasi yang dapat ditelusuri ke source code. Target analisis mencakup **PHP dan JavaScript/TypeScript**, dengan keluaran Markdown serta PDF.

📖 [Panduan lokal](docs/LOCAL_SETUP.md) · 🎯 [Product backlog](docs/PRODUCT_BACKLOG.md) · 🗓️ [Sprint plan](docs/SPRINT_PLAN.md) · 🤝 [Kontribusi](CONTRIBUTING.md)

> 🚧 **Dalam pengembangan — Sprint 1, per 18 Oktober 2026.**
> Fondasi web/worker, Docker Compose, migrasi infrastruktur, parser probe, dan seed fixture tersedia; ENV-01 sudah masuk `main` melalui PR #29. Login GitHub, analisis repository, graph, history, serta ekspor produk masih dikerjakan pada issue masing-masing. Probe fondasi belum membuktikan MVP lengkap.

## 🎯 Kemampuan yang ditargetkan

| | Kemampuan | Hasil yang ingin dicapai |
| --- | --- | --- |
| 🔐 | Akses GitHub | Login, repository publik milik pihak lain, dan repository private yang telah diotorisasi |
| 🔎 | Analisis source code | Adapter PHP dan JS/TS dengan model kode serta kontrak evidence yang sama |
| 🕸️ | Code Knowledge Graph | Telusuri module, class, interface, function, dan hubungan antarkode |
| 📍 | Bukti yang dapat diperiksa | Temuan terhubung ke file, baris, dan snapshot commit yang dianalisis |
| 📝 | Dokumentasi arsitektur | Interface Catalog, Software Engineering Diagram, UML Class Diagram, serta Architecture Definition Document |
| 📦 | Ekspor dan riwayat | Simpan Markdown/PDF, buka kembali analisis, dan hapus data milik pengguna |

Seluruh kemampuan di atas masuk target MVP lokal. Status implementasi serta acceptance criteria mengikuti [backlog](docs/PRODUCT_BACKLOG.md) dan [test plan](docs/TEST_PLAN.md).

## 🚀 Menjalankan di lokal

Siapkan **Docker Engine/Compose** dan Node.js untuk script setup, lalu jalankan dari root repository:

```sh
node scripts/setup-local.mjs
docker compose build
docker compose up --wait --wait-timeout 180
```

Buka **[http://localhost:3000](http://localhost:3000)**.

Script setup membuat `.env` dengan password acak tanpa menimpa konfigurasi lama. PHP, PostgreSQL, dependency aplikasi, dan Chromium berada di container. Versi runtime serta dependency dipin pada konfigurasi proyek.

📘 Command lengkap, migrasi, smoke test, dan troubleshooting tersedia di [panduan setup lokal](docs/LOCAL_SETUP.md). Hasil pengujian fondasi beserta batas buktinya ada di [pemeriksaan environment](docs/ENVIRONMENT_CHECKS.md).

## 🧰 Stack teknologi

| Area | Teknologi |
| --- | --- |
| 🖥️ Web dan API | Next.js App Router · TypeScript · Tailwind CSS |
| ⚙️ Pemrosesan | Worker Node.js terpisah dari proses web |
| 🗄️ Database | PostgreSQL · Prisma ORM |
| 🟨 Analyzer JavaScript/TypeScript | TypeScript Compiler API |
| 🐘 Analyzer PHP | nikic/PHP-Parser melalui runtime PHP pada worker |
| 🕸️ Graph interaktif | Cytoscape.js — direncanakan untuk integrasi graph |
| 📄 Dokumen dan PDF | Mermaid untuk rendering diagram · Playwright/Chromium untuk PDF |
| 🐳 Lingkungan lokal | Docker Compose · Persistent volumes |

Dependency dipin pada lockfile dan base image memakai digest. Renderer SVG/PDF sudah melewati probe fondasi; generator artefak produk serta ekspor terotorisasi tetap perlu diimplementasikan dan diuji.

## 🧭 Prinsip pengembangan

- **Berbasis bukti:** fakta teknis berasal dari static analysis; resolusi relasi hanya `Exact` atau `Unresolved`.
- **Target konsisten:** repository, branch, dan full SHA dipertahankan sepanjang analisis; kode target dibaca sebagai data.
- **Alur bertahap:** satu analisis repository aktif secara global, dengan sembilan tahap pipeline berurutan.
- **Akses sesuai pemilik:** login diperlukan untuk analisis, history, hasil, dan penghapusan; akses private mengikuti izin GitHub.
- **Retensi jelas:** hasil disimpan sampai pemilik menghapusnya; kredensial tetap mengikuti masa berlaku dan pencabutan akses.
- **UI Indonesia:** pendekatan mobile first dengan pengalaman desktop yang lengkap.
- **Lokal lebih dahulu:** MVP diterima melalui Docker; deployment dan anggaran produksi menunggu keputusan dosen.
- **MVP sebelum eksperimen:** seluruh fitur wajib ditargetkan selesai Sprint 2; LLM opsional setelah MVP freeze.

## 📚 Dokumentasi proyek

| Dokumen | Kegunaan |
| --- | --- |
| 🎯 [PRD](docs/PRD.md) | Tujuan, cakupan, pengguna, dan batas MVP |
| 🧾 [Requirement traceability](docs/REQUIREMENTS_TRACEABILITY.md) | Pemetaan 72 requirement SRS ke backlog dan pengujian |
| 🏗️ [Arsitektur](docs/ARCHITECTURE.md) | Komponen aplikasi, stack, pipeline, dan lingkungan lokal |
| 🔬 [Spesifikasi analisis](docs/ANALYSIS_SPEC.md) | CCM, node, edge, evidence, cakupan analyzer, dan artefak |
| 🗄️ [Model data](docs/DATA_MODEL.md) | Entitas penyimpanan, lifecycle, dan penghapusan |
| 🔌 [Kontrak API](docs/API_CONTRACT.md) | Endpoint, payload, otorisasi, status, dan error |
| 🎨 [Design guidelines](docs/DESIGN_GUIDELINES.md) | Acuan Figma, token, bahasa UI, state, dan responsivitas |
| 📋 [Product backlog](docs/PRODUCT_BACKLOG.md) | 39 issue, dependensi, acceptance criteria, dan penanggung jawab |
| 🗓️ [Sprint plan](docs/SPRINT_PLAN.md) | Kalender pengerjaan/review dan target tiap sprint |
| ⚖️ [Alokasi sprint](docs/SPRINT_ALLOCATION.md) | Deliverable tiap anggota dan bukti kontribusi |
| ✅ [Definition of Done](docs/DEFINITION_OF_DONE.md) | Syarat deliverable dan MVP dinyatakan selesai |
| 🧪 [Test plan](docs/TEST_PLAN.md) | Fixture, integrasi GitHub, dan verifikasi ekspor |
| 🧭 [Keputusan dan risiko](docs/DECISIONS.md) | Keputusan, rancangan awal, TBD, dan risiko |
| 📎 [Sumber](docs/SOURCES.md) | PDF, Figma, referensi teknis, dan urutan acuan |
| 🤝 [Kontribusi](CONTRIBUTING.md) | Pembagian modul, issue, branch, PR, commit, dan alur merge |

Mulai dari PRD, keputusan, dan spesifikasi analisis, kemudian backlog serta sprint plan. Kontrak API dan model data diperbarui bersama ketika implementasi mengubah kontrak.

## 🗓️ Roadmap sprint

Semua tanggal mengikuti **Asia/Jakarta**. Setiap siklus terdiri atas dua minggu pengerjaan dan satu minggu review user story.

| Sprint | Fokus | Pengerjaan | Review |
| --- | --- | --- | --- |
| 🌱 Sprint 1 | Fondasi, akses repository, kontrak, dan jalur dasar dua bahasa | 12–25 Oktober 2026 | 26 Oktober–1 November 2026 |
| 🛠️ Sprint 2 | Integrasi seluruh alur MVP dan feature freeze | 2–15 November 2026 | 16–22 November 2026 |
| ✨ Sprint 3 | Regression, penyempurnaan, dokumentasi, dan demo | 23 November–6 Desember 2026 | 7–13 Desember 2026 |

**Target feature-complete: 15 November 2026.** Kalender merupakan rencana; status selesai tetap memerlukan bukti dan review sesuai Definition of Done.

## 🤝 Tim dan kontribusi

| Anggota | GitHub | Fokus modul |
| --- | --- | --- |
| Iltizam Muhammad Hasan | [@iltizamhasan3](https://github.com/iltizamhasan3) | Kontrak/JS/TS, canonical CKG, login/snapshot, review teknis, dan merge |
| Rizqy Fadhil Athallah | [@rizqy-fadhil](https://github.com/rizqy-fadhil) | Akses/target repository, queue/pipeline, history, dan pengujian integrasi |
| Valentina Hermawan | [@liliks13](https://github.com/liliks13) | UI, graph/inspector, diagram, PDF, dan verifikasi visual |
| Zarra Firdaus Ananda Salia | [@zarrrafirdaus](https://github.com/zarrrafirdaus) | Model data, oracle, analyzer PHP, catalog/ADD, Markdown, dan cleanup |

Pekerjaan dilacak melalui issue, branch, PR, dan bukti verifikasi. Gunakan **Conventional Commit satu baris/satu kalimat**. Penanggung jawab serta hasil aktual mengikuti [alur kontribusi](CONTRIBUTING.md) dan [alokasi sprint](docs/SPRINT_ALLOCATION.md).

## 📌 Langkah berikutnya

1. Lengkapi model data produk, session/credential storage, dan isolasi pengguna pada **DATA-01**.
2. Review serta lengkapi oracle minimum PHP/JS/TS pada **QA-01-S1**.
3. Hubungkan GitHub App pada **GH-01**, lalu lanjutkan paket sesuai dependensi.
4. Tutup setiap issue setelah acceptance criteria, bukti, dan review terpenuhi.
