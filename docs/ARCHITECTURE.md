# Arsitektur sistem

Status per 20 Oktober 2026: login GitHub, akses repository, validasi target, submission idempotent ke durable queue, snapshot immutable, serta source handlers tersedia dan memiliki bukti per issue. Runner tahap dan penyimpanan status juga tersedia. Consumer analisis produk tetap nonaktif (`workerQueueEnabled=false`), sehingga submission belum menjalankan pipeline sembilan tahap sampai selesai. History produk membaca record analisis nyata melalui list/detail GET (HIST-01); graph/dokumen produk, ekspor, dan penghapusan masih mengikuti issue terbuka. Detail setup dan batas bukti ada di [setup lokal](LOCAL_SETUP.md).

## Komponen

| Komponen | Tanggung jawab produk target | Batas |
| --- | --- | --- |
| Web/API Next.js | Session, GitHub callback, target analisis, riwayat, graph, dokumen, dan endpoint job | Tidak menjalankan parsing panjang di request HTTP |
| Worker Node.js | Mengambil job, snapshot, pipeline, adapter analyzer, persistensi hasil, dan ekspor | Satu analysis job aktif secara global |
| Adapter JS/TS | TypeScript Compiler API, AST, simbol, tipe, dan evidence | Versi API dipin; tidak memuat plugin atau menjalankan project target |
| Adapter PHP | nikic/PHP-Parser melalui program PHP tepercaya milik SAGE | Membaca source sebagai data; tidak mengeksekusi file target |
| PostgreSQL | User, koneksi, job, stage, hasil terstruktur, dokumen, dan metadata storage | Seluruh query hasil memiliki konteks pemilik |
| Persistent volume | Snapshot/source evidence dan file ekspor | Tidak berada di Git atau direktori static publik |
| GitHub | Identitas, izin, metadata target, dan snapshot source | Akses dibatasi pada hak pengguna/instalasi |
| Browser | UI Indonesia, Cytoscape.js, inspector, dan unduhan | Tidak menerima token GitHub atau private key |

Target pipeline: GitHub -> snapshot immutable -> adapter bahasa -> Common Code Model -> canonical Code Knowledge Graph -> tiga proyeksi artefak -> Architecture Definition Document -> ekspor. Baru akses repository, validasi/submission, snapshot, dan fondasi queue/runner yang tersedia; alur penuh belum aktif.

LLM tidak terhubung ke jalur MVP. Framework backend tambahan, graph database, dan layanan antrean terpisah tidak menjadi dependency awal.

## Rencana Docker Compose

Tiga service jangka panjang: `web`, `worker`, dan `db`; service `migrate` berjalan sekali sebelum web/worker untuk menerapkan migrasi. Image worker memuat Node.js, runtime PHP, dependency parser yang dipin, serta Chromium untuk ekspor PDF. Program PHP hanya menjalankan adapter milik aplikasi.

- Web dipublikasikan ke loopback host, dengan target awal port 3000; port final mengikuti konfigurasi lokal.
- PostgreSQL berada pada jaringan internal Compose; port database tidak perlu dipublikasikan secara default.
- Web dan worker berbagi storage yang terkontrol; browser mengunduh melalui endpoint berotorisasi.
- Database dan artefak memakai persistent volumes sehingga restart mempertahankan hasil.
- Worker berjalan sebagai pengguna non-root dan memiliki batas CPU, memori, ukuran snapshot, timeout, serta jumlah file.
- Health check, migrasi, dependency readiness, dan pemulihan job diuji sebelum setup dianggap selesai.
- Credential dan key berasal dari environment lokal yang diabaikan Git; contoh konfigurasi hanya berisi placeholder.
- Command yang sudah diverifikasi untuk lingkungan lokal tercantum di [setup lokal](LOCAL_SETUP.md); keberhasilan setup fondasi tidak membuktikan pipeline produk lengkap.

Hosting produksi tetap TBD. Pemisahan worker dipertahankan ketika aplikasi dipindahkan ke server; evaluasi deployment harus mencakup worker, database, Chromium, dan volume, bukan hanya frontend.

## Identitas dan target repository

GitHub App menangani login pengguna dan akses instalasi. Bedakan user authorization, instalasi App, serta token instalasi. Login tidak otomatis memberi App akses ke seluruh repository private.

Repository public milik akun diambil dari identitas sesi melalui endpoint GitHub public dengan pagination, terpisah dari pilihan instalasi App. Permintaan UI terikat ID GitHub akun; header yang tidak cocok dengan cookie sesi ditolak sebelum provider. Tab lama menghapus daftar/target dan memuat ulang ketika akun berubah.

Repository publik pihak lain dapat dicari menggunakan URL/slug yang tervalidasi setelah login. Daftar instalasi hanya menampilkan repository dalam izin App, sedangkan metadata dan snapshot repository publik diambil melalui jalur GitHub yang sesuai. Target private ditolak jika pengguna atau instalasi tidak memiliki izin yang diperlukan.

Resolve branch/commit ke full SHA pada saat submission valid diterima, sebelum masuk antrean. Snapshot dan semua percobaan berikutnya menggunakan SHA tersebut. Saat worker mulai, izin diperiksa kembali tanpa mengubah SHA. Perubahan HEAD selama mengantre tidak boleh mengubah target.

