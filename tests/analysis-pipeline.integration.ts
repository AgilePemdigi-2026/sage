import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { pack } from "tar-stream";
import test from "node:test";
import { parseCanonicalCkg } from "@sage/contracts";
import { projectArchitectureDocument } from "@sage/documents/model";
import { ANALYSIS_STAGE_DEFINITIONS, type AnalysisStageKey } from "../packages/contracts/src/stages.ts";
import {
  claimAnalysisJob,
  database,
  disconnectDatabase,
  enqueueAnalysis,
  failAnalysisJob,
  readCanonicalDocumentForUser,
  readCanonicalGraphForUser,
  storeGitHubCredential,
} from "../packages/database/src/index.ts";
import { publishAnalysisResult } from "../packages/database/src/publication.ts";
import type { AnalysisStageTargetContext } from "../packages/database/src/stages.ts";
import type { AnalysisJobClaim } from "../packages/database/src/queue.ts";
import type { PrismaClient } from "../packages/database/generated/client.ts";
import type { AnalysisStageArtifact, AnalysisStageHandler, AnalysisStageHandlers } from "../apps/worker/src/stage-runner.ts";
import { runAnalysisStages } from "../apps/worker/src/stage-runner.ts";
import { createAnalysisPipeline } from "../apps/worker/src/pipeline.ts";
import { createSnapshotHandler } from "../apps/worker/src/snapshot/handler.ts";
import { createSourceStageHandlers } from "../apps/worker/src/source-handlers.ts";
import { createCkgStageHandlers } from "../apps/worker/src/ckg-handlers.ts";
import { createDocumentStageHandlers } from "../apps/worker/src/document-handlers.ts";
import type { RepositoryArchiveInput } from "../packages/github/archive.ts";

const pipelineTestsEnabled = process.env.SAGE_PIPELINE_TESTS === "1";
const TEST_CONFIGURATION = { sourcePolicyVersion: "sage-source-policy-v1", maxSourceFileBytes: 1_048_576 };
const TEST_COMMIT = "d".repeat(40);

function assertIsolatedPipelineDatabase(): void {
  if (!pipelineTestsEnabled) throw new Error("Set SAGE_PIPELINE_TESTS=1 to run ANA-07 pipeline integration tests.");
  const rawUrl = process.env.DATABASE_URL;
  if (!rawUrl) throw new Error("DATABASE_URL is required for ANA-07 pipeline integration tests.");
  let databaseName: string;
  try {
    databaseName = decodeURIComponent(new URL(rawUrl).pathname.slice(1));
  } catch {
    throw new Error("DATABASE_URL is invalid; it was not logged.");
  }
  if (databaseName !== "sage_pipeline16") throw new Error("ANA-07 pipeline tests only allow the isolated sage_pipeline16 database.");
}

async function createArchive(rootName: string, files: Record<string, Uint8Array>): Promise<Buffer> {
  const stream = pack();
  const chunks: Buffer[] = [];
  const collecting = (async () => { for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array)); })();
  await new Promise<void>((resolve, reject) => stream.entry(
    { name: `${rootName}/`, type: "directory", mtime: new Date(0) },
    error => error ? reject(error) : resolve(),
  ));
  for (const [path, bytes] of Object.entries(files).sort(([left], [right]) => left.localeCompare(right))) {
    await new Promise<void>((resolve, reject) => stream.entry(
      { name: `${rootName}/${path}`, type: "file", size: bytes.byteLength, mode: 0o644, mtime: new Date(0) },
      Buffer.from(bytes),
      error => error ? reject(error) : resolve(),
    ));
  }
  stream.finalize();
  await collecting;
  return gzipSync(Buffer.concat(chunks));
}

interface TestOwner {
  ownerId: string;
  repositoryId: string;
  repositoryFullName: string;
}

