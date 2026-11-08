# QA-02 — Integrasi dan release evidence

**Status: partial; keep #24 and REL-01 #26 open.** Fresh local runs on 9 November 2026 used application commit `b0ed42e431169617c134563985bfe84eb2ff8c58`, Docker images `sage-web:local` / `sage-worker:local`, Node.js 24.22.0, and the active GitHub account `iltizamhasan3`. No private source or credential is committed here.

The redacted machine-readable summary is [QA-02-live-integration-2026-11-09.json](evidence/QA-02-live-integration-2026-11-09.json).

## Fresh end-to-end runs

All three submissions traversed the live repository selector, target validation, actual worker pipeline, result pages, and history. Each reached `COMPLETED_WITH_LIMITATIONS` after all nine stages completed. The CKG counts below are separate from Software Engineering Diagram relationship counts.

| Public/private source and pinned commit | Pipeline | Code Knowledge | Software Engineering Diagram | Export result |
| --- | --- | --- | --- | --- |
| `iltizamhasan3/sistem-informasi-perpus`, `master`, [`d72c3532a7d59cab242fb705ab201cf99ef35e88`](https://github.com/iltizamhasan3/sistem-informasi-perpus/commit/d72c3532a7d59cab242fb705ab201cf99ef35e88) | 21.5 s; 9/9 stages; 105 source files | 3,116 nodes / 3,420 edges | 17/17 features; 67 displayed connections and 189 represented source relationships | Markdown READY (13,234,876 bytes); PDF READY (3,368,578 bytes). UI exposed both downloads as ready; a separate byte-for-byte download check was not recorded for this sample. |
| `iltizamhasan3/emosync-backend`, `main`, [`a22992668658538f6fc10b904d6f7b2ed09124ac`](https://github.com/iltizamhasan3/emosync-backend/commit/a22992668658538f6fc10b904d6f7b2ed09124ac) | 14.7 s; 9/9 stages; 122 source files | 513 nodes / 1,408 edges; 87 Exact / 1,321 Unresolved | 14/14 features; 149 source relationships | Markdown READY and downloaded (5,125,688 bytes); PDF READY and downloaded (955,856 bytes). Both owner-scoped downloads returned HTTP 200 and matched the stored content hash; PDF signature was valid. |
| Private Node.js HTTP sample; repository and commit intentionally redacted | 54.8 s; 9/9 stages; 118 source files | 6,594 nodes / 8,570 edges | 5 features; **0 source relationships** represented | Markdown READY and downloaded (30,219,466 bytes; stored hash matched). PDF failed with `PDF_DOCUMENT_LIMIT_EXCEEDED`; the UI showed an export failure instead of a successful download. |

The private sample's failed PDF is a real size limitation, not a skipped check. Its static graph and Markdown completed, but its user-flow diagram has no proven links. The Laravel and Next.js samples do show source relationships, so those results do not justify claiming every JavaScript/PHP structure is supported.

## GitHub and browser evidence

- Fresh interactive OAuth returned to SAGE as `@iltizamhasan3`. The installed App exposed the authorized private repository, while the public-account repository list also exposed Perpus, Emosync, and other public repositories.
- The provider route Playwright report remains at [qa-02-provider-playwright-2026-11-08.json](evidence/qa-02-provider-playwright-2026-11-08.json). It checks real installation/repository metadata and denied or malformed targets; it does not create an analysis by itself.
- The separate four-suite browser regression passed landing/health, auth/workspace, repository-target, and account-isolation checks on 360, 390, 768, 1024, and 1440 px. Its controlled provider responses are not described as live GitHub requests. Login denial, invalid callback, expired session, account mismatch, repository/branch errors, and retry behavior were covered in those suites.
- One initial direct submission attempt returned HTTP 401 and created no job. It is excluded from passing counts; subsequent submissions through the signed-in UI completed successfully.

## Remaining acceptance gaps

- The private Node.js HTTP sample produced zero Software Engineering Diagram relationships. Source-backed user-flow coverage needs further analyzer work and an independent expected-versus-actual source oracle; feature counts alone do not prove each relationship is correct.
- PDF export is unavailable for the large private sample under the current document-size limit. The limit is visible and handled, but full PDF coverage across large repositories is not met.
- Emosync and Perpus both retain substantial unresolved references and extraction limitations. Their successful pipeline and export status do not mean all source facts or business behavior were recovered.
- This run is local release evidence, not a Coolify deployment or a shared-host capacity test. Detailed clean-start, resource, and disk limits are in [REL-01 checks](REL-01_CHECKS.md).

Provider-boundary and older history evidence remains in [GH-02](GH-02_CHECKS.md) and [HIST-01](HIST-01_CHECKS.md). Do not close #24 until the analyzer gaps and large-document PDF behavior have an accepted resolution or an explicitly narrowed product contract.