Callback memakai state sekali pakai, session berumur terbatas, dan pemetaan instalasi yang tervalidasi. Kredensial disimpan terenkripsi, tidak dikirim ke browser atau log. GH-01 memverifikasi callback nyata; origin tepercaya dan callback lokal dijelaskan di [setup GitHub App](GITHUB_APP_SETUP.md).

## Antrean dan sembilan tahap

| Urutan | Stage key | Label UI |
| --- | --- | --- |
| 1 | `SNAPSHOT` | Mengambil snapshot repository |
| 2 | `LANGUAGE_DETECTION` | Mendeteksi bahasa dan struktur proyek |
| 3 | `STATIC_ANALYSIS` | Menjalankan analisis statis |
| 4 | `COMMON_CODE_MODEL` | Membentuk Common Code Model |
| 5 | `KNOWLEDGE_GRAPH` | Membangun Code Knowledge Graph |
| 6 | `INTERFACE_CATALOG` | Menghasilkan Interface Catalog |
| 7 | `SOFTWARE_ENGINEERING_DIAGRAM` | Menghasilkan Software Engineering Diagram |
| 8 | `UML_CLASS_DIAGRAM` | Menghasilkan UML Class Diagram |
| 9 | `ARCHITECTURE_DOCUMENT` | Menyusun Architecture Definition Document |

Antrean PostgreSQL, idempotent enqueue, claim, lease/lock database, dan guard global sudah diimplementasikan serta diuji pada [ANA-01](ANA-01_CHECKS.md). Runner tahap memiliki irisan teruji pada ANA-07-S1. Namun consumer produk dikendalikan `workerQueueEnabled=false`; job yang diantrekan belum memicu analisis sembilan tahap penuh. Integrasi consumer dan publikasi hasil tetap berada pada ANA-07 #16.

Status analisis: `QUEUED`, `RUNNING`, `COMPLETED`, `COMPLETED_WITH_LIMITATIONS`, `FAILED`. Status tahap: `PENDING`, `RUNNING`, `COMPLETED`, `FAILED`. Setiap tahap dimulai sesudah tahap sebelumnya selesai. Ketika gagal, tahap berikutnya tetap `PENDING` dan UI menjelaskan pipeline berhenti.

Retry membuat analysis ID baru, memiliki `retryOfAnalysisId`, menyalin target full SHA/config, dan melakukan pemeriksaan izin baru. Record percobaan lama dipertahankan. Pengguna yang ingin mengikuti HEAD terbaru membuat analisis baru melalui pemilihan target.

Worker yang kehilangan lease atau mati meninggalkan job yang dideteksi recovery. Percobaan lama ditandai `FAILED` dengan kode `WORKER_INTERRUPTED`; tidak dinyatakan Completed dan tidak dilanjutkan diam-diam dengan hasil parsial.

Target komunikasi progress adalah polling endpoint read-only. Interval awal dan backoff mengikuti implementasi consumer penuh. Target arsitektur juga memakai worker untuk export dan cleanup; job export produk dan cleanup belum aktif dan tetap menunggu #20–23.

## Ketersediaan hasil

Publikasikan graph dan ADD sebagai satu result bundle setelah kesembilan tahap berhasil. `COMPLETED_WITH_LIMITATIONS` tetap memiliki bundle lengkap beserta daftar bagian yang dikecualikan. Gagal membentuk salah satu artefak membuat analisis `FAILED`; artefak internal parsial tidak disajikan sebagai hasil selesai.

Kegagalan ekspor setelah hasil tersedia hanya memengaruhi export job. Graph dan ADD yang telah selesai tetap dapat dibuka. Satu format aktif pada toolbar dokumen menonaktifkan permintaan format lain pada toolbar yang sama sesuai alur mockup.

Diagram statis merupakan proyeksi dari canonical graph. Renderer SVG dan representasi Markdown dipilih pada spike, dengan Mermaid sebagai kandidat awal; pilihan renderer tidak menentukan fakta atau resolusi relasi.

## Batas keamanan pemrosesan

- Terima URL GitHub HTTPS yang dinormalisasi; jangan memperlakukan URL pengguna sebagai tujuan fetch bebas.
- Pengambilan archive/redirect hanya melalui host GitHub yang diizinkan oleh implementasi.
- Terapkan batas file, byte terkompresi/terekstrak, timeout, path traversal, symlink, dan rasio ekstraksi.
- Jangan menjalankan source target, install script, package manager target, konfigurasi executable, atau plugin compiler project target.
- `.git`, dependency vendored, binary, hasil build, dan submodule tidak dipindai secara rekursif; pengecualian dicatat.
- Source, komentar, label graph, dan diagram di-escape sebagai data; halaman cetak tidak dapat menjalankan HTML/JS dari repository.
- Semua endpoint hasil, source, export, dan delete memeriksa pemilik; opaque ID tidak menggantikan otorisasi.

## Struktur aplikasi yang direncanakan

```text
apps/web/                 UI dan route API
apps/worker/              orchestration, queue, pipeline, export
packages/contracts/       tipe payload, CCM, graph, dan dokumen
packages/analyzer-js/     adapter JavaScript/TypeScript
packages/analyzer-php/    adapter PHP dan program parser tepercaya
packages/documents/       proyeksi artefak dan template cetak
tests/fixtures/           source uji kecil dengan oracle yang direview
tests/e2e/                alur aplikasi dan ekspor
```

Workspace web/worker/database, parser probe, renderer probe, serta tests/fixtures sudah dibuat. packages/contracts masih berupa batas modul; contracts CCM dan struktur E2E produk mengikuti issue berikutnya.
