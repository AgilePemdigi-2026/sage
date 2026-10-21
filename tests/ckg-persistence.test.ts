import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { canonicalizeCkg } from "@sage/contracts";
import { CanonicalGraphIntegrityError, persistCanonicalGraph, readCanonicalGraphForUser } from "../packages/database/src/graphs.ts";
import type { PrismaClient } from "../packages/database/generated/client.ts";

const configurationHash = "c".repeat(64);
const sourcePath = new URL("../packages/contracts/examples/minimum-ccm.source.ts", import.meta.url);
const payloadPath = new URL("../packages/contracts/examples/minimum-ccm.json", import.meta.url);

async function fixture() {
  const [sourceText, payloadText] = await Promise.all([readFile(sourcePath, "utf8"), readFile(payloadPath, "utf8")]);
  return {
    sourceBytes: { "examples/minimum-ccm.source.ts": new TextEncoder().encode(sourceText) },
    ccm: JSON.parse(payloadText) as unknown,
  };
}

test("CKG persistence rejects invalid source evidence before touching the database", async () => {
  const value = await fixture();
  value.sourceBytes["examples/minimum-ccm.source.ts"][0] ^= 1;
  let transactions = 0;
  const db = { $transaction: async () => { transactions += 1; } } as unknown as PrismaClient;
  await assert.rejects(persistCanonicalGraph(db, {
    claim: {
      jobId: "job-1", analysisId: "analysis-1", ownerUserId: "owner-1", attempt: 1,
      leaseToken: "11111111-1111-4111-8111-111111111111", leaseExpiresAt: new Date(),
    },
    ccm: value.ccm,
    sourceBytes: value.sourceBytes,
    configurationHash,
  }), /CCM tidak valid/);
  assert.equal(transactions, 0);
});

test("published graph reads require owner and terminal analysis status and accept legacy rows as absent", async () => {
  const calls: unknown[] = [];
  const db = {
    analysis: { findFirst: async (args: unknown) => { calls.push(args); return { graphBundle: { canonicalContent: null } }; } },
  } as unknown as PrismaClient;
  assert.equal(await readCanonicalGraphForUser(db, "owner-1", "analysis-1", {}), null);
  assert.deepEqual(calls[0], {
    where: { id: "analysis-1", ownerUserId: "owner-1", status: { in: ["COMPLETED", "COMPLETED_WITH_LIMITATIONS"] } },
    select: {
      configurationHash: true,
      branchName: true,
      commitSha: true,
      repository: { select: { fullName: true } },
      graphBundle: { select: {
        id: true, schemaVersion: true, configurationHash: true, canonicalContent: true,
        nodes: true, edges: true, nodeCount: true, edgeCount: true, contentHash: true,
      } },
    },
  });
});

test("published graph read verifies canonical content, source evidence and mirrored columns", async () => {
  const value = await fixture();
  const canonical = canonicalizeCkg(value.ccm, value.sourceBytes, configurationHash);
  assert.equal(canonical.ok, true);
  if (!canonical.ok) return;
  const parent = {
    configurationHash,
    branchName: canonical.value.ccm.snapshot.branch,
    commitSha: canonical.value.ccm.snapshot.commitSha,
    repository: { fullName: canonical.value.ccm.snapshot.repository },
  };
  const db = {
    analysis: { findFirst: async () => ({ ...parent, graphBundle: {
      id: "graph-1", schemaVersion: canonical.value.schemaVersion,
      configurationHash: canonical.value.configurationHash, canonicalContent: canonical.json,
      nodes: canonical.value.ccm.nodes, edges: canonical.value.ccm.edges,
      nodeCount: canonical.value.counts.nodes, edgeCount: canonical.value.counts.edges,
      contentHash: canonical.sha256,
    } }) },
  } as unknown as PrismaClient;
  const result = await readCanonicalGraphForUser(db, "owner-1", "analysis-1", value.sourceBytes);
  assert.deepEqual(result, { id: "graph-1", contentHash: canonical.sha256, graph: canonical.value });

  const tamperedDb = {
    analysis: { findFirst: async () => ({ ...parent, graphBundle: {
      id: "graph-1", schemaVersion: canonical.value.schemaVersion,
      configurationHash: canonical.value.configurationHash, canonicalContent: canonical.json,
      nodes: [], edges: canonical.value.ccm.edges,
      nodeCount: canonical.value.counts.nodes, edgeCount: canonical.value.counts.edges,
      contentHash: canonical.sha256,
    } }) },
  } as unknown as PrismaClient;
  await assert.rejects(readCanonicalGraphForUser(tamperedDb, "owner-1", "analysis-1", value.sourceBytes), CanonicalGraphIntegrityError);

  for (const mismatch of [
    { ...parent, configurationHash: "d".repeat(64) },
    { ...parent, branchName: "different-branch" },
    { ...parent, commitSha: "e".repeat(40) },
    { ...parent, repository: { fullName: "different/repository" } },
  ]) {
    const parentMismatchDb = {
      analysis: { findFirst: async () => ({
        ...mismatch,
        graphBundle: {
          id: "graph-1", schemaVersion: canonical.value.schemaVersion,
          configurationHash: canonical.value.configurationHash, canonicalContent: canonical.json,
          nodes: canonical.value.ccm.nodes, edges: canonical.value.ccm.edges,
          nodeCount: canonical.value.counts.nodes, edgeCount: canonical.value.counts.edges,
          contentHash: canonical.sha256,
        },
      }) },
    } as unknown as PrismaClient;
    await assert.rejects(readCanonicalGraphForUser(parentMismatchDb, "owner-1", "analysis-1", value.sourceBytes), CanonicalGraphIntegrityError);
  }

  const mutableSource = await fixture();
  const raceDb = {
    analysis: { findFirst: async () => {
      mutableSource.sourceBytes["examples/minimum-ccm.source.ts"][0] ^= 1;
      return { ...parent, graphBundle: {
        id: "graph-1", schemaVersion: canonical.value.schemaVersion,
        configurationHash: canonical.value.configurationHash, canonicalContent: canonical.json,
        nodes: canonical.value.ccm.nodes, edges: canonical.value.ccm.edges,
        nodeCount: canonical.value.counts.nodes, edgeCount: canonical.value.counts.edges,
        contentHash: canonical.sha256,
      } };
    } },
  } as unknown as PrismaClient;
  assert.equal((await readCanonicalGraphForUser(raceDb, "owner-1", "analysis-1", mutableSource.sourceBytes))?.contentHash, canonical.sha256,
    "source bytes are copied before the asynchronous database read");
});

