# Review teknis oracle QA-01

Tanggal: 21 Oktober 2026. Metode: pemeriksa independen membaca source dan deklarasi target secara langsung, tanpa memakai keluaran analyzer sebagai expected truth. Ini review teknis otomatis, bukan signoff manusia dari anggota tim. Manifest tetap `DRAFT_AWAITING_TEAM_REVIEW`; paket ini menyiapkan bahan penerimaan tim.

Seluruh **12 fakta seed dan 33 fakta resolver** cocok dengan source pada fingerprint berikut. Hash file, ukuran, literal evidence, batas UTF-8 serta posisi baris/kolom diperiksa terpisah dari eksekusi analyzer.

| Artefak | SHA-256 |
| --- | --- |
| Manifest seed | `41697b000ef84741303d82828740fcfb6cd0c0a52355dfd2b742bf94c3a54148` |
| Agregat 15 file seed, 1.783 byte | `de56c110d7ddd3cc0a68c0b4af78589a88c097e43663bc3fef1ae5ecb63138f4` |
| Manifest resolver | `5906d49bb123c69c957ea579d20b5c1273f64b302d05f0be1f1a4f7b3214058c` |
| Agregat 18 file resolver, 3.370 byte | `d661adb9df0e6f5b81319d0e522642e2e8dd2a2d065996062d0bf5d11141fae8` |

Agregat adalah SHA-256 atas baris `path + NUL + sha256` yang diurutkan, digabung LF tanpa LF penutup. Verifier integritas tidak menjalankan analyzer; penerimaan semantik otomatis berasal dari `tests/resolver-integration.test.ts`.

## Seed

| Indeks | Putusan | Dasar source |
| --- | --- | --- |
| 1 | PASS | Widget dideklarasikan sebagai class yang extends Base |
| 2 | PASS | render memanggil binding impor decorate dari base.js |
| 3 | PASS | import(name) memakai nilai runtime |
| 4 | PASS | require literal menunjuk legacy.cjs yang tersedia |
| 5 | PASS | Identifiable merupakan interface dengan property id |
| 6 | PASS | Service implements interface Identifiable yang diimpor |
| 7 | PASS | Cast struktural receiver unknown tidak membuktikan implementasi run |
| 8 | PASS | Service extends Contracts/Base melalui use |
| 9 | PASS | Tipe object tidak menentukan implementasi run |
| 10 | PASS | Deklarasi café dan literal Unicode sesuai source |
| 11 | PASS | Span konteks judul sesuai literal, bukan klaim CCM Property |
| 12 | PASS | Header class App/Service sesuai source |

Seed adalah representasi oracle awal, bukan payload CCM v1. Nilai legacy `resolved`/`unresolved`, kind `Unresolved`/`SourceSpan`, dan header span luas pada fakta 6/8 tidak boleh diperlakukan sebagai oracle edge CCM token-exact.

## Resolver

| ID fakta | Putusan dan dasar |
| --- | --- |
| js-import-module-format | PASS — specifier literal menunjuk format.js |
| js-import-symbol-normalize | PASS — named import menunjuk export normalize |
| js-call-render-normalize | PASS — binding impor tidak tertimpa pada call ini |
| js-call-invoke-exercise | PASS — invoke memanggil export exercise |
| js-call-unknown-receiver | PASS — parameter target tidak menentukan run |
| js-dynamic-import | PASS — specifier merupakan parameter runtime |
| js-shadowed-parameter-call | PASS — parameter lokal menimpa binding impor |
| js-import-unavailable-symbol | PASS — file impor tidak tersedia |
| js-call-unavailable-symbol | PASS — target call bergantung pada impor yang tidak tersedia |
| ts-import-symbol-base | PASS — pasangan source model.ts menyediakan export Base |
| ts-extends-base | PASS — Endpoint extends binding class Base |
| ts-implements-payload | PASS — Payload adalah interface import type |
| ts-type-reference-payload | PASS — parameter handle memakai Payload |
| ts-call-describe | PASS — call menunjuk function impor describe |
| ts-call-unknown-receiver | PASS — cast unknown tidak membuktikan target method |
| php-import-base | PASS — use menunjuk class Resolver/Contracts/Base |
| php-extends-base | PASS — Endpoint extends alias impor Base |
| php-implements-payload | PASS — Payload menunjuk interface yang tersedia |
| php-call-describe | PASS — use function menentukan binding call |
| php-call-unknown-receiver | PASS — parameter object tidak menentukan run |
| php-import-unavailable-class | PASS — Missing tidak dideklarasikan |
| js-cjs-alias-module | PASS — literal menunjuk legacy.cjs |
| js-cjs-import-aliased-symbol | PASS — destructuring normalize: clean menetapkan alias lokal |
| js-cjs-call-aliased-symbol | PASS — call clean mengarah export normalize |
| ts-construct-record-node | PASS — new RecordNode memakai impor class yang tersedia |
| ts-ambiguous-extensionless-module | PASS untuk kebijakan konservatif SAGE — tersedia kandidat .ts/.mts/.cts |
| php-instantiate-imported-base | PASS — grouped use menetapkan binding Base |
| php-check-payload-parameter | PASS — parameter memakai interface Payload |
| php-check-payload-return | PASS — occurrence return menunjuk interface yang sama |
| ts-write-record-label | PASS — assignment this.label menunjuk property class |
| ts-read-record-label | PASS — return this.label membaca property yang sama |
| ts-write-local-record-label-unresolved | PASS sebagai batas adapter — inferensi instance binding lokal belum didukung |
| ts-read-local-record-label-unresolved | PASS sebagai batas adapter — batas inferensi yang sama |

Dua fakta instance lokal terakhir tidak menyatakan receiver ditimpa: hanya property `local.label` yang ditulis. Analyzer yang lebih lengkap dapat mengetahui class dari source tersebut; `UNKNOWN_RECEIVER` menyatakan batas implementasi sekarang. Ambiguitas ekstensi juga merupakan kebijakan konservatif SAGE, bukan klaim prioritas resolusi native TypeScript.

## Canary dan perbaikan hasil review

Source canary JS/TS memuat `writeFileSync`, sedangkan PHP memuat `file_put_contents`, dengan path marker unik dari environment. Semuanya juga memuat top-level throw. Tes memastikan marker tetap tidak ada setelah analyzer selesai, sekaligus memastikan ketiga unsafe file berstatus `processed` agar file yang diam-diam dilewatkan tidak menghasilkan pass palsu. Pemeriksaan status processed ditambahkan setelah temuan review dan tes terfokusnya lulus.

Source target tidak dijalankan untuk menguji canary. Environment marker diteruskan ke subprocess PHP. Kasus ini menguji parse-only dan efek samping file; bukan sandbox universal atau pengujian semua bentuk network/exec. Archive traversal/symlink, ekspansi ukuran, binary/UTF-8, dan interruption mengikuti suite snapshot/source/stage yang terpisah.

Audit tidak menyatakan seluruh edge yang mungkin ada sudah terdaftar. Manifest yang direview harus tetap cocok dengan fingerprint di atas; perubahan berikutnya membutuhkan review ulang.
