import { setTimeout as delay } from "node:timers/promises";
import { completeCleanupJob, failCleanupJob, markCleanupObjectDeleted, renewCleanupLease, snapshotCleanupJobClaim } from "@sage/database";
import type { CleanupJobClaim } from "@sage/database";
import type { PrismaClient } from "../../../packages/database/generated/client.ts";
import { finishCleanupStorageFolders, removeCleanupStorageFile } from "./cleanup-storage.ts";

export function createCleanupWorker(options: { db: PrismaClient; storageRoot: string }) {
  return {
    async process(inputClaim: CleanupJobClaim, parentSignal?: AbortSignal): Promise<void> {
      const claim = snapshotCleanupJobClaim(inputClaim);
      const controller = new AbortController();
      const stop = () => controller.abort();
      if (parentSignal?.aborted) stop();
      else parentSignal?.addEventListener("abort", stop, { once: true });
      const heartbeat = (async () => {
        while (!controller.signal.aborted) {
          try { await delay(10_000, undefined, { signal: controller.signal }); } catch { return; }
          if (controller.signal.aborted) return;
          try { if (!await renewCleanupLease(options.db, claim)) stop(); } catch { stop(); }
        }
      })();
      try {
        controller.signal.throwIfAborted();
        if (!await renewCleanupLease(options.db, claim)) return;
        const removed: string[] = [];
        for (const entry of claim.manifest) {
          controller.signal.throwIfAborted();
          await removeCleanupStorageFile(options.storageRoot, entry.storageKey, controller.signal);
          controller.signal.throwIfAborted();
          if (entry.storageObjectId !== null && !await markCleanupObjectDeleted(options.db, claim, entry.storageObjectId)) return;
          removed.push(entry.storageKey);
        }
        await finishCleanupStorageFolders(options.storageRoot, removed, controller.signal);
        controller.signal.throwIfAborted();
        await completeCleanupJob(options.db, claim, removed);
      } catch {
        if (!controller.signal.aborted) {
          await failCleanupJob(options.db, claim);
          console.error(JSON.stringify({ event: "analysis_cleanup_failed", code: "CLEANUP_FAILED" }));
        }
      } finally {
        stop();
        parentSignal?.removeEventListener("abort", stop);
        await heartbeat;
      }
    },
  };
}
