# Keputusan, TBD, dan risiko

Baseline: 18 Oktober 2026, Asia/Jakarta. `Disepakati` adalah keputusan project; `Rancangan awal` adalah detail teknis yang perlu dibuktikan/ditinjau pada issue terkait; `TBD eksternal` menunggu informasi di luar implementasi saat ini. Tidak ada status yang berarti fitur telah berjalan tanpa bukti pengujian.

## Keputusan project

| ID | Keputusan | Status | Dampak |
| --- | --- | --- | --- |
| D-01 | MVP berfungsi penuh di lokal; deployment/anggaran ditentukan dosen | Disepakati | Compose menjadi target penerimaan awal |
| D-02 | Next.js, TypeScript, Tailwind, worker Node, PostgreSQL/Prisma, Compiler API, nikic/PHP-Parser, Cytoscape.js, Playwright | Disepakati | Versi kompatibel dipin setelah spike |
| D-03 | Lingkungan lokal menggunakan Docker Compose | Disepakati | Source, database, dan export tetap ada sesudah restart |
| D-04 | Login GitHub wajib untuk seluruh analisis | Disepakati | Semua hasil/history/delete memiliki pemilik |
| D-05 | Repository publik pihak lain dapat dianalisis; private memerlukan izin GitHub yang benar | Disepakati | Tambahkan input publik di luar daftar instalasi App |
| D-06 | PHP dan JavaScript/TypeScript dikembangkan paralel | Disepakati | Dua adapter berbagi contracts; keduanya wajib dalam MVP |
| D-07 | Satu analisis repository aktif global; sembilan tahap berurutan | Disepakati | Queue dan concurrency guard harus diuji |
| D-08 | Data hasil/snapshot dipertahankan sampai pemilik menghapusnya | Disepakati | Tambahkan lifecycle delete; expiry token tetap berlaku |
| D-09 | UI Indonesia, mobile first, dominan penggunaan web/laptop | Disepakati | Label prototype Inggris diadaptasi; responsive QA wajib |
| D-10 | LLM opsional setelah MVP freeze | Disepakati | Tidak ada ketergantungan model/API LLM pada MVP |
| D-11 | Satu siklus sprint terdiri atas dua minggu pengerjaan dan satu minggu review | Disepakati | Mulai 12 Oktober 2026; tanggal lengkap di sprint plan |
| D-12 | Seluruh fitur MVP selesai pada Sprint 2; Sprint 3 finishing | Disepakati | Generator dokumen, graph, history, dan ekspor masuk Sprint 2 |
| D-13 | Tanggung jawab dibagi berdasarkan modul dan deliverable; Iltizam melakukan review teknis dan merge PR | Disepakati | Scope, penanggung jawab, dan hasil aktual dicatat pada issue/PR |
| D-14 | Pembagian kerja memakai Issues, milestone sprint, commit/PR, dan bukti verifikasi | Disepakati | 28 Issues awal dan tiga milestone dibuat pada 18 Oktober 2026; revisi pembagian menambah 11 issue fase/finishing menjadi 39, mapping di product backlog |
| D-15 | Pesan commit Conventional Commit, satu baris/satu kalimat | Disepakati | Rincian pekerjaan dan bukti ada di issue/PR |
| D-16 | Pembagian dinilai berdasarkan bobot pekerjaan dan bukti kontribusi tiap sprint; jumlah issue boleh berbeda | Disepakati 18 Oktober 2026 | Queue ke Rizqy, PHP ke Zarra, PDF/proyeksi diagram ke Valentina; fase Sprint 1 dan empat paket finishing eksplisit; ukuran parent hanya scope sisa, tanpa memindahkan bukti historis |
| D-17 | Zarra bergabung sebagai `zarrrafirdaus`; seluruh paketnya memakai assignee tersebut | Diterapkan 18 Oktober 2026 | Sepuluh issue di-assign; kepemilikan dan bobot pekerjaan tidak berubah |
| D-18 | PR tetap wajib, dengan minimum approval 0 agar penulis dapat merge PR sendiri setelah pemeriksaan | Diterapkan 18 Oktober 2026 | Review/bukti tetap dicatat; resolusi percakapan, pembatasan push/merge, enforcement admin, serta larangan force push/delete tetap berlaku |

## Rancangan teknis awal

