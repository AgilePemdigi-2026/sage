# Requirements traceability

Status diperbarui 20 Oktober 2026. Tabel ini memuat **72 requirement SRS yang unik** dan requirement lokal hasil keputusan project. Paket Sprint 1 memiliki bukti implementasi terpisah; keberadaan mapping tidak membuktikan acceptance MVP penuh. Status “paket teruji” mengacu bukti issue dan check record, termasuk batas pengujian controlled/live; status Planned tetap menunggu penerimaan produk.

Judul requirement berasal dari SRC-SRS; nomor halaman menggunakan indeks PDF. Rincian perilaku dibaca bersama sumber dan PRD, bukan digantikan hanya oleh judul. ID backlog adalah ID internal; nomor issue GitHub tersedia pada tabel product backlog. Test ID merujuk [test plan](TEST_PLAN.md).

## Requirement SRS

| ID | Judul sumber | PDF hlm. | Screen/state | Backlog | Test case | Sprint target | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| SAGE-FR-GH-01 | GitHub Connection Action | 27 | Landing / Pilih Repository | GH-01 | T-GH-01, T-GH-02 | 1 | Paket GH-01 teruji; integrasi penuh mengikuti test plan |
| SAGE-FR-GH-02 | GitHub Authorization Redirect | 28 | Landing / Pilih Repository | GH-01 | T-GH-01, T-GH-02 | 1 | Paket GH-01 teruji; integrasi penuh mengikuti test plan |
| SAGE-FR-GH-03 | Authorization Callback Handling | 28 | Landing / Pilih Repository | GH-01 | T-GH-01, T-GH-02 | 1 | Paket GH-01 teruji; integrasi penuh mengikuti test plan |
| SAGE-FR-GH-04 | Successful GitHub Connection | 28 | Landing / Pilih Repository | GH-01 | T-GH-01, T-GH-02 | 1 | Paket GH-01 teruji; integrasi penuh mengikuti test plan |
| SAGE-FR-GH-05 | Authorized Repository Retrieval | 28 | Pilih Repository | GH-02 | T-GH-03, T-DATA-01 | 1 | Paket GH-02 teruji; integrasi penuh mengikuti test plan |
| SAGE-FR-GH-06 | Repository Access Restriction | 28 | Pilih Repository | GH-02 | T-GH-03, T-DATA-01 | 1 | Paket GH-02 teruji; integrasi penuh mengikuti test plan |
| SAGE-FR-GH-07 | Repository Selection Navigation | 28 | Landing / Pilih Repository | GH-01 | T-GH-01, T-GH-02 | 1 | Paket GH-01 teruji; integrasi penuh mengikuti test plan |
| SAGE-FR-GH-08 | Permission Denial Handling | 28 | Landing | GH-01 | T-GH-02 | 1 | Paket GH-01 teruji; integrasi penuh mengikuti test plan |
| SAGE-FR-GH-09 | Authentication Failure Handling | 28 | Landing | GH-01 | T-GH-02 | 1 | Paket GH-01 teruji; integrasi penuh mengikuti test plan |
| SAGE-FR-GH-10 | Retry Connection | 28 | Landing | GH-01 | T-GH-02 | 1 | Paket GH-01 teruji; integrasi penuh mengikuti test plan |
| SAGE-FR-REP-01 | Authorized Repository List | 30 | Pilih Repository | REP-01 | T-REP-01 | 1 | Paket REP-01 teruji; integrasi penuh mengikuti test plan |
| SAGE-FR-REP-02 | Repository Search | 30 | Pilih Repository | REP-01 | T-REP-01 | 1 | Paket REP-01 teruji; integrasi penuh mengikuti test plan |
| SAGE-FR-REP-03 | Repository Selection | 30 | Pilih Repository | REP-01 | T-REP-01 | 1 | Paket REP-01 teruji; integrasi penuh mengikuti test plan |
| SAGE-FR-REP-04 | Analysis Target Display | 30 | Pilih Repository | REP-01 | T-REP-01 | 1 | Paket REP-01 teruji; integrasi penuh mengikuti test plan |
| SAGE-FR-REP-05 | Branch Retrieval | 30 | Pilih Repository | REP-01 | T-REP-01 | 1 | Paket REP-01 teruji; integrasi penuh mengikuti test plan |
| SAGE-FR-REP-06 | Branch Selection | 30 | Pilih Repository | REP-01 | T-REP-01 | 1 | Paket REP-01 teruji; integrasi penuh mengikuti test plan |
| SAGE-FR-REP-07 | Optional Commit Selection | 30 | Pilih Repository | REP-01 | T-REP-01 | 1 | Paket REP-01 teruji; integrasi penuh mengikuti test plan |
| SAGE-FR-REP-08 | Latest Commit Fallback | 30 | Pilih Repository / Progres | REP-02 | T-REP-02 | 1 | Paket REP-02 teruji; integrasi penuh mengikuti test plan |
| SAGE-FR-REP-09 | Analysis Target Validation | 30 | Pilih Repository | REP-01 | T-REP-02 | 1 | Paket REP-01 teruji; integrasi penuh mengikuti test plan |
| SAGE-FR-REP-10 | Repository Snapshot Retrieval | 30 | Pilih Repository / Progres | REP-02 | T-REP-02, T-SEC-01 | 1 | Paket REP-02 teruji; integrasi penuh mengikuti test plan |
| SAGE-FR-REP-11 | Analysis Initialization | 30 | Progres | ANA-01 | T-ANA-01 | 1 | Paket ANA-01 teruji; integrasi penuh mengikuti test plan |
| SAGE-FR-REP-12 | Analysis Progress Navigation | 30 | Progres | ANA-07 | T-ANA-02 | 1-2 | Planned |
| SAGE-FR-REP-13 | Repository Search Empty Result | 31 | Pilih Repository | REP-01 | T-REP-01 | 1 | Paket REP-01 teruji; integrasi penuh mengikuti test plan |
| SAGE-FR-ANA-01 | Analysis Progress Display | 32 | Progres | ANA-07 | T-ANA-02 | 1-2 | Planned |
| SAGE-FR-ANA-02 | Repository Snapshot Processing | 32 | Progres | REP-02 | T-REP-02 | 1 | Paket REP-02 teruji; integrasi penuh mengikuti test plan |
| SAGE-FR-ANA-03 | Language and Project Structure Detection | 32 | Progres / Keterbatasan | ANA-02 | T-ANA-05 | 1 | Paket ANA-02 teruji; integrasi penuh mengikuti test plan |
| SAGE-FR-ANA-04 | Supported Source Code Analysis | 32 | Progres / Hasil | ANA-03, ANA-04 | T-ANA-03 | 1-2 | Adapter statis teruji sesuai capability; integrasi produk menunggu pipeline |
| SAGE-FR-ANA-05 | Common Code Model Generation | 32 | Progres / Hasil | ANA-05 | T-ANA-04 | 1-2 | Hardening validator dan kompatibilitas deklarasi; 21 fakta resolver teruji; acceptance parent dan QA-01 tetap terpisah |
| SAGE-FR-ANA-06 | Code Knowledge Graph Generation | 33 | Graph | ANA-06 | T-ANA-04, T-GRAPH-01 | 2 | Planned |
| SAGE-FR-ANA-07 | Interface Catalog Generation | 33 | Dokumen | DOC-01 | T-DOC-01 | 2 | Planned |
| SAGE-FR-ANA-08 | Software Engineering Diagram Generation | 33 | Dokumen | DOC-02, DOC-01 | T-DOC-01 | 2 | Planned |
| SAGE-FR-ANA-09 | UML Class Diagram Generation | 33 | Dokumen | DOC-02, DOC-01 | T-DOC-01 | 2 | Planned |
| SAGE-FR-ANA-10 | Architecture Definition Document Generation | 33 | Dokumen | DOC-01 | T-DOC-01 | 2 | Planned |
| SAGE-FR-ANA-11 | Analysis Progress Update | 33 | Progres | ANA-07 | T-ANA-02 | 1-2 | Planned |
| SAGE-FR-ANA-12 | Unsupported Language Notification | 33 | Progres / Keterbatasan | ANA-02 | T-ANA-05 | 1 | Paket ANA-02 teruji; integrasi penuh mengikuti test plan |
| SAGE-FR-ANA-13 | Partial Analysis Continuation | 33 | Progres / Keterbatasan | ANA-02, ANA-03, ANA-04 | T-ANA-05 | 1-2 | Partial/failed sibling dan unresolved teruji pada worker; alur produk menunggu pipeline |
| SAGE-FR-ANA-14 | Analysis Completion Status | 33 | Progres | ANA-07 | T-ANA-02, T-ANA-05 | 2 | Planned |
| SAGE-FR-ANA-15 | Analysis Result Access | 33 | Progres / Graph | ANA-07, GRAPH-01 | T-GRAPH-01 | 2 | Planned |
| SAGE-FR-GRAPH-01 | Analysis Context Display | 35 | Graph | GRAPH-01 | T-GRAPH-01 | 2 | Planned |
| SAGE-FR-GRAPH-02 | Code Knowledge Graph Display | 35 | Graph | GRAPH-01 | T-GRAPH-01 | 2 | Planned |
| SAGE-FR-GRAPH-03 | Node Query | 35 | Graph | GRAPH-02 | T-GRAPH-02 | 2 | Planned |
| SAGE-FR-GRAPH-04 | AST Category Filter | 35 | Graph | GRAPH-02 | T-GRAPH-02 | 2 | Planned |
| SAGE-FR-GRAPH-05 | Graph Filtering Result | 35 | Graph | GRAPH-02 | T-GRAPH-02 | 2 | Planned |
| SAGE-FR-GRAPH-06 | Node Selection | 35 | Graph / Inspector / Source | GRAPH-03 | T-GRAPH-03 | 2 | Planned |
| SAGE-FR-GRAPH-07 | Node Inspector | 35 | Graph / Inspector / Source | GRAPH-03 | T-GRAPH-03 | 2 | Planned |
| SAGE-FR-GRAPH-08 | Location and AST Bounds Display | 35 | Graph / Inspector / Source | GRAPH-03 | T-GRAPH-03 | 2 | Planned |
| SAGE-FR-GRAPH-09 | Direct Relations Display | 36 | Graph / Inspector / Source | GRAPH-03 | T-GRAPH-03 | 2 | Planned |
| SAGE-FR-GRAPH-10 | Source Evidence Display | 36 | Graph / Inspector / Source | GRAPH-03 | T-GRAPH-03 | 2 | Planned |
| SAGE-FR-GRAPH-11 | Document Access | 36 | Graph / Dokumen | DOC-01 | T-DOC-01 | 2 | Planned |
| SAGE-FR-GRAPH-12 | Unavailable Result Handling | 36 | Graph unavailable / Progres | ANA-07 | T-ANA-02, T-GRAPH-03 | 1-2 | Planned |
| SAGE-FR-GRAPH-13 | Analysis Progress Display | 36 | Graph unavailable / Progres | ANA-07 | T-ANA-02, T-GRAPH-03 | 1-2 | Planned |
| SAGE-FR-EXP-01 | Architecture Definition Document Display | 37 | Dokumen | DOC-01 | T-DOC-01 | 2 | Planned |
| SAGE-FR-EXP-02 | Interface Catalog Display | 37 | Dokumen | DOC-01 | T-DOC-01 | 2 | Planned |
| SAGE-FR-EXP-03 | Software Engineering Diagram Display | 37 | Dokumen | DOC-02, DOC-01 | T-DOC-01 | 2 | Planned |
| SAGE-FR-EXP-04 | UML Class Diagram Display | 37 | Dokumen | DOC-02, DOC-01 | T-DOC-01 | 2 | Planned |
| SAGE-FR-EXP-05 | PDF Export | 38 | Dokumen / Ekspor PDF | EXP-02 | T-EXP-02 | 2 | Planned |
| SAGE-FR-EXP-06 | Markdown Export | 38 | Dokumen / Ekspor Markdown | EXP-01 | T-EXP-01 | 2 | Planned |
| SAGE-FR-EXP-07 | Export File Generation | 38 | Dokumen / Ekspor | EXP-01, EXP-02 | T-EXP-01, T-EXP-02, T-EXP-03 | 2 | Planned |
| SAGE-FR-EXP-08 | Export File Availability | 38 | Dokumen / Ekspor | EXP-01, EXP-02 | T-EXP-01, T-EXP-02, T-EXP-03 | 2 | Planned |
| SAGE-FR-EXP-09 | Export Failure Notification | 38 | Dokumen / Ekspor gagal | EXP-01, EXP-02 | T-EXP-03 | 2 | Planned |
| SAGE-FR-EXP-10 | Export Retry | 38 | Dokumen / Ekspor gagal | EXP-01, EXP-02 | T-EXP-03 | 2 | Planned |
| SAGE-FR-HIST-01 | Analysis History Display | 39 | Riwayat Analisis | HIST-01 | T-HIST-01, T-DATA-01 | 2 | Planned |
| SAGE-FR-HIST-02 | Analysis History Information | 39 | Riwayat Analisis | HIST-01 | T-HIST-01, T-DATA-01 | 2 | Planned |
| SAGE-FR-HIST-03 | Repository Search | 40 | Riwayat Analisis | HIST-01 | T-HIST-01, T-DATA-01 | 2 | Planned |
| SAGE-FR-HIST-04 | Commit SHA Search | 40 | Riwayat Analisis | HIST-01 | T-HIST-01, T-DATA-01 | 2 | Planned |
| SAGE-FR-HIST-05 | History Filtering | 40 | Riwayat Analisis | HIST-01 | T-HIST-01, T-DATA-01 | 2 | Planned |
| SAGE-FR-HIST-06 | Analysis History Selection | 40 | Riwayat Analisis | HIST-01 | T-HIST-01, T-DATA-01 | 2 | Planned |
| SAGE-FR-HIST-07 | Completed Analysis Navigation | 40 | Riwayat Analisis | HIST-01 | T-HIST-01, T-DATA-01 | 2 | Planned |
| SAGE-FR-HIST-08 | Ongoing Analysis Navigation | 40 | Riwayat Analisis | HIST-01 | T-HIST-01, T-DATA-01 | 2 | Planned |
| SAGE-FR-HIST-09 | Empty History State | 40 | Riwayat Analisis | HIST-01 | T-HIST-01, T-DATA-01 | 2 | Planned |
| SAGE-FR-HIST-10 | New Analysis Action | 40 | Riwayat Analisis | HIST-01 | T-HIST-01, T-DATA-01 | 2 | Planned |
| SAGE-FR-HIST-11 | New Analysis Navigation | 40 | Riwayat Analisis | HIST-01 | T-HIST-01, T-DATA-01 | 2 | Planned |

