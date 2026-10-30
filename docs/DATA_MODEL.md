# Model data dan lifecycle

Status per 27 Oktober 2026: DATA-01 menyediakan schema PostgreSQL, helper session/kredensial, query owner-scoped, dan pemeriksaan integrasi/persistensi. GH-01/02 menyediakan autentikasi dan akses repository nyata; REP-01/02 menyediakan validasi target, submission idempotent, snapshot immutable, serta source handlers. ANA-01 menyediakan queue durable dan runner stage terbatas sudah memiliki slice teruji. Consumer sembilan tahap dan publikasi bundle atomik tersedia pada ANA-07; history, graph dan dokumen membaca hasil tersimpan yang sukses. Ekspor Markdown/PDF tersedia; DATA-02 menambah penghapusan owner-scoped dengan cleanup durable dan retry.

## Entitas

Model ini memperinci empat entitas konseptual pada SRS agar queue, source evidence, dan ekspor dapat dikelola. Nama fisik serta indeks tersedia pada schema dan migration database.

| Entitas | Field utama dan hubungan |
| --- | --- |
| `User` | ID internal, `githubUserId` unik, login/display name, timestamps |
| `Session` | Hash SHA-256 token session, `userId`, expiry, revocation; token mentah hanya dikembalikan saat dibuat dan tidak disimpan |
| `GitHubConnection` | `userId`, identitas GitHub, ciphertext AES-256-GCM, nonce, authentication tag, key ID, expiry, revocation, status |
| `GitHubInstallation` | `ownerUserId`, ID instalasi, account, status, permission metadata; akses instalasi tetap harus divalidasi oleh integrasi GitHub |
| `Repository` | ID GitHub unik, owner/name, visibility; record global dapat dipakai beberapa user dan tidak memberi hak baca hasil analysis |
| `Analysis` | `ownerUserId`, `repositoryId`, branch, full SHA, config/schema/analyzer versions, status, retry parent, timestamps, error code, result hash, tombstone `deletionRequestedAt` |
| `Job` | Type `ANALYSIS`/`EXPORT`/`CLEANUP`, pemilik, relasi analysis/export opsional, status, enqueue/start/end, lease/heartbeat, attempt metadata, FIFO `queueSequence` untuk analysis, `cleanupAnalysisId`, `cleanupManifest`, serta reservasi path `storageReservations` |
| `AnalysisStage` | `ownerUserId`, `analysisId`, sequence/key, status, timestamps, error code; unik per analysis/sequence dan analysis/key |
| `SourceFile` | Pemilik/analysis, path, language, byte length, SHA-256, processing status, relasi storage opsional |
| `AnalysisLimitation` | Pemilik/analysis, path opsional, stage, code, penjelasan aman, jumlah bagian terdampak |
| `GraphBundle` | Satu per analysis, pemilik, schema/config hash, `storageLayoutVersion`, canonical CKG text, counts, content hash; mirror nodes/edges hanya layout 1 |
| `ArchitectureDocument` | Maksimal satu per analysis, title, versi model, `storageLayoutVersion`, `canonicalContent`, content hash dan timestamps; tiga mirror artefak hanya layout 1 |
| `Export` | Pemilik/analysis/document, format, versi renderer, status, storage reference, content hash, error code |
| `StorageObject` | Pemilik/analysis, jenis objek, opaque storage key unik, hash, ukuran, status penghapusan |
| `WorkerSlot` | Slot global `analysis`, `export`, dan `cleanup`, relasi job/pemilik, lease/heartbeat, hash token lease, dan counter FIFO; row lock menserialkan enqueue/claim/renew/fail |

`GraphBundle` menyimpan canonical text yang divalidasi terhadap sumber; mirror JSONB hanya dipertahankan pada layout lama. Pemisahan ke tabel node/edge dilakukan bila benchmark membuktikan kebutuhan; keberadaan Code Knowledge Graph tidak mewajibkan graph database.

## Invarian

