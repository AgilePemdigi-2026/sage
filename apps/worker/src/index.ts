import { writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { hostname } from "node:os";
import {
  claimAnalysisJob,
  database,
  disconnectDatabase,
} from "@sage/database";
import { createAnalysisPipeline } from "./pipeline.ts";

const WORKER_HEARTBEAT_INTERVAL_MS = 5_000;
const QUEUE_POLL_INTERVAL_MS = 1_000;

function isAbortError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "name" in error && error.name === "AbortError";
}

async function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  try {
    await delay(milliseconds, undefined, { signal });
  } catch (error) {
    if (!isAbortError(error)) throw error;
  }
}

async function main(): Promise<void> {
  const id = hostname();
  const db = database();
  const controller = new AbortController();
  let fatalError: unknown;
  const stop = () => controller.abort(new Error("WORKER_SHUTDOWN"));
  const fail = (error: unknown) => {
    fatalError ??= error;
    if (!controller.signal.aborted) controller.abort(error);
  };
  const onSignal = () => stop();
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);

  const pipeline = createAnalysisPipeline({
    db,
    storageRoot: process.env.STORAGE_ROOT ?? "/app/storage",
  });
  console.log(JSON.stringify({ event: "worker_started", mode: "durable_queue" }));
  const heartbeatLoop = async () => {
    while (!controller.signal.aborted) {
      await db.workerHeartbeat.upsert({ where: { id }, create: { id }, update: { lastSeen: new Date() } });
      await writeFile("/tmp/sage-worker-heartbeat", String(Date.now()));
      await wait(WORKER_HEARTBEAT_INTERVAL_MS, controller.signal);
    }
  };
  const consumerLoop = async () => {
    while (!controller.signal.aborted) {
      const claim = await claimAnalysisJob(db);
      if (controller.signal.aborted) return;
      if (claim) {
        await pipeline(claim, controller.signal);
      } else {
        await wait(QUEUE_POLL_INTERVAL_MS, controller.signal);
      }
    }
  };

  const tasks = [heartbeatLoop(), consumerLoop()];
  try {
    await Promise.race(tasks.map(task => task.then(() => {
      if (!controller.signal.aborted) throw new Error("Worker service loop stopped unexpectedly.");
    })));
  } catch (error) {
    fail(error);
  } finally {
    stop();
    await Promise.allSettled(tasks);
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
    await disconnectDatabase();
  }

  if (fatalError !== undefined) throw fatalError;
}

main().catch(() => {
  console.error(JSON.stringify({ event: "worker_failed", code: "ENVIRONMENT_UNAVAILABLE" }));
  process.exitCode = 1;
});
