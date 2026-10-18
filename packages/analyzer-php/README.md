# `@sage/analyzer-php`

Adapter PHP tahap deklarasi yang mem-parsing byte source melalui proses PHP tepercaya dan `nikic/php-parser` 5.9.0. Source proyek diterima lewat stdin sebagai data; adapter tidak menyertakannya, mengevaluasinya, menjalankan script Composer, membaca konfigurasi proyek, atau memuat autoloader milik repository yang dianalisis. Hanya autoloader parser tepercaya pada package ini yang dimuat.

## API

`parsePhp(source)` tetap tersedia sebagai probe kompatibilitas. Untuk menghasilkan CCM v1, kirim identitas snapshot dan byte file yang persis berasal dari snapshot ke `analyzeDeclarations`:

```ts
import { readFile } from "node:fs/promises";
import { analyzeDeclarations } from "@sage/analyzer-php";

const result = await analyzeDeclarations({
  snapshot: {
    repository: "owner/repository",
    branch: "main",
    commitSha: "0123456789abcdef0123456789abcdef01234567",
  },
  sources: {
    "src/service.php": new Uint8Array(await readFile("src/service.php")),
  },
});

if (!result.ccm) throw new Error(result.errorCode ?? "analysis failed");
```

Hasil memuat CCM v1 yang sudah divalidasi dan dikanonisasi, JSON canonical dan SHA-256, diagnostik per file, serta status. `complete` berarti file PHP dikenali dan semua bentuk deklarasi dalam subset adapter berhasil direpresentasikan. `partial` mencatat syntax error, input yang dikecualikan, deklarasi yang belum didukung, atau construct dinamis. Limitasi resolver tetap dicantumkan meski ekstraksi deklarasi selesai. `failed` berarti tidak ada file PHP yang dapat diproses atau input/CCM gagal divalidasi.

## Subset deklarasi

Adapter mengeluarkan Module file/namespace, class, interface, function, dan method bernama. Import `use` dicatat pada attributes Module sebagai nama sintaksis, alias, jenis (`class`, `function`, atau `const`), serta rentang byte. Namespace dan deklarasi memakai offset AST PHP-Parser dan diperiksa terhadap byte source yang sama oleh `@sage/contracts`. Versi PHP dan parser dicatat dalam provenance.

Property dan constant, trait dan enum, anonymous class/function, deklarasi nested atau conditional, inline HTML, serta include/eval yang dinamis menghasilkan limitation. UTF-8 BOM tepat sebelum tag `<?php` tidak menghilangkan deklarasi PHP sesudahnya. Source dengan syntax error atau UTF-8 tidak valid ditandai gagal dan tidak menyumbang node; file saudara yang valid tetap dapat dianalisis.

Tahap ini tidak mengeluarkan edge. Import, `extends`, `implements`, call, trait composition, dan target include belum di-resolve. Nama pada `use` adalah fakta sintaksis; adapter tidak menambahkan prefix namespace secara semantik atau menebak target. Evidence memakai offset byte UTF-8 berbasis nol dengan batas akhir eksklusif. Baris satu-based dan kolom Unicode code point mengikuti konvensi validator CCM, termasuk CRLF dan byte BOM.

## Checks

Dari root repository, jalankan `npm test` dan `npm run typecheck` pada Node 24. `tests/analyzer-php.test.ts` memeriksa oracle class, import langsung dan grouped untuk class/function/constant, parent IDs, canonical replay, validasi CCM, BOM/CRLF/Unicode, syntax error/UTF-8 invalid, batas construct yang belum didukung, dan kompatibilitas `parsePhp`. Fixture PHP berisi pernyataan `throw` sebagai canary; pemanggilan adapter hanya mem-parse source tersebut.
