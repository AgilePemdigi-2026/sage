# Arsitektur sistem

Web/API mengautentikasi akun dan mengantrekan pekerjaan; worker membentuk snapshot, CCM/CKG, serta semantic model dari commit yang sama. Setelah analisis selesai, Code Knowledge tersedia sebagai view pendamping. Pengguna dapat membuat TOGAF Phase C baseline ADD melalui endpoint terpisah yang menyimpan snapshot ADD dan revision overlay per owner. UI aktif menampilkan Code Knowledge dan TOGAF ADD; Software Engineering Diagram serta UML lama tidak lagi menjadi keluaran utama. Rincian setup ada di [setup lokal](../guides/LOCAL_SETUP.md); bukti bertanggal ada di [arsip](../archive/README.md).

## Komponen

| Komponen | Tanggung jawab | Batas |
| --- | --- | --- |
| Web/API Next.js | Session, GitHub callback, target analisis, riwayat, graph, ADD baseline, review overlay, dan endpoint job | Tidak menjalankan parsing source panjang di request HTTP |
| Worker Node.js | Mengambil job, snapshot, pipeline, adapter analyzer, persistensi CKG/semantic model, dan job lama | Satu analysis job aktif secara global |
| Adapter JS/TS | TypeScript Compiler API, AST, simbol, tipe, dan evidence | Versi API dipin; tidak memuat plugin atau menjalankan project target |
| Adapter PHP | nikic/PHP-Parser melalui program PHP tepercaya milik SAGE | Membaca source sebagai data; tidak mengeksekusi file target |
| Adapter Python | Pemindai line-structured untuk deklarasi, route FastAPI-style literal, model SQLAlchemy-style, dan beberapa relasi lokal | Bukan Python AST penuh; tidak mengeksekusi source atau menyelesaikan alur dinamis |
| Extractor data | SQL DDL, OpenAPI JSON/YAML, serta pola JSON Schema tertentu | Tidak membuktikan skema runtime atau integrasi yang tidak dideklarasikan |
| PostgreSQL | User, koneksi, job, stage, CKG/semantic model, ADD baseline, revision, dan metadata storage | Seluruh query hasil memiliki konteks pemilik |
| Persistent volume | Snapshot/source evidence dan file ekspor | Tidak berada di Git atau direktori static publik |
| GitHub | Identitas, izin, metadata target, dan snapshot source | Akses dibatasi pada hak pengguna/instalasi |
| Browser | UI Indonesia, Cytoscape.js, inspector, dan unduhan | Tidak menerima token GitHub atau private key |

Alur produk: GitHub -> immutable snapshot -> static adapters -> CCM/CKG -> semantic model -> Code Knowledge. Setelah pipeline selesai, endpoint **Generate ADD** memproyeksikan baseline Data Architecture dan Application Architecture, menyimpan model, lalu membuka catalog/matrix/review/export. Detail model ada di [TOGAF ADD](TOGAF_ADD.md).

LLM kampus opsional dipanggil hanya jika user mengaktifkan consent saat Generate ADD. Payload dibatasi pada nama dan relationship summary; model hanya membantu menulis dua narrative baseline dan tidak dapat mengubah fakta source. Jika endpoint/model tidak tersedia, narrative deterministik tetap dipakai. Framework backend tambahan, graph database, dan layanan antrean terpisah tidak menjadi dependency awal.

## Docker Compose

Tiga service jangka panjang: `web`, `worker`, dan `db`; service `migrate` berjalan sekali sebelum web/worker untuk menerapkan migrasi. Image worker memuat Node.js, runtime PHP, dependency parser yang dipin, serta Chromium untuk ekspor PDF. Program PHP hanya menjalankan adapter milik aplikasi.

- Web dipublikasikan ke loopback host, dengan target awal port 3000; port final mengikuti konfigurasi lokal.
- PostgreSQL berada pada jaringan internal Compose; port database tidak perlu dipublikasikan secara default.
- Web dan worker berbagi storage yang terkontrol; browser mengunduh melalui endpoint berotorisasi.
- Database dan artefak memakai persistent volumes sehingga restart mempertahankan hasil.
- Worker berjalan sebagai pengguna non-root dan memiliki batas CPU, memori, ukuran snapshot, timeout, serta jumlah file.
- Health check, migrasi, dependency readiness, dan pemulihan job diuji sebelum setup dianggap selesai.
- Credential dan key berasal dari environment lokal yang diabaikan Git; contoh konfigurasi hanya berisi placeholder.
- Command yang sudah diverifikasi untuk lingkungan lokal tercantum di [setup lokal](../guides/LOCAL_SETUP.md); keberhasilan setup fondasi tidak membuktikan pipeline produk lengkap.

