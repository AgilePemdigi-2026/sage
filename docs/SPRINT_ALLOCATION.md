# Alokasi pekerjaan per sprint

Revisi 20 Oktober 2026 telah diterapkan pada GitHub Issues. Dasar pembagian adalah bobot deliverable dan bukti kontribusi setiap sprint; jumlah issue boleh berbeda. Perubahan ini mempertahankan kalender, target feature-complete 15 November, serta acceptance MVP.

## Pemetaan anggota

| Penanggung jawab | Akun GitHub | Assignment |
| --- | --- | --- |
| Iltizam Muhammad Hasan | `iltizamhasan3` | Aktif; review teknis dan merge PR |
| Rizqy Fadhil Athallah | `rizqy-fadhil` | Aktif |
| Valentina Hermawan | `liliks13` | Aktif |
| Zarra Firdaus Ananda Salia | `zarrrafirdaus` | Aktif; 11 paket sudah di-assign |

## Deliverable tiap anggota

| Anggota | Sprint 1: fondasi dan jalur dasar | Sprint 2: integrasi MVP | Sprint 3: finishing |
| --- | --- | --- | --- |
| Iltizam | Planning dan environment; login/snapshot; kontrak CCM/evidence dan deklarasi JS/TS dasar | Hardening kontrak, resolver JS/TS, canonical CKG, release freeze | Regression analyzer/worker/evidence dan performa |
| Rizqy | Akses repository, target/API, queue global, runner/progress dasar | Pipeline sembilan tahap nyata, history, pengujian integrasi penuh | Regression GitHub/repository/queue/pipeline/history |
| Valentina | Shell dan komponen UI, canvas fixture bervalidasi, baseline keyboard/lima viewport; frontend Figma landing/repository/progres/history/graph | Graph nyata, filter/inspector/source, proyeksi UML/struktur, PDF, verifikasi UI lengkap | Regression graph/UI/aksesibilitas dan visual seluruh halaman PDF |
| Zarra | Model data/session/credential, oracle minimum, deteksi source, adapter PHP dasar; frontend dokumen Figma dan sinkronisasi docs | Oracle/benchmark tambahan, resolver PHP, catalog/ADD, Markdown, deletion/cleanup | Verifikasi dokumen, panduan pengguna, dan demo |

Review/merge adalah tanggung jawab tambahan Iltizam yang harus masuk peninjauan kapasitas. Sprint 1 berjalan sejak 12 Oktober; alokasi dibuat pada 18 Oktober, sehingga kapasitas sisa harus dinilai dari waktu yang masih tersedia. PLAN-01/ENV-01 dan seed QA-01 mempertahankan bukti serta author aktualnya.

## Daftar issue per milestone

Tabel ini menunjukkan jumlah dan keterlacakan scope. Parent lintas sprint dihitung pada milestone acceptance Sprint 2; pekerjaan awalnya tercatat pada issue fase Sprint 1. Angka bukan skor, jam, atau pernyataan effort sama.

