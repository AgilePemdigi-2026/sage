import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { access, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { After, Given, Then, When, type DataTable } from "@cucumber/cucumber";
import { canonicalizeCcm, validateCcm } from "../../../packages/contracts/src/index.ts";
import { ANALYSIS_STAGE_DEFINITIONS, type AnalysisStagesResult } from "../../../packages/contracts/src/stages.ts";
import {
  claimAnalysisJob,
  database,
  disconnectDatabase,
  enqueueAnalysis,
  failAnalysisJob,
  getOwnerAnalysisProgress,
  renewAnalysisLease,
} from "../../../packages/database/src/index.ts";
import type { AnalysisJobClaim, EnqueuedAnalysis } from "../../../packages/database/src/queue.ts";
import type { PrismaClient } from "../../../packages/database/generated/client.ts";
import { analyzeSnapshotSources, scanSnapshotSources } from "../../../apps/worker/src/source-analysis.ts";
import type { SnapshotFile } from "../../../apps/worker/src/snapshot/archive.ts";
import { runAnalysisStages } from "../../../apps/worker/src/stage-runner.ts";
import type { AnalysisStageContext, AnalysisStageHandlers } from "../../../apps/worker/src/stage-runner.ts";
import type { SageWorld } from "../support/world.ts";

interface DomainState {
  files: SnapshotFile[];
  sourceResult: Awaited<ReturnType<typeof analyzeSnapshotSources>> | null;
  scanReport: ReturnType<typeof scanSnapshotSources> | null;
  canaryPath: string | null;
  db: PrismaClient | null;
  userIds: string[];
  repositoryIds: string[];
  analysisIds: string[];
  jobIds: string[];
  claims: AnalysisJobClaim[];
  owners: [string, string] | null;
  repositoryId: string | null;
  repositoryFullName: string | null;
  enqueued: EnqueuedAnalysis[];
  runnerResult: AnalysisStagesResult | null;
  calledStages: string[];
  maxConcurrentHandlers: number;
}

const stateByWorld = new WeakMap<SageWorld, DomainState>();
const encoder = new TextEncoder();
const TEST_DATABASE_NAME = "sage_bdd_sprint1";

function stateFor(world: SageWorld): DomainState {
  let state = stateByWorld.get(world);
  if (!state) {
    state = {
      files: [],
      sourceResult: null,
      scanReport: null,
      canaryPath: null,
      db: null,
      userIds: [],
      repositoryIds: [],
      analysisIds: [],
      jobIds: [],
      claims: [],
      owners: null,
      repositoryId: null,
      repositoryFullName: null,
      enqueued: [],
      runnerResult: null,
      calledStages: [],
      maxConcurrentHandlers: 0,
    };
    stateByWorld.set(world, state);
  }
  return state;
}

function snapshotFile(path: string, content: string | Uint8Array): SnapshotFile {
  const bytes = typeof content === "string" ? encoder.encode(content) : new Uint8Array(content);
  return {
    relativePath: path,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    byteLength: bytes.byteLength,
    bytes,
  };
}

const testSnapshot = {
  repository: "sage-bdd/domain-fixtures",
  branch: "main",
  commitSha: "a".repeat(40),
};

function getIsolatedDatabase(state: DomainState): PrismaClient {
  if (process.env.SAGE_BDD_TESTS !== "1") {
    throw new Error("Set SAGE_BDD_TESTS=1 before running @database Sprint 1 BDD scenarios.");
  }
  const rawUrl = process.env.DATABASE_URL;
  if (!rawUrl) throw new Error("DATABASE_URL is required for @database Sprint 1 BDD scenarios.");

  let databaseName: string;
  try {
    databaseName = decodeURIComponent(new URL(rawUrl).pathname.slice(1));
  } catch {
    throw new Error("DATABASE_URL is invalid; its value was not logged.");
  }
  if (databaseName !== TEST_DATABASE_NAME) {
    throw new Error(`@database Sprint 1 BDD scenarios only allow the isolated ${TEST_DATABASE_NAME} database.`);
  }

  state.db ??= database();
  return state.db;
}

async function prepareDatabaseFixture(world: SageWorld): Promise<{ db: PrismaClient; state: DomainState }> {
  const state = stateFor(world);
  const db = getIsolatedDatabase(state);
  const suffix = randomUUID();
  const first = await db.user.create({
    data: { githubUserId: `bdd-first-${suffix}`, login: `bdd-first-${suffix}` },
  });
  state.userIds.push(first.id);
  const second = await db.user.create({
    data: { githubUserId: `bdd-second-${suffix}`, login: `bdd-second-${suffix}` },
  });
  state.userIds.push(second.id);
  const repository = await db.repository.create({
    data: {
      githubRepositoryId: `bdd-repository-${suffix}`,
      ownerLogin: "sage-bdd-fixture",
      name: suffix,
      fullName: `sage-bdd-fixture/${suffix}`,
      visibility: "PUBLIC",
      defaultBranch: "main",
    },
  });
  state.repositoryIds.push(repository.id);
  state.owners = [first.id, second.id];
  state.repositoryId = repository.id;
  state.repositoryFullName = repository.fullName;
  return { db, state };
}

function requirePreparedDatabase(world: SageWorld): { db: PrismaClient; state: DomainState; owners: [string, string]; repositoryId: string; repositoryFullName: string } {
  const state = stateFor(world);
  if (!state.db || !state.owners || !state.repositoryId || !state.repositoryFullName) {
    throw new Error("The PostgreSQL fixture has not been prepared by the Given step.");
  }
  return {
    db: state.db,
    state,
    owners: state.owners,
    repositoryId: state.repositoryId,
    repositoryFullName: state.repositoryFullName,
  };
}

async function enqueueFor(
  state: DomainState,
  db: PrismaClient,
  input: { ownerUserId: string; repositoryId: string; branchName?: string; commitSha: string; idempotency?: { keyHash: string; requestHash: string } },
): Promise<EnqueuedAnalysis> {
  const result = await enqueueAnalysis(db, {
    ownerUserId: input.ownerUserId,
    repositoryId: input.repositoryId,
    branchName: input.branchName ?? "main",
    commitSha: input.commitSha,
    configuration: { includeTests: false, sourcePolicy: "sage-source-policy-v1" },
    analyzerVersion: "sprint1-bdd-1",
    schemaVersion: "1",
    ...(input.idempotency ? { idempotency: input.idempotency } : {}),
  });
  state.analysisIds.push(result.analysisId);
  state.jobIds.push(result.jobId);
  state.enqueued.push(result);
  return result;
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function expireLease(db: PrismaClient, claim: AnalysisJobClaim): Promise<void> {
  const tokenHash = hash(claim.leaseToken);
  await db.$executeRaw`
    UPDATE "WorkerSlot"
    SET "leaseUntil" = clock_timestamp() - INTERVAL '1 second'
    WHERE "slotKey" = 'analysis' AND "jobId" = ${claim.jobId}
      AND "ownerUserId" = ${claim.ownerUserId} AND "leaseTokenHash" = ${tokenHash}
  `;
  await db.$executeRaw`
    UPDATE "Job"
    SET "leaseExpiresAt" = clock_timestamp() - INTERVAL '1 second'
    WHERE "id" = ${claim.jobId} AND "ownerUserId" = ${claim.ownerUserId}
      AND "attempt" = ${claim.attempt}
  `;
}

function controlledHandlers(onStage: (key: string) => Promise<unknown> | unknown): AnalysisStageHandlers {
  const handlers = Object.fromEntries(ANALYSIS_STAGE_DEFINITIONS.map(({ key }) => [key, async (_context: AnalysisStageContext, signal: AbortSignal) => {
    signal.throwIfAborted();
    return onStage(key);
  }])) as unknown as AnalysisStageHandlers;
  return handlers;
}

Given("an immutable snapshot contains the following source files:", function (this: SageWorld, table: DataTable) {
  const state = stateFor(this);
  state.files = table.hashes().map((row) => snapshotFile(row.path!, row.source!));
  state.sourceResult = null;
  state.scanReport = null;
});

Given("a source snapshot contains a Composer configuration with a filesystem canary", function (this: SageWorld) {
  const state = stateFor(this);
  const canaryPath = join(tmpdir(), `sage-bdd-canary-${randomUUID()}`);
  state.canaryPath = canaryPath;
  const postInstallCommand = `@php -r 'file_put_contents(${JSON.stringify(canaryPath)}, "executed");'`;
  const composerJson = JSON.stringify({
    name: "sage/bdd-canary",
    scripts: { "post-install-cmd": [postInstallCommand] },
  });
  const manifest = JSON.parse(composerJson) as { name: string; scripts: { "post-install-cmd": string[] } };
  assert.equal(manifest.name, "sage/bdd-canary");
  assert.deepEqual(manifest.scripts["post-install-cmd"], [postInstallCommand]);
  state.files = [snapshotFile("composer.json", composerJson)];
});

When("the static source analyzer runs on that snapshot", async function (this: SageWorld) {
  const state = stateFor(this);
  const files = state.files;
  state.scanReport = scanSnapshotSources(files);
  state.sourceResult = await analyzeSnapshotSources({ snapshot: testSnapshot, files });
});

Then("the CCM contains JavaScript and PHP declarations validated against the source bytes", function (this: SageWorld) {
  const result = stateFor(this).sourceResult;
  assert.ok(result?.ccm, "the adapter must produce a CCM");
  assert.equal(result.status, "complete");
  assert.ok(result.ccm.nodes.some((node) => node.language === "javascript" && node.name === "App"));
  assert.ok(result.ccm.nodes.some((node) => node.language === "php" && node.name === "Contract"));
  assert.ok(result.ccm.edges.every((edge) => edge.kind === "CONTAINS"));
  const sources = Object.fromEntries(stateFor(this).files.map((file) => [file.relativePath, file.bytes]));
  assert.equal(validateCcm(result.ccm, sources).ok, true);
  const canonical = canonicalizeCcm(result.ccm, sources);
  assert.equal(canonical.ok, true);
  if (canonical.ok) {
    assert.equal(canonical.json, result.canonicalJson);
    assert.equal(canonical.sha256, result.contentSha256);
  }
});

Then("generated files, metadata, and excluded dependencies remain recorded with policy reasons", function (this: SageWorld) {
  const state = stateFor(this);
  const result = state.sourceResult;
  const report = state.scanReport;
  assert.ok(result?.ccm);
  assert.ok(report);
  assert.equal(report.counts.eligible, 1);
  assert.equal(report.counts.excluded, 6);
  assert.equal(report.files.find((file) => file.path === "vendor/old.php")?.reason, "EXCLUDED_DIRECTORY");
  assert.equal(report.files.find((file) => file.path === "src/app.min.js")?.reason, "MINIFIED_SOURCE");
  assert.equal(report.files.find((file) => file.path === "src/app.js.map")?.reason, "SOURCE_MAP");
  assert.equal(report.files.find((file) => file.path === "dist/generated.ts")?.reason, "EXCLUDED_DIRECTORY");
  assert.equal(report.files.find((file) => file.path === "package.json")?.reason, "UNSUPPORTED_EXTENSION");
  assert.equal(report.files.find((file) => file.path === ".gitmodules")?.reason, "SUBMODULE_METADATA");
  assert.equal(result.report.counts.processed, 1);
  assert.equal(result.ccm.files.find((file) => file.path === "vendor/old.php")?.status, "excluded");
  assert.ok(!result.ccm.nodes.some((node) => ["Legacy", "Generated", "AppMap"].includes(node.name)));
});

Then("the supported source remains analyzed when an unsupported-language source is present, and the result is partial when a sibling has a syntax error", function (this: SageWorld) {
  const state = stateFor(this);
  const result = state.sourceResult;
  assert.ok(result?.ccm);
  assert.equal(result.status, "partial");
  assert.equal(result.errorCode, null);
  assert.equal(result.report.counts.processed, 1);
  assert.equal(result.report.counts.failed, 1);
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.path === "src/bad.ts"));
  assert.ok(result.ccm.nodes.some((node) => node.name === "good"));
  assert.equal(result.ccm.files.find((file) => file.path === "src/bad.ts")?.status, "failed");
  assert.equal(state.scanReport?.files.find((file) => file.path === "src/unsupported.rb")?.reason, "UNSUPPORTED_EXTENSION");
  assert.equal(result.ccm.files.find((file) => file.path === "src/unsupported.rb")?.status, "excluded");
});