async function createOwner(db: PrismaClient, suffix: string): Promise<TestOwner> {
  const owner = await db.user.create({ data: { githubUserId: `pipeline-owner-${suffix}`, login: `pipeline-owner-${suffix}` } });
  const repository = await db.repository.create({
    data: {
      githubRepositoryId: String(8_000_000_000 + randomBytes(4).readUInt32BE(0)),
      ownerLogin: "sage-pipeline-test",
      name: suffix,
      fullName: `sage-pipeline-test/${suffix}`,
      visibility: "PRIVATE",
      defaultBranch: "main",
    },
  });
  await storeGitHubCredential(db, owner.id, {
    githubUserId: `pipeline-gh-${suffix}`,
    githubLogin: `pipeline-user-${suffix}`,
    accessToken: `pipeline-test-token-${suffix}`,
  });
  return { ownerId: owner.id, repositoryId: repository.id, repositoryFullName: repository.fullName };
}

async function enqueueAndClaim(db: PrismaClient, owner: TestOwner, suffix: string) {
  const enqueued = await enqueueAnalysis(db, {
    ownerUserId: owner.ownerId,
    repositoryId: owner.repositoryId,
    branchName: "main",
    commitSha: TEST_COMMIT,
    configuration: TEST_CONFIGURATION,
    analyzerVersion: "ana07-pipeline-test-v1",
    schemaVersion: "1",
  });
  const claim = await claimAnalysisJob(db, { leaseDurationMs: 300_000 });
  assert.ok(claim, `queued analysis ${suffix} must be claimed`);
  assert.equal(claim.analysisId, enqueued.analysisId);
  return { enqueued, claim };
}

async function cleanupOwner(
  db: PrismaClient,
  owner: TestOwner | null,
  claims: readonly AnalysisJobClaim[],
  storageRoot: string,
): Promise<void> {
  for (const claim of claims) await failAnalysisJob(db, claim, "PIPELINE_TEST_CLEANUP").catch(() => false);
  if (owner) {
    await db.$transaction(async tx => {
      await tx.workerSlot.updateMany({
        where: { ownerUserId: owner.ownerId },
        data: { jobId: null, ownerUserId: null, leaseUntil: null, heartbeatAt: null, leaseTokenHash: null },
      });
      await tx.job.deleteMany({ where: { ownerUserId: owner.ownerId } });
      await tx.analysis.deleteMany({ where: { ownerUserId: owner.ownerId } });
      await tx.gitHubConnection.deleteMany({ where: { userId: owner.ownerId } });
      await tx.user.deleteMany({ where: { id: owner.ownerId } });
      await tx.repository.deleteMany({ where: { id: owner.repositoryId } });
    });
  }
  if (storageRoot) await rm(storageRoot, { recursive: true, force: true });
}

async function runTrustedPipeline(
  db: PrismaClient,
  claim: AnalysisJobClaim,
  storageRoot: string,
  archive: Uint8Array,
  expectedRepositoryFullName: string,
): Promise<void> {
  const observed: RepositoryArchiveInput[] = [];
  const pipeline = createAnalysisPipeline({
    db,
    storageRoot,
    leaseDurationMs: 300_000,
    fetchArchive: async request => {
      observed.push(request);
      return archive;
    },
  });
  const result = await pipeline(claim);
  assert.equal(result.stagesFinished, result.stages.length === 9 && result.stages.every(stage => stage.status === "COMPLETED"));
  assert.deepEqual(observed.map(({ commitSha, repository }) => ({ commitSha, repository })), [{ commitSha: TEST_COMMIT, repository: expectedRepositoryFullName }]);
}

interface CapturedStages {
  target?: AnalysisStageTargetContext;
  configuration?: unknown;
  outputs: Partial<Record<string, AnalysisStageArtifact>>;
}

function captureHandler(key: string, handler: AnalysisStageHandler, captured: CapturedStages): AnalysisStageHandler {
  return async (context, signal) => {
    captured.target ??= context.target;
    captured.configuration ??= context.configuration;
    const value = await handler(context, signal);
    if (value !== undefined) captured.outputs[key] = value;
    return value;
  };
}

