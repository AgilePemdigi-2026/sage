# Pemeriksaan kontrak minimum ANA-05-S1

Tanggal: 18 Oktober 2026, Asia/Jakarta. Issue [#32](https://github.com/AgilePemdigi-2026/sage/issues/32); requirement `NFR-01`, `NFR-02`, `NFR-08`, `SAGE-FR-ANA-05`. Base: `ca7827406e1170d07298210c6993d94b25a27568`; full SHA implementasi dicatat pada PR. Penanggung jawab/pengirim: Iltizam (`iltizamhasan3`); review penerimaan PR masih menunggu.

Package `@sage/contracts` menyediakan registry, tipe CCM v1, validator runtime, ID deterministik, serialisasi canonical, dan hash konten. Payload diperiksa bersama byte snapshot yang diberikan terpisah, sehingga metadata hash tidak menjadi satu-satunya bukti. Contoh JSON valid dan source pendamping tersedia di package; source dibaca sebagai data dan tidak dieksekusi.

Pengujian aktual memakai Node 24.22.0 dan npm 11.17.0 pada Docker Linux arm64. `npm run check` lulus lint, typecheck root/web, serta **17/17 tes**, termasuk tujuh kelompok kontrak baru. `git diff --check` juga lulus. Hasil terstruktur dan SHA-256 file uji tersedia pada [evidence JSON](evidence/ANA-05-S1-2026-10-18.json).

| Pemeriksaan | Expected | Actual |
| --- | --- | --- |
| Payload contoh + byte source | Struktur dan evidence valid | PASS |
| ID duplikat, edge/parent menggantung dan siklus parent | Ditolak dengan kode stabil | PASS |
| Hash/ukuran source, posisi/bounds keliru, registry/resolution salah | Ditolak | PASS |
| Unicode/CRLF | Offset UTF-8 dan kolom code point cocok | PASS |
| Koleksi dan key object diurut ulang | ID, JSON canonical dan hash sama | PASS |
| Metadata job atau properti tersembunyi | Ditolak, tanpa menghilangkan field wajib diam-diam | PASS |

Ulangi `npm ci`, `npm run db:generate`, lalu `npm run check` dengan Node 24 pada checkout branch ini. Command pemeriksaan Docker yang dijalankan:

```sh
docker run --rm --network none \
  --mount type=bind,src="$PWD",dst=/workspace \
  --workdir /workspace --entrypoint npm sage-worker:local run check
```

Image worker lokal berasal dari setup fondasi; dependency pengembangan checkout diperlukan. Konvensi ID, sorting, posisi evidence, dan kode error dijelaskan pada [README contracts](../packages/contracts/README.md). Review independen menemukan properti non-enumerable dapat hilang saat clone; validator diperbaiki dan kasus tersebut dijaga tes regresi.

T-ANA-04 pada paket ini menerima kontrak minimum dan integritas source/evidence, bukan semantik parser/resolver atau canonical CKG produk. Hardening lintas bahasa, capability lengkap, resource limits, persistensi, dan integrasi adapter tetap pada parent [ANA-05 #11](https://github.com/AgilePemdigi-2026/sage/issues/11). Verifier aktual adalah Node test runner/TypeScript/ESLint melalui command di atas; review manusia serta merge tidak diklaim sudah dilakukan.
