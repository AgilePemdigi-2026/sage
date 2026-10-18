# Kontrak API

Status: endpoint produk `v1` masih rancangan dan belum tersedia. Fondasi ENV-01 menyediakan `GET /api/health`: HTTP 200 ketika koneksi database tersedia, atau HTTP 503 dengan status `unavailable` tanpa detail error internal. Health check tidak memerlukan session dan tidak menyediakan data pengguna. Root rencana produk adalah `/api`; ID opaque tidak menggantikan pemeriksaan session/pemilik.

## Aturan umum

- Payload JSON memakai UTF-8 dan camelCase; waktu ISO 8601 UTC.
- Seluruh endpoint produk memerlukan session GitHub, kecuali login/callback dan health check minimal.
- Mutation memvalidasi origin/CSRF; callback GitHub memvalidasi state sekali pakai.
- Owner analysis/job/export diperoleh dari session, bukan field `userId` yang dikirim klien.
- Data normal dikembalikan dalam `{ "data": ... }`; pagination menambahkan `nextCursor` yang opaque.
- Error berbentuk `{ "error": { "code": "...", "message": "...", "details": {} }, "requestId": "..." }`.
- `details` hanya memuat field validasi atau konteks aman; token, raw stack trace, absolute server path, dan source private tidak masuk error/log publik.
- Full SHA, schema/config version, dan result hash dipertahankan di seluruh endpoint hasil.
- Request panjang membuat job dan mengembalikan `202`; request HTTP tidak menunggu parsing selesai.

## Session dan GitHub

| Method | Endpoint | Perilaku |
| --- | --- | --- |
| GET | `/auth/github` | Membuat state login lalu redirect ke GitHub |
| GET | `/auth/github/callback` | Memvalidasi state/code, menukar kredensial server-side, membuat session, lalu redirect ke UI |
| GET | `/auth/github/install` | Memulai pemilihan/instalasi GitHub App bila diperlukan untuk private repository |
| GET | `/auth/github/setup` | Memvalidasi konteks instalasi dan menghubungkannya ke user yang berhak |
| GET | `/session` | Identitas pengguna, status koneksi, dan instalasi yang dapat dipilih; tanpa token |
| POST | `/auth/logout` | Mencabut session lokal dan menghapus cookie |

Exact redirect URI dan konfigurasi GitHub App ditutup pada GH-01. Login pengguna dan instalasi App adalah proses yang berbeda. Callback yang gagal/ditolak kembali ke landing dengan kode pesan aman dan aksi coba lagi; state tidak dapat digunakan ulang.

## Repository dan target

| Method | Endpoint | Input dan hasil |
| --- | --- | --- |
| GET | `/repositories` | `query`, `cursor`; daftar repository yang diizinkan melalui instalasi App |
| POST | `/repositories/resolve` | `{ "repository": "owner/name atau URL GitHub" }`; memvalidasi repository publik pihak lain atau private berizin |
| GET | `/repositories/{repositoryId}/branches` | Daftar branch, default branch, cursor, dan error retryable |
| POST | `/analyses` | Membuat target immutable dan analysis job terantre |

Daftar terotorisasi dan input publik adalah dua jalur UI yang terlihat jelas. Resolve slug/URL tidak menambah izin private dan tidak menerima host arbitrary. Branch dibaca dari repository, bukan daftar hardcoded dari mockup.

Rancangan request analisis:

```json
{
  "repositoryId": "repo-example",
  "branch": "main",
  "commit": null
}
```

Nilai ID di atas hanya ilustrasi. `commit` dapat kosong atau berupa SHA/prefix yang valid dan tidak ambigu. Validasi harus memastikan commit berada dalam history branch terpilih sesuai kebijakan target awal; jika berbeda, kembalikan error target dan minta pengguna memperbaikinya.

Sebelum response `202`, server resolve target ke full SHA dan menyimpan analysis ID, pemilik, branch, versi config, serta urutan antrean. Worker memeriksa izin kembali dan mengambil snapshot SHA yang sama. Kegagalan validasi tidak membuat record analisis yang seolah sudah berjalan.

Header `Idempotency-Key` digunakan untuk mencegah double-submit. Scope key adalah user dan operasi; key yang sama dengan payload berbeda menghasilkan `409 IDEMPOTENCY_CONFLICT`. Analisis kedua yang valid mengantre, bukan berjalan bersamaan atau mengganti target sebelumnya.

## Analysis dan progress

| Method | Endpoint | Hasil |
| --- | --- | --- |
| GET | `/analyses` | History milik user; filter `query`, `status`, dan cursor |
| GET | `/analyses/{analysisId}` | Context, full SHA, status, antrean, sembilan stage, limitations, serta link hasil jika tersedia |
| POST | `/analyses/{analysisId}/retry` | Analysis baru dengan full SHA/config yang sama dan `retryOfAnalysisId` |
| DELETE | `/analyses/{analysisId}` | Penghapusan data terminal milik user; `202` selama cleanup atau `204` setelah selesai |
| GET | `/jobs/{jobId}` | Status job milik user, termasuk cleanup/export yang masih diproses |

Enum analysis: `QUEUED`, `RUNNING`, `COMPLETED`, `COMPLETED_WITH_LIMITATIONS`, `FAILED`. Enum stage: `PENDING`, `RUNNING`, `COMPLETED`, `FAILED`.

Response progress menyertakan `updatedAt` dan `stateVersion` monoton untuk menghindari pembaruan UI yang mundur. UI tidak membuat persentase/ETA dari jumlah stage. Jika stage gagal, stage berikutnya tetap pending dan link hasil tetap tidak tersedia.

