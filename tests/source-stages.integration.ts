import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { pack, type Header } from "tar-stream";
import test from "node:test";
import { ANALYSIS_STAGE_DEFINITIONS, type AnalysisStageKey } from "../packages/contracts/src/stages.ts";
import {
  claimAnalysisJob,
  database,
  disconnectDatabase,
  enqueueAnalysis,
  failAnalysisJob,
} from "../packages/database/src/index.ts";
import type { AnalysisJobClaim } from "../packages/database/src/queue.ts";
import type { AnalysisStageContext, AnalysisStageHandler, AnalysisStageHandlers } from "../apps/worker/src/stage-runner.ts";
import { AnalysisStageExecutionError, runAnalysisStages } from "../apps/worker/src/stage-runner.ts";
import { createSourceStageHandlers } from "../apps/worker/src/source-handlers.ts";
import { DEFAULT_MAX_SOURCE_FILE_BYTES, SOURCE_POLICY_VERSION } from "../apps/worker/src/source-analysis.ts";
import { writeSnapshotArchive, readSnapshotArchive } from "../apps/worker/src/snapshot/storage.ts";
import type { PrismaClient } from "../packages/database/generated/client.ts";

function assertIsolatedSourceDatabase(): void {
  if (process.env.SAGE_SOURCE_TESTS !== "1") throw new Error("Set SAGE_SOURCE_TESTS=1 to run destructive issue 10 source-stage integration fixtures.");
  const rawUrl = process.env.DATABASE_URL;
  if (!rawUrl) throw new Error("DATABASE_URL is required for issue 10 source-stage integration tests.");
  let databaseName: string;
  try {
    databaseName = decodeURIComponent(new URL(rawUrl).pathname.slice(1));
  } catch {
    throw new Error("DATABASE_URL is invalid; it was not logged.");
  }
  if (databaseName !== "sage_source10") throw new Error("Issue 10 source-stage tests only allow the isolated sage_source10 database.");
}

async function makeArchive(rootName: string, files: readonly { path: string; bytes: Uint8Array }[]): Promise<Buffer> {
  const tar = pack();
  const entries: Array<{ name: string; type: "directory" | "file"; bytes?: Uint8Array }> = [
    { name: `${rootName}/`, type: "directory" },
    ...files.map(({ path, bytes }) => ({ name: `${rootName}/${path}`, type: "file" as const, bytes })),
  ];
  for (const entry of entries) {
    const bytes = entry.bytes ?? Buffer.alloc(0);
    const header: Partial<Header> & Pick<Header, "name"> = {
      name: entry.name,
      type: entry.type,
      size: bytes.byteLength,
      mode: 0o644,
      mtime: new Date(0),
      linkname: "",
      uid: 0,
      gid: 0,
      uname: "",
      gname: "",
      devmajor: 0,
      devminor: 0,
    };
    await new Promise<void>((resolve, reject) => {
      tar.entry(header, bytes, (error) => (error ? reject(error) : resolve()));
    });
  }
  tar.finalize();
  const chunks: Buffer[] = [];
  for await (const chunk of tar) chunks.push(Buffer.from(chunk as Uint8Array));
  return gzipSync(Buffer.concat(chunks));
}

async function cleanup(
  db: PrismaClient,
  userIds: string[],
  repositoryId: string,
  jobIds: string[],
  claims: AnalysisJobClaim[],
): Promise<void> {
  for (const claim of claims) await failAnalysisJob(db, claim, "SOURCE_TEST_CLEANUP").catch(() => false);
  await db.$transaction(async (tx) => {
    if (jobIds.length > 0) {
      await tx.workerSlot.updateMany({
        where: { jobId: { in: jobIds } },
        data: { jobId: null, ownerUserId: null, leaseUntil: null, heartbeatAt: null, leaseTokenHash: null },
      });
      await tx.job.deleteMany({ where: { id: { in: jobIds }, ownerUserId: { in: userIds } } });
    }
    await tx.storageObject.deleteMany({ where: { ownerUserId: { in: userIds } } });
    await tx.analysisStage.deleteMany({ where: { ownerUserId: { in: userIds } } });
    await tx.analysis.deleteMany({ where: { ownerUserId: { in: userIds } } });
    await tx.user.deleteMany({ where: { id: { in: userIds } } });
    if (repositoryId) await tx.repository.deleteMany({ where: { id: repositoryId } });
  });
}

