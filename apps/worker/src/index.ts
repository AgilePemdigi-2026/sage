import { writeFile } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";
import { hostname } from "node:os";
import { database, disconnectDatabase } from "@sage/database";

const abort = new AbortController();
for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => abort.abort());

async function main() {
  const id = hostname();
  const db = database();
  console.log(JSON.stringify({ event: "worker_started", mode: "environment", queueEnabled: false }));
  try {
    while (!abort.signal.aborted) {
      await db.workerHeartbeat.upsert({ where: { id }, create: { id }, update: { lastSeen: new Date() } });
      await writeFile("/tmp/sage-worker-heartbeat", String(Date.now()));
      await setTimeout(5000, undefined, { signal: abort.signal }).catch((error: Error) => {
        if (error.name !== "AbortError") throw error;
      });
    }
  } finally {
    await disconnectDatabase();
  }
}

main().catch(() => {
  console.error(JSON.stringify({ event: "worker_failed", code: "ENVIRONMENT_UNAVAILABLE" }));
  process.exitCode = 1;
});
