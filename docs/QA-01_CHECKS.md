# Pemeriksaan oracle dan benchmark QA-01

Tanggal: 21 Oktober 2026. Issue [#4](https://github.com/AgilePemdigi-2026/sage/issues/4), base `04b97c6a1be4c6ff3d378a04f3fa812788879bc4`. Paket ini melengkapi oracle capability, canary berbahaya, review teknis independen dan pengukuran dua repository nyata. Status: bukti teknis tersedia; review/signoff formal tim terhadap manifest masih menunggu.

## Oracle dan hasil pengujian

[Review source independen](QA-01_ORACLE_REVIEW.md) memeriksa 12 fakta seed dan 33 fakta resolver. Tambahan 12 fakta mencakup CommonJS alias, konstruksi dan READ/WRITE TypeScript, ambiguitas ekstensi, serta constructor dan dua occurrence referensi tipe PHP. Fixture resolver berjumlah 18 file / 3.370 byte; seed 15 file / 1.783 byte. Unicode, BOM, CRLF, dynamic load, unknown receiver, dan external dependency tetap tercakup.

| Pemeriksaan aktual | Hasil |
| --- | --- |
| Lint, typecheck root/web, suite utama | PASS; 242/242 tes utama |
| Tes data tanpa database aktif | PASS; 8/8 |
| Integritas seed/resolver | PASS; 12 oracle seed dan 33 fakta resolver |
| Semantik resolver | Ketiga bahasa cocok dengan expected target/reason/span; canonical replay sama |
| Canary JS/TS/PHP | Ketiga unsafe file processed; marker efek samping tetap tidak ada |
| Loader benchmark | Hash/size berubah, path/symlink, bahasa dan batas ukuran ditolak |
| Benchmark repository | 6/6 run sukses; tidak ada timeout/OOM; hash CCM/CKG identik per corpus, termasuk urutan input terbalik |

Full check berjalan pada image `sage-worker:local`, Node 24.22.0, npm 11.17.0, PHP 8.4.26, TypeScript 5.9.3, 1 CPU/2 GiB, tanpa jaringan. Setelah full check, assertion status processed ditambahkan pada tes canary dan tes terfokus itu dijalankan ulang: 1/1 PASS. Verifier tetap melaporkan `semanticAcceptance: NOT_RUN` karena hanya menguji integritas; hasil semantik berasal dari suite integrasi terpisah. Metadata dan fingerprint ada pada [evidence QA-01](evidence/QA-01-2026-10-21.json).

Percobaan awal fixture menemukan batas inferensi receiver instance lokal. Oracle akhir mempertahankannya sebagai unresolved, bukan menambahkan Exact palsu; penjelasan source ada pada laporan review. Percobaan tooling juga memperbaiki validasi ekstensi path benchmark dan dukungan nama route Next.js pada preparer sebelum pengukuran berhasil. Host Node 26 tidak dipakai menjalankan tes/analyzer; preparasi source dan supervisor Docker berjalan pada host, analyzer serta seluruh tes pada Node 24 di Docker.

## Sampel repository dan pengukuran

Source hanya dibaca, tidak dipasang dependency-nya atau dijalankan. Source cache di `storage/benchmarks/` diabaikan Git; yang disimpan adalah manifest path/hash, full commit SHA, kode pengukuran dan data hasil. Corpus SAGE mencakup seluruh 98 source JS/TS tracked di apps/packages pada commit beku, tanpa tests/dependency/generated output. Corpus PHP-Parser mencakup seluruh 271 file lib/PhpParser, termasuk parser generated; sampel ini library class-heavy, bukan aplikasi Laravel atau semua gaya PHP.

| Sampel | Full commit SHA | File / byte | Analisis adapter | Wall container | Peak charged memory container |
| --- | --- | --- | --- | --- | --- |
| AgilePemdigi-2026/sage | `04b97c6a1be4c6ff3d378a04f3fa812788879bc4` | 98 / 596.027 | 4,04–4,39 detik | 5,87–6,70 detik | 429,3–451,2 MiB |
| nikic/PHP-Parser v5.9.0 | `9e33da9553fe7786f0962b35f4e4ecf01be89def` | 271 / 976.412 | 10,63–11,09 detik | 12,12–12,57 detik | 307,3–317,4 MiB |

[Data mentah enam run](evidence/qa01-repository-benchmark-2026-10-21.json) mencatat waktu, Node peak RSS, container `memory.peak`, jumlah node/edge/limitation, hash dan kondisi exit. SAGE menghasilkan 8.937 node/10.817 edge/310 limitation; PHP-Parser 3.602 node/5.694 edge/57 limitation. Kedua adapter berstatus partial secara konsisten; benchmark sukses tidak berarti source seluruhnya didukung atau seluruh relasi benar.

Setiap iterasi memakai container/cgroup baru, 1 CPU, RAM maksimum 2 GiB, swap dimatikan, network none, root read-only, tmpfs 64 MiB dan batas 128 PID. Supervisor menerapkan deadline 180 detik per run dan selalu menghapus container, termasuk jika attached CLI dihentikan. Peak charged memory mencakup charge Node, proses PHP, page cache dan kernel; ini bukan jumlah RSS seluruh proses, dan shared page dapat dibebankan ke cgroup lain. Node peak RSS dicatat terpisah. Tidak ada klaim pengukuran peak RSS khusus PHP. Cache host/VM tidak di-flush.

Waktu adapter mencakup ekstraksi fakta dan canonical CCM; wall time juga mencakup startup, pemuatan/validasi source serta verifikasi CCM/CKG. Keduanya tidak mencakup download GitHub, ekstraksi snapshot, antrean, database, UI atau export. Hasil lama enam fixture sintetis tetap merupakan microbenchmark pada [laporan integrasi resolver](RESOLVER_CHECKS.md), bukan pengganti angka repository nyata ini.

## Reproduksi

Dengan dependency lokal dan image worker sudah tersedia, gunakan Node yang didukung project untuk tooling:

```sh
npm run benchmark:prepare
npm run benchmark:repositories -- --output artifacts/qa01-repository-benchmark.json
npm run check
npm run fixtures:verify
npm run fixtures:verify:resolvers
```

Preparer mengambil dua commit publik yang sudah dipin melalui bare Git fetch tanpa checkout/hook/dependency install, lalu memverifikasi setiap file terhadap manifest. Benchmark berjalan offline pada source cache. Pada worktree yang memakai dependency checkout utama, tambahkan `--dependencies /path/checkout-utama` pada command benchmark. `npm run check` tetap dijalankan pada Node 24 sesuai setup lokal; bukti paket ini memakai Docker dengan bind source, node_modules, generated Prisma dan PHP vendor. Tidak perlu menyalakan Compose/web/database untuk benchmark ini.

## Rekomendasi dan batas penerimaan

Gunakan 1 CPU/2 GiB sebagai profil reproduksi lokal yang sudah diuji pada dua corpus ini. Peak terbesar sekitar 451 MiB bukan dasar untuk menurunkan RAM worker atau menaikkan kapasitas repository: file count/ukuran, kompleksitas, parser, JSON dan CKG tidak selalu tumbuh linear. Pertahankan ceiling snapshot/source yang ada (2.000 file, 100 MiB extracted, 1 MiB/source) sebagai guard awal; **batas tersebut belum terbukti sebagai kapasitas analyzer**. Jangan menaikkannya berdasarkan pengukuran ini. Deadline benchmark 180 detik bukan pengganti deadline produk 300 detik yang integrasinya mengikuti ANA-07.

Belum diuji: repository mendekati ceiling, cold filesystem cache terkontrol, tekanan memory sengaja hingga OOM, dan pipeline produk penuh. Build web, PostgreSQL integration, dan browser E2E tidak dijalankan ulang pada paket QA ini. Layanan aplikasi/database tidak dinyalakan; seluruh container pengukuran/verifikasi telah berhenti.

Manifest tetap draft sampai signoff tim; laporan review otomatis tidak diatribusikan sebagai review manusia. Issue #4 tetap terbuka untuk gate tersebut. #11 dan #14 tidak otomatis ditutup hanya karena benchmark selesai. Source/code fixture tetap data, bukan instruksi untuk dieksekusi.
