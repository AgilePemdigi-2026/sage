import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { pack } from "tar-stream";
import { analyzeReferences } from "@sage/analyzer-js";
import { canonicalizeCkg } from "@sage/contracts";
import { projectArchitectureDocument } from "@sage/documents/model";
import {
  compactAnalysisStorage,
  database,
  disconnectDatabase,
  readCanonicalDocumentForUser,
  readCanonicalGraphForUser,
} from "../packages/database/src/index.ts";
import type { PrismaClient } from "../packages/database/generated/client.ts";
import { renderMarkdownDocument } from "../packages/documents/src/markdown.ts";

const TEST_DATABASE = "sage_storage96";
const sourcePath = "examples/minimum-ccm.source.ts";
const configurationHash = "c".repeat(64);
const runIntegration = process.env.SAGE_STORAGE_TESTS === "1";

function assertIsolatedStorageDatabase(): void {
  if (process.env.SAGE_STORAGE_TESTS !== "1") throw new Error("Set SAGE_STORAGE_TESTS=1 to run storage compaction integration tests.");
  const rawUrl = process.env.DATABASE_URL;
  if (!rawUrl) throw new Error("DATABASE_URL is required for storage compaction integration tests.");
  let databaseName: string;
  try {
    databaseName = decodeURIComponent(new URL(rawUrl).pathname.slice(1));
  } catch {
    throw new Error("DATABASE_URL is invalid; it was not logged.");
  }
  if (databaseName !== TEST_DATABASE) throw new Error(`Storage compaction integration tests only allow ${TEST_DATABASE}.`);
}

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function tarArchive(path: string, bytes: Uint8Array): Promise<Uint8Array> {
  const stream = pack();
  const chunks: Buffer[] = [];
  const collecting = (async () => { for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array)); })();
  await new Promise<void>((resolve, reject) => stream.entry({ name: "snapshot/", type: "directory", mtime: new Date(0) }, error => error ? reject(error) : resolve()));
  await new Promise<void>((resolve, reject) => stream.entry({ name: `snapshot/${path}`, size: bytes.byteLength, type: "file", mtime: new Date(0) }, Buffer.from(bytes), error => error ? reject(error) : resolve()));
  stream.finalize();
  await collecting;
  return gzipSync(Buffer.concat(chunks));
}

async function storeSourceArchive(db: PrismaClient, input: {
  storageRoot: string;
  ownerUserId: string;
  analysisId: string;
  sourceBytes: Uint8Array;
}) {
  const folderName = `snapshot-${randomUUID().replaceAll("-", "").slice(0, 6)}`;
  const folderPath = join(input.storageRoot, folderName);
  await mkdir(folderPath, { mode: 0o700 });
  const archive = await tarArchive(sourcePath, input.sourceBytes);
  const storageKey = `${folderName}/archive.tar.gz`;
  await writeFile(join(folderPath, "archive.tar.gz"), archive, { flag: "wx", mode: 0o600 });
  const storageObject = await db.storageObject.create({ data: {
    ownerUserId: input.ownerUserId,
    analysisId: input.analysisId,
    type: "SOURCE_ARCHIVE",
    storageKey,
    sha256: sha256(archive),
    byteLength: BigInt(archive.byteLength),
  } });
  return { storageObject, folderPath };
}

async function runMaintenanceCli(args: string[], env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, ["--import", "tsx", "scripts/compact-canonical-storage.ts", ...args], {
    cwd: process.cwd(),
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", chunk => stdout.push(Buffer.from(chunk)));
  child.stderr.on("data", chunk => stderr.push(Buffer.from(chunk)));
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", code => resolve(code ?? 1));
  });
  return { exitCode, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") };
}

