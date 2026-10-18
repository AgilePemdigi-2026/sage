# Sprint plan

Baseline: 18 Oktober 2026, Asia/Jakarta. Rencana ini menggantikan pembagian fitur 6/7/7 pada PDF awal untuk pelaksanaan mendatang. Histori estimasi awal tetap dicatat di [sumber](SOURCES.md). Pembagian 39 issue berdasarkan bobot dan bukti tiap anggota telah diterapkan pada GitHub; lihat [alokasi sprint](SPRINT_ALLOCATION.md).

## Kalender yang disepakati

Satu siklus = 14 hari pengerjaan + 7 hari review user story. Tanggal 26 Oktober dan 2 November adalah batas pergantian fase; tabel berikut memakai rentang tanggal inklusif agar hari tidak tumpang tindih.

| Sprint | Pengerjaan minggu 1 | Pengerjaan minggu 2 | Review |
| --- | --- | --- | --- |
| 1 | 12-18 Oktober 2026 | 19-25 Oktober 2026 | 26 Oktober-1 November 2026 |
| 2 | 2-8 November 2026 | 9-15 November 2026 | 16-22 November 2026 |
| 3 | 23-29 November 2026 | 30 November-6 Desember 2026 | 7-13 Desember 2026 |

Target feature-complete: 15 November 2026. Review penerimaan MVP: 16-22 November 2026. Sprint 3 berfokus pada finishing, bukan penundaan sengaja fitur wajib yang belum ada.

Baseline awal 18 Oktober berisi planning. Pada tanggal yang sama, ENV-01 dan seed QA-01 mulai diimplementasikan; status serta bukti fondasi dicatat di [pemeriksaan environment](ENVIRONMENT_CHECKS.md), terpisah dari acceptance fitur produk. Kalender minggu pertama tidak boleh diisi sebagai pekerjaan selesai secara retrospektif. Kapasitas sisa Sprint 1 dan estimasi harus ditinjau pada issue ENV-01.

## Sprint 1: fondasi dan jalur dasar dua bahasa

Tujuan: setup lokal dapat direproduksi, login/target repository berfungsi, serta kontrak dan jalur dasar analyzer PHP dan JS/TS tersedia untuk integrasi.

| Area | Paket | Hasil yang ditinjau |
| --- | --- | --- |
| Planning | PLAN-01 | Dokumen, traceability, dan aturan issue/commit |
| Environment/data | ENV-01, DATA-01 | Docker bersih, versi, migrasi, session, storage, limits awal |
| Akses/target | GH-01, GH-02, REP-01, REP-02 | Login nyata, public pihak lain/private berizin, target full SHA, snapshot |
| Queue dan source | ANA-01, ANA-02 | Satu analysis global, deteksi/exclusion, status awal |
| Analyzer/contracts | QA-01-S1, ANA-05-S1, ANA-03-S1, ANA-04-S1 | Oracle minimum (Zarra), kontrak/JS/TS (Iltizam), PHP (Zarra) menuju CCM |
| Runner/progress | ANA-07-S1 | Rizqy: sembilan key tahap, persistensi state, failure menghentikan downstream; stub tepercaya berlabel pada test |
| UI dasar | UI-01, GRAPH-01-S1, QA-03-S1 | Valentina: komponen responsive, canvas fixture valid, keyboard dan lima viewport |

Review user story menilai login, penolakan izin, search/branch/commit invalid, snapshot immutable, antrean dua request, serta contoh source PHP dan JS/TS. Adapter dasar tidak berarti fitur analisis lengkap sudah Done. Ketiga artefak dan ekspor tetap harus dituntaskan pada Sprint 2.

## Sprint 2: seluruh alur MVP

Tujuan: source repository terotorisasi berubah menjadi graph dan tiga artefak yang bisa diperiksa serta diekspor; seluruh alur inti dan error memiliki bukti uji.

| Urutan dependensi | Paket | Hasil |
| --- | --- | --- |
| 1 | ANA-03, ANA-04, ANA-05, QA-01 | Capability matrix dan fixture dua adapter lengkap sesuai scope penerimaan |
| 2 | ANA-06, DOC-02, DOC-01, ANA-07 | CKG (Iltizam), proyeksi UML/struktur (Valentina), catalog/ADD (Zarra), pipeline nyata (Rizqy) |
| 3 | GRAPH-01, GRAPH-02, GRAPH-03 | Navigasi graph, query/filter, inspector, source preview |
| 4 | EXP-01, EXP-02, HIST-01, DATA-02 | Markdown/PDF nyata, history, penghapusan dan cleanup |
| 5 | QA-02, QA-03, REL-01 | E2E, private/public nyata, UI mobile/desktop, release lokal dan freeze |

