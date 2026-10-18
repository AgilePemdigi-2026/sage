# Model data dan lifecycle

Status: DATA-01 menambahkan schema dan migrasi PostgreSQL untuk entitas produk di bawah, helper session/kredensial, query yang selalu membatasi pemilik, serta integration dan persistence checks. Ini belum menyediakan login/OAuth HTTP, pipeline analisis, claim queue, ataupun cleanup lifecycle.

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
| `Job` | Type `ANALYSIS`/`EXPORT`/`CLEANUP`, pemilik, relasi analysis/export opsional, status, enqueue/start/end, lease/heartbeat, attempt metadata |
| `AnalysisStage` | `ownerUserId`, `analysisId`, sequence/key, status, timestamps, error code; unik per analysis/sequence dan analysis/key |
| `SourceFile` | Pemilik/analysis, path, language, byte length, SHA-256, processing status, relasi storage opsional |
| `AnalysisLimitation` | Pemilik/analysis, path opsional, stage, code, penjelasan aman, jumlah bagian terdampak |
| `GraphBundle` | Satu per analysis, pemilik, schema/config hash, canonical nodes/edges JSON, counts, content hash |
| `ArchitectureDocument` | Maksimal satu per analysis, title, versi model, `interfaceCatalog`, `softwareEngineeringDiagram`, `umlClassDiagram` sebagai JSON, content hash, generated timestamp |
| `Export` | Pemilik/analysis/document, format, versi renderer, status, storage reference, content hash, error code |
| `StorageObject` | Pemilik/analysis, jenis objek, opaque storage key unik, hash, ukuran, status penghapusan |
| `WorkerSlot` | Baris slot global dan lease untuk integrasi worker mendatang; model ini belum mengimplementasikan lock/claim |

`GraphBundle` dapat memakai JSONB dengan schema validation untuk MVP. Pemisahan ke tabel node/edge dilakukan bila benchmark membuktikan kebutuhan; keberadaan Code Knowledge Graph tidak mewajibkan graph database.

## Invarian

- Setiap analysis memiliki tepat satu pemilik dan satu target full SHA yang tidak berubah.
- Repository yang sama dapat dianalisis oleh beberapa user; result bundle milik user lain tidak dapat dibuka hanya karena repository-nya publik.
- Pipeline nantinya membuat sembilan stage berurutan; schema saat ini menyimpan stage dan membatasi sequence/key duplikat, tetapi belum menegakkan jumlah sembilan.
- `WorkerSlot` hanya menyediakan bentuk data. Aturan maksimal satu analysis `RUNNING`, claim atomik, dan recovery lease menunggu #9.
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

Key diambil dari environment proses web/worker dan tidak diberikan ke container database. Rotasi multi-key belum diimplementasikan: selama rotasi, operator harus mempertahankan key lama dan melakukan proses decrypt/re-encrypt terkontrol sebelum mengganti key aktif. Jika key lama hilang, kredensial lama tidak dapat dipulihkan. Belum ada route login/OAuth yang memakai helper ini; pembacaan token tetap harus berasal dari koneksi milik session tepercaya dan tetap memeriksa expiry/revocation.

Koneksi pertama memakai `storeGitHubCredential`; refresh atau reconnect memakai `replaceGitHubCredential` dengan ID koneksi yang sama. Replacement dibatasi pemilik, mengaktifkan kembali koneksi, menghapus revocation, dan mengganti expiry secara eksplisit. Callback OAuth tetap harus memilih operasi yang sesuai.

Helper `find*ForUser` selalu memasukkan user yang dipercaya server ke predicate SQL. Relasi analysis-child memakai foreign key komposit `(analysisId, ownerUserId)`; relasi storage source/export mengikat analysis dan owner sekaligus. Repository global boleh dibagi, sedangkan baris hasil dan kredensial tetap owner-scoped. Route HTTP belum ada dan wajib meneruskan `userId` hasil resolver session, bukan nilai dari request.

Pada alur target/worker mendatang, izin GitHub tetap harus diperiksa saat repository diajukan dan saat snapshot diambil. Helper pembacaan server saat ini tidak mengembalikan token jika status bukan `ACTIVE`, token kedaluwarsa, atau koneksi dicabut; pemeriksaan status GitHub App dan error yang dapat ditindaklanjuti menunggu integrasi GH-01.

## Storage dan isolasi

Key storage dibuat oleh aplikasi berdasarkan owner/analysis/object ID; path mentah tidak diterima dari browser. Database menyimpan metadata, sedangkan source archive dan export berada di persistent volume. Root storage tidak dipublikasikan sebagai static directory. DATA-01 hanya menyediakan metadata/relasi `StorageObject`; proses penulisan, pembacaan file, dan cleanup storage masih menunggu pipeline serta #23.

Source preview membaca file dari snapshot melalui file ID dan pemeriksaan pemilik. File yang tidak diproses dapat dicatat sebagai metadata limitation tanpa menyimpan potongan source yang tidak diperlukan. Data private tidak digunakan sebagai fixture yang di-commit.

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

- #5 menambahkan login dan integrasi GitHub HTTP yang memakai resolver session serta helper kredensial ini.
- #9 menentukan claim queue atomik, batas worker global, retry, dan recovery lease.
- #23 menentukan alur penghapusan analysis dan objek storage secara idempotent.
- DOC-01 memvalidasi tiga artefak dokumen; kolom JSON saat ini menyimpan struktur dan belum menjamin validitas kontennya.
- Pipeline analisis harus menegakkan kelengkapan graph/document dan hash sebelum menyatakan analysis selesai.
