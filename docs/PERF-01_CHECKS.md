# PERF-01 — Canonical storage tanpa mirror duplikat

Issue [#96](https://github.com/AgilePemdigi-2026/sage/issues/96). Base: `24c0d194688c5a3a5045467a1abb8d2589a46d34`. Paket ini menyiapkan penyimpanan sebelum Coolify; tidak menutup seluruh QA/release/performance #24/#26/#27 dan tidak melakukan deployment.

## Perubahan

`storageLayoutVersion` memisahkan representasi database dari schema semantic `sage-ckg-v1`/`sage-add-v1`. Layout 1 mempertahankan mirror string JSON lama dan pemeriksaan kesamaannya. Layout 2 menyimpan canonicalContent sekali, dengan mirror nodes/edges serta tiga artefak ADD sebagai SQL NULL. Database menolak versi tak dikenal, JSON null, canonical SQL NULL, atau mirror non-null pada layout 2. Teks canonical kosong atau malformed tetap ditolak validator.

Writer baru memakai layout 2 dan tidak menserialisasi mirror. Pembacaan, immutable replay, dan publikasi tetap memeriksa owner, target/config, sumber, hash canonical, counts, serta regenerasi ADD. Format API, result hash dan versi renderer ekspor tidak berubah. Migrasi schema memberi default layout 1 pada baris lama dan tidak membuang mirror otomatis.

## Pemeliharaan operator lokal

`npm run storage:compact` menjalankan **audit**, bukan apply, maksimum 10 analisis secara serial. CLI memakai konfigurasi database dan storage privat yang sama dengan worker. Pada container worker:

```sh
docker compose exec worker node --max-old-space-size=1536 --import tsx scripts/compact-canonical-storage.ts --limit 10
```

Setelah backup dan pemeriksaan audit, gunakan command yang sama dengan `--apply`. `--analysis-id <ID>` membatasi satu analisis; `--limit` menerima 1–100. Output hanya ringkasan jumlah/status/byte, tanpa source atau connection string. Tool ini bukan endpoint pengguna atau scheduler.

Tool membaca archive ACTIVE milik analisis, memverifikasi checksum, dan mereplay canonical CKG/ADD terhadap source. Transaksi mengunci satu analisis terminal, memeriksa kembali tombstone serta konsistensi mirror/hash/target, kemudian mengganti versi dan mirror saja. Canonical content, graph/document/result hash, source, export dan akun tidak ditulis ulang. Satu transaksi mencakup graph dan dokumen; kegagalan tidak mengonversi setengah pasangan. Timestamp hasil dipertahankan. Record aktif, deletion pending, legacy tanpa canonical/source, payload terlalu besar atau corrupt dilewati. Operasi idempotent. Batch memilih ID layout 1 secara terurut; record yang selalu dilewati tetap dapat memenuhi batch awal. Untuk pemeliharaan berikutnya, periksa daftar internal melalui operator dan gunakan `--analysis-id` pada record yang diinginkan; tidak ada cursor otomatis.

Backfill sementara memerlukan memori untuk replay, berbeda dari penggunaan idle aplikasi. Batas total payload tersimpan per analisis 128 MiB (termasuk envelope mirror JSONB yang dihitung konservatif) dan timeout transaksi 60 detik; batch diproses satu per satu. Jalankan pada waktu sepi. Setelah layout 2 digunakan, binary lama yang hanya memahami layout 1 tidak dapat membaca record tersebut; rollback harus memakai reader kompatibel atau backup yang sesuai, bukan sekadar mengganti image lama.

## Pengukuran

Bedakan byte payload logical UTF-8, ukuran relation/TOAST, dan ukuran keseluruhan database. Menghapus mirror melalui UPDATE dapat menyisakan tuple lama; PostgreSQL mendaur ulang ruang melalui vacuum. File database tidak harus langsung menyusut. Tool tidak menjalankan VACUUM FULL atau rewrite database. Lihat [pemeliharaan PostgreSQL 17](https://www.postgresql.org/docs/17/routine-vacuuming.html).

Pengukuran memakai salinan privat database lokal, bukan database kelompok lain. Source volume dipasang read-only, tidak ada secret/source mentah dalam bukti yang di-commit. Backup privat dibuat sebelum migrasi. Audit dan apply berjalan serial pada 6 analisis; semua eligible dan berhasil dikonversi, tanpa skip. Audit ulang menemukan 0 kandidat layout 1.

| Ukuran | Sebelum | Sesudah |
| --- | ---: | ---: |
| Canonical UTF-8 | 106,045,134 byte | 106,045,134 byte |
| Mirror JSON tanpa envelope | 105,445,942 byte | 0 byte |
| Total payload logical | 211,491,076 byte | 106,045,134 byte |
| Seluruh database fisik | 114,783,923 byte | 114,808,499 byte |

Penghematan logical **105,445,942 byte (100.56 MiB; 49.86% dari payload graph/dokumen)**. Angka ini bukan pengurangan RAM atau disk filesystem dengan persentase sama. Ukuran fisik sesudah UPDATE sedikit bertambah karena tuple/migration overhead; tidak ada VACUUM FULL. Fingerprint seluruh kolom selain layout/mirror identik, termasuk canonical, hash, timestamps, owner dan metadata. Jumlah tetap: 2 user, 6 analysis, 6 graph, 2 dokumen, 0 ekspor, 6 storage object. Source replay dilakukan terhadap archive nyata; tidak ada hasil/source yang dihapus. [Bukti agregat](evidence/PERF-01-2026-10-27.json).

## Verifikasi dan batas

Suite terisolasi memakai PostgreSQL 17, Next production, worker dan Chromium. Source baseline pengujian `9fbf97b`; tindak lanjut `533b749` mempertahankan timestamp dan diuji lagi melalui suite storage dan pemeriksaan tipe/lint. Format produk tidak berubah.

| Pemeriksaan | Hasil |
| --- | --- |
| Unit/contract (`npm test`) | 355 pass, 0 fail/skip |
| Database foundation | 8 pass |
| Storage PostgreSQL | 1 pass; audit/apply, CLI, atomic rollback, null constraints, integrity dan timestamp |
| CKG / dokumen / pipeline PostgreSQL | 2 / 1 / 2 pass |
| Markdown / PDF PostgreSQL | 2 / 1 pass |
| Browser Markdown layout 2 | 20 kelompok pass, 390px/1440px |
| Browser PDF layout 2 | 15 kelompok pass, 390px/1440px |
| Production build / lint / typecheck | Pass |
| Review independen PR | Kode storage ditinjau pada remote head; catatan review final tersedia di PR |

Laporan runtime lokal berada pada `artifacts/storage96/run1/markdown-regression/report.json` dan `pdf-regression/report.json` (diabaikan Git). Kedua browser suite memakai compactor nyata pada fixture tervalidasi, API produksi, worker dan unduhan nyata; provider GitHub tetap terkendali, bukan login OAuth live. Markdown fixture sama persis dengan renderer. PDF mempunyai signature/content/download dan alur retry yang lulus; tidak ada klaim perbandingan byte PDF sebelum/sesudah pada database pengguna karena snapshot tidak memiliki ekspor.

Belum dilakukan deployment Coolify, benchmark beban server bersama, penetapan kuota atau backup produksi. Konversi sementara memakai proses Node dengan heap 1536 MiB dan batas container 2 GiB; ini bukan rekomendasi quota tanpa pengukuran. Reader tetap mem-parsing canonical dan memverifikasi source; optimasi ini mengurangi duplikasi penyimpanan dan serialisasi mirror, bukan menyelesaikan seluruh penggunaan memori analyzer/renderer.
