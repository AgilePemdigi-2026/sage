import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  AnalysisRetryConflictError,
  claimAnalysisJob,
  enqueueAnalysis,
  findEnqueuedAnalysisRequest,
  failAnalysisJob,
  getOwnerAnalysisProgress,
  renewAnalysisLease,
} from "../packages/database/src/queue.ts";
import type { PrismaClient } from "../packages/database/generated/client.ts";

const noDatabase = {} as PrismaClient;
const validEnqueue = {
  ownerUserId: "user-1",
  repositoryId: "repository-1",
  branchName: "main",
  commitSha: "a".repeat(40),
  configuration: { includeTests: false },
  analyzerVersion: "analyzer-1",
  schemaVersion: "1",
};
const validClaim = {
  jobId: "job-1",
  analysisId: "analysis-1",
  ownerUserId: "user-1",
  attempt: 1,
  leaseToken: "550e8400-e29b-41d4-a716-446655440000",
  leaseExpiresAt: new Date("2026-10-19T00:00:00.000Z"),
};

test("queue enqueue rejects incomplete immutable snapshots before opening a transaction", async () => {
  let transactions = 0;
  const db = { $transaction: async () => { transactions += 1; } } as unknown as PrismaClient;
  await assert.rejects(enqueueAnalysis(db, { ...validEnqueue, ownerUserId: " " }), /Pemilik/);
  await assert.rejects(enqueueAnalysis(db, { ...validEnqueue, commitSha: "a".repeat(39) }), /full SHA/);
  await assert.rejects(enqueueAnalysis(db, { ...validEnqueue, commitSha: "z".repeat(40) }), /full SHA/);
  await assert.rejects(enqueueAnalysis(db, { ...validEnqueue, configuration: ["not", "an", "object"] }), /object JSON/);
  await assert.rejects(enqueueAnalysis(db, { ...validEnqueue, idempotency: { keyHash: "bad", requestHash: "a".repeat(64) } }), /Hash kunci idempotensi/);
  await assert.rejects(enqueueAnalysis(db, { ...validEnqueue, idempotency: { keyHash: "a".repeat(64), requestHash: "bad" } }), /Hash permintaan idempotensi/);
  await assert.rejects(findEnqueuedAnalysisRequest(db, "user-1", "a".repeat(64), "bad"), /Hash permintaan idempotensi/);
  assert.equal(transactions, 0);
});

test("queue configuration accepts only plain finite acyclic JSON", async () => {
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  const getter = Object.defineProperty({}, "hidden", { enumerable: true, get: () => true });
  const db = { $transaction: async () => { throw new Error("database should not be reached"); } } as unknown as PrismaClient;
  await assert.rejects(enqueueAnalysis(db, { ...validEnqueue, configuration: circular }), /melingkar/);
  await assert.rejects(enqueueAnalysis(db, { ...validEnqueue, configuration: getter }), /properti JSON biasa/);
  await assert.rejects(enqueueAnalysis(db, { ...validEnqueue, configuration: { value: Number.NaN } }), /angka yang tidak valid/);
});

