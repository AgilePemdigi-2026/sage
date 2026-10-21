import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { canonicalizeCkg } from "@sage/contracts";
import { projectArchitectureDocument } from "@sage/documents/model";
import type { PrismaClient } from "../packages/database/generated/client.ts";
import {
  CanonicalDocumentIntegrityError,
  persistCanonicalDocument,
  readCanonicalDocumentForUser,
} from "../packages/database/src/documents.ts";

const configurationHash = "c".repeat(64);
const ownerUserId = "owner-document-15";
const analysisId = "analysis-document-15";
const claim = {
  jobId: "job-document-15",
  analysisId,
  ownerUserId,
  attempt: 1,
  leaseToken: "11111111-1111-4111-8111-111111111111",
  leaseExpiresAt: new Date("2026-10-21T00:00:00.000Z"),
};

async function fixture() {
  const [source, payload] = await Promise.all([
    readFile(new URL("../packages/contracts/examples/minimum-ccm.source.ts", import.meta.url), "utf8"),
    readFile(new URL("../packages/contracts/examples/minimum-ccm.json", import.meta.url), "utf8"),
  ]);
  const sourceBytes = { "examples/minimum-ccm.source.ts": new TextEncoder().encode(source) };
  const ccm = JSON.parse(payload) as Record<string, unknown>;
  const canonical = canonicalizeCkg(ccm, sourceBytes, configurationHash);
  assert.equal(canonical.ok, true);
  if (!canonical.ok) throw new Error("Canonical test CKG must validate");
  const document = projectArchitectureDocument(canonical.json, sourceBytes, canonical.sha256);
  assert.equal(document.ok, true);
  if (!document.ok) throw new Error("Canonical test document must validate");
  return { sourceBytes, canonical, document };
}

function graphRow(value: Awaited<ReturnType<typeof fixture>>["canonical"]) {
  assert.equal(value.ok, true);
  if (!value.ok) throw new Error("Canonical graph fixture must validate");
  return {
    id: "graph-document-15",
    ownerUserId,
    analysisId,
    schemaVersion: value.value.schemaVersion,
    configurationHash: value.value.configurationHash,
    canonicalContent: value.json,
    nodes: JSON.stringify(value.value.ccm.nodes),
    edges: JSON.stringify(value.value.ccm.edges),
    nodeCount: value.value.counts.nodes,
    edgeCount: value.value.counts.edges,
    contentHash: value.sha256,
  };
}

function documentRow(value: Awaited<ReturnType<typeof fixture>>["document"]) {
  assert.equal(value.ok, true);
  if (!value.ok) throw new Error("Canonical document fixture must validate");
  return {
    id: "document-document-15",
    ownerUserId,
    analysisId,
    title: value.value.title,
    documentModelVersion: value.value.schemaVersion,
    interfaceCatalog: JSON.stringify(value.value.interfaceCatalog),
    softwareEngineeringDiagram: JSON.stringify(value.value.softwareEngineeringDiagram),
    umlClassDiagram: JSON.stringify(value.value.umlClassDiagram),
    canonicalContent: value.json,
    contentHash: value.sha256,
  };
}

function analysisRow(value: Awaited<ReturnType<typeof fixture>>["canonical"]) {
  assert.equal(value.ok, true);
  if (!value.ok) throw new Error("Canonical graph fixture must validate");
  return {
    configurationHash: value.value.configurationHash,
    repositoryFullNameSnapshot: value.value.ccm.snapshot.repository,
    branchName: value.value.ccm.snapshot.branch,
    commitSha: value.value.ccm.snapshot.commitSha,
    status: "RUNNING",
  };
}

function transactionDatabase(
  value: Awaited<ReturnType<typeof fixture>>,
  options: {
    stages?: Array<{ key: string; status: string }>;
    graph?: ReturnType<typeof graphRow> | null;
    existing?: ReturnType<typeof documentRow> | null;
    active?: () => boolean;
    onTransactionStart?: () => void;
    onCreate?: (data: Record<string, unknown>) => void;
  } = {},
): PrismaClient {
  const graph = options.graph === undefined ? graphRow(value.canonical) : options.graph;
  const existing = options.existing === undefined ? null : options.existing;
  const stages = options.stages ?? [
    { key: "KNOWLEDGE_GRAPH", status: "COMPLETED" },
    { key: "INTERFACE_CATALOG", status: "COMPLETED" },
    { key: "SOFTWARE_ENGINEERING_DIAGRAM", status: "COMPLETED" },
    { key: "UML_CLASS_DIAGRAM", status: "COMPLETED" },
    { key: "ARCHITECTURE_DOCUMENT", status: "RUNNING" },
  ];
  const tx = {
    $queryRaw: async (parts: TemplateStringsArray) => {
      if (!parts.join("").includes("SELECT EXISTS")) return [{ slotKey: "analysis" }];
      return [{ active: options.active?.() ?? true }];
    },
    analysis: { findFirst: async () => analysisRow(value.canonical) },
    analysisStage: { findMany: async () => stages },
    graphBundle: { findUnique: async () => graph },
    architectureDocument: {
      findUnique: async () => existing,
      create: async (args: { data: Record<string, unknown> }) => {
        options.onCreate?.(args.data);
        return { id: "created-document", contentHash: String(args.data.contentHash) };
      },
    },
  };
  return {
    $transaction: async (callback: (transaction: typeof tx) => Promise<unknown>) => {
      options.onTransactionStart?.();
      return callback(tx);
    },
  } as unknown as PrismaClient;
}