async function createLegacyAnalysis(db: PrismaClient, input: {
  ownerUserId: string;
  repositoryId: string;
  repositoryFullName: string;
  suffix: string;
  sourceBytes: Uint8Array;
}) {
  const commitSha = sha256(input.suffix).slice(0, 40);
  const branchName = "main";
  const sources = { [sourcePath]: input.sourceBytes };
  const analyzed = await analyzeReferences({
    snapshot: { repository: input.repositoryFullName, branch: branchName, commitSha },
    sources,
  });
  assert.ok(analyzed.ccm, `Fixture analyzer failed: ${analyzed.errorCode}`);
  const canonicalGraph = canonicalizeCkg(analyzed.ccm, sources, configurationHash);
  assert.ok(canonicalGraph.ok, canonicalGraph.ok ? undefined : `Fixture CKG failed: ${canonicalGraph.errorCode}`);
  const canonicalDocument = projectArchitectureDocument(canonicalGraph.json, sources, canonicalGraph.sha256);
  assert.ok(canonicalDocument.ok, canonicalDocument.ok ? undefined : `Fixture ADD failed: ${canonicalDocument.errorCode}`);

  const resultHash = sha256(`analysis-result-${input.suffix}`);
  const analysis = await db.analysis.create({ data: {
    ownerUserId: input.ownerUserId,
    repositoryId: input.repositoryId,
    repositoryFullNameSnapshot: input.repositoryFullName,
    branchName,
    commitSha,
    configuration: { storageCompactionFixture: true },
    configurationHash,
    analyzerVersion: "storage-compaction-integration",
    schemaVersion: "1",
    status: "COMPLETED",
    resultHash,
    completedAt: new Date(),
  } });
  const graph = await db.graphBundle.create({ data: {
    ownerUserId: input.ownerUserId,
    analysisId: analysis.id,
    schemaVersion: canonicalGraph.value.schemaVersion,
    configurationHash: canonicalGraph.value.configurationHash,
    storageLayoutVersion: 1,
    canonicalContent: canonicalGraph.json,
    nodes: JSON.stringify(canonicalGraph.value.ccm.nodes),
    edges: JSON.stringify(canonicalGraph.value.ccm.edges),
    nodeCount: canonicalGraph.value.counts.nodes,
    edgeCount: canonicalGraph.value.counts.edges,
    contentHash: canonicalGraph.sha256,
  } });
  const document = await db.architectureDocument.create({ data: {
    ownerUserId: input.ownerUserId,
    analysisId: analysis.id,
    title: canonicalDocument.value.title,
    documentModelVersion: canonicalDocument.value.schemaVersion,
    storageLayoutVersion: 1,
    canonicalContent: canonicalDocument.json,
    interfaceCatalog: JSON.stringify(canonicalDocument.value.interfaceCatalog),
    softwareEngineeringDiagram: JSON.stringify(canonicalDocument.value.softwareEngineeringDiagram),
    umlClassDiagram: JSON.stringify(canonicalDocument.value.umlClassDiagram),
    contentHash: canonicalDocument.sha256,
  } });
  return {
    analysis,
    graph,
    document,
    canonicalGraph,
    canonicalDocument,
    resultHash,
    sourceBytes: sources,
  };
}

async function rowsForAnalysis(db: PrismaClient, ownerUserId: string, analysisId: string) {
  const where = { analysisId_ownerUserId: { analysisId, ownerUserId } };
  const [graph, document, analysis] = await Promise.all([
    db.graphBundle.findUniqueOrThrow({ where }),
    db.architectureDocument.findUniqueOrThrow({ where }),
    db.analysis.findUniqueOrThrow({ where: { id: analysisId }, select: { id: true, resultHash: true, status: true } }),
  ]);
  return { graph, document, analysis };
}

async function makeOwnerAndRepository(db: PrismaClient, suffix: string) {
  const owner = await db.user.create({ data: {
    githubUserId: `storage96-owner-${suffix}`,
    login: `storage96-owner-${suffix}`,
  } });
  const outsider = await db.user.create({ data: {
    githubUserId: `storage96-outsider-${suffix}`,
    login: `storage96-outsider-${suffix}`,
  } });
  const repository = await db.repository.create({ data: {
    githubRepositoryId: `storage96-repo-${suffix}`,
    ownerLogin: "sage-storage-test",
    name: suffix,
    fullName: `sage-storage-test/${suffix}`,
    visibility: "PUBLIC",
  } });
  return { owner, outsider, repository };
}