## Requirement lokal hasil keputusan

ID `APP-*` merupakan tambahan project, bukan identifier yang diklaim berasal dari PDF. Semua masih Planned kecuali kebijakan planning yang telah disepakati; bukti runtime tetap NOT_RUN.

| ID | Requirement | Backlog | Test case/bukti | Status |
| --- | --- | --- | --- | --- |
| APP-01 | Semua analisis memerlukan login dan history milik pengguna | GH-01, HIST-01, DATA-01 | T-GH-01, T-DATA-01, T-HIST-01 | Planned |
| APP-02 | Setelah login, public repository pihak lain dapat dipilih melalui URL/slug | GH-02, REP-01 | T-GH-03, T-REP-01 | Planned |
| APP-03 | Hanya satu analysis repository aktif secara global dengan antrean | ANA-01 | T-ANA-01 | Planned |
| APP-04 | Target full SHA immutable sebelum antrean dan retry memakai record baru | REP-02, ANA-07 | T-REP-02, T-ANA-06 | Planned |
| APP-05 | Hasil/snapshot disimpan sampai user menghapus; deletion membersihkan turunannya | DATA-01, DATA-02 | T-DATA-01, T-DATA-02 | Planned |
| APP-06 | Semua komponen MVP berjalan lokal melalui Docker Compose | ENV-01, REL-01 | T-REL-01 | Planned |
| APP-07 | UI menggunakan Bahasa Indonesia | UI-01, QA-03 | T-UI-01 | Planned |
| APP-08 | Mobile first dengan pengalaman laptop/desktop yang tetap lengkap | UI-01, GRAPH-01, QA-03 | T-UI-01 | Planned |
| APP-09 | LLM tidak menjadi dependency MVP sebelum freeze | ENV-01, REL-01 | T-REL-01 dan review dependency/config | Planned |
| APP-10 | PHP dan JS/TS dikembangkan paralel dan diuji melalui capability matrix | ANA-03, ANA-04, QA-01 | T-ANA-03, T-ANA-04 | Dua capability matrix dan 21 fakta oracle teruji; QA-01 luas masih terbuka |
| APP-11 | Error pipeline, recovery, source unavailable, dan export retry dapat ditindaklanjuti | ANA-07, GRAPH-03, EXP-01, EXP-02 | T-ANA-06, T-GRAPH-03, T-EXP-03 | Planned |
| APP-12 | Seluruh fitur MVP ditargetkan selesai Sprint 2, Sprint 3 finishing | REL-01, FIN-01, FIN-02, FIN-03, FIN-04 | T-REL-01 dan review sprint | Planned |
| APP-13 | Handoff memakai issue/PR dan commit Conventional Commit satu kalimat | PLAN-01 | Pemeriksaan dokumentasi, issue/PR, dan metadata commit aktual | Kebijakan disepakati |