test("enqueue snapshots mutable caller input before waiting for the database transaction", async () => {
  let releaseTransaction: (() => void) | undefined;
  const transactionGate = new Promise<void>((resolveGate) => { releaseTransaction = resolveGate; });
  let queryNumber = 0;
  let analysisData: Record<string, unknown> | undefined;
  let jobData: Record<string, unknown> | undefined;
  const transaction = {
    $executeRaw: async () => 1,
    $queryRaw: async () => {
      queryNumber += 1;
      if (queryNumber === 1) return [{ jobId: null, ownerUserId: null, leaseUntil: null, heartbeatAt: null, leaseTokenHash: null, lastEnqueueSequence: 0n }];
      if (queryNumber === 2) return [{ sequence: 1n }];
      return [{ fullName: "example/repository" }];
    },
    analysis: { create: async ({ data }: { data: Record<string, unknown> }) => { analysisData = data; return { id: "analysis-snapshot" }; } },
    job: { create: async ({ data }: { data: Record<string, unknown> }) => { jobData = data; return { id: "job-snapshot" }; } },
  };
  const db = {
    $transaction: async (work: (tx: typeof transaction) => Promise<unknown>) => {
      await transactionGate;
      return work(transaction);
    },
  } as unknown as PrismaClient;
  const input = {
    ...validEnqueue,
    configuration: { nested: { value: "before" } },
  };
  const pendingEnqueue = enqueueAnalysis(db, input);
  input.ownerUserId = "changed-owner";
  input.repositoryId = "changed-repository";
  input.branchName = "changed-branch";
  input.commitSha = "f".repeat(40);
  input.analyzerVersion = "changed-analyzer";
  input.schemaVersion = "changed-schema";
  input.configuration.nested.value = "after";
  releaseTransaction?.();

  const result = await pendingEnqueue;
  assert.deepEqual(analysisData, {
    ownerUserId: "user-1",
    repositoryId: "repository-1",
    repositoryFullNameSnapshot: "example/repository",
    retryParentId: null,
    branchName: "main",
    commitSha: "a".repeat(40),
    configuration: { nested: { value: "before" } },
    configurationHash: createHash("sha256").update('{"nested":{"value":"before"}}', "utf8").digest("hex"),
    analyzerVersion: "analyzer-1",
    schemaVersion: "1",
  });
  assert.deepEqual(jobData, { ownerUserId: "user-1", analysisId: "analysis-snapshot", type: "ANALYSIS", queueSequence: 1n });
  assert.equal(result.analysisId, "analysis-snapshot");
});

test("retry enqueue locks and validates the failed immutable parent before inserting the new job", async () => {
  const configurationHash = createHash("sha256").update('{"includeTests":false}', "utf8").digest("hex");
  let queryNumber = 0;
  let analysisData: Record<string, unknown> | undefined;
  let jobData: Record<string, unknown> | undefined;
  const transaction = {
    $executeRaw: async () => 1,
    $queryRaw: async () => {
      queryNumber += 1;
      if (queryNumber === 1) return [{ jobId: null, ownerUserId: null, leaseUntil: null, heartbeatAt: null, leaseTokenHash: null, lastEnqueueSequence: 4n }];
      if (queryNumber === 2) return [{ status: "FAILED", repositoryId: validEnqueue.repositoryId, branchName: validEnqueue.branchName, commitSha: validEnqueue.commitSha, configurationHash, analyzerVersion: validEnqueue.analyzerVersion, schemaVersion: validEnqueue.schemaVersion, repositoryFullNameSnapshot: "example/repository" }];
      if (queryNumber === 3) return [{ sequence: 5n }];
      return [{ fullName: "renamed/repository" }];
    },
    analysis: {
      findFirst: async () => null,
      create: async ({ data }: { data: Record<string, unknown> }) => { analysisData = data; return { id: "analysis-retry" }; },
    },
    job: { create: async ({ data }: { data: Record<string, unknown> }) => { jobData = data; return { id: "job-retry" }; } },
  };
  const db = { $transaction: async (work: (tx: typeof transaction) => Promise<unknown>) => work(transaction) } as unknown as PrismaClient;
  const input = {
    ...validEnqueue,
    retryParentId: "analysis-failed-parent",
    retryParentRepositoryFullNameSnapshot: "example/repository",
    idempotency: { keyHash: "c".repeat(64), requestHash: "d".repeat(64) },
  };

  const result = await enqueueAnalysis(db, input);
  assert.equal(result.analysisId, "analysis-retry");
  assert.equal(analysisData?.retryParentId, "analysis-failed-parent");
  assert.equal(analysisData?.repositoryFullNameSnapshot, "example/repository", "retry preserves the parent's captured name after a repository rename");
  assert.equal(analysisData?.commitSha, validEnqueue.commitSha);
  assert.equal(analysisData?.configurationHash, configurationHash);
  assert.equal(analysisData?.analyzerVersion, validEnqueue.analyzerVersion);
  assert.equal(analysisData?.schemaVersion, validEnqueue.schemaVersion);
  assert.equal(jobData?.analysisId, "analysis-retry");
  assert.equal(queryNumber, 4, "parent lock precedes queue sequence and inserts");
});

