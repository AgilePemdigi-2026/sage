# REL-01 — Local Docker release verification

**Status: not ready to close #26.** The local stack runs and serves real analysis, but the remaining QA-02 analyzer/PDF gaps and low free disk prevent a clean release signoff. This is local Docker evidence only; no Coolify deployment was performed.

## Verified run

- Application source: `b0ed42e431169617c134563985bfe84eb2ff8c58`; local images `sage-web:local` and `sage-worker:local`; PostgreSQL `17-bookworm`.
- Colima profile `sage`: 2 vCPU, 4 GiB RAM, 30 GiB disk; app and worker ran Node.js 24.22.0.
- Web, worker, and database containers reported healthy. `http://localhost:3000/` and `/api/health` both returned HTTP 200.
- A `docker compose stop` → `docker compose start` cycle using the original ignored `.env` succeeded without deleting volumes. All services returned healthy; the Perpus history record still had 9/9 completed stages and both exports READY after restart.
- Three fresh live analysis runs completed all nine stages; their results and export outcomes are listed in [QA-02 checks](QA-02_CHECKS.md).
- At one `docker stats` sample: web 343 MiB / 768 MiB, worker 367 MiB / 2 GiB, database 72 MiB / 1 GiB. These are point-in-time values, not peak-memory benchmarks.
- After the user-approved removal of old SAGE rollback image tags, the Colima disk still showed 26 GiB used of 30 GiB (93%), with about 2.2 GiB free. No database or storage volume was removed.

## Remaining release gate

- Free disk is low for repeated rebuilds, exports, and other teams on this shared Docker host. Do not raise container memory limits to hide disk pressure.
- This test used the already-configured local Docker stack and its existing volume. It does not prove recovery from a brand-new empty volume or a Coolify deployment/backup restore.
- #24 remains partial because one real Node.js HTTP sample generated zero user-flow relationships and its PDF exceeded the configured document limit. #25's browser report also notes that SVG/canvas stroke contrast was not pixel-audited.
- Keep database and storage volumes. After QA, Compose services and the Colima `sage` profile were stopped to reduce laptop load; starting requires the original ignored `.env` and the `colima-sage` Docker context. This QA worktree used the `.env` in the main checkout via `--env-file`; no credentials were copied into the worktree.

The image cleanup removed only the approved old SAGE rollback tags; it did not prune unrelated images or volumes. Issue #26 stays open until the analyzer and export gaps are accepted and a clean, repeatable local start has been verified with adequate disk headroom.