test("canonical storage compaction audits, compacts atomically, and preserves canonical reads and render output", {
  skip: !runIntegration,
}, async () => {
  assertIsolatedStorageDatabase();
  const db = database();
  const suffix = randomUUID().replaceAll("-", "");
  const ownerIds: string[] = [];
  let repositoryId = "";
  let storageRoot = "";
  let rollbackConstraint: string | null = null;
  try {
    const { owner, outsider, repository } = await makeOwnerAndRepository(db, suffix);
    ownerIds.push(owner.id, outsider.id);
    repositoryId = repository.id;
    const sourceBytes = new Uint8Array(await readFile(new URL("../packages/contracts/examples/minimum-ccm.source.ts", import.meta.url)));
    storageRoot = await mkdtemp(join(tmpdir(), "sage-storage96-cli-"));

    const happy = await createLegacyAnalysis(db, {
      ownerUserId: owner.id,
      repositoryId,
      repositoryFullName: repository.fullName,
      suffix: `${suffix}-happy`,
      sourceBytes,
    });
    const before = await rowsForAnalysis(db, owner.id, happy.analysis.id);
    const originalHashes = {
      graph: happy.graph.contentHash,
      document: happy.document.contentHash,
      result: happy.resultHash,
    };
    const originalUpdatedAt = {
      graph: happy.graph.updatedAt,
      document: happy.document.updatedAt,
    };
    const beforeRead = await readCanonicalDocumentForUser(db, owner.id, happy.analysis.id, happy.sourceBytes);
    assert.ok(beforeRead);
    const markdownBefore = renderMarkdownDocument(beforeRead.document);

    const missingSource = await compactAnalysisStorage(db, happy.analysis.id);
    assert.deepEqual(missingSource, {
      status: "skipped",
      reason: "LEGACY_UNVERIFIABLE",
      graphs: 0,
      documents: 0,
      canonicalBytes: 0,
      removableMirrorBytes: 0,
    });
    assert.deepEqual(await rowsForAnalysis(db, owner.id, happy.analysis.id), before);

    const audit = await compactAnalysisStorage(db, happy.analysis.id, { sourceBytes: happy.sourceBytes });
    assert.equal(audit.status, "eligible");
    assert.equal(audit.graphs, 1);
    assert.equal(audit.documents, 1);
    assert.ok(audit.removableMirrorBytes > 0);
    assert.deepEqual(await rowsForAnalysis(db, owner.id, happy.analysis.id), before, "audit mode leaves every row unchanged");

    const applied = await compactAnalysisStorage(db, happy.analysis.id, { apply: true, sourceBytes: happy.sourceBytes });
    assert.equal(applied.status, "compacted");
    const after = await rowsForAnalysis(db, owner.id, happy.analysis.id);
    assert.equal(after.graph.storageLayoutVersion, 2);
    assert.equal(after.document.storageLayoutVersion, 2);
    assert.equal(after.graph.contentHash, originalHashes.graph);
    assert.equal(after.document.contentHash, originalHashes.document);
    assert.equal(after.analysis.resultHash, originalHashes.result);
    assert.equal(after.graph.updatedAt.getTime(), originalUpdatedAt.graph.getTime());
    assert.equal(after.document.updatedAt.getTime(), originalUpdatedAt.document.getTime());
    assert.equal(after.graph.canonicalContent, happy.canonicalGraph.json);
    assert.equal(after.document.canonicalContent, happy.canonicalDocument.json);

    const sqlNulls = await db.$queryRaw<Array<{
      graphNodesNull: boolean; graphEdgesNull: boolean; catalogNull: boolean; engineeringDiagramNull: boolean; umlDiagramNull: boolean;
    }>>`
      SELECT graph."nodes" IS NULL AS "graphNodesNull", graph."edges" IS NULL AS "graphEdgesNull",
        document."interfaceCatalog" IS NULL AS "catalogNull",
        document."softwareEngineeringDiagram" IS NULL AS "engineeringDiagramNull",
        document."umlClassDiagram" IS NULL AS "umlDiagramNull"
      FROM "GraphBundle" AS graph
      JOIN "ArchitectureDocument" AS document USING ("analysisId", "ownerUserId")
      WHERE graph."analysisId" = ${happy.analysis.id} AND graph."ownerUserId" = ${owner.id}
    `;
    assert.deepEqual(sqlNulls, [{
      graphNodesNull: true,
      graphEdgesNull: true,
      catalogNull: true,
      engineeringDiagramNull: true,
      umlDiagramNull: true,
    }], "v2 mirror columns contain SQL NULL, not JSON null");

    const afterRead = await readCanonicalDocumentForUser(db, owner.id, happy.analysis.id, happy.sourceBytes);
    assert.ok(afterRead);
    assert.deepEqual(afterRead.document, beforeRead.document);
    assert.equal(renderMarkdownDocument(afterRead.document), markdownBefore);
    assert.equal((await readCanonicalGraphForUser(db, owner.id, happy.analysis.id, happy.sourceBytes))?.contentHash, originalHashes.graph);
    assert.equal(await readCanonicalDocumentForUser(db, outsider.id, happy.analysis.id, happy.sourceBytes), null);
    assert.equal(await readCanonicalGraphForUser(db, outsider.id, happy.analysis.id, happy.sourceBytes), null);

    const secondApply = await compactAnalysisStorage(db, happy.analysis.id, { apply: true, sourceBytes: happy.sourceBytes });
    assert.equal(secondApply.status, "unchanged");
    assert.equal(secondApply.reason, null);
    assert.deepEqual(await rowsForAnalysis(db, owner.id, happy.analysis.id), after, "a second apply is idempotent");

    const cliFixture = await createLegacyAnalysis(db, {
      ownerUserId: owner.id,
      repositoryId,
      repositoryFullName: repository.fullName,
      suffix: `${suffix}-cli`,
      sourceBytes,
    });
    await storeSourceArchive(db, {
      storageRoot,
      ownerUserId: owner.id,
      analysisId: cliFixture.analysis.id,
      sourceBytes,
    });
    const cliBefore = await rowsForAnalysis(db, owner.id, cliFixture.analysis.id);
    const cliEnv = { ...process.env, STORAGE_ROOT: storageRoot };
    const cliArgs = ["--analysis-id", cliFixture.analysis.id];
    const cliAudit = await runMaintenanceCli(cliArgs, cliEnv);
    assert.equal(cliAudit.exitCode, 0, "CLI defaults to a successful audit");
    const cliAuditSummary = JSON.parse(cliAudit.stdout) as Record<string, unknown>;
    assert.deepEqual(
      [cliAuditSummary.mode, cliAuditSummary.examined, cliAuditSummary.eligible, cliAuditSummary.compacted],
      ["audit", 1, 1, 0],
    );
    assert.deepEqual(await rowsForAnalysis(db, owner.id, cliFixture.analysis.id), cliBefore, "CLI default mode does not modify result rows");

    const cliApply = await runMaintenanceCli([...cliArgs, "--apply"], cliEnv);
    assert.equal(cliApply.exitCode, 0, "CLI apply succeeds for a verified archive");
    const cliApplySummary = JSON.parse(cliApply.stdout) as Record<string, unknown>;
    assert.deepEqual(
      [cliApplySummary.mode, cliApplySummary.examined, cliApplySummary.compacted],
      ["apply", 1, 1],
    );
    const cliAfterApply = await rowsForAnalysis(db, owner.id, cliFixture.analysis.id);
    assert.equal(cliAfterApply.graph.storageLayoutVersion, 2);
    assert.equal(cliAfterApply.document.storageLayoutVersion, 2);
    assert.equal(cliAfterApply.graph.contentHash, cliFixture.graph.contentHash);
    assert.equal(cliAfterApply.document.contentHash, cliFixture.document.contentHash);
    assert.equal(cliAfterApply.graph.updatedAt.getTime(), cliFixture.graph.updatedAt.getTime());
    assert.equal(cliAfterApply.document.updatedAt.getTime(), cliFixture.document.updatedAt.getTime());

    const cliRerun = await runMaintenanceCli([...cliArgs, "--apply"], cliEnv);
    assert.equal(cliRerun.exitCode, 0, "CLI apply rerun succeeds");
    const cliRerunSummary = JSON.parse(cliRerun.stdout) as Record<string, unknown>;
    assert.deepEqual(
      [cliRerunSummary.mode, cliRerunSummary.examined, cliRerunSummary.unchanged, cliRerunSummary.compacted],
      ["apply", 1, 1, 0],
    );
    assert.deepEqual(await rowsForAnalysis(db, owner.id, cliFixture.analysis.id), cliAfterApply, "CLI rerun remains idempotent");

    const sourceText = Buffer.from(sourceBytes).toString("utf8");
    for (const cliResult of [cliAudit, cliApply, cliRerun]) {
      const output = cliResult.stdout + cliResult.stderr;
      assert.equal(output.includes(sourceText), false, "CLI output omits source text");
      assert.equal(output.includes(process.env.DATABASE_URL!), false, "CLI output omits the database URL");
    }
    for (const invalidArgs of [["--not-a-real-flag"], ["--analysis-id"]]) {
      const invalid = await runMaintenanceCli(invalidArgs, cliEnv);
      assert.equal(invalid.exitCode, 1, "unknown flags and missing values fail closed");
      assert.equal(invalid.stdout, "");
      assert.match(invalid.stderr, /Canonical storage maintenance failed/);
      assert.equal(invalid.stderr.includes(sourceText), false, "CLI errors omit source text");
      assert.equal(invalid.stderr.includes(process.env.DATABASE_URL!), false, "CLI errors omit the database URL");
    }

    const corrupt = await createLegacyAnalysis(db, {
      ownerUserId: owner.id,
      repositoryId,
      repositoryFullName: repository.fullName,
      suffix: `${suffix}-corrupt`,
      sourceBytes,
    });
    const corruptSource = { [sourcePath]: new Uint8Array(sourceBytes) };
    corruptSource[sourcePath]![0] ^= 1;
    let stableRows = await rowsForAnalysis(db, owner.id, corrupt.analysis.id);
    let result = await compactAnalysisStorage(db, corrupt.analysis.id, { apply: true, sourceBytes: corruptSource });
    assert.deepEqual([result.status, result.reason], ["skipped", "INTEGRITY_ERROR"]);
    assert.deepEqual(await rowsForAnalysis(db, owner.id, corrupt.analysis.id), stableRows);

    await db.graphBundle.update({ where: { id: corrupt.graph.id }, data: { contentHash: "e".repeat(64) } });
    stableRows = await rowsForAnalysis(db, owner.id, corrupt.analysis.id);
    result = await compactAnalysisStorage(db, corrupt.analysis.id, { apply: true, sourceBytes: corrupt.sourceBytes });
    assert.deepEqual([result.status, result.reason], ["skipped", "INTEGRITY_ERROR"]);
    assert.deepEqual(await rowsForAnalysis(db, owner.id, corrupt.analysis.id), stableRows);

    await db.graphBundle.update({ where: { id: corrupt.graph.id }, data: { contentHash: corrupt.graph.contentHash, nodes: [] } });
    stableRows = await rowsForAnalysis(db, owner.id, corrupt.analysis.id);
    result = await compactAnalysisStorage(db, corrupt.analysis.id, { apply: true, sourceBytes: corrupt.sourceBytes });
    assert.deepEqual([result.status, result.reason], ["skipped", "INTEGRITY_ERROR"]);
    assert.deepEqual(await rowsForAnalysis(db, owner.id, corrupt.analysis.id), stableRows);

    await db.graphBundle.update({ where: { id: corrupt.graph.id }, data: { nodes: String(corrupt.graph.nodes) } });
    await db.architectureDocument.update({ where: { id: corrupt.document.id }, data: { umlClassDiagram: [] } });
    stableRows = await rowsForAnalysis(db, owner.id, corrupt.analysis.id);
    result = await compactAnalysisStorage(db, corrupt.analysis.id, { apply: true, sourceBytes: corrupt.sourceBytes });
    assert.deepEqual([result.status, result.reason], ["skipped", "INTEGRITY_ERROR"]);
    assert.deepEqual(await rowsForAnalysis(db, owner.id, corrupt.analysis.id), stableRows,
      "an invalid document mirror does not allow the valid graph to compact first");

    const guarded = await createLegacyAnalysis(db, {
      ownerUserId: owner.id,
      repositoryId,
      repositoryFullName: repository.fullName,
      suffix: `${suffix}-guarded`,
      sourceBytes,
    });
    await db.analysis.update({ where: { id: guarded.analysis.id }, data: { status: "RUNNING" } });
    result = await compactAnalysisStorage(db, guarded.analysis.id, { apply: true, sourceBytes: guarded.sourceBytes });
    assert.deepEqual([result.status, result.reason], ["skipped", "ACTIVE_ANALYSIS"]);
    assert.equal((await rowsForAnalysis(db, owner.id, guarded.analysis.id)).graph.storageLayoutVersion, 1);

    await db.analysis.update({ where: { id: guarded.analysis.id }, data: { status: "COMPLETED", deletionRequestedAt: new Date() } });
    result = await compactAnalysisStorage(db, guarded.analysis.id, { apply: true, sourceBytes: guarded.sourceBytes });
    assert.deepEqual([result.status, result.reason], ["skipped", "DELETION_PENDING"]);
    assert.equal((await rowsForAnalysis(db, owner.id, guarded.analysis.id)).graph.storageLayoutVersion, 1);

    const legacy = await createLegacyAnalysis(db, {
      ownerUserId: owner.id,
      repositoryId,
      repositoryFullName: repository.fullName,
      suffix: `${suffix}-legacy-null`,
      sourceBytes,
    });
    await db.graphBundle.update({ where: { id: legacy.graph.id }, data: { canonicalContent: null } });
    stableRows = await rowsForAnalysis(db, owner.id, legacy.analysis.id);
    result = await compactAnalysisStorage(db, legacy.analysis.id, { apply: true, sourceBytes: legacy.sourceBytes });
    assert.deepEqual([result.status, result.reason], ["skipped", "LEGACY_UNVERIFIABLE"]);
    assert.deepEqual(await rowsForAnalysis(db, owner.id, legacy.analysis.id), stableRows);

    const constraints = await createLegacyAnalysis(db, {
      ownerUserId: owner.id,
      repositoryId,
      repositoryFullName: repository.fullName,
      suffix: `${suffix}-constraints`,
      sourceBytes,
    });
    await assert.rejects(db.$executeRaw`
      UPDATE "GraphBundle" SET "storageLayoutVersion" = 2, "nodes" = 'null'::jsonb, "edges" = NULL
      WHERE "id" = ${constraints.graph.id}
    `, /check constraint/i, "GraphBundle v2 rejects JSON null mirrors");
    await assert.rejects(db.$executeRaw`
      UPDATE "GraphBundle" SET "storageLayoutVersion" = 2, "canonicalContent" = NULL, "nodes" = NULL, "edges" = NULL
      WHERE "id" = ${constraints.graph.id}
    `, /check constraint/i, "GraphBundle v2 requires canonical content");
    await assert.rejects(db.$executeRaw`
      UPDATE "ArchitectureDocument" SET "storageLayoutVersion" = 2, "interfaceCatalog" = 'null'::jsonb,
        "softwareEngineeringDiagram" = NULL, "umlClassDiagram" = NULL
      WHERE "id" = ${constraints.document.id}
    `, /check constraint/i, "ArchitectureDocument v2 rejects JSON null mirrors");
    await assert.rejects(db.$executeRaw`
      UPDATE "ArchitectureDocument" SET "storageLayoutVersion" = 2, "canonicalContent" = NULL,
        "interfaceCatalog" = NULL, "softwareEngineeringDiagram" = NULL, "umlClassDiagram" = NULL
      WHERE "id" = ${constraints.document.id}
    `, /check constraint/i, "ArchitectureDocument v2 requires canonical content");
    assert.equal((await rowsForAnalysis(db, owner.id, constraints.analysis.id)).graph.storageLayoutVersion, 1);
    assert.equal((await rowsForAnalysis(db, owner.id, constraints.analysis.id)).document.storageLayoutVersion, 1);

    const rollback = await createLegacyAnalysis(db, {
      ownerUserId: owner.id,
      repositoryId,
      repositoryFullName: repository.fullName,
      suffix: `${suffix}-rollback`,
      sourceBytes,
    });
    rollbackConstraint = `StorageCompactionRollback_${suffix.slice(0, 20)}`;
    assert.match(rollback.analysis.id, /^[A-Za-z0-9_-]+$/);
    await db.$executeRawUnsafe(
      `ALTER TABLE "ArchitectureDocument" ADD CONSTRAINT "${rollbackConstraint}" ` +
      `CHECK ("analysisId" <> '${rollback.analysis.id}' OR "storageLayoutVersion" = 1)`,
    );
    await assert.rejects(
      compactAnalysisStorage(db, rollback.analysis.id, { apply: true, sourceBytes: rollback.sourceBytes }),
      /constraint|check|ArchitectureDocument/i,
      "a document update failure rolls back the earlier graph update in the same transaction",
    );
    const rolledBack = await rowsForAnalysis(db, owner.id, rollback.analysis.id);
    assert.equal(rolledBack.graph.storageLayoutVersion, 1);
    assert.equal(rolledBack.document.storageLayoutVersion, 1);
    assert.equal(rolledBack.graph.nodes, rollback.graph.nodes);
    assert.equal(rolledBack.document.interfaceCatalog, rollback.document.interfaceCatalog);
  } finally {
    if (rollbackConstraint) {
      await db.$executeRawUnsafe(`ALTER TABLE "ArchitectureDocument" DROP CONSTRAINT IF EXISTS "${rollbackConstraint}"`).catch(() => undefined);
    }
    if (ownerIds.length > 0) {
      await db.storageObject.deleteMany({ where: { ownerUserId: { in: ownerIds } } }).catch(() => undefined);
      await db.analysis.deleteMany({ where: { ownerUserId: { in: ownerIds } } }).catch(() => undefined);
      await db.user.deleteMany({ where: { id: { in: ownerIds } } }).catch(() => undefined);
    }
    if (repositoryId) await db.repository.deleteMany({ where: { id: repositoryId } }).catch(() => undefined);
    if (storageRoot) await rm(storageRoot, { recursive: true, force: true }).catch(() => undefined);
    await disconnectDatabase();
  }
});
