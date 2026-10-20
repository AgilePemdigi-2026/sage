# ANA-03 — Resolver statis JavaScript dan TypeScript

`analyzeReferences(input)` menambahkan relasi statis pada hasil `analyzeDeclarations(input)` tanpa mengubah API maupun perilaku adapter deklarasi yang sudah ada. Input konfigurasi bersifat opsional melalui `configurationSources`; kedua adapter hanya membaca salinan byte yang diberikan pemanggil. Resolver tidak membaca filesystem, mengunduh dependency, memuat plugin, menjalankan source/config, atau memanggil compiler project.

## Matriks kemampuan

| Fakta | Hasil jika bukti statis cukup | Jika tidak cukup |
| --- | --- | --- |
| Hubungan deklarasi-parent yang sudah tercatat | `CONTAINS` exact | — |
| Import/export ESM relatif, termasuk namespace import | Modul dan binding bernama/default/namespace yang ditemukan di snapshot | `EXTERNAL_DEPENDENCY` bila file tidak tersedia; `AMBIGUOUS_SYMBOL` bila lebih dari satu kandidat |
| Pemetaan ekstensi `.js`/`.jsx`/`.mjs`/`.cjs` ke pasangan TS yang didukung, serta index folder | Target tunggal di snapshot | Kandidat ganda unresolved |
| Import alias `baseUrl` dan `paths` dari `tsconfig.json`/`jsconfig.json` bytes | Hanya mapping lokal satu wildcard yang jatuh pada satu file snapshot | Konfigurasi/mapping di luar subset mendapat limitation; target unresolved |
| `require("literal")`, binding properti CJS, dan bentuk assignment `exports`/`module.exports` sederhana | Modul serta simbol lokal yang dapat ditentukan | Dynamic, shadowed, diganti, atau assignment kondisional tetap unresolved |
| Pemanggilan identifier lokal atau binding bernama import | `CALLS` ke satu deklarasi function/method | Shadow, mutasi, overload/target ganda atau receiver yang tidak diketahui tidak dipaksa exact |
| `extends`, `implements`, dan referensi tipe bernama yang dikenal adapter deklarasi | Relasi ke deklarasi class/interface yang tersedia | Built-in diabaikan; type alias, tipe/module, atau binding yang tidak dikenali tidak diinferensikan |
| `new` pada class yang dikenal, `this.member`, static member, dan alias instance tingkat atas `const x = new KnownClass()` | `INSTANTIATES`, `CALLS`, `READS`, atau `WRITES` sesuai member yang unik | Receiver dinamis, member ambigu, shadowed, atau termutasi unresolved |
| Dynamic `import(expr)`/`require(expr)` atau import eksternal | — | `DYNAMIC_LOAD` atau `EXTERNAL_DEPENDENCY` dengan evidence pada token referensi |

Relasi `Exact` hanya dibuat ketika resolver menemukan satu target yang didukung oleh byte source/config yang tersedia. Ambiguitas, shadowing, penugasan ulang yang terdeteksi, ekspor CJS yang diganti, dan receiver tak dikenal menghasilkan `UnresolvedReference`; unresolved bukan klaim bahwa target tersebut tidak ada.

## Konfigurasi dan batas

Resolver menerima file konfigurasi bernama `tsconfig.json`, `jsconfig.json`, `package.json`, atau `composer.json` dalam map input terpisah. Hash byte konfigurasi yang diterima menjadi bagian `provenance.configHash`; konfigurasi tidak menjadi file source CCM. Hanya `compilerOptions.baseUrl` serta `paths` sederhana yang dipakai untuk resolusi JS/TS. Config maksimal 1 MiB diparse; config lebih besar tetap masuk fingerprint dan menghasilkan limitation. Path absolute/URL/drive, traversal keluar snapshot, malformed JSON, target di luar snapshot, dan pola di luar subset tidak dipakai untuk membuat edge exact.

`extends` serta project references tidak dimuat. Resolver tidak membaca `package.json` exports, package manager metadata, `node_modules`, type alias/declaration eksternal, ambient framework types, Babel/Webpack aliases, nested namespace declarations, conditionals runtime, overload resolution, control/data flow umum, callback dispatch, computed property, dynamic object mutation, ataupun prototype/mixin semantics. `paths` belum menerapkan prioritas semantik TypeScript; jika beberapa mapping menghasilkan kandidat, hasil dibuat unresolved. JSX/TSX diparse sebagai source JS/TS, tetapi semantik komponen/framework tidak ditebak.

Source hash dan evidence memakai byte asli, termasuk BOM, CRLF, dan UTF-8 multibyte. Evidence module specifier menunjuk isi literal tanpa tanda kutip; call/property evidence menunjuk token callee/member; dynamic-load evidence menunjuk argumen dinamis. Edge identik dideduplikasi berdasarkan ID fakta/evidence canonical, bukan berdasarkan endpoint saja. Urutan input source/config tidak boleh mengubah canonical JSON atau hash hasil.

## Pengujian terarah

Suite adapter deklarasi dan resolver dijalankan dengan image worker terisolasi, tanpa jaringan dan dibatasi 1 CPU/2 GiB:

```sh
docker run --rm --network none --cpus=1 --cpuset-cpus=0 --memory=2g \
  --mount type=bind,src="$PWD",dst=/workspace --workdir /workspace \
  --entrypoint node sage-worker:local --import tsx --test \
  tests/analyzer-js.test.ts tests/analyzer-js-resolver.test.ts
```

Run lokal terakhir lulus 15/15 test: adapter declarations tetap kompatibel; ESM/CommonJS statis; mapping TS `.js`, `baseUrl`/`paths`; inheritance/type/member/call/constructor; dynamic dan missing imports; shadowing, assignment, CJS replacement, nested `this`; extension ambiguity; BOM/CRLF/Unicode evidence; canary source tidak dieksekusi; konfigurasi absolute dan batas 1 MiB; determinisme urutan serta provenance config. Integrasi akhir lulus lint, typecheck root/web, 202 tes utama dan 8 tes data; 21 fakta oracle independen cocok pada ketiga bahasa. Lihat [laporan integrasi](RESOLVER_CHECKS.md) untuk bukti dan batas benchmark. Dokumen ini mencatat kemampuan adapter, bukan penerimaan end-to-end pipeline produk.