Produksi berjalan melalui Coolify pada server bersama dengan web, worker, PostgreSQL, Chromium, dan volume privat. Web dirutekan ke port internal 3000 melalui domain aplikasi; resource ceiling awal bukan quota resmi dosen. Lihat [runbook operasi](../operations/COOLIFY.md) untuk registry, routing, backup, dan batas verifikasi.

## Identitas dan target repository

GitHub App menangani login pengguna dan akses instalasi. Bedakan user authorization, instalasi App, serta token instalasi. Login tidak otomatis memberi App akses ke seluruh repository private.

Repository public milik akun diambil dari identitas sesi melalui endpoint GitHub public dengan pagination, terpisah dari pilihan instalasi App. Permintaan UI terikat ID GitHub akun; header yang tidak cocok dengan cookie sesi ditolak sebelum provider. Tab lama menghapus daftar/target dan memuat ulang ketika akun berubah.

Repository publik pihak lain dapat dicari menggunakan URL/slug yang tervalidasi setelah login. Daftar instalasi hanya menampilkan repository dalam izin App, sedangkan metadata dan snapshot repository publik diambil melalui jalur GitHub yang sesuai. Target private ditolak jika pengguna atau instalasi tidak memiliki izin yang diperlukan.

Resolve branch/commit ke full SHA pada saat submission valid diterima, sebelum masuk antrean. Snapshot dan semua percobaan berikutnya menggunakan SHA tersebut. Saat worker mulai, izin diperiksa kembali tanpa mengubah SHA. Perubahan HEAD selama mengantre tidak boleh mengubah target.

Callback memakai state sekali pakai, session berumur terbatas, dan pemetaan instalasi yang tervalidasi. Kredensial disimpan terenkripsi, tidak dikirim ke browser atau log. GH-01 memverifikasi callback nyata; origin tepercaya dan callback lokal dijelaskan di [setup GitHub App](../guides/GITHUB_APP_SETUP.md).

## Antrean dan sembilan tahap

| Urutan | Stage key | Label UI |
| --- | --- | --- |
| 1 | `SNAPSHOT` | Mengambil snapshot repository |
| 2 | `LANGUAGE_DETECTION` | Mendeteksi bahasa dan struktur proyek |
| 3 | `STATIC_ANALYSIS` | Menjalankan analisis statis |
| 4 | `COMMON_CODE_MODEL` | Membentuk Common Code Model |
| 5 | `KNOWLEDGE_GRAPH` | Membangun Code Knowledge Graph |
| 6 | `INTERFACE_CATALOG` | Menyiapkan katalog interface |
| 7 | `SOFTWARE_ENGINEERING_DIAGRAM` | Memvalidasi proyeksi struktur source |
| 8 | `UML_CLASS_DIAGRAM` | Memvalidasi relasi class |
| 9 | `ARCHITECTURE_DOCUMENT` | Menyimpan hasil analisis |

Stage key lama tetap dipakai untuk kompatibilitas pipeline dan data historis; label UI tidak lagi menawarkan Software Engineering Diagram atau UML sebagai deliverable utama. ADD baseline dibuat terpisah sesudah pipeline selesai.

Antrean PostgreSQL, idempotent enqueue, claim, lease/lock database, dan guard global sudah diimplementasikan serta diuji pada [ANA-01](../archive/analyzer/ANA-01_CHECKS.md). Runner dasar ANA-07-S1 kini dipakai oleh consumer ANA-07. Worker mengambil satu job, menyusun registry sembilan handler nyata, mempertahankan lease selama eksekusi dan publikasi, lalu melepaskan slot hanya bersama transisi terminal. Restart tidak melanjutkan artefak in-memory: lease kedaluwarsa menjadi FAILED/WORKER_INTERRUPTED dan pengguna membuat retry baru. [Bukti ANA-07](../archive/analyzer/ANA-07_CHECKS.md) membedakan provider terkontrol dari GitHub live.

Status analisis: `QUEUED`, `RUNNING`, `COMPLETED`, `COMPLETED_WITH_LIMITATIONS`, `FAILED`. Status tahap: `PENDING`, `RUNNING`, `COMPLETED`, `FAILED`. Setiap tahap dimulai sesudah tahap sebelumnya selesai. Ketika gagal, tahap berikutnya tetap `PENDING` dan UI menjelaskan pipeline berhenti.

Retry membuat analysis ID baru, memiliki `retryOfAnalysisId`, menyalin target full SHA/config, dan melakukan pemeriksaan izin baru. Record percobaan lama dipertahankan. Pengguna yang ingin mengikuti HEAD terbaru membuat analisis baru melalui pemilihan target.

