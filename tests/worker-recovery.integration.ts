import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import test from "node:test";
import {
  database, disconnectDatabase, enqueueAnalysis, enqueueAnalysisRetry,
  getAnalysisRetryTargetForUser, storeGitHubCredential,
  ANALYSIS_RUNTIME_LEASE_DURATION_MS,
} from "../packages/database/src/index.ts";

const enabled = process.env.SAGE_PIPELINE_TESTS === "1" && process.env.SAGE_PIPELINE_RECOVERY_TESTS === "1";
const repositoryId = "160016";
const repositoryFullName = "sage-pipeline16-fixture/private-sample";
const commitSha = "16".repeat(20);
const configuration = { limitsVersion: 1, maxSourceFileBytes: 1_048_576, sourcePolicyVersion: "sage-source-policy-v1", version: 1 };
const digest = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

type Worker = { child: ChildProcess; closed: boolean; output: string; done: Promise<void> };
function startWorker(storageRoot: string): Worker {
  const root = process.cwd();
  const child = spawn(process.execPath, ["--import", "tsx", "--import", resolve(root, "scripts/helpers/pipeline-provider-fixture.mjs"), resolve(root, "apps/worker/src/index.ts")], {
    cwd: root, env: { ...process.env, SAGE_PIPELINE_TESTS: "1", STORAGE_ROOT: storageRoot }, stdio: ["ignore", "pipe", "pipe"],
  });
  const worker: Worker = { child, closed: false, output: "", done: Promise.resolve() };
  worker.done = new Promise(resolveDone => child.once("close", () => { worker.closed = true; resolveDone(); }));
  for (const stream of [child.stdout, child.stderr]) stream?.setEncoding("utf8").on("data", chunk => { worker.output = `${worker.output}${String(chunk)}`.slice(-4_000); });
  return worker;
}

async function stopWorker(worker: Worker | undefined, signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
  if (!worker || worker.closed) return;
  worker.child.kill(signal);
  if (await Promise.race([worker.done.then(() => true), sleep(6_000).then(() => false)])) return;
  worker.child.kill("SIGKILL");
  await Promise.race([worker.done, sleep(6_000)]);
}

