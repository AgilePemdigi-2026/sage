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
