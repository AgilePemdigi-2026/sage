# ANA-04-S1 PHP declaration adapter

Scope: extract PHP namespace, `use` import, class, interface, function, and method declarations into CCM v1 from the exact source bytes supplied by the caller. The trusted parser reads stdin as data. Repository source is never included or evaluated, Composer scripts are not run, and project configuration is not loaded. Import facts retain their syntactic name, alias, kind, and byte span; this stage emits no resolver edges.

## Acceptance checks

| Check | Expected result |
| --- | --- |
| Existing `parsePhp(source)` callers | Probe API continues to return parser version, syntax status, statement kinds, and diagnostics |
| PHP declaration oracle | `App\Service` contains the independent class-header byte range |
| Namespace and imports | Namespace modules retain class/function/constant import names, aliases, kinds, and source byte ranges |
| Other declarations | Interfaces, functions, and methods have stable names, parent IDs, and AST-derived byte spans |
| CCM integrity | Emitted payload validates against the same copied snapshot byte map |
| Repeatability | Reordering source-map keys produces identical canonical JSON and content hash |
| Source positions | UTF-8 BOM, CRLF, accented identifiers, and supplementary Unicode preserve validator-valid byte positions |
| Parse failure | Invalid syntax and invalid UTF-8 mark only the affected file failed and emit no declarations from it |
| Unsupported constructs | Traits, enums, anonymous classes/functions, properties, constants, dynamic include/eval, nested declarations, and inline HTML are explicit limitations |
| Resolver boundary | No inheritance, implementation, import, call, or include edge is fabricated |

Focused tests are in [`../tests/analyzer-php.test.ts`](../tests/analyzer-php.test.ts). The parser runner is [`../packages/analyzer-php/bin/declarations.php`](../packages/analyzer-php/bin/declarations.php); it requires only the locked `nikic/php-parser` dependency already declared by the package. Run `npm test` and `npm run typecheck` with the project Node 24 runtime.

This S1 stage does not claim complete PHP language coverage, property extraction, semantic alias resolution, inheritance/call resolution, safe execution of arbitrary project configuration, or end-to-end repository analysis. Traits, enums, anonymous/dynamic constructs, and inline HTML are reported as limitations for later work.

## Hasil aktual 19 Oktober 2026

Base implementasi: `0247fe5`. Identitas commit mengikuti penanggung jawab issue, `zarrrafirdaus`; pemeriksaan kode, review terpisah, dan tes di bawah dilakukan secara otomatis, bukan klaim review manual anggota.

| Pemeriksaan | Expected | Actual |
| --- | --- | --- |
| `npm run check` dalam Docker | Lint, typecheck, dan seluruh suite lulus | PASS; 37 tes utama (8 grup PHP) + 8 tes database, 0 gagal |
| PHP lint trusted runner | Tidak ada syntax error pada parser runner | PASS |
| Runtime worker + paket PHP bind readonly | Import adapter dan parsing namespace/class/method berhasil | PASS; CCM 4 node, status complete |
| Oracle minimum | Class `App\Service` sesuai rentang/snippet source independen | PASS |
| Import metadata | Normal/grouped `use`, function/const, alias, dan bounds benar | PASS |
| Source positions | Byte BOM/CRLF/Unicode dan lokasi method tetap cocok source | PASS |
| Failure/limitation | Syntax/UTF-8 invalid terisolasi; trait/enum/property/promoted property/conditional/inline HTML/short tag eksplisit | PASS |
| Parent dan canonical replay | Method terikat class berdasarkan bounds; urutan input tidak mengubah JSON/hash | PASS |

Lingkungan penerimaan: Linux arm64, Node.js 24.22.0, PHP 8.4.26, `nikic/php-parser` 5.9.0. SHA-256 manifest fixture tetap `41697b000ef84741303d82828740fcfb6cd0c0a52355dfd2b742bf94c3a54148`. Identitas snapshot pada tes adalah fixture sintetis eksplisit.

Pemeriksaan kode memperbaiki jenis `use function`/`use const`, identitas parent berdasarkan bounds, limitation untuk properti promosi, dan pelaporan short tag yang bergantung konfigurasi runtime. Pengujian akhir tidak menemukan kegagalan tersisa. Image dasar berasal dari build #33; paket PHP terbaru diuji dengan bind readonly, bukan klaim rebuild image produksi baru atau analisis remote.

Parent #13 tetap terbuka. Resolver namespace/member/inheritance/Composer statis, source repository nyata, dan pipeline end-to-end belum diterima oleh paket ini.
