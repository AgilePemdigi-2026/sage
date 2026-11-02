import { setTimeout as delay } from "node:timers/promises";
import { classifyWorkerError, type WorkerErrorCode, type WorkerPhase, type WorkerQueue } from "./diagnostics.ts";

export const WORKER_RETRY_DELAYS_MS = [500, 1_500, 3_000] as const;
export type WorkerHandler = (signal: AbortSignal) => Promise<void>;
export interface WorkerConsumer {
  queue: WorkerQueue;
  claim: () => Promise<WorkerHandler | null>;
  idleMs: number;
}
export interface WorkerRuntimeEvent {
  event: "worker_retry" | "worker_recovered" | "worker_failed";
  phase: WorkerPhase;
  queue: WorkerQueue | null;
  code: WorkerErrorCode;
  attempt: number;
  delayMs: number;
}
export class WorkerRuntimeFailure extends Error {
  constructor(readonly diagnostic: WorkerRuntimeEvent) {
    super("Worker operation failed.");
    this.name = "WorkerRuntimeFailure";
  }
}
class WorkerCancelled extends Error {}

export async function waitForWorker(milliseconds: number, signal: AbortSignal): Promise<void> {
  try { await delay(milliseconds, undefined, { signal }); }
  catch (error) { if (!signal.aborted) throw error; }
}

/** Supervise independently fenced consumers; a handler is never replayed here. */
export async function runWorkerRuntime(options: {
  heartbeat: () => Promise<void>;
  consumers: readonly WorkerConsumer[];
  parentSignal: AbortSignal;
  emit: (event: WorkerRuntimeEvent) => void;
  /** Trusted deterministic test seams; production uses the defaults. */
  wait?: typeof waitForWorker;
  heartbeatIntervalMs?: number;
}): Promise<void> {
  const controller = new AbortController();
  const stop = () => controller.abort();
  options.parentSignal.addEventListener("abort", stop, { once: true });
  if (options.parentSignal.aborted) stop();
  const signal = controller.signal;
  const wait = options.wait ?? waitForWorker;
  let failure: unknown;

  async function operation<T>(phase: WorkerPhase, queue: WorkerQueue | null, task: () => Promise<T>): Promise<T> {
    let priorCode: WorkerErrorCode | null = null;
    for (let attempt = 1; ; attempt += 1) {
      if (signal.aborted) throw new WorkerCancelled();
      try {
        const value = await task();
        if (priorCode && !signal.aborted) options.emit({ event: "worker_recovered", phase, queue, code: priorCode, attempt, delayMs: 0 });
        return value;
      } catch (error) {
        if (signal.aborted) throw new WorkerCancelled();
        const classification = classifyWorkerError(error);
        const retryable = phase === "startup" || phase === "heartbeat" ? classification.retryableHeartbeat
          : phase === "claim" && classification.retryableClaim;
        const delayMs = WORKER_RETRY_DELAYS_MS[attempt - 1];
        if (!retryable || delayMs === undefined) {
          const diagnostic: WorkerRuntimeEvent = { event: "worker_failed", phase, queue, code: classification.code, attempt, delayMs: 0 };
          const fatal = new WorkerRuntimeFailure(diagnostic);
          failure = fatal;
          stop();
          options.emit(diagnostic);
          throw fatal;
        }
        priorCode = classification.code;
        options.emit({ event: "worker_retry", phase, queue, code: classification.code, attempt, delayMs });
        await wait(delayMs, signal);
      }
    }
  }

  const tasks: Promise<void>[] = [];
  const launch = (task: () => Promise<void>) => {
    tasks.push(task().catch(error => {
      if (!signal.aborted) { failure = error; stop(); }
    }));
  };
  try {
    // No claims until the initial database heartbeat and health-file write succeed.
    await operation("startup", null, options.heartbeat);
    if (signal.aborted) return;
    launch(async () => {
      while (!signal.aborted) {
        await wait(options.heartbeatIntervalMs ?? 5_000, signal);
        if (!signal.aborted) await operation("heartbeat", null, options.heartbeat);
      }
    });
    for (const consumer of options.consumers) launch(async () => {
      while (!signal.aborted) {
        const handler = await operation("claim", consumer.queue, consumer.claim);
        // An ambiguous/aborted acquisition remains fenced until lease recovery.
        if (signal.aborted) return;
        if (handler) await operation("handler", consumer.queue, () => handler(signal));
        else await wait(consumer.idleMs, signal);
      }
    });
    await Promise.all(tasks);
    if (failure !== undefined) throw failure;
  } catch (error) {
    if (!(error instanceof WorkerCancelled)) throw error;
  } finally {
    stop();
    await Promise.allSettled(tasks);
    options.parentSignal.removeEventListener("abort", stop);
  }
}
