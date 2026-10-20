# Test plan

Status 20 Oktober 2026: GH-01/02 memuat bukti login dan akses GitHub nyata; REP-01/02 memuat validasi repository/branch/full SHA, submission idempotent, dan snapshot immutable; ANA-01/02 mencatat queue/source policy; runner stage terbatas diuji pada ANA-07-S1. Consumer sembilan tahap masih nonaktif (`workerQueueEnabled=false`), dan acceptance end-to-end tetap terbuka. Frontend Figma UI-02 #59 serta UI-03 #60 telah diuji pada lima viewport menggunakan fixture; hasil dan batas keyboard/visual ada di [UI-02/UI-03 checks](UI-02_CHECKS.md). Bukti per slice ada pada dokumen [GH-01](GH-01_CHECKS.md), [GH-02](GH-02_CHECKS.md), [REP-01](REP-01_CHECKS.md), [REP-02](REP-02_CHECKS.md), [ANA-01](ANA-01_CHECKS.md), dan [ANA-02](ANA-02_CHECKS.md). Probe fondasi ENV-01 dan integritas seed QA-01 dicatat terpisah di [pemeriksaan environment](ENVIRONMENT_CHECKS.md); probe tidak menutup acceptance produk.

## Strategi

Gunakan tiga lapis: unit/contract untuk parser, CCM dan proyeksi; integrasi untuk database/worker/GitHub boundary; E2E untuk user story dan ekspor. Mock hanya membuktikan perilaku pada boundary yang digantikan; release gate tetap memerlukan integrasi GitHub nyata dan file keluaran nyata.

Playwright digunakan untuk browser E2E dan export PDF. Fondasi memakai Node.js test runner melalui tsx untuk unit/integrity tests. Test harus menilai perilaku/hasil yang penting, bukan mengulang implementasi atau hanya memeriksa keberadaan komponen.

## Fixture dan oracle

Oracle awal untuk PHP, JavaScript, dan TypeScript sudah memiliki bukti tersendiri, tetapi QA-01 masih terbuka untuk kelengkapan oracle semantik dan review tim. Fixture source-backed pada pratinjau UI bukan pengganti oracle analisis repository.

Untuk tiap fixture simpan source, full SHA atau manifest hash lokal, config, expected declaration/edge/evidence/limitations, dan nama pemeriksa. Oracle disusun dari source yang dibaca/direview; jangan menjadikan output analyzer yang diuji sebagai satu-satunya expected output.

| Fixture rencana | Isi minimum |
| --- | --- |
| `js-static` | ESM/CommonJS statis, function/class, calls, member, external/dynamic reference |
| `ts-contracts` | Interface, tipe, extends/implements, imports lintas file, alias, callback, receiver unresolved |
| `php-namespaces` | Namespace/use, class/interface, member, extends/implements, calls, pemetaan Composer statis |
| `mixed-languages` | PHP/JS/TS didukung dan satu file bahasa lain yang harus dikecualikan |
| `source-bounds` | Unicode, LF/CRLF, file sama nama di path berbeda, evidence utama dan konteks |
| `failure-cases` | Syntax invalid, tidak ada source didukung, limit terlampaui, duplicate submission, worker terhenti |
| `unsafe-inputs` | URL non-GitHub, traversal, symlink, archive berlebihan, konfigurasi/plugin executable |

Fixture JSX/TSX, type alias, enum, PHP trait, dan semantik framework ditambahkan saat capability spike. Contoh Figma lama berisi 37 node/88 edge bukan oracle. Pratinjau Sprint 1 memakai satu fixture CCM source-backed yang divalidasi dengan 10 node/9 edge; fixture itu hanya untuk demonstrasi UI dan tidak membuktikan hasil analyzer dari repository.

## Penerimaan fase dan regression

