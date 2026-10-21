# Model data dan lifecycle

Status per 21 Oktober 2026: DATA-01 menyediakan schema PostgreSQL, helper session/kredensial, query owner-scoped, dan pemeriksaan integrasi/persistensi. GH-01/02 menyediakan autentikasi dan akses repository nyata; REP-01/02 menyediakan validasi target, submission idempotent, snapshot immutable, serta source handlers. ANA-01 menyediakan queue durable dan runner stage terbatas sudah memiliki slice teruji. Consumer analisis produk masih nonaktif (`workerQueueEnabled=false`); history, graph dan dokumen membaca hasil tersimpan yang sukses. Ekspor dan cleanup lifecycle masih mengikuti issue terbuka.

## Entitas

Model ini memperinci empat entitas konseptual pada SRS agar queue, source evidence, dan ekspor dapat dikelola. Nama fisik serta indeks dipastikan saat DATA-01; hubungan dan invariannya menjadi kontrak awal.

| Entitas | Field utama dan hubungan |
| --- | --- |
| `User` | ID internal, `githubUserId` unik, login/display name, timestamps |
| `Session` | Hash SHA-256 token session, `userId`, expiry, revocation; token mentah hanya dikembalikan saat dibuat dan tidak disimpan |
| `GitHubConnection` | `userId`, identitas GitHub, ciphertext AES-256-GCM, nonce, authentication tag, key ID, expiry, revocation, status |
| `GitHubInstallation` | `ownerUserId`, ID instalasi, account, status, permission metadata; akses instalasi tetap harus divalidasi oleh integrasi GitHub |
| `Repository` | ID GitHub unik, owner/name, visibility; record global dapat dipakai beberapa user dan tidak memberi hak baca hasil analysis |
| `Analysis` | `ownerUserId`, `repositoryId`, branch, full SHA, config/schema/analyzer versions, status, retry parent, timestamps, error code, result hash |
| `Job` | Type `ANALYSIS`/`EXPORT`/`CLEANUP`, pemilik, relasi analysis/export opsional, status, enqueue/start/end, lease/heartbeat, attempt metadata, dan FIFO `queueSequence` untuk analysis |
| `AnalysisStage` | `ownerUserId`, `analysisId`, sequence/key, status, timestamps, error code; unik per analysis/sequence dan analysis/key |
| `SourceFile` | Pemilik/analysis, path, language, byte length, SHA-256, processing status, relasi storage opsional |
| `AnalysisLimitation` | Pemilik/analysis, path opsional, stage, code, penjelasan aman, jumlah bagian terdampak |
| `GraphBundle` | Satu per analysis, pemilik, schema/config hash, canonical nodes/edges JSON, counts, content hash |
| `ArchitectureDocument` | Maksimal satu per analysis, title, versi model, `interfaceCatalog`, `softwareEngineeringDiagram`, `umlClassDiagram` sebagai mirror string JSON canonical, `canonicalContent`, content hash, generated timestamp |
| `Export` | Pemilik/analysis/document, format, versi renderer, status, storage reference, content hash, error code |
| `StorageObject` | Pemilik/analysis, jenis objek, opaque storage key unik, hash, ukuran, status penghapusan |
| `WorkerSlot` | Slot global `analysis`, relasi job/pemilik, lease/heartbeat, hash token lease, dan counter FIFO; row lock menserialkan enqueue/claim/renew/fail |

`GraphBundle` dapat memakai JSONB dengan schema validation untuk MVP. Pemisahan ke tabel node/edge dilakukan bila benchmark membuktikan kebutuhan; keberadaan Code Knowledge Graph tidak mewajibkan graph database.

## Invarian

- Setiap analysis memiliki tepat satu pemilik dan satu target full SHA yang tidak berubah.
- Repository yang sama dapat dianalisis oleh beberapa user; result bundle milik user lain tidak dapat dibuka hanya karena repository-nya publik.
- Pipeline nantinya membuat sembilan stage berurutan; schema saat ini menyimpan stage dan membatasi sequence/key duplikat, tetapi belum menegakkan jumlah sembilan.
- ANA-01 menegakkan maksimal satu analysis dan satu ANALYSIS Job `RUNNING` lewat partial unique index PostgreSQL serta claim atomik pada slot tetap. Lease mengikuti waktu database; recovery menandai percobaan interrupted sebagai gagal. Detail ada di [ANA-01](ANA-01_CHECKS.md).
- Kelengkapan graph/document untuk status terminal divalidasi oleh worker/pipeline yang belum tersedia.
- Dokumen maksimal satu per analysis; varian PDF/Markdown disimpan sebagai export terpisah dari dokumen logis.
- Retry adalah analysis baru dengan target/config salinan dan FK parent; bukan overwrite hasil percobaan sebelumnya.
- Bahasa disimpan sebagai koleksi terstruktur; UI tidak mem-parsing string seperti `TypeScript; Python excluded` untuk menentukan kemampuan analyzer.
- Full SHA disimpan untuk identitas. SHA pendek hanya untuk tampilan, pencarian dapat menerima prefix yang tidak ambigu.
- Semua penyimpanan waktu menggunakan UTC; UI mengonversi sesuai zona tampilan.

