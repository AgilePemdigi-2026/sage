# Model data dan lifecycle

Status: rancangan persistensi PostgreSQL/Prisma; belum ada schema ORM atau migrasi yang dijalankan.

## Entitas

Model ini memperinci empat entitas konseptual pada SRS agar queue, source evidence, dan ekspor dapat dikelola. Nama fisik serta indeks dipastikan saat DATA-01; hubungan dan invariannya menjadi kontrak awal.

| Entitas | Field utama dan hubungan |
| --- | --- |
| `User` | ID internal, `githubUserId` unik, login/display name, timestamps |
| `Session` | Hash token session, `userId`, expiry, revocation; cookie tidak menyimpan GitHub token |
| `GitHubConnection` | `userId`, identitas user GitHub, token terenkripsi, expiry/refresh metadata, status koneksi |
| `GitHubInstallation` | ID instalasi, account, status, permission metadata; relasi akses pengguna divalidasi kembali |
| `Repository` | ID internal, GitHub repository ID unik, owner/name, visibility; bukan bukti bahwa semua user boleh mengaksesnya |
| `Analysis` | `ownerUserId`, `repositoryId`, branch, full SHA, config/schema/analyzer versions, status, retry parent, timestamps, error code, result hash |
| `Job` | Type `ANALYSIS`/`EXPORT`/`CLEANUP`, pemilik, target ID, status, enqueue/start/end, lease/heartbeat, attempt metadata |
| `AnalysisStage` | `analysisId`, sequence 1-9, key, status, timestamps, error code; unik per analysis/key |
| `SourceFile` | `analysisId`, path, language, byte length, SHA-256, processing status, storage reference |
| `AnalysisLimitation` | `analysisId`, path opsional, stage, code, penjelasan aman, jumlah bagian terdampak |
| `GraphBundle` | Satu per analysis, schema/config hash, canonical nodes/edges, counts, content hash |
| `ArchitectureDocument` | Maksimal satu per analysis, title, versi document model, tiga artefak terstruktur, content hash, generated timestamp |
| `Export` | Pemilik/analysis/document, format, versi renderer, status, storage reference, content hash, error code |
| `StorageObject` | Pemilik/analysis, jenis objek, opaque storage key, hash, ukuran, status penghapusan |
| `WorkerSlot` | Global slot/lease untuk menjamin maksimal satu analysis job aktif |

`GraphBundle` dapat memakai JSONB dengan schema validation untuk MVP. Pemisahan ke tabel node/edge dilakukan bila benchmark membuktikan kebutuhan; keberadaan Code Knowledge Graph tidak mewajibkan graph database.

## Invarian

- Setiap analysis memiliki tepat satu pemilik dan satu target full SHA yang tidak berubah.
- Repository yang sama dapat dianalisis oleh beberapa user; result bundle milik user lain tidak dapat dibuka hanya karena repository-nya publik.
- Satu analysis memiliki sembilan stage yang urutannya tetap.
- Maksimal satu analysis berstatus `RUNNING` secara global, dijaga mekanisme lock/lease database yang diuji.
- `COMPLETED` dan `COMPLETED_WITH_LIMITATIONS` memiliki graph serta dokumen lengkap dengan hash yang konsisten.
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

Session dan koneksi GitHub tidak disimpan di tabel User sebagai token plaintext. Rancangan awal memakai authenticated encryption dengan key di environment server, terpisah dari database. Detail algoritme, rotasi key, dan masa berlaku session ditutup pada GH-01/DATA-01 sebelum implementasi autentikasi dinyatakan selesai.

Izin diperiksa saat target diajukan dan saat worker mengambil snapshot. Token berakhir atau App dicabut menghasilkan status koneksi tidak valid dan error yang dapat ditindaklanjuti. Retensi hasil sampai dihapus tidak berarti token kedaluwarsa disimpan atau dipakai selamanya.

## Storage dan isolasi

Key storage dibuat oleh aplikasi berdasarkan owner/analysis/object ID; path mentah tidak diterima dari browser. Database menyimpan metadata, sedangkan source archive dan export berada di persistent volume. Root storage tidak dipublikasikan sebagai static directory.

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

## Hal yang harus dibuktikan pada implementasi

Migrasi database bersih, unique/FK constraints, isolasi user, claim job konkuren, restart recovery, penulisan bundle atomik, idempotensi export, dan cleanup harus memiliki hasil pengujian. Model ini belum memberikan bukti bahwa mekanisme tersebut telah berfungsi.
