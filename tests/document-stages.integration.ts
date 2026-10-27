import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { pack } from "tar-stream";
import test from "node:test";
import { ANALYSIS_STAGE_DEFINITIONS } from "../packages/contracts/src/index.ts";
import {
  claimAnalysisJob,
  database,
  disconnectDatabase,
  enqueueAnalysis,
  failAnalysisJob,
  readCanonicalDocumentForUser,
} from "../packages/database/src/index.ts";
import type { AnalysisJobClaim } from "../packages/database/src/queue.ts";
import type { AnalysisStageArtifact, AnalysisStageContext, AnalysisStageHandler } from "../apps/worker/src/stage-runner.ts";
import { createCkgStageHandlers } from "../apps/worker/src/ckg-handlers.ts";
import { createDocumentStageHandlers } from "../apps/worker/src/document-handlers.ts";
import { createSourceStageHandlers } from "../apps/worker/src/source-handlers.ts";
import { runAnalysisStages } from "../apps/worker/src/stage-runner.ts";
import { parseSnapshotArchive } from "../apps/worker/src/snapshot/archive.ts";
import { writeSnapshotArchive } from "../apps/worker/src/snapshot/storage.ts";
import { parseCanonicalArchitectureDocument } from "@sage/documents/model";
import type { PrismaClient } from "../packages/database/generated/client.ts";

const documentTestsEnabled = process.env.SAGE_DOCUMENT_TESTS === "1";

async function createArchive(files: Record<string, Uint8Array>): Promise<Uint8Array> {
  const stream = pack();
  const chunks: Buffer[] = [];
  const collecting = (async () => { for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array)); })();
  await new Promise<void>((resolve, reject) => stream.entry({ name: "snapshot/", type: "directory", mtime: new Date(0) }, error => error ? reject(error) : resolve()));
  for (const [path, bytes] of Object.entries(files)) {
    await new Promise<void>((resolve, reject) => stream.entry({ name: `snapshot/${path}`, size: bytes.byteLength, type: "file", mtime: new Date(0) }, Buffer.from(bytes), error => error ? reject(error) : resolve()));
  }
  stream.finalize();
  await collecting;
  return gzipSync(Buffer.concat(chunks));
}

interface Fixture {
  db: PrismaClient;
  claim: AnalysisJobClaim;
  analysisId: string;
  ownerId: string;
  repositoryId: string;
  storageRoot: string;
  sources: Record<string, Uint8Array>;
  archive: Uint8Array;
}

async function prepareFixture(db: PrismaClient, leaseDurationMs = 300_000): Promise<Fixture> {
  const suffix = randomUUID();
  const owner = await db.user.create({ data: { githubUserId: `doc-stage-${suffix}`, login: `doc-stage-${suffix}` } });
  const repository = await db.repository.create({ data: { githubRepositoryId: `doc-stage-${suffix}`, ownerLogin: "fixture", name: suffix, fullName: `fixture/${suffix}`, visibility: "PUBLIC" } });
  const enqueued = await enqueueAnalysis(db, {
    ownerUserId: owner.id,
    repositoryId: repository.id,
    branchName: "main",
    commitSha: "a".repeat(40),
    configuration: { sourcePolicyVersion: "sage-source-policy-v1", maxSourceFileBytes: 1024 * 1024 },
    analyzerVersion: "document-stage-integration",
    schemaVersion: "1",
  });
  const claim = await claimAnalysisJob(db, { leaseDurationMs });
  assert.ok(claim);
  assert.equal(claim.analysisId, enqueued.analysisId);

  const sources = {
    "src/app.ts": new TextEncoder().encode('\ufeffexport class Café { run(): void {} }\r\nconst app = new Café(); app.run(); external.run();\r\n'),
    "src/app.php": new TextEncoder().encode('<?php\nclass Worker { public function run(): void {} }\n$worker = new Worker(); $worker->run();\n'),
    "src/canary.js": new TextEncoder().encode('import value from "pkg\\u0000name"; import lone from "pkg\\ud800"; value(); lone(); throw new Error("SOURCE_MUST_NEVER_EXECUTE"); export function ready() { return true; }\n'),
    "README.md": new TextEncoder().encode("fixture only"),
  };
  const archive = await createArchive(sources);
  const storageRoot = await mkdtemp(join(tmpdir(), "sage-document15-"));
  return { db, claim, analysisId: enqueued.analysisId, ownerId: owner.id, repositoryId: repository.id, storageRoot, sources, archive };
}