- Setiap analysis memiliki tepat satu pemilik dan satu target full SHA yang tidak berubah.
- Repository yang sama dapat dianalisis oleh beberapa user; result bundle milik user lain tidak dapat dibuka hanya karena repository-nya publik.
- Pipeline membuat sembilan stage berurutan; schema saat ini menyimpan stage dan membatasi sequence/key duplikat, tetapi belum menegakkan jumlah sembilan.
- ANA-01 menegakkan maksimal satu analysis dan satu ANALYSIS Job `RUNNING` lewat partial unique index PostgreSQL serta claim atomik pada slot tetap. Lease mengikuti waktu database; recovery menandai percobaan interrupted sebagai gagal. Detail ada di [ANA-01](ANA-01_CHECKS.md).
- Kelengkapan graph/document untuk status terminal divalidasi oleh worker ANA-07 sebelum publikasi atomik.
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

Helper `find*ForUser` selalu memasukkan user yang dipercaya server ke predicate SQL. Relasi analysis-child memakai foreign key komposit `(analysisId, ownerUserId)`; relasi storage source/export mengikat analysis dan owner sekaligus. Repository global boleh dibagi, sedangkan baris hasil dan kredensial tetap owner-scoped. `POST /api/analyses` mengambil pemilik dari session server dan tidak mempercayai `userId` request. History membaca melalui `listAnalysesForUser` dan `getAnalysisDetailForUser` yang mengikuti konvensi `find*ForUser` (predicate `ownerUserId`); graph dan dokumen memakai reader canonical dengan validasi snapshot serta owner/status; ekspor Markdown/PDF dan penghapusan DATA-02 mengikuti owner-scoped predicate yang sama.

Izin GitHub diperiksa saat repository diajukan dan saat snapshot immutable diambil; bukti per slice ada pada [GH-02](GH-02_CHECKS.md) dan [REP-02](REP-02_CHECKS.md). Helper pembacaan server tidak mengembalikan token jika status bukan `ACTIVE`, token kedaluwarsa, atau koneksi dicabut. Consumer ANA-07 memakai kredensial aktif pada saat snapshot diambil dan mempertahankan full SHA yang dibekukan.

## Storage dan isolasi

Key storage dibuat oleh aplikasi berdasarkan owner/analysis/object ID; path mentah tidak diterima dari browser. Database menyimpan metadata, sedangkan snapshot source disimpan pada persistent volume dan dilayani melalui source handlers berotorisasi. Root storage tidak dipublikasikan sebagai static directory. Ekspor produk dan cleanup DATA-02 memakai metadata storage yang terikat owner/analysis.

Source handlers membaca file dari snapshot melalui identitas file dan pemeriksaan pemilik. Ini menyediakan data untuk pemanggil tepercaya; graph inspector/source-preview tersedia melalui GRAPH-03 #19. File yang tidak diproses dapat dicatat sebagai metadata limitation tanpa menyimpan potongan source yang tidak diperlukan. Data private tidak digunakan sebagai fixture yang di-commit.

## Retensi dan penghapusan

Hasil, snapshot yang diperlukan untuk evidence, dan export disimpan sampai pemilik menghapus analisis. Cakupan penghapusan adalah analysis, stage, graph, dokumen, export, metadata file, dan seluruh storage object terkait. Session/token tetap tunduk pada expiry serta revocation.

Lifecycle penghapusan DATA-02:

1. Verifikasi session dan pemilik.
2. Jika analysis sedang `QUEUED` atau `RUNNING`, kembalikan `409 ANALYSIS_ACTIVE`; pengguna dapat menghapus setelah terminal. Pembatalan job interaktif bukan fitur baseline.
3. Jika export terkait masih aktif, kembalikan `409 EXPORT_ACTIVE` agar proses tidak menulis objek yang sudah dihapus.
4. Tandai record untuk penghapusan dan segera hilangkan akses baca/download.
5. Hapus objek volume secara idempotent, lalu hapus record turunan dalam urutan transaksi yang aman.
6. Jika penghapusan storage gagal, simpan status `FAILED` pada cleanup job dan tampilkan retry di history; jangan menyatakan penghapusan selesai sebelum seluruh objek tersingkir.

API mengembalikan `202` saat cleanup masih berjalan dan `204` setelah benar-benar selesai. Queue cleanup diproses secara aman meskipun worker restart. Penghapusan parent retry tidak menghapus percobaan baru; FK retry di-null-kan agar tidak memblokir penghapusan.

Kebijakan backup produksi belum ditentukan dosen. Jangan menjanjikan penghapusan backup eksternal sebelum kebijakan tersebut tersedia. Pada MVP lokal, backup manual dan volume yang disalin pengguna harus dijelaskan pada panduan operasional.