## Nonfunctional requirement dan batas teknis

ID `NFR-*` adalah indeks lokal untuk pengujian prinsip yang tersebar di SRS; bukan penomoran asli sumber.

| ID | Prinsip dan referensi SRS | Backlog | Test case | Status |
| --- | --- | --- | --- | --- |
| NFR-01 | Fakta teknis static analysis dan Exact/Unresolved, SRS 2.5 dan 5.4 | ANA-03, ANA-04, ANA-05, ANA-06 | T-ANA-03, T-ANA-04, T-DOC-01 | Fakta Exact/Unresolved adapter teruji; CKG/dokumen belum diterima |
| NFR-02 | Traceability file/baris, SRS 2.5 dan 5.4 | ANA-05, GRAPH-03, DOC-01, DOC-02 | T-ANA-04, T-GRAPH-03, T-DOC-01 | Planned |
| NFR-03 | Konsistensi snapshot yang sama, SRS 5.4 Reliability | REP-02, ANA-06 | T-REP-02, T-ANA-04 | Planned |
| NFR-04 | Source asli tidak berubah dan kode target tidak dieksekusi, SRS 5.2 dan glossary | REP-02, ANA-03, ANA-04 | T-SEC-01 | Snapshot/adapter teruji tanpa eksekusi source atau konfigurasi target |
| NFR-05 | Credential terlindungi dan akses user terisolasi, SRS 5.3 | GH-01, DATA-01, DATA-02 | T-GH-02, T-DATA-01, T-DATA-02, T-SEC-01 | Planned |
| NFR-06 | Progress tetap tersedia dan resource/performa diukur, SRS 5.1 | ENV-01, ANA-01, ANA-07, QA-01 | T-ANA-01, T-ANA-02, T-REL-01 | Microbenchmark adapter tersedia; performa representatif/progress E2E belum diterima, target angka TBD |
| NFR-07 | Usability serta bahasa/responsivitas keputusan project, SRS 5.4 dan APP-07/08 | UI-01, QA-03 | T-UI-01 | Planned |
| NFR-08 | Maintainability adapter/contracts dan interoperabilitas, SRS 5.4 | ENV-01, ANA-05, REL-01 | T-ANA-04, T-REL-01 | Planned |
| NFR-09 | Kegagalan export tidak mengubah hasil, SRS 5.2 | EXP-01, EXP-02 | T-EXP-03 | Planned |