Then("no supported source is found and the Composer canary is never created", async function (this: SageWorld) {
  const state = stateFor(this);
  assert.equal(state.sourceResult?.errorCode, "NO_SUPPORTED_SOURCE");
  assert.equal(state.sourceResult?.ccm, null);
  const composerFile = state.files.find((file) => file.relativePath === "composer.json");
  assert.ok(composerFile);
  const manifest = JSON.parse(new TextDecoder().decode(composerFile.bytes)) as { scripts?: { "post-install-cmd"?: unknown } };
  assert.ok(manifest.scripts?.["post-install-cmd"], "the fixture must be a valid Composer manifest with a real install hook");
  const canaryPath = state.canaryPath;
  assert.ok(canaryPath);
  try {
    await assert.rejects(access(canaryPath), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");
  } finally {
    await rm(canaryPath, { force: true });
  }
});

Given("a disposable PostgreSQL database, two owners, and one test repository are available", async function (this: SageWorld) {
  await prepareDatabaseFixture(this);
});

When("the first owner enqueues commit {string}", async function (this: SageWorld, commitSha: string) {
  const { db, state, owners, repositoryId } = requirePreparedDatabase(this);
  await enqueueFor(state, db, { ownerUserId: owners[0], repositoryId, commitSha });
});

When("the second owner enqueues commit {string}", async function (this: SageWorld, commitSha: string) {
  const { db, state, owners, repositoryId } = requirePreparedDatabase(this);
  await enqueueFor(state, db, { ownerUserId: owners[1], repositoryId, commitSha });
});

Then("only one global claim is active; FIFO gives the first owner priority, and another owner cannot read the first owner's analysis", async function (this: SageWorld) {
  const { db, state, owners } = requirePreparedDatabase(this);
  const first = state.enqueued[0];
  const second = state.enqueued[1];
  assert.ok(first && second);
  const claim = await claimAnalysisJob(db);
  assert.ok(claim);
  state.claims.push(claim);
  assert.equal(claim.analysisId, first.analysisId);
  assert.equal(await claimAnalysisJob(db), null, "the fixed global slot must reject a second active claim");
  const rows = await db.analysis.findMany({
    where: { id: { in: [first.analysisId, second.analysisId] } },
    select: { id: true, ownerUserId: true, status: true, commitSha: true },
  });
  assert.deepEqual(rows.map(({ id, ownerUserId, status }) => ({ id, ownerUserId, status })).sort((a, b) => a.id.localeCompare(b.id)), [
    { id: first.analysisId, ownerUserId: owners[0], status: "RUNNING" },
    { id: second.analysisId, ownerUserId: owners[1], status: "QUEUED" },
  ].sort((a, b) => a.id.localeCompare(b.id)));
  assert.equal(rows.find(({ id }) => id === first.analysisId)?.commitSha, "a".repeat(40));
  assert.equal(rows.find(({ id }) => id === second.analysisId)?.commitSha, "b".repeat(40));
  assert.equal(await getOwnerAnalysisProgress(db, owners[1], first.analysisId), null);
  assert.equal((await getOwnerAnalysisProgress(db, owners[1], second.analysisId))?.status, "QUEUED");
});

When("the first owner enqueues key {string} with payload {string} and commit {string}", async function (this: SageWorld, key: string, payload: string, commitSha: string) {
  const { db, state, owners, repositoryId } = requirePreparedDatabase(this);
  await enqueueFor(state, db, {
    ownerUserId: owners[0], repositoryId, commitSha,
    idempotency: { keyHash: hash(key), requestHash: hash(payload) },
  });
});

When("the second owner submits key {string} with payload {string} and commit {string}", async function (this: SageWorld, key: string, payload: string, commitSha: string) {
  const { db, state, owners, repositoryId } = requirePreparedDatabase(this);
  await enqueueFor(state, db, {
    ownerUserId: owners[1], repositoryId, commitSha,
    idempotency: { keyHash: hash(key), requestHash: hash(payload) },
  });
});

Then("the first owner's replay retains the original full SHA, while the same key creates a separate analysis for the second owner", async function (this: SageWorld) {
  const { db, state, owners } = requirePreparedDatabase(this);
  const first = state.enqueued[0];
  const replay = state.enqueued[1];
  const otherOwnerRequest = state.enqueued[2];
  assert.ok(first && replay && otherOwnerRequest);
  assert.equal(replay.analysisId, first.analysisId);
  assert.equal(replay.jobId, first.jobId);
  assert.equal(replay.replayed, true);
  assert.equal(replay.commitSha, "c".repeat(40));
  assert.notEqual(otherOwnerRequest.analysisId, first.analysisId);
  assert.equal(otherOwnerRequest.replayed, undefined);
  assert.equal(otherOwnerRequest.commitSha, "e".repeat(40));
  assert.equal(await getOwnerAnalysisProgress(db, owners[1], first.analysisId), null);
  assert.equal(await db.analysis.count({ where: { ownerUserId: owners[0] } }), 1);
  assert.equal(await db.analysis.count({ where: { ownerUserId: owners[1] } }), 1);
});

When("two owners enqueue jobs, the first claim expires, and a new worker claims the next job", async function (this: SageWorld) {
  const { db, state, owners, repositoryId } = requirePreparedDatabase(this);
  await enqueueFor(state, db, { ownerUserId: owners[0], repositoryId, commitSha: "d".repeat(40) });
  await enqueueFor(state, db, { ownerUserId: owners[1], repositoryId, commitSha: "e".repeat(40) });
  const staleClaim = await claimAnalysisJob(db, { leaseDurationMs: 1_000 });
  assert.ok(staleClaim);
  state.claims.push(staleClaim);
  assert.equal(staleClaim.analysisId, state.enqueued[0]?.analysisId);
  await expireLease(db, staleClaim);
  const nextClaim = await claimAnalysisJob(db, { leaseDurationMs: 60_000 });
  assert.ok(nextClaim);
  state.claims.push(nextClaim);
  assert.equal(nextClaim.analysisId, state.enqueued[1]?.analysisId);
});

Then("the old lease token cannot renew or fail the new running job", async function (this: SageWorld) {
  const { db, state } = requirePreparedDatabase(this);
  const oldClaim = state.claims.at(-2);
  const currentClaim = state.claims.at(-1);
  assert.ok(oldClaim && currentClaim);
  assert.equal(await renewAnalysisLease(db, oldClaim), null);
  assert.equal(await failAnalysisJob(db, oldClaim, "STALE_WORKER"), false);
  const current = await db.workerSlot.findUniqueOrThrow({ where: { slotKey: "analysis" }, select: { jobId: true, ownerUserId: true } });
  assert.deepEqual(current, { jobId: currentClaim.jobId, ownerUserId: currentClaim.ownerUserId });
  const interrupted = await db.analysis.findUniqueOrThrow({ where: { id: oldClaim.analysisId }, select: { status: true, errorCode: true } });
  assert.deepEqual(interrupted, { status: "FAILED", errorCode: "WORKER_INTERRUPTED" });
});

When("the runner executes nine test handlers in sequence for the first owner's analysis", async function (this: SageWorld) {
  const { db, state, owners, repositoryId } = requirePreparedDatabase(this);
  const enqueued = await enqueueFor(state, db, { ownerUserId: owners[0], repositoryId, commitSha: "f".repeat(40) });
  const claim = await claimAnalysisJob(db);
  assert.ok(claim);
  state.claims.push(claim);
  assert.equal(claim.analysisId, enqueued.analysisId);

  let active = 0;
  const handlers = controlledHandlers(async (key) => {
    active += 1;
    state.maxConcurrentHandlers = Math.max(state.maxConcurrentHandlers, active);
    try {
      state.calledStages.push(key);
      await new Promise((resolve) => setTimeout(resolve, 2));
      if (key === "SNAPSHOT") return { files: { "src/main.ts": new Uint8Array([1, 2, 3]) } };
      return { stage: key, controlledTestStub: true };
    } finally {
      active -= 1;
    }
  });
  state.runnerResult = await runAnalysisStages(db, claim, handlers);
});

When("the STATIC_ANALYSIS handler throws an internal error while the runner executes the claim", async function (this: SageWorld) {
  const { db, state, owners, repositoryId } = requirePreparedDatabase(this);
  const enqueued = await enqueueFor(state, db, { ownerUserId: owners[0], repositoryId, commitSha: "9".repeat(40) });
  const claim = await claimAnalysisJob(db);
  assert.ok(claim);
  state.claims.push(claim);
  assert.equal(claim.analysisId, enqueued.analysisId);
  state.runnerResult = await runAnalysisStages(db, claim, controlledHandlers((key) => {
    state.calledStages.push(key);
    if (key === "STATIC_ANALYSIS") throw new Error("private source detail must not be persisted");
    return { stage: key, controlledTestStub: true };
  }));
});

Then("the runner fails at that stage, stores a safe error code, and leaves downstream stages pending", async function (this: SageWorld) {
  const { db, state, owners } = requirePreparedDatabase(this);
  const result = state.runnerResult;
  const claim = state.claims.at(-1);
  assert.ok(result && claim);
  const expectedKeys = ANALYSIS_STAGE_DEFINITIONS.map(({ key }) => key);
  assert.equal(result.stagesFinished, false);
  assert.deepEqual(state.calledStages, ["SNAPSHOT", "LANGUAGE_DETECTION", "STATIC_ANALYSIS"]);
  assert.deepEqual(result.stages.map(({ key, status, errorCode }) => [key, status, errorCode]), [
    [expectedKeys[0], "COMPLETED", null],
    [expectedKeys[1], "COMPLETED", null],
    [expectedKeys[2], "FAILED", "STAGE_HANDLER_FAILED"],
    ...expectedKeys.slice(3).map((key) => [key, "PENDING", null]),
  ]);
  assert.equal(JSON.stringify(result).includes("private source detail"), false);
  assert.equal(JSON.stringify(await getOwnerAnalysisProgress(db, owners[0], claim.analysisId)).includes("private source detail"), false);
  assert.equal(await getOwnerAnalysisProgress(db, owners[1], claim.analysisId), null);
  const analysis = await db.analysis.findUniqueOrThrow({ where: { id: claim.analysisId }, select: { status: true, errorCode: true } });
  assert.deepEqual(analysis, { status: "FAILED", errorCode: "STAGE_HANDLER_FAILED" });
});

Then("all nine stage statuses are completed in contract order, with no terminal product result published", async function (this: SageWorld) {
  const { db, state, owners } = requirePreparedDatabase(this);
  const result = state.runnerResult;
  const claim = state.claims.at(-1);
  assert.ok(result && claim);
  const expectedKeys = ANALYSIS_STAGE_DEFINITIONS.map(({ key }) => key);
  assert.equal(result.stagesFinished, true);
  assert.deepEqual(state.calledStages, expectedKeys);
  assert.equal(state.maxConcurrentHandlers, 1);
  assert.deepEqual(result.stages.map(({ key, status }) => [key, status]), expectedKeys.map((key) => [key, "COMPLETED"]));
  const progress = await getOwnerAnalysisProgress(db, owners[0], claim.analysisId);
  assert.deepEqual(progress?.stages.map(({ key }) => key), expectedKeys);
  assert.equal(progress?.status, "RUNNING");
  const current = await db.analysis.findUniqueOrThrow({
    where: { id: claim.analysisId },
    select: { status: true, graphBundle: { select: { id: true } }, architectureDocument: { select: { id: true } } },
  });
  assert.deepEqual(current, { status: "RUNNING", graphBundle: null, architectureDocument: null });
});

When("the first owner's claim lease expires before the runner starts a stage", async function (this: SageWorld) {
  const { db, state, owners, repositoryId } = requirePreparedDatabase(this);
  await enqueueFor(state, db, { ownerUserId: owners[0], repositoryId, commitSha: "1".repeat(40) });
  await enqueueFor(state, db, { ownerUserId: owners[1], repositoryId, commitSha: "2".repeat(40) });
  const staleClaim = await claimAnalysisJob(db, { leaseDurationMs: 1_000 });
  assert.ok(staleClaim);
  state.claims.push(staleClaim);
  await expireLease(db, staleClaim);
  let handlerCalls = 0;
  state.runnerResult = await runAnalysisStages(db, staleClaim, controlledHandlers(() => {
    handlerCalls += 1;
    return { shouldNotRun: true };
  }));
  assert.equal(handlerCalls, 0);
  state.calledStages.push(`expired-runner-handler-calls:${handlerCalls}`);
});

Then("the stale runner invokes no handler, recovery moves the claim, and the old token cannot affect the slot", async function (this: SageWorld) {
  const { db, state } = requirePreparedDatabase(this);
  const oldClaim = state.claims.at(-1);
  assert.ok(oldClaim);
  assert.deepEqual(state.runnerResult?.stages, []);
  assert.deepEqual(state.calledStages, ["expired-runner-handler-calls:0"]);
  assert.equal(await renewAnalysisLease(db, oldClaim), null);
  assert.equal(await failAnalysisJob(db, oldClaim, "STALE_WORKER"), false);
  const nextClaim = await claimAnalysisJob(db, { leaseDurationMs: 60_000 });
  assert.ok(nextClaim);
  state.claims.push(nextClaim);
  assert.equal(nextClaim.analysisId, state.enqueued[1]?.analysisId);
  const oldAnalysis = await db.analysis.findUniqueOrThrow({ where: { id: oldClaim.analysisId }, select: { status: true, errorCode: true } });
  assert.deepEqual(oldAnalysis, { status: "FAILED", errorCode: "WORKER_INTERRUPTED" });
  const slot = await db.workerSlot.findUniqueOrThrow({ where: { slotKey: "analysis" }, select: { jobId: true, ownerUserId: true } });
  assert.deepEqual(slot, { jobId: nextClaim.jobId, ownerUserId: nextClaim.ownerUserId });
});

After({ tags: "@database" }, async function (this: SageWorld) {
  const state = stateByWorld.get(this);
  if (!state?.db) return;
  const db = state.db;

  try {
    for (const claim of state.claims) await failAnalysisJob(db, claim, "BDD_SCENARIO_CLEANUP").catch(() => false);
    await db.$transaction(async (tx) => {
      if (state.jobIds.length > 0) {
        await tx.workerSlot.updateMany({
          where: { jobId: { in: state.jobIds } },
          data: { jobId: null, ownerUserId: null, leaseUntil: null, heartbeatAt: null, leaseTokenHash: null },
        });
        await tx.job.deleteMany({ where: { id: { in: state.jobIds }, ownerUserId: { in: state.userIds } } });
      }
      if (state.analysisIds.length > 0) {
        await tx.analysis.deleteMany({ where: { id: { in: state.analysisIds }, ownerUserId: { in: state.userIds } } });
      }
      if (state.userIds.length > 0) await tx.user.deleteMany({ where: { id: { in: state.userIds } } });
      if (state.repositoryIds.length > 0) await tx.repository.deleteMany({ where: { id: { in: state.repositoryIds } } });
    });
  } finally {
    await disconnectDatabase();
    stateByWorld.delete(this);
  }
});
