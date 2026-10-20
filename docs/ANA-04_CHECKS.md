# Pemeriksaan resolver PHP ANA-04

## API dan batas eksekusi

`@sage/analyzer-php` mempertahankan `analyzeDeclarations(input)` untuk deklarasi dan menambah `analyzeReferences(input)` untuk relasi statis. Parser tepercaya membaca byte source dan konfigurasi snapshot; source PHP, include, eval, Composer scripts, dependency installer dan autoloader milik target tidak dijalankan.

Implementasi berada pada `packages/analyzer-php/src/index.ts` dan ekstraksi AST pada `packages/analyzer-php/bin/declarations.php`. Setiap relasi mempunyai evidence `reference`, status `Exact` atau `Unresolved`, dan ID deterministik. Target `Exact` memerlukan satu deklarasi unik dari source yang benar-benar diparse.

## Capability matrix

| Bentuk source | Perilaku |
| --- | --- |
| `use` class/function, alias dan grouped imports | Memakai aturan namespace PHP; simbol eksternal tetap mempunyai edge `IMPORTS` unresolved. Konstanta impor belum didukung sebagai target deklarasi. |
| `extends`, `implements`, tipe bernama, `instanceof`, catch | Mengacu deklarasi class/interface unik yang tersedia. |
| `new KnownClass()` | Edge `INSTANTIATES` ke deklarasi class unik. |
| Pemanggilan fungsi bernama | Fungsi namespace lalu fallback global sesuai PHP; nama dinamis tetap unresolved. |
| Pemanggilan method statis | Deklarasi method unik dari class yang disebut dan rantai parent yang didukung; ekspresi dinamis/ambigu tetap unresolved. |
| `$this->method()` dan receiver dengan satu tipe bernama | Exact hanya ketika dispatch dibatasi class/method final atau method private. Union/intersection tidak dipakai untuk menebak receiver. Variabel yang ditimpa atau terikat referensi/loop kehilangan inferensi tipe. |
| Property instance/statis | Mode resolver menambah node property dan edge baca/tulis sesuai staticness deklarasi; kasus dinamis atau ambigu tetap unresolved. |
| Parent method/property | Mengikuti rantai parent berbasis deklarasi yang unik; hubungan ambigu/tidak dapat diakses tetap unresolved. |
| Composer PSR-4 / `autoload-dev` | Membaca JSON melalui `configurationSources` yang dibatasi; petunjuk path tidak cukup untuk Exact tanpa deklarasi parsed unik. |

## Keterbatasan

Trait/composition, enum, deklarasi konstanta, anonymous class/function, deklarasi nested/conditional, nama dinamis, dynamic include/require dan eval belum diselesaikan. PSR-0, Composer classmap dan `autoload.files` tidak diinterpretasi atau dieksekusi dan dicatat sebagai limitation. Target unknown, eksternal, dinamis atau ambigu tetap unresolved dan hasil menjadi partial. Syntax/UTF-8 invalid menggagalkan file terkait; sibling valid tetap dipertahankan.

Byte source, konfigurasi dan identitas snapshot disalin sebelum pekerjaan parser asynchronous. Hash konfigurasi dan versi resolver masuk provenance. API deklarasi lama tetap menghasilkan bentuk deklarasi tanpa edge resolver.

## Verifikasi

Tes pada `tests/analyzer-php.test.ts` dan `tests/analyzer-php-resolver.test.ts` memeriksa alias/namespace lintas file, inheritance, tipe, pemanggilan, property, Composer statis, simbol duplikat, unknown/dynamic dispatch, receiver yang berubah, identitas placeholder, BOM/CRLF/Unicode, replay canonical, abort/failure dan canary throw yang hanya diparse.

Perintah pada runtime Node/PHP yang didukung:

```sh
node --import tsx --test tests/analyzer-php.test.ts tests/analyzer-php-resolver.test.ts
php -l packages/analyzer-php/bin/declarations.php
npm run check
```

Run terarah pada image `sage-worker:local`, Node 24.22.0/PHP 8.4.26, tanpa jaringan dan batas 1 CPU/2 GiB lulus **18/18 tes PHP**, syntax check PHP dan typecheck root. Pemeriksaan repository pada branch PHP lulus lint, typecheck root/web, **190/190 tes utama** dan **8/8 tes data**. Run integrasi berikutnya lulus **16/16 tes gabungan** (21 fakta oracle independen untuk JS/TS/PHP, replay canonical dan worker); source/config target tidak dieksekusi. Pengujian adapter tidak membuktikan queue consumer atau alur produk lengkap telah aktif.

Integrasi akhir dengan JS/TS dan worker lulus **202/202 tes utama**, **8/8 tes data**, lint dan typecheck root/web. Lihat [laporan integrasi](RESOLVER_CHECKS.md) untuk bukti semantik 21 fakta oracle, pengukuran dan batas penerimaan.