test("immutable graph replay rejects a database row with tampered mirrors", async () => {
  const value = await fixture();
  const canonical = canonicalizeCkg(value.ccm, value.sourceBytes, configurationHash);
  assert.equal(canonical.ok, true);
  if (!canonical.ok) return;
  const claim = {
    jobId: "job-1", analysisId: "analysis-1", ownerUserId: "owner-1", attempt: 1,
    leaseToken: "11111111-1111-4111-8111-111111111111", leaseExpiresAt: new Date(),
  };
  const existing = {
    id: "graph-1",
    schemaVersion: canonical.value.schemaVersion,
    configurationHash,
    canonicalContent: canonical.json,
    nodes: [], // Deliberately inconsistent with the canonical content.
    edges: canonical.value.ccm.edges,
    nodeCount: canonical.value.counts.nodes,
    edgeCount: canonical.value.counts.edges,
    contentHash: canonical.sha256,
  };
  let created = 0;
  const tx = {
    $queryRaw: async (parts: TemplateStringsArray) => parts.join("").includes("SELECT EXISTS") ? [{ active: true }] : [{ slotKey: "analysis" }],
    analysis: { findFirst: async () => ({
      configurationHash,
      branchName: canonical.value.ccm.snapshot.branch,
      commitSha: canonical.value.ccm.snapshot.commitSha,
      status: "RUNNING",
      repository: { fullName: canonical.value.ccm.snapshot.repository },
    }) },
    analysisStage: { findMany: async () => [
      { key: "COMMON_CODE_MODEL", status: "COMPLETED" },
      { key: "KNOWLEDGE_GRAPH", status: "RUNNING" },
    ] },
    graphBundle: {
      findUnique: async () => existing,
      create: async () => { created += 1; throw new Error("Must not create a second bundle."); },
    },
  };
  const db = { $transaction: async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx) } as unknown as PrismaClient;
  await assert.rejects(persistCanonicalGraph(db, {
    claim, ccm: value.ccm, sourceBytes: value.sourceBytes, configurationHash,
  }), /immutable/);
  assert.equal(created, 0);
});

test("expired lease at the final fence rolls back a newly written graph", async () => {
  const value = await fixture();
  const canonical = canonicalizeCkg(value.ccm, value.sourceBytes, configurationHash);
  assert.equal(canonical.ok, true);
  if (!canonical.ok) return;
  const claim = {
    jobId: "job-1", analysisId: "analysis-1", ownerUserId: "owner-1", attempt: 1,
    leaseToken: "33333333-3333-4333-8333-333333333333", leaseExpiresAt: new Date(),
  };
  let activeChecks = 0;
  let graphStored = false;
  const tx = {
    $queryRaw: async (parts: TemplateStringsArray) => {
      if (!parts.join("").includes("SELECT EXISTS")) return [{ slotKey: "analysis" }];
      activeChecks += 1;
      return [{ active: activeChecks === 1 }];
    },
    analysis: { findFirst: async () => ({
      configurationHash,
      branchName: canonical.value.ccm.snapshot.branch,
      commitSha: canonical.value.ccm.snapshot.commitSha,
      status: "RUNNING",
      repository: { fullName: canonical.value.ccm.snapshot.repository },
    }) },
    analysisStage: { findMany: async () => [
      { key: "COMMON_CODE_MODEL", status: "COMPLETED" },
      { key: "KNOWLEDGE_GRAPH", status: "RUNNING" },
    ] },
    graphBundle: {
      findUnique: async () => null,
      create: async () => {
        graphStored = true;
        return { id: "graph-1", contentHash: canonical.sha256 };
      },
    },
  };
  const db = {
    $transaction: async (callback: (transaction: typeof tx) => Promise<unknown>) => {
      const before = graphStored;
      try {
        return await callback(tx);
      } catch (error) {
        // Mirrors Prisma transaction rollback for the persistence callback under test.
        graphStored = before;
        throw error;
      }
    },
  } as unknown as PrismaClient;

  const result = await persistCanonicalGraph(db, {
    claim, ccm: value.ccm, sourceBytes: value.sourceBytes, configurationHash,
  });
  assert.equal(activeChecks, 2, "lease is checked both before and after persistence");
  assert.equal(result, null, "expired lease is reported as lost");
  assert.equal(graphStored, false, "failed final fence aborts the transaction write");
});

test("graph read rejects empty owner and analysis identifiers before querying", async () => {
  const db = {} as PrismaClient;
  await assert.rejects(readCanonicalGraphForUser(db, " ", "analysis-1", {}), /Pemilik analisis wajib diisi/);
  await assert.rejects(readCanonicalGraphForUser(db, "owner-1", " ", {}), /ID analisis wajib diisi/);
});