function makeHandlers(input: {
  claim: AnalysisJobClaim;
  storageRoot: string;
  db: PrismaClient;
  archive: Uint8Array;
  onCommonCodeModel?: (context: AnalysisStageContext) => Promise<void> | void;
}): AnalysisStageHandlers {
  const handlers: Partial<Record<AnalysisStageKey, AnalysisStageHandler>> = {
    SNAPSHOT: async (context, signal) => {
      signal.throwIfAborted();
      const stored = await writeSnapshotArchive(input.db, {
        storageRoot: input.storageRoot,
        claim: input.claim,
        signal,
        archive: input.archive,
        sha256: createHash("sha256").update(input.archive).digest("hex"),
      });
      return { ...stored, commitSha: context.target.commitSha };
    },
    ...createSourceStageHandlers({ claim: input.claim, storageRoot: input.storageRoot, db: input.db }),
  };

  for (const { key } of ANALYSIS_STAGE_DEFINITIONS) {
    if (handlers[key]) continue;
    handlers[key] = async (context, signal) => {
      signal.throwIfAborted();
      if (key === "COMMON_CODE_MODEL") await input.onCommonCodeModel?.(context);
      return { stage: key, accepted: true };
    };
  }
  return handlers as AnalysisStageHandlers;
}

test("issue 10 runs real owner-bound source handlers from stored snapshots and persists safe failures", {
  skip: process.env.SAGE_SOURCE_TESTS !== "1",
}, async () => {
  assertIsolatedSourceDatabase();
  const db = database();
  const suffix = randomUUID();
  const userIds: string[] = [];
  const jobIds: string[] = [];
  const claims: AnalysisJobClaim[] = [];
  let repositoryId = "";
  let storageRoot = "";

  try {
    const owner = await db.user.create({ data: { githubUserId: `source-owner-${suffix}`, login: `source-owner-${suffix}` } });
    userIds.push(owner.id);
    const otherOwner = await db.user.create({ data: { githubUserId: `source-other-${suffix}`, login: `source-other-${suffix}` } });
    userIds.push(otherOwner.id);
    const repository = await db.repository.create({
      data: {
        githubRepositoryId: `source-repo-${suffix}`,
        ownerLogin: "sage-source-test",
        name: suffix,
        fullName: `sage-source-test/${suffix}`,
        visibility: "PUBLIC",
      },
    });
    repositoryId = repository.id;
    storageRoot = await mkdtemp(join(tmpdir(), "sage-source-stages-"));

    const run = async (input: {
      label: string;
      commitSha: string;
      files: readonly { path: string; content: string }[];
      configuration?: Record<string, unknown>;
      onCommonCodeModel?: (context: AnalysisStageContext) => Promise<void> | void;
    }) => {
      const enqueued = await enqueueAnalysis(db, {
        ownerUserId: owner.id,
        repositoryId: repository.id,
        branchName: "main",
        commitSha: input.commitSha,
        configuration: input.configuration ?? { includeTests: false },
        analyzerVersion: "issue10-source-test-1",
        schemaVersion: "1",
      });
      jobIds.push(enqueued.jobId);
      const claim = await claimAnalysisJob(db, { leaseDurationMs: 300_000 });
      assert.ok(claim);
      claims.push(claim);
      assert.equal(claim.analysisId, enqueued.analysisId);

      const rootName = `${input.label}-${suffix.replaceAll("-", "").slice(0, 12)}`;
      const archive = await makeArchive(rootName, input.files.map(({ path, content }) => ({ path, bytes: Buffer.from(content, "utf8") })));
      const result = await runAnalysisStages(
        db,
        claim,
        makeHandlers({ claim, storageRoot, db, archive, onCommonCodeModel: input.onCommonCodeModel }),
        { leaseDurationMs: 300_000 },
      );
      return { enqueued, claim, result };
    };

    const mixedArtifacts: Array<{
      languageDetection: Record<string, unknown>;
      staticAnalysis: Record<string, unknown>;
      context: AnalysisStageContext;
    }> = [];
    const mixed = await run({
      label: "mixed",
      commitSha: "a".repeat(40),
      configuration: {
        includeTests: false,
        sourcePolicyVersion: SOURCE_POLICY_VERSION,
        maxSourceFileBytes: DEFAULT_MAX_SOURCE_FILE_BYTES,
      },
      files: [
        { path: "src/App.js", content: "export class App {}\n" },
        { path: "src/Service.php", content: "<?php\nclass Service { public function run(): void {} }\n" },
      ],
      onCommonCodeModel: async (context) => {
        const snapshot = context.sourceSnapshot as { storageObjectId: string };
        const stored = await db.storageObject.findUniqueOrThrow({ where: { id: snapshot.storageObjectId } });
        assert.equal(stored.ownerUserId, owner.id);
        assert.equal(stored.analysisId, context.target.analysisId);
        assert.equal(stored.type, "SOURCE_ARCHIVE");
        await assert.rejects(readSnapshotArchive(db, {
          storageRoot,
          ownerUserId: otherOwner.id,
          analysisId: context.target.analysisId,
          storageObjectId: snapshot.storageObjectId,
        }));

        const languageDetection = context.previousStages.LANGUAGE_DETECTION as unknown as Record<string, unknown>;
        const staticAnalysis = context.previousStages.STATIC_ANALYSIS as unknown as Record<string, unknown>;
        mixedArtifacts.push({ languageDetection, staticAnalysis, context });
      },
    });
    assert.equal(mixed.result.stagesFinished, true);
    assert.deepEqual(mixed.result.stages.map(({ status }) => status), Array(9).fill("COMPLETED"));
    const capturedMixed = mixedArtifacts[0];
    assert.ok(capturedMixed);
    const detection = capturedMixed.languageDetection as {
      status: string;
      counts: { eligible: number; languages: { javascript: { eligible: number }; php: { eligible: number } } };
    };
    assert.equal(detection.status, "ready");
    assert.equal(detection.counts.eligible, 2);
    assert.equal(detection.counts.languages.javascript.eligible, 1);
    assert.equal(detection.counts.languages.php.eligible, 1);
    const analysis = capturedMixed.staticAnalysis as {
      status: string;
      report: { counts: { processed: number; languages: { javascript: { processed: number }; php: { processed: number } } } };
      ccm: { nodes: Array<{ language: string; name: string }> };
    };
    assert.equal(analysis.status, "complete");
    assert.equal(analysis.report.counts.processed, 2);
    assert.equal(analysis.report.counts.languages.javascript.processed, 1);
    assert.equal(analysis.report.counts.languages.php.processed, 1);
    assert.ok(analysis.ccm.nodes.some(({ language, name }) => language === "javascript" && name === "App"));
    assert.ok(analysis.ccm.nodes.some(({ language, name }) => language === "php" && name === "Service"));

    const directSourceHandlers = createSourceStageHandlers({ claim: mixed.claim, storageRoot, db });
    const limitedContext: AnalysisStageContext = {
      ...capturedMixed.context,
      configuration: {
        includeTests: false,
        sourcePolicyVersion: SOURCE_POLICY_VERSION,
        maxSourceFileBytes: 1,
      },
    };
    await assert.rejects(
      directSourceHandlers.LANGUAGE_DETECTION(limitedContext, new AbortController().signal),
      (error: unknown) => error instanceof AnalysisStageExecutionError && error.code === "NO_SUPPORTED_SOURCE",
    );
    const unsupportedPolicyContext: AnalysisStageContext = {
      ...capturedMixed.context,
      configuration: { sourcePolicyVersion: "unknown-policy-version", maxSourceFileBytes: 1 },
    };
    await assert.rejects(
      directSourceHandlers.LANGUAGE_DETECTION(unsupportedPolicyContext, new AbortController().signal),
      (error: unknown) => error instanceof AnalysisStageExecutionError && error.code === "SNAPSHOT_INVALID",
    );
    assert.equal(await failAnalysisJob(db, mixed.claim, "SOURCE_TEST_SUCCESS_CLEANUP"), true);

    const noSupported = await run({
      label: "unsupported",
      commitSha: "b".repeat(40),
      files: [
        { path: "README.md", content: "Documentation only." },
        { path: "package.json", content: "{\"private\":true}" },
      ],
    });
    assert.equal(noSupported.result.stagesFinished, false);
    assert.deepEqual(noSupported.result.stages.map(({ status }) => status), ["COMPLETED", "FAILED", ...Array(7).fill("PENDING")]);
    assert.equal(noSupported.result.stages[1]?.errorCode, "NO_SUPPORTED_SOURCE");
    const noSupportedRows = await db.analysisStage.findMany({
      where: { analysisId: noSupported.enqueued.analysisId, ownerUserId: owner.id },
      orderBy: { sequence: "asc" },
      select: { key: true, status: true, errorCode: true },
    });
    assert.equal(noSupportedRows[1]?.key, "LANGUAGE_DETECTION");
    assert.equal(noSupportedRows[1]?.status, "FAILED");
    assert.equal(noSupportedRows[1]?.errorCode, "NO_SUPPORTED_SOURCE");
    assert.equal(noSupportedRows.slice(2).every(({ status }) => status === "PENDING"), true);
    const noSupportedAnalysis = await db.analysis.findUniqueOrThrow({ where: { id: noSupported.enqueued.analysisId }, select: { status: true, errorCode: true } });
    assert.deepEqual(noSupportedAnalysis, { status: "FAILED", errorCode: "NO_SUPPORTED_SOURCE" });

    const parseFailed = await run({
      label: "parse-failed",
      commitSha: "c".repeat(40),
      files: [
        { path: "src/bad.js", content: "export class {\n" },
        { path: "src/bad.php", content: "<?php class {" },
      ],
    });
    assert.equal(parseFailed.result.stagesFinished, false);
    assert.deepEqual(parseFailed.result.stages.map(({ status }) => status), ["COMPLETED", "COMPLETED", "FAILED", ...Array(6).fill("PENDING")]);
    assert.equal(parseFailed.result.stages[2]?.errorCode, "PARSE_FAILED");
    const parseFailedRows = await db.analysisStage.findMany({
      where: { analysisId: parseFailed.enqueued.analysisId, ownerUserId: owner.id },
      orderBy: { sequence: "asc" },
      select: { key: true, status: true, errorCode: true },
    });
    assert.equal(parseFailedRows[2]?.key, "STATIC_ANALYSIS");
    assert.equal(parseFailedRows[2]?.status, "FAILED");
    assert.equal(parseFailedRows[2]?.errorCode, "PARSE_FAILED");
    assert.equal(parseFailedRows.slice(3).every(({ status }) => status === "PENDING"), true);
    const parseFailedAnalysis = await db.analysis.findUniqueOrThrow({ where: { id: parseFailed.enqueued.analysisId }, select: { status: true, errorCode: true } });
    assert.deepEqual(parseFailedAnalysis, { status: "FAILED", errorCode: "PARSE_FAILED" });

    const rawFailure = `private source failure marker ${suffix}`;
    const genericFailure = await run({
      label: "generic-failed",
      commitSha: "d".repeat(40),
      files: [{ path: "src/Good.js", content: "export function good() {}\n" }],
      onCommonCodeModel: () => { throw new Error(rawFailure); },
    });
    assert.equal(genericFailure.result.stagesFinished, false);
    assert.deepEqual(genericFailure.result.stages.map(({ status }) => status), ["COMPLETED", "COMPLETED", "COMPLETED", "FAILED", ...Array(5).fill("PENDING")]);
    assert.equal(genericFailure.result.stages[3]?.errorCode, "STAGE_HANDLER_FAILED");
    const genericRows = await db.analysisStage.findMany({
      where: { analysisId: genericFailure.enqueued.analysisId, ownerUserId: owner.id },
      orderBy: { sequence: "asc" },
      select: { key: true, status: true, errorCode: true },
    });
    assert.equal(genericRows[3]?.key, "COMMON_CODE_MODEL");
    assert.equal(genericRows[3]?.status, "FAILED");
    assert.equal(genericRows[3]?.errorCode, "STAGE_HANDLER_FAILED");
    assert.equal(genericRows.slice(4).every(({ status }) => status === "PENDING"), true);
    const genericAnalysis = await db.analysis.findUniqueOrThrow({ where: { id: genericFailure.enqueued.analysisId }, select: { status: true, errorCode: true } });
    assert.deepEqual(genericAnalysis, { status: "FAILED", errorCode: "STAGE_HANDLER_FAILED" });
    assert.ok(!JSON.stringify({ stages: genericFailure.result.stages, genericRows, genericAnalysis }).includes(rawFailure));
  } finally {
    try {
      await cleanup(db, userIds, repositoryId, jobIds, claims);
    } finally {
      if (storageRoot) await rm(storageRoot, { recursive: true, force: true });
      await disconnectDatabase();
    }
  }
});