### Manifest, reservasi, dan pemulihan

Permintaan delete menandai `Analysis.deletionRequestedAt`, mengubah storage menjadi `DELETION_PENDING`, dan menyimpan manifest pada job CLEANUP dalam satu transaksi. History tetap menyajikan status cleanup agar pemilik dapat memantau atau retry setelah reload; pembacaan hasil, source, dokumen, ekspor, serta retry analisis ditutup. Reader file memeriksa ulang tombstone setelah I/O. Respons atau file yang sudah diterima client sebelum penghapusan tidak dapat ditarik kembali.

Worker menghapus file satu per satu secara idempotent, menandai storage `DELETED`, lalu menghapus folder kosong tanpa rekursi. Symlink, path di luar pola aplikasi, serta isi folder yang tidak dikenal ditolak. Worker hanya menerbitkan `COMPLETED` setelah seluruh key manifest terhapus dan transaksi penghapusan turunan berhasil. Lease/token/attempt pada slot cleanup mencegah claim lama menerbitkan status; restart memulihkan claim kedaluwarsa. Retry menggunakan cleanup job yang sama.

Penulis snapshot dan ekspor mereservasi path pada job sebelum menulis byte. Manifest mencakup objek terdaftar dan path reservasi, termasuk file ekspor `.pending`, sehingga kegagalan sebelum registrasi StorageObject tetap dapat dibersihkan. Reservasi dibatasi 32 path per job. File lama yang tidak pernah terdaftar atau terreservasi tidak ditebak kepemilikannya dan tidak disapu otomatis. Analisis dengan key legacy yang tidak dikenal membutuhkan penanganan operator sebelum cleanup dapat selesai.

Sesudah selesai, data analisis beserta stages, source metadata, limitations, graph, dokumen, export, storage metadata, dan job analisis/ekspor dihapus. Retry child tetap ada dengan parent dilepas. Satu tombstone job minimal (`ownerUserId`, target ID, status dan timestamp) dipertahankan untuk status/idempotensi; manifest dan relasi analysis dikosongkan. Akun, session, kredensial, dan metadata repository global tidak ikut dihapus. Tidak ada penghapusan otomatis berdasarkan umur data.

## Provenance dan replay

Simpan full SHA, hash snapshot/file, versi parser/resolver/schema, config hash, exclusion rules, dan hash canonical graph/document. Replay membandingkan canonical content dengan ordering tetap; job ID dan waktu eksekusi tidak masuk ke hash fakta.

## Cakupan yang masih menunggu issue lain

- Queue durable, API submission idempotent, dan runner stage terbatas sudah memiliki bukti. Consumer ANA-07 menjalankan sembilan tahap dan menerbitkan bundle atomik; retry FAILED memerlukan pemeriksaan izin baru serta analysis ID baru dengan SHA/configuration yang sama.
- DOC-01 #15 memvalidasi dan menyimpan tiga artefak dokumen bersama serta menyediakan API/halaman privat. History #22 menyediakan pembacaan list/detail GET, GRAPH-01 #17 menyediakan graph canonical; query/filter/inspector #18–19 tersedia. Ekspor Markdown #20 memiliki bukti terpisah; PDF #21 memiliki bukti terpisah pada [EXP-02_CHECKS](EXP-02_CHECKS.md).
- DATA-02 #23 menyediakan penghapusan analysis dan objek storage secara idempotent; lihat [bukti dan batas cleanup](DATA-02_CHECKS.md).
- Pipeline analisis menegakkan kelengkapan graph/document dan hash sebelum menyatakan analysis selesai.

## Canonical CKG ANA-06

`GraphBundle.canonicalContent` menyimpan canonical JSON `sage-ckg-v1` berisi CCM lengkap, fingerprint queue dan counts. Nullable hanya untuk baris legacy. Hash canonical mencakup snapshot, file/evidence, provenance dan limitation; kolom node/edge JSONB menyimpan string JSON canonical agar escaped NUL/lone surrogate tidak ditolak PostgreSQL; reader canonical mengembalikan model decoded. Layout 1 memverifikasi mirror string tersebut serta count kolom. Layout 2 menyimpan mirror sebagai SQL NULL dan tetap memverifikasi canonical/source/hash/count. Penulisan berada di transaksi lease/stage-fenced dan hasil per analysis immutable. Reader canonical memerlukan owner, status terminal berhasil, kesamaan target parent serta validasi source/hash/mirror. Graph draft tidak dipublikasikan lewat reader tersebut; publikasi result bundle lengkap dilakukan ANA-07. Lihat [verifikasi ANA-06](ANA-06_CHECKS.md).

