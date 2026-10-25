# language: en
Feature: Static source analysis (Sprint 1)
  Analysis reads snapshot bytes and runs the available JavaScript/TypeScript and PHP adapters.
  These initial checks cover the analyzer domain; they are not acceptance of the complete product pipeline.

  @sprint1 @US_AnalyzeSource @SAGE_FR_ANA_04 @SAGE_FR_ANA_05 @issue_33 @issue_34 @domain @controlled
  Scenario: [SAGE-FR-ANA-04] Supported Source Code Analysis; [SAGE-FR-ANA-05] Common Code Model Generation — Supporting SRS B.7.3: mixed-language adapter subset
    Given an immutable snapshot contains the following source files:
      | path                | source                                                               |
      | src/App.js          | export class App {}                                                   |
      | src/Contract.php    | <?php namespace Acme; interface Contract { public function run(): void; } |
    When the static source analyzer runs on that snapshot
    Then the CCM contains JavaScript and PHP declarations validated against the source bytes

  @sprint1 @US_DetectAndExcludeSource @SAGE_FR_ANA_03 @issue_10 @domain @controlled
  Scenario: [SAGE-FR-ANA-03] Language and Project Structure Detection — Supporting SRS B.7.3: source-policy exclusions only
    Given an immutable snapshot contains the following source files:
      | path                | source                                                        |
      | src/entry.ts        | export function entry() {}                                     |
      | vendor/old.php      | <?php class Legacy {}                                          |
      | src/app.min.js      | minified                                                        |
      | src/app.js.map      | {"version":3,"sources":["app.js"]}                            |
      | dist/generated.ts   | export class Generated {}                                       |
      | package.json        | {"scripts":{"postinstall":"throw new Error('must not run')"}} |
      | .gitmodules         | [submodule "external"]                                         |
    When the static source analyzer runs on that snapshot
    Then generated files, metadata, and excluded dependencies remain recorded with policy reasons

  @sprint1 @US_PartialAnalysis @SAGE_FR_ANA_13 @issue_10 @issue_33 @issue_34 @domain @controlled
  Scenario: Supporting SRS B.7.3 — Some source code uses an unsupported language (domain subset) — [SAGE-FR-ANA-13] Partial Analysis Continuation; syntax-invalid sibling is supporting local robustness coverage
    Given an immutable snapshot contains the following source files:
      | path                   | source                    |
      | src/good.ts            | export function good() {} |
      | src/bad.ts             | export class {            |
      | src/unsupported.rb     | class Unsupported; end    |
    When the static source analyzer runs on that snapshot
    Then the supported source remains analyzed with unsupported source "src/unsupported.rb" excluded for reason "UNSUPPORTED_EXTENSION", and the result has status "partial" when a sibling has a syntax error

  @sprint1 @US_SafeSourceAnalysis @NFR_04 @issue_10 @domain @controlled
  Scenario: [NFR-04] Original source remains unchanged and target code is not executed — supporting local source-safety check: Composer hook non-execution
    Given a source snapshot contains a Composer configuration with a filesystem canary
    When the static source analyzer runs on that snapshot
    Then no supported source is found with diagnostic "NO_SUPPORTED_SOURCE", and the Composer canary is never created
