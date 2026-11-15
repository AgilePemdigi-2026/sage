# ANA-07-S1 — sequential analysis stage runner

## Scope

The worker now has an internal runner for the nine pipeline stages defined in `docs/ARCHITECTURE.md`. It accepts an exact registry of trusted handlers, starts one persisted stage at a time, and passes each handler the repository target and configuration loaded from the persisted analysis. Handler outputs are copied before they are kept and copied again before they are passed downstream; snapshot bytes therefore remain unchanged if a later handler mutates its own input copy.

The runner does not fetch or execute repository code itself. It does not install project dependencies, publish graph/document records, or mark an analysis successful. No production handler registry is connected yet; the handlers in the integration test are explicitly test-only stubs.

## State and lease behavior

- The stage contract fixes the sequence and keys: `SNAPSHOT`, `LANGUAGE_DETECTION`, `STATIC_ANALYSIS`, `COMMON_CODE_MODEL`, `KNOWLEDGE_GRAPH`, `INTERFACE_CATALOG`, `SOFTWARE_ENGINEERING_DIAGRAM`, `UML_CLASS_DIAGRAM`, and `ARCHITECTURE_DOCUMENT`.
- Stage transitions hold the fixed `analysis` worker-slot row lock and check the job, owner, attempt, token hash, and database lease expiry. `PENDING → RUNNING` is a compare-and-set, so a second runner using the same claim cannot invoke a duplicate handler.
- A successful pass marks all nine stages `COMPLETED` and returns `stagesFinished: true`. The analysis and job remain `RUNNING` so a later result-publication step can decide when to publish artifacts and complete them.
- A handler error or cancellation uses the existing fenced queue failure operation with a fixed error code. The active stage is marked `FAILED`, later stages stay `PENDING`, and the analysis/job become `FAILED` together.
- The lease is renewed before stage initialization and then by one bounded heartbeat loop. Lost or unverified leases abort the handler signal and prevent later writes. Handlers must observe the supplied `AbortSignal` to stop their own work; the runner cannot forcibly terminate uncooperative code.

## Validation commands

Run the unit contract checks with:

```sh
npm test
```

Run the destructive PostgreSQL integration test only against an isolated queue test database:

```sh
SAGE_QUEUE_TESTS=1 DATABASE_URL='postgresql://sage@queue-db:5432/sage_queue01_fresh' npm run test:stages:integration
```

The integration test rejects database names other than `sage_queue01` and `sage_queue01_fresh`. It checks sequential handler calls, read-only persisted target/config input, source-byte preservation, stage failure and downstream pending state, owner-scoped progress reads, and the absence of published graph/document rows.

## Hasil aktual 19 Oktober 2026

Base implementasi: `4420e9271ceb63ef3d57700fa9873ccf007e8bb3`. Penanggung jawab paket dan identitas commit: `rizqy-fadhil`. Implementasi, pengujian, dan review kode terpisah dilakukan secara otomatis; ini bukan klaim review manual anggota.

| Pemeriksaan | Expected | Actual |
| --- | --- | --- |
| `npm run check` | Lint, typecheck, unit/contract suite lulus | PASS; 47 tes utama dan 8 tes database |
| `npm run build` | Production build web dan generate Prisma lulus | PASS |
| `npm run test:stages:integration` | Persistensi sembilan tahap dan failure konsisten pada PostgreSQL nyata | PASS; dua kasus integrasi, handler hanya stub terkontrol |
| Handler panjang | Heartbeat mempertahankan lease 1 detik selama handler lebih dari 1,2 detik | PASS |
| Pemanggilan duplikat | Handler tidak dieksekusi dua kali; pembatalan duplikat tidak menggagalkan runner aktif | PASS; CAS menolak duplikat sebelum jalur pembatalan |
| Durasi lease berbeda | Duplikat dengan lease 1 detik tidak memperpendek lease aktif 30 detik | PASS; renewal memakai deadline terbesar |
| Pembatalan dan kehilangan lease | AbortSignal diterima, downstream tetap PENDING, slot dilepas melalui failure/recovery | PASS |
| Token salah dan ownership | Token salah tidak menginisialisasi tahap; user lain tidak mendapat progres | PASS |
| `npm run test:queue:integration` | Perubahan snapshot claim/renewal tidak merusak FIFO, fencing, dan recovery | PASS; satu kasus integrasi PostgreSQL dengan dua proses worker |

Runtime: Node.js 24.22.0 dan PostgreSQL 17 dalam Docker. Semua integrasi menggunakan database uji terisolasi `sage_queue01_fresh`; database aplikasi tidak diubah. Log lokal berada di `/tmp/sage-tools/35-*.log` dan tidak di-commit. Tidak ada migrasi baru atau rebuild image produksi pada paket ini.

Review memperbaiki query INSERT tahap yang membutuhkan cast integer eksplisit, pembacaan progres sebelum inisialisasi, snapshot claim sebelum await, rollback inisialisasi saat lease hilang, pembatalan dari pemanggilan duplikat, dan renewal yang semula dapat memperpendek lease. Tidak ada temuan material tersisa setelah pemeriksaan akhir.

`stagesFinished` hanya menyatakan handler tahap selesai. Analysis/Job tetap RUNNING pada jalur sukses, dan heartbeat runner berhenti setelah fungsi kembali; pemanggil publikasi harus mempertahankan lease melalui `renewAnalysisLease` sampai publikasi atomik selesai. Worker produk tetap mode heartbeat lingkungan; tidak ada registry stub yang diaktifkan di aplikasi. Integrasi pipeline repository nyata dan publikasi hasil tetap #16, sehingga parent tersebut belum ditutup.
