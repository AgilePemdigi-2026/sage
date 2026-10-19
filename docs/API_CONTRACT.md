# Kontrak API

Status: endpoint produk `v1` masih rancangan. Fondasi ENV-01 menyediakan `GET /api/health`; alur login dan session GitHub App GH-01 juga sudah tersedia pada path yang dicantumkan di bawah. Endpoint selain yang dinyatakan tersedia tetap rancangan. Health check mengembalikan HTTP 200 ketika koneksi database tersedia, atau HTTP 503 dengan status `unavailable` tanpa detail error internal. Health check tidak memerlukan session dan tidak menyediakan data pengguna. Root rencana produk adalah `/api`; ID opaque tidak menggantikan pemeriksaan session/pemilik.

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
| GET | `/login` | Halaman login HTML dengan pesan error aman dan tombol POST GitHub; tersedia |
| POST | `/auth/github` | Memeriksa `Origin` (cross-origin mendapat HTTP 403), membuat state/PKCE dan cookie browser, lalu redirect ke GitHub; tersedia |
| GET | `/auth/github` | Redirect ke `/login`; read-only dan tidak membuat state |
| GET | `/auth/github/callback` | Memeriksa state sekali pakai dan cookie browser, menukar kode server-side, membuat session, lalu redirect ke `/workspace`; tersedia |
| GET | `/workspace` | Workspace untuk session aktif dan koneksi GitHub aktif yang belum kedaluwarsa; tersedia |
| GET | `/workspace/repositories` | Halaman akses instalasi dan resolve repository; tersedia |
| POST | `/auth/logout` | Memeriksa `Origin` (cross-origin mendapat HTTP 403), mencabut session lokal, menghapus cookie, lalu redirect ke `/login`; tersedia |
| GET | `/auth/github/install` | Rancangan: memulai pemilihan/instalasi GitHub App untuk akses repository |
| GET | `/auth/github/setup` | Rancangan: memvalidasi konteks instalasi dan menghubungkannya ke user yang berhak |
| GET | `/session` | Rancangan: identitas pengguna, status koneksi, dan instalasi yang dapat dipilih; tanpa token |

Redirect URI harus sama dengan `{AUTH_BASE_URL}/auth/github/callback`; `AUTH_BASE_URL` harus berupa origin tanpa path, query, fragment, atau kredensial. HTTP hanya diizinkan untuk loopback lokal. Redirect selalu menuju GitHub atau path SAGE tetap, tanpa `returnTo`. Login memakai PKCE S256. Cookie `sage_oauth_browser` berumur 10 menit, HttpOnly, SameSite=Lax, dan terikat ke attempt yang dienkripsi server-side. State dikonsumsi sebelum token exchange, termasuk ketika pengguna menolak akses. Callback selalu menghapus cookie attempt. Cookie `sage_session` HttpOnly, SameSite=Lax, Secure pada HTTPS, dan hanya berisi token session opaque; access token GitHub tidak dikirim ke browser.

Login membaca ID, login, dan nama profil melalui GitHub App tanpa scope OAuth App tambahan. `expires_in` GitHub dibatasi maksimal delapan jam untuk masa berlaku kredensial dan session lokal; bila provider tidak mengirim expiry, SAGE memakai delapan jam dan meminta login ulang. Implementasi ini tidak menyimpan atau memakai refresh token. Logout hanya mencabut session lokal SAGE dan tidak mencabut token di GitHub. Callback yang gagal/ditolak kembali ke halaman login dengan kode pesan aman dan aksi coba lagi; raw error GitHub, token, dan detail internal tidak ditampilkan.

## Repository dan target

| Method | Endpoint | Input dan hasil |
| --- | --- | --- |
| GET | `/api/github/installations` | Tersedia: `page=1..100`; instalasi aktif yang dapat diakses user, metadata aman tanpa token |
| GET | `/api/github/installations/{id}/repositories` | Tersedia: `page=1..100`; repository dengan akses akun dan Contents read dari instalasi |
| POST | `/api/repositories/resolve` | Tersedia: JSON `{ "repository": "owner/name atau URL GitHub" }`; public pihak lain atau private berizin, Origin wajib |
| GET | `/repositories` | Rancangan: search gabungan/pagination target |
| GET | `/api/repositories/branches` | Tersedia: `repository=owner/name&page=1..100`; branch aktual `{ name, commitSha }` dan `nextPage` |
| POST | `/api/repositories/target` | Tersedia: JSON `{ repository, branch, commit? }`; metadata repository, branch, `commitSha` penuh dan `branchHeadSha`; tidak membuat job |
| POST | `/api/analyses` | Tersedia: JSON `{ repository, branch, commit? }`, header `Idempotency-Key`; target diverifikasi ulang lalu analysis/job atomik, `202` baru atau `200` replay |

Endpoint GH-02 mengembalikan halaman `{ data: { items, nextPage } }`; `nextPage` adalah nomor halaman atau null. Hanya page 1–100 diterima, query asing ditolak. Daftar terotorisasi dan input publik adalah dua jalur UI yang terlihat jelas. Resolve slug/URL tidak menambah izin private dan tidak menerima host arbitrary. Branch dibaca dari repository, bukan daftar hardcoded dari mockup.

REP-01 memeriksa ulang izin dan branch setiap request. Commit opsional menerima prefix heksadesimal 7–40 karakter atau SHA 64 karakter; prefix harus tidak ambigu dan commit harus ancestor dari HEAD branch yang ditangkap pada request. Branch kosong/repository kosong, commit di luar branch, atau respons provider rusak ditolak. Kesalahan input memakai `400 INVALID_INPUT`; branch hilang dapat menghasilkan `404 NOT_FOUND`. Hasil validasi belum tersimpan sebagai analysis; submission REP-02 wajib memvalidasi ulang. Pencarian UI berlaku pada repository yang sudah dimuat; halaman berikutnya tetap dapat dimuat.

Rancangan request analisis:

```json
{
  "repository": "owner/name",
  "branch": "main",
  "commit": null
}
```

Slug di atas hanya ilustrasi; ID repository lokal diperoleh server dari metadata GitHub yang terverifikasi. `commit` dapat kosong atau berupa SHA/prefix yang valid dan tidak ambigu. Validasi harus memastikan commit berada dalam history branch terpilih sesuai kebijakan target awal; jika berbeda, kembalikan error target dan minta pengguna memperbaikinya.

Sebelum response `202`, server resolve target ke full SHA dan menyimpan analysis ID, pemilik, branch, versi config, serta urutan antrean. Worker memeriksa izin kembali dan mengambil snapshot SHA yang sama. Kegagalan validasi tidak membuat record analisis yang seolah sudah berjalan.

Implementasi REP-02 menerima key 16–128 karakter ASCII huruf/angka/underscore/minus; hash key dan hash payload kanonis disimpan per pemilik. Replay mengembalikan ID, full SHA, configuration hash, dan status persisten, tanpa resolve HEAD ulang. Key bertahan selama analysis belum dihapus. Perubahan payload, termasuk mengganti bentuk slug/URL, memakai key baru. Worker consumer penuh masih ANA-07 #16; submission saat ini menyimpan antrean dan tidak mengklaim pipeline selesai.

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
