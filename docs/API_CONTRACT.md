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
| GET | `/workspace/repositories` | Halaman daftar public milik akun, akses instalasi dan resolve repository; tersedia |
| GET | `/api/auth/session` | Tersedia: `{ data: { accountKey, login } }` dari sesi aktif; tanpa credential, private/no-store |
| POST | `/auth/logout` | Memeriksa `Origin` (cross-origin mendapat HTTP 403), mencabut session lokal, menghapus cookie, lalu redirect ke `/login`; tersedia |
| GET | `/auth/github/install` | Rancangan: memulai pemilihan/instalasi GitHub App untuk akses repository |
| GET | `/auth/github/setup` | Rancangan: memvalidasi konteks instalasi dan menghubungkannya ke user yang berhak |
| GET | `/session` | Rancangan: identitas pengguna, status koneksi, dan instalasi yang dapat dipilih; tanpa token |

Redirect URI harus sama dengan `{AUTH_BASE_URL}/auth/github/callback`; `AUTH_BASE_URL` harus berupa origin tanpa path, query, fragment, atau kredensial. HTTP hanya diizinkan untuk loopback lokal. Redirect selalu menuju GitHub atau path SAGE tetap, tanpa `returnTo`. Login memakai PKCE S256. Cookie `sage_oauth_browser` berumur 10 menit, HttpOnly, SameSite=Lax, dan terikat ke attempt yang dienkripsi server-side. State dikonsumsi sebelum token exchange, termasuk ketika pengguna menolak akses. Callback selalu menghapus cookie attempt. Cookie `sage_session` HttpOnly, SameSite=Lax, Secure pada HTTPS, dan hanya berisi token session opaque; access token GitHub tidak dikirim ke browser.

Login membaca ID, login, dan nama profil melalui GitHub App tanpa scope OAuth App tambahan. `expires_in` GitHub dibatasi maksimal delapan jam untuk masa berlaku kredensial dan session lokal; bila provider tidak mengirim expiry, SAGE memakai delapan jam dan meminta login ulang. Implementasi ini tidak menyimpan atau memakai refresh token. Logout hanya mencabut session lokal SAGE dan tidak mencabut token di GitHub. Callback yang gagal/ditolak kembali ke halaman login dengan kode pesan aman dan aksi coba lagi; raw error GitHub, token, dan detail internal tidak ditampilkan.

## Repository dan target

| Method | Endpoint | Input dan hasil |
| --- | --- | --- |
| GET | `/api/repositories/public` | Tersedia: `page=1..100`; public milik akun dari sesi, tanpa parameter owner; tidak dibatasi pilihan instalasi App |
| GET | `/api/github/installations` | Tersedia: `page=1..100`; instalasi aktif yang dapat diakses user, metadata aman tanpa token |
| GET | `/api/github/installations/{id}/repositories` | Tersedia: `page=1..100`; repository dengan akses akun dan Contents read dari instalasi |
| POST | `/api/repositories/resolve` | Tersedia: JSON `{ "repository": "owner/name atau URL GitHub" }`; public pihak lain atau private berizin, Origin wajib |
| GET | `/repositories` | Rancangan: search gabungan/pagination target |
| GET | `/api/repositories/branches` | Tersedia: `repository=owner/name&page=1..100`; branch aktual `{ name, commitSha }` dan `nextPage` |
| POST | `/api/repositories/target` | Tersedia: JSON `{ repository, branch, commit? }`; metadata repository, branch, `commitSha` penuh dan `branchHeadSha`; tidak membuat job |
| POST | `/api/analyses` | Tersedia: JSON `{ repository, branch, commit? }`, header `Idempotency-Key`; target diverifikasi ulang lalu analysis/job atomik, `202` baru atau `200` replay |

Endpoint GH-02 mengembalikan halaman `{ data: { items, nextPage } }`; `nextPage` adalah nomor halaman atau null. Hanya page 1–100 diterima, query asing ditolak. Daftar public milik akun, daftar instalasi terotorisasi, dan input public pihak lain ditampilkan terpisah. Instalasi dapat dimiliki collaborator/organisasi yang aksesnya sah. UI mengirim `X-SAGE-Account` berisi ID GitHub yang dirender server; backend menolak `401 AUTH_REQUIRED` bila tidak sesuai sesi aktif. Header ini mendeteksi tab lama, bukan pengganti autentikasi cookie. Connection harus cocok dengan ID GitHub user; identitas tidak diambil dari parameter klien. Tab memeriksa identitas saat fokus/visible dan berkala, lalu menghapus state dan memuat ulang jika akun berubah. Resolve slug/URL tidak menambah izin private dan tidak menerima host arbitrary. Branch dibaca dari repository, bukan daftar hardcoded dari mockup.

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