Paket QA-01-S1, ANA-05-S1, ANA-03-S1, ANA-04-S1, ANA-07-S1, GRAPH-01-S1, QA-03-S1, dan UI-01 memiliki scope awal yang diuji terpisah. Rekam kasus uji yang dipakai serta batasnya: runner stage terbatas tidak membuktikan consumer sembilan tahap aktif; canvas/halaman fixture tidak membuktikan CKG dari repository. QA-03-S1 memeriksa shell awal dan tidak menggantikan verifikasi layar Figma baru pada #59/#60. Parent tetap memerlukan kasus penerimaan lengkap. DOC-02 menguji proyeksi diagram dari CKG dan keamanan rendering, lalu DOC-01/EXP-01/EXP-02 memverifikasi konsistensi dokumen serta file nyata.

Hardening ANA-05 memperluas T-ANA-04 melalui `tests/contracts.test.ts`: array/source map non-serializable, UTF-8 processed tanpa evidence, parent bounds/siklus dalam, serta containment yang tidak konsisten. `tests/source-analysis.test.ts` menguji output adapter PHP/JS/TS setelah round-trip JSON, byte BOM/CRLF/Unicode, file gagal/excluded, dan penolakan manipulasi hash/ID/bounds pada batas konsumsi. Pengujian ini tidak menggantikan oracle resolver lengkap, benchmark QA-01, persistensi CKG, atau replay pipeline produk.

Sesudah freeze, FIN-01 (Iltizam) mengulang analyzer/worker/CCM/CKG/evidence dan benchmark; FIN-03 (Rizqy) mengulang GitHub/repository/queue/pipeline/history/integrasi; FIN-04 (Valentina) mengulang graph/UI/keyboard/lima viewport dan render visual seluruh halaman PDF. FIN-02 (Zarra) memverifikasi dokumen, panduan, serta replay demo setelah hasil regression tersedia. Catat hasil bersih jika tidak ada temuan; issue bug hanya untuk kegagalan yang benar-benar ditemukan.

Rincian scope dan bukti mengikuti [alokasi sprint](SPRINT_ALLOCATION.md). Penggunaan bukti fase pada parent tidak dihitung sebagai kontribusi baru tanpa aktivitas verifikasi baru yang dicatat.

## Kasus penerimaan

ID di bawah adalah kontrak acceptance alur produk lengkap. Check per issue dapat membuktikan sebagian perilaku tanpa menutup baris ini; tandai acceptance lengkap setelah semua kondisi pada skenario terpenuhi dan buktinya dicatat.

