# Test plan

Status 22 Oktober 2026: GH-01/02 memuat bukti login dan akses GitHub nyata; REP-01/02 memuat validasi repository/branch/full SHA, submission idempotent, dan snapshot immutable; ANA-01/02 mencatat queue/source policy; runner stage terbatas diuji pada ANA-07-S1. ANA-07 menyambungkan consumer sembilan tahap, publikasi terminal, serta retry; bukti aktual dan batas penggantian provider uji dicatat di [ANA-07_CHECKS](ANA-07_CHECKS.md). Frontend Figma UI-02 #59 serta UI-03 #60 telah diuji pada lima viewport menggunakan fixture; hasil dan batas keyboard/visual ada di [UI-02/UI-03 checks](UI-02_CHECKS.md). Bukti per slice ada pada dokumen [GH-01](GH-01_CHECKS.md), [GH-02](GH-02_CHECKS.md), [REP-01](REP-01_CHECKS.md), [REP-02](REP-02_CHECKS.md), [ANA-01](ANA-01_CHECKS.md), dan [ANA-02](ANA-02_CHECKS.md). Probe fondasi ENV-01 dan integritas seed QA-01 dicatat terpisah di [pemeriksaan environment](ENVIRONMENT_CHECKS.md); probe tidak menutup acceptance produk.

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

Hardening ANA-05 memperluas T-ANA-04 melalui `tests/contracts.test.ts`: array/source map non-serializable, UTF-8 processed tanpa evidence, parent bounds/siklus dalam, serta containment yang tidak konsisten. `tests/source-analysis.test.ts` menguji output adapter PHP/JS/TS setelah round-trip JSON, byte BOM/CRLF/Unicode, file gagal/excluded, dan penolakan manipulasi hash/ID/bounds pada batas konsumsi. Integrasi ANA-03/ANA-04 menambah `tests/resolver-integration.test.ts` dengan 21 fakta oracle independen dan tes worker untuk relasi campuran, config fingerprint serta snapshot mutation; seluruh 202 tes utama dan 8 tes data lulus. Bukti serta microbenchmark dicatat pada [RESOLVER_CHECKS](RESOLVER_CHECKS.md). Pengujian ini tidak menggantikan cakupan oracle lengkap, benchmark repository representatif QA-01, persistensi CKG, atau replay pipeline produk.

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
| T-GRAPH-02 | Cari node, combine kategori, no result, reset | Query AND kategori; edge sesuai endpoint; canonical result tidak berubah; 5 unit filter dan 18 kelompok regresi browser PASS, interaksi filter 390 px (GRAPH-02_CHECKS) |
| T-GRAPH-03 | Pilih node, incoming/outgoing, buka/tutup source preview, unavailable | Lulus: canonical bounds/relasi/source hash, retry, Escape/focus, akun berubah dan respons terlambat; 25 kelompok browser/API dengan fixture TypeScript, lihat GRAPH-03_CHECKS |
| T-DOC-01 | Bandingkan tiga artefak dengan CKG/source | Contract/signature/dependency terbukti; unresolved dan provenance terpelihara; tidak ada fakta tambahan |
| T-EXP-01 | Ekspor dan buka Markdown pada viewer bersih | Markdown mandiri: tiga artefak, diagram source, evidence/context/limitation; unduhan nyata dan viewer offline, lihat EXP-01_CHECKS |
| T-EXP-02 | Ekspor dan buka PDF, ekstrak teks, render seluruh halaman | File valid, teks sesuai, diagram terbaca, tidak terpotong, font dan evidence sesuai; teruji ([EXP-02_CHECKS](EXP-02_CHECKS.md)) |
| T-EXP-03 | Gagalkan ekspor, double submit, retry, download bukan pemilik | Markdown: dedup, hash graph/ADD/analysis tetap, retry dokumen sama dan akses privat; PDF teruji ([EXP-02_CHECKS](EXP-02_CHECKS.md)) |
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

T-UI-02 memeriksa enam layar pada 360/390/768/1024/1440 px, aset SVG lokal, pencarian dan state history, query AND kategori serta fokus graph, evidence/source dan pengembalian fokus, tab dokumen dengan keyboard, byte unduhan Markdown contoh, PDF disabled, state retry/unavailable, dan penolakan konteks analysis yang tidak cocok. Catatan ini historis: route fixture dihapus pada UI-05; `npm run test:figma:ui` kini menjadi alias smoke landing/login dan route 404. Target repository nyata diperiksa terpisah melalui `npm run test:target:ui` dengan sesi valid milik identitas fixture sementara (`SAGE_TEST_FIXTURE_USER=1`) dan respons provider terkontrol. Hasil dan batasnya: [UI-02/UI-03 checks](UI-02_CHECKS.md).

## Regression Playwright lintas fitur (QA-04-S1)