Implementasi REP-02 menerima key 16–128 karakter ASCII huruf/angka/underscore/minus; hash key dan hash payload kanonis disimpan per pemilik. Replay mengembalikan ID, full SHA, configuration hash, dan status persisten, tanpa resolve HEAD ulang. Key bertahan selama analysis belum dihapus. Perubahan payload, termasuk mengganti bentuk slug/URL, memakai key baru. Consumer ANA-07 mengambil antrean dan menjalankan sembilan handler nyata; respons submission tetap menyatakan status antrean, bukan hasil selesai.

Header `Idempotency-Key` digunakan untuk mencegah double-submit. Scope key adalah user dan operasi; key yang sama dengan payload berbeda menghasilkan `409 IDEMPOTENCY_CONFLICT`. Analisis kedua yang valid mengantre, bukan berjalan bersamaan atau mengganti target sebelumnya.

## Analysis dan progress

| Method | Endpoint | Hasil |
| --- | --- | --- |
| GET | `/analyses` | **Tersedia (HIST-01)**: history milik user; filter `query`, `status`, dan cursor keyset 20 per halaman |
| GET | `/analyses/{analysisId}` | **Tersedia (HIST-01)**: context, full SHA, status, sembilan stage, limitations, serta link hasil jika tersedia |
| POST | `/analyses/{analysisId}/retry` | Analysis baru dengan full SHA/config yang sama; detail menyajikan `retryOfAnalysisId` dari relasi internal `retryParentId` |
| DELETE | `/analyses/{analysisId}` | Penghapusan data terminal milik user; `202` selama cleanup atau `204` setelah selesai |
| GET | `/jobs/{jobId}` | Status job milik user, termasuk cleanup/export yang masih diproses |

`GET /analyses` paginasi memakai cursor keyset `(createdAt DESC, id DESC)` membatasi 20 record; `nextCursor: null` berarti habis. Tautan graph/dokumen pada detail hanya muncul untuk status `COMPLETED`/`COMPLETED_WITH_LIMITATIONS` dan berformat canonical `/analyses/{analysisId}/graph` dan `/analyses/{analysisId}/document`; halaman tujuannya mengikuti paket GRAPH-01 dan DOC-01.

Enum analysis: `QUEUED`, `RUNNING`, `COMPLETED`, `COMPLETED_WITH_LIMITATIONS`, `FAILED`. Enum stage: `PENDING`, `RUNNING`, `COMPLETED`, `FAILED`.

Response progress menyertakan `updatedAt` dan `stateVersion` monoton untuk menghindari pembaruan UI yang mundur. UI tidak membuat persentase/ETA dari jumlah stage. Jika stage gagal, stage berikutnya tetap pending dan link hasil tetap tidak tersedia.

Retry hanya diterima untuk analysis `FAILED`; pemilik yang ingin mengulang hasil sukses membuat analysis baru dari target yang dipilih. Retry selalu menjalankan validasi izin dan tidak mengubah record lama. Endpoint retry menerima object JSON kosong, `Idempotency-Key` 16–128 karakter dan header akun, jika dikirim, harus cocok dengan session; field target/owner/config dari klien ditolak. Izin provider diperiksa lagi termasuk saat replay. Parent asing menghasilkan 404, non-FAILED 409 `ANALYSIS_NOT_RETRYABLE`, identitas repository/SHA berubah 409 `RETRY_TARGET_CHANGED`; kegagalan izin tidak membuat analysis baru. Nama snapshot parent dipertahankan pada retry meskipun metadata repository berubah.

Delete analysis queued/running menghasilkan `409 ANALYSIS_ACTIVE`; delete dengan export aktif menghasilkan `409 EXPORT_ACTIVE`. Setelah cleanup dimulai, hasil dan file tidak dapat dibaca lagi meskipun penghapusan volume masih retry. Perilaku lifecycle lengkap mengikuti [model data](DATA_MODEL.md).

## Graph, inspector, dan source

| Method | Endpoint | Parameter/hasil |
| --- | --- | --- |
| GET | `/analyses/{analysisId}/graph` | `mode=focus\|overview\|all-references`, `nodeId`, `query`, daftar `categories`, cursor/limit |
| GET | `/analyses/{analysisId}/nodes/{nodeId}` | Node, location/bounds, incoming/outgoing summary, evidence, limitations |
| GET | `/analyses/{analysisId}/nodes/{nodeId}/relations` | `direction=incoming\|outgoing`, cursor/limit; edge asli dan evidence |
| GET | `/analyses/{analysisId}/files/{fileId}/source` | Source snapshot, hash, line range yang diminta dan bounds highlight |
| GET | `/analyses/{analysisId}/document` | Document model dan tiga artefak dari result bundle yang sama |