## Status

| Objek | Enum API/internal |
| --- | --- |
| Analysis | `QUEUED`, `RUNNING`, `COMPLETED`, `COMPLETED_WITH_LIMITATIONS`, `FAILED` |
| AnalysisStage | `PENDING`, `RUNNING`, `COMPLETED`, `FAILED` |
| Job | `QUEUED`, `RUNNING`, `COMPLETED`, `FAILED` |
| Export | `QUEUED`, `GENERATING`, `READY`, `FAILED` |
| StorageObject | `ACTIVE`, `DELETION_PENDING`, `DELETED` |

Label UI berbahasa Indonesia dipisahkan dari enum kontrak. Format export `MARKDOWN` atau `PDF`. Enum error memakai kode stabil dan pesan aman, bukan stack trace atau kredensial.

## Akses dan kredensial

Session dibuat dari 32 byte acak dan token base64url mentah hanya dikembalikan sekali. Database menyimpan SHA-256 token; resolver server hanya menerima session yang belum kedaluwarsa dan belum dicabut, lalu mengembalikan `userId` untuk query pemilik. Masa default session adalah 30 hari dan pemanggil dapat memberi TTL eksplisit.

Kredensial GitHub dienkripsi dengan AES-256-GCM, nonce acak 12 byte, dan tag 16 byte. `CREDENTIAL_ENCRYPTION_KEY` harus berupa base64 kanonis yang mewakili tepat 32 byte. AAD mengikat format, `userId`, konteks record, dan key ID sehingga ciphertext tidak dapat dipindah ke user/koneksi lain tanpa gagal autentikasi. Key ID berasal dari SHA-256 key; bila konfigurasi key tidak ada/salah atau ciphertext dimodifikasi, operasi ditolak dengan error aman.

Key diambil dari environment proses web/worker dan tidak diberikan ke container database. Rotasi multi-key belum diimplementasikan: selama rotasi, operator harus mempertahankan key lama dan melakukan proses decrypt/re-encrypt terkontrol sebelum mengganti key aktif. Jika key lama hilang, kredensial lama tidak dapat dipulihkan. Route GitHub nyata memakai helper kredensial melalui session server; token dibaca dari koneksi pemilik yang tervalidasi dan tetap tunduk pada expiry/revocation.

Koneksi pertama memakai `storeGitHubCredential`; refresh atau reconnect memakai `replaceGitHubCredential` dengan ID koneksi yang sama. Replacement dibatasi pemilik, mengaktifkan kembali koneksi, menghapus revocation, dan mengganti expiry secara eksplisit. Callback OAuth tetap harus memilih operasi yang sesuai.

Helper `find*ForUser` selalu memasukkan user yang dipercaya server ke predicate SQL. Relasi analysis-child memakai foreign key komposit `(analysisId, ownerUserId)`; relasi storage source/export mengikat analysis dan owner sekaligus. Repository global boleh dibagi, sedangkan baris hasil dan kredensial tetap owner-scoped. `POST /api/analyses` mengambil pemilik dari session server dan tidak mempercayai `userId` request. History membaca melalui `listAnalysesForUser` dan `getAnalysisDetailForUser` yang mengikuti konvensi `find*ForUser` (predicate `ownerUserId`); graph dan dokumen memakai reader canonical dengan validasi snapshot serta owner/status; export dan delete tetap mengikuti issue produknya.

Izin GitHub diperiksa saat repository diajukan dan saat snapshot immutable diambil; bukti per slice ada pada [GH-02](GH-02_CHECKS.md) dan [REP-02](REP-02_CHECKS.md). Helper pembacaan server tidak mengembalikan token jika status bukan `ACTIVE`, token kedaluwarsa, atau koneksi dicabut. Consumer analisis penuh masih dimatikan, sehingga jalur worker end-to-end tetap menunggu ANA-07 #16.

## Storage dan isolasi

Key storage dibuat oleh aplikasi berdasarkan owner/analysis/object ID; path mentah tidak diterima dari browser. Database menyimpan metadata, sedangkan snapshot source disimpan pada persistent volume dan dilayani melalui source handlers berotorisasi. Root storage tidak dipublikasikan sebagai static directory. Lifecycle cleanup terkoordinasi masih menunggu #23; ekspor produk belum tersedia.

Source handlers membaca file dari snapshot melalui identitas file dan pemeriksaan pemilik. Ini menyediakan data untuk pemanggil tepercaya; graph inspector/source-preview sebagai fitur produk masih menunggu GRAPH-03 #19. File yang tidak diproses dapat dicatat sebagai metadata limitation tanpa menyimpan potongan source yang tidak diperlukan. Data private tidak digunakan sebagai fixture yang di-commit.

## Retensi dan penghapusan

