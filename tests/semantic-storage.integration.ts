import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import {
  appendPresentationRevision,
  database,
  disconnectDatabase,
  enqueueExport,
  ExportDocumentChangedError,
  persistAnalysisSemantic,
  readSemanticForUser,
  SemanticModelIntegrityError,
  SemanticPresentationConflictError,
} from "../packages/database/src/index.ts";
import { semanticRendererVersion } from "../packages/documents/src/semantic/export-pin.ts";
import { buildSemanticModel } from "../packages/documents/src/semantic/build.ts";
import { analyzeReferences } from "@sage/analyzer-js";
import { canonicalizeCkg } from "@sage/contracts";
import type { SemanticModel } from "../packages/documents/src/semantic/model.ts";

const hash = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const enabled = process.env.SAGE_SEMANTIC_STORAGE_TESTS === "1";
const sourceFileHash = "a".repeat(64);
const fixtureEvidence = [{ filePath: "src/index.ts", fileSha256: sourceFileHash, startByte: 0, endByte: 1, startLine: 1, endLine: 1, startColumn: 1, endColumn: 2, role: "context" as const }];

async function waitForBlockedQuery(db: ReturnType<typeof database>, matches: (query: string) => boolean, description: string): Promise<string> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const rows = await db.$queryRaw<Array<{ query: string }>>`
      SELECT query FROM pg_stat_activity
      WHERE datname = current_database() AND pid <> pg_backend_pid() AND wait_event_type = 'Lock'`;
    const blocked = rows.find(row => matches(row.query));
    if (blocked) return blocked.query;
    await new Promise<void>(resolve => setTimeout(resolve, 15));
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

function assertIsolatedSemanticDatabase(): void {
  if (!enabled) throw new Error("Set SAGE_SEMANTIC_STORAGE_TESTS=1 to run the isolated semantic-storage integration test.");
  const rawUrl = process.env.DATABASE_URL;
  if (!rawUrl) throw new Error("DATABASE_URL is required for semantic-storage integration tests.");
  let databaseName: string;
  try { databaseName = decodeURIComponent(new URL(rawUrl).pathname.slice(1)); }
  catch { throw new Error("DATABASE_URL is invalid; it was not logged."); }
  if (databaseName !== "sage_semantic_export_20261030") {
    throw new Error("Semantic-storage integration tests only allow the isolated sage_semantic_export_20261030 database.");
  }
}

function createModel(sourceCkgHash: string, snapshot: SemanticModel["snapshot"]): SemanticModel {
  return {
    schemaVersion: "sage-semantic-v1",
    extractorVersion: "integration-v1",
    sourceCkgHash,
    snapshot,
    nodes: [
      { id: "actor-1", kind: "actor", label: "Developer", featureId: null, confidence: "proven", reason: "route actor", evidence: fixtureEvidence, technicalNodeIds: [] },
      { id: "feature-1", kind: "feature", label: "Analyze repository", featureId: "feature-1", confidence: "proven", reason: "route entry", evidence: fixtureEvidence, technicalNodeIds: ["ccm-node-1"] },
      { id: "concept-1", kind: "concept", label: "Repository", featureId: "feature-1", confidence: "indicated", reason: "schema context", evidence: fixtureEvidence, technicalNodeIds: ["ccm-node-1"] },
    ],
    edges: [{ id: "edge-1", source: "actor-1", target: "feature-1", label: "starts", confidence: "proven", reason: "explicit route", evidence: fixtureEvidence }],
    features: [{ id: "feature-1", label: "Analyze repository", entryNodeIds: ["feature-1"], nodeIds: ["feature-1", "concept-1"], edgeIds: ["edge-1"], evidence: fixtureEvidence }],
    frameworks: ["nextjs"],
    limitations: [],
  };
}