| ID | Pilihan awal | Issue pembuktian |
| --- | --- | --- |
| A-01 | Queue/lease PostgreSQL dengan global analysis slot; worker memproses job di luar request web | ANA-01 |
| A-02 | Polling progress dengan backoff dan penghentian pada terminal state | ANA-07 |
| A-03 | Retry membuat analysis ID baru dengan full SHA/config yang sama | ANA-07 |
| A-04 | Resolve commit sekali saat submission sebelum antrean; snapshot immutable | REP-02 |
| A-05 | Graph JSONB berversi dan artefak tersimpan pada persistent volume | DATA-01 |
| A-06 | Publish result bundle atomik sesudah sembilan stage; generator gagal berarti analysis gagal | DOC-01 |
| A-07 | Export job terpisah, deduplikasi per format/document hash, file ready hanya sesudah ditulis | EXP-01, EXP-02 |
| A-08 | Software Engineering Diagram berupa proyeksi struktur/dependency dari CKG | DOC-02, DOC-01 |
| A-09 | Authenticated encryption untuk credential, key terpisah di environment; session server-side | GH-01, DATA-01 |
| A-10 | Delete hanya untuk analysis terminal tanpa export aktif; cleanup idempotent dan akses langsung dicabut | DATA-02 |
| A-11 | Mermaid telah lolos probe SVG/PDF ENV-01; proyeksi diagram produk dan Markdown/PDF terintegrasi tetap perlu diuji | DOC-02, DOC-01, EXP-01, EXP-02 |
| A-12 | Query AND kategori; focus context diberi penanda; hitungan canonical tidak berubah | GRAPH-01, GRAPH-02 |
| A-13 | Batas resource wajib sebelum repository arbitrer; nilai dari fixture/benchmark lokal | ENV-01, QA-01 |

Jika pembuktian menunjukkan pilihan awal tidak cocok, issue harus menjelaskan alternatif, tradeoff, dan perubahan pada kontrak sebelum integrasi. Pilihan awal bukan janji kemampuan yang telah diuji.

## Penyelarasan sumber

| Perbedaan | Baseline yang dipakai |
| --- | --- |
| Lampiran use case masih menyebut Inferred Static Edge | Exact/Unresolved mengikuti scope SRS dan keputusan MVP |
| Skenario filter menyebut Service | Pakai kategori AST nyata; Service menjadi nama/peran |
| History memiliki alur ke halaman detail tambahan di sebagian lampiran | Running/queued/failed -> progress; hasil tersedia -> graph; dokumen diakses dari graph |
| Snapshot seolah diambil dua kali pada pemilihan dan pipeline | Submission resolve SHA; stage pertama mengambil satu snapshot untuk SHA tersebut |
| Contoh Completed tidak punya graph karena prototype tidak menyediakannya | Produk nyata harus memiliki result bundle untuk setiap status Completed |
| Priority SRS masih TBD, sprint awal menandai export/history Should Have | Enam fitur tetap wajib untuk penerimaan lokal; urutan pengerjaan diprioritaskan per dependensi |
| Pipeline selesai di Sprint 2 tetapi generator belum tercantum | Generator dan export ditargetkan selesai Sprint 2 |
| Estimasi 6/7/7 dan grafik tanpa titik nol | Simpan sebagai estimasi awal; reestimasi backlog dan tampilkan titik awal/akhir sprint dengan jelas |
| Copy UI Inggris pada Figma dan Indonesia pada SRS | UI Indonesia, identifier teknis dipertahankan |

## Register 24 TBD SRS

Nomor berikut mengikuti Appendix C. `Sebagian` berarti keputusan inti tersedia tetapi detail atau buktinya belum lengkap.