`Analysis.repositoryFullNameSnapshot` membekukan nama target saat enqueue; stable repository relation, branch dan full SHA tetap dipakai. Context stage dan integritas CKG memakai snapshot ini sehingga rename repository tidak merusak hasil historis. Field nullable menjaga baris legacy; saat pertama diinisialisasi, worker menangkap nama terkini satu kali tanpa mengklaim rekonstruksi nama historis yang belum pernah disimpan.

## Canonical ADD DOC-01

`ArchitectureDocument.canonicalContent` menyimpan JSON `sage-add-v1`; nullable hanya untuk legacy yang tidak disajikan sebagai hasil canonical. Pada layout 1, ketiga kolom artefak JSONB berisi string JSON canonical agar escaped NUL/lone surrogate dipertahankan. Layout 2 menyimpan canonicalContent sekali dengan ketiga mirror sebagai SQL NULL. Reader meregenerasi model dari CKG serta source snapshot dan memverifikasi hash, title/version, serta ketentuan mirror sesuai storageLayoutVersion. Penulisan dilakukan sekali secara transaksional dengan lease/stage fence; replay berbeda ditolak. Model tidak memuat ID record/job atau waktu generate dalam hash. DOC-01 tidak mengubah status Analysis/Job terminal; publikasi graph+document+resultHash bersama dilakukan ANA-07. Lihat [bukti DOC-01](DOC-01_CHECKS.md).

## Ekspor Markdown EXP-01

`Export.documentHash` menyimpan hash ADD yang diminta. Unique key owner/analysis/format/documentHash/rendererVersion mencegah duplikasi permintaan. Export menggunakan Job bertipe EXPORT dan WorkerSlot `export`; lease/token/attempt memagari publikasi serta memulihkan claim kedaluwarsa. Retry FAILED memakai ID ekspor, dokumen dan renderer yang sama dengan job percobaan baru. StorageObject bertipe EXPORT menyimpan SHA-256/ukuran file; source, canonical document serta result hash analisis tetap immutable. File hanya diunduh melalui pemeriksaan pemilik dan checksum, tanpa URL publik permanen.


## Layout penyimpanan PERF-01

GraphBundle dan ArchitectureDocument memiliki storageLayoutVersion: 1 untuk mirror legacy yang wajib cocok dengan canonical, 2 untuk canonical-only dengan mirror SQL NULL. Versi semantic dan content/result hash tetap sama. Migrasi schema tidak otomatis mengubah baris lama; tool audit/apply operator hanya mengonversi analisis terminal yang lolos replay source dan pemeriksaan hash/mirror secara atomik. Batas, prosedur dan bukti ada di [PERF-01_CHECKS](PERF-01_CHECKS.md).


## Model semantik dan revisi tampilan

Per 30 Oktober 2026, `SemanticModel` menyimpan satu JSON canonical per analisis beserta source CKG hash, model hash, versi schema/extractor, dan pemilik. `PresentationRevision` menyimpan overlay label/kelompok append-only dan hash overlay; revisi nol adalah hasil otomatis tanpa row tambahan. Foreign key komposit mencegah relasi lintas pemilik. Revisi terkunci saat koreksi dan enqueue ekspor; versi usang ditolak, bukan menimpa data.

`Export.semanticModelHash` dan `Export.presentationRevision` mem-pin snapshot koreksi. Keduanya null untuk ekspor legacy, atau keduanya valid untuk ekspor semantik. Cache renderer mencakup pin ini. Tidak menyimpan ulang JSON model per revisi, menambah service/database, atau menyalin kredensial ke model. Model dibatasi 24 MiB dan overlay 256 KiB; batas source/worker dan artefak tetap berlaku. Revisi tetap tersimpan hingga analisis dihapus; cascade/cleanup yang sama menghapus model, revisi, snapshot serta ekspornya. Lihat [kontrak semantik](SEMANTIC_ANALYSIS.md).
