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
import type { SemanticModel } from "../packages/documents/src/semantic/model.ts";

const hash = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const enabled = process.env.SAGE_SEMANTIC_STORAGE_TESTS === "1";
const sourceFileHash = "a".repeat(64);
const fixtureEvidence = [{ filePath: "src/index.ts", fileSha256: sourceFileHash, startByte: 0, endByte: 1, startLine: 1, endLine: 1, startColumn: 1, endColumn: 2, role: "context" as const }];

function assertIsolatedSemanticDatabase(): void {
  if (!enabled) throw new Error("Set SAGE_SEMANTIC_STORAGE_TESTS=1 to run the isolated semantic-storage integration test.");
  const rawUrl = process.env.DATABASE_URL;
  if (!rawUrl) throw new Error("DATABASE_URL is required for semantic-storage integration tests.");
  let databaseName: string;
  try { databaseName = decodeURIComponent(new URL(rawUrl).pathname.slice(1)); }
  catch { throw new Error("DATABASE_URL is invalid; it was not logged."); }
  if (databaseName !== "sage_semantic_storage_20261030") {
    throw new Error("Semantic-storage integration tests only allow the isolated sage_semantic_storage_20261030 database.");
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

test("semantic DB revisions serialize concurrent edits and keep exports pinned to immutable history", { skip: !enabled }, async () => {
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