`npm run test:browser` menjalankan empat suite secara berurutan: landing/health, auth/workspace, repository target, isolasi akun dan route pratinjau yang dihapus (404). Graph/dokumen nyata diuji melalui suite live. Runner memberi setiap run folder terpisah, tanggal, hash script/lockfile, base commit, hasil suite dan lokasi screenshot. `npm run test:provider:playwright` memeriksa API Next serta GitHub nyata secara terpisah memakai otorisasi existing dan sesi sementara. Origin browser auth tetap tepercaya walaupun transport pengujian melewati jaringan Compose.

Rincian hasil terbaru, matriks fitur, batas OAuth/fixture/pipeline dan perintah Docker: [QA-04-S1 checks](QA-04-S1_CHECKS.md). Paket QA-04-S1 tidak menutup QA-03/QA-02 atau T-REL-01 penuh.

## GH-03-S1 — Daftar public dan pergantian akun

`npm run test:accounts:ui` menggunakan dua identitas disposable untuk memeriksa sesi/identity endpoint nyata, penolakan header akun lama sebelum provider, dan tab terbuka yang cookie-nya berubah. Metadata repository/branch pada browser dikontrol dan diberi label; unit provider memeriksa pemilik/public filtering serta pagination. Target UI memeriksa daftar public tanpa instalasi, muat berikutnya, retry dan pemilihan branch. [Bukti dan batas](GH-03-S1_CHECKS.md).

## Replay canonical dan persistensi ANA-06

T-ANA-04/T-GRAPH-01 diperluas oleh `tests/ckg.test.ts`, `tests/ckg-handlers.test.ts`, dan `tests/ckg-persistence.test.ts` untuk determinisme/counts, batas hash/target/evidence serta integritas read/replay. `npm run test:ckg:integration` hanya dijalankan dengan opt-in dan database disposable `sage_ckg14`: source handlers nyata, snapshot owner-bound, graph canonical, lease/owner/stage fencing dan rollback saat lease habis dalam INSERT. Stage dokumen masih placeholder uji; suite memastikan tidak ada analysis terminal sukses yang diterbitkan. Hasil aktual dan batas di [ANA-06_CHECKS](ANA-06_CHECKS.md).

## Pembaruan QA-01 — 21 Oktober 2026

Suite integrasi kini memakai 33 fakta resolver source-authored (18 file), ditambah canary JS/TS/PHP yang wajib processed tanpa menghasilkan marker efek samping. Review teknis independen memeriksa 12 fakta seed dan 33 fakta resolver langsung dari source; metode/fingerprint/nuansa konservatif ada pada [laporan review](QA-01_ORACLE_REVIEW.md). Full check lulus 242 tes utama dan 8 tes data. Benchmark memakai dua corpus repository pada commit beku, tiga container baru per corpus, termasuk replay input terbalik, waktu serta peak charged memory container yang mencakup proses anak PHP. [Laporan QA-01](QA-01_CHECKS.md) mencatat command, angka, batas dan gate signoff tim. Ini tidak menggantikan regression produk penuh, kapasitas dekat ceiling atau review manusia terhadap manifest.

T-GRAPH-01 juga diverifikasi oleh tes reader/handler/mode/payload serta `npm run test:graph:live` dengan opt-in `SAGE_GRAPH_TESTS=1`, database disposable `sage_graph17`, storage sementara privat dan server Next standalone. Suite memeriksa CKG/source integrity, ownership dan sesi nyata, mode/counts, lima viewport, zoom/fit, empty graph, route pratinjau yang telah dihapus, serta respons akun lama yang ditunda. Terminal GraphBundle/archive di-seed langsung dari resolver TypeScript; ini bukan eksekusi pipeline sembilan tahap. Hasil serta cara menjalankan tercatat pada [GRAPH-01_CHECKS](GRAPH-01_CHECKS.md).

## Dokumen canonical DOC-01

T-DOC-01 memeriksa proyeksi deterministik dari satu CKG, katalog deklarasi dan seluruh relasi, mapping/evidence/unresolved, tidak ada fakta tebakan, serta penolakan tamper/hash/source berbeda. T-ANA-02 pada handler tahap 6–9 memeriksa context immutable yang sama dan penolakan artefak upstream berbeda. Integrasi PostgreSQL disposable memeriksa owner/token/attempt/lease/stage fence, replay immutable, mirror/target/config rusak serta rollback ketika lease habis saat insert. Tahap 2–9 menggunakan handler nyata dengan archive fixture; publikasi terminal pipeline tetap #16.