Worker yang kehilangan lease atau mati meninggalkan job yang dideteksi recovery. Percobaan lama ditandai `FAILED` dengan kode `WORKER_INTERRUPTED`; tidak dinyatakan Completed dan tidak dilanjutkan diam-diam dengan hasil parsial.

Progress memakai endpoint read-only dengan polling tiga detik selama QUEUED/RUNNING; polling berhenti ketika terminal. Retry FAILED memeriksa izin GitHub terkini sebelum mengantre analysis baru dengan SHA/configuration/versi yang sama. Worker juga menangani job ekspor Markdown/PDF dan cleanup dengan pemeriksaan pemilik, retry, serta metadata artefak terverifikasi.

## Ketersediaan hasil

Graph, semantic model, dan legacy architecture document dipublikasikan bersama setelah kesembilan tahap pipeline berhasil. ADD Phase C baseline baru dibuat saat pengguna menekan **Generate ADD**. Karena itu, analisis yang selesai belum tentu memiliki `AddBaseline` tersimpan. `COMPLETED_WITH_LIMITATIONS` tetap memiliki graph/semantic output serta daftar bagian yang dikecualikan. Gagal membentuk artefak pipeline membuat analisis `FAILED`; artefak internal parsial tidak disajikan sebagai hasil selesai.

Kegagalan membuat ADD tidak mengubah hasil CKG/semantic yang telah selesai; Generate ADD dapat dicoba lagi. Pada UI ADD saat ini, Markdown diunduh dari browser dan PDF dibuat melalui Print / Save as PDF. Export job worker yang masih ada melayani alur dokumen lama dan tidak membuktikan ekspor PDF ADD baru.

ArchiMate ADD views merupakan proyeksi dari canonical semantic model dan CKG. Legacy DOC-02 masih memakai Mermaid untuk dokumen lama; ia tidak menentukan fakta ADD atau resolver. Halaman ADD aktif merender SVG dari model ADD dan membuat Markdown/PDF dari model serta review overlay yang sedang ditampilkan. Worker export jobs masih mendukung format dokumen lama.

## Batas keamanan pemrosesan

- Terima URL GitHub HTTPS yang dinormalisasi; jangan memperlakukan URL pengguna sebagai tujuan fetch bebas.
- Pengambilan archive/redirect hanya melalui host GitHub yang diizinkan oleh implementasi.
- Terapkan batas file, byte terkompresi/terekstrak, timeout, path traversal, symlink, dan rasio ekstraksi.
- Jangan menjalankan source target, install script, package manager target, konfigurasi executable, atau plugin compiler project target.
- `.git`, dependency vendored, binary, hasil build, dan submodule tidak dipindai secara rekursif; pengecualian dicatat.
- Source, komentar, label graph, dan diagram di-escape sebagai data; halaman cetak tidak dapat menjalankan HTML/JS dari repository.
- Semua endpoint hasil, source, export, dan delete memeriksa pemilik; opaque ID tidak menggantikan otorisasi.

## Struktur aplikasi

```text
apps/web/                 UI dan route API
apps/worker/              orchestration, queue, pipeline, export
packages/contracts/      tipe payload, CCM, registry, dan validator
packages/database/       schema, migrasi, dan reader owner-scoped
packages/analyzer-js/     adapter JavaScript/TypeScript
packages/analyzer-php/    adapter PHP dan program parser tepercaya
packages/documents/       proyeksi artefak dan template cetak
tests/fixtures/           source uji kecil dengan oracle yang direview
tests/bdd/                skenario Gherkin dan langkah browser
tests/*.integration.ts   pengujian database/worker terisolasi
scripts/                  runner integrasi, browser, dan operasi
```

Contracts CCM, canonical serialization, registry, dan validator tersedia di packages/contracts. Proyeksi dokumen/semantik berada di packages/documents. Runner browser dan worker memakai database/storage disposable sesuai guard masing-masing; sesi fixture tidak membuktikan OAuth provider nyata.

## Handler internal canonical CKG

ANA-06 menyediakan `createCkgStageHandlers` untuk COMMON_CODE_MODEL dan KNOWLEDGE_GRAPH, setelah handler snapshot/source. Keduanya membaca ulang snapshot owner-bound dan memverifikasi hash/target artefak tahap sebelumnya. Graph canonical adalah wrapper CCM tervalidasi; tidak menjalankan resolver ulang atau mengubah fakta. Persistensi memakai lease aktif, stage fence, transaksi dan replay immutable. Handler berikutnya menerima graph beserta hash untuk proyeksi dokumen; publikasi analysis selesai tidak dilakukan di tahap graph. Consumer ANA-07 menyambungkan handler ini ke registry sembilan tahap dan publikasi terminal atomik. Bukti serta batas ada di [ANA-06_CHECKS](../archive/analyzer/ANA-06_CHECKS.md).