/** Start document persistence just before the runner's next 10s default heartbeat. */
async function waitForHeartbeatContentionWindow(db: PrismaClient): Promise<Date> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const slot = await db.workerSlot.findUniqueOrThrow({ where: { slotKey: "analysis" }, select: { heartbeatAt: true } });
    if (!slot.heartbeatAt) throw new Error("The analysis heartbeat timestamp is missing.");
    const elapsedMs = Date.now() - slot.heartbeatAt.getTime();
    if (elapsedMs >= 9_300 && elapsedMs <= 9_700) return slot.heartbeatAt;
    if (elapsedMs < 9_300) await delay(Math.min(100, 9_300 - elapsedMs));
    else await delay(20);
  }
  throw new Error("The analysis heartbeat did not reach the document-persistence contention window.");
}

function stageHandlers(fixture: Fixture, failAtDiagram = false) {
  const captured: Partial<Record<"INTERFACE_CATALOG" | "SOFTWARE_ENGINEERING_DIAGRAM" | "UML_CLASS_DIAGRAM" | "ARCHITECTURE_DOCUMENT", AnalysisStageArtifact>> = {};
  const documentHandlers = createDocumentStageHandlers({ claim: fixture.claim, storageRoot: fixture.storageRoot, db: fixture.db });
  const capture = (key: keyof typeof captured, handler: AnalysisStageHandler): AnalysisStageHandler => async (context, signal) => {
    const artifact = await handler(context, signal);
    if (artifact !== undefined) captured[key] = artifact;
    return artifact;
  };
  const documentStages = {
    INTERFACE_CATALOG: capture("INTERFACE_CATALOG", documentHandlers.INTERFACE_CATALOG),
    SOFTWARE_ENGINEERING_DIAGRAM: failAtDiagram
      ? async () => { throw new Error("forced document stage failure"); }
      : capture("SOFTWARE_ENGINEERING_DIAGRAM", documentHandlers.SOFTWARE_ENGINEERING_DIAGRAM),
    UML_CLASS_DIAGRAM: capture("UML_CLASS_DIAGRAM", documentHandlers.UML_CLASS_DIAGRAM),
    ARCHITECTURE_DOCUMENT: capture("ARCHITECTURE_DOCUMENT", documentHandlers.ARCHITECTURE_DOCUMENT),
  };
  const handlers = {
    SNAPSHOT: async (_context: AnalysisStageContext, signal: AbortSignal) => {
      const parsed = await parseSnapshotArchive(fixture.archive, { signal });
      const stored = await writeSnapshotArchive(fixture.db, {
        claim: fixture.claim,
        storageRoot: fixture.storageRoot,
        archive: fixture.archive,
        sha256: parsed.archiveSha256,
        signal,
      });
      return {
        ...stored,
        commitSha: "a".repeat(40),
        files: parsed.files.length,
        extractedBytes: parsed.extractedBytes,
      };
    },
    ...createSourceStageHandlers({ claim: fixture.claim, storageRoot: fixture.storageRoot, db: fixture.db }),
    ...createCkgStageHandlers({ claim: fixture.claim, storageRoot: fixture.storageRoot, db: fixture.db }),
    ...documentStages,
  };
  return { handlers, captured };
}

async function cleanupFixture(fixture: Fixture | null): Promise<void> {
  if (!fixture) return;
  await failAnalysisJob(fixture.db, fixture.claim, "DOCUMENT_TEST_CLEANUP").catch(() => false);
  await fixture.db.workerSlot.updateMany({ where: { ownerUserId: fixture.ownerId }, data: { jobId: null, ownerUserId: null, leaseUntil: null, heartbeatAt: null, leaseTokenHash: null } });
  await fixture.db.job.deleteMany({ where: { ownerUserId: fixture.ownerId } });
  await fixture.db.storageObject.deleteMany({ where: { ownerUserId: fixture.ownerId } });
  await fixture.db.analysis.deleteMany({ where: { ownerUserId: fixture.ownerId } });
  await fixture.db.user.delete({ where: { id: fixture.ownerId } });
  await fixture.db.repository.delete({ where: { id: fixture.repositoryId } });
  await rm(fixture.storageRoot, { recursive: true, force: true });
}

