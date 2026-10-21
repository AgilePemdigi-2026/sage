# Pemeriksaan hardening kontrak CCM ANA-05

Tanggal: 21 Oktober 2026, Asia/Jakarta. Refs [#11](https://github.com/AgilePemdigi-2026/sage/issues/11); requirement `SAGE-FR-ANA-05`, `NFR-01`, `NFR-02`, `NFR-08`. Base implementasi: `4c93f5dcbebb9edc6a47881ca380c14e26423b5b`. Penanggung jawab: Iltizam (`iltizamhasan3`). Paket ini melanjutkan kontrak minimum [ANA-05-S1](ANA-05-S1_CHECKS.md).

## Perubahan dan acceptance yang diuji

Validator mempertahankan schema v1, tujuh kategori node, ID deterministik, dan format canonical yang sama. Validasi diperketat agar hasil yang diterima tidak kehilangan properti tersembunyi ketika diserialisasi dan deklarasi tidak menyatakan containment yang bertentangan dengan source.

| Pemeriksaan | Expected | Actual |
| --- | --- | --- |
| Array sparse, properti tambahan/symbol, elemen non-enumerable/getter, prototype khusus | Ditolak sebelum getter/iterator dijalankan | PASS |
| Peta byte source dengan getter | Ditolak tanpa memanggil getter, termasuk canonicalization | PASS |
| UTF-8 invalid pada file processed tanpa evidence | Ditolak meskipun hash/ukuran benar | PASS |
| Bounds anak di luar deklarasi parent | `CCM_NODE_PARENT_BOUNDS_INVALID` | PASS |
| Rantai parent 12.000 node, dimulai dari anak terdalam | Valid tanpa kegagalan stack; siklus tetap ditolak | PASS |
| Edge CONTAINS tidak sesuai parent/resolution/evidence deklarasi | `CCM_EDGE_CONTAINMENT_INVALID` | PASS |
| Preview graph source-backed | Rentang class/member lengkap; containment memakai deklarasi anak | PASS |
| Output deklarasi gabungan PHP/JS/TS setelah JSON round-trip | Evidence literal BOM/CRLF/Unicode dan hash canonical tetap sama | PASS |
| Byte source, ID, atau bounds diubah pada payload hasil adapter | Ditolak di batas konsumsi | PASS |
| Source gagal parse dan binary excluded berdampingan dengan source valid | CCM parsial tetap valid; byte excluded tetap diverifikasi hash/ukurannya | PASS |

`tests/contracts.test.ts` memuat **13 tes**, termasuk enam kelompok regresi baru. Enam kelompok tersebut juga dijalankan pada salinan validator sebelum perubahan dan semuanya gagal sebagaimana diharapkan. Pengujian rantai dalam membalik urutan node agar traversal benar-benar dimulai dari node terdalam.

Pemeriksaan menyeluruh sempat menemukan dua kegagalan pada fixture graph lama: lokasi class hanya memuat namanya dan containment memakai evidence reference. Fixture diperbaiki menjadi rentang deklarasi penuh dan ditambahkan assertion isi class serta evidence containment. Pemeriksaan berikutnya lulus. Kesalahan anotasi tipe pada tes integrasi baru juga diperbaiki sebelum hasil akhir di bawah dicatat.

## Lingkungan dan hasil aktual

Linux arm64, Node **24.22.0**, npm **11.17.0**, PHP **8.4.26**, TypeScript **5.9.3**. Pemeriksaan memakai image worker lokal dan dependency checkout terkunci; identitas image serta hash file kode/tes ada pada [evidence JSON](evidence/ANA-05-2026-10-21.json).

Command yang dijalankan dari root repository:

```sh
docker run --rm --network none --cpus=1 --cpuset-cpus=0 --memory=2g \
  --mount type=bind,src="$PWD",dst=/workspace \
  --workdir /workspace --entrypoint npm sage-worker:local run check

docker run --rm --network none --cpus=1 --cpuset-cpus=0 --memory=1g \
  --mount type=bind,src="$PWD",dst=/workspace \
  --workdir /workspace --entrypoint npm sage-worker:local run fixtures:verify

git diff --check
```

Hasil akhir: lint PASS, typecheck root/web PASS, **176/176 tes utama PASS**, **8/8 tes data PASS**, dan integritas **15 file / 12 oracle PASS**. Tidak ada source target yang dieksekusi atau dependency target yang diinstal. Container verifikasi bersifat sementara dan telah berhenti; layanan web/database tidak dinyalakan untuk paket ini.

Review kode terpisah tidak menemukan temuan material setelah perbaikan fixture. Ini bukan klaim persetujuan manusia dari anggota tim.

## Batas kesimpulan dan handoff

Issue #11 tetap terbuka. Paket ini membuktikan hardening struktur dan kompatibilitas output deklarasi dua adapter, bukan kelengkapan semantik resolver atau acceptance oracle QA-01. Manifest fixture tetap `DRAFT_AWAITING_TEAM_REVIEW`; verifier integritas melaporkan `semanticAcceptance: NOT_RUN`.

`TypeAlias`, `Enum`, dan `Trait` tetap dicatat sebagai keterbatasan sampai spike taxonomy diterima. Resolver lengkap #12/#13, canonical CKG/persistensi #14, pipeline produk #16, benchmark/resource limits seluruh job, dan replay end-to-end memerlukan bukti tersendiri. Kontrak ini bukan sandbox untuk JavaScript Proxy atau object executable yang tidak dipercaya. Build produksi, integrasi PostgreSQL nyata, dan browser E2E tidak dijalankan ulang untuk paket ini.

## Pembaruan integrasi 21 Oktober 2026

Dua resolver statis kini menghasilkan CCM yang cocok dengan 21 fakta oracle independen, termasuk target/reason, evidence dan replay canonical. Full check integrasi lulus 202 tes utama dan 8 tes data; lihat [RESOLVER_CHECKS](RESOLVER_CHECKS.md). Bukti hardening di atas tetap berlaku. Issue ANA-05 dan QA-01 mengikuti acceptance parent-nya sendiri; review formal manifest serta benchmark repository representatif belum dinyatakan selesai.

## Spike taxonomy dan regresi ID edge — 21 Oktober 2026

Base integrasi: `118156fd649766f906b9e8361701fbbe35cb4f4d` (sesudah canonical CKG). Paket ini menambahkan satu regresi validator/canonicalizer untuk ID edge Exact dan Unresolved palsu, serta dua tes kompatibilitas taxonomy. Tidak ada perubahan registry atau kemampuan parser yang diklaim. [Hasil spike](CCM_TAXONOMY_SPIKE.md) memetakan konstruksi source ke kind atau limitation, alasan kompatibilitas, dan syarat perluasan.

Pengujian memakai image worker lokal Node 24.22.0, PHP 8.4.26, npm 11.17.0, TypeScript 5.9.3; container sementara dibatasi 1 CPU/2 GiB tanpa jaringan. Worktree dipasang di `/workspace`, dependency root `node_modules`, generated Prisma, serta PHP `vendor` dipasang pada lokasi paket yang sama. Command aktual di dalam lingkungan tersebut:

```sh
node --import tsx --test tests/contracts.test.ts
node --import tsx --test tests/taxonomy-compatibility.test.ts
npm run check
npm run fixtures:verify
npm run fixtures:verify:resolvers
git diff --check
```

Hasil: 14/14 tes kontrak, 2/2 tes taxonomy, lint dan typecheck root/web PASS, **237/237 tes utama dan 8/8 tes data PASS**, integritas seed 15 file/12 oracle dan resolver 6 file/21 fakta PASS. Tes taxonomy membuktikan limitation per path/stage/reason, sibling yang didukung, tidak adanya deklarasi/member palsu dari konstruksi unsupported, serta canonical CCM/CKG yang tetap sama setelah JSON round-trip dan pengubahan urutan input. Fingerprint kode/tes ada pada [evidence taxonomy](evidence/ANA-05-taxonomy-2026-10-21.json).

Percobaan awal tes terfokus PHP belum memasang dependency vendor pada worktree; setelah dependency dipasang, tes lulus. Ini kegagalan konfigurasi pengujian, bukan kegagalan parser. Tidak ditemukan bug analyzer baru pada subset yang diuji. Build web, PostgreSQL nyata, browser E2E, dan benchmark representatif tidak dijalankan ulang karena perubahan hanya menambah bukti kontrak/taxonomy dan dokumentasi. Layanan aplikasi/database tidak dinyalakan dan container verifikasi sudah berhenti.

Issue #11 tetap terbuka untuk gate QA-01: manifest oracle masih `DRAFT_AWAITING_TEAM_REVIEW`, review formal tim dan benchmark repository representatif belum diterima. Status verifier integritas `semanticAcceptance: NOT_RUN` tetap benar; bukti semantik berasal dari tes terpisah. Review PR independen tidak disebut sebagai review manusia tim atau penerimaan penuh QA-01.

## Pembaruan dependency QA-01 — 21 Oktober 2026

QA-01 kini menyediakan 33 fakta resolver source-backed, canary processed tanpa efek samping, review teknis independen serta enam run benchmark dua corpus repository nyata; lihat [hasil QA-01](QA-01_CHECKS.md). Gate yang tersisa adalah signoff formal tim pada manifest; tidak lagi menyatakan benchmark dua corpus belum dijalankan. Pengukuran tersebut tetap bukan bukti kapasitas dekat ceiling atau pipeline E2E. Penerimaan parent tidak ditutup otomatis.
