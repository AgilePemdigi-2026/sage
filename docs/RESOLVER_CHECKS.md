# Verifikasi integrasi resolver statis

Tanggal: 21 Oktober 2026. Kode integrasi: `07c9b784a860a75011c142cedbc5f48a1be872ec`. Paket ini mengintegrasikan ANA-03 (#12) dan ANA-04 (#13) dengan worker, serta memperluas oracle QA-01 (#4). Capability dan batas masing-masing adapter dicatat pada [JS/TS](ANA-03_CHECKS.md) dan [PHP](ANA-04_CHECKS.md).

## Hasil aktual

| Pemeriksaan | Hasil |
| --- | --- |
| `npm run check`: ESLint dan typecheck root/web | PASS tanpa warning |
| Tes utama | 202/202 PASS |
| Tes data tanpa database aktif | 8/8 PASS |
| Verifier seed | 15 file / 12 oracle, integritas PASS |
| Verifier resolver | 6 file / 21 fakta yang diharapkan, integritas PASS |
| Tes semantik `tests/resolver-integration.test.ts` | 3/3 bahasa, seluruh 21 fakta cocok kind, source, target/reason dan span; tidak ada target/resolusi yang bertentangan pada site yang diuji |
| Replay | Urutan input dibalik, JSON round-trip dan hash canonical tetap sama |
| Worker | Relasi dua adapter dipertahankan, config mengubah target/hash, snapshot disalin sebelum await, unresolved/limitation menghasilkan partial |
| Review | Temuan binding/mutasi JS dan receiver/akses/identitas PHP diperbaiki; tidak ada temuan material tersisa pada subset yang didokumentasikan |

Lingkungan: image `sage-worker:local`, Node 24.22.0, PHP 8.4.26, TypeScript 5.9.3. Container sementara memakai `--network none --cpus=1 --cpuset-cpus=0 --memory=2g`. Source/config target tidak dieksekusi; canary throw tetap diparse sebagai data. Layanan aplikasi/database tidak dinyalakan.

Perintah yang dijalankan pada lingkungan tersebut:

```sh
npm run check
npm run fixtures:verify
npm run fixtures:verify:resolvers
node --import tsx scripts/benchmark-resolvers.ts
```

Verifier integritas melaporkan `semanticAcceptance: NOT_RUN` karena tidak memanggil adapter. Penerimaan semantik di atas berasal dari suite integrasi terpisah. Manifest tetap `DRAFT_AWAITING_TEAM_REVIEW`; review formal tim dan benchmark repository representatif belum diterima untuk seluruh QA-01. Koreksi oracle sebelumnya berdasarkan pemeriksaan source: span call `normalize` harus menunjuk pemanggilan, dan PHP use mencakup nama qualified lengkap yang tertulis.

## Microbenchmark

[Data mentah benchmark](evidence/resolver-benchmark-2026-10-21.json) mencatat tiga iterasi per adapter, fingerprint fixture, waktu, RSS proses pemanggil, jumlah node/edge dan hash hasil. Status adapter `partial` memang diharapkan karena fixture memuat target unknown/dynamic/external; status benchmark `COMPLETE` berarti seluruh pengukuran menghasilkan CCM berisi array node/edge dengan errorCode null. Benchmark sendiri tidak menetapkan kebenaran semantik.

| Adapter | File / ukuran input | Rentang waktu | RSS Node sesudah call | Node / edge |
| --- | --- | --- | --- | --- |
| `@sage/analyzer-js` | 4 / 1175 byte | 20.79–57.45 ms | 212.9–219.6 MiB | 31 / 41 |
| `@sage/analyzer-php` | 2 / 598 byte | 48.15–102.49 ms | 219.8–220.1 MiB | 15 / 10 |

Hash keluaran sama untuk ketiga iterasi setiap adapter. Sampel ini hanya 1.773 byte pada enam file sintetis, bukan repository nyata atau SLA. RSS bukan peak dan tidak mencakup proses anak PHP; beban container lain dan kondisi cache belum dikontrol sebagai eksperimen performa representatif.

## Batas penerimaan

Adapter statis dan integrasi source worker teruji sesuai capability matrix. Ini tidak mengaktifkan consumer queue, persistensi CKG, graph hasil nyata, generator dokumen atau ekspor. Penerimaan alur produk tetap mengikuti issue pipeline/CKG dan E2E terpisah. QA-01 tetap terbuka untuk review tim, cakupan tambahan dan performa representatif; kontrak ANA-05 tetap mengikuti acceptance parent-nya sendiri.