Ukuran parent QA-01, ANA-03/04/05/07, GRAPH-01, QA-03, dan DOC-01 kini mengacu scope sisa setelah paket fase/proyeksi dipisah; jangan menghitung pekerjaan anak lagi. PDF EXP-02 menjadi tanggung jawab Valentina, Markdown EXP-01 tetap Zarra. Pengujian integrasi QA-02 diperkirakan XL agar beban verifikasi penuh terlihat.

Pengerjaan dapat overlap berdasarkan contracts dan fixture, tetapi acceptance final tetap menunggu integrasi nyata. Generator dokumen mulai segera setelah CKG minimal valid; tidak menunggu seluruh polish UI.

Review 16-22 November menjalankan seluruh kasus wajib dari [test plan](TEST_PLAN.md). Requirement yang gagal tetap terbuka; target Sprint 2 bukan izin untuk mencatat fitur gagal sebagai selesai. Jika kapasitas tidak cukup, perubahan scope/jadwal harus dicatat sebagai keputusan project.

## Sprint 3: finishing

Tujuan: memperbaiki temuan review, memperkuat regression, menyesuaikan performa berdasarkan benchmark, merapikan UI, dan menyiapkan demo yang dapat direplay.

| Anggota | Paket | Hasil finishing yang diperiksa |
| --- | --- | --- |
| Iltizam | FIN-01 | Regression analyzer/worker/CCM/CKG/evidence serta benchmark dan perbaikan performa |
| Rizqy | FIN-03 | Regression GitHub/repository/queue/pipeline/retry/history dan integrasi |
| Valentina | FIN-04 | Regression graph/inspector/source, keyboard/lima viewport, visual seluruh halaman PDF |
| Zarra | FIN-02 | Verifikasi dokumen, panduan setup/pengguna, keterbatasan, dan replay demo sesudah tiga paket regression |

Keempat paket menghasilkan laporan hasil aktual; perbaikan dilakukan jika ada temuan. Tidak diperlukan bug fiktif atau jumlah commit yang sama. Usulan LLM hanya dievaluasi setelah freeze dan tidak menjadi dependency kelulusan MVP. Deployment produksi mengikuti keputusan dosen yang terpisah.

## Review dan Definition of Done

Setiap review mencatat user story/requirement, analysis ID/full SHA, langkah uji, expected vs actual, bukti, dan keputusan pass/fail. Kegagalan menjadi issue terhubung, dengan owner serta prioritas yang jelas. Tanggal review tidak menggantikan bukti hasil run.

Pembagian modul dan deliverable mengikuti [CONTRIBUTING.md](../CONTRIBUTING.md). Setiap issue memiliki penanggung jawab paket dan bukti verifikasi. Iltizam bertanggung jawab melakukan review teknis serta merge PR ke `main`; hasil pekerjaan aktual dicatat pada issue/PR terkait.

## Burndown dan pelaporan

Total 20 serta pembagian 6/7/7 berasal dari estimasi fitur awal. Jika grafik awal ditampilkan sebagai akhir sprint, titik yang benar adalah awal 20, akhir Sprint 1 = 14, akhir Sprint 2 = 7, akhir Sprint 3 = 0. Itu tetap grafik rencana awal, bukan aktual atau rencana feature-complete baru.

Baseline revisi harus mengestimasi paket yang sudah dipecah sebelum membuat garis ideal baru. Sumbu waktu membedakan awal project dan akhir setiap sprint. Actual remaining baru berkurang ketika issue memenuhi DoD; pekerjaan parsial, spike, atau UI dummy tidak mengurangi sisa effort fitur penuh. Hindari mengonversi T-shirt size menjadi hari tanpa data kapasitas/velocity.

## Ketergantungan yang harus diselesaikan awal

Konfigurasi GitHub App/callback, penerimaan undangan Zarra, repository uji yang disediakan tim, review oracle fixture, serta penerapan batas resource masih perlu pekerjaan nyata. Versi/renderer fondasi sudah diuji pada ENV-01; integrasi produk belum diterima. Tidak ada blocker tersebut yang dinyatakan selesai hanya karena sudah memiliki rencana.
