# Product backlog

Status per 20 Oktober 2026: **44 GitHub Issues**, tiga milestone sprint, dan delapan relasi parent/sub-issue sudah dibuat. Revisi pembagian memakai bobot pekerjaan serta bukti kontribusi tiap sprint; jumlah issue tidak harus sama. Penanggung jawab paket mengikuti [alur kontribusi](../CONTRIBUTING.md); Iltizam melakukan review teknis dan merge PR.

Seluruh akun sudah dipetakan dan assignment aktif: Iltizam (`iltizamhasan3`), Rizqy (`rizqy-fadhil`), Valentina (`liliks13`), serta Zarra (`zarrrafirdaus`). Sebelas paket Zarra sudah di-assign ke akunnya. Ringkasan lintas anggota ada di [alokasi sprint](SPRINT_ALLOCATION.md).

## Prioritas, estimasi, dan fase

`P0` diperlukan untuk alur kritis/kontrak; `P1` tetap wajib pada MVP; `P2` adalah finishing sesudah feature-complete. Semua enam fitur utama tetap masuk penerimaan lokal.

Ukuran S/M/L/XL/XXL adalah estimasi relatif awal per scope, belum dikalibrasi terhadap kapasitas aktual. Ukuran tidak dikonversi menjadi jam atau dijumlahkan dengan total 20 effort pada PDF. Reestimasi sesudah spike/review harus mencatat alasan dan kapasitas sisa Sprint 1.

`1-2` berarti parent memuat dasar Sprint 1 dan acceptance lengkap Sprint 2. Dasar kini memiliki issue `*-S1` tersendiri pada milestone Sprint 1. Ukuran parent adalah **scope sisa**, tidak menghitung kembali pekerjaan anak. DOC-02 juga dipisahkan dari DOC-01: ukuran DOC-01 hanya pekerjaan integrasi/catalog yang tersisa. Relasi parent bukan tambahan dependency; dependency eksplisit tercantum pada tabel.

Penutupan fase awal tidak menutup acceptance parent atau requirement produk. Fixture/stub harus diberi label pada bukti; integrasi nyata tetap diperlukan. Perubahan alokasi tidak mengubah pelaksana commit atau bukti historis.

## Paket pekerjaan

