# REL-01 — Local Docker release verification

**Local Docker-to-demo gate: passed for the exercised scope, with limitations recorded.** Issue [#26](https://github.com/AgilePemdigi-2026/sage/issues/26) was closed after independent review and merge of [PR #127](https://github.com/AgilePemdigi-2026/sage/pull/127). This is local verification, not a Coolify production release.

## Verified run

- Built production `sage-web:local` and `sage-worker:local` images from source commit `6174452423da75f8090d98ef63a87bef23f5cb80`. The build completed lint, package checks, typecheck, the test suites listed in [QA-02](QA-02_CHECKS.md), and the production Next.js build.
- Started isolated Compose project `sage-cleanqa` with newly created database and storage volumes. The original `sage` database/storage volumes were retained. Migrations exited successfully; database, web, and worker reported healthy; `/` and `/api/health` returned HTTP 200.
- Verified the fresh path from GitHub login on an empty database through public repository selection, pinned full commit, 9-stage analysis, Code Knowledge, Software Engineering Diagram, Architecture Definition Document, Markdown/PDF export, history, and cleanup. Full results and limitations are in the [QA-02 report](evidence/QA-02-live-integration-2026-11-09.json).
- The test analysis was permanently deleted after explicit user approval. History returned to empty and cleanup completed. The isolated Compose volumes remain available as QA evidence; no analysis or export data remains.
- At a prior `docker stats` sample, web used 343 MiB / 768 MiB, worker 367 MiB / 2 GiB, and database 72 MiB / 1 GiB. These are point-in-time observations, not peak-memory benchmarks.

## Environment and limits

- Colima profile `sage`: 2 vCPU, 4 GiB RAM, 30 GiB disk; app/worker Node.js 24.22.0; PostgreSQL `17-bookworm`.
- Docker disk reached approximately 96% during image rebuild. The user approved removing old SAGE rollback image tags; database/storage volumes and unrelated images were preserved. This is not a capacity test for the shared class server.
- The run began with new isolated database and storage volumes, but does not test backup restoration. It used the existing local ignored `.env` from the main checkout; no credentials were copied into Git.
- No Coolify deployment, registry pull, TLS/domain, backup restore, or multi-group load test was attempted. Do not describe this result as Coolify readiness or shared-server capacity acceptance.
- PDF export bytes and SHA-256 were verified through the product download flow. A separate default-overlay replay then generated an 88-page A4 landscape PDF with renderer 2.4.0; all pages were reviewed in contact sheets and selected pages at full resolution, with no clipping or overlap observed. This offline renderer output is not byte-compared with the Docker UI download; details are in the [visual review evidence](evidence/PDF-visual-review-2026-11-09.json). Full technical detail remains in Markdown.

After local QA, stop the `sage-cleanqa` Compose services and Colima profile `sage` to reduce laptop load. Starting the original stack still uses the ignored `.env` and the `colima-sage` Docker context. Keep all existing database/storage volumes.