## Pembacaan graph tersimpan GRAPH-01

Web memeriksa session dan pemilik/status analisis sebelum membaca snapshot archive dari volume read-only. Archive aktif terbaru dipilih secara owner/analysis-scoped dengan urutan createdAt/id; canonical reader memverifikasi kembali hash/source/mirror dan target immutable. Endpoint graph hanya menyediakan proyeksi lengkap setelah status sukses, tanpa source bytes, path storage atau token. Validasi byte archive ini tidak menjalankan adapter/resolver atau source target.

Browser mengikat payload ke ID analisis serta akun, membuang respons generasi lama, dan menghapus data sebelum pemeriksaan ulang identitas pada focus/pageshow/visibility. Mode Esensial/Detail AST/Fokus node/Semua referensi hanya menghasilkan subset tampilan dari fakta canonical. Budget render 200 node/500 edge dijelaskan bersama canonical/mode/visible counts; API tidak memotong graph. Node Query literal dan kategori AST canonical digabung AND pada proyeksi lengkap sebelum mode/budget render; edge hanya bertahan jika kedua endpoint cocok. Reset/no-result tidak mengubah payload atau hash canonical. Lihat [GRAPH-02_CHECKS](../archive/graph/GRAPH-02_CHECKS.md). Inspector/source (GRAPH-03) membaca ulang canonical CKG dan archive melalui helper terotorisasi yang sama. Detail node membawa relasi langsung lengkap, sementara source hanya dikirim atas permintaan untuk ID file evidence canonical dengan rentang maksimum 200 baris/128 KiB. Respons diikat ke akun, analysis, hash, snapshot serta node/file. Lihat [GRAPH-03_CHECKS](../archive/graph/GRAPH-03_CHECKS.md). Bukti terisolasi dan batas pipeline tersedia pada [GRAPH-01_CHECKS](../archive/graph/GRAPH-01_CHECKS.md).

## Model dan akses dokumen DOC-01

Pipeline masih menjalankan handler internal INTERFACE_CATALOG, SOFTWARE_ENGINEERING_DIAGRAM, UML_CLASS_DIAGRAM, dan ARCHITECTURE_DOCUMENT untuk kompatibilitas publikasi yang telah ada. Hasil tiga tampilan lama tidak lagi menjadi UI utama. TOGAF Phase C ADD baru dibuat oleh endpoint owner-scoped `/api/analyses/{analysisId}/add` sesudah analisis berstatus terminal sukses; endpoint membaca GraphBundle dan SemanticModel canonical serta memvalidasi hash/snapshot yang sama.

Dokumen internal dan graph disembunyikan oleh canonical reader selama analisis belum sukses. Pipeline menerbitkan hasil graph/semantic setelah stage yang diwajibkan selesai; ADD baseline tetap dibuat terpisah dari hasil tersebut. Detail kontrak: [spesifikasi analisis](ANALYSIS_SPEC.md#togaf-phase-c-add-baseline).

Halaman `/analyses/{analysisId}/document` mengambil model ADD melalui API privat setelah memeriksa session dan owner. Client menolak respons dari akun yang berubah. Diagram Data Structure dan Application Cooperation dirender sebagai SVG dari model yang sama serta mengikuti overlay review. Markdown memuat katalog, functional decomposition, matrix, relationship register, limitation, review state, dan evidence commit-pinned. PDF memakai print CSS A4 dan dikendalikan browser.

## Ekspor ADD aktif dan pipeline ekspor legacy

ADD baseline saat ini diekspor dari halaman yang sudah memuat canonical model dan review overlay: Markdown dibuat di browser, sedangkan PDF memakai print browser dengan layout A4. Keduanya mengacu ke snapshot repository/commit yang sama dan evidence commit-pinned. Perubahan pada overlay yang belum disimpan ikut tampil pada ekspor sesi tersebut; pengguna sebaiknya menyimpan review terlebih dahulu bila ingin revisi menjadi data persisten.

Job ekspor worker dan arsip EXP-01 adalah implementasi legacy bagi alur dokumen sebelumnya. Keberadaan fitur lama itu bukan bukti bahwa export worker menangani model `sage-add-baseline-v1`. Cache/versioning, pagination PDF berukuran besar, dan konsistensi lintas format ADD baru masih harus diuji sebelum dinyatakan siap rilis. Lihat [kontrak ADD](TOGAF_ADD.md) dan [catatan historis EXP-01](../archive/documents/EXP-01_CHECKS.md).
