import { rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { ANALYSIS_RUNTIME_LEASE_DURATION_MS, claimAnalysisJob, claimExportJob, claimCleanupJob, database, disconnectDatabase } from "@sage/database";
import { classifyWorkerError, type WorkerPhase } from "./diagnostics.ts";
import { runWorkerRuntime, WorkerRuntimeFailure, type WorkerRuntimeEvent } from "./runtime.ts";

const HEARTBEAT_PATH = "/tmp/sage-worker-heartbeat";
const emit = (event: WorkerRuntimeEvent) => console.error(JSON.stringify(event));
function diagnostic(error: unknown, phase: WorkerPhase): void {
  emit({ event: "worker_failed", phase, queue: null, code: classifyWorkerError(error).code, attempt: 1, delayMs: 0 });
}

async function main(): Promise<void> {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  let phase: WorkerPhase = "startup";
  let failed = false;
  try {
    await rm(HEARTBEAT_PATH, { force: true });
    // Import configuration-dependent modules inside the safe startup boundary.
    const [{ createAnalysisPipeline }, { createExportWorker }, { createCleanupWorker }] = await Promise.all([
      import("./pipeline.ts"), import("./export-handlers.ts"), import("./cleanup-handlers.ts"),
    ]);
    const db = database();
    const id = hostname();
    const storageRoot = process.env.STORAGE_ROOT ?? "/app/storage";
    const pipeline = createAnalysisPipeline({ db, storageRoot, leaseDurationMs: ANALYSIS_RUNTIME_LEASE_DURATION_MS });
    const exporter = createExportWorker({ db, storageRoot });
    const cleaner = createCleanupWorker({ db, storageRoot });
    console.log(JSON.stringify({ event: "worker_started", mode: "durable_queue" }));
    let ready = false;
    await runWorkerRuntime({
      parentSignal: controller.signal,
      emit,
      heartbeat: async () => {
        await db.$transaction(async tx => {
          // Keep an idempotent service heartbeat bounded under database lock pressure.
          await tx.$executeRaw`SET LOCAL lock_timeout = '2s'`;
          await tx.$executeRaw`SET LOCAL statement_timeout = '5s'`;
          await tx.workerHeartbeat.upsert({ where: { id }, create: { id }, update: { lastSeen: new Date() } });
        }, { maxWait: 2_000, timeout: 8_000 });
        await writeFile(HEARTBEAT_PATH, String(Date.now()));
        if (!ready) { ready = true; console.log(JSON.stringify({ event: "worker_ready", mode: "durable_queue" })); }
      },
      consumers: [
        { queue: "analysis", idleMs: 1_000, claim: async () => {
          const claim = await claimAnalysisJob(db, { leaseDurationMs: ANALYSIS_RUNTIME_LEASE_DURATION_MS });
          return claim ? async signal => { await pipeline(claim, signal); } : null;
        } },
        { queue: "export", idleMs: 1_000, claim: async () => {
          const claim = await claimExportJob(db, { leaseDurationMs: 120_000 });
          return claim ? signal => exporter.process(claim, signal) : null;
        } },
        { queue: "cleanup", idleMs: 2_000, claim: async () => {
          const claim = await claimCleanupJob(db, { leaseDurationMs: 30_000 });
          return claim ? signal => cleaner.process(claim, signal) : null;
        } },
      ],
    });
  } catch (error) {
    failed = true;
    if (!(error instanceof WorkerRuntimeFailure)) diagnostic(error, phase);
  } finally {
    controller.abort();
    phase = "shutdown";
    // Failure in one cleanup must not skip the other or leak signal listeners.
    const cleanup = await Promise.allSettled([rm(HEARTBEAT_PATH, { force: true }), disconnectDatabase()]);
    for (const result of cleanup) if (result.status === "rejected") { failed = true; diagnostic(result.reason, phase); }
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
  }
  if (failed) process.exitCode = 1;
}

void main().catch(() => {
  // Last-resort boundary: do not let Node print a raw database/provider exception.
  emit({ event: "worker_failed", phase: "startup", queue: null, code: "UNCLASSIFIED", attempt: 1, delayMs: 0 });
  process.exitCode = 1;
});
