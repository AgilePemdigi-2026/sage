# TOGAF ADD implementation and acceptance traceability

Baseline: 19 November 2026. This page tracks the one-sprint replacement scope for TOGAF Phase C baseline output. GitHub ownership is [#142](https://github.com/AgilePemdigi-2026/sage/issues/142) for Iltizam and [#143](https://github.com/AgilePemdigi-2026/sage/issues/143) for Rizqy. Assignment is not completion evidence. The old SRS mapping remains available as historical traceability in [REQUIREMENTS_TRACEABILITY](REQUIREMENTS_TRACEABILITY.md).

## Scope and evidence map

| Requirement | Implementation entry points | Automated evidence | Acceptance boundary |
| --- | --- | --- | --- |
| Produce one canonical baseline from the same source CKG snapshot | `packages/documents/src/baseline-add.ts`; `apps/web/lib/add/handlers.ts`; `packages/database/src/add-baseline.ts` | `tests/add-baseline.test.ts`; `tests/add-handlers.test.ts` | Model, evidence byte ranges, source hashes, relationships, and limitations must validate against one pinned commit. |
| Derive application/data structure without inventing business meaning | `packages/documents/src/semantic/build.ts`; `packages/documents/src/semantic/next.ts`; `packages/documents/src/semantic/laravel.ts`; `packages/documents/src/semantic/python-fastapi.ts`; `packages/documents/src/semantic/data-artifacts.ts`; `packages/documents/src/baseline-add.ts` | `tests/semantic-next.test.ts`; `tests/semantic-laravel.test.ts`; `tests/add-baseline.test.ts` | Framework and file-format support is pattern-specific. A filename or import alone does not prove a user flow, business owner, deployment, target state, or cross-application interaction. |
| Show Data Structure and Application Cooperation views plus catalogs and matrices | `apps/web/components/add-workspace/`; `packages/documents/src/baseline-add.ts` | `tests/add-baseline.test.ts`; `scripts/test-add-workspace.ts` | Every displayed ArchiMate relation must be valid for the implemented profile, source-evidenced, and distinguish proven from indicated. The older `scripts/test-semantic-workspace.ts` covers Code Knowledge, not the ADD workspace. |
| Keep user corrections separate from source facts | `packages/documents/src/add-overlay.ts`; `apps/web/lib/add/handlers.ts`; `packages/database/src/add-baseline.ts`; migration `packages/database/prisma/migrations/202611160001_add_baseline/` | `tests/add-handlers.test.ts`; `tests/add-baseline.integration.ts` | Unit and disposable PostgreSQL integration cover owner isolation, canonical hash/idempotency, append-only revisions, and stale/concurrent revision conflicts. |
| Offer LLM only for consented narrative wording | `packages/documents/src/baseline-llm.ts`; `apps/web/lib/add/handlers.ts` | `tests/add-baseline.test.ts`; `tests/add-handlers.test.ts` | No source bytes are sent; returned text cannot add/alter facts or relationships. Deterministic narrative is the fallback. |
| Provide readable Markdown, LaTeX, and PDF from the canonical ADD and correction snapshot | `packages/documents/src/baseline-markdown.ts`; `packages/documents/src/baseline-latex.ts`; `packages/documents/src/phase-c-add.ts`; `apps/web/components/add-workspace/` | `tests/add-export.test.ts`; `scripts/test-add-workspace.ts` | Markdown and LaTeX carry the canonical model hash and saved overlay revision. Browser print produces an A4 PDF from that same page snapshot. A server-side PDF export/cache route is not implemented. |
| Support the current reference projects and resource limits | `scripts/benchmark-add.ts`; `scripts/run-add-container-benchmarks.py`; `.github/workflows/ci.yml`; `artifacts/semantic/corpora/`; `docs/evidence/semantic/oracle.json` | `npm run benchmark:add -- <corpus> <new-output-directory> <alias>`; GitHub Actions run [#44449002743](https://github.com/AgilePemdigi-2026/sage/actions/runs/44449002743) | Replay Perpus, SAGE, and Emosync with commit-pinned evidence. Report runtime, process and cgroup peak memory, model counts, Markdown size, determinism, and limitations; failures remain visible. |

## Verification status

This table is updated only from commands actually run for the current worktree revision.

| Check | Status | Evidence/limit |
| --- | --- | --- |
| `npm run typecheck` | Passed | Root and web workspace TypeScript checks passed on 19 November 2026 with Node v24.22.3. |
| `npm run lint` | Passed with warnings | No lint errors. Three exhaustive-dependency warnings remain in the existing `semantic-workspace.tsx`. |
| `npm test` | Passed | 590 unit/contract tests, including OpenAPI scope guards, Python binding identity, TRACE interface projection, complete ADD exports, Prisma, and combined-pipeline coverage. PostgreSQL integration is a separate command. |
| `npm run test:semantic` | Passed | 132 focused analyzer/model/handler/presentation tests. |
| ADD corpus replay: Perpus, SAGE, Emosync | Passed | Fresh Node v24.22.3 replays on pinned snapshots passed deterministic model/hash and evidence byte/hash checks. Results are shown below. Resource figures are host process measurements, not server limits. |
| Fixed-limit Linux ADD replay | Passed | GitHub Actions run [#44449002743](https://github.com/AgilePemdigi-2026/sage/actions/runs/44449002743) replayed all three pinned commits on Ubuntu 24.04 / Node v24.22.0. Docker enforced 2 GiB memory, 1.5 CPU, 256 PIDs, no network, and read-only root; each report confirmed cgroup limits and peak charge. The sanitized reports are attached to the run for 14 days. Per-corpus results follow. |
| PostgreSQL owner/revision integration | Passed | 2 tests passed against the new disposable `sage_add_baseline_20261119` database. Migration and test data were removed with the temporary QA Colima profile; the existing `sage` profile and application database were not used. |
| ADD workspace Playwright/browser review | Passed in fixture scope | Tested initial not-generated state, generation without visiting Code Knowledge, both connected ArchiMate views, paginated application diagram, evidence links, mobile overflow, keyboard access, saved overlay revision, default-off LLM consent and opt-in, active-search print behavior, complete relationship IDs/evidence, all data catalog rows, and matching Markdown/LaTeX/PDF identity. API responses were intercepted fixtures; this does not cover production OAuth, the worker queue, or server persistence. |
| Markdown, LaTeX, and PDF export | Passed with scope limits | The browser generated an A4 PDF from the reviewed fixture; Tectonic compiled a 19-page A4 LaTeX fixture and key diagram/catalog pages were visually checked. Application Cooperation and Data Structure use paginated relationship rows so cross-page relationships remain drawn; regressions verify every relation survives pagination. Browser print includes a complete relationship/evidence register and an unfiltered catalog. PDF remains browser-print output; no server-side PDF export/cache route exists. Tectonic still reports minor overfull-box warnings; no clipping was visible on the reviewed pages. Test artifacts are ignored and not committed; Tectonic intermediates are kept under `tmp/pdfs/`. |
| Production Docker image | Passed on a clean runner | GitHub Actions run [#44444020828](https://github.com/AgilePemdigi-2026/sage/actions/runs/44444020828) built the production `web` target on Ubuntu 24.04 after the full test and integration suite. The earlier local `bdd` image attempt reached the Next.js build but failed writing the Playwright browser layer during Colima disk I/O errors; the local cache and stale QA images/volumes were subsequently cleared. |
| End-to-end repository analysis pipeline | Partial | Fresh pinned-source benchmarks cover analysis, semantic extraction, ADD projection, deterministic replay, and evidence validation. They do not cover GitHub OAuth, the production queue, or deployment runtime. |
| Production build | Passed with local build configuration | `npm run build` passed on Node v24.22.3 using a dummy loopback `DATABASE_URL` for static route configuration. It did not connect to a database. |

### Pinned corpus replay results

All three fresh reports were generated on macOS arm64 with Node v24.22.3. Memory is the Node process peak RSS, not a Docker/container limit. The replay validates output determinism and source evidence for these commits only; it is not a production resource guarantee. PDF bytes are absent from replay reports because the PDF is generated by browser print rather than a pipeline export worker.

| Corpus and commit | Source files / size | Elapsed / peak RSS | ADD elements / relationships | Data objects / interfaces / limitations | Model JSON / Markdown bytes |
| --- | ---: | ---: | ---: | ---: | ---: |
| Perpus `d72c3532` | 89 / 319,532 B | 1.72 s / 397 MiB | 201 / 310 | 95 / 37 / 68 | 537,232 / 310,510 |
| SAGE `c2dc3d84` | 369 / 3,189,530 B | 66.80 s / 905 MiB | 87 / 160 | 17 / 26 / 42 | 263,489 / 184,137 |
| Emosync `a2299266` | 85 / 242,613 B | 6.47 s / 207 MiB | 114 / 328 | 8 / 45 / 10 | 342,176 / 181,550 |

Earlier SAGE sessions produced unexplained source-analysis time outliers. The fresh replay completed in 64.59 s for source analysis and 66.80 s total at 905 MiB peak RSS; the cause of the old outliers remains unknown. This run did not use a container limit. These figures describe this macOS host and must not be treated as production resource guarantees.

### Fixed-limit Linux replay

The same three oracle commits passed in a separate Docker container per repository. Cgroup peak is the container's measured memory charge; process peak RSS is reported separately. The run used 2 GiB, 1.5 CPU, a 256 PID cap, no network, and read-only root. Markdown byte counts come from the canonical ADD generated by this replay. PDF bytes are not measured because PDF output still uses browser print.

| Corpus and commit | Source files / size | Elapsed | Container peak / process peak RSS | ADD elements / relationships | Evidence spans / Markdown bytes |
| --- | ---: | ---: | ---: | ---: | ---: |
| Perpus `d72c3532` | 89 / 319,532 B | 3.50 s | 320.6 / 358.9 MiB | 201 / 310 | 1,143 / 310,510 B |
| SAGE `c2dc3d84` | 369 / 3,189,530 B | 87.87 s | 974.1 / 1,003.6 MiB | 87 / 160 | 603 / 184,137 B |
| Emosync `a2299266` | 85 / 242,613 B | 4.37 s | 291.4 / 329.7 MiB | 114 / 328 | 651 / 181,550 B |

Those recorded runs verified the 2 GiB memory cap, but did not record the cgroup swap limit. The runner now disables swap and requires `memory.swap.max = 0`; a fresh run is required before reporting that check as passed. This remains a bounded static replay against those exact source commits, not a capacity guarantee for the shared Coolify server. It does not exercise OAuth, the production queue, deployed storage, or PDF generation.

## Supported baseline and limitations

The current static analyzer recognizes selected JavaScript/TypeScript, PHP, and Python patterns. The first semantic framework patterns include Next.js App Router, Laravel, limited Node HTTP, and literal FastAPI-style routes. SQL, OpenAPI, and selected JSON Schema files may contribute data/interface contracts independently of programming-language support. This does not imply that every repository using those languages or frameworks is covered. See [semantic analyzer limits](../reference/SEMANTIC_ANALYSIS.md) and [ADD contract](../reference/TOGAF_ADD.md).

The generated state is the observed baseline for one source commit. Target architecture, gap/RAG status, Business Architecture capabilities/processes, enterprise data ownership/distribution, and integrations between separately deployed applications require additional evidence or human input. Code Knowledge remains a supporting source-structure visualization; it is not the ADD and does not imply application behavior.
