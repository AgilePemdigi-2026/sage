import assert from "node:assert/strict";
import test from "node:test";
import { reserveJobStorage, snapshotCleanupJobClaim } from "../packages/database/src/cleanup.ts";
import type { JobStorageReservationClaim } from "../packages/database/src/cleanup.ts";
import type { PrismaClient } from "../packages/database/generated/client.ts";

test("cleanup claim snapshots deeply copy and freeze its manifest", () => {
  const manifest = [{ storageObjectId: "object-1", storageKey: "snapshot-Ab12Cd/archive.tar.gz" }];
  const expiry = new Date("2026-10-27T00:00:00.000Z");
  const source = {
    jobId: "cleanup-job-1",
    analysisId: "analysis-1",
    ownerUserId: "owner-1",
    attempt: 2,
    leaseToken: "123e4567-e89b-42d3-a456-426614174000",
    leaseExpiresAt: expiry,
    manifest,
  };

  const claim = snapshotCleanupJobClaim(source);
  assert.notEqual(claim, source);
  assert.ok(Object.isFrozen(claim));
  assert.ok(Object.isFrozen(claim.manifest));
  assert.ok(Object.isFrozen(claim.manifest[0]));
  assert.notEqual(claim.leaseExpiresAt, expiry);
  manifest[0].storageKey = "snapshot-Zz99Yy/archive.tar.gz";
  assert.equal(claim.manifest[0].storageKey, "snapshot-Ab12Cd/archive.tar.gz");
  assert.throws(() => snapshotCleanupJobClaim({ ...source, unexpected: true } as typeof source), /invalid fields/i);
});

test("job storage reservations validate generated keys before database access", async () => {
  let transactionCalls = 0;
  const db = {
    $transaction: async () => { transactionCalls += 1; return true; },
  } as unknown as PrismaClient;
  const claim: JobStorageReservationClaim = {
    jobId: "job-1",
    analysisId: "analysis-1",
    ownerUserId: "owner-1",
    attempt: 1,
    leaseToken: "123e4567-e89b-42d3-a456-426614174000",
  };
  await assert.rejects(reserveJobStorage(db, claim, "../outside.txt"), /Storage key is invalid/);
  assert.equal(transactionCalls, 0);
});