async function poll<T>(read: () => Promise<T | null>, timeoutMs: number, worker?: Worker): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (worker?.closed) throw new Error(`Owned worker exited before the expected state: ${worker.output}`);
    const value = await read();
    if (value !== null) return value;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for worker state${worker ? `: ${worker.output}` : ""}.`);
}

test("T-ANA06 actual worker recovers a killed claim and publishes the same target on retry", { skip: !enabled, timeout: ANALYSIS_RUNTIME_LEASE_DURATION_MS + 90_000 }, async () => {
  const url = new URL(process.env.DATABASE_URL ?? "");
  assert.ok(url.protocol === "postgresql:" || url.protocol === "postgres:");
  assert.equal(decodeURIComponent(url.pathname.slice(1)), "sage_pipeline16", "recovery test only uses its isolated database");
  const db = database();
  const priorKey = process.env.CREDENTIAL_ENCRYPTION_KEY;
  process.env.CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  const suffix = randomUUID().replaceAll("-", "");
  const storageRoot = join(tmpdir(), `sage-pipeline16-recovery-${suffix}`);
  let ownerUserId = "";
  let repoCreated = false;
  let repoId = "";
  let first: Worker | undefined;
  let restarted: Worker | undefined;
  try {
    assert.equal(await db.job.count({ where: { type: "ANALYSIS", status: { in: ["QUEUED", "RUNNING"] } } }), 0, "stop other consumers and drain jobs before recovery test");
    assert.equal((await db.workerSlot.findUniqueOrThrow({ where: { slotKey: "analysis" }, select: { jobId: true } })).jobId, null);
    await mkdir(storageRoot, { mode: 0o700 });
    let repo = await db.repository.findUnique({ where: { githubRepositoryId: repositoryId }, select: { id: true, fullName: true } });
    if (!repo) {
      repo = await db.repository.create({ data: { githubRepositoryId: repositoryId, ownerLogin: "sage-pipeline16-fixture", name: "private-sample", fullName: repositoryFullName, visibility: "PRIVATE", defaultBranch: "main" }, select: { id: true, fullName: true } });
      repoCreated = true;
    }
    assert.equal(repo.fullName, repositoryFullName);
    repoId = repo.id;
    const owner = await db.user.create({ data: { githubUserId: `worker-recovery-${suffix}`, login: `worker-recovery-${suffix.slice(0, 12)}` }, select: { id: true } });
    ownerUserId = owner.id;
    await storeGitHubCredential(db, owner.id, { githubUserId: `worker-gh-${suffix}`, githubLogin: "sage-pipeline16-fixture", accessToken: "sage-pipeline16-provider-allowed" });
    const parent = await enqueueAnalysis(db, { ownerUserId, repositoryId: repo.id, branchName: "main", commitSha, configuration, analyzerVersion: "declarations-v1", schemaVersion: "1" });
    first = startWorker(storageRoot);
    await poll(async () => {
      const row = await db.analysis.findUnique({ where: { id: parent.analysisId }, select: { status: true, stages: { where: { sequence: 1 }, select: { status: true } } } });
      return row?.status === "RUNNING" && row.stages[0]?.status === "RUNNING" ? row : null;
    }, 10_000, first);
    await sleep(250); // The guarded provider fixture holds the actual codeload response for four seconds.
    assert.equal(first.closed, false);
    const snapshotStillRunning = await db.analysis.findUniqueOrThrow({ where: { id: parent.analysisId }, select: { status: true, stages: { where: { sequence: 1 }, select: { status: true } } } });
    assert.equal(snapshotStillRunning.status, "RUNNING");
    assert.equal(snapshotStillRunning.stages[0]?.status, "RUNNING");
    assert.equal(first.child.kill("SIGKILL"), true);
    await first.done;
    assert.equal(first.child.signalCode, "SIGKILL");

    await poll(async () => {
      const rows = await db.$queryRaw<Array<{ expired: boolean }>>`SELECT slot."leaseUntil" <= clock_timestamp() AND job."leaseExpiresAt" <= clock_timestamp() AS expired FROM "WorkerSlot" slot JOIN "Job" job ON job."id" = slot."jobId" WHERE slot."jobId" = ${parent.jobId}`;
      return rows[0]?.expired ? true : null;
    }, ANALYSIS_RUNTIME_LEASE_DURATION_MS + 5_000);

    restarted = startWorker(storageRoot);
    const recovered = await poll(async () => {
      const row = await db.analysis.findUnique({
        where: { id: parent.analysisId },
        select: {
          status: true, errorCode: true, resultHash: true,
          stages: { orderBy: { sequence: "asc" }, select: { status: true, errorCode: true } },
        },
      });
      return row?.status === "FAILED" ? row : null;
    }, 10_000, restarted);
    assert.deepEqual({ status: recovered.status, errorCode: recovered.errorCode, resultHash: recovered.resultHash }, { status: "FAILED", errorCode: "WORKER_INTERRUPTED", resultHash: null });
    assert.deepEqual(recovered.stages.map(stage => stage.status), ["FAILED", ...Array(8).fill("PENDING")]);
    assert.equal(recovered.stages[0]?.errorCode, "WORKER_INTERRUPTED");
    const failedJob = await db.job.findUniqueOrThrow({ where: { id: parent.jobId }, select: { status: true, errorCode: true } });
    assert.deepEqual(failedJob, { status: "FAILED", errorCode: "WORKER_INTERRUPTED" });
    assert.equal(await db.graphBundle.count({ where: { analysisId: parent.analysisId } }), 0);
    assert.equal(await db.architectureDocument.count({ where: { analysisId: parent.analysisId } }), 0);
    assert.equal(await db.storageObject.count({ where: { analysisId: parent.analysisId } }), 0);
    assert.equal(await db.sourceFile.count({ where: { analysisId: parent.analysisId } }), 0);
    assert.equal(await db.analysisLimitation.count({ where: { analysisId: parent.analysisId } }), 0);

    const retryTarget = await getAnalysisRetryTargetForUser(db, ownerUserId, parent.analysisId);
    assert.ok(retryTarget);
    const retryRequestHash = digest(JSON.stringify({ retryParentId: retryTarget.analysisId, repositoryId: retryTarget.repositoryId, repositoryGitHubId: retryTarget.repositoryGitHubId, branchName: retryTarget.branchName, commitSha: retryTarget.commitSha, configurationHash: retryTarget.configurationHash, analyzerVersion: retryTarget.analyzerVersion, schemaVersion: retryTarget.schemaVersion }));
    const retry = await enqueueAnalysisRetry(db, retryTarget, { keyHash: digest(`worker-recovery-${suffix}`), requestHash: retryRequestHash });
    const completed = await poll(async () => {
      const row = await db.analysis.findUnique({ where: { id: retry.analysisId }, select: { status: true } });
      return row && ["COMPLETED", "COMPLETED_WITH_LIMITATIONS", "FAILED"].includes(row.status) ? row : null;
    }, 50_000, restarted);
    assert.equal(completed.status, "COMPLETED_WITH_LIMITATIONS");
    const result = await db.analysis.findUniqueOrThrow({
      where: { id: retry.analysisId },
      select: {
        retryParentId: true, commitSha: true, configuration: true, configurationHash: true, resultHash: true,
        stages: { orderBy: { sequence: "asc" }, select: { status: true } },
        jobs: { where: { type: "ANALYSIS" }, select: { status: true } },
        graphBundle: { select: { canonicalContent: true, contentHash: true, nodeCount: true } },
        architectureDocument: { select: { canonicalContent: true, contentHash: true } },
      },
    });
    assert.equal(result.retryParentId, parent.analysisId);
    assert.equal(result.commitSha, commitSha);
    assert.deepEqual(result.configuration, configuration);
    assert.equal(result.configurationHash, parent.configurationHash);
    assert.match(result.resultHash ?? "", /^[a-f0-9]{64}$/);
    assert.deepEqual(result.stages.map(stage => stage.status), Array(9).fill("COMPLETED"));
    assert.equal(result.jobs[0]?.status, "COMPLETED");
    assert.ok(result.graphBundle?.canonicalContent && result.graphBundle.contentHash && result.graphBundle.nodeCount > 0);
    assert.ok(result.architectureDocument?.canonicalContent && result.architectureDocument.contentHash);
  } finally {
    await stopWorker(first, "SIGTERM");
    await stopWorker(restarted, "SIGTERM");
    if (ownerUserId) {
      const analyses = await db.analysis.findMany({ where: { ownerUserId }, select: { id: true, retryParentId: true } });
      const ids = analyses.map(row => row.id);
      await db.$transaction(async tx => {
        const jobs = ids.length ? await tx.job.findMany({ where: { analysisId: { in: ids }, ownerUserId }, select: { id: true } }) : [];
        if (jobs.length) await tx.workerSlot.updateMany({
          where: { jobId: { in: jobs.map(row => row.id) }, ownerUserId },
          data: { jobId: null, ownerUserId: null, leaseUntil: null, heartbeatAt: null, leaseTokenHash: null },
        });
        await tx.job.deleteMany({ where: { ownerUserId } });
        const retryIds = analyses.filter(row => row.retryParentId).map(row => row.id);
        const parentIds = analyses.filter(row => !row.retryParentId).map(row => row.id);
        await tx.analysis.deleteMany({ where: { id: { in: retryIds }, ownerUserId } });
        await tx.analysis.deleteMany({ where: { id: { in: parentIds }, ownerUserId } });
        await tx.gitHubConnection.deleteMany({ where: { userId: ownerUserId } });
        await tx.user.deleteMany({ where: { id: ownerUserId } });
      });
    }
    if (repoCreated && repoId && await db.analysis.count({ where: { repositoryId: repoId } }) === 0) await db.repository.deleteMany({ where: { id: repoId } });
    await rm(storageRoot, { recursive: true, force: true });
    await disconnectDatabase();
    if (priorKey === undefined) delete process.env.CREDENTIAL_ENCRYPTION_KEY;
    else process.env.CREDENTIAL_ENCRYPTION_KEY = priorKey;
  }
});
