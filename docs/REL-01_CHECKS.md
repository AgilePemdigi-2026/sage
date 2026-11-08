# REL-01 — Local Docker release verification

**Local release gate: passed for the MVP; issue #26 remains open until this PR is independently reviewed and merged.** This is a Docker-local result only. No Coolify deployment or shared-host capacity test was performed.

## Verified run

- Built the production `sage-web:local` and `sage-worker:local` images from this branch. The Docker build completed lint, package checks, typecheck, production Next.js build, and the test suites recorded in [QA-02](QA-02_CHECKS.md).
- Started the rebuilt app and worker against the existing local Postgres and storage volumes. All three services reported healthy; `/` and `/api/health` returned HTTP 200.
- Fresh UI-submitted analysis completed 9/9 worker stages. Code Knowledge, Software Engineering Diagram, and documentation opened without browser page errors. Markdown and PDF exports downloaded and matched their stored content hashes; full result is in [the QA-02 report](evidence/QA-02-live-integration-2026-11-09.json).
- The analysis record and generated export records were removed after the end-to-end check completed.
- A prior Compose stop/start cycle retained the Perpus history record and both READY exports. Database and storage volumes were not deleted or recreated.
- At a prior `docker stats` sample, web used 343 MiB / 768 MiB, worker 367 MiB / 2 GiB, and database 72 MiB / 1 GiB. These are point-in-time observations, not peak-memory benchmarks.

## Environment and limits

- Colima profile `sage`: 2 vCPU, 4 GiB RAM, 30 GiB disk; app and worker use Node.js 24.22.0; PostgreSQL is `17-bookworm`.
- The Docker disk reached approximately 96% usage during the image rebuild. The user approved removing old SAGE rollback image tags; database/storage volumes and unrelated images were preserved. Do not treat this as a capacity test for the shared class server.
- This fresh start reused the configured local environment and existing volumes. It verifies rebuilding and starting the app without destroying user data, but does not prove recovery from an empty volume or a backup restore.
- No Coolify configuration, deployment, TLS, external domain, backup/restore, or multi-group load test was attempted.
- PDF contains compact overview/flow pages; full evidence is available in Markdown. Node HTTP route registration is source-indicated; listener execution is not claimed.

After QA, stop the Compose stack and Colima `sage` profile to reduce laptop load. Starting again uses the original ignored `.env` and the `colima-sage` Docker context. This worktree read that `.env` from the main checkout via `--env-file`; no credentials were copied into Git.

The gate is limited to the local MVP path that was exercised. Do not describe it as a Coolify-ready production release or an empty-volume recovery test.
