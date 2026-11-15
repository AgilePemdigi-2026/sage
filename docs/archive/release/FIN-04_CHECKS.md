# FIN-04 regression — 15 November 2026

Refs #40. Base application: `e85fb6fef249f81ec543fa681d8678f47bd7667a`.

`SAGE_SEMANTIC_REPORT_DIR=artifacts/fin04-20261115 npm run test:semantic:ui` passed. The actual React workspace and Next dev routing were exercised with intercepted API fixtures: 33 semantic GET requests and 7 overlay PATCH requests. Checks include initial connected overview, distinct graph/flow modes, keyboard selection, source explanation inspector, corrections, revision conflicts, zoom/reset, desktop and mobile. Saved Perpus, SAGE and Emosync models passed the harness checks; these were not fresh analyses through the worker.

Additional focused graph/filter/inspector/PDF unit results are recorded in the accompanying report. These prove automated assertions, not visual signoff of every PDF page.

Evidence is kept locally under `artifacts/fin04-20261115`; screenshots may include corpus labels and are not automatically published. The log digest identifies the run without exposing fixture source.

## Acceptance still pending

The saved Emosync architecture overview passed flow/graph checks at 360, 390, 768, 1024 and 1440 px. Perpus and SAGE additionally passed initial overview checks at 390 px. This does not establish the five-viewport matrix for all core application screens and states. Every page of the newly generated Perpus/Emosync PDFs still needs visual inspection for clipping, fonts and relationship readability. This partial result does not close #40. Production OAuth and database/worker integration are outside this browser fixture run.

## Final acceptance — 15 November 2026

The clean Node 24 BDD run passes 57 scenarios / 220 steps with actual Next/database/worker result readers. Real graph, document and history suites pass at 360, 390, 768, 1024 and 1440 px, including inspector/source, keyboard/focus restoration and error/account-isolation checks. Controlled providers and synthetic sessions are distinguished from real application/database/worker behavior in each report.

The pipeline regression now captures and checks whole-page overflow for repository-selected, pipeline-complete, retry-progress and retry-permission-error at all five widths: **20/20 matrix cells pass**, plus 2/2 targeted Cucumber scenarios. Saved Emosync semantic overview also passes both modes at five widths. Evidence: [final matrix and PDF inventory](../../evidence/FIN-04-final-20261115.json).

All pages of the three distinct sampled PDFs were visually inspected at 1200px raster previews: normal output (4), retry output (4), and BCE main classes (4), totaling 12 pages. The 390px normal download is byte-identical to the 1440px download. No clipped text, broken glyphs, or diagram bounds outside the page were observed. Catalog continuation whitespace is expected; small diagram text remains vector content for zoom. This is sampled PDF acceptance, not a claim that every PDF from every repository has been visually reviewed.

Browser states and every sampled PDF page now have evidence for the issue criteria; the earlier pending notes remain as historical run boundaries. No product defect was found during this final campaign.
