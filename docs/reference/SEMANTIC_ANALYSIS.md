# Analisis semantik fitur dan alur

## Kontrak

`SemanticModel` (`sage-semantic-v2`) adalah model canonical terpisah dari fakta CCM/CKG. Snapshot, SHA-256 source graph, versi extractor, serta evidence sumber mengikat hasil ke commit yang dianalisis. Node: actor, feature, concept, component, store, step, decision, outcome. Setiap hubungan memuat evidence dan alasan **Terbukti** (`proven`) atau **Indikasi** (`indicated`). Ini tidak mengubah resolusi `Exact`/`Unresolved` pada CKG. Data tidak menyatakan bahwa seluruh jalur statis pasti dapat dieksekusi pada runtime.

Extractor berbasis aturan berjalan pada worker yang ada tanpa instalasi dependency atau eksekusi source repository target. Next.js menggunakan AST TypeScript, Laravel memakai token PHP serta deklarasi route/controller, Node HTTP dan FastAPI hanya mendukung pola literal terbatas. SQL, Prisma model, OpenAPI JSON/YAML, dan sebagian JSON Schema menambah contract data/interface, bukan dukungan bahasa pemrograman baru. Import dan kedekatan folder tidak menjadi urutan aktivitas. Framework lain atau binding dinamis memerlukan bukti tersendiri dan menghasilkan batasan bila tidak dapat ditelusuri. LLM kampus tidak dipakai untuk membentuk semantic model; consent LLM berlaku terpisah dan hanya untuk wording narrative ADD.

Prisma extraction mengatalogkan deklarasi `model` dan relasi ketika field secara eksplisit memakai nama model lain dalam schema root yang sama. Relasi dua arah dikelompokkan menjadi satu association dengan kedua deklarasi sebagai evidence. Scalar field, enum, operasi CRUD, data owner, distribusi, dan deployment tidak disimpulkan dari schema. File schema yang malformed, target relasi ambigu, dan self-reference yang belum didukung dilaporkan sebagai limitation.

## Penyajian interaktif

Sejak revisi 1 November 2026, graph semantik memakai architecture card dan kelompok tanggung jawab. Lingkaran bukan lagi persyaratan bentuk. Diagram alur mengikuti entry point beserta seluruh hubungan yang tampil dalam scope terpilih, tanpa pemotongan acak 24 node. Zoom, fokus, search dan evidence tetap tersedia. Lihat [audit dan revisi keterbacaan](DIAGRAM_READABILITY.md).

Extractor `0.2.0` memperbaiki hubungan kondisi/query Laravel serta mengecualikan callable yang hanya dideklarasikan dan kode setelah unconditional return dari fakta alur request. Query-result local hanya ditautkan ke kondisi langsung jika assignment dan pemakaiannya dapat diverifikasi tanpa mutasi/escape; pola lain tetap tidak dianggap terbukti. Analisis ulang diperlukan untuk memperoleh hasil baru.

## Penyimpanan dan akses

- `SemanticModel` menyimpan satu `canonicalContent`, hash model, source CKG hash, versi schema/extractor, serta foreign key pemilik/analisis. Tidak ada salinan model JSON per revisi. ADD baseline memakai penyimpanan canonical tersendiri (`AddBaseline`) dengan append-only `AddRevision` untuk koreksi dokumen.
- `PresentationRevision` hanya menyimpan overlay label/kelompok dan hash overlay. Revisi nol berarti hasil otomatis; pembaruan menambahkan revisi, tidak menimpa source.
- GET `/api/analyses/:analysisId/semantic` membaca model dan overlay terbaru untuk sesi/pemilik yang sama. Hasil lama tanpa model memberikan keterangan analisis ulang; graph/ADD lama tetap dapat dibaca.
- PATCH `/api/analyses/:analysisId/semantic/presentation` menerima `{ "expectedRevision": 0, "overlay": { "labels": {}, "groups": {} } }`. Body, same-origin, akun, ID node/fitur, panjang label, dan pemilik divalidasi. Pengelompokan hanya untuk konsep, komponen, dan store; tidak menambah hubungan.
- Row lock analisis lalu model, serta pemeriksaan revisi mencegah dua penulis menimpa perubahan. Revisi usang ditolak dengan konflik HTTP 409. Reset menghapus override terkait pada revisi baru.
- Penghapusan analisis menghapus model dan riwayat koreksi melalui cascade. Kredensial tidak masuk model semantik.

## ADD aktif dan kompatibilitas export

Semantic model adalah salah satu input canonical bagi ADD, bukan file dokumen yang diekspor langsung. Halaman TOGAF ADD membaca `AddBaseline` beserta overlay/revision saat ini. Markdown dan LaTeX dibuat dari snapshot aktif di browser; PDF memakai print browser dengan SVG A4. File LaTeX adalah source unduhan dan bukan bagian dari export worker/API. Export worker yang mem-pin semantic model/presentation revision tetap ada untuk format lama; hal itu tidak membuktikan worker menghasilkan `sage-add-baseline-v1`.

Markdown ADD mencakup katalog, functional decomposition, matriks, relasi, limitations, review, dan evidence commit-pinned. LaTeX memproyeksikan struktur Phase C, tabel, diagram, serta evidence yang sama; source belum dikompilasi di worktree ini. PDF ringkas memakai diagram SVG pada halaman A4. Cache/versioning, pagination pada repository besar, dan konsistensi penuh seluruh tampilan masih memerlukan acceptance untuk ADD aktif.