test("document persistence derives canonical content synchronously and stores string mirrors", async () => {
  const value = await fixture();
  let created: Record<string, unknown> | undefined;
  const db = transactionDatabase(value, {
    onTransactionStart: () => {
      value.sourceBytes["examples/minimum-ccm.source.ts"]![0] ^= 1;
    },
    onCreate: data => { created = data; },
  });
  const result = await persistCanonicalDocument(db, {
    claim,
    canonicalCkgJson: value.canonical.json,
    sourceBytes: value.sourceBytes,
    expectedCkgSha256: value.canonical.sha256,
  });
  assert.deepEqual(result, { id: "created-document", contentHash: value.document.sha256 });
  assert.equal(created?.canonicalContent, value.document.json);
  assert.equal(created?.contentHash, value.document.sha256);
  assert.equal(created?.documentModelVersion, "sage-add-v1");
  assert.equal(created?.interfaceCatalog, JSON.stringify(value.document.value.interfaceCatalog));
  assert.equal(created?.softwareEngineeringDiagram, JSON.stringify(value.document.value.softwareEngineeringDiagram));
  assert.equal(created?.umlClassDiagram, JSON.stringify(value.document.value.umlClassDiagram));
  assert.equal(created?.canonicalContent, value.document.json, "source bytes were copied before asynchronous database work");
});

test("document persistence validates canonical source before opening a transaction", async () => {
  const value = await fixture();
  value.sourceBytes["examples/minimum-ccm.source.ts"]![0] ^= 1;
  let transactions = 0;
  const db = { $transaction: async () => { transactions += 1; } } as unknown as PrismaClient;
  await assert.rejects(persistCanonicalDocument(db, {
    claim,
    canonicalCkgJson: value.canonical.json,
    sourceBytes: value.sourceBytes,
  }), /CKG canonical tidak valid/);
  assert.equal(transactions, 0);
});

test("document persistence requires the exact active lease, final stages and matching full graph", async () => {
  const value = await fixture();
  const staleDb = transactionDatabase(value, { active: () => false });
  assert.equal(await persistCanonicalDocument(staleDb, {
    claim: { ...claim, leaseToken: "22222222-2222-4222-8222-222222222222" },
    canonicalCkgJson: value.canonical.json,
    sourceBytes: value.sourceBytes,
  }), null);

  const wrongStagesDb = transactionDatabase(value, {
    stages: [
      { key: "KNOWLEDGE_GRAPH", status: "COMPLETED" },
      { key: "INTERFACE_CATALOG", status: "COMPLETED" },
      { key: "SOFTWARE_ENGINEERING_DIAGRAM", status: "RUNNING" },
      { key: "UML_CLASS_DIAGRAM", status: "COMPLETED" },
      { key: "ARCHITECTURE_DOCUMENT", status: "RUNNING" },
    ],
  });
  await assert.rejects(persistCanonicalDocument(wrongStagesDb, {
    claim,
    canonicalCkgJson: value.canonical.json,
    sourceBytes: value.sourceBytes,
  }), /tahap architecture document/);

  const badGraph = graphRow(value.canonical);
  badGraph.nodes = "[]";
  const wrongGraphDb = transactionDatabase(value, { graph: badGraph });
  await assert.rejects(persistCanonicalDocument(wrongGraphDb, {
    claim,
    canonicalCkgJson: value.canonical.json,
    sourceBytes: value.sourceBytes,
  }), /Graph bundle/);
});