test("retry enqueue rejects a foreign, non-failed, or changed parent before creating rows", async () => {
  const configurationHash = createHash("sha256").update('{"includeTests":false}', "utf8").digest("hex");
  for (const parent of [
    null,
    { status: "RUNNING" },
    { status: "FAILED", repositoryId: "other-repository" },
    { status: "FAILED", commitSha: "f".repeat(40) },
    { status: "FAILED", configurationHash: "e".repeat(64) },
  ]) {
    let queryNumber = 0;
    let analysisCreates = 0;
    const transaction = {
      $executeRaw: async () => 1,
      $queryRaw: async () => {
        queryNumber += 1;
        if (queryNumber === 1) return [{ jobId: null, ownerUserId: null, leaseUntil: null, heartbeatAt: null, leaseTokenHash: null, lastEnqueueSequence: 0n }];
        return parent ? [{
          status: parent.status ?? "FAILED", repositoryId: parent.repositoryId ?? validEnqueue.repositoryId,
          branchName: validEnqueue.branchName, commitSha: parent.commitSha ?? validEnqueue.commitSha,
          configurationHash: parent.configurationHash ?? configurationHash,
          analyzerVersion: validEnqueue.analyzerVersion, schemaVersion: validEnqueue.schemaVersion,
          repositoryFullNameSnapshot: "example/repository",
        }] : [];
      },
      analysis: { create: async () => { analysisCreates += 1; return { id: "should-not-create" }; } },
      job: { create: async () => { throw new Error("job should not be created"); } },
    };
    const db = { $transaction: async (work: (tx: typeof transaction) => Promise<unknown>) => work(transaction) } as unknown as PrismaClient;
    await assert.rejects(enqueueAnalysis(db, {
      ...validEnqueue, retryParentId: "analysis-failed-parent", retryParentRepositoryFullNameSnapshot: "example/repository",
    }), AnalysisRetryConflictError);
    assert.equal(analysisCreates, 0);
    assert.equal(queryNumber, 2, "validation fails before queue position is assigned");
  }
});

test("queue lease durations reject caller-clock or unbounded values before database access", async () => {
  await assert.rejects(claimAnalysisJob(noDatabase, { leaseDurationMs: 999 }), /Durasi lease/);
  await assert.rejects(claimAnalysisJob(noDatabase, { leaseDurationMs: 300_001 }), /Durasi lease/);
  await assert.rejects(claimAnalysisJob(noDatabase, { leaseDurationMs: 1.5 }), /Durasi lease/);
  await assert.rejects(renewAnalysisLease(noDatabase, validClaim, { leaseDurationMs: Number.NaN }), /Durasi lease/);
});

test("queue lease and failure APIs reject malformed handles and error codes before database access", async () => {
  await assert.rejects(renewAnalysisLease(noDatabase, { ...validClaim, attempt: 0 }), /Percobaan/);
  await assert.rejects(renewAnalysisLease(noDatabase, { ...validClaim, leaseToken: "not-a-token" }), /Token lease/);
  await assert.rejects(failAnalysisJob(noDatabase, validClaim, "invalid error"), /Kode error/);
  await assert.rejects(getOwnerAnalysisProgress(noDatabase, "", "analysis-1"), /Pemilik/);
  await assert.rejects(getOwnerAnalysisProgress(noDatabase, "user-1", " "), /ID analisis/);
});