Batas source, ukuran canonical model, artefak, timeout, serta resource worker tetap berlaku. Analisis yang gagal memenuhi kontrak tidak diterbitkan sebagai hasil sukses. Dukungan backend Laravel tidak membuktikan adanya layar atau interaksi frontend.

## Verifikasi

Acuan beku dan kasus negatif ada pada [oracle](../evidence/semantic/oracle.json); [storyboard](../archive/semantic/SEMANTIC_STORYBOARD.md) ditulis sebelum implementasi renderer.

```bash
npm run semantic:prepare
npm run test:semantic
npm run test:bdd:semantic
npm run benchmark:semantic -- artifacts/semantic/corpora/sistem-informasi-perpus artifacts/semantic/run-perpus
```

Untuk pengukuran container, bangun target QA `bdd` dari Dockerfile lalu gunakan runner yang mempertahankan kegagalan proses/heap sebagai laporan:

```bash
docker build --target bdd -t sage-semantic-qa:local .
python3 scripts/run-semantic-benchmarks.py artifacts/semantic/verification-run --image sage-semantic-qa:local --render
```

Runner membuat container baru untuk analisis dan container terpisah untuk ekspor per corpus, tanpa jaringan, read-only selain output/tmp, maksimal 2 GB dan 1,5 CPU. Default runner memakai kode serta dependency dari image QA yang baru dibangun; mount corpus/output tidak menutupi Composer vendor atau Prisma generated. `--source-overlay` hanya untuk pengembangan, memasang direktori source tertentu sambil mempertahankan dependency image. Ia tidak mengubah resource aplikasi atau server Coolify. Gunakan direktori output baru per benchmark. Laporan mencatat kegagalan, waktu, puncak RSS proses, `memory.peak` cgroup, ukuran model/artefak, dan cakupan source; RSS dan charged memory adalah metrik berbeda. Hasil terukur ada pada [SEM-01 checks](../archive/semantic/SEM-01_CHECKS.md). Untuk menilai resource seluruh container, jalankan setiap corpus dalam container baru dengan batas yang sama. Pemisahan proses menghindari AST analyzer dan model replay tertahan di memori worker ekspor. Mode langsung `SAGE_SEMANTIC_RENDER=1` mengukur semuanya dalam satu proses dan bukan pengukuran worker ekspor terisolasi. PASS source/hashes tidak menggantikan pemeriksaan makna alur dan visual. BDD memakai Gherkin Inggris dengan parameter berpetik; fixture BDD tidak membuktikan integrasi OAuth live atau kesiapan server Coolify.

## Acuan Archify dan batas implementasi

Evaluasi terhadap [Archify](https://github.com/tt-a1i/archify) pada commit `a4065941f12be7967436261d9934784e381d423c` menemukan alur pembuatan model oleh coding agent: agent menelusuri source dan menyusun representasi diagram, kemudian tool Archify memvalidasi dan merendernya. Archify bukan extractor statis universal yang bisa langsung menghasilkan model SAGE. SAGE mempertahankan extractor berbasis aturan tanpa layanan AI eksternal; pendekatan yang diambil adalah mengikuti entry point dan relasi source yang dapat ditelusuri, menyertakan lokasi evidence, serta menyatakan ketidakpastian. Tidak ada kode Archify yang disalin dalam revisi ini.

Extractor `0.4.2` mengenali kandidat guard method/path Node HTTP pada fungsi `handle…Request`, binding `request.method`, serta helper lokal `pathParts` yang didukung. Guard bersarang dapat dikomposisikan; pemanggilan lintas file ditelusuri hanya dengan binding CKG `Exact` dan lokasi panggilan dalam cabang yang cocok. Registrasi `createServer` menjadi evidence terpisah; tidak membuktikan `listen` atau keterjangkauan runtime. Cabang kontradiktif, kode setelah return, callback yang belum dipanggil, binding type-only/shadowed/mutated, dan dispatch dinamis tidak dipromosikan menjadi eksekusi terbukti. Ini belum merupakan dukungan umum Express atau seluruh router Node.

Replay offline pada 15 November 2026 menghasilkan 5 fitur, 66 node, 76 relasi, dan 3 batasan pada snapshot acuan privat. Seluruh hash/span lolos validasi canonical. [Laporan aman](../evidence/semantic/node-http-replay-20261115.json) hanya menyimpan hash dan jumlah, tanpa source privat. Jalankan ulang dengan `npx tsx scripts/replay-node-http.ts <snapshot-directory> <canonical-ckg.json> <report-baru.json>`; file laporan lama tidak ditimpa. Suite semantik 105 tes lulus, termasuk kasus positif/negatif Node HTTP. Ini membuktikan ekstraksi statis, bukan eksekusi aplikasi target.

Deklarasi route Laravel membuktikan rujukan action, tetapi relasi eksekusi hanya ditandai terbukti ketika method controller dapat ditemukan secara unik. Action yang belum terpecahkan tetap menjadi indikasi, bukan klaim bahwa handler benar-benar dieksekusi. Hasil lama memerlukan analisis ulang untuk mendapat perubahan ini.