| ID | Deliverable | Sprint | Prioritas / ukuran | Penanggung jawab | Dependensi | Parent | Status | Issue |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| PLAN-01 | Baseline planning dan workflow issue | 1 | P0 / M | Iltizam | - | - | Done (baseline dokumentasi) | [#1](https://github.com/AgilePemdigi-2026/sage/issues/1) |
| ENV-01 | Spike stack, versi, Docker, limits awal, renderer diagram | 1 | P0 / L | Iltizam | PLAN-01 | - | Done (merged PR #29) | [#2](https://github.com/AgilePemdigi-2026/sage/issues/2) |
| DATA-01 | Schema, migrasi, session/credential storage, isolasi user | 1 | P0 / L | Zarra | ENV-01 | - | Done (paket teruji; lihat issue) | [#3](https://github.com/AgilePemdigi-2026/sage/issues/3) |
| QA-01-S1 | Oracle minimum PHP/JS/TS dan review evidence Sprint 1 | 1 | P0 / M | Zarra | PLAN-01 | QA-01 | Done (paket teruji; lihat issue) | [#31](https://github.com/AgilePemdigi-2026/sage/issues/31) |
| UI-01 | Fondasi shell UI dan komponen state login/target/progress | 1 | P0 / L | Valentina | ENV-01 | - | Done (paket teruji; lihat issue) | [#30](https://github.com/AgilePemdigi-2026/sage/issues/30) |
| GH-01 | Login GitHub App, callback, session, dan error | 1 | P0 / L | Iltizam | ENV-01, DATA-01 | - | Done (paket teruji; lihat issue) | [#5](https://github.com/AgilePemdigi-2026/sage/issues/5) |
| GH-02 | Daftar instalasi/private berizin dan resolve public pihak lain | 1 | P0 / L | Rizqy | GH-01 | - | Done (paket teruji; lihat issue) | [#6](https://github.com/AgilePemdigi-2026/sage/issues/6) |
| REP-01 | UI/API target, search, branch, commit, validasi | 1 | P0 / L | Rizqy | GH-02 | - | Done (paket teruji; lihat issue) | [#7](https://github.com/AgilePemdigi-2026/sage/issues/7) |
| REP-02 | Full SHA immutable dan snapshot aman | 1 | P0 / L | Iltizam | REP-01, DATA-01 | - | Done (paket teruji; lihat issue) | [#8](https://github.com/AgilePemdigi-2026/sage/issues/8) |
| ANA-01 | Queue durable dan global analysis slot | 1 | P0 / L | Rizqy | DATA-01 | - | Done (paket teruji; lihat issue) | [#9](https://github.com/AgilePemdigi-2026/sage/issues/9) |
| ANA-02 | Deteksi bahasa, exclusion, dan batas file | 1 | P0 / M | Zarra | REP-02 | - | Done (paket teruji; lihat issue) | [#10](https://github.com/AgilePemdigi-2026/sage/issues/10) |
| ANA-05-S1 | Kontrak CCM/evidence v1 minimum dan validator dasar | 1 | P0 / M | Iltizam | ENV-01, QA-01-S1 | ANA-05 | Done (paket teruji; lihat issue) | [#32](https://github.com/AgilePemdigi-2026/sage/issues/32) |
| ANA-03-S1 | Deklarasi dan evidence dasar adapter JavaScript/TypeScript | 1 | P0 / L | Iltizam | ENV-01, QA-01-S1, ANA-05-S1 | ANA-03 | Done (paket teruji; lihat issue) | [#33](https://github.com/AgilePemdigi-2026/sage/issues/33) |
| ANA-04-S1 | Namespace, deklarasi, dan evidence dasar adapter PHP | 1 | P0 / L | Zarra | ENV-01, QA-01-S1, ANA-05-S1 | ANA-04 | Done (paket teruji; lihat issue) | [#34](https://github.com/AgilePemdigi-2026/sage/issues/34) |
| ANA-07-S1 | Runner stage berurutan, persistensi status, dan kontrak progress | 1 | P0 / L | Rizqy | DATA-01, ANA-01, ANA-05-S1 | ANA-07 | Done (paket teruji; lihat issue) | [#35](https://github.com/AgilePemdigi-2026/sage/issues/35) |
| GRAPH-01-S1 | Canvas graph dasar dari fixture bervalidasi | 1 | P1 / L | Valentina | UI-01, ANA-05-S1, QA-01-S1 | GRAPH-01 | Done (paket teruji; lihat issue) | [#36](https://github.com/AgilePemdigi-2026/sage/issues/36) |
| QA-03-S1 | Verifikasi UI dasar, state, keyboard, dan lima viewport | 1 | P1 / M | Valentina | UI-01, GRAPH-01-S1 | QA-03 | Done (paket teruji; lihat issue) | [#37](https://github.com/AgilePemdigi-2026/sage/issues/37) |
| UI-02 | Frontend Figma landing, repository, progres, history dan graph | 1 | P1 / L | Valentina | UI-01, GRAPH-01-S1, REP-01 | - | Done (frontend fixture; UI-02_CHECKS) | [#59](https://github.com/AgilePemdigi-2026/sage/issues/59) |
| UI-03 | Frontend dokumen Figma dan sinkronisasi dokumentasi | 1 | P1 / M | Zarra | UI-02, ANA-05-S1 | - | Done (frontend fixture; UI-02_CHECKS) | [#60](https://github.com/AgilePemdigi-2026/sage/issues/60) |
| DOC-03 | Rapikan README, logo stack, use flow dan operasi Docker | 1 | P1 / S | Rizqy | UI-02, UI-03 | - | Done (dokumentasi; DOC-03_CHECKS) | [#62](https://github.com/AgilePemdigi-2026/sage/issues/62) |
| GH-03-S1 | Daftar public milik akun dan isolasi pergantian sesi | 1 | P1 / M | Valentina | GH-01, GH-02, REP-01 | - | Done | [#68](https://github.com/AgilePemdigi-2026/sage/issues/68) |
| QA-04-S1 | Regression Playwright seluruh fitur tersedia | 1 | P1 / M | Valentina | UI-02, UI-03, REP-01, GH-01 | - | Done | [#66](https://github.com/AgilePemdigi-2026/sage/issues/66) |
| QA-01 | Fixture/oracle PHP, JS, TS dan benchmark awal | 1-2 | P0 / L | Zarra | PLAN-01, QA-01-S1 | - | In progress | [#4](https://github.com/AgilePemdigi-2026/sage/issues/4) |
| ANA-05 | Contracts CCM/evidence dan validator | 1-2 | P0 / M | Iltizam | ENV-01, QA-01, ANA-05-S1, ANA-03-S1, ANA-04-S1 | - | In progress (hardening; lihat ANA-05_CHECKS) | [#11](https://github.com/AgilePemdigi-2026/sage/issues/11) |
| ANA-03 | Adapter JavaScript/TypeScript dan resolver | 1-2 | P0 / XL | Iltizam | ANA-05, QA-01, ANA-03-S1 | - | Done (resolver statis sesuai capability; lihat RESOLVER_CHECKS) | [#12](https://github.com/AgilePemdigi-2026/sage/issues/12) |
| ANA-04 | Adapter PHP dan resolver | 1-2 | P0 / XL | Zarra | ANA-05, QA-01, ANA-04-S1 | - | Done (resolver statis sesuai capability; lihat RESOLVER_CHECKS) | [#13](https://github.com/AgilePemdigi-2026/sage/issues/13) |
| ANA-06 | Canonical CKG, provenance, dan persistensi | 2 | P0 / L | Iltizam | ANA-03, ANA-04, ANA-05 | - | Implemented; acceptance parent pending (ANA-06_CHECKS) | [#14](https://github.com/AgilePemdigi-2026/sage/issues/14) |
| DOC-02 | Proyeksi UML/struktur dan rendering diagram dari CKG | 2 | P0 / L | Valentina | ANA-06 | DOC-01 | Planned | [#38](https://github.com/AgilePemdigi-2026/sage/issues/38) |
| DOC-01 | Interface Catalog, model ADD, dan integrasi tiga artefak | 2 | P0 / L | Zarra | ANA-06, DOC-02 | - | Planned | [#15](https://github.com/AgilePemdigi-2026/sage/issues/15) |
| ANA-07 | Pipeline sembilan tahap, progress, failure/retry, atomic result | 1-2 | P0 / XL | Rizqy | ANA-01, ANA-02, ANA-06, DOC-01, ANA-07-S1 | - | Planned | [#16](https://github.com/AgilePemdigi-2026/sage/issues/16) |
| GRAPH-01 | Graph canvas, mode, legend, zoom, dan counts | 1-2 | P1 / L | Valentina | ANA-06, UI-01, GRAPH-01-S1 | - | Planned | [#17](https://github.com/AgilePemdigi-2026/sage/issues/17) |
| GRAPH-02 | Node Query dan filter kategori gabungan | 2 | P1 / M | Valentina | GRAPH-01 | - | Planned | [#18](https://github.com/AgilePemdigi-2026/sage/issues/18) |
| GRAPH-03 | Inspector, incoming/outgoing, evidence, source preview | 2 | P0 / L | Valentina | GRAPH-01, REP-02 | - | Planned | [#19](https://github.com/AgilePemdigi-2026/sage/issues/19) |
| EXP-01 | Markdown mandiri beserta failure/retry | 2 | P0 / L | Zarra | DOC-01 | - | Planned | [#20](https://github.com/AgilePemdigi-2026/sage/issues/20) |
| EXP-02 | PDF, print layout, diagram, dan download | 2 | P0 / L | Valentina | DOC-01, ENV-01 | - | Planned | [#21](https://github.com/AgilePemdigi-2026/sage/issues/21) |
| HIST-01 | History per user, search, empty/error, navigasi | 2 | P1 / M | Rizqy | DATA-01, ANA-01 | - | Planned | [#22](https://github.com/AgilePemdigi-2026/sage/issues/22) |
| DATA-02 | Penghapusan analysis dan cleanup storage/export | 2 | P1 / M | Zarra | DATA-01, EXP-01, EXP-02 | - | Planned | [#23](https://github.com/AgilePemdigi-2026/sage/issues/23) |
| QA-02 | Integrasi penuh, GitHub nyata, error, dan release evidence | 2 | P0 / XL | Rizqy | GH-01, REP-02, ANA-07, GRAPH-03, EXP-01, EXP-02, HIST-01, DATA-02 | - | Planned | [#24](https://github.com/AgilePemdigi-2026/sage/issues/24) |
| QA-03 | Responsivitas, keyboard, bahasa UI, dan visual QA | 1-2 | P1 / L | Valentina | GRAPH-03, EXP-02, REP-01, HIST-01, QA-03-S1 | - | Planned | [#25](https://github.com/AgilePemdigi-2026/sage/issues/25) |
| REL-01 | MVP freeze lokal dan panduan setup/demo teruji | 2 | P0 / M | Iltizam | QA-02, QA-03 | - | Planned | [#26](https://github.com/AgilePemdigi-2026/sage/issues/26) |
| FIN-01 | Regression analyzer/worker, evidence, dan performa | 3 | P2 / L | Iltizam | REL-01 | - | Planned | [#27](https://github.com/AgilePemdigi-2026/sage/issues/27) |
| FIN-03 | Regression akses repository, pipeline, history, dan integrasi | 3 | P2 / L | Rizqy | REL-01 | - | Planned | [#39](https://github.com/AgilePemdigi-2026/sage/issues/39) |
| FIN-04 | Regression graph/UI, aksesibilitas, dan keterbacaan PDF | 3 | P2 / L | Valentina | REL-01 | - | Planned | [#40](https://github.com/AgilePemdigi-2026/sage/issues/40) |
| FIN-02 | Verifikasi dokumen, panduan pengguna, dan demo akhir | 3 | P2 / L | Zarra | FIN-01, FIN-03, FIN-04 | - | Planned | [#28](https://github.com/AgilePemdigi-2026/sage/issues/28) |

## Scope sisa dan penerimaan parent

| Parent | Fase terpisah | Scope estimasi parent saat ini |
| --- | --- | --- |
| QA-01 | QA-01-S1 | Sprint 2: oracle capability tambahan, fixture berbahaya, dan benchmark representatif; oracle minimum diterima pada QA-01-S1. |
| ANA-05 | ANA-05-S1 | Sprint 2: hardening schema/validator, taxonomy dan kompatibilitas hasil dua adapter; kontrak minimum diterima pada ANA-05-S1. |
| ANA-03 | ANA-03-S1 | Sprint 2: resolver imports/calls/types/member lintas file, dynamic/unresolved, capability matrix dan replay; deklarasi dasar pada ANA-03-S1. |
| ANA-04 | ANA-04-S1 | Sprint 2: resolver namespace/use/member/inheritance/Composer statis, dynamic/unresolved dan replay; deklarasi dasar pada ANA-04-S1. |
| ANA-07 | ANA-07-S1 | Sprint 2: sambungkan sembilan tahap nyata, atomic bundle, izin retry, recovery dan polling terminal; runner dasar pada ANA-07-S1. |
| GRAPH-01 | GRAPH-01-S1 | Sprint 2: integrasi CKG nyata, focus/overview/references dan counts canonical; canvas fixture dasar pada GRAPH-01-S1. |
| QA-03 | QA-03-S1 | Sprint 2: verifikasi semua screen dan state produk pada data analisis nyata; baseline UI pada QA-03-S1. |
| DOC-01 | DOC-02 | Interface Catalog, model ADD, context/provenance dan publish bundle atomik. UML/diagram struktur dipasok DOC-02; kriteria tiga artefak lengkap tetap wajib. |
| FIN-01 | - | Regression analyzer JS/TS/PHP, validator/CCM/CKG/evidence, resource/performa worker; regression integrasi dan visual ditangani FIN-03/04. |

QA-01-S1 menyediakan oracle minimum lebih dahulu; QA-01 melengkapi capability/benchmark pada Sprint 2. ANA-05-S1 menjadi kontrak awal agar dua adapter dan canvas dapat dikembangkan paralel. Hardening ANA-05 memakai keluaran dua adapter dasar sebelum resolver lengkap diterima.

## Acceptance criteria per paket

Kriteria berikut tetap wajib bersama scope fase/sisa di atas. Setiap hasil mencatat commit/PR, pelaksana dan pemeriksa aktual, langkah uji, expected vs actual, serta keterbatasan.

| ID | Kriteria penerimaan yang harus dibuktikan | Test case |
| --- | --- | --- |
| PLAN-01 | Tautan lokal valid, 72 requirement unik terpetakan, kalender/enum konsisten, status planning jelas, dan commit baseline tersimpan | Pemeriksaan dokumentasi |
| ENV-01 | Setup bersih Docker, versi/lockfile dipin, Node/PHP/Chromium kompatibel, health/migration siap, batas awal dicatat, renderer diagram terbukti | T-REL-01, T-SEC-01 |
| DATA-01 | Migrasi bersih, sesi/credential aman, record user terisolasi, hasil bertahan setelah restart | T-DATA-01 |
| QA-01-S1 | Fixture minimum tiap bahasa mempunyai source SHA-256, expected declaration/reference dan limitation; Unicode/CRLF serta dynamic/unresolved termasuk; pemeriksa aktual dan hasil review dicatat; verifier hash/snippet/bounds lulus; output parser bukan satu-satunya sumber expected output | T-ANA-03/T-ANA-04 (oracle minimum; semantic adapter acceptance tetap menunggu implementasi) |
| UI-01 | Komponen berbahasa Indonesia memuat state loading/empty/error/retry yang dapat diperiksa dari data fixture berlabel; keyboard/focus dan validasi form tersedia; layar 360/390/768/1024/1440 px diperiksa; tidak ada tombol login atau hasil analisis dummy yang diklaim sebagai integrasi GitHub nyata | T-UI-01 (komponen dasar, bukan acceptance UI produk penuh) |
| UI-02 | Layout Figma, akses repository tetap nyata, preview berlabel, query/filter/inspector/source dan lima viewport teruji tanpa mengklaim integrasi pipeline | T-UI-02 (frontend fixture) |
| UI-03 | Catalog/struktur/UML berbasis fixture tervalidasi, konteks/evidence konsisten, ekspor yang belum tersedia dijelaskan, README dan dokumen status diselaraskan | T-UI-02 (dokumen fixture) |
| DOC-03 | README tanpa emoji dekoratif, pembuka terpusat dengan logo lokal, use flow membedakan status aktual/target, operasi stop/start jelas, render/diagram/tautan diperiksa | Pemeriksaan dokumentasi DOC-03 |
| QA-04-S1 | Tujuh suite browser lima viewport, auth/session, public/pagination, provider terpisah, laporan per run; fixture dan fitur belum tersedia dibedakan | Pemeriksaan QA-04-S1 |
| GH-01 | Login/logout nyata, state replay ditolak, denial/failure dapat dipulihkan, secret tidak terekspos | T-GH-01, T-GH-02 |
| GH-03-S1 | Public milik akun tampil tanpa instalasi; owner dari sesi; pergantian akun menghapus state; header akun lama ditolak; provider 401 tidak membuat loop reload; dua sesi dan lima viewport teruji | Pemeriksaan GH-03-S1 |
| GH-02 | Public pihak lain dan private berizin berhasil, private tanpa izin ditolak, rate limit/unavailable punya pesan aman | T-GH-03 |
| REP-01 | List/search/empty/error, branch aktual, commit opsional, input invalid ditolak sebelum job | T-REP-01, T-REP-02 |
| REP-02 | SHA tersimpan sebelum antrean, HEAD berubah tidak mengubah snapshot, archive/hash/path/limits valid | T-REP-02, T-SEC-01 |
| ANA-01 | Dua submission tidak menghasilkan dua job RUNNING, antrean/restart aman, lock global diuji dengan dua worker | T-ANA-01 |
| ANA-02 | Bahasa/exclusion dilaporkan, source didukung tetap dianalisis, tidak ada source didukung menghasilkan failure yang jelas | T-ANA-05 |
| ANA-05-S1 | Tipe/schema minimum dan contoh payload valid tersedia; ID duplikat, dangling edge, dan bounds invalid ditolak; posisi Unicode/CRLF dan source hash diuji; aturan determinisme dan error validator didokumentasikan | T-ANA-04 (kontrak minimum) |
| ANA-03-S1 | Module/class/function/method/property yang didukung menghasilkan deklarasi dan bounds nyata; output minimum lolos validator serta cocok oracle minimum; syntax invalid dan konstruk dinamis dicatat dengan limitation; source/config target tidak dieksekusi | T-ANA-03/T-ANA-04 (deklarasi minimum) |
| ANA-04-S1 | Namespace/use/class/interface/function/method dasar mempunyai nama dan bounds nyata; output cocok oracle minimum dan lolos validator; parse failure/unsupported dicatat; Composer scripts, include target, serta source repository tidak dijalankan | T-ANA-03/T-ANA-04 (PHP minimum) |
| ANA-07-S1 | Sembilan key tahap sesuai kontrak dijalankan berurutan dan status dipersistenkan; tahap gagal menghentikan runner dan downstream tetap pending; progress/error dapat dibaca konsisten; bukti test yang memakai stub diberi label dan tidak dinyatakan sebagai analisis repository selesai | T-ANA-02 (runner terkontrol; integrasi nyata NOT_RUN) |
| GRAPH-01-S1 | Canvas menerima fixture bervalidasi dan membedakan kategori serta Exact/Unresolved dengan label/garis; zoom/fit dan selection keyboard atau alternatif daftar berfungsi; fixture diberi penanda eksplisit; tampilan tidak menambah atau mengubah fakta source | T-GRAPH-01/T-UI-01 (fixture canvas dasar) |
| QA-03-S1 | Matriks state dan lima viewport tersedia dengan expected vs actual; label/focus/keyboard dan kontras diperiksa; temuan nyata diperbaiki atau ditautkan; bukti menyebut fixture/stub dan keterbatasan integrasi secara jelas | T-UI-01 (baseline; acceptance UI produk lengkap tetap QA-03) |
| QA-01 | Source fixture kecil tiap bahasa, oracle yang direview, dynamic/unresolved dan Unicode termasuk, ukuran/waktu/RAM dicatat | T-ANA-03, T-ANA-04, T-ANA-05 |
| ANA-05 | Schema validator menolak ID/edge/bounds invalid; konversi Unicode/CRLF dan hash benar | T-ANA-04 |
| ANA-03 | Capability matrix JS/TS beserta calls/types/imports sesuai oracle, dynamic tetap unresolved, tanpa eksekusi target | T-ANA-03, T-ANA-04 |
| ANA-04 | Capability matrix PHP beserta namespace/member/inheritance sesuai oracle, dynamic tetap unresolved | T-ANA-03, T-ANA-04 |
| ANA-06 | CKG deterministik, counts containment/reference benar, evidence/provenance lengkap, proyeksi tidak mengubah data | T-ANA-04, T-GRAPH-01 |
| DOC-02 | Dua proyeksi membaca canonical CKG yang sama dan mempertahankan nodeIds/edgeIds/evidence; Exact/Unresolved terlihat tanpa fakta/cardinality buatan; source diagram mandiri tersedia untuk Markdown; label berbahaya di-escape dan render tidak mengambil URL bebas; SVG/diagram dapat dicetak dan kegagalan renderer tidak dipublikasikan sebagai sukses | T-DOC-01, T-EXP-02, T-SEC-01 (bagian proyeksi/render) |
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
| FIN-03 | Matriks public/private/error/retry/recovery/history dijalankan pada commit dan SHA uji yang dicatat; hasil pass/fail serta bukti tersedia; temuan diperbaiki dan retest dilakukan atau blocker tercatat; tidak membuat bug fiktif untuk memenuhi jumlah issue | T-GH-01/02/03, T-REP-01/02, T-ANA-01/02/06, T-HIST-01, T-REL-01 |
| FIN-04 | Semua viewport dan state inti diperiksa dengan data analisis nyata; graph/filter/inspector/source serta fokus keyboard direplay; seluruh halaman sampel PDF diperiksa visual untuk clipping/font/diagram; temuan nyata diperbaiki dan retest dicatat atau hasil bersih dibuktikan | T-GRAPH-01/02/03, T-UI-01, T-EXP-02/03 |
| FIN-02 | Panduan sesuai command yang lulus, demo dapat direplay, issue dan bukti review ditutup sesuai hasil | T-REL-01 |

## GitHub Issues dan penilaian

Judul memakai `[ID] Ringkasan deliverable`. Seluruh nomor di tabel adalah issue nyata. Milestone parent `1-2` tetap Sprint 2; issue fase awal memakai Sprint 1. Parent tetap terbuka sampai semua anak dan acceptance penuh lulus, termasuk integrasi. Bukti anak boleh dirujuk kembali oleh parent, tetapi bobot/hasil pekerjaan yang sama tidak dihitung dua kali.

Tinjau bobot, dependensi, waktu review, serta bukti perubahan/tes/review yang substantif per anggota pada setiap sprint. Jumlah issue/commit merupakan penunjuk keterlacakan, bukan ukuran effort yang setara. Rencana ini belum membuktikan actual effort atau menjamin kapasitas; penyesuaian dicatat pada issue dan decision log.

Definisi selesai mengikuti [Definition of Done](DEFINITION_OF_DONE.md). Seluruh 17 paket awal Sprint 1 sudah ditutup sesuai bukti pada issue. UI-02/UI-03 menambahkan pekerjaan frontend pada 20 Oktober; keduanya terverifikasi sebagai fase frontend fixture, terpisah dari acceptance fitur penuh Sprint 2. QA-01 tetap In progress untuk oracle tambahan; acceptance produk mengikuti [test plan](TEST_PLAN.md).