Implementasi GRAPH-01 menyediakan `GET /api/analyses/{analysisId}/graph` tanpa query parameter untuk membaca proyeksi lengkap dari canonical CKG tersimpan. Envelope memuat `accountKey`, snapshot immutable, hash CKG/configuration, provenance, limitation, `canonicalCounts`, `filteredCounts`, `returnedCounts`, `paginated: false`, dan `graph`. Byte source, kredensial, serta path storage tidak dikirim. Mode, Node Query, dan kategori AST diproyeksikan di client pada proyeksi lengkap yang telah diotorisasi. GRAPH-02 tidak menambah parameter API atau pagination server; parameter pada tabel adalah rancangan endpoint, bukan kontrak query yang sudah diterima API. Semua query parameter tetap ditolak secara eksplisit, bukan diabaikan.

Owner diambil dari session cookie; `X-SAGE-Account` mendeteksi tab dengan akun lama. API memakai `private, no-store` serta `Vary: Cookie, X-SAGE-Account`. Analisis asing/tidak ada menghasilkan 404, analisis milik sendiri yang belum sukses menghasilkan 409 `RESULT_NOT_READY`, dan storage/CKG rusak menghasilkan 503 generik tanpa membocorkan source atau path. Graph diperiksa ulang terhadap archive ACTIVE terbaru yang terikat owner/analysis, dengan urutan createdAt/id deterministik; metadata target tetap dari snapshot CKG, bukan nama repository yang dapat berubah.

Response graph memisahkan `canonicalCounts`, `filteredCounts`, `returnedCounts`, serta `paginated: false`. API mengirim graph lengkap; client membedakan jumlah canonical, hasil filter/mode, serta jumlah yang dirender setelah budget 200 node/500 edge. Filter tidak menambahkan node konteks yang tidak cocok; edge hanya bertahan jika kedua endpoint cocok. Focus diterapkan pada subset yang cocok.

Kategori UI memakai kind AST canonical yang tersedia pada graph; query dan kategori digabung AND. Hasil filter kosong adalah state lokal tanpa mengubah response API atau hasil canonical. Reset menghapus kata pencarian dan pilihan kategori. Source hanya menerima file ID milik analisis, bukan arbitrary path/URL; snippet berasal dari hash snapshot yang sama.

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

## Implementasi pembacaan dokumen DOC-01

`GET /api/analyses/{analysisId}/document` tidak menerima query parameter. Envelope `{ data: { analysisId, accountKey, contentHash, document } }` membawa `sage-add-v1` lengkap dari canonical CKG dan archive ACTIVE terbaru yang terikat owner/analysis, diurutkan createdAt/id. Source bytes, storage key dan kredensial tidak dikirim. Owner/status diperiksa sebelum akses storage; parent target/config serta hash/mirror graph dan dokumen diperiksa ulang.

ID/query invalid menghasilkan 400 `INVALID_INPUT`; session atau `X-SAGE-Account` tidak cocok menghasilkan 401 `AUTH_REQUIRED`; missing/foreign 404 `ANALYSIS_NOT_FOUND`; milik sendiri belum sukses 409 `RESULT_NOT_READY`; hasil terminal hilang/rusak 503 `DOCUMENT_UNAVAILABLE` generik. Respons memakai `Cache-Control: private, no-store`, `Vary: Cookie, X-SAGE-Account`, serta `X-Content-Type-Options: nosniff`. Halaman dokumen memeriksa ulang identitas dan membuang respons lama setelah pergantian akun. Endpoint ini tidak menyediakan download/ekspor #20/#21 atau menerbitkan status terminal #16.

## Pembacaan inspector dan source GRAPH-03

`GET /api/analyses/{analysisId}/nodes/{nodeId}` tidak menerima query parameter. Envelope `data` membawa `analysisId`, `accountKey`, `ckgSha256`, `configurationHash`, `snapshot`, `node`, `incoming`, `outgoing`, serta `files`. Setiap relasi memuat edge canonical lengkap dengan evidence/resolution/reason dan peer node; self-loop dapat muncul pada kedua arah. Node tidak menyertakan attributes analyzer yang arbitrer. Daftar file hanya memuat source processed yang dikutip oleh lokasi node atau evidence relasi langsung. Source text tidak disertakan di endpoint detail.

`GET /api/analyses/{analysisId}/files/{fileId}/source?startLine=1&endLine=20` memakai ID `file-` ditambah SHA-256 dari UTF-8 `path + NUL + fileSha256`. ID hanya dicocokkan dengan file processed yang dikutip evidence canonical dalam analisis terotorisasi; path atau URL tidak diterima sebagai pengganti ID. Kedua parameter baris wajib, tepat satu kali, integer positif dalam notasi desimal tanpa leading zero; parameter lain ditolak. Batas 200 baris inklusif dan 128 KiB UTF-8 per preview. Akhir rentang diklem ke baris terakhir berkas. Payload source membawa binding analisis/akun/hash/snapshot yang sama, metadata `file`, `startLine`, `endLine`, `totalLines`, dan `text`. Nomor baris mengikuti LF pada byte snapshot; BOM, Unicode, dan CRLF dipertahankan dalam text API.