async function runStagesWithoutPublisher(
  db: PrismaClient,
  claim: AnalysisJobClaim,
  storageRoot: string,
  archive: Uint8Array,
): Promise<CapturedStages> {
  const captured: CapturedStages = { outputs: Object.create(null) as Partial<Record<string, AnalysisStageArtifact>> };
  const handlers = {
    SNAPSHOT: createSnapshotHandler({ claim, storageRoot, db, fetchArchive: async () => archive }),
    ...createSourceStageHandlers({ claim, storageRoot, db }),
    ...createCkgStageHandlers({ claim, storageRoot, db }),
    ...createDocumentStageHandlers({ claim, storageRoot, db }),
  };
  const wrapped = Object.fromEntries(Object.entries(handlers).map(([key, handler]) => [key, captureHandler(key, handler, captured)])) as typeof handlers;
  const result = await runAnalysisStages(db, claim, wrapped, { leaseDurationMs: 300_000 });
  assert.equal(result.stagesFinished, true, JSON.stringify(result.stages));
  return captured;
}

function capturedRecord(captured: CapturedStages, key: string): Record<string, unknown> {
  const value = captured.outputs[key];
  assert.ok(value && typeof value === "object" && !Array.isArray(value), `${key} output should be an object`);
  return value as Record<string, unknown>;
}

function publicationInput(captured: CapturedStages, claim: AnalysisJobClaim, sourceBytes: Record<string, Uint8Array>) {
  const target = captured.target;
  assert.ok(target);
  const snapshot = capturedRecord(captured, "SNAPSHOT");
  const graphArtifact = capturedRecord(captured, "KNOWLEDGE_GRAPH");
  const documentArtifact = capturedRecord(captured, "ARCHITECTURE_DOCUMENT");
  const canonicalCkgJson = JSON.stringify(graphArtifact.graph);
  if (typeof canonicalCkgJson !== "string") throw new Error("Captured graph is not serializable.");
  const graph = parseCanonicalCkg(canonicalCkgJson, sourceBytes, String(graphArtifact.contentSha256));
  assert.ok(graph.ok);
  const document = projectArchitectureDocument(graph.json, sourceBytes, graph.sha256);
  assert.ok(document.ok);
  assert.equal(documentArtifact.canonicalJson, document.json);
  return {
    claim,
    target,
    configuration: captured.configuration,
    snapshot: snapshot as unknown as {
      storageObjectId: string;
      archiveSha256: string;
      archiveBytes: number;
      commitSha: string;
      files: number;
      extractedBytes: number;
    },
    sourceBytes,
    canonicalCkgJson,
    expectedCkgSha256: graph.sha256,
    graphBundleId: String(graphArtifact.graphBundleId),
    canonicalDocumentJson: document.json,
    expectedDocumentSha256: document.sha256,
    architectureDocumentId: String(documentArtifact.documentId),
  };
}

function expireLeaseAfterSourceInsert(db: PrismaClient, claim: AnalysisJobClaim): PrismaClient {
  const transaction = db.$transaction.bind(db);
  return new Proxy(db, {
    get(target, property, receiver) {
      if (property !== "$transaction") return Reflect.get(target, property, receiver);
      return ((callback: (tx: unknown) => Promise<unknown>) => transaction(async tx => {
        const wrapped = new Proxy(tx, {
          get(transactionClient, key) {
            const delegate = Reflect.get(transactionClient, key, transactionClient) as unknown;
            if (key !== "sourceFile" || typeof delegate !== "object" || delegate === null) {
              return typeof delegate === "function" ? delegate.bind(transactionClient) : delegate;
            }
            return new Proxy(delegate, {
              get(sourceFiles, method) {
                const operation = Reflect.get(sourceFiles, method, sourceFiles) as unknown;
                if (method !== "createMany" || typeof operation !== "function") {
                  return typeof operation === "function" ? operation.bind(sourceFiles) : operation;
                }
                return async (...args: unknown[]) => {
                  const inserted = await Reflect.apply(operation, sourceFiles, args) as unknown;
                  await tx.$executeRaw`UPDATE "WorkerSlot" SET "leaseUntil" = clock_timestamp() - INTERVAL '1 millisecond' WHERE "slotKey" = 'analysis' AND "jobId" = ${claim.jobId} AND "ownerUserId" = ${claim.ownerUserId}`;
                  await tx.$executeRaw`UPDATE "Job" SET "leaseExpiresAt" = clock_timestamp() - INTERVAL '1 millisecond' WHERE "id" = ${claim.jobId} AND "ownerUserId" = ${claim.ownerUserId}`;
                  return inserted;
                };
              },
            });
          },
        });
        return callback(wrapped);
      })) as typeof target.$transaction;
    },
  });
}

