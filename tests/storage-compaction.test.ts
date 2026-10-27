import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { analyzeReferences } from "@sage/analyzer-js";
import { canonicalizeCkg } from "@sage/contracts";
import { projectArchitectureDocument } from "@sage/documents/model";
import { compactAnalysisStorage, inspectCanonicalStorage } from "../packages/database/src/storage-compaction.ts";
import type { PrismaClient } from "../packages/database/generated/client.ts";

const sourcePath = "examples/minimum-ccm.source.ts";
const configurationHash = "c".repeat(64);
const target = {
  id: "analysis_fixture01",
  ownerUserId: "owner_fixture01",
  configurationHash,
  repositoryFullNameSnapshot: "fixture/storage-compaction",
  branchName: "main",
  commitSha: "d".repeat(40),
};

async function fixture() {
  const sourceBytes = new Uint8Array(await readFile(new URL("../packages/contracts/examples/minimum-ccm.source.ts", import.meta.url)));
  const analyzed = await analyzeReferences({
    snapshot: {
      repository: target.repositoryFullNameSnapshot!,
      branch: target.branchName,
      commitSha: target.commitSha,
    },
    sources: { [sourcePath]: sourceBytes },
  });
  assert.ok(analyzed.ccm, `Fixture analyzer failed: ${analyzed.errorCode}`);
  const graph = canonicalizeCkg(analyzed.ccm, { [sourcePath]: sourceBytes }, configurationHash);
  assert.ok(graph.ok, graph.ok ? undefined : `Fixture CKG failed: ${graph.errorCode}`);
  const document = projectArchitectureDocument(graph.json, { [sourcePath]: sourceBytes }, graph.sha256);
  assert.ok(document.ok, document.ok ? undefined : `Fixture ADD failed: ${document.errorCode}`);

  const graphRow = {
    id: "graph_fixture01",
    ownerUserId: target.ownerUserId,
    analysisId: target.id,
    storageLayoutVersion: 1,
    canonicalContent: graph.json,
    contentHash: graph.sha256,
    schemaVersion: graph.value.schemaVersion,
    configurationHash: graph.value.configurationHash,
    nodes: JSON.stringify(graph.value.ccm.nodes),
    edges: JSON.stringify(graph.value.ccm.edges),
    nodeCount: graph.value.counts.nodes,
    edgeCount: graph.value.counts.edges,
  };
  const documentRow = {
    id: "document_fixture01",
    ownerUserId: target.ownerUserId,
    analysisId: target.id,
    storageLayoutVersion: 1,
    canonicalContent: document.json,
    contentHash: document.sha256,
    title: document.value.title,
    documentModelVersion: document.value.schemaVersion,
    interfaceCatalog: JSON.stringify(document.value.interfaceCatalog),
    softwareEngineeringDiagram: JSON.stringify(document.value.softwareEngineeringDiagram),
    umlClassDiagram: JSON.stringify(document.value.umlClassDiagram),
  };
  return { graph, document, graphRow, documentRow };
}

test("canonical storage inspection measures valid legacy mirrors without changing payloads", async () => {
  const value = await fixture();
  const expectedMirrorBytes = [
    value.graphRow.nodes,
    value.graphRow.edges,
    value.documentRow.interfaceCatalog,
    value.documentRow.softwareEngineeringDiagram,
    value.documentRow.umlClassDiagram,
  ].reduce((sum, mirror) => sum + Buffer.byteLength(mirror, "utf8"), 0);

  const result = inspectCanonicalStorage(target, value.graphRow, value.documentRow);

  assert.deepEqual(result, {
    graphs: 1,
    documents: 1,
    canonicalBytes: Buffer.byteLength(value.graph.json, "utf8") + Buffer.byteLength(value.document.json, "utf8"),
    removableMirrorBytes: expectedMirrorBytes,
  });
  assert.equal(value.graphRow.canonicalContent, value.graph.json);
  assert.equal(value.documentRow.canonicalContent, value.document.json);
});

test("canonical storage inspection accepts version 2 only with SQL-null mirror values", async () => {
  const value = await fixture();
  const graphRow = { ...value.graphRow, storageLayoutVersion: 2, nodes: null, edges: null };
  const documentRow = {
    ...value.documentRow,
    storageLayoutVersion: 2,
    interfaceCatalog: null,
    softwareEngineeringDiagram: null,
    umlClassDiagram: null,
  };

  assert.deepEqual(inspectCanonicalStorage(target, graphRow, documentRow), {
    graphs: 0,
    documents: 0,
    canonicalBytes: Buffer.byteLength(value.graph.json, "utf8") + Buffer.byteLength(value.document.json, "utf8"),
    removableMirrorBytes: 0,
  });
});

test("canonical storage inspection rejects unverifiable and unknown layouts or mismatched ownership", async () => {
  const value = await fixture();

  assert.throws(() => inspectCanonicalStorage(target, { ...value.graphRow, canonicalContent: null }, null), /LEGACY_UNVERIFIABLE/);
  assert.throws(() => inspectCanonicalStorage(target, { ...value.graphRow, storageLayoutVersion: 3 }, null), /INTEGRITY_ERROR/);
  assert.throws(() => inspectCanonicalStorage(target, { ...value.graphRow, ownerUserId: "other_owner" }, null), /INTEGRITY_ERROR/);
  assert.throws(() => inspectCanonicalStorage(target, { ...value.graphRow, storageLayoutVersion: 2, nodes: null }, null), /INTEGRITY_ERROR/);
});

test("compaction skips an oversized analysis before loading its result rows", async () => {
  const queries: string[] = [];
  const tx = {
    $queryRaw: async (strings: TemplateStringsArray) => {
      const query = strings.join("");
      queries.push(query);
      if (query.includes("FOR UPDATE")) return [{ ...target, status: "COMPLETED", deletionRequestedAt: null }];
      if (query.includes("octet_length")) return [{ tooLarge: true }];
      throw new Error("Unexpected storage compaction query.");
    },
  };
  const db = {
    $transaction: async <T>(callback: (transaction: typeof tx) => Promise<T>) => callback(tx),
  } as unknown as PrismaClient;

  assert.deepEqual(await compactAnalysisStorage(db, target.id), {
    status: "skipped",
    reason: "PAYLOAD_TOO_LARGE",
    graphs: 0,
    documents: 0,
    canonicalBytes: 0,
    removableMirrorBytes: 0,
  });
  assert.equal(queries.length, 2);
  assert.ok(queries[0]!.includes("FOR UPDATE"));
  assert.ok(queries[1]!.includes("octet_length"));
});
