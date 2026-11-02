# OPS-01 — worker diagnostics and bounded recovery

Refs [#104](https://github.com/AgilePemdigi-2026/sage/issues/104). Base: `4c4c8c375f888b4edae6c5b9c455946bc9ef9538`. Implementation and verification performed directly by Codex for Iltizam; delegated agents reached usage limits before delivering work. An independent read-only agent reviewed the final staged diff without material findings and reran all 13 focused tests. This is not human approval or a PR-based signoff.

## Behavior

The supervisor separates startup, service heartbeat, queue claim, handler and shutdown failures. Diagnostics contain only fixed event, phase, queue and error-code values plus attempt/backoff numbers. Raw messages, stacks, provider bodies, SQL, parameters, credentials, owner/job IDs and connection URLs are excluded. The classifier reads bounded own-property wrapper paths for the installed Prisma/pg adapter; it does not invoke error getters or traverse arbitrary metadata.

`worker_started` means boot has begun. `worker_ready` follows the first confirmed database heartbeat and health-file write; consumers cannot claim before this succeeds. Readiness does not prove a particular analysis has completed. Startup and shutdown remove the old marker, and the health probe rejects missing, malformed, stale or future timestamps quietly.

Retries wait 500, 1,500 and 3,000 ms, for at most four total attempts per operation. Service heartbeat is idempotent, so known transient connection errors can retry. Claims retry only known pre-execution connection/pool failures or confirmed transaction rollback/conflict/lock timeout. Connection loss, operation timeout, closed transaction and unknown claim outcomes stop the worker and leave lease recovery in charge. Handlers are never replayed by the supervisor. Authentication, schema, disk and unknown failures fail closed.

The service heartbeat has a local database lock timeout of 2 seconds, statement timeout of 5 seconds and transaction timeout of 8 seconds (2-second acquisition wait). These bounds apply only to the service heartbeat; canonical persistence/publication and job lease timings retain their existing contracts. Fatal failures abort sibling consumers, wait for running handlers to settle and disconnect. SIGTERM/SIGINT interrupt idle/backoff waits. No worker CPU, RAM, lease or export limit was raised.

## Fresh verification

[Sanitized evidence](evidence/ops/issue-104-worker-resilience.json) retains before/after outcomes, runtime and resource caps, source/log hashes and limitations. Private probe scripts/configuration and raw logs remain in ignored `artifacts/ops104-20261102/`.

- Before: a fresh real worker with an unreachable database exits 1 with only `ENVIRONMENT_UNAVAILABLE`, without OOM. After: the same controlled outage produces `startup / DATABASE_UNREACHABLE`, three bounded retries, then exit 1.
- A real worker survives controlled database table locks at startup and during heartbeat. A concurrent 8-second CPU probe runs inside its unchanged 2 GiB / 1.5 CPU cgroup. Health passes after recovery. SIGTERM during the next backoff exits 0 in under one second and the marker is absent at process exit. This is a controlled pressure test, not a shared-server capacity guarantee.
- Wrong database credentials and malformed configuration each produce one safe startup failure, no retry and no leaked canary/connection URL.
- 509 unit tests pass, 2 skip; 13 focused diagnostic/runtime tests pass. `npm run check` passes, including lint, root/web typecheck, all unit tests and 8 data tests (three existing React hook lint warnings).
- Actual PostgreSQL queue and stage-lifecycle integration: 2 tests pass, including owner isolation, atomic/FIFO acquisition, stale/duplicate/attempt fencing, cancellation and lease loss.
- Actual worker kill/recovery integration: 1 test passes. The killed claim expires after its real 120-second lease, is marked `WORKER_INTERRUPTED`, and an explicit retry completes all nine stages and publishes one canonical result. The GitHub provider is a fixture; database/process/worker behavior is real. The fixture now supports a newly migrated database without a pre-created analysis slot.

Commands used with Node 24 and generated Prisma/PHP dependencies:

```sh
npm test
npm run typecheck
npm run lint
node --import tsx --test tests/worker-diagnostics.test.ts tests/worker-runtime.test.ts
# Opt-in, disposable databases only; never point these at the application DB.
SAGE_QUEUE_TESTS=1 node --import tsx --test --test-concurrency=1 tests/queue.integration.ts tests/stage-runner-lifecycle.integration.ts
SAGE_PIPELINE_TESTS=1 SAGE_PIPELINE_RECOVERY_TESTS=1 npm run test:pipeline:recovery
```

The pressure probes use the pinned local QA image with read-only source overlays and a separate disposable PostgreSQL instance. Local Docker and Node versions, exact probes and private log hashes are recorded in the evidence. No product data, live GitHub calls, Coolify deployment or operator quota changes are part of this check. The original historical restart cause remains unverified; this controlled reproduction does not relabel it as OOM or a database timeout.