test("semantic DB revisions serialize edits and exports without lock-order deadlocks", { skip: !enabled }, async () => {
  assertIsolatedSemanticDatabase();
  const db = database();
  const suffix = randomUUID().replaceAll("-", "");
  let ownerId = "";
  let repositoryId = "";
  let analysisId = "";
  try {
    const user = await db.user.create({
      data: { githubUserId: "semantic-" + suffix, login: "semantic-" + suffix },
      select: { id: true },
    });
    ownerId = user.id;
    const repository = await db.repository.create({
      data: {
        githubRepositoryId: "semantic-repository-" + suffix,
        ownerLogin: "semantic-" + suffix,
        name: "fixture",
        fullName: "semantic-" + suffix + "/fixture",
        visibility: "PRIVATE",
      },
      select: { id: true },
    });
    repositoryId = repository.id;
    const snapshot = {
      repository: "semantic-" + suffix + "/fixture",
      branch: "main",
      commitSha: "d".repeat(40),
    };
    const configurationHash = "e".repeat(64);
    const analysis = await db.analysis.create({
      data: {
        ownerUserId: ownerId,
        repositoryId,
        repositoryFullNameSnapshot: snapshot.repository,
        branchName: snapshot.branch,
        commitSha: snapshot.commitSha,
        configuration: { sourcePolicyVersion: "integration-v1" },
        configurationHash,
        analyzerVersion: "semantic-storage-integration-v1",
        schemaVersion: "1",
        status: "COMPLETED",
        resultHash: "f".repeat(64),
        completedAt: new Date(),
      },
      select: { id: true },
    });
    analysisId = analysis.id;

    const ccm = {
      snapshot,
      nodes: [{ id: "ccm-node-1" }],
      files: [{ path: "src/index.ts", sha256: sourceFileHash }],
    };
    const graphContent = JSON.stringify({ schemaVersion: "sage-ckg-v1", ccm });
    const sourceCkgHash = hash(graphContent);
    const semantic = createModel(sourceCkgHash, snapshot);
    await db.graphBundle.create({
      data: {
        ownerUserId: ownerId,
        analysisId,
        schemaVersion: "sage-ckg-v1",
        configurationHash,
        storageLayoutVersion: 2,
        canonicalContent: graphContent,
        nodeCount: ccm.nodes.length,
        edgeCount: 0,
        contentHash: sourceCkgHash,
      },
    });
    const documentHash = hash("{}");
    await db.architectureDocument.create({
      data: {
        ownerUserId: ownerId,
        analysisId,
        title: "Semantic integration fixture",
        documentModelVersion: "integration-v1",
        storageLayoutVersion: 2,
        canonicalContent: "{}",
        contentHash: documentHash,
      },
    });

    await assert.rejects(db.$transaction(tx => persistAnalysisSemantic(tx, {
      ownerUserId: ownerId,
      analysisId,
      sourceCkgHash,
      ccm,
      model: { ...semantic, edges: semantic.edges.map(edge => ({ ...edge, evidence: [] })) },
    })), SemanticModelIntegrityError, "the storage path must reject a relationship without source evidence");

    const firstPersist = await db.$transaction(tx => persistAnalysisSemantic(tx, {
      ownerUserId: ownerId, analysisId, sourceCkgHash, ccm, model: semantic,
    }));
    const secondPersist = await db.$transaction(tx => persistAnalysisSemantic(tx, {
      ownerUserId: ownerId, analysisId, sourceCkgHash, ccm, model: semantic,
    }));
    assert.deepEqual(secondPersist, firstPersist, "replaying identical publication must not duplicate the model");

    const initialRead = await readSemanticForUser(db, ownerId, analysisId);
    assert.ok(initialRead);
    assert.equal(initialRead.revision, 0);
    assert.equal(await readSemanticForUser(db, "some-other-owner", analysisId), null);

    const revisionZeroRenderer = semanticRendererVersion("integration-v1", firstPersist.modelHash, 0);
    const exportRevisionZero = await enqueueExport(db, {
      ownerUserId: ownerId,
      analysisId,
      format: "MARKDOWN",
      documentHash,
      rendererVersion: revisionZeroRenderer,
      semanticModelHash: firstPersist.modelHash,
      presentationRevision: 0,
    });
    assert.equal(exportRevisionZero.created, true);
    const exportZeroRow = await db.export.findUniqueOrThrow({ where: { id: exportRevisionZero.export.id } });
    assert.equal(exportZeroRow.semanticModelHash, firstPersist.modelHash);
    assert.equal(exportZeroRow.presentationRevision, 0);

    const firstRevision = await appendPresentationRevision(db, {
      ownerUserId: ownerId,
      analysisId,
      expectedRevision: 0,
      overlay: { labels: { "concept-1": "Repository concept" }, groups: { "concept-1": "feature-1" } },
    });
    assert.equal(firstRevision.revision, 1);
    const historicExportSemantic = await readSemanticForUser(db, ownerId, analysisId, exportZeroRow.presentationRevision ?? undefined);
    assert.equal(historicExportSemantic?.revision, 0);
    assert.deepEqual(historicExportSemantic?.overlay, { labels: {}, groups: {} });

    await assert.rejects(enqueueExport(db, {
      ownerUserId: ownerId,
      analysisId,
      format: "MARKDOWN",
      documentHash,
      rendererVersion: revisionZeroRenderer,
      semanticModelHash: firstPersist.modelHash,
      presentationRevision: 0,
    }), ExportDocumentChangedError, "an export request with an outdated latest revision must be rejected");

    const revisionOneRenderer = semanticRendererVersion("integration-v1", firstPersist.modelHash, 1);
    assert.notEqual(revisionOneRenderer, revisionZeroRenderer);
    const exportRevisionOne = await enqueueExport(db, {
      ownerUserId: ownerId,
      analysisId,
      format: "MARKDOWN",
      documentHash,
      rendererVersion: revisionOneRenderer,
      semanticModelHash: firstPersist.modelHash,
      presentationRevision: 1,
    });
    assert.equal(exportRevisionOne.created, true, "a semantic revision gets a separate export cache identity");
    const exportOneRow = await db.export.findUniqueOrThrow({ where: { id: exportRevisionOne.export.id } });
    assert.equal(exportOneRow.semanticModelHash, firstPersist.modelHash);
    assert.equal(exportOneRow.presentationRevision, 1);
    assert.notEqual(exportZeroRow.rendererVersion, exportOneRow.rendererVersion);

    const updates = await Promise.allSettled(["Repository model A", "Repository model B"].map(label =>
      appendPresentationRevision(db, {
        ownerUserId: ownerId,
        analysisId,
        expectedRevision: 1,
        overlay: { labels: { "concept-1": label }, groups: { "concept-1": "feature-1" } },
      }),
    ));
    assert.equal(updates.filter(result => result.status === "fulfilled").length, 1, "only one writer may append for the current revision");
    assert.equal(updates.filter(result => result.status === "rejected" && result.reason instanceof SemanticPresentationConflictError).length, 1,
      "the concurrent stale writer must receive an optimistic conflict");

    const historical = await readSemanticForUser(db, ownerId, analysisId, 1);
    assert.equal(historical?.revision, 1);
    assert.equal(historical?.overlay.labels["concept-1"], "Repository concept");
    const current = await readSemanticForUser(db, ownerId, analysisId);
    assert.equal(current?.revision, 2);
    assert.ok(["Repository model A", "Repository model B"].includes(current?.overlay.labels["concept-1"] ?? ""));
    await assert.rejects(appendPresentationRevision(db, {
      ownerUserId: ownerId,
      analysisId,
      expectedRevision: 2,
      overlay: { labels: { "missing-node": "Unknown" }, groups: {} },
    }));

    // Hold Analysis first, queue export's Analysis lock, then start a correction.
    // This forces both operations through the lock-order boundary at the same time.
    let releaseAnalysis!: () => void;
    let acquiredAnalysis!: () => void;
    const analysisAcquired = new Promise<void>(resolve => { acquiredAnalysis = resolve; });
    const releaseBarrier = new Promise<void>(resolve => { releaseAnalysis = resolve; });
    const holder = db.$transaction(async tx => {
      const rows = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "Analysis" WHERE "id" = ${analysisId} AND "ownerUserId" = ${ownerId} FOR UPDATE`;
      assert.equal(rows.length, 1);
      acquiredAnalysis();
      await releaseBarrier;
    });
    let exportRequest: ReturnType<typeof enqueueExport> | undefined;
    let correctionRequest: ReturnType<typeof appendPresentationRevision> | undefined;
    try {
      await analysisAcquired;
      exportRequest = enqueueExport(db, {
        ownerUserId: ownerId,
        analysisId,
        format: "MARKDOWN",
        documentHash,
        rendererVersion: semanticRendererVersion("integration-v1", firstPersist.modelHash, 2),
        semanticModelHash: firstPersist.modelHash,
        presentationRevision: 2,
      });
      await waitForBlockedQuery(db, query => query.includes('JOIN "ArchitectureDocument" AS document'), "export to queue on the analysis lock");
      correctionRequest = appendPresentationRevision(db, {
        ownerUserId: ownerId,
        analysisId,
        expectedRevision: 2,
        overlay: { labels: { "concept-1": "Repository model concurrent" }, groups: { "concept-1": "feature-1" } },
      });
      const correctionLockWait = await waitForBlockedQuery(db,
        query => query.includes("semantic-revision-analysis-lock") || query.includes('INSERT INTO "PresentationRevision"'),
        "correction to queue before taking the semantic-model lock");
      releaseAnalysis();
      await holder;
      const [exportResult, correctionResult] = await Promise.allSettled([exportRequest, correctionRequest]);
      assert.equal(correctionLockWait.includes("semantic-revision-analysis-lock"), true,
        "correction must wait on Analysis before it can lock SemanticModel or insert a revision");
      assert.equal(correctionResult.status, "fulfilled", "correction must finish without a lock-order deadlock");
      if (exportResult.status === "fulfilled") {
        assert.equal(exportResult.value.created, true);
        const concurrentExport = await db.export.findUniqueOrThrow({ where: { id: exportResult.value.export.id } });
        assert.equal(concurrentExport.semanticModelHash, firstPersist.modelHash);
        assert.equal(concurrentExport.presentationRevision, 2);
      } else {
        assert.ok(exportResult.reason instanceof ExportDocumentChangedError,
          "an export that loses the race may only be rejected as a stale pin");
      }
      const afterConcurrentOperations = await readSemanticForUser(db, ownerId, analysisId);
      assert.equal(afterConcurrentOperations?.revision, 3);
    } finally {
      releaseAnalysis();
      await holder.catch(() => undefined);
      if (exportRequest && correctionRequest) await Promise.allSettled([exportRequest, correctionRequest]);
      else if (exportRequest) await Promise.allSettled([exportRequest]);
      else if (correctionRequest) await Promise.allSettled([correctionRequest]);
    }
  } finally {
    if (ownerId && analysisId) {
      await db.job.deleteMany({ where: { ownerUserId: ownerId, analysisId } });
      await db.export.deleteMany({ where: { ownerUserId: ownerId, analysisId } });
      await db.analysis.deleteMany({ where: { ownerUserId: ownerId, id: analysisId } });
    }
    if (ownerId) await db.user.deleteMany({ where: { id: ownerId } });
    if (repositoryId) await db.repository.deleteMany({ where: { id: repositoryId } });
    await disconnectDatabase();
  }
});

test("semantic v2 publication persists Markdown context and rejects documentation evidence tampering", { skip: !enabled }, async () => {
  assertIsolatedSemanticDatabase();
  const db = database();
  const suffix = randomUUID().replaceAll("-", "");
  let ownerId = "";
  let otherId = "";
  let repositoryId = "";
  let analysisId = "";
  try {
    const user = await db.user.create({
      data: { githubUserId: `semantic-v2-${suffix}`, login: `semantic-v2-${suffix}` },
      select: { id: true },
    });
    ownerId = user.id;
    const other = await db.user.create({
      data: { githubUserId: `semantic-v2-other-${suffix}`, login: `semantic-v2-other-${suffix}` },
      select: { id: true },
    });
    otherId = other.id;
    const repository = await db.repository.create({
      data: {
        githubRepositoryId: `semantic-v2-repository-${suffix}`,
        ownerLogin: `semantic-v2-${suffix}`,
        name: "fixture",
        fullName: `semantic-v2-${suffix}/fixture`,
        visibility: "PRIVATE",
      },
      select: { id: true },
    });
    repositoryId = repository.id;

    const snapshot = { repository: `semantic-v2-${suffix}/fixture`, branch: "main", commitSha: "c".repeat(40) };
    const source: Record<string, Uint8Array> = {
      "src/app/api/items/route.ts": new TextEncoder().encode("export async function GET() { return Response.json({ items: [] }); }\n"),
      "README.md": new TextEncoder().encode("# Semantic fixture\n\nThe API route is documented for maintainers.\n\n[Items handler](src/app/api/items/route.ts)\n"),
    };
    const configurationHash = hash(`semantic v2 integration ${suffix}`);
    const analysisResult = analyzeReferences({ snapshot, sources: source });
    assert.ok(analysisResult.ccm, "static fixture source should produce a CCM snapshot");
    const canonical = canonicalizeCkg(analysisResult.ccm, source, configurationHash);
    assert.ok(canonical.ok, "source and excluded README should canonicalize into the pinned CKG");
    const ccm = canonical.value.ccm;
    const readme = ccm.files.find(file => file.path === "README.md");
    assert.ok(readme);
    assert.equal(readme.status, "excluded", "Markdown remains excluded from code analysis while its snapshot hash is retained");
    const model = buildSemanticModel({
      ccm,
      sourceCkgHash: canonical.sha256,
      sources: source,
      documentationSources: source,
      snapshotPaths: Object.keys(source),
    });
    assert.equal(model.schemaVersion, "sage-semantic-v2");
    assert.ok(model.edges.length > 0, "the semantic model should contain source-derived relationships");
    assert.ok(model.edges.every(edge => !!edge.explanation), "every v2 relationship should carry its structured explanation");
    const documentation = model.documentation!.documents.find(document => document.filePath === "README.md");
    assert.ok(documentation, "the v2 publication should include the parsed Markdown file");
    assert.equal(documentation.fileSha256, readme.sha256, "documentation is bound to the excluded snapshot file hash");
    const reference = model.documentation!.references.find(item => item.sourcePath === "README.md");
    assert.ok(reference);
    assert.equal(reference.evidence.fileSha256, readme.sha256, "the documentation link evidence uses the same snapshot hash");
    assert.equal(reference.targetPath, "src/app/api/items/route.ts");

    const analysis = await db.analysis.create({
      data: {
        ownerUserId: ownerId,
        repositoryId,
        repositoryFullNameSnapshot: snapshot.repository,
        branchName: snapshot.branch,
        commitSha: snapshot.commitSha,
        configuration: { sourcePolicyVersion: "semantic-v2-integration" },
        configurationHash,
        analyzerVersion: "semantic-v2-storage-integration",
        schemaVersion: "1",
        status: "COMPLETED",
        resultHash: canonical.sha256,
        completedAt: new Date(),
      },
      select: { id: true },
    });
    analysisId = analysis.id;
    await db.graphBundle.create({
      data: {
        ownerUserId: ownerId,
        analysisId,
        schemaVersion: canonical.value.schemaVersion,
        configurationHash,
        storageLayoutVersion: 2,
        canonicalContent: canonical.json,
        nodeCount: canonical.value.counts.nodes,
        edgeCount: canonical.value.counts.edges,
        contentHash: canonical.sha256,
      },
    });
    const documentHash = hash("semantic v2 integration architecture document");
    await db.architectureDocument.create({
      data: {
        ownerUserId: ownerId,
        analysisId,
        title: "Semantic v2 integration fixture",
        documentModelVersion: "integration-v1",
        storageLayoutVersion: 2,
        canonicalContent: "{}",
        contentHash: documentHash,
      },
    });

    const persisted = await db.$transaction(tx => persistAnalysisSemantic(tx, {
      ownerUserId: ownerId, analysisId, sourceCkgHash: canonical.sha256, ccm, model,
    }));
    const published = await readSemanticForUser(db, ownerId, analysisId);
    assert.ok(published);
    assert.equal(published.modelHash, persisted.modelHash);
    assert.deepEqual(published.model, model, "a stored v2 publication round-trips documentation and explanations without rewriting");
    assert.equal(await readSemanticForUser(db, other.id, analysisId), null, "the v2 publication remains owner scoped");

    const invalidModel = structuredClone(model);
    invalidModel.documentation!.documents[0]!.fileSha256 = "f".repeat(64);
    await assert.rejects(db.$transaction(tx => persistAnalysisSemantic(tx, {
      ownerUserId: ownerId, analysisId, sourceCkgHash: canonical.sha256, ccm, model: invalidModel,
    })), SemanticModelIntegrityError, "publication must reject documentation bytes that do not match the snapshot file hash");

    const tampered = structuredClone(model);
    tampered.documentation!.documents[0]!.fileSha256 = "f".repeat(64);
    await db.semanticModel.update({
      where: { analysisId_ownerUserId: { analysisId, ownerUserId: ownerId } },
      data: { canonicalContent: JSON.stringify(tampered) },
    });
    await assert.rejects(readSemanticForUser(db, ownerId, analysisId), SemanticModelIntegrityError,
      "reads must reject stored documentation whose evidence hash no longer matches the pinned CKG");
  } finally {
    if (ownerId && analysisId) {
      await db.job.deleteMany({ where: { ownerUserId: ownerId, analysisId } }).catch(() => undefined);
      await db.export.deleteMany({ where: { ownerUserId: ownerId, analysisId } }).catch(() => undefined);
      await db.analysis.deleteMany({ where: { ownerUserId: ownerId, id: analysisId } }).catch(() => undefined);
    }
    if (otherId) await db.user.deleteMany({ where: { id: otherId } }).catch(() => undefined);
    if (ownerId) await db.user.deleteMany({ where: { id: ownerId } }).catch(() => undefined);
    if (repositoryId) await db.repository.deleteMany({ where: { id: repositoryId } }).catch(() => undefined);
    await disconnectDatabase();
  }
});
