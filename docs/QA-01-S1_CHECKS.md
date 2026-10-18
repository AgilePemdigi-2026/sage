# Pemeriksaan oracle minimum QA-01-S1

Tanggal: 18 Oktober 2026, Asia/Jakarta. Issue: [QA-01-S1 #31](https://github.com/AgilePemdigi-2026/sage/issues/31). Requirement: `APP-10`, `NFR-06`. Base implementasi: `f7a2f893c67cbcad784a164d9eea7ace81460d3e`. Full SHA commit perubahan dicatat pada PR branch `test/31-minimum-oracle`.

## Deliverable

Manifest memuat 15 file dengan SHA-256 dan 12 span oracle. JavaScript, TypeScript, dan PHP masing-masing memiliki sedikitnya satu deklarasi, satu referensi, serta limitation yang menunjuk referensi unresolved. Deklarasi `App\Service` PHP ditambahkan dari pembacaan namespace dan source; expected fact tidak diturunkan dari keluaran analyzer.

Verifier menolak hash/snippet yang berubah, koordinat salah atau bukan bilangan bulat hingga, potongan UTF-8 yang terbelah, path traversal/encoding, file duplikat/tidak dikenal, dan symlink yang keluar dari root fixture. Tes BOM memastikan U+FEFF tetap dihitung sebagai karakter pada snippet dan kolom. Source fixture dan konfigurasi executable diperlakukan sebagai data.

## Bukti pengujian

Pengujian aktual berjalan pada Linux arm64, Node 24.22.0 dan npm 11.17.0 di image worker lokal. Manifest dan hasil ringkas tersedia pada [evidence JSON](evidence/QA-01-S1-2026-10-18.json).

| Pemeriksaan | Expected | Actual |
| --- | --- | --- |
| `npm run db:generate` | Client Prisma dapat dihasilkan untuk typecheck | PASS |
| `npm run check` | Lint, typecheck root/web, unit/integrity lulus | PASS, 10/10 tes |
| `npm run fixtures:verify` | Hash, snippet, bounds, posisi, dan cakupan valid | PASS, 15 file / 12 span |
| `git diff --check` | Tidak ada kesalahan whitespace | PASS |

Untuk mengulang setelah instalasi dependency terkunci pada Node 24, jalankan `npm run db:generate`, `npm run check`, lalu `npm run fixtures:verify`. Command verifikasi Docker yang dipakai:

```sh
docker run --rm --network none \
  --mount type=bind,src="$PWD",dst=/workspace \
  --workdir /workspace --entrypoint npm sage-worker:local run check

docker run --rm --network none \
  --mount type=bind,src="$PWD",dst=/workspace \
  --workdir /workspace --entrypoint npm sage-worker:local run fixtures:verify
```

Image worker dibangun melalui setup lokal; dependency pengembangan pada checkout diperlukan untuk `check`. Pemeriksaan awal menemukan error narrowing TypeScript; pemeriksaan ulang setelah perbaikan lulus. Kasus BOM juga diperbaiki dan dijaga tes regresi.

## Review dan batas kesimpulan

Penanggung jawab/pengirim paket: Zarra (`zarrrafirdaus`). Verifier aktual: script integritas dan Node test runner melalui command di atas. Pemeriksaan teknis serta merge oleh Iltizam (`iltizamhasan3`) masih menunggu PR; tidak ada klaim review manusia sudah dilakukan. Manifest tetap `DRAFT_AWAITING_TEAM_REVIEW` dengan `reviewedBy: null` sampai pemeriksaan itu selesai.

T-ANA-03/T-ANA-04 pada paket ini hanya mencakup penyiapan oracle dan integritas evidence; acceptance semantik adapter/CCM/graph tetap `NOT_RUN`. Benchmark representatif, capability tambahan, dan fixture keamanan lebih luas tetap pada parent [QA-01 #4](https://github.com/AgilePemdigi-2026/sage/issues/4). Issue #31 dan parent tetap terbuka selama review penerimaan belum selesai.
