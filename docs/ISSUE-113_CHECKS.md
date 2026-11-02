# Issue 113 — bounded technical document exports

The frozen SAGE corpus is `AgilePemdigi-2026/sage@c2dc3d84b220c572fb5b2ce85dd3605e89b11a73` (369 files, 3,189,530 source bytes). Source extraction success and export success are reported separately. See `evidence/semantic/issue-113-resource-report.json` for commands, pinned input hashes, process outcomes and resource measurements.

## Behavior

- Canonical document reads reuse the source-verified CKG when replaying the expected ADD. Document bytes, SHA-256, graph metadata, storage mirrors, ownership and snapshot identity still have to match.
- Technical Markdown is generated lazily and written in UTF-8 chunks of at most 64 KiB. Complete outputs within the existing 32 MiB limit retain their original bytes and renderer version. The semantic appendix and technical document share one output limit.
- Oversized Markdown fails with `EXPORT_TOO_LARGE`; it is never published as a truncated document. Private pending files are removed. Artifact verification uses fixed-size reads and incremental SHA-256 instead of whole-file copies.
- Storage reservations, lease fencing, owner checks, immutable semantic model/revision pins and legacy exports retain their existing behavior. Compact vector PDF rendering and its existing limits are unchanged.

## Verification

`npm run lint`, `npm run typecheck`, `npm test` (496 pass, 2 skipped), and `npm run test:data` (8 pass) passed with Node 24.11.0 and the repository dependencies, generated Prisma client and PHP parser installed. New renderer tests cover the legacy output hash, control characters/backticks/numeric JSON keys, UTF-8 chunk boundaries, early termination and a 150,000-item evidence list.

Isolated PostgreSQL integration checks passed: document persistence (6), Markdown worker (2), immutable semantic Markdown/PDF revision and legacy behavior (1), PDF projection/rendering (11), and PDF worker (1). The Markdown worker test verifies the exact downloaded bytes, persisted SHA-256 and UTF-8 length. The integration databases were disposable `sage_export20` and `sage_pdf21`; the live application database was not used.

## Resource outcome

A fresh offline export container reproduces the original V8 heap abort. The renderer rerun uses identical frozen CKG/model bytes and the same 2 GiB / 1.5 CPU limits, without a larger heap. The 161,534,141-byte canonical SAGE document exceeds the existing output budgets: Markdown now reports `EXPORT_TOO_LARGE` and removes its partial artifact; PDF reports its existing `PDF_DOCUMENT_LIMIT_EXCEEDED`. These are controlled failures, not successful exports. Source extraction remains a separate passing result. The resource report retains the nonzero export status rather than converting it into a passing benchmark.

This change does not deploy to Coolify or modify the frozen corpus. It does not promise successful export for every graph size within a fixed process budget.

The same frozen corpus was also imported into a disposable PostgreSQL database and processed through `createExportWorker`, including source archive replay, owner-scoped canonical reads, compact storage layout v2, and immutable presentation revision 1. Both jobs reached controlled terminal states: `FAILED/EXPORT_TOO_LARGE` for Markdown and `FAILED/PDF_DOCUMENT_LIMIT_EXCEEDED` for PDF. No storage object was published and no export directory remained. The worker completed in 26.3 seconds with peak RSS 1,885,569,024 bytes and cgroup peak 1,856,581,632 bytes under its unchanged 2 GiB / 1.5 CPU budget. See `evidence/semantic/issue-113-production-worker-report.json`; its successful verification status means the expected terminal errors were observed, not that artifacts were exported successfully.

The local worker image was refreshed with the verified implementation. Web, worker and database health checks passed; the separate uncommitted diagram UI work was preserved.
