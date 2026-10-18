# Product backlog

Status: backlog terhubung ke 28 GitHub Issues dan tiga milestone sprint. ID internal tetap dipakai untuk traceability; nomor issue nyata tercantum di bawah. Assignment akun selain Iltizam menunggu username anggota. Kolom paket menunjukkan rencana penanggung jawab deliverable sesuai [alur kontribusi](../CONTRIBUTING.md). Iltizam menangani review teknis dan merge PR.

## Prioritas dan estimasi

`P0` diperlukan agar alur kritis atau kontrak aman dapat berjalan. `P1` tetap wajib untuk MVP lengkap, dengan urutan mengikuti dependensi. `P2` adalah finishing sesudah feature-complete. Semua enam fitur utama tetap masuk penerimaan lokal.

Ukuran S/M/L/XL/XXL adalah estimasi relatif awal per paket, belum dikalibrasi terhadap kapasitas aktual tim dan dependensi pekerjaan. Tidak dijumlahkan atau dibandingkan langsung dengan total 20 effort dari PDF, karena granularitas backlog berubah. Reestimasi dilakukan sesudah spike dan pada review Sprint 1; tidak ada actual effort yang diklaim pada baseline ini.

`1-2` berarti dasar dibangun Sprint 1, acceptance lengkap ditargetkan Sprint 2. Pekerjaan analisis tidak dihitung selesai hanya karena parser menghasilkan AST; kontrak, evidence, kegagalan, dan artefak harus lolos acceptance yang relevan.

## Paket pekerjaan

