import {
  claimAnalysisJob,
  database,
  disconnectDatabase,
  failAnalysisJob,
  renewAnalysisLease,
} from "../../packages/database/src/index.ts";
import type { AnalysisJobClaim } from "../../packages/database/src/queue.ts";

const allowedDatabases = new Set(["sage_queue01", "sage_queue01_fresh"]);

function assertIsolatedQueueDatabase(): void {
  if (process.env.SAGE_QUEUE_TESTS !== "1") throw new Error("Queue worker helper requires SAGE_QUEUE_TESTS=1.");
  const rawUrl = process.env.DATABASE_URL;
  if (!rawUrl) throw new Error("DATABASE_URL is required for queue worker integration tests.");
  let databaseName: string;
  try {
    databaseName = decodeURIComponent(new URL(rawUrl).pathname.slice(1));
  } catch {
    throw new Error("DATABASE_URL is invalid; it was not logged.");
  }
  if (!allowedDatabases.has(databaseName)) throw new Error("Queue worker helper only allows isolated ANA-01 test databases.");
}

function parseClaim(raw: string | undefined): AnalysisJobClaim {
  if (!raw) throw new Error("A serialized test claim is required.");
  const value: unknown = JSON.parse(raw);
  if (typeof value !== "object" || value === null) throw new Error("Serialized test claim is invalid.");
  return value as AnalysisJobClaim;
}

async function main(): Promise<void> {
  assertIsolatedQueueDatabase();
  const mode = process.argv[2];
  const db = database();
  try {
    if (mode === "claim") {
      console.log(JSON.stringify(await claimAnalysisJob(db, { leaseDurationMs: 300_000 })));
      return;
    }
    if (mode === "renew") {
      console.log(JSON.stringify({ leaseExpiresAt: await renewAnalysisLease(db, parseClaim(process.argv[3]), { leaseDurationMs: 30_000 }) }));
      return;
    }
    if (mode === "fail") {
      console.log(JSON.stringify({ failed: await failAnalysisJob(db, parseClaim(process.argv[3]), "TEST_FAILURE") }));
      return;
    }
    throw new Error("Unknown queue worker helper mode.");
  } finally {
    await disconnectDatabase();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown queue test worker error.";
  console.error(message);
  process.exitCode = 1;
});
