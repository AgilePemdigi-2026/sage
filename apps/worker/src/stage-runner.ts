import { ANALYSIS_STAGE_DEFINITIONS } from "../../../packages/contracts/src/stages.ts";
import type {
  AnalysisStageKey,
  AnalysisStagesResult,
  AnalysisStageProgress,
} from "../../../packages/contracts/src/stages.ts";
import {
  completeAnalysisStage,
  initializeAnalysisStages,
  readAnalysisStages,
  startAnalysisStage,
} from "../../../packages/database/src/stages.ts";
import type {
  AnalysisStageTargetContext,
  PersistedAnalysisStageInput,
  ReadonlyJsonValue,
} from "../../../packages/database/src/stages.ts";
import { failAnalysisJob, renewAnalysisLease, snapshotAnalysisJobClaim } from "../../../packages/database/src/queue.ts";
import type { AnalysisJobClaim } from "../../../packages/database/src/queue.ts";
import type { PrismaClient } from "../../../packages/database/generated/client.ts";

const DEFAULT_LEASE_DURATION_MS = 30_000;
const MIN_LEASE_DURATION_MS = 1_000;
const MAX_LEASE_DURATION_MS = 300_000;
const DEFAULT_HANDLER_FAILURE = "STAGE_HANDLER_FAILED";
const CANCELLED_HANDLER_FAILURE = "STAGE_CANCELLED";

export type AnalysisStageArtifact =
  | ReadonlyJsonValue
  | Uint8Array
  | readonly AnalysisStageArtifact[]
  | { readonly [key: string]: AnalysisStageArtifact };

export interface AnalysisStageContext {
  readonly target: AnalysisStageTargetContext;
  readonly configuration: ReadonlyJsonValue;
  /** Outputs from prior trusted stages, copied for each handler invocation. */
  readonly previousStages: Partial<Readonly<Record<AnalysisStageKey, AnalysisStageArtifact>>>;
  /** The SNAPSHOT handler output, copied independently for each later stage. */
  readonly sourceSnapshot: AnalysisStageArtifact | null;
}

/** Trusted worker handler. It must observe `signal`; the runner cannot forcibly stop uncooperative code. */
export type AnalysisStageHandler = (
  context: AnalysisStageContext,
  signal: AbortSignal,
) => Promise<AnalysisStageArtifact | void>;

export type AnalysisStageHandlers = Readonly<Record<AnalysisStageKey, AnalysisStageHandler>>;

export interface RunAnalysisStagesOptions {
  readonly signal?: AbortSignal;
  readonly leaseDurationMs?: number;
}

type AbortCause = "CANCELLED" | "LEASE_LOST" | "LEASE_UNVERIFIED";

class StageHandlerAbortedError extends Error {
  constructor() {
    super("Handler tahap dihentikan.");
    this.name = "StageHandlerAbortedError";
  }
}

export class AnalysisStageTransitionConflictError extends Error {
  constructor(stageKey: AnalysisStageKey) {
    super(`Transisi tahap ${stageKey} tidak cocok dengan progres yang tersimpan.`);
    this.name = "AnalysisStageTransitionConflictError";
  }
}

function validatedHandlers(handlers: AnalysisStageHandlers): readonly { key: AnalysisStageKey; handler: AnalysisStageHandler }[] {
  if (!handlers || typeof handlers !== "object") throw new Error("Registry handler tahap wajib berupa object.");
  const prototype = Object.getPrototypeOf(handlers);
  if (prototype !== Object.prototype && prototype !== null) throw new Error("Registry handler tahap harus berupa object biasa.");
  const ownKeys = Reflect.ownKeys(handlers);
  if (ownKeys.length !== ANALYSIS_STAGE_DEFINITIONS.length || ownKeys.some((key) => typeof key !== "string")) {
    throw new Error("Registry harus berisi tepat sembilan handler tahap.");
  }

  return ANALYSIS_STAGE_DEFINITIONS.map(({ key }) => {
    const descriptor = Object.getOwnPropertyDescriptor(handlers, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor) || typeof descriptor.value !== "function") {
      throw new Error(`Handler tepercaya untuk tahap ${key} wajib tersedia.`);
    }
    return { key, handler: descriptor.value as AnalysisStageHandler };
  });
}