## Resolusi ketidaksesuaian

Pakai Exact/Unresolved tanpa Inferred Static Edge; filter memakai kategori AST, bukan Service; context full SHA tetap; history berbasis status; source preview dan export membaca snapshot/document yang sama. Detail perubahan dan status 24 TBD ada di [decision log](DECISIONS.md).

## Mapping fase dan regression

Pemisahan berikut mempertahankan 72 ID SRS dan seluruh acceptance parent. Daftar requirement pada issue adalah konteks yang diwarisi dari paket sumber; fase hanya membuktikan scope yang tercantum, bukan otomatis memverifikasi semua requirement konteks tersebut.

| Paket fase/regression | Mewarisi konteks backlog | Bukti terbatas yang harus tersedia |
| --- | --- | --- |
| QA-01-S1 | QA-01 | T-ANA-03/T-ANA-04 (oracle minimum; semantic adapter acceptance tetap menunggu implementasi) |
| UI-01 | GH-01, REP-01, ANA-07, QA-03 | T-UI-01 (komponen dasar, bukan acceptance UI produk penuh) |
| ANA-05-S1 | ANA-05 | T-ANA-04 (kontrak minimum) |
| ANA-03-S1 | ANA-03 | T-ANA-03/T-ANA-04 (deklarasi minimum) |
| ANA-04-S1 | ANA-04 | T-ANA-03/T-ANA-04 (PHP minimum) |
| ANA-07-S1 | ANA-07 | T-ANA-02 (runner terkontrol; integrasi nyata NOT_RUN) |
| GRAPH-01-S1 | GRAPH-01 | T-GRAPH-01/T-UI-01 (fixture canvas dasar) |
| QA-03-S1 | QA-03 | T-UI-01 (baseline; acceptance UI produk lengkap tetap QA-03) |
| DOC-02 | DOC-01 | T-DOC-01, T-EXP-02, T-SEC-01 (bagian proyeksi/render) |
| FIN-03 | GH-01, GH-02, REP-01, ANA-07, HIST-01, QA-02 | T-GH-01/02/03, T-REP-01/02, T-ANA-01/02/06, T-HIST-01, T-REL-01 |
| FIN-04 | GRAPH-01, GRAPH-02, GRAPH-03, QA-03, EXP-02 | T-GRAPH-01/02/03, T-UI-01, T-EXP-02/03 |

