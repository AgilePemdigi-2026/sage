# ANA-01 — Durable analysis queue

Status: API queue dan penerimaan PostgreSQL lulus pada 19 Oktober 2026. Read this document together with the migration and test evidence; an enqueue or claim alone does not mean an analysis has run or completed.

## Queue contract

- `enqueueAnalysis` stores an owner-bound Analysis snapshot and its ANALYSIS Job in one transaction. It accepts only a full 40- or 64-character Git commit SHA, lowercases that SHA, validates a plain finite JSON object, deep-copies it through canonical JSON, and computes `configurationHash` as SHA-256 of that canonical serialization. The caller cannot supply a mismatched hash.
- The caller must authenticate the owner and resolve the repository, branch, commit, and any private-repository permission before enqueueing. Queue code does not contact GitHub, read source files, or fetch a snapshot.
- `WorkerSlot(slotKey = analysis)` serializes enqueue and claim transactions. Its increasing `lastEnqueueSequence` is copied to each ANALYSIS Job and determines FIFO order. The sequence is not returned by the owner progress reader.
- Claim atomically changes one queued Job and its Analysis to RUNNING and installs a random UUID lease token hash. The raw token is returned only inside the worker claim handle. Renew and fail operations require the job ID, owner, attempt, and token hash to match, and require both persisted lease timestamps to remain in the future according to PostgreSQL `clock_timestamp()`.
- A new claim recovers an expired worker by marking its Job, Analysis, and currently RUNNING stages FAILED with `WORKER_INTERRUPTED`; PENDING stages remain pending. The old token cannot renew, fail, or release a later worker's slot. Recovery never retries or resumes the interrupted analysis.
- No completion operation or placeholder product result is provided. Publishing successful analysis output belongs to the pipeline implementation.

## PostgreSQL-only invariants

The migration uses manual SQL for predicates Prisma cannot currently represent without a preview schema feature:

- one RUNNING Analysis globally;
- one RUNNING ANALYSIS Job globally;
- one ANALYSIS Job per Analysis and unique FIFO sequence values;
- an ANALYSIS Job must reference an Analysis and have a sequence.

The migration backfills existing ANALYSIS jobs in `enqueuedAt, id` order and initializes the sequence counter. Because the earlier worker did not claim persisted jobs, it also converts any legacy RUNNING Analysis, Job, and RUNNING stage to `FAILED/WORKER_INTERRUPTED` and clears the legacy analysis slot. Existing queued jobs remain queued.

These partial indexes and the conditional job check are not represented in `schema.prisma`; preserve the migration SQL when changing the schema. `prisma db push` does not establish the global queue guarantee.

## Acceptance checks

`tests/queue.test.ts` verifies input guards and that enqueue snapshots caller-owned input before waiting on the database transaction. `tests/queue.integration.ts` uses actual PostgreSQL and launches separate Node processes to check FIFO, global claim exclusion, database constraints, heartbeat renewal, owner-scoped progress, stale-token fencing, and expired-lease recovery. `tests/helpers/queue-worker.ts` is a test-only process helper and refuses to run unless `SAGE_QUEUE_TESTS=1` and the database is exactly `sage_queue01` or `sage_queue01_fresh`.

Record fresh-schema and upgrade-schema migration output, test counts, runtime versions, and any limitations here after those checks have actually run. Do not treat a mocked queue test or a successful migration as proof of cross-process exclusivity.

## Hasil aktual 19 Oktober 2026

Base implementasi: `ba190b7`. Identitas commit mengikuti penanggung jawab issue `rizqy-fadhil`; pemeriksaan kode, review terpisah, dan tes dilakukan secara otomatis, bukan klaim review manual anggota.

| Pemeriksaan | Expected | Actual |
| --- | --- | --- |
| `npm run check` | Lint, typecheck, unit/contract suite lulus | PASS; 45 tes utama + 8 tes database |
| Typecheck helper worker | Proses worker test ikut diperiksa TypeScript | PASS |
| `npm run build` | Production build sesudah generate Prisma terbaru | PASS |
| Migrasi baru | Tiga migrasi lulus pada database kosong | PASS pada `sage_queue01_fresh` |
| Upgrade baseline | Dua migrasi lama + data sintetis lama dapat di-upgrade | PASS pada `sage_queue01`; dua RUNNING menjadi interrupted, dua QUEUED tetap ada, urutan FIFO 1–4 dibackfill, slot dilepas, downstream tetap pending |
| Checksum migrasi | File final sama dengan yang diterapkan | PASS pada kedua database; SHA-256 `88cd6288542542e28119ce0fcfa5b794518fcc190be8c5b0c3654c6281edf0b5` |
| Claim data backfill | Job queued lama yang paling awal dapat diklaim | PASS; failure bertoken juga melepas slot |
| `npm run test:queue:integration` | Dua proses worker hanya memperoleh satu claim global | PASS, PostgreSQL nyata; satu kasus integrasi dengan FIFO, constraint, heartbeat, ownership, stale fence, recovery, dan rollback transaksi |
| Regresi DATA-01 | Session/credential dan isolasi user tetap berlaku setelah migrasi baru | PASS; `npm run test:data:integration` pada database uji `sage_data01` |
| `prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code` | Schema tidak drift | PASS; tidak ada perbedaan |

Runtime: Linux arm64, Node.js 24.22.0, PostgreSQL 17, Prisma 7.10.1. Seluruh database berada di container/network uji terpisah; tidak ada pengujian destructive terhadap database aplikasi. Evidence lokal yang tidak di-commit ada di `artifacts/ana01-queue/upgrade-report.json`. Migrasi memakai transaksi eksplisit untuk menjaga cutover/backfill/index tetap atomik.

Review memperbaiki input enqueue yang semula dapat berubah selama menunggu lock, pemulihan slot lama tanpa token, dan penanganan null pada worker yang kalah berebut claim. Pemeriksaan akhir tidak menemukan masalah material tersisa.

Consumer worker aplikasi masih berjalan dalam mode environment/heartbeat. Helper dua proses hanya memeriksa kontrak antrean dan tidak menjalankan parser atau analisis repository; tidak ada hasil produk dummy yang dinyatakan selesai. Runner sembilan tahap serta publikasi graph/document sukses tetap #35/#16; pemeriksaan izin GitHub dan snapshot tetap tanggung jawab caller #5–#8. Image produksi tidak dibangun ulang pada paket ini; production build workspace dan integrasi database dijalankan langsung.