function leaseDuration(value: number | undefined): number {
  if (value === undefined) return DEFAULT_LEASE_DURATION_MS;
  if (!Number.isSafeInteger(value) || value < MIN_LEASE_DURATION_MS || value > MAX_LEASE_DURATION_MS) {
    throw new Error(`Durasi lease harus bilangan bulat ${MIN_LEASE_DURATION_MS}–${MAX_LEASE_DURATION_MS} milidetik.`);
  }
  return value;
}

function cloneArtifact(value: unknown, active = new Set<object>()): AnalysisStageArtifact {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Output tahap harus memakai angka JSON yang valid.");
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== "object" || value === null) throw new Error("Output tahap hanya boleh berisi data terstruktur.");
  if (Buffer.isBuffer(value)) return new Uint8Array(value);
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (active.has(value)) throw new Error("Output tahap tidak boleh memiliki referensi melingkar.");

  active.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) throw new Error("Array output tahap tidak valid.");
      const keys = Reflect.ownKeys(value);
      if (keys.some((key) => typeof key !== "string" || (key !== "length" && !/^(0|[1-9]\d*)$/.test(key)))) {
        throw new Error("Array output tahap memuat properti tambahan.");
      }
      const copied: AnalysisStageArtifact[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) throw new Error("Array output tahap harus padat dan tanpa getter.");
        copied.push(cloneArtifact(descriptor.value, active));
      }
      return copied;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new Error("Object output tahap tidak valid.");
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string")) throw new Error("Output tahap tidak boleh memakai symbol key.");
    const copied: Record<string, AnalysisStageArtifact> = Object.create(null) as Record<string, AnalysisStageArtifact>;
    for (const key of (keys as string[])) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) throw new Error("Object output tahap harus memakai properti data biasa.");
      copied[key] = cloneArtifact(descriptor.value, active);
    }
    return copied;
  } finally {
    active.delete(value);
  }
}

function freezeArtifact<T extends AnalysisStageArtifact>(value: T): T {
  if (value === null || typeof value !== "object" || value instanceof Uint8Array) return value;
  for (const child of Object.values(value)) freezeArtifact(child);
  return Object.freeze(value);
}

function handlerContext(
  input: PersistedAnalysisStageInput,
  outputs: ReadonlyMap<AnalysisStageKey, AnalysisStageArtifact>,
): AnalysisStageContext {
  const target = freezeArtifact(cloneArtifact(input.target)) as unknown as AnalysisStageTargetContext;
  const configuration = freezeArtifact(cloneArtifact(input.configuration)) as ReadonlyJsonValue;
  const previousStages: Partial<Record<AnalysisStageKey, AnalysisStageArtifact>> = Object.create(null) as Partial<Record<AnalysisStageKey, AnalysisStageArtifact>>;
  for (const [key, output] of outputs) previousStages[key] = freezeArtifact(cloneArtifact(output));
  Object.freeze(previousStages);
  return Object.freeze({
    target,
    configuration,
    previousStages,
    sourceSnapshot: previousStages.SNAPSHOT ?? null,
  });
}

function waitOrAbort(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    timer.unref?.();
    signal.addEventListener("abort", finish, { once: true });
    if (signal.aborted) finish();
  });
}

function invokeHandler(handler: AnalysisStageHandler, context: AnalysisStageContext, signal: AbortSignal): Promise<AnalysisStageArtifact | void> {
  if (signal.aborted) return Promise.reject(new StageHandlerAbortedError());
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(new StageHandlerAbortedError()));
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve().then(() => {
      if (signal.aborted) throw new StageHandlerAbortedError();
      return handler(context, signal);
    }).then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
    if (signal.aborted) onAbort();
  });
}

async function readResult(db: PrismaClient, claim: AnalysisJobClaim, stagesFinished = false): Promise<AnalysisStagesResult> {
  const stages: readonly AnalysisStageProgress[] = await readAnalysisStages(db, claim.ownerUserId, claim.analysisId) ?? [];
  return { stagesFinished: stagesFinished && stages.length === ANALYSIS_STAGE_DEFINITIONS.length && stages.every((stage) => stage.status === "COMPLETED"), stages };
}

/**
 * Execute the fixed trusted-handler registry sequentially under the queue lease.
 * Stage state is persisted, while analysis/job publication remains for the result-publishing issue.
 */