Hasil, snapshot yang diperlukan untuk evidence, dan export disimpan sampai pemilik menghapus analisis. Cakupan penghapusan adalah analysis, stage, graph, dokumen, export, metadata file, dan seluruh storage object terkait. Session/token tetap tunduk pada expiry serta revocation.

Rancangan awal penghapusan:

1. Verifikasi session dan pemilik.
2. Jika analysis sedang `QUEUED` atau `RUNNING`, kembalikan `409 ANALYSIS_ACTIVE`; pengguna dapat menghapus setelah terminal. Pembatalan job interaktif bukan fitur baseline.
3. Jika export terkait masih aktif, kembalikan `409 EXPORT_ACTIVE` agar proses tidak menulis objek yang sudah dihapus.
4. Tandai record untuk penghapusan dan segera hilangkan akses baca/download.
5. Hapus objek volume secara idempotent, lalu hapus record turunan dalam urutan transaksi yang aman.
6. Jika penghapusan storage gagal, simpan status pending agar cleanup dapat diulang; jangan menyatakan penghapusan selesai sebelum seluruh objek tersingkir.

API mengembalikan `202` saat cleanup masih berjalan dan `204` setelah benar-benar selesai. Queue cleanup diproses secara aman meskipun worker restart. Penghapusan parent retry tidak menghapus percobaan baru; FK retry di-null-kan agar tidak memblokir penghapusan.

Kebijakan backup produksi belum ditentukan dosen. Jangan menjanjikan penghapusan backup eksternal sebelum kebijakan tersebut tersedia. Pada MVP lokal, backup manual dan volume yang disalin pengguna harus dijelaskan pada panduan operasional.

## Provenance dan replay

Simpan full SHA, hash snapshot/file, versi parser/resolver/schema, config hash, exclusion rules, dan hash canonical graph/document. Replay membandingkan canonical content dengan ordering tetap; job ID dan waktu eksekusi tidak masuk ke hash fakta.

## Cakupan yang masih menunggu issue lain

- Queue durable, API submission idempotent, dan runner stage terbatas sudah memiliki bukti. Consumer sembilan tahap dan publikasi bundle atomik tetap di ANA-07 #16; `workerQueueEnabled=false` saat ini mencegah job submission diproses sebagai analisis penuh. Retry produk memerlukan pemeriksaan izin baru dan analysis ID baru pada integrasi pipeline.
- DOC-01 #15 memvalidasi dan menyimpan tiga artefak dokumen bersama serta menyediakan API/halaman privat. History #22 menyediakan pembacaan list/detail GET, GRAPH-01 #17 menyediakan graph canonical; query/filter/inspector #18–19 dan ekspor #20–21 tetap terbuka.
- #23 menentukan alur penghapusan analysis dan objek storage secara idempotent.
- Pipeline analisis harus menegakkan kelengkapan graph/document dan hash sebelum menyatakan analysis selesai.

## Canonical CKG ANA-06

`GraphBundle.canonicalContent` menyimpan canonical JSON `sage-ckg-v1` berisi CCM lengkap, fingerprint queue dan counts. Nullable hanya untuk baris legacy. Hash canonical mencakup snapshot, file/evidence, provenance dan limitation; kolom node/edge JSONB menyimpan string JSON canonical agar escaped NUL/lone surrogate tidak ditolak PostgreSQL; reader canonical mengembalikan model decoded. Mirror string tersebut serta count kolom diverifikasi. Penulisan berada di transaksi lease/stage-fenced dan hasil per analysis immutable. Reader canonical memerlukan owner, status terminal berhasil, kesamaan target parent serta validasi source/hash/mirror. Graph draft tidak dipublikasikan lewat reader tersebut; publikasi result bundle lengkap tetap #16. Lihat [verifikasi ANA-06](ANA-06_CHECKS.md).

`Analysis.repositoryFullNameSnapshot` membekukan nama target saat enqueue; stable repository relation, branch dan full SHA tetap dipakai. Context stage dan integritas CKG memakai snapshot ini sehingga rename repository tidak merusak hasil historis. Field nullable menjaga baris legacy; saat pertama diinisialisasi, worker menangkap nama terkini satu kali tanpa mengklaim rekonstruksi nama historis yang belum pernah disimpan.

## Canonical ADD DOC-01

`ArchitectureDocument.canonicalContent` menyimpan JSON `sage-add-v1`; nullable hanya untuk legacy yang tidak disajikan sebagai hasil canonical. Ketiga kolom artefak JSONB berisi string JSON canonical agar escaped NUL/lone surrogate dipertahankan. Reader meregenerasi model dari CKG serta source snapshot dan memverifikasi hash, title/version dan semua mirror. Penulisan dilakukan sekali secara transaksional dengan lease/stage fence; replay berbeda ditolak. Model tidak memuat ID record/job atau waktu generate dalam hash. DOC-01 tidak mengubah status Analysis/Job terminal; publikasi graph+document+resultHash bersama merupakan #16. Lihat [bukti DOC-01](DOC-01_CHECKS.md).
