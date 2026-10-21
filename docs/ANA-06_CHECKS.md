# Verifikasi canonical CKG dan persistensi ANA-06

Tanggal: 21 Oktober 2026, Asia/Jakarta. Refs [#14](https://github.com/AgilePemdigi-2026/sage/issues/14). Base: `2be9fd054183c16383a700188154dbc018f8172e`. Akun pengiriman: Iltizam (`iltizamhasan3`). Requirement `SAGE-FR-ANA-06`, `NFR-01`, `NFR-03`.

## Implementasi

`canonicalizeCkg` membungkus CCM tervalidasi sebagai `sage-ckg-v1`, mempertahankan semua node/edge/ID, snapshot, metadata file, provenance adapter, limitation dan evidence byte source. Hash konfigurasi queue disimpan terpisah dari hash konfigurasi adapter. Counts membedakan containment/reference dan Exact/Unresolved; timestamp, ID job, dan ID baris database tidak masuk hash fakta.

`parseCanonicalCkg` memverifikasi canonical JSON, SHA-256, counts turunan, dan kecocokan evidence dengan byte snapshot. Proyeksi graph tetap membaca CCM yang sama; tidak ada resolusi atau relasi baru yang ditebak pada tahap CKG.

Stage `COMMON_CODE_MODEL` memvalidasi ulang artefak serialized dari static analysis terhadap snapshot milik analysis dan target immutable. Stage `KNOWLEDGE_GRAPH` membangun canonical CKG serta menyimpan GraphBundle internal. Penulis database memeriksa pemilik, attempt/token, lease berdasarkan waktu PostgreSQL, status analysis, target/configuration hash, serta stage CCM selesai/graph aktif. Slot dikunci dalam transaksi; pengecekan lease terakhir membatalkan transaksi bila masa lease habis selama penulisan. Replay identik idempotent; hasil berbeda ditolak tanpa overwrite.

Migrasi `202610210002_ana06_repository_context` menambahkan nama target immutable `Analysis.repositoryFullNameSnapshot`, diisi saat enqueue. Rename metadata repository berikutnya tidak mengubah konteks job atau membatalkan graph historis. Untuk analysis legacy yang belum menyimpan nama, inisialisasi worker menangkap nama terkini satu kali; ini tidak merekonstruksi nama historis yang tidak pernah direkam.

Migrasi `202610210001_ana06_canonical_graph` menambahkan `GraphBundle.canonicalContent` nullable untuk kompatibilitas baris lama. Nodes/edges disimpan sebagai string JSON canonical di kolom JSONB, bukan array JSONB decoded: source dengan escaped NUL atau lone surrogate tetap tersimpan tanpa sanitasi atau kehilangan fakta. Encoding ini bagian dari storage contract `sage-ckg-v1`; reader mengembalikan model decoded. Mirror tersebut dan count diperiksa saat replay/read. `readCanonicalGraphForUser` memakai predicate owner dan status terminal berhasil, memeriksa parent target/config serta mirror/hash/source. Baris legacy tanpa canonical content tidak dianggap CKG tervalidasi. Tidak ada endpoint graph produk baru pada paket ini.

## Hasil aktual

| Pemeriksaan | Expected | Actual |
| --- | --- | --- |
| Lint dan typecheck root/web | Tanpa error/warning | PASS |
| Tes utama | Seluruh suite lulus | 234/234 PASS |
| Tes data tanpa layanan DB | Seluruh suite lulus | 8/8 PASS |
| Migrasi pada PostgreSQL kosong | Tujuh migrasi berhasil | PASS |
| Replay, counts dan input arrays diurutkan berbeda | JSON/hash sama, source/extra field/count/hash palsu ditolak | PASS |
| Hash/target/evidence pada batas stage | Perubahan ditolak sebelum persistensi | PASS |
| PostgreSQL owner/lease/stage fence, replay immutable dan rollback | Claim owner/token salah ditolak, graph sementara tersembunyi | PASS |
| Lease habis selama INSERT | Trigger uji menunda INSERT 400 ms melewati deadline 200 ms; transaksi rollback dan baris tidak tersimpan | PASS |
| Snapshot tersimpan → JS/TS/PHP → CCM → canonical CKG | Provenance/evidence/hash dipertahankan, unresolved tetap terlihat | PASS |
| Label dependency dengan escaped NUL/lone surrogate | Source valid diparse, seluruh codepoint tersimpan dan direplay lossless | PASS setelah perbaikan encoding JSONB |
| Integrasi CKG, rename dan capture legacy | Tiga tes tanpa skip | 3/3 PASS |
| Regression queue/stage PostgreSQL | Atomic/FIFO/recovery, heartbeat, cancellation dan lease loss tetap benar | 1 tes queue + 2 tes stage PASS |
| Production build | Prisma generate, Next compilation/typecheck dan static pages berhasil | PASS |

Review independen langsung pada diff PR menemukan label NUL yang ditolak JSONB. Tes source-backed PostgreSQL direproduksi gagal di KNOWLEDGE_GRAPH sebelum perubahan encoding; setelahnya tes yang sama lulus. Review juga menemukan perbandingan nama snapshot dengan nama repository yang mutable; koreksi membekukan nama analysis saat enqueue dan menambahkan regresi rename pada konteks worker/read historis.

Tes fixture kontrak memakai output resolver nyata. Integrasi worker memakai source sintetis publik tiga bahasa termasuk BOM/CRLF/Unicode, source excluded, unknown receiver dan canary throw yang tidak dieksekusi. Stage 1–5 menjalankan handler nyata; stage 6–9 memakai placeholder uji yang ditandai eksplisit. Assertion memastikan analysis tetap RUNNING dan ArchitectureDocument belum tersedia, sehingga ini bukan bukti pipeline produk sembilan tahap selesai.

Lingkungan: Linux arm64, image lokal `sage-worker:local`, Node 24.22.0, PHP 8.4.26, PostgreSQL 17. Container pengujian dibatasi 1 CPU/2 GiB; DB 0.5 CPU/256 MiB memakai tmpfs dan network internal terpisah. Database fixture `sage_ckg14` hanya diizinkan dengan `SAGE_CKG_TESTS=1`; data aplikasi tidak diakses. Trigger penundaan hanya dipasang sementara pada database fixture dan dibersihkan di finally.

Command dalam container Node 24 dengan dependency terkunci:

```sh
npm run db:generate
npm run db:migrate
npm run check
SAGE_CKG_TESTS=1 npm run test:ckg:integration
npm run build
git diff --check
```

`DATABASE_URL` untuk integrasi harus menunjuk database disposable bernama `sage_ckg14`; jangan memakai database aplikasi. Dua suite CKG berjalan berurutan untuk slot worker global tunggal. Regression queue/stage memakai database disposable terpisah `sage_queue01` dan `SAGE_QUEUE_TESTS=1`; command `npm run test:queue:integration` serta `npm run test:stages:integration` juga lulus sesudah migrasi.

## Batas acceptance

Consumer queue produk tetap nonaktif. Publikasi graph dan dokumen secara atomik, retry/recovery produk, graph canvas/inspector nyata, dokumen, ekspor dan replay browser masih mengikuti #16/#17–21. Integrasi ini memakai PostgreSQL nyata dan source fixture, bukan GitHub live atau browser E2E. Penghapusan graph mengikuti cascade analysis yang ada; cleanup produk tetap #23.

Dependency formal ANA-05 #11 dan QA-01 #4 masih terbuka untuk acceptance parent/review formal tim dan benchmark representatif. PR ini memakai `Refs #14`; issue tidak ditutup otomatis dan tidak mengklaim dependency tersebut selesai. Bukti parent sebelumnya tetap berlaku dengan scope historisnya.

## Pembaruan dependency QA-01 — 21 Oktober 2026

QA-01 kini menyediakan 33 fakta resolver source-backed, canary processed tanpa efek samping, review teknis independen serta enam run benchmark dua corpus repository nyata; lihat [hasil QA-01](QA-01_CHECKS.md). Gate yang tersisa adalah signoff formal tim pada manifest; tidak lagi menyatakan benchmark dua corpus belum dijalankan. Pengukuran tersebut tetap bukan bukti kapasitas dekat ceiling atau pipeline E2E. Penerimaan parent tidak ditutup otomatis.
