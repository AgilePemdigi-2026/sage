import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  appendPresentationRevision,
  canonicalSemanticContent,
  persistAnalysisSemantic,
  readSemanticForUser,
  SemanticModelIntegrityError,
  SemanticPresentationConflictError,
} from "../packages/database/src/semantic.ts";
import type { Prisma, PrismaClient } from "../packages/database/generated/client.ts";
import type { SemanticModel } from "../packages/documents/src/semantic/model.ts";
import { isSemanticModel } from "../packages/documents/src/semantic/validation.ts";

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const sourceFileHash = "b".repeat(64);
const snapshot = { repository: "owner/repo", branch: "main", commitSha: "c".repeat(40) };
const ccm = { snapshot, nodes: [{ id: "ccm-node-1" }], files: [{ path: "src/index.ts", sha256: sourceFileHash }] };
const evidence = [{ filePath: "src/index.ts", fileSha256: sourceFileHash, startByte: 0, endByte: 1, startLine: 1, endLine: 1, startColumn: 1, endColumn: 2, role: "context" as const }];

function model(sourceCkgHash: string): SemanticModel {
  return {
    schemaVersion: "sage-semantic-v1",
    extractorVersion: "test",
    sourceCkgHash,
    snapshot,
    nodes: [
      { id: "feature-1", kind: "feature", label: "Analyze repository", featureId: "feature-1", confidence: "proven", reason: "route", evidence, technicalNodeIds: ["ccm-node-1"] },
      { id: "concept-1", kind: "concept", label: "Repository", featureId: "feature-1", confidence: "indicated", reason: "model", evidence, technicalNodeIds: ["ccm-node-1"] },
      { id: "actor-1", kind: "actor", label: "Developer", featureId: null, confidence: "indicated", reason: "route", evidence, technicalNodeIds: [] },
    ],
    edges: [{ id: "edge-1", source: "actor-1", target: "feature-1", label: "starts", confidence: "proven", reason: "route", evidence }],
    features: [{ id: "feature-1", label: "Analyze repository", entryNodeIds: ["feature-1"], nodeIds: ["feature-1", "concept-1"], edgeIds: ["edge-1"], evidence }],
    frameworks: [],
    limitations: [],
  };
}

function publishedRow(ownerUserId: string, semanticModel: SemanticModel) {
  const graphBundleContent = JSON.stringify({ schemaVersion: "sage-ckg-v1", ccm });
  const graphHash = sha256(graphBundleContent);
  const graphModel = { ...semanticModel, sourceCkgHash: graphHash };
  const semanticContent = JSON.stringify(graphModel);
  return {
    graphBundle: { contentHash: graphHash, canonicalContent: graphBundleContent },
    semanticModel: {
      id: "semantic-row-1",
      modelHash: sha256(semanticContent),
      sourceCkgHash: graphHash,
      schemaVersion: graphModel.schemaVersion,
      extractorVersion: graphModel.extractorVersion,
      canonicalContent: semanticContent,
    },
    presentationRevisions: [],
    ownerUserId,
  };
}

function readDb(ownerUserId: string, row: ReturnType<typeof publishedRow>, latestOverlay?: unknown, latestHash?: string) {
  const currentRow = {
    ...row,
    presentationRevisions: latestOverlay === undefined ? [] : [{
      revision: 1,
      overlay: latestOverlay,
      contentHash: latestHash,
    }],
  };
  return {
    analysis: {
      findFirst: async (args: unknown) => (args as { where: { ownerUserId: string } }).where.ownerUserId === ownerUserId ? currentRow : null,
    },
    presentationRevision: {
      findFirst: async () => latestOverlay === undefined ? null : {
        revision: 1,
        overlay: latestOverlay,
        contentHash: latestHash,
      },
      create: async (args: unknown) => ({ revision: (args as { data: { revision: number } }).data.revision }),
    },
  } as unknown as PrismaClient;
}

test("semantic storage binds the model to the stored CKG, evidence files, and snapshot", () => {
  const graphContent = JSON.stringify({ schemaVersion: "sage-ckg-v1", ccm });
  const graphHash = sha256(graphContent);
  const value = model(graphHash);
  const validationContext = { sourceCkgHash: graphHash, ckgNodeIds: new Set(["ccm-node-1"]), fileHashes: new Map([["src/index.ts", sourceFileHash]]), snapshot };
  assert.equal(isSemanticModel(value, validationContext), true);
  const valid = canonicalSemanticContent(value, graphHash, new Set(["ccm-node-1"]), new Map([["src/index.ts", sourceFileHash]]), snapshot);
  assert.equal(valid.modelHash, sha256(valid.content));
  assert.throws(() => canonicalSemanticContent({ ...value, edges: value.edges.map(edge => ({ ...edge, evidence: [] })) }, graphHash, new Set(["ccm-node-1"]), new Map([["src/index.ts", sourceFileHash]]), snapshot), SemanticModelIntegrityError,
    "relationships without source evidence must not be stored");
  assert.equal(isSemanticModel({ ...value, nodes: value.nodes.map(node => ({ ...node, evidence: node.id === "actor-1" ? [] : node.evidence })) }, validationContext), false,
    "nodes without source evidence must be rejected");
  assert.equal(isSemanticModel({ ...value, features: value.features.map(feature => ({ ...feature, evidence: [] })) }, validationContext), false,
    "features without source evidence must be rejected");
  assert.equal(isSemanticModel({ ...value, nodes: value.nodes.map(node => ({ ...node, label: node.id === "actor-1" ? "  " : node.label })) }, validationContext), false,
    "blank node labels must be rejected");
  assert.equal(isSemanticModel({ ...value, edges: value.edges.map(edge => ({ ...edge, reason: " " })) }, validationContext), false,
    "blank relationship reasons must be rejected");
  assert.throws(() => canonicalSemanticContent(value, "d".repeat(64), new Set(["ccm-node-1"]), new Map([["src/index.ts", sourceFileHash]]), snapshot), SemanticModelIntegrityError);
  assert.throws(() => canonicalSemanticContent(value, graphHash, new Set(), new Map([["src/index.ts", sourceFileHash]]), snapshot), SemanticModelIntegrityError);
});