API/halaman dokumen diuji terhadap server Next.js production, PostgreSQL dan Chromium nyata melalui `npm run test:documents:live` pada lima viewport. Kasus meliputi auth/owner, status nonterminal, data canonical corrupt, pemulihan error, metadata/evidence/relasi, tiga bagian dokumen, diagram SVG lokal, keyboard/responsif, dan pergantian akun yang membuang hasil lama. Fixture terminal dibuat secara terkontrol, bukan output consumer pipeline produk. Hasil, versi, hash fixture serta batas aktual dicatat pada [DOC-01_CHECKS](DOC-01_CHECKS.md). Ekspor Markdown memakai bukti T-EXP-01/03 pada [EXP-01_CHECKS](EXP-01_CHECKS.md); PDF T-EXP-02 teruji ([EXP-02_CHECKS](EXP-02_CHECKS.md)).

## Cucumber BDD acceptance Sprint 1

Feature, scenario, dan step Cucumber menggunakan Gherkin berbahasa Inggris. Katalog pada [BDD Sprint 1](BDD_SPRINT1.md) memisahkan sepuluh skenario sumber SRS B.7.1–B.7.3 dari 20 skenario tes aktual; pemetaan menyatakan cakupan parsial/pendukung atau belum tercakup beserta batas API/provider/fixture. Tidak ada skenario kanonis B.7 yang diterima penuh oleh suite terkendali ini. Tes browser memakai API dan sesi sintetis; tes source, queue, serta runner adalah pemeriksaan kontrak pendukung, bukan penerimaan penuh alur GitHub atau pipeline produk. `@US_*` adalah label lokal turunan, bukan ID user story dari SRS. APP/NFR lokal ditandai terpisah dari FR SRS.

Gunakan Node.js `>=24.11.0 <25`. `npm run test:bdd:dry` hanya memeriksa sintaks feature dan resolusi step; status `VALIDATED_ONLY` bukan pass perilaku. `npm run test:bdd` memerlukan opt-in `SAGE_BDD_TESTS=1`, database PostgreSQL disposable termigrasi bernama `sage_bdd_sprint1`, serta server Next.js di origin loopback. `AUTH_BASE_URL` harus sama dengan `SAGE_BDD_BASE_URL`; aplikasi dan runner juga harus memakai `DATABASE_URL` serta `CREDENTIAL_ENCRYPTION_KEY` yang sama. Simpan key test-only pada konfigurasi privat yang diabaikan Git, source konfigurasi yang sama untuk kedua proses, dan jangan menaruh key di repo/chat. `npm run test:bdd:docker` menyiapkan project Compose unik dengan database dan server milik run, tanpa membuka host port. Laporan Cucumber HTML/JSON dan manifest ada pada folder baru `artifacts/bdd/<run-id>`.

Boundary browser memakai session/provider sintetis dan API terkendali, jadi bukan bukti OAuth atau izin GitHub nyata. Runner menggunakan handler uji tepercaya untuk memeriksa progress/persistensi stage, bukan consumer penuh atau keluaran produk. Contoh ini tidak menutup kasus lengkap `T-GH-*`, `T-REP-*`, `T-ANA-*`, QA-01 signoff, atau `T-REL-01`. Revisi judul feature saat ini: **PASS — 20 skenario/156 langkah**, run `2026-10-25T09-11-51-985Z` pada commit tes `9095ef4`. URL, label, pesan, input dan nilai domain ditulis dengan petik dua serta diikat ke `{string}`; kontrol negatif nilai diagnostic yang salah ditolak sesuai harapan. Run ini memakai feature/step Inggris saat ini, production image yang tidak berubah, dan PostgreSQL disposable baru. Manifest dan batas bukti tercatat pada [BDD Sprint 1](BDD_SPRINT1.md).

## DATA-02 cleanup dan retensi

T-DATA-02 menguji owner-only delete, penolakan analisis/ekspor aktif, tombstone hasil, kelengkapan manifest sebelum complete, lease/attempt fencing, retry, serta pelestarian data akun lain dan retry child. `npm test` mencakup unit storage/API/read gate/UI; `npm run test:cleanup:integration` menjalankan transaksi nyata; `npm run test:cleanup:live` menjalankan Next production, worker, PostgreSQL dan Chromium pada 390px/1440px. Dua suite destructive tersebut hanya menerima opt-in `SAGE_CLEANUP_TESTS=1` dan database disposable `sage_cleanup23`. Jangan gunakan database aplikasi. Detail hasil dan batas ada di [DATA-02_CHECKS](DATA-02_CHECKS.md).

## PERF-01 penyimpanan canonical

T-PERF-01 memeriksa read/write/replay layout 1 dan 2, SQL NULL versus JSON null, unknown version, owner/target/hash/source, audit tanpa perubahan, apply atomik, idempotensi, rollback, timestamps, active/deleting/corrupt/oversize, dan CLI. `npm run test:storage:integration` memerlukan `SAGE_STORAGE_TESTS=1` dan database disposable **sage_storage96**. Jangan arahkan suite destruktif ke database aplikasi. Regresi PostgreSQL pipeline/CKG/dokumen serta ekspor/browser dijalankan terpisah; ekspor/browser dapat memakai `SAGE_TEST_STORAGE_LAYOUT=2` untuk mengonversi fixture tervalidasi lewat compactor nyata. [PERF-01_CHECKS](PERF-01_CHECKS.md) mencatat hasil, pengukuran salinan privat dan batas klaim performa.