| ID | Deliverable | Sprint | Prioritas / ukuran | Penanggung jawab paket | Dependensi | Status | Issue |
| --- | --- | --- | --- | --- | --- | --- | --- |
| PLAN-01 | Baseline planning dan workflow issue | 1 | P0 / M | Iltizam | - | Done (baseline dokumentasi) | [#1](https://github.com/AgilePemdigi-2026/sage/issues/1) |
| ENV-01 | Spike stack, versi, Docker, limits awal, renderer diagram | 1 | P0 / L | Iltizam | PLAN-01 | In review | [#2](https://github.com/AgilePemdigi-2026/sage/issues/2) |
| DATA-01 | Schema, migrasi, session/credential storage, isolasi user | 1 | P0 / L | Zarra | ENV-01 | Planned | [#3](https://github.com/AgilePemdigi-2026/sage/issues/3) |
| QA-01 | Fixture/oracle PHP, JS, TS dan benchmark awal | 1-2 | P0 / L | Zarra | PLAN-01 | In progress | [#4](https://github.com/AgilePemdigi-2026/sage/issues/4) |
| GH-01 | Login GitHub App, callback, session, dan error | 1 | P0 / L | Iltizam | ENV-01, DATA-01 | Planned | [#5](https://github.com/AgilePemdigi-2026/sage/issues/5) |
| GH-02 | Daftar instalasi/private berizin dan resolve public pihak lain | 1 | P0 / L | Rizqy | GH-01 | Planned | [#6](https://github.com/AgilePemdigi-2026/sage/issues/6) |
| REP-01 | UI/API target, search, branch, commit, validasi | 1 | P0 / L | Rizqy | GH-02 | Planned | [#7](https://github.com/AgilePemdigi-2026/sage/issues/7) |
| REP-02 | Full SHA immutable dan snapshot aman | 1 | P0 / L | Iltizam | REP-01, DATA-01 | Planned | [#8](https://github.com/AgilePemdigi-2026/sage/issues/8) |
| ANA-01 | Queue durable dan global analysis slot | 1 | P0 / L | Iltizam | DATA-01 | Planned | [#9](https://github.com/AgilePemdigi-2026/sage/issues/9) |
| ANA-02 | Deteksi bahasa, exclusion, dan batas file | 1 | P0 / M | Zarra | REP-02 | Planned | [#10](https://github.com/AgilePemdigi-2026/sage/issues/10) |
| ANA-05 | Contracts CCM/evidence dan validator | 1-2 | P0 / L | Iltizam | ENV-01, QA-01 | Planned | [#11](https://github.com/AgilePemdigi-2026/sage/issues/11) |
| ANA-03 | Adapter JavaScript/TypeScript dan resolver | 1-2 | P0 / XXL | Iltizam | ANA-05, QA-01 | Planned | [#12](https://github.com/AgilePemdigi-2026/sage/issues/12) |
| ANA-04 | Adapter PHP dan resolver | 1-2 | P0 / XXL | Iltizam | ANA-05, QA-01 | Planned | [#13](https://github.com/AgilePemdigi-2026/sage/issues/13) |
| ANA-06 | Canonical CKG, provenance, dan persistensi | 2 | P0 / L | Iltizam | ANA-03, ANA-04, ANA-05 | Planned | [#14](https://github.com/AgilePemdigi-2026/sage/issues/14) |
| DOC-01 | Tiga artefak dan Architecture Definition Document | 2 | P0 / XL | Zarra | ANA-06 | Planned | [#15](https://github.com/AgilePemdigi-2026/sage/issues/15) |
| ANA-07 | Pipeline sembilan tahap, progress, failure/retry, atomic result | 1-2 | P0 / XL | Rizqy | ANA-01, ANA-02, ANA-06, DOC-01 | Planned | [#16](https://github.com/AgilePemdigi-2026/sage/issues/16) |
| GRAPH-01 | Graph canvas, mode, legend, zoom, dan counts | 2 | P1 / XL | Valentina | ANA-06 | Planned | [#17](https://github.com/AgilePemdigi-2026/sage/issues/17) |
| GRAPH-02 | Node Query dan filter kategori gabungan | 2 | P1 / M | Valentina | GRAPH-01 | Planned | [#18](https://github.com/AgilePemdigi-2026/sage/issues/18) |
| GRAPH-03 | Inspector, incoming/outgoing, evidence, source preview | 2 | P0 / L | Valentina | GRAPH-01, REP-02 | Planned | [#19](https://github.com/AgilePemdigi-2026/sage/issues/19) |
| EXP-01 | Markdown mandiri beserta failure/retry | 2 | P0 / L | Zarra | DOC-01 | Planned | [#20](https://github.com/AgilePemdigi-2026/sage/issues/20) |
| EXP-02 | PDF, print layout, diagram, dan download | 2 | P0 / L | Zarra | DOC-01, ENV-01 | Planned | [#21](https://github.com/AgilePemdigi-2026/sage/issues/21) |
| HIST-01 | History per user, search, empty/error, navigasi | 2 | P1 / M | Rizqy | DATA-01, ANA-01 | Planned | [#22](https://github.com/AgilePemdigi-2026/sage/issues/22) |
| DATA-02 | Penghapusan analysis dan cleanup storage/export | 2 | P1 / M | Zarra | DATA-01, EXP-01, EXP-02 | Planned | [#23](https://github.com/AgilePemdigi-2026/sage/issues/23) |
| QA-02 | Integrasi penuh, GitHub nyata, error, dan release evidence | 2 | P0 / L | Rizqy | GH-01, REP-02, ANA-07, GRAPH-03, EXP-01, EXP-02, HIST-01, DATA-02 | Planned | [#24](https://github.com/AgilePemdigi-2026/sage/issues/24) |
| QA-03 | Responsivitas, keyboard, bahasa UI, dan visual QA | 1-2 | P1 / L | Valentina | GRAPH-03, EXP-02, REP-01, HIST-01 | Planned | [#25](https://github.com/AgilePemdigi-2026/sage/issues/25) |
| REL-01 | MVP freeze lokal dan panduan setup/demo teruji | 2 | P0 / M | Iltizam | QA-02, QA-03 | Planned | [#26](https://github.com/AgilePemdigi-2026/sage/issues/26) |
| FIN-01 | Regression fixes, performa, dan polish | 3 | P2 / L | Iltizam | REL-01 | Planned | [#27](https://github.com/AgilePemdigi-2026/sage/issues/27) |
| FIN-02 | Review akhir, dokumentasi pengguna, dan demo | 3 | P2 / M | Zarra | FIN-01 | Planned | [#28](https://github.com/AgilePemdigi-2026/sage/issues/28) |

Paket QA-01 menutup oracle minimum lebih dahulu; fixture tambahan dapat diteruskan paralel hingga Sprint 2. Dependensi ANA-05 mengacu pada oracle minimum tersebut, bukan menunggu seluruh benchmark final.

## Acceptance criteria per paket

| ID | Kriteria penerimaan yang harus dibuktikan | Test case |
| --- | --- | --- |
| PLAN-01 | Tautan lokal valid, 72 requirement unik terpetakan, kalender/enum konsisten, status planning jelas, dan commit baseline tersimpan | Pemeriksaan dokumentasi |
| ENV-01 | Setup bersih Docker, versi/lockfile dipin, Node/PHP/Chromium kompatibel, health/migration siap, batas awal dicatat, renderer diagram terbukti | T-REL-01, T-SEC-01 |
| DATA-01 | Migrasi bersih, sesi/credential aman, record user terisolasi, hasil bertahan setelah restart | T-DATA-01 |
| QA-01 | Source fixture kecil tiap bahasa, oracle yang direview, dynamic/unresolved dan Unicode termasuk, ukuran/waktu/RAM dicatat | T-ANA-03, T-ANA-04, T-ANA-05 |
| GH-01 | Login/logout nyata, state replay ditolak, denial/failure dapat dipulihkan, secret tidak terekspos | T-GH-01, T-GH-02 |
| GH-02 | Public pihak lain dan private berizin berhasil, private tanpa izin ditolak, rate limit/unavailable punya pesan aman | T-GH-03 |
| REP-01 | List/search/empty/error, branch aktual, commit opsional, input invalid ditolak sebelum job | T-REP-01, T-REP-02 |
| REP-02 | SHA tersimpan sebelum antrean, HEAD berubah tidak mengubah snapshot, archive/hash/path/limits valid | T-REP-02, T-SEC-01 |
| ANA-01 | Dua submission tidak menghasilkan dua job RUNNING, antrean/restart aman, lock global diuji dengan dua worker | T-ANA-01 |
| ANA-02 | Bahasa/exclusion dilaporkan, source didukung tetap dianalisis, tidak ada source didukung menghasilkan failure yang jelas | T-ANA-05 |
| ANA-03 | Capability matrix JS/TS beserta calls/types/imports sesuai oracle, dynamic tetap unresolved, tanpa eksekusi target | T-ANA-03, T-ANA-04 |
| ANA-04 | Capability matrix PHP beserta namespace/member/inheritance sesuai oracle, dynamic tetap unresolved | T-ANA-03, T-ANA-04 |
| ANA-05 | Schema validator menolak ID/edge/bounds invalid; konversi Unicode/CRLF dan hash benar | T-ANA-04 |
| ANA-06 | CKG deterministik, counts containment/reference benar, evidence/provenance lengkap, proyeksi tidak mengubah data | T-ANA-04, T-GRAPH-01 |
| DOC-01 | Ketiga artefak dari CKG yang sama, unresolved/evidence terpelihara, tidak menambah fakta, publish bundle atomik | T-DOC-01, T-ANA-02 |
| ANA-07 | Sembilan stage berurutan, polling berhenti terminal, failure/limitation/recovery benar, retry record baru dengan SHA sama | T-ANA-02, T-ANA-05, T-ANA-06 |
| GRAPH-01 | Focus/overview/references dan zoom/fit dapat dipakai, counts lengkap dibedakan dari tampilan subset | T-GRAPH-01 |
| GRAPH-02 | Query AND kategori, kategori AST nyata, reset/no result tidak mengubah canonical result | T-GRAPH-02 |
| GRAPH-03 | Relasi dua arah dan evidence benar, source snapshot sesuai hash/line, loading/unavailable/close berfungsi | T-GRAPH-03 |
| EXP-01 | File Markdown nyata memuat tiga artefak, evidence, konteks dan limitation; retry tidak mengubah hasil | T-EXP-01, T-EXP-03 |
| EXP-02 | PDF nyata dapat dibuka, diagram terbaca, tidak terpotong, context/evidence sesuai; download terotorisasi | T-EXP-02, T-EXP-03 |
| HIST-01 | Search nama/SHA, context dan tanggal benar, queued/running/failed ke progress, completed ke graph | T-HIST-01 |
| DATA-02 | Hanya owner dapat delete, active job ditolak, semua object hilang sebelum status selesai, cleanup dapat retry | T-DATA-02 |
| QA-02 | Seluruh user story inti dan error lulus dengan bukti fresh run; pengujian nyata dibedakan dari mock | T-REL-01 dan seluruh kasus inti |
| QA-03 | UI Indonesia, 360/390/768/1024/1440 px, keyboard/focus, error states dan kontras diperiksa | T-UI-01 |
| REL-01 | Semua requirement wajib terverifikasi, clean Docker run berhasil, known limitations terdokumentasi, tidak ada blocker alur inti | T-REL-01 |
| FIN-01 | Temuan regression/performa diperbaiki dan tes terdampak diulang tanpa mengurangi scope diam-diam | Kasus regresi terkait |
| FIN-02 | Panduan sesuai command yang lulus, demo dapat direplay, issue dan bukti review ditutup sesuai hasil | T-REL-01 |

## Konversi ke GitHub Issues

Judul rencana: `[ID] Ringkasan deliverable`. Salin acceptance criteria, dependencies, test case, dan requirement dari traceability. Petakan username anggota sebelum assignment; username Iltizam yang telah diverifikasi adalah `iltizamhasan3`.

Mapping issue nyata telah ditulis pada tabel paket; milestone paket `1-2` mengikuti Sprint 2 sebagai batas acceptance, dengan dasar tetap dikerjakan Sprint 1. Hindari nomor contoh yang dapat disalahartikan sebagai issue yang sudah dibuat. Paket besar boleh dipecah menjadi sub-issue, dengan parent tetap terbuka sampai seluruh acceptance terpenuhi.

Definisi fitur selesai mengikuti [Definition of Done](DEFINITION_OF_DONE.md), bukan jumlah commit atau keberhasilan tampilan dummy.
