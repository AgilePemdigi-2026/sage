# FIN-04 regression — 15 November 2026

Refs #40. Base application: `e85fb6fef249f81ec543fa681d8678f47bd7667a`.

`SAGE_SEMANTIC_REPORT_DIR=artifacts/fin04-20261115 npm run test:semantic:ui` passed. The actual React workspace and Next dev routing were exercised with intercepted API fixtures: 33 semantic GET requests and 7 overlay PATCH requests. Checks include initial connected overview, distinct graph/flow modes, keyboard selection, source explanation inspector, corrections, revision conflicts, zoom/reset, desktop and mobile. Saved Perpus, SAGE and Emosync models passed the harness checks; these were not fresh analyses through the worker.

Additional focused graph/filter/inspector/PDF unit results are recorded in the accompanying report. These prove automated assertions, not visual signoff of every PDF page.

Evidence is kept locally under `artifacts/fin04-20261115`; screenshots may include corpus labels and are not automatically published. The log digest identifies the run without exposing fixture source.

## Acceptance still pending

The harness covers desktop/mobile, not the complete required five viewport matrix. Every page of the newly generated Perpus/Emosync PDFs still needs visual inspection for clipping, fonts and relationship readability. This partial result does not close #40. Production OAuth and database/worker integration are outside this browser fixture run.