## PERF-02 resource benchmark

T-PERF-02 memverifikasi manifest corpus lokal dan subset metadata publik tanpa download pada unit test, kontrol iterasi/CLI dan penolakan bukti metrik yang tidak lengkap. `npm run benchmark:resources` memerlukan Docker dan image worker yang cocok; persiapan corpus publik dilakukan dengan `npm run benchmark:prepare`. Run memakai container baru, offline, source/rootfs read-only, batas CPU/RAM/PID/tmpfs/shm dan deadline eksternal; tidak terhubung database atau volume produk. Report menyimpan kegagalan, hash deterministik canonical/Markdown, fase waktu serta cgroup CPU/memory. PDF memakai renderer nyata dengan signature/size guards, tidak dibandingkan hash lintas proses. [PERF-02_CHECKS](PERF-02_CHECKS.md) memisahkan pengukuran core dari queue/database/GitHub dan kapasitas shared-host.

## DEP-01 deployment preparation

T-DEP-01 memeriksa Compose terpisah, image digest, environment/key/database consistency, startup ordering, disabled health, port/host network, external volumes dan resource caps. `npm run test:deployment` tidak memakai secret/network. `npm run deployment:check -- --env-file /path/private.env` hanya resolve/validate tanpa start. `npm run deployment:smoke -- --project <project> --compose <file>` read-only terhadap stack eksplisit; bukan login GitHub atau deploy. Runtime disposable memakai image lokal/synthetic env dengan namespace volume terpisah untuk migrasi, RO/RW, persistence serta backup/restore. Bukti dan batas ada di [DEP-01_CHECKS](DEP-01_CHECKS.md).

## EXP-03 PDF compact

Regresi PDF memeriksa pemilihan deterministik, source-backed groups, anggota/evidence yang tidak dimutasi, budget encoded Mermaid, dan penolakan directive berbahaya. Dua kasus visual menjadi regresi: duplikasi satu relasi tidak menghabiskan seluruh kelompok terpilih; target Unresolved tidak menyingkirkan semua class nyata. Kasus 602 record method/2 kotak/300 relasi membedakan record evidence dari node renderer serta tetap menolak 501 kotak. Node24 lulus 375 unit +8 database foundation; integrasi Markdown/PDF dan browser 390/1440 menguji owner, deduplikasi, attachment/account switch serta retry/lease. Kedua corpus PERF-02 diekspor tiga kali dalam container offline baru, hash canonical/Markdown dibandingkan dengan baseline, dan seluruh halaman PDF A4 diperiksa visual. [EXP-03_CHECKS](EXP-03_CHECKS.md) mencatat hasil aktual, percobaan awal gagal dan batas penerimaan.


## Revisi workspace UI-05

Mode pratinjau publik dihapus. Fixture graph/progres berada di `tests/fixtures/ui` dan bukan halaman produk. Perintah browser lama untuk preview tetap menjadi alias smoke landing/login dan 404; laporan historis UI-01/UI-02 tidak membuktikan workspace saat ini. `test:pdf:live` juga memeriksa workspace nyata pada 390/1440 px (evidence commit, katalog bertahap, graph, dan layout); `test:target:ui` memeriksa perpindahan fokus setelah pemilihan repository dengan provider yang dikontrol. Lihat [UI-05_CHECKS](UI-05_CHECKS.md) untuk hasil run dan batasnya.


## ANA-08: resolusi lokal, graph esensial, UML BCE

Uji positif mencakup binding lokal `new`, field/parameter property bertipe, pewarisan aman, dan alias TS tanpa `baseUrl`. Uji negatif mencakup receiver dinamis, union, generic shadowing, mutasi, scope loop, destructuring, dispatch class PHP terbuka serta alias/by-reference. Oracle source harus memeriksa target dan rentang evidence, bukan hanya penurunan jumlah Unresolved.

Proyeksi graph diuji deterministik, bebas mutasi canonical, mengangkat anggota ke pemilik dan memprioritaskan node terhubung. UML diuji dengan lima class BCE yang semuanya tampil beserta dependency dan pewarisan; role convention tetap eksplisit dan yang ambigu tidak dipaksakan. Browser 390/1440 memeriksa SVG nyata, garis hubungan, susunan atas-ke-bawah dan overflow. Ekspor PDF melewati HTTP/worker dengan fixture yang sama, menjaga canonical/Markdown dan replay hasil lama. Hasil aktual dan batas run dicatat di [ANA-08_CHECKS](ANA-08_CHECKS.md).