| Anggota | Sprint 1 | Sprint 2 | Sprint 3 |
| --- | --- | --- | --- |
| Iltizam | 6: [PLAN-01 #1](https://github.com/AgilePemdigi-2026/sage/issues/1), [ENV-01 #2](https://github.com/AgilePemdigi-2026/sage/issues/2), [GH-01 #5](https://github.com/AgilePemdigi-2026/sage/issues/5), [REP-02 #8](https://github.com/AgilePemdigi-2026/sage/issues/8), [ANA-05-S1 #32](https://github.com/AgilePemdigi-2026/sage/issues/32), [ANA-03-S1 #33](https://github.com/AgilePemdigi-2026/sage/issues/33) | 4: [ANA-05 #11](https://github.com/AgilePemdigi-2026/sage/issues/11), [ANA-03 #12](https://github.com/AgilePemdigi-2026/sage/issues/12), [ANA-06 #14](https://github.com/AgilePemdigi-2026/sage/issues/14), [REL-01 #26](https://github.com/AgilePemdigi-2026/sage/issues/26) | 1: [FIN-01 #27](https://github.com/AgilePemdigi-2026/sage/issues/27) |
| Rizqy | 4: [GH-02 #6](https://github.com/AgilePemdigi-2026/sage/issues/6), [REP-01 #7](https://github.com/AgilePemdigi-2026/sage/issues/7), [ANA-01 #9](https://github.com/AgilePemdigi-2026/sage/issues/9), [ANA-07-S1 #35](https://github.com/AgilePemdigi-2026/sage/issues/35) | 3: [ANA-07 #16](https://github.com/AgilePemdigi-2026/sage/issues/16), [HIST-01 #22](https://github.com/AgilePemdigi-2026/sage/issues/22), [QA-02 #24](https://github.com/AgilePemdigi-2026/sage/issues/24) | 1: [FIN-03 #39](https://github.com/AgilePemdigi-2026/sage/issues/39) |
| Valentina | 4: [UI-01 #30](https://github.com/AgilePemdigi-2026/sage/issues/30), [GRAPH-01-S1 #36](https://github.com/AgilePemdigi-2026/sage/issues/36), [QA-03-S1 #37](https://github.com/AgilePemdigi-2026/sage/issues/37), [UI-02 #59](https://github.com/AgilePemdigi-2026/sage/issues/59) | 6: [DOC-02 #38](https://github.com/AgilePemdigi-2026/sage/issues/38), [GRAPH-01 #17](https://github.com/AgilePemdigi-2026/sage/issues/17), [GRAPH-02 #18](https://github.com/AgilePemdigi-2026/sage/issues/18), [GRAPH-03 #19](https://github.com/AgilePemdigi-2026/sage/issues/19), [EXP-02 #21](https://github.com/AgilePemdigi-2026/sage/issues/21), [QA-03 #25](https://github.com/AgilePemdigi-2026/sage/issues/25) | 1: [FIN-04 #40](https://github.com/AgilePemdigi-2026/sage/issues/40) |
| Zarra | 5: [DATA-01 #3](https://github.com/AgilePemdigi-2026/sage/issues/3), [QA-01-S1 #31](https://github.com/AgilePemdigi-2026/sage/issues/31), [ANA-02 #10](https://github.com/AgilePemdigi-2026/sage/issues/10), [ANA-04-S1 #34](https://github.com/AgilePemdigi-2026/sage/issues/34), [UI-03 #60](https://github.com/AgilePemdigi-2026/sage/issues/60) | 5: [QA-01 #4](https://github.com/AgilePemdigi-2026/sage/issues/4), [ANA-04 #13](https://github.com/AgilePemdigi-2026/sage/issues/13), [DOC-01 #15](https://github.com/AgilePemdigi-2026/sage/issues/15), [EXP-01 #20](https://github.com/AgilePemdigi-2026/sage/issues/20), [DATA-02 #23](https://github.com/AgilePemdigi-2026/sage/issues/23) | 1: [FIN-02 #28](https://github.com/AgilePemdigi-2026/sage/issues/28) |

Total: 19 issue milestone Sprint 1, 18 Sprint 2, dan 4 Sprint 3. Ada 41 issue; delapan anak memiliki relasi parent native GitHub. Rincian ukuran/dependensi/acceptance ada di [backlog](PRODUCT_BACKLOG.md).

## Pemisahan scope dan bukti

| Parent | Paket yang diterima terpisah | Batas yang diperiksa |
| --- | --- | --- |
| [QA-01 #4](https://github.com/AgilePemdigi-2026/sage/issues/4) | [QA-01-S1 #31](https://github.com/AgilePemdigi-2026/sage/issues/31) | Sprint 2: oracle capability tambahan, fixture berbahaya, dan benchmark representatif; oracle minimum diterima pada QA-01-S1. |
| [ANA-05 #11](https://github.com/AgilePemdigi-2026/sage/issues/11) | [ANA-05-S1 #32](https://github.com/AgilePemdigi-2026/sage/issues/32) | Sprint 2: hardening schema/validator, taxonomy dan kompatibilitas hasil dua adapter; kontrak minimum diterima pada ANA-05-S1. |
| [ANA-03 #12](https://github.com/AgilePemdigi-2026/sage/issues/12) | [ANA-03-S1 #33](https://github.com/AgilePemdigi-2026/sage/issues/33) | Sprint 2: resolver imports/calls/types/member lintas file, dynamic/unresolved, capability matrix dan replay; deklarasi dasar pada ANA-03-S1. |
| [ANA-04 #13](https://github.com/AgilePemdigi-2026/sage/issues/13) | [ANA-04-S1 #34](https://github.com/AgilePemdigi-2026/sage/issues/34) | Sprint 2: resolver namespace/use/member/inheritance/Composer statis, dynamic/unresolved dan replay; deklarasi dasar pada ANA-04-S1. |
| [ANA-07 #16](https://github.com/AgilePemdigi-2026/sage/issues/16) | [ANA-07-S1 #35](https://github.com/AgilePemdigi-2026/sage/issues/35) | Sprint 2: sambungkan sembilan tahap nyata, atomic bundle, izin retry, recovery dan polling terminal; runner dasar pada ANA-07-S1. |
| [GRAPH-01 #17](https://github.com/AgilePemdigi-2026/sage/issues/17) | [GRAPH-01-S1 #36](https://github.com/AgilePemdigi-2026/sage/issues/36) | Sprint 2: integrasi CKG nyata, focus/overview/references dan counts canonical; canvas fixture dasar pada GRAPH-01-S1. |
| [QA-03 #25](https://github.com/AgilePemdigi-2026/sage/issues/25) | [QA-03-S1 #37](https://github.com/AgilePemdigi-2026/sage/issues/37) | Sprint 2: verifikasi semua screen dan state produk pada data analisis nyata; baseline UI pada QA-03-S1. |
| [DOC-01 #15](https://github.com/AgilePemdigi-2026/sage/issues/15) | [DOC-02 #38](https://github.com/AgilePemdigi-2026/sage/issues/38) | Interface Catalog, model ADD, context/provenance dan publish bundle atomik. UML/diagram struktur dipasok DOC-02; kriteria tiga artefak lengkap tetap wajib. |

UI-01 adalah paket mandiri untuk komponen reusable; REP-01 tetap memiliki API serta integrasi target. DOC-02 memasok dua proyeksi diagram, sedangkan DOC-01 menyusun Interface Catalog/ADD dan memastikan tiga artefak konsisten. Sample PDF ENV-01 tetap bukti renderer fondasi; EXP-02 harus menghasilkan ekspor produk terotorisasi dari hasil analisis nyata.

Setiap issue menyimpan perubahan substantif, commit/PR, test report atau review yang benar-benar dilakukan, pemeriksa aktual, expected vs actual, dan batas pengujian. Review ulang seed yang telah tersedia adalah aktivitas baru; penulis dan bukti awal tidak dipindahkan. Parent merujuk bukti anak tanpa menghitung ulang bobot pekerjaan yang sama.

## Review bobot dan kapasitas

Pada review sprint, bandingkan kompleksitas, dependensi/hambatan, perubahan yang diterima, hasil pengujian, serta waktu review tiap anggota. T-shirt size merupakan estimasi awal; tidak ada velocity atau actual effort yang sudah diukur. Jumlah issue yang berbeda di atas tidak dengan sendirinya membuktikan pembagian sudah sama berat.

Jika ada ketimpangan atau antrean review, pindahkan scope tersisa dengan persetujuan tim dan perbarui issue/backlog sebelum dikerjakan. Pertahankan bukti kontribusi aktual. Paket regression Sprint 3 menghasilkan laporan nyata bahkan jika tidak ditemukan bug; temuan baru dibuat ketika benar-benar ditemukan. Tidak ada fitur wajib yang sengaja ditunda ke Sprint 3.

Penambahan 20 Oktober: UI-02 dan UI-03 merupakan deliverable frontend substantif berdasarkan Figma. Riwayat author tetap dipertahankan. Progress/history/graph/dokumen pada preview memakai fixture tervalidasi; integrasi dan acceptance parent Sprint 2 tetap wajib. Volume lockfile, baris tambahan, dan jumlah merge tidak dipakai sebagai pengganti bukti bobot pekerjaan.
