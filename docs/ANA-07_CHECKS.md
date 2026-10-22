# ANA-07 — pipeline sembilan tahap dan publikasi hasil

Tanggal verifikasi: 22 Oktober 2026. Scope: #16, T-ANA-02, T-ANA-05, dan T-ANA-06. Baseline implementasi: `61b1f61db31b170862a7b183a67491fd2028a563`.

## Perilaku produk

Worker mengonsumsi durable queue PostgreSQL, satu analisis pada satu waktu. Registry produksi menyusun SNAPSHOT, LANGUAGE_DETECTION, STATIC_ANALYSIS, COMMON_CODE_MODEL, KNOWLEDGE_GRAPH, INTERFACE_CATALOG, SOFTWARE_ENGINEERING_DIAGRAM, UML_CLASS_DIAGRAM, dan ARCHITECTURE_DOCUMENT dari handler nyata. Health heartbeat berjalan selama job diproses; lease runner tetap diperbarui hingga publikasi selesai. Deadline keseluruhan 300 detik membatalkan pekerjaan dengan ANALYSIS_TIMEOUT; penghentian worker memakai WORKER_INTERRUPTED. Source pengguna hanya dibaca sebagai data.

Hasil graph dan ADD disimpan internal terlebih dahulu. Publisher memeriksa source snapshot, target/configuration immutable, seluruh stage COMPLETED, canonical graph/ADD dan mirror tersimpan, serta lease/token/attempt berdasarkan clock database. Satu transaksi menulis source-file mirror, limitation aman, resultHash, Analysis terminal, Job COMPLETED, dan pelepasan WorkerSlot. Analisis tanpa limitation menjadi COMPLETED; source excluded/failed atau model unresolved/limitation menjadi COMPLETED_WITH_LIMITATIONS. Kegagalan publikasi tidak membuka hasil parsial.

Retry hanya untuk FAILED, dengan owner dari session, pemeriksaan izin GitHub dan repository ID terkini, full SHA/configuration/versi yang sama, idempotency baru, serta analysis ID dan retryParentId baru. Record sebelumnya dipertahankan. Bila SHA lama tidak lagi berada pada branch tersimpan, validasi provider menolak retry; pilih target baru untuk mengikuti HEAD.

Pemilih target memanggil POST /api/analyses dan membuka halaman progres. Detail melakukan polling setiap tiga detik selama QUEUED/RUNNING dan berhenti ketika terminal. Setelah membaca response body, klien memeriksa akun sesi kembali sebelum menampilkan hasil atau berpindah ke analisis baru.

## Identitas hasil

`resultHash` adalah SHA-256 atas JSON deterministik dengan object key terurut: marker `sage-analysis-result-v1`, repository/branch/full SHA, configurationHash, versi analyzer/schema, daftar file terurut menurut path (bahasa/hash/ukuran/status), hash canonical CKG, hash ADD, dan kode/tahap/jumlah limitation aman. ID database, timestamp, visibility mutable, dan encoding/header gzip tidak masuk identitas hasil; hash fisik archive tetap diverifikasi untuk integritas penyimpanan. Source dan konfigurasi sama dapat menghasilkan hash hasil sama pada analysis ID berbeda.

## Lingkungan dan batas bukti

Pengujian dijalankan di database disposable `sage_pipeline16`, bukan database aplikasi. Container runner dibatasi 1 CPU/2 GiB dan PostgreSQL 0,5 CPU/256 MiB. Key enkripsi dan kredensial uji hanya tersedia dalam runtime privat. Laporan browser memakai akun serta source fixture sintetis.

Preload provider uji hanya boleh aktif dengan SAGE_PIPELINE_TESTS=1 dan database sage_pipeline16. Respons GitHub pada skenario browser terkontrol; ini tidak membuktikan login OAuth baru atau akses GitHub live. API Next, PostgreSQL, parser PHP/JS/TS, penyimpanan snapshot, worker, publisher, dan Chromium tetap nyata. Bukti provider live sebelumnya tetap terpisah di GH-01/GH-02/REP-02. Gate signoff formal #4/#11/#14 tidak ditutup oleh pekerjaan ini. Ekspor dan penghapusan tetap mengikuti issue masing-masing.

## Hasil aktual

- `npm run test:pipeline:live`: PASS, 12 pemeriksaan HTTP/Chromium. UI membuat antrean nyata, retry mempertahankan SHA/configuration, replay idempotent, foreign owner ditolak, izin dicabut tidak mengantre, polling berhenti terminal, dan dua respons A yang ditahan dibuang setelah cookie beralih ke B tanpa event focus.
- Analisis awal dan retry masing-masing menyelesaikan sembilan tahap dengan 34 node/37 edge. Hash hasil keduanya `d162f7b8019821927e003fa92ccdc581edbf90416b5df5be56d2713b485e2d1d`; hash ADD `6076699c3ec364f730afc61e825e51b0e722ef507ca60b22a15d92ed98e0d1f8`.
- Laporan dan lima screenshot lokal: `artifacts/pipeline-16/report.json`. Browser memakai lebar 390 px untuk pergantian akun pada target dan 1280 px untuk progres/retry; ini bukan pengulangan audit lima viewport seluruh aplikasi.
- `npm run check`: PASS, ESLint tanpa warning, TypeScript, 292 tes utama dan 8 tes data.
- `npm run test:pipeline:integration`: PASS, dua skenario PostgreSQL dengan assertion completion/limitation, replay hash, handler failure, interruption, deadline 1 detik, mirror rusak, rollback lease setelah write, dan recovery. Snapshot provider pada suite ini diinjeksi sebagai archive fixture; handler serta publisher nyata.
- `npm run build`: PASS, build produksi Next.js dengan endpoint retry dan seluruh halaman hasil.
- `npm run test:pipeline:recovery`: PASS, proses worker nyata dimatikan dengan SIGKILL saat SNAPSHOT. Setelah lease database kedaluwarsa, worker baru menandai parent FAILED/WORKER_INTERRUPTED tanpa hasil parsial, lalu retry target yang sama selesai sembilan tahap (39,4 detik).

### Menjalankan ulang

Gunakan database disposable sage_pipeline16 dengan opt-in SAGE_PIPELINE_TESTS=1, key enkripsi uji privat yang sama pada semua proses, serta STORAGE_ROOT privat di /tmp. Terapkan migrasi, generate Prisma, jalankan `npm run build`, lalu jalankan server standalone dan worker dengan `node --import ./scripts/helpers/pipeline-provider-fixture.mjs` (worker juga memakai `--import tsx`). Jalankan `npm run test:pipeline:live`. Preload ini khusus tes dan tidak dipakai oleh Compose produk.

Untuk integrasi publisher jalankan `npm run test:pipeline:integration` saat consumer terpisah berhenti agar claim fixture tidak diambil proses lain. Script menolak database dengan nama selain sage_pipeline16.

Untuk recovery proses, hentikan consumer lain lalu jalankan `SAGE_PIPELINE_RECOVERY_TESTS=1 npm run test:pipeline:recovery` dengan opt-in dan database yang sama. Tes menjalankan serta menghentikan proses worker miliknya sendiri dan menunggu expiry lease alami.