test("semantic persistence is immutable and idempotent for a repeated verified publication", async () => {
  const graphContent = JSON.stringify({ schemaVersion: "sage-ckg-v1", ccm });
  const graphHash = sha256(graphContent);
  type StoredSemantic = {
    id: string;
    ownerUserId: string;
    analysisId: string;
    sourceCkgHash: string;
    modelHash: string;
    schemaVersion: string;
    extractorVersion: string;
    canonicalContent: string;
  };
  let stored: StoredSemantic | null = null;
  let createCount = 0;
  const tx = {
    semanticModel: {
      findUnique: async () => stored ? {
        id: stored.id,
        sourceCkgHash: stored.sourceCkgHash,
        modelHash: stored.modelHash,
        schemaVersion: stored.schemaVersion,
        extractorVersion: stored.extractorVersion,
        canonicalContent: stored.canonicalContent,
      } : null,
      create: async ({ data }: { data: Omit<StoredSemantic, "id"> }) => {
        createCount += 1;
        stored = { id: "semantic-row-1", ...data };
        return { id: stored.id, modelHash: stored.modelHash };
      },
    },
  } as unknown as Prisma.TransactionClient;
  const input = { ownerUserId: "owner-1", analysisId: "analysis-1", sourceCkgHash: graphHash, ccm, model: model(graphHash) };
  const first = await persistAnalysisSemantic(tx, input);
  const second = await persistAnalysisSemantic(tx, input);
  assert.deepEqual(second, first);
  assert.equal(createCount, 1);
  await assert.rejects(persistAnalysisSemantic(tx, { ...input, model: { ...input.model, extractorVersion: "different" } }), SemanticModelIntegrityError);
});

test("semantic reads are owner-scoped and pinned empty or historic overlays remain stable", async () => {
  const graphHash = sha256(JSON.stringify({ schemaVersion: "sage-ckg-v1", ccm }));
  const row = publishedRow("owner-1", model(graphHash));
  const historicOverlay = { labels: { "concept-1": "Domain concept" }, groups: { "concept-1": "feature-1" } };
  const historicHash = sha256(JSON.stringify(historicOverlay));
  const db = readDb("owner-1", row, historicOverlay, historicHash);
  assert.equal(await readSemanticForUser(db, "different-owner", "analysis-1"), null);
  const latest = await readSemanticForUser(db, "owner-1", "analysis-1");
  assert.equal(latest?.revision, 1);
  const revisionZero = await readSemanticForUser(db, "owner-1", "analysis-1", 0);
  assert.deepEqual(revisionZero?.overlay, { labels: {}, groups: {} });
  const pinned = await readSemanticForUser(db, "owner-1", "analysis-1", 1);
  assert.deepEqual(pinned?.overlay, historicOverlay);
});

test("presentation updates use optimistic revisions and reject stale writers", async () => {
  const graphHash = sha256(JSON.stringify({ schemaVersion: "sage-ckg-v1", ccm }));
  const row = publishedRow("owner-1", model(graphHash));
  const latestOverlay = { labels: {}, groups: {} };
  const latestHash = sha256(JSON.stringify(latestOverlay));
  const base = readDb("owner-1", row, latestOverlay, latestHash) as unknown as {
    analysis: Record<string, unknown>;
    presentationRevision: Record<string, unknown>;
  };
  let created = 0;
  const transactionDb = {
    ...base,
    $transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback({
      ...base,
      $queryRaw: async () => [{ id: "semantic-row-1" }],
      presentationRevision: {
        ...base.presentationRevision,
        create: async (args: unknown) => {
          created += 1;
          return { revision: (args as { data: { revision: number } }).data.revision };
        },
      },
    }),
  } as unknown as PrismaClient;
  await assert.rejects(
    appendPresentationRevision(transactionDb, {
      ownerUserId: "owner-1", analysisId: "analysis-1", expectedRevision: 0, overlay: latestOverlay,
    }),
    SemanticPresentationConflictError,
  );
  assert.equal(created, 0);

  const saved = await appendPresentationRevision(transactionDb, {
    ownerUserId: "owner-1",
    analysisId: "analysis-1",
    expectedRevision: 1,
    overlay: { labels: { "concept-1": "Repository model" }, groups: {} },
  });
  assert.equal(saved.revision, 2);
  assert.equal(created, 1);
});