UI-01 membuktikan komponen dasar, `*-S1` membuktikan hasil awal Sprint 1, dan DOC-02 membuktikan dua proyeksi diagram. Integrasi GitHub/analisis/ekspor nyata tetap diperiksa pada parent dan kasus penerimaan lengkap. FIN-03/04 mengulang kasus terkait setelah freeze; penambahan issue tidak menciptakan requirement sumber baru atau hasil PASS baru.

## Pemeliharaan mapping

Setelah issue nyata dibuat, tambahkan URL/nomor issue pada ID backlog terkait. Setelah pengujian, tautkan run yang memuat commit aplikasi, fixture/full SHA, versi config, serta hasil aktual. Requirement hanya menjadi Verified setelah bukti dan review sesuai [Definition of Done](DEFINITION_OF_DONE.md); persiapan, mock, atau screenshot saja tidak menutup seluruh requirement.

UI-02 (#59) dan UI-03 (#60) menambah frontend Figma pada Sprint 1. Preview progres/history/graph/dokumen menggunakan fixture ReportService tervalidasi, bukan hasil pipeline pengguna. Karena itu perubahan tampilan tidak menutup requirement analisis, persistensi history, generator artefak, atau ekspor produk. Bukti UI dicatat di [UI-02_CHECKS.md](UI-02_CHECKS.md).