test("ANA-07 composes production stages, atomically publishes terminal results, and hashes canonical inputs", {
  skip: !pipelineTestsEnabled,
}, async () => {
  assertIsolatedPipelineDatabase();
  const db = database();
  const suffix = randomUUID();
  const previousEncryptionKey = process.env.CREDENTIAL_ENCRYPTION_KEY;
  process.env.CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  let owner: TestOwner | null = null;
  let storageRoot = "";
  const claims: AnalysisJobClaim[] = [];
  try {
    owner = await createOwner(db, suffix);
    storageRoot = await mkdtemp(join(tmpdir(), "sage-pipeline16-"));
    const cleanSources = { "src/index.ts": new TextEncoder().encode("export function answer() { return 42; }\n") };
    const firstArchive = await createArchive("first-root", cleanSources);
    const first = await enqueueAndClaim(db, owner, "first canonical run");
    claims.push(first.claim);
    // Exercise the publisher's bounded transaction with database work longer than
    // Prisma's previous 5s default while the test claim has a 300s lease.
    const slowFunctionName = `pipeline16_slow_${suffix.replaceAll("-", "")}`;
    const slowTriggerName = `${slowFunctionName}_trigger`;
    try {
      await db.$executeRawUnsafe(`CREATE FUNCTION "${slowFunctionName}"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(6); RETURN NEW; END $$`);
      await db.$executeRawUnsafe(`CREATE TRIGGER "${slowTriggerName}" BEFORE INSERT ON "SourceFile" FOR EACH ROW EXECUTE FUNCTION "${slowFunctionName}"()`);
      await runTrustedPipeline(db, first.claim, storageRoot, firstArchive, owner.repositoryFullName);
    } finally {
      await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${slowTriggerName}" ON "SourceFile"`);
      await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${slowFunctionName}"()`);
    }
    const firstAnalysis = await db.analysis.findUniqueOrThrow({ where: { id: first.enqueued.analysisId }, select: { status: true, resultHash: true } });
    assert.equal(firstAnalysis.status, "COMPLETED");
    assert.match(firstAnalysis.resultHash ?? "", /^[a-f0-9]{64}$/);
    assert.equal((await db.job.findUniqueOrThrow({ where: { id: first.claim.jobId }, select: { status: true } })).status, "COMPLETED");
    assert.ok(await readCanonicalGraphForUser(db, owner.ownerId, first.enqueued.analysisId, cleanSources));
    assert.ok(await readCanonicalDocumentForUser(db, owner.ownerId, first.enqueued.analysisId, cleanSources));
    assert.equal(await db.sourceFile.count({ where: { analysisId: first.enqueued.analysisId } }), 1);
    assert.equal(await db.analysisLimitation.count({ where: { analysisId: first.enqueued.analysisId } }), 0);

    const secondArchive = await createArchive("different-root", cleanSources);
    const second = await enqueueAndClaim(db, owner, "same canonical input under a new analysis");
    claims.push(second.claim);
    await runTrustedPipeline(db, second.claim, storageRoot, secondArchive, owner.repositoryFullName);
    const secondAnalysis = await db.analysis.findUniqueOrThrow({ where: { id: second.enqueued.analysisId }, select: { status: true, resultHash: true } });
    assert.equal(secondAnalysis.status, "COMPLETED");
    assert.equal(secondAnalysis.resultHash, firstAnalysis.resultHash, "result identity must ignore analysis IDs and archive encoding/root bytes");
    const archiveHashes = await db.storageObject.findMany({ where: { analysisId: { in: [first.enqueued.analysisId, second.enqueued.analysisId] } }, orderBy: { analysisId: "asc" }, select: { sha256: true } });
    assert.equal(archiveHashes.length, 2);
    assert.notEqual(archiveHashes[0]?.sha256, archiveHashes[1]?.sha256, "the physical archives differ despite identical canonical files");

    const limitedSources = {
      "src/index.ts": new TextEncoder().encode("export function answer() { return 42; }\n"),
      "README.md": new TextEncoder().encode("documentation is intentionally outside the source model"),
    };
    const limited = await enqueueAndClaim(db, owner, "excluded source limitation");
    claims.push(limited.claim);
    await runTrustedPipeline(db, limited.claim, storageRoot, await createArchive("limited-root", limitedSources), owner.repositoryFullName);
    const limitedAnalysis = await db.analysis.findUniqueOrThrow({ where: { id: limited.enqueued.analysisId }, select: { status: true, resultHash: true } });
    assert.equal(limitedAnalysis.status, "COMPLETED_WITH_LIMITATIONS");
    assert.match(limitedAnalysis.resultHash ?? "", /^[a-f0-9]{64}$/);
    const limitation = await db.analysisLimitation.findFirstOrThrow({ where: { analysisId: limited.enqueued.analysisId, code: "SOURCE_FILES_EXCLUDED" }, select: { code: true, safeExplanation: true, affectedPartCount: true } });
    assert.equal(limitation.code, "SOURCE_FILES_EXCLUDED");
    assert.equal(limitation.affectedPartCount, 1);
    assert.match(limitation.safeExplanation, /file source dikecualikan/u);
    assert.equal(await db.analysisLimitation.count({ where: { analysisId: limited.enqueued.analysisId, code: "MODEL_LIMITATIONS" } }), 0, "source exclusions must not be duplicated as model limitations");
    assert.ok(await readCanonicalGraphForUser(db, owner.ownerId, limited.enqueued.analysisId, limitedSources));

    const interrupted = await enqueueAndClaim(db, owner, "worker shutdown during provider fetch");
    claims.push(interrupted.claim);
    let providerStarted: (() => void) | undefined;
    const providerStartedPromise = new Promise<void>(resolve => { providerStarted = resolve; });
    const interruptController = new AbortController();
    const interruptiblePipeline = createAnalysisPipeline({
      db,
      storageRoot,
      leaseDurationMs: 300_000,
      fetchArchive: async ({ signal }) => {
        if (!signal) throw new Error("Snapshot provider signal was not supplied.");
        providerStarted?.();
        return new Promise<Uint8Array>((_resolve, reject) => {
          const rejectOnAbort = () => reject(new Error("provider request aborted"));
          if (signal.aborted) rejectOnAbort();
          else signal.addEventListener("abort", rejectOnAbort, { once: true });
        });
      },
    });
    const interruptRun = interruptiblePipeline(interrupted.claim, interruptController.signal);
    await providerStartedPromise;
    interruptController.abort();
    const interruptedStages = await interruptRun;
    assert.equal(interruptedStages.stagesFinished, false);
    const interruptedAnalysis = await db.analysis.findUniqueOrThrow({ where: { id: interrupted.enqueued.analysisId }, select: { status: true, errorCode: true, resultHash: true } });
    assert.deepEqual(interruptedAnalysis, { status: "FAILED", errorCode: "WORKER_INTERRUPTED", resultHash: null });
    assert.equal(await db.graphBundle.count({ where: { analysisId: interrupted.enqueued.analysisId } }), 0);
    assert.equal(await db.architectureDocument.count({ where: { analysisId: interrupted.enqueued.analysisId } }), 0);

    const failed = await enqueueAndClaim(db, owner, "invalid provider archive");
    claims.push(failed.claim);
    const invalidPipeline = createAnalysisPipeline({
      db,
      storageRoot,
      leaseDurationMs: 300_000,
      fetchArchive: async () => Buffer.from("not a gzip archive"),
    });
    const failedStages = await invalidPipeline(failed.claim);
    assert.equal(failedStages.stagesFinished, false);
    const failedAnalysis = await db.analysis.findUniqueOrThrow({ where: { id: failed.enqueued.analysisId }, select: { status: true, resultHash: true } });
    assert.equal(failedAnalysis.status, "FAILED");
    assert.equal(failedAnalysis.resultHash, null);
    assert.equal(await db.graphBundle.count({ where: { analysisId: failed.enqueued.analysisId } }), 0);
    assert.equal(await db.architectureDocument.count({ where: { analysisId: failed.enqueued.analysisId } }), 0);
    assert.equal(await db.sourceFile.count({ where: { analysisId: failed.enqueued.analysisId } }), 0);
    assert.equal(await db.analysisLimitation.count({ where: { analysisId: failed.enqueued.analysisId } }), 0);
    assert.equal(await readCanonicalGraphForUser(db, owner.ownerId, failed.enqueued.analysisId, {}), null);
    assert.equal(await readCanonicalDocumentForUser(db, owner.ownerId, failed.enqueued.analysisId, {}), null);

    const timedOut = await enqueueAndClaim(db, owner, "whole-job deadline");
    claims.push(timedOut.claim);
    const invoked: AnalysisStageKey[] = [];
    const timeoutHandlers = Object.fromEntries(ANALYSIS_STAGE_DEFINITIONS.map(({ key }) => [key, async () => {
      invoked.push(key);
      if (key === "SNAPSHOT") return new Promise<never>(() => undefined);
      return {};
    }])) as unknown as AnalysisStageHandlers;
    const timeoutResult = await runAnalysisStages(db, timedOut.claim, timeoutHandlers, {
      leaseDurationMs: 300_000,
      executionTimeoutMs: 1_000,
    });
    assert.equal(timeoutResult.stagesFinished, false);
    assert.deepEqual(invoked, ["SNAPSHOT"], "a timeout must prevent later stages from starting");
    assert.deepEqual(timeoutResult.stages.map(stage => stage.status), ["FAILED", ...Array(8).fill("PENDING")]);
    const timeoutAnalysis = await db.analysis.findUniqueOrThrow({ where: { id: timedOut.enqueued.analysisId }, select: { status: true, errorCode: true, resultHash: true } });
    assert.deepEqual(timeoutAnalysis, { status: "FAILED", errorCode: "ANALYSIS_TIMEOUT", resultHash: null });
    const timeoutJob = await db.job.findUniqueOrThrow({ where: { id: timedOut.claim.jobId }, select: { status: true, errorCode: true } });
    assert.deepEqual(timeoutJob, { status: "FAILED", errorCode: "ANALYSIS_TIMEOUT" });
    assert.equal(await db.graphBundle.count({ where: { analysisId: timedOut.enqueued.analysisId } }), 0);
    assert.equal(await db.architectureDocument.count({ where: { analysisId: timedOut.enqueued.analysisId } }), 0);
  } finally {
    await cleanupOwner(db, owner, claims, storageRoot);
    await disconnectDatabase();
    if (previousEncryptionKey === undefined) delete process.env.CREDENTIAL_ENCRYPTION_KEY;
    else process.env.CREDENTIAL_ENCRYPTION_KEY = previousEncryptionKey;
  }
});