Kedua endpoint membaca ulang canonical CKG terhadap archive immutable setelah memeriksa pemilik/status. Byte/hash file diverifikasi sebelum dipotong menjadi preview. Source yang tidak direferensikan atau dikecualikan tidak dilayani. Respons memakai `Cache-Control: private, no-store`, `Vary: Cookie, X-SAGE-Account` dan `X-Content-Type-Options: nosniff`. ID atau bentuk request tidak valid menghasilkan 400 `INVALID_INPUT`; sesi hilang atau account binding usang 401 `AUTH_REQUIRED`; analisis asing/hilang 404 `ANALYSIS_NOT_FOUND`; node/file tidak dikenal 404 `NODE_NOT_FOUND`/`FILE_NOT_FOUND`; status belum sukses 409 `RESULT_NOT_READY`; cuplikan terlalu besar 413 `SOURCE_RANGE_TOO_LARGE`. Hasil/archive rusak menghasilkan 503 generik `NODE_INSPECTOR_UNAVAILABLE`/`SOURCE_UNAVAILABLE` tanpa path storage atau detail internal.

Inspector client mengikat respons ke analysis, account, CKG/configuration hash, snapshot, serta node atau file/range yang diminta. Pergantian selection/context membatalkan request lama. Deteksi 401 memicu pemeriksaan identitas parent dan membersihkan inspector/source lama. Dialog menampilkan highlight pada baris evidence, bukan klaim highlight byte/kolom; bounds AST asli tetap ditampilkan, termasuk keterangan akhir byte eksklusif.

Endpoint terpisah `/nodes/{nodeId}/relations` pada tabel rancangan belum diimplementasikan; relasi aktual GRAPH-03 dikirim sebagai array incoming/outgoing di payload detail node.

## Ekspor Markdown EXP-01 yang tersedia

`POST /api/analyses/{analysisId}/exports` menerima JSON tepat `{ "format": "MARKDOWN" }`. Format lain menghasilkan 422 `EXPORT_FORMAT_UNSUPPORTED`; PDF mengikuti #21. Request baru menghasilkan 202, request yang sudah ada untuk owner/analysis/document hash/renderer yang sama menghasilkan 200. Body tidak menerima owner, path storage atau hash dokumen dari pengguna. Hash diambil dari ADD canonical yang diverifikasi ulang.

`GET /api/analyses/{analysisId}/exports/{exportId}` membaca status. Ketiga operasi status/create/retry mengembalikan `{ data: { analysisId, accountKey, export: { id, format, status, documentHash, rendererVersion, contentHash, errorCode } } }`; `status` adalah QUEUED/GENERATING/READY/FAILED. READY memiliki contentHash SHA-256, sedangkan detail path storage tidak dikirim.

`POST /api/analyses/{analysisId}/exports/{exportId}/retry` menerima JSON kosong `{}` dan mengembalikan 202 hanya untuk FAILED. Retry mempertahankan ID ekspor, documentHash dan rendererVersion, lalu membuat job percobaan baru. READY/aktif menghasilkan 409 `EXPORT_RETRY_CONFLICT`; dokumen yang berubah menghasilkan 409 `DOCUMENT_CHANGED`.

`GET /api/analyses/{analysisId}/exports/{exportId}/download` mengirim attachment `text/markdown; charset=utf-8` sesudah ownership, status READY, metadata storage, ukuran dan checksum file diverifikasi. File maksimum 32 MiB; renderer yang melebihi batas gagal dengan `EXPORT_TOO_LARGE`. Tidak ada parameter query pada endpoint ekspor. POST wajib Origin tepercaya serta JSON berbatas ukuran. Semua respons memakai private/no-store, Vary Cookie/X-SAGE-Account dan nosniff. Session/akun berubah menghasilkan 401, missing/foreign export 404, unduhan belum siap 409, gangguan storage/integritas 503 aman. Browser mengikat status pada analysis/account/document hash dan memeriksa session sesudah menerima body unduhan sebelum membuat Blob URL.

Worker ekspor memakai slot `export` dengan lease terpisah dari antrean analisis. Kegagalan atau retry ekspor tidak memublikasikan ulang graph/ADD dan tidak mengubah result hash analisis. Bukti aktual serta batas integrasi: [EXP-01_CHECKS](EXP-01_CHECKS.md).
