# QA-03 — Responsive UI, keyboard, errors, and contrast

**Result: PASS within the measured UI scope.** Current application commit: `b0ed42e431169617c134563985bfe84eb2ff8c58`. The evidence is a combination of a fresh live result run and the four-suite browser regression. The historical [QA-03-S1 fixture report](QA-03-S1_CHECKS.md) is not counted as live product coverage.

## Fresh live result run — 9 November 2026

Playwright checked history, progress, Code Knowledge, documentation, Software Engineering Diagram, and keyboard focus at widths 360, 390, 768, 1024, and 1440 px: **30 checks** total.

| Check | Expected | Actual |
| --- | --- | --- |
| History, progress, graph, documentation | HTTP 200; Indonesian UI; no horizontal overflow | PASS at all five widths; max overflow 0 px |
| Software Engineering Diagram | Source-connected flow remains present and readable | PASS at all five widths; 149 source relationships for the Laravel sample |
| Keyboard focus | Focus remains visible when navigating controls | PASS at all five widths; visible 2 px solid outline |
| Browser/page errors | No uncaught page errors during these views | PASS; 0 errors |
| Visible text contrast | At least 4.5:1 for normal text, 3:1 for large text | PASS; 0 sampled failures; minimum sampled ratio 4.5187:1 |

The machine-readable report is [QA-03-live-result-views-2026-11-09.json](evidence/QA-03-live-result-views-2026-11-09.json). The separate Playwright regression on 8 November passed landing/health, auth/workspace, repository-target, and account-isolation suites. Auth checks include denied login, invalid callback, expired/revoked sessions, and retry; repository checks include empty/search/error/retry states, invalid targets, and focus after selection. Those provider responses are controlled and remain distinct from the live OAuth and repository runs in [QA-02](QA-02_CHECKS.md).

## Limits

- Contrast sampling covers visible DOM text and large-text thresholds. It excludes disabled controls and decorative breadcrumb separators; it does **not** measure every SVG relationship stroke or canvas pixel. Treat this as text-contrast evidence, not a complete pixel-level contrast audit.
- The live screen run exercises a real analysis result and visible PDF size-limit error on the large sample. It does not inject a network outage into every screen at all five widths.
- The flow relationship count proves that the analyzer emitted connected paths for the Laravel sample; semantic correctness is handled separately by the analyzer oracle and remains a QA-02 gap for the Node.js HTTP sample.

The regression scope, expected/actual cases, viewport list, and report limitations are recorded here so fixture-only QA-03-S1 results are not presented as full product coverage.