test("document persistence replays only an identical immutable row and rolls back at final lease fence", async () => {
  const value = await fixture();
  const existing = documentRow(value.document);
  const replayDb = transactionDatabase(value, { existing });
  assert.deepEqual(await persistCanonicalDocument(replayDb, {
    claim,
    canonicalCkgJson: value.canonical.json,
    sourceBytes: value.sourceBytes,
  }), { id: existing.id, contentHash: existing.contentHash });

  const altered = { ...existing, umlClassDiagram: "{}" };
  const conflictDb = transactionDatabase(value, { existing: altered });
  await assert.rejects(persistCanonicalDocument(conflictDb, {
    claim,
    canonicalCkgJson: value.canonical.json,
    sourceBytes: value.sourceBytes,
  }), /immutable/);

  let stored = false;
  let checks = 0;
  const expiringDb = transactionDatabase(value, {
    active: () => ++checks === 1,
    onCreate: () => { stored = true; },
  });
  // The fake transaction mirrors rollback when the final DB-clock lease check throws.
  const originalTransaction = expiringDb.$transaction.bind(expiringDb);
  (expiringDb as unknown as { $transaction: unknown }).$transaction = async (callback: (tx: unknown) => Promise<unknown>) => {
    const before = stored;
    try { return await originalTransaction(callback as never); }
    catch (error) { stored = before; throw error; }
  };
  assert.equal(await persistCanonicalDocument(expiringDb, {
    claim,
    canonicalCkgJson: value.canonical.json,
    sourceBytes: value.sourceBytes,
  }), null);
  assert.equal(checks, 2);
  assert.equal(stored, false);
});

test("published document reads are owner scoped, terminal only and treat legacy canonical rows as absent", async () => {
  const calls: unknown[] = [];
  const db = {
    analysis: { findFirst: async (args: unknown) => { calls.push(args); return { architectureDocument: { canonicalContent: null } }; } },
  } as unknown as PrismaClient;
  assert.equal(await readCanonicalDocumentForUser(db, ownerUserId, analysisId, {}), null);
  assert.deepEqual(calls[0], {
    where: { id: analysisId, ownerUserId, status: { in: ["COMPLETED", "COMPLETED_WITH_LIMITATIONS"] } },
    select: {
      configurationHash: true,
      repositoryFullNameSnapshot: true,
      branchName: true,
      commitSha: true,
      graphBundle: { select: {
        id: true, ownerUserId: true, analysisId: true, schemaVersion: true, configurationHash: true,
        canonicalContent: true, nodes: true, edges: true, nodeCount: true, edgeCount: true, contentHash: true,
      } },
      architectureDocument: { select: {
        id: true, ownerUserId: true, analysisId: true, title: true, documentModelVersion: true,
        interfaceCatalog: true, softwareEngineeringDiagram: true, umlClassDiagram: true,
        canonicalContent: true, contentHash: true,
      } },
    },
  });
});

test("published document reads replay canonical content and reject altered mirrors", async () => {
  const value = await fixture();
  const parent = analysisRow(value.canonical);
  const graph = graphRow(value.canonical);
  const doc = documentRow(value.document);
  let calls = 0;
  const db = {
    analysis: { findFirst: async () => {
      calls += 1;
      if (calls === 1) value.sourceBytes["examples/minimum-ccm.source.ts"]![0] ^= 1;
      return { ...parent, status: "COMPLETED", graphBundle: graph, architectureDocument: doc };
    } },
  } as unknown as PrismaClient;
  const result = await readCanonicalDocumentForUser(db, ownerUserId, analysisId, value.sourceBytes);
  assert.equal(result?.id, doc.id);
  assert.equal(result?.contentHash, doc.contentHash);
  assert.deepEqual(result?.document, value.document.value);

  const badMirror = { ...doc, interfaceCatalog: "{}" };
  const tamperedDb = {
    analysis: { findFirst: async () => ({ ...parent, status: "COMPLETED", graphBundle: graph, architectureDocument: badMirror }) },
  } as unknown as PrismaClient;
  await assert.rejects(readCanonicalDocumentForUser(tamperedDb, ownerUserId, analysisId, await sourceFixture()), CanonicalDocumentIntegrityError);

  const wrongGraph = { ...graph, contentHash: "d".repeat(64) };
  const graphMismatchDb = {
    analysis: { findFirst: async () => ({ ...parent, status: "COMPLETED", graphBundle: wrongGraph, architectureDocument: doc }) },
  } as unknown as PrismaClient;
  await assert.rejects(readCanonicalDocumentForUser(graphMismatchDb, ownerUserId, analysisId, await sourceFixture()), CanonicalDocumentIntegrityError);
});

async function sourceFixture(): Promise<Record<string, Uint8Array>> {
  const source = await readFile(new URL("../packages/contracts/examples/minimum-ccm.source.ts", import.meta.url));
  return { "examples/minimum-ccm.source.ts": new Uint8Array(source) };
}