| ID | Langkah/skenario | Expected result |
| --- | --- | --- |
| T-GH-01 | Login GitHub nyata, buka session/repositories, logout | Session valid dan milik user; token tidak ada di browser; logout mencabut session |
| T-GH-02 | Tolak izin, gagalkan callback, ulang state, coba lagi | Pesan Indonesia tepat, state replay ditolak, tidak membentuk koneksi palsu, retry tersedia |
| T-GH-03 | Public pihak lain, private berizin/tanpa izin, token dicabut, rate limit | Public/private sesuai hak dapat dibaca; akses lain ditolak; error aman dan dapat dipulihkan |
| T-REP-01 | List/search, empty/no match, branch loading/error/retry | Data tidak terhapus oleh filter; branch berasal dari GitHub; state dan reset sesuai |
| T-REP-02 | Commit kosong/eksplisit/invalid; HEAD berubah saat queued | Full SHA dibekukan saat submission; invalid ditolak; snapshot tetap sesuai target tersimpan |
| T-ANA-01 | Dua request bersamaan, dua worker, restart dengan antrean | Maksimal satu analysis RUNNING global; antrean diproses tanpa duplikasi atau kehilangan target |
| T-ANA-02 | Jalankan sembilan stage; paksa satu stage/generator gagal | Urutan tepat, progress aktual, next stage pending saat gagal, hasil hanya tersedia setelah bundle lengkap |
| T-ANA-03 | Jalankan adapter pada fixture PHP, JavaScript, TypeScript | Deklarasi, relasi, kind, resolusi, dan limitation cocok oracle per kemampuan |
| T-ANA-04 | Replay snapshot/config sama; cek Unicode/CRLF/bounds/ID | Canonical graph/hash stabil; tidak ada dangling edge; source snippet menunjuk lokasi sebenarnya |
| T-ANA-05 | Mixed language, file parse gagal, tidak ada source didukung | Partial yang sah menjadi completed with limitations; tidak ada source berhasil menjadi failed |
| T-ANA-06 | Matikan worker aktif lalu retry | Percobaan lama failed/interrupted; percobaan baru memakai SHA/config yang sama dan izin diperiksa ulang |
| T-GRAPH-01 | Buka context, focus/overview/all references, zoom/fit | Graph sesuai analisis; canonical dan subset counts jelas; unresolved tetap terbedakan |
| T-GRAPH-02 | Cari node, combine kategori, no result, reset | Query AND kategori; edge sesuai endpoint/konteks; canonical result tidak berubah |
| T-GRAPH-03 | Pilih node, incoming/outgoing, buka/tutup source preview, unavailable | Location/bounds/evidence benar dan dari snapshot; loading/error/focus kembali sesuai |
| T-DOC-01 | Bandingkan tiga artefak dengan CKG/source | Contract/signature/dependency terbukti; unresolved dan provenance terpelihara; tidak ada fakta tambahan |
| T-EXP-01 | Ekspor dan buka Markdown pada viewer bersih | Tiga artefak, diagram source, evidence, context, limitation lengkap; tidak bergantung path lokal |
| T-EXP-02 | Ekspor dan buka PDF, ekstrak teks, render seluruh halaman | File valid, teks sesuai, diagram terbaca, tidak terpotong, font dan evidence sesuai |
| T-EXP-03 | Gagalkan ekspor, double submit, retry, download bukan pemilik | State benar, deduplikasi bekerja, graph tidak berubah, retry berhasil pada document hash sama, akses ditolak |
| T-HIST-01 | Empty history, list berbagai status, query nama/SHA, buka record | Hanya milik user; query/reset benar; terminal sukses ke graph, queued/running/failed ke progress |
| T-DATA-01 | Migrasi bersih, restart Docker, dua user mengakses ID yang sama | Persistensi utuh, credential/session aman, user lain ditolak pada graph/source/doc/export/job |
| T-DATA-02 | Delete terminal/active/export aktif; simulasikan cleanup gagal | Active ditolak; akses hilang saat cleanup; file dan record turunan hilang sebelum selesai; cleanup idempotent |
| T-UI-01 | Periksa viewport 360/390/768/1024/1440, keyboard, status/error | UI Indonesia, context terbaca, canvas/source terkontrol, fokus/label/warna diperiksa |
| T-SEC-01 | Unsafe inputs, config executable, source berisi HTML/script, secret scan | Tidak ada eksekusi source, SSRF/traversal, injeksi render, akses lintas user, atau secret di artefak |
| T-REL-01 | Fresh Docker setup -> login -> target -> analysis -> graph -> ADD -> MD/PDF -> history/delete | Semua alur nyata dan error wajib lulus; panduan dapat direplay; limitation dan versi tercatat |

## Skenario GitHub nyata

GH-01 memerlukan konfigurasi GitHub App lokal yang dimiliki project. Uji minimal satu akun yang diotorisasi, satu public repository pihak lain, satu private repository yang diizinkan, dan percobaan akses private tanpa izin. Rahasia, OTP, token, serta private key tidak disimpan sebagai fixture atau bukti publik.

Testing dengan fake callback atau mock GitHub API tetap berguna untuk determinisme error, tetapi harus diberi label mocked dan tidak menggantikan bukti login/izin nyata. Bila repository private uji belum disediakan, status pengujian tersebut tetap blocked/not run dan release gate belum lulus.

## Verifikasi export

