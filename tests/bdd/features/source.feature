# language: id
Fitur: Pemindaian source statis Sprint 1
  Analisis membaca byte snapshot dan menjalankan adapter JavaScript/TypeScript serta PHP yang tersedia.
  Hasil awal ini memeriksa domain analyzer; bukan penerimaan pipeline produk lengkap.

  @sprint1 @US_AnalyzeSource @SAGE_FR_ANA_04 @issue_33 @issue_34 @domain @controlled
  Skenario: Adapter JavaScript dan PHP menghasilkan CCM yang dapat divalidasi
    Dengan snapshot immutable berisi source berikut:
      | path                | source                                                               |
      | src/App.js          | export class App {}                                                   |
      | src/Contract.php    | <?php namespace Acme; interface Contract { public function run(): void; } |
    Ketika analyzer source statis dijalankan pada snapshot tersebut
    Maka CCM mengandung deklarasi JavaScript dan PHP yang valid terhadap byte sumber

  @sprint1 @US_DetectAndExcludeSource @SAGE_FR_ANA_03 @SAGE_FR_ANA_12 @issue_10 @domain @controlled
  Skenario: Source yang didukung diproses dan file generated atau metadata dikecualikan
    Dengan snapshot immutable berisi source berikut:
      | path                | source                                                        |
      | src/entry.ts        | export function entry() {}                                     |
      | vendor/old.php      | <?php class Legacy {}                                          |
      | src/app.min.js      | minified                                                        |
      | src/app.js.map      | {"version":3,"sources":["app.js"]}                            |
      | dist/generated.ts   | export class Generated {}                                       |
      | package.json        | {"scripts":{"postinstall":"throw new Error('must not run')"}} |
      | .gitmodules         | [submodule "external"]                                         |
    Ketika analyzer source statis dijalankan pada snapshot tersebut
    Maka file generated, metadata, dan dependency yang dikecualikan tetap tercatat dengan alasan policy

  @sprint1 @US_PartialAnalysis @SAGE_FR_ANA_13 @issue_10 @issue_33 @issue_34 @domain @controlled
  Skenario: File valid tetap diproses saat sibling memiliki syntax invalid
    Dengan snapshot immutable berisi source berikut:
      | path             | source                |
      | src/good.ts      | export function good() {} |
      | src/bad.ts       | export class {        |
    Ketika analyzer source statis dijalankan pada snapshot tersebut
    Maka file valid tetap dianalisis ketika sibling gagal syntax dan hasil ditandai parsial

  @sprint1 @US_SafeSourceAnalysis @SAGE_FR_ANA_12 @issue_10 @domain @controlled
  Skenario: Konfigurasi Composer tidak dieksekusi
    Dengan source snapshot berisi konfigurasi Composer dengan canary filesystem
    Ketika analyzer source statis dijalankan pada snapshot tersebut
    Maka tidak ada source yang didukung dan canary Composer tidak pernah dibuat