test("real document stages persist one replayable canonical document without publishing analysis", {
  skip: !documentTestsEnabled,
}, async () => {
  assert.equal(new URL(process.env.DATABASE_URL!).pathname, "/sage_document15", "only the isolated DOC01 integration database is allowed");
  const db = database();
  let fixture: Fixture | null = null;
  try {
    fixture = await prepareFixture(db);
    const { handlers, captured } = stageHandlers(fixture);
    const result = await runAnalysisStages(db, fixture.claim, handlers, { leaseDurationMs: 300_000 });
    assert.equal(result.stagesFinished, true, JSON.stringify(result.stages));
    assert.deepEqual(result.stages.map(stage => [stage.sequence, stage.key, stage.status]), ANALYSIS_STAGE_DEFINITIONS.map(stage => [stage.sequence, stage.key, "COMPLETED"]));

    const interfaceCatalog = captured.INTERFACE_CATALOG as Record<string, unknown>;
    const softwareDiagram = captured.SOFTWARE_ENGINEERING_DIAGRAM as Record<string, unknown>;
    const umlDiagram = captured.UML_CLASS_DIAGRAM as Record<string, unknown>;
    const final = captured.ARCHITECTURE_DOCUMENT as Record<string, unknown>;
    assert.ok(interfaceCatalog && softwareDiagram && umlDiagram && final);
    assert.equal(interfaceCatalog.ckgSha256, softwareDiagram.ckgSha256);
    assert.equal(interfaceCatalog.ckgSha256, umlDiagram.ckgSha256);
    assert.equal(interfaceCatalog.documentSha256, softwareDiagram.documentSha256);
    assert.equal(interfaceCatalog.documentSha256, umlDiagram.documentSha256);
    assert.equal(interfaceCatalog.documentSha256, final.documentSha256);
    assert.deepEqual(interfaceCatalog.context, softwareDiagram.context);
    assert.deepEqual(interfaceCatalog.context, umlDiagram.context);
    assert.deepEqual(interfaceCatalog.context, final.context);
    assert.equal(final.contentHash, final.documentSha256);
    assert.equal(final.canonicalJson, JSON.stringify(final.document));

    const analysis = await db.analysis.findUniqueOrThrow({ where: { id: fixture.analysisId }, select: { status: true } });
    const job = await db.job.findUniqueOrThrow({ where: { id: fixture.claim.jobId }, select: { status: true } });
    assert.equal(analysis.status, "RUNNING");
    assert.equal(job.status, "RUNNING");
    assert.equal(await readCanonicalDocumentForUser(db, fixture.ownerId, fixture.analysisId, fixture.sources), null, "the persisted document remains unreadable until analysis publication");

    const row = await db.architectureDocument.findUniqueOrThrow({
      where: { analysisId_ownerUserId: { analysisId: fixture.analysisId, ownerUserId: fixture.ownerId } },
    });
    const graph = await db.graphBundle.findUniqueOrThrow({
      where: { analysisId_ownerUserId: { analysisId: fixture.analysisId, ownerUserId: fixture.ownerId } },
    });
    assert.equal(row.contentHash, final.contentHash);
    assert.equal(row.canonicalContent, final.canonicalJson);
    assert.equal(row.interfaceCatalog, JSON.stringify(interfaceCatalog.artifact));
    assert.equal(row.softwareEngineeringDiagram, JSON.stringify(softwareDiagram.artifact));
    assert.equal(row.umlClassDiagram, JSON.stringify(umlDiagram.artifact));
    assert.equal(graph.contentHash, final.ckgSha256);
    assert.ok(graph.canonicalContent);
    const replay = parseCanonicalArchitectureDocument(row.canonicalContent!, graph.canonicalContent!, fixture.sources, row.contentHash, graph.contentHash);
    assert.ok(replay.ok);
    assert.deepEqual(replay.value, final.document);
    assert.deepEqual(new Set(replay.value.files.map(file => file.language)), new Set(["typescript", "php", "javascript", null]));
    assert.ok(replay.value.canonicalCounts.unresolvedEdges > 0);
    const serialized = JSON.stringify(replay.value);
    assert.ok(serialized.includes("\\u0000"), "escaped NUL labels survive canonical document storage");
    assert.ok(serialized.includes("\\ud800"), "lone surrogate labels survive canonical document storage");
  } finally {
    await cleanupFixture(fixture);
    await disconnectDatabase();
  }
});