Bandingkan Markdown/PDF dengan document model yang sama, bukan hanya pesan berhasil. Periksa signature, daftar class/interface, relasi unresolved, evidence, SHA, dan limitation. Hash graph/document sebelum dan sesudah export harus tetap sama.

PDF diperiksa dengan parser serta render visual semua halaman untuk clipping/font/diagram. Markdown harus memuat isi mandiri dan source diagram yang valid; diagram Markdown dapat memerlukan viewer yang mendukung formatnya, tetapi source relasi tetap tersedia dalam teks.

## Benchmark dan batas

Rekam mesin, OS/Docker, CPU/RAM, versi package/image, ukuran repository, jumlah file/node/edge, durasi per stage, peak memory, respons query, dan ukuran export. Dari pengukuran tersebut tetapkan batas repository, timeout, pagination, interval polling, dan budget layout graph.

Tidak ada angka performa hasil eksekusi atau hardware minimum yang telah ditetapkan pada baseline. Batas wajib ada sebelum pemrosesan repository arbitrer; nilai awal dapat konservatif dan harus terlihat pada UI ketika dilampaui.

## Format bukti

Setiap hasil run mencatat tanggal, commit aplikasi, full SHA/hash fixture, schema/config/parser versions, lingkungan, test IDs, command/langkah nyata, expected vs actual, status pass/fail, serta lokasi artefak yang aman. Bedakan run baru, hasil tersimpan, mock, dan review dokumen.

Hasil pengujian yang mengandung source private tidak diunggah ke repository publik. Issue dapat menyimpan ringkasan yang disamarkan dan identitas run, dengan bukti sensitif disimpan pada lokasi yang disetujui pemilik.

## Frontend Figma Sprint 1

T-UI-02 memeriksa enam layar pada 360/390/768/1024/1440 px, aset SVG lokal, pencarian dan state history, query AND kategori serta fokus graph, evidence/source dan pengembalian fokus, tab dokumen dengan keyboard, byte unduhan Markdown contoh, PDF disabled, state retry/unavailable, dan penolakan konteks analysis yang tidak cocok. Replay: `npm run test:figma:ui`. Target repository nyata diperiksa terpisah melalui `npm run test:target:ui` dengan sesi valid milik identitas fixture sementara (`SAGE_TEST_FIXTURE_USER=1`) dan respons provider terkontrol. Hasil dan batasnya: [UI-02/UI-03 checks](UI-02_CHECKS.md).

## Regression Playwright lintas fitur (QA-04-S1)

`npm run test:browser` menjalankan delapan suite secara berurutan: landing/health, auth/workspace, repository target, isolasi akun, preview Figma, komponen UI awal, graph awal dan baseline keyboard/kontras DOM. Runner memberi setiap run folder terpisah, tanggal, hash script/lockfile, base commit, hasil suite dan lokasi screenshot. `npm run test:provider:playwright` memeriksa API Next serta GitHub nyata secara terpisah memakai otorisasi existing dan sesi sementara. Origin browser auth tetap tepercaya walaupun transport pengujian melewati jaringan Compose.

Rincian hasil terbaru, matriks fitur, batas OAuth/fixture/pipeline dan perintah Docker: [QA-04-S1 checks](QA-04-S1_CHECKS.md). Paket QA-04-S1 tidak menutup QA-03/QA-02 atau T-REL-01 penuh.

## GH-03-S1 — Daftar public dan pergantian akun

`npm run test:accounts:ui` menggunakan dua identitas disposable untuk memeriksa sesi/identity endpoint nyata, penolakan header akun lama sebelum provider, dan tab terbuka yang cookie-nya berubah. Metadata repository/branch pada browser dikontrol dan diberi label; unit provider memeriksa pemilik/public filtering serta pagination. Target UI memeriksa daftar public tanpa instalasi, muat berikutnya, retry dan pemilihan branch. [Bukti dan batas](GH-03-S1_CHECKS.md).