test("ANA-07 publisher rejects tampered mirrors and rolls back if the DB-clock lease expires", {
  skip: !pipelineTestsEnabled,
}, async () => {
  assertIsolatedPipelineDatabase();
  const db = database();
  const suffix = randomUUID();
  const previousEncryptionKey = process.env.CREDENTIAL_ENCRYPTION_KEY;
  process.env.CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  let owner: TestOwner | null = null;
  let storageRoot = "";
  const claims: AnalysisJobClaim[] = [];
  try {
    owner = await createOwner(db, suffix);
    storageRoot = await mkdtemp(join(tmpdir(), "sage-pipeline16-publication-"));
    const sourceBytes = { "src/index.ts": new TextEncoder().encode("export const answer = 42;\n") };

    const tampered = await enqueueAndClaim(db, owner, "tampered graph mirror");
    claims.push(tampered.claim);
    const tamperedCapture = await runStagesWithoutPublisher(db, tampered.claim, storageRoot, await createArchive("tampered-root", sourceBytes));
    const tamperedInput = publicationInput(tamperedCapture, tampered.claim, sourceBytes);
    await db.graphBundle.update({
      where: { analysisId_ownerUserId: { analysisId: tampered.enqueued.analysisId, ownerUserId: owner.ownerId } },
      data: { nodes: JSON.stringify([]) },
    });
    await assert.rejects(publishAnalysisResult(db, tamperedInput), /Stored graph bundle does not match/u);
    assert.equal(await db.sourceFile.count({ where: { analysisId: tampered.enqueued.analysisId } }), 0);
    assert.equal(await db.analysisLimitation.count({ where: { analysisId: tampered.enqueued.analysisId } }), 0);
    assert.equal((await db.analysis.findUniqueOrThrow({ where: { id: tampered.enqueued.analysisId }, select: { status: true, resultHash: true } })).status, "RUNNING");
    assert.equal(await readCanonicalGraphForUser(db, owner.ownerId, tampered.enqueued.analysisId, sourceBytes), null);
    assert.equal(await readCanonicalDocumentForUser(db, owner.ownerId, tampered.enqueued.analysisId, sourceBytes), null);
    assert.equal(await failAnalysisJob(db, tampered.claim, "PIPELINE_TEST_TAMPER"), true);

    const expired = await enqueueAndClaim(db, owner, "lease expiry during publication transaction");
    claims.push(expired.claim);
    const expiredCapture = await runStagesWithoutPublisher(db, expired.claim, storageRoot, await createArchive("expired-root", sourceBytes));
    const expiredInput = publicationInput(expiredCapture, expired.claim, sourceBytes);
    const published = await publishAnalysisResult(expireLeaseAfterSourceInsert(db, expired.claim), expiredInput);
    assert.equal(published, false, "publication should reject a lease that expires after its source mirror writes");
    assert.equal(await db.sourceFile.count({ where: { analysisId: expired.enqueued.analysisId } }), 0, "source rows must roll back with expired lease");
    assert.equal(await db.analysisLimitation.count({ where: { analysisId: expired.enqueued.analysisId } }), 0);
    const stillRunning = await db.analysis.findUniqueOrThrow({ where: { id: expired.enqueued.analysisId }, select: { status: true, resultHash: true } });
    assert.equal(stillRunning.status, "RUNNING");
    assert.equal(stillRunning.resultHash, null);

    // Expire the still-owned DB claim outside the publication transaction and verify
    // the normal queue claimant performs safe recovery on its next pass.
    await db.$executeRaw`UPDATE "WorkerSlot" SET "leaseUntil" = clock_timestamp() - INTERVAL '1 millisecond' WHERE "slotKey" = 'analysis' AND "jobId" = ${expired.claim.jobId}`;
    await db.$executeRaw`UPDATE "Job" SET "leaseExpiresAt" = clock_timestamp() - INTERVAL '1 millisecond' WHERE "id" = ${expired.claim.jobId}`;
    assert.equal(await claimAnalysisJob(db, { leaseDurationMs: 300_000 }), null);
    const recoveredAnalysis = await db.analysis.findUniqueOrThrow({ where: { id: expired.enqueued.analysisId }, select: { status: true, errorCode: true, resultHash: true } });
    const recoveredJob = await db.job.findUniqueOrThrow({ where: { id: expired.claim.jobId }, select: { status: true, errorCode: true } });
    assert.deepEqual(recoveredAnalysis, { status: "FAILED", errorCode: "WORKER_INTERRUPTED", resultHash: null });
    assert.deepEqual(recoveredJob, { status: "FAILED", errorCode: "WORKER_INTERRUPTED" });
    assert.equal(await db.sourceFile.count({ where: { analysisId: expired.enqueued.analysisId } }), 0);
    assert.equal(await db.analysisLimitation.count({ where: { analysisId: expired.enqueued.analysisId } }), 0);
    assert.equal((await db.workerSlot.findUniqueOrThrow({ where: { slotKey: "analysis" }, select: { jobId: true } })).jobId, null);
  } finally {
    await cleanupOwner(db, owner, claims, storageRoot);
    await disconnectDatabase();
    if (previousEncryptionKey === undefined) delete process.env.CREDENTIAL_ENCRYPTION_KEY;
    else process.env.CREDENTIAL_ENCRYPTION_KEY = previousEncryptionKey;
  }
});
