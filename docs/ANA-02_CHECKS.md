# ANA-02 — Deteksi bahasa, exclusion, dan batas source

Scope #10 adalah policy source pada snapshot immutable serta handler LANGUAGE_DETECTION dan STATIC_ANALYSIS. Handler memakai adapter deklarasi JS/TS dan PHP yang tersedia, lalu menggabungkan CCM tervalidasi. Resolver lintas file, canonical CKG produk, persistensi hasil akhir dan consumer otomatis tetap mengikuti issue masing-masing, termasuk #16.

## Kontrak implementasi

Policy `sage-source-policy-v1` menerima metadata/checksum dan byte file snapshot, memeriksa integritas lalu mengurutkan path. Ekstensi case-insensitive: JavaScript `.js`, `.mjs`, `.cjs`, `.jsx`; TypeScript `.ts`, `.mts`, `.cts`, `.tsx`; PHP `.php`. Pengenalan ekstensi bukan jaminan semua konstruksi bahasa/framework didukung; capability tetap mengikuti fixture adapter.

| Kondisi | Laporan |
| --- | --- |
| Segmen `.git`, `node_modules`, `vendor`, `dist`, `build`, `coverage`, `.next` | `EXCLUDED_DIRECTORY` |
| Suffix `.min.js`, `.min.mjs`, `.min.cjs` | `MINIFIED_SOURCE` |
| Suffix `.map` | `SOURCE_MAP` |
| Ekstensi lain | `UNSUPPORTED_EXTENSION` |
| Source lebih dari 1.048.576 byte | `SOURCE_FILE_TOO_LARGE` |
| NUL, control byte binary, UTF-8 invalid | `NUL_BYTE`, `BINARY_FILE`, `INVALID_UTF8` |
| `.gitmodules` | `SUBMODULE_METADATA` dan `SUBMODULE_CONTENTS_NOT_INCLUDED` |

Pengecualian nama minified/build adalah policy konservatif, bukan deteksi semua generated code. File biasa yang tidak cocok tetap diparse sebagai data. Tidak ada install dependency, evaluasi konfigurasi/script target, atau fetch URL submodule. Ketiadaan source submodule tanpa metadata tidak dapat dideteksi dari tar saja.

Laporan deteksi berisi path, bahasa, hash, ukuran, status/reason dan hitungan recognized/eligible/excluded per bahasa; byte source tidak ikut laporan. Hasil analisis menambahkan hitungan processed/failed, diagnostic parser dan satu CCM dengan satu file record per path termasuk exclusion. Hash canonical diverifikasi terhadap byte asli; config hash memasukkan policy, batas numerik dan provenance adapter. Evidence tetap memakai byte UTF-8 asli termasuk BOM/CRLF.

Tanpa source eligible: `NO_SUPPORTED_SOURCE`. Semua source eligible gagal parse: `PARSE_FAILED`. Sibling valid tetap diproses; file gagal/excluded dan limitation di luar tahap resolver menghasilkan hasil parsial. Limitation resolver deklarasi tetap tercatat pada CCM; status modul source ini belum menilai penyelesaian resolver lanjutan. Snapshot/checksum invalid: `SNAPSHOT_INVALID`. Runner hanya menerima kode kegagalan tepercaya yang diizinkan; exception lain tetap `STAGE_HANDLER_FAILED`. Kegagalan menghentikan tahap berikutnya.

Config job menyimpan policy dan batas numerik; handler menolak versi tidak dikenal serta limit invalid. Job lama tanpa kedua field memakai default v1 sebesar 1 MiB. Limit lebih rendah diterapkan konsisten pada deteksi dan parsing.

Handler membaca StorageObject milik owner/analysis dari claim dan commit SHA context. Archive diperiksa ulang melalui reader dan parser snapshot; file source tidak ditulis ulang atau dieksekusi. Stage output masih artefak internal runner; UI/progress dan penyimpanan hasil produk memerlukan consumer #16. Deadline archive dan timeout parser PHP tersedia; deadline seluruh analisis tetap perlu integrasi #16. Parser JS sinkron tidak dapat diinterupsi di tengah parse; batas per-file mengurangi input, bukan bukti kapasitas produksi.

## Verifikasi dan batas bukti

Perintah verifikasi:

- `npm run check`: lint, typecheck, test utama dan database.
- `SAGE_SOURCE_TESTS=1 npm run test:source:integration` hanya pada database terisolasi `sage_source10`; fixture integrasi menghapus data uji dan tidak boleh memakai database aplikasi.
- `docker compose build`: image web dan worker.

Fixture terkontrol mencakup campuran JS/TS/PHP, pengecualian dan batas file, tampered snapshot, source tanpa bahasa didukung, sibling syntax invalid, evidence BOM/CRLF, determinisme urutan input dan canary konfigurasi yang tidak dieksekusi. Integrasi memakai PostgreSQL serta arsip fixture, bukan repository GitHub baru; akses/download GitHub nyata telah diuji terpisah pada REP-02.

Hasil aktual pemeriksaan 19 Oktober 2026: lint/typecheck lulus, 165 test utama dan 8 test database lulus. Satu test integrasi PostgreSQL lulus dengan empat skenario persisten dan dua pemeriksaan policy berikut:

| Fixture / expected | Actual |
| --- | --- |
| Snapshot tersimpan berisi JS/PHP → kedua bahasa diproses, owner lain ditolak | Lulus; CCM memuat deklarasi kedua bahasa |
| Hanya dokumentasi/config → `NO_SUPPORTED_SOURCE`, downstream tetap PENDING | Lulus; Analysis dan stage menyimpan kode tersebut |
| Semua source syntax invalid → `PARSE_FAILED`, downstream tetap PENDING | Lulus; Analysis dan stage menyimpan kode tersebut |
| Exception internal arbitrary → `STAGE_HANDLER_FAILED`, pesan mentah tidak dipersistenkan | Lulus |
| Limit job diturunkan → handler deteksi menolak source di atas batas | Lulus |
| Versi policy job tidak dikenal → `SNAPSHOT_INVALID` | Lulus |

Regresi parser PHP memakai child shim tepercaya yang tetap aktif setelah stdin selesai; abort menghasilkan SIGTERM dan hanya satu parser diluncurkan. Suite adapter PHP lulus 9/9, termasuk regresi tersebut. Fixture default 1 MiB menerima ukuran tepat batas dan menolak satu byte di atasnya. Tidak ada source private atau credential pada fixture/laporan repository.

Build produksi Docker web dan worker lulus, termasuk pemeriksaan ulang pada stage build. Kedua service direkreasi dari image akhir; web, worker dan database sehat. Smoke runtime lulus 16 pemeriksaan (termasuk PHP dan Chromium/PDF). Checksum empat modul worker/adapter yang berubah cocok dengan checkout. Smoke adalah pemeriksaan fondasi runtime; consumer analisis otomatis tetap belum diaktifkan oleh scope ini.