Retry hanya diterima untuk analysis `FAILED`; pemilik yang ingin mengulang hasil sukses membuat analysis baru dari target yang dipilih. Retry selalu menjalankan validasi izin dan tidak mengubah record lama.

Delete analysis queued/running menghasilkan `409 ANALYSIS_ACTIVE`; delete dengan export aktif menghasilkan `409 EXPORT_ACTIVE`. Setelah cleanup dimulai, hasil dan file tidak dapat dibaca lagi meskipun penghapusan volume masih retry. Perilaku lifecycle lengkap mengikuti [model data](DATA_MODEL.md).

## Graph, inspector, dan source

| Method | Endpoint | Parameter/hasil |
| --- | --- | --- |
| GET | `/analyses/{analysisId}/graph` | `mode=focus\|overview\|all-references`, `nodeId`, `query`, daftar `categories`, cursor/limit |
| GET | `/analyses/{analysisId}/nodes/{nodeId}` | Node, location/bounds, incoming/outgoing summary, evidence, limitations |
| GET | `/analyses/{analysisId}/nodes/{nodeId}/relations` | `direction=incoming\|outgoing`, cursor/limit; edge asli dan evidence |
| GET | `/analyses/{analysisId}/files/{fileId}/source` | Source snapshot, hash, line range yang diminta dan bounds highlight |
| GET | `/analyses/{analysisId}/document` | Document model dan tiga artefak dari result bundle yang sama |

Response graph memisahkan `canonicalCounts`, `filteredCounts`, node/edge yang dikembalikan, serta tanda hasil yang dipaginasi. Jangan menyatakan satu halaman graph sebagai graph lengkap. Focus menyertakan context nodes dengan penanda ketika tidak termasuk hit query/filter.

Categories memakai registry dari kontrak analisis; query dan category digabung AND. Empty result adalah `200` dengan koleksi kosong dan metadata, bukan `404`. Source hanya menerima file ID milik analisis, bukan arbitrary path/URL; snippet berasal dari hash snapshot yang sama.

Hasil graph/document baru tersedia pada `COMPLETED` atau `COMPLETED_WITH_LIMITATIONS`. Akses sebelum selesai menghasilkan `409 RESULT_NOT_READY` dengan link progress milik user. Node/file yang tidak tersedia menghasilkan `404` dan UI menyediakan state yang sesuai.

## Ekspor

| Method | Endpoint | Perilaku |
| --- | --- | --- |
| POST | `/analyses/{analysisId}/exports` | `{ "format": "PDF" }`, dengan format `PDF` atau `MARKDOWN`; menghasilkan job atau mengembalikan export versi yang sama |
| GET | `/analyses/{analysisId}/exports/{exportId}` | Status `QUEUED`, `GENERATING`, `READY`, `FAILED`; metadata tanpa storage path |
| GET | `/analyses/{analysisId}/exports/{exportId}/download` | Stream file ready sesudah pemeriksaan pemilik |
| POST | `/analyses/{analysisId}/exports/{exportId}/retry` | Mengantrekan percobaan baru untuk export gagal dari document hash yang sama |

Satu request aktif per analysis/format/document hash dideduplikasi. `READY` hanya disimpan sesudah file selesai ditulis, dapat dibaca, dan memiliki checksum. Download sebelum ready menghasilkan `409 EXPORT_NOT_READY`. Kegagalan export tidak mengubah status hasil analisis.

Filename: `sage-{repository-slug}-{short-sha}.md` atau `.pdf`; slug di-sanitize. Respons download memakai content type yang sesuai, attachment filename, dan kebijakan cache private. Tidak mengembalikan permanent public URL untuk snapshot atau file private.

## Kode error minimum

| HTTP | Kode | Arti/aksi UI |
| --- | --- | --- |
| 401 | `AUTH_REQUIRED`, `SESSION_EXPIRED` | Login ulang |
| 403 | `GITHUB_PERMISSION_DENIED` | Perbaiki izin GitHub yang diperlukan |
| 404 | `RESOURCE_NOT_FOUND` | Resource tidak ada atau hasil user lain tidak dapat dibuka |
| 422 | `INVALID_REPOSITORY`, `INVALID_BRANCH`, `INVALID_COMMIT` | Perbaiki target sebelum submission |
| 409 | `RESULT_NOT_READY`, `ANALYSIS_ACTIVE`, `EXPORT_ACTIVE` | Buka progress atau tunggu job terminal |
| 409 | `IDEMPOTENCY_CONFLICT`, `EXPORT_NOT_READY` | Perbaiki request atau tunggu |
| 429 | `GITHUB_RATE_LIMITED` | Informasi retry setelah waktu yang tersedia dari GitHub |
| 413 | `REPOSITORY_LIMIT_EXCEEDED` | Jelaskan batas yang benar-benar dilampaui |
| 502/503 | `GITHUB_UNAVAILABLE` | Coba lagi tanpa mengubah target tersimpan |

Error job seperti `PARSE_FAILED`, `NO_SUPPORTED_SOURCE`, `CCM_INVALID`, `ARTIFACT_GENERATION_FAILED`, `WORKER_INTERRUPTED`, dan `EXPORT_FAILED` tersimpan pada status job/analysis yang dibaca dengan response `200`. Error job tidak selalu berarti endpoint pembaca status harus membalas `500`.

## Hal yang masih perlu dipin

Ukuran pagination, interval polling, TTL idempotency, resource limits, masa berlaku session, versi schema validator, dan detail cleanup transaction dipastikan pada ENV-01/GH-01/DATA-01. Kontrak yang berubah harus dicatat sebelum frontend/backend mengandalkan implementasi berbeda.