test("a failure before stage 9 leaves no architecture document row", {
  skip: !documentTestsEnabled,
}, async () => {
  assert.equal(new URL(process.env.DATABASE_URL!).pathname, "/sage_document15", "only the isolated DOC01 integration database is allowed");
  const db = database();
  let fixture: Fixture | null = null;
  try {
    fixture = await prepareFixture(db);
    const { handlers } = stageHandlers(fixture, true);
    const result = await runAnalysisStages(db, fixture.claim, handlers, { leaseDurationMs: 300_000 });
    assert.equal(result.stagesFinished, false);
    assert.equal(await db.architectureDocument.count({ where: { analysisId: fixture.analysisId } }), 0);
    assert.equal((await db.analysis.findUniqueOrThrow({ where: { id: fixture.analysisId }, select: { status: true } })).status, "FAILED");
  } finally {
    await cleanupFixture(fixture);
    await disconnectDatabase();
  }
});

test("the default lease heartbeat waits through slow document persistence without interrupting the stage", {
  skip: !documentTestsEnabled,
}, async () => {
  assert.equal(new URL(process.env.DATABASE_URL!).pathname, "/sage_document15", "only the isolated DOC01 integration database is allowed");
  const db = database();
  let fixture: Fixture | null = null;
  const suffix = randomUUID().replaceAll("-", "");
  const functionName = `doc15_heartbeat_${suffix}`;
  const triggerName = `${functionName}_trigger`;
  let observerFinished = false;
  let observedBlockedHeartbeat = false;
  let heartbeatObserver: Promise<void> | undefined;
  try {
    // Exercise the actual 30s queue lease and the runner's 10s heartbeat cadence.
    fixture = await prepareFixture(db, 30_000);
    const { handlers } = stageHandlers(fixture);
    const architectureDocumentHandler = handlers.ARCHITECTURE_DOCUMENT;
    handlers.ARCHITECTURE_DOCUMENT = async (context, signal) => {
      await waitForHeartbeatContentionWindow(db);
      return architectureDocumentHandler(context, signal);
    };

    await db.$executeRawUnsafe(`CREATE FUNCTION "${functionName}"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(6); RETURN NEW; END $$`);
    await db.$executeRawUnsafe(`CREATE TRIGGER "${triggerName}" BEFORE INSERT ON "ArchitectureDocument" FOR EACH ROW EXECUTE FUNCTION "${functionName}"()`);
    heartbeatObserver = (async () => {
      while (!observerFinished) {
        const rows = await db.$queryRaw<Array<{ waiting: boolean }>>`
          SELECT EXISTS (
            SELECT 1 FROM pg_stat_activity
            WHERE datname = current_database() AND pid <> pg_backend_pid()
              AND wait_event_type = 'Lock'
              AND query LIKE '%"WorkerSlot"%' AND query LIKE '%"leaseTokenHash"%' AND query LIKE '%FOR UPDATE%'
          ) AS "waiting"
        `;
        if (rows[0]?.waiting) observedBlockedHeartbeat = true;
        await delay(25);
      }
    })();

    const result = await runAnalysisStages(db, fixture.claim, handlers, { leaseDurationMs: 30_000 });
    observerFinished = true;
    await heartbeatObserver;
    assert.equal(result.stagesFinished, true, JSON.stringify(result.stages));
    assert.equal(observedBlockedHeartbeat, true, "the 10s heartbeat must wait behind the document transaction's WorkerSlot lock");
    assert.equal(await db.architectureDocument.count({ where: { analysisId: fixture.analysisId } }), 1);
  } finally {
    observerFinished = true;
    await heartbeatObserver?.catch(() => undefined);
    await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${triggerName}" ON "ArchitectureDocument"`).catch(() => undefined);
    await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${functionName}"()`).catch(() => undefined);
    await cleanupFixture(fixture);
    await disconnectDatabase();
  }
});
