# Sprint plan

Baseline: 18 Oktober 2026, Asia/Jakarta. Rencana ini menggantikan pembagian fitur 6/7/7 pada PDF awal untuk pelaksanaan mendatang. Histori estimasi awal tetap dicatat di [sumber](SOURCES.md).

## Kalender yang disepakati

Satu siklus = 14 hari pengerjaan + 7 hari review user story. Tanggal 26 Oktober dan 2 November adalah batas pergantian fase; tabel berikut memakai rentang tanggal inklusif agar hari tidak tumpang tindih.

| Sprint | Pengerjaan minggu 1 | Pengerjaan minggu 2 | Review |
| --- | --- | --- | --- |
| 1 | 12-18 Oktober 2026 | 19-25 Oktober 2026 | 26 Oktober-1 November 2026 |
| 2 | 2-8 November 2026 | 9-15 November 2026 | 16-22 November 2026 |
| 3 | 23-29 November 2026 | 30 November-6 Desember 2026 | 7-13 Desember 2026 |

Target feature-complete: 15 November 2026. Review penerimaan MVP: 16-22 November 2026. Sprint 3 berfokus pada finishing, bukan penundaan sengaja fitur wajib yang belum ada.

Pada 18 Oktober, repository baru memiliki baseline planning dan belum ada bukti eksekusi aplikasi. Kalender minggu pertama tidak boleh diisi sebagai pekerjaan selesai secara retrospektif. Kapasitas sisa Sprint 1 dan estimasi harus ditinjau pada issue ENV-01.

## Sprint 1: fondasi dan jalur dasar dua bahasa

Tujuan: setup lokal dapat direproduksi, login/target repository berfungsi, serta kontrak dan jalur dasar analyzer PHP dan JS/TS tersedia untuk integrasi.

| Area | Paket | Hasil yang ditinjau |
| --- | --- | --- |
| Planning | PLAN-01 | Dokumen, traceability, dan aturan issue/commit |
| Environment/data | ENV-01, DATA-01 | Docker bersih, versi, migrasi, session, storage, limits awal |
| Akses/target | GH-01, GH-02, REP-01, REP-02 | Login nyata, public pihak lain/private berizin, target full SHA, snapshot |
| Queue dan source | ANA-01, ANA-02 | Satu analysis global, deteksi/exclusion, status awal |
| Analyzer/contracts | QA-01 minimum, ANA-05 dasar, ANA-03/ANA-04 dasar | Fixture/oracle minimum dan dua adapter menuju CCM |
| UI dasar | QA-03 awal, ANA-07 awal | Bahasa, komponen responsive, progress yang membaca kontrak |

Review user story menilai login, penolakan izin, search/branch/commit invalid, snapshot immutable, antrean dua request, serta contoh source PHP dan JS/TS. Adapter dasar tidak berarti fitur analisis lengkap sudah Done. Ketiga artefak dan ekspor tetap harus dituntaskan pada Sprint 2.

## Sprint 2: seluruh alur MVP

Tujuan: source repository terotorisasi berubah menjadi graph dan tiga artefak yang bisa diperiksa serta diekspor; seluruh alur inti dan error memiliki bukti uji.

| Urutan dependensi | Paket | Hasil |
| --- | --- | --- |
| 1 | ANA-03, ANA-04, ANA-05, QA-01 | Capability matrix dan fixture dua adapter lengkap sesuai scope penerimaan |
| 2 | ANA-06, DOC-01, ANA-07 | CKG canonical, tiga artefak, sembilan stage, atomic result, failure/retry |
| 3 | GRAPH-01, GRAPH-02, GRAPH-03 | Navigasi graph, query/filter, inspector, source preview |
| 4 | EXP-01, EXP-02, HIST-01, DATA-02 | Markdown/PDF nyata, history, penghapusan dan cleanup |
| 5 | QA-02, QA-03, REL-01 | E2E, private/public nyata, UI mobile/desktop, release lokal dan freeze |

Pengerjaan dapat overlap berdasarkan contracts dan fixture, tetapi acceptance final tetap menunggu integrasi nyata. Generator dokumen mulai segera setelah CKG minimal valid; tidak menunggu seluruh polish UI.

Review 16-22 November menjalankan seluruh kasus wajib dari [test plan](TEST_PLAN.md). Requirement yang gagal tetap terbuka; target Sprint 2 bukan izin untuk mencatat fitur gagal sebagai selesai. Jika kapasitas tidak cukup, perubahan scope/jadwal harus dicatat sebagai keputusan project.

## Sprint 3: finishing

Tujuan: memperbaiki temuan review, memperkuat regression, menyesuaikan performa berdasarkan benchmark, merapikan UI, dan menyiapkan demo yang dapat direplay.

Paket FIN-01 dan FIN-02 menangani issue nyata yang ditemukan, hasil pengujian ulang, panduan pengguna/setup, catatan keterbatasan, dan evidence demo. Usulan LLM hanya dievaluasi setelah freeze dan tidak menjadi dependency kelulusan MVP. Deployment produksi mengikuti keputusan dosen yang terpisah.

## Review dan Definition of Done

Setiap review mencatat user story/requirement, analysis ID/full SHA, langkah uji, expected vs actual, bukti, dan keputusan pass/fail. Kegagalan menjadi issue terhubung, dengan owner serta prioritas yang jelas. Tanggal review tidak menggantikan bukti hasil run.

Pembagian peran mengikuti [CONTRIBUTING.md](../CONTRIBUTING.md). Implementasi inti terpusat pada Iltizam; anggota lain dapat memeriksa paket tanpa diwajibkan menulis kode, dengan hasil pemeriksaan yang nyata.

## Burndown dan pelaporan

Total 20 serta pembagian 6/7/7 berasal dari estimasi fitur awal. Jika grafik awal ditampilkan sebagai akhir sprint, titik yang benar adalah awal 20, akhir Sprint 1 = 14, akhir Sprint 2 = 7, akhir Sprint 3 = 0. Itu tetap grafik rencana awal, bukan aktual atau rencana feature-complete baru.

Baseline revisi harus mengestimasi paket yang sudah dipecah sebelum membuat garis ideal baru. Sumbu waktu membedakan awal project dan akhir setiap sprint. Actual remaining baru berkurang ketika issue memenuhi DoD; pekerjaan parsial, spike, atau UI dummy tidak mengurangi sisa effort fitur penuh. Hindari mengonversi T-shirt size menjadi hari tanpa data kapasitas/velocity.

## Ketergantungan yang harus diselesaikan awal

Konfigurasi GitHub App/callback, username anggota, repository uji yang disediakan tim, oracle fixture, serta batas resource/versi kompatibel masih perlu pekerjaan nyata. Tidak ada blocker tersebut yang dinyatakan selesai hanya karena sudah memiliki rencana.