export async function runAnalysisStages(
  db: PrismaClient,
  inputClaim: AnalysisJobClaim,
  handlers: AnalysisStageHandlers,
  options: RunAnalysisStagesOptions = {},
): Promise<AnalysisStagesResult> {
  const orderedHandlers = validatedHandlers(handlers);
  const renewalDurationMs = leaseDuration(options.leaseDurationMs);
  if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) throw new Error("Signal pembatalan tahap tidak valid.");
  const claim = snapshotAnalysisJobClaim(inputClaim);

  const initialRenewal = await renewAnalysisLease(db, claim, { leaseDurationMs: renewalDurationMs });
  if (!initialRenewal) return readResult(db, claim);
  const persistedInput = await initializeAnalysisStages(db, claim);
  if (!persistedInput) return readResult(db, claim);

  // Acquire execution ownership before observing cancellation. A duplicate call
  // must lose this CAS and leave the winning runner's job untouched, even when
  // the duplicate's signal was already aborted.
  const firstStageStarted = await startAnalysisStage(db, claim, "SNAPSHOT");
  if (firstStageStarted === null) return readResult(db, claim);
  if (!firstStageStarted) throw new AnalysisStageTransitionConflictError("SNAPSHOT");
  const ownsExecution = true;

  const controller = new AbortController();
  let abortCause: AbortCause | null = null;
  const abort = (cause: AbortCause) => {
    if (controller.signal.aborted) return;
    abortCause = cause;
    controller.abort(new Error(cause));
  };
  const forwardExternalAbort = () => abort("CANCELLED");
  options.signal?.addEventListener("abort", forwardExternalAbort, { once: true });
  if (options.signal?.aborted) forwardExternalAbort();

  const heartbeatIntervalMs = Math.max(50, Math.floor(renewalDurationMs / 3));
  const heartbeat = (async () => {
    while (!controller.signal.aborted) {
      await waitOrAbort(heartbeatIntervalMs, controller.signal);
      if (controller.signal.aborted) return;
      try {
        const expiresAt = await renewAnalysisLease(db, claim, { leaseDurationMs: renewalDurationMs });
        if (!expiresAt) {
          abort("LEASE_LOST");
          return;
        }
      } catch {
        // Fail closed: without a confirmed renewal, no later stage write is attempted.
        abort("LEASE_UNVERIFIED");
        return;
      }
    }
  })();

  const outputs = new Map<AnalysisStageKey, AnalysisStageArtifact>();
  let stagesFinished = false;
  let jobFailureHandled = false;
  try {
    for (const { key, handler } of orderedHandlers) {
      if (controller.signal.aborted) break;
      if (key !== "SNAPSHOT") {
        const started = await startAnalysisStage(db, claim, key);
        if (started === null) {
          abort("LEASE_LOST");
          break;
        }
        if (!started) throw new AnalysisStageTransitionConflictError(key);
      }

      let output: AnalysisStageArtifact | void;
      try {
        output = await invokeHandler(handler, handlerContext(persistedInput, outputs), controller.signal);
        if (output !== undefined) output = cloneArtifact(output);
      } catch {
        if (abortCause === "LEASE_LOST" || abortCause === "LEASE_UNVERIFIED") break;
        const failureCode = abortCause === "CANCELLED" ? CANCELLED_HANDLER_FAILURE : DEFAULT_HANDLER_FAILURE;
        const failed = await failAnalysisJob(db, claim, failureCode);
        if (!failed) abort("LEASE_LOST");
        else jobFailureHandled = true;
        break;
      }

      if (controller.signal.aborted) {
        if (abortCause === "CANCELLED") {
          const failed = await failAnalysisJob(db, claim, CANCELLED_HANDLER_FAILURE);
          if (!failed) abort("LEASE_LOST");
          else jobFailureHandled = true;
        }
        break;
      }

      const completed = await completeAnalysisStage(db, claim, key);
      if (completed === null) {
        abort("LEASE_LOST");
        break;
      }
      if (!completed) throw new AnalysisStageTransitionConflictError(key);
      if (output !== undefined) outputs.set(key, output);
      if (key === "ARCHITECTURE_DOCUMENT") stagesFinished = true;
    }

    // Cancellation can arrive between two stages, when no stage row is RUNNING.
    if (ownsExecution && abortCause === "CANCELLED" && !jobFailureHandled) {
      const failed = await failAnalysisJob(db, claim, CANCELLED_HANDLER_FAILURE);
      if (!failed) abort("LEASE_LOST");
      else jobFailureHandled = true;
    }
  } finally {
    if (!controller.signal.aborted) controller.abort(new Error("RUNNER_FINISHED"));
    options.signal?.removeEventListener("abort", forwardExternalAbort);
    await heartbeat;
  }

  return readResult(db, claim, stagesFinished);
}