| No. | Topik | Status baseline dan tindak lanjut | Penanggung jawab / target |
| --- | --- | --- | --- |
| 1 | Versi software | TBD; planning baseline v0.1 bukan versi release aplikasi | Iltizam / sebelum REL-01 |
| 2 | Metadata referensi | Sebagian; filename/hash PDF dan Figma dicatat di SOURCES; akses arsip tim perlu dipastikan | Zarra / Sprint 1 |
| 3 | Server/framework/database/deployment | Sebagian; stack dan Docker lokal dipilih, produksi menunggu dosen | Iltizam / ENV-01; produksi eksternal |
| 4 | Dokumentasi pengguna | Rancangan awal; panduan setup/demo dan troubleshooting ditulis dari command yang benar-benar lulus | Zarra / REL-01 |
| 5 | Parser/library/framework/storage | Sebagian; pilihan utama disepakati, versi/renderer dipin pada spike | Iltizam / ENV-01 |
| 6 | Hardware minimum | TBD; benchmark CPU/RAM/disk dan limits | Zarra bersama Iltizam / QA-01 sebelum release |
| 7 | Static analysis tool | Sebagian; Compiler API dan PHP-Parser dipilih, kemampuan perlu fixture | Iltizam (JS/TS), Zarra (PHP) / ANA-03, ANA-04 |
| 8 | PDF/Markdown generator | Sebagian; document model dan Playwright dipilih, renderer diagram diuji | Zarra (catalog/MD), Valentina (diagram/PDF) / DOC-01, DOC-02, EXP-01, EXP-02 |
| 9 | Database/storage/persistence | Sebagian; PostgreSQL/Prisma dan volume; migrasi infrastruktur sudah diuji ENV-01, entitas produk belum | Zarra / DATA-01 |
| 10 | Provider/model LLM | Ditunda secara sengaja sampai MVP freeze | Iltizam / keputusan setelah Sprint 2 |
| 11 | Pembaruan progress | Rancangan awal polling; interval/backoff diuji | Rizqy / ANA-07 |
| 12 | Format pesan | Rancangan awal JSON/CCM schema v1; validator dan kompatibilitas diuji | Iltizam / ANA-05 |
| 13 | Protokol dan keamanan komunikasi | Sebagian; HTTP loopback lokal, HTTPS produksi menunggu deployment; callback/session wajib aman | Iltizam / GH-01 |
| 14 | Prioritas fitur | Ditutup untuk scope; seluruh enam fitur wajib pada target lokal, prioritas tugas dicatat di backlog | Iltizam / baseline |
| 15 | Respons UI maksimum | TBD; target terukur ditetapkan setelah benchmark, tanpa ETA/persentase palsu | Valentina / QA-03 |
| 16 | Durasi maksimum analisis | TBD; timeout/config berdasarkan benchmark repository uji | Zarra / QA-01 |
| 17 | Ukuran repository | TBD; batas compressed/extracted/files diterapkan setelah spike | Iltizam / ENV-01 |
| 18 | Konkurensi | Sebagian; satu analysis global disepakati, kapasitas antrean/user tetap dibenchmark | Rizqy / ANA-01 |
| 19 | Kebijakan safety tambahan | TBD eksternal; tidak ada kebijakan tambahan yang diasumsikan | Iltizam / konfirmasi dosen bila ada |
| 20 | Penyimpanan token | Rancangan awal encryption/session server-side; expiry/revocation wajib diuji | Iltizam / GH-01, DATA-01 |
| 21 | Enkripsi/data at rest | Sebagian; credential encryption dirancang, storage/host produksi mengikuti lingkungan dosen | Zarra / DATA-01 |
| 22 | Retensi/penghapusan | Sebagian; sampai user menghapus, cleanup lokal dirancang; backup produksi TBD | Zarra / DATA-02 |
| 23 | Regulasi/kebijakan/sertifikasi | TBD eksternal; tidak ada klaim kepatuhan atau sertifikasi | Iltizam / bila ditentukan dosen |
| 24 | Kebutuhan tambahan | Sebagian; UI Indonesia/mobile, public repository pihak lain, dan deletion ditambahkan sebagai requirement lokal | Iltizam / traceability |

## Risiko dan mitigasi

| Risiko | Dampak | Mitigasi dan pemilik |
| --- | --- | --- |
| Target luas analyzer melebihi waktu | Fitur tampak lengkap tetapi resolver salah | Capability matrix + fixture per konstruksi; unresolved jujur; Iltizam/Zarra |
| Antrean review dan integrasi antarmodul | Paket yang siap tertahan sebelum terintegrasi | PR kecil, dependensi jelas, dan bukti verifikasi tersedia sebelum review; seluruh tim |
| Dua bahasa dan perubahan mayor library | Kontrak adapter tidak kompatibel | Pin versi, spike dua bahasa di Sprint 1, contracts tunggal; Iltizam/Zarra |
| GitHub App/izin belum dikonfigurasi | Private repo dan login belum dapat dibuktikan | Tutup GH-01 lebih awal; jangan ganti dengan demo palsu saat release; Iltizam |
| Fixture belum tersedia | Tidak ada oracle untuk ketepatan graph | QA-01 membuat source kecil dan expected output yang direview sebelum klaim analyzer; Zarra |
| Scope dipadatkan ke Sprint 2 | Testing/ekspor tertunda | Integrasi tipis awal, generator dimulai sebelum semua UI selesai, reestimasi tiap review termasuk beban review/merge; seluruh tim |
| Repo besar/berbahaya | Resource habis atau source mengeksekusi sesuatu | Batas ekstraksi, worker terpisah, tanpa eksekusi target, timeout; Iltizam |
| File private masuk Git/log/public URL | Kebocoran data | Ignore storage/secret, redaction, otorisasi, pemeriksaan diff; seluruh tim |
| Dokumentasi planning dianggap bukti runtime | Pelaporan progres keliru | Status planned vs tested dan bukti per issue; Rizqy/Zarra |
| Keterlacakan deliverable belum lengkap | Hasil dan keputusan penerimaan sulit diperiksa | Hubungkan issue, PR, commit, dan hasil pengujian aktual; seluruh tim |

## Perubahan keputusan

Setiap perubahan mencatat tanggal, alasan, alternatif, dampak requirement/kontrak, dan issue terkait. Keputusan eksternal tidak ditebak. Penutupan TBD teknis memerlukan hasil pembuktian, bukan hanya nama library.
