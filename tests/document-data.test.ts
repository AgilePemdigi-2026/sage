import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { canonicalizeCkg } from "@sage/contracts";
import { projectArchitectureDocument } from "@sage/documents/model";
import type { DocumentPayload } from "../apps/web/lib/documents/types.ts";
import { diagramBudget, parseLiveDocumentPayload } from "../apps/web/components/live-document/document-data.ts";

async function fixture(): Promise<DocumentPayload> {
  const [source, ccmJson] = await Promise.all([
    readFile(new URL("../packages/contracts/examples/minimum-ccm.source.ts", import.meta.url), "utf8"),
    readFile(new URL("../packages/contracts/examples/minimum-ccm.json", import.meta.url), "utf8"),
  ]);
  const ccm = JSON.parse(ccmJson) as { provenance: { configHash: string } };
  const sourceBytes = { "examples/minimum-ccm.source.ts": new TextEncoder().encode(source) };
  const graph = canonicalizeCkg(JSON.parse(ccmJson) as unknown, sourceBytes, ccm.provenance.configHash);
  assert.equal(graph.ok, true);
  if (!graph.ok) throw new Error("Canonical document fixture must validate");
  const projected = projectArchitectureDocument(graph.json, sourceBytes, graph.sha256);
  assert.equal(projected.ok, true);
  if (!projected.ok) throw new Error("Canonical document fixture must project");
  return {
    analysisId: "analysis_document_data",
    accountKey: "github-document-data",
    contentHash: projected.sha256,
    document: projected.value,
  };
}

test("live document payload requires the expected analysis, account and canonical hashes", async () => {
  const value = await fixture();
  assert.equal(parseLiveDocumentPayload(value, value.analysisId, value.accountKey), value);
  assert.throws(() => parseLiveDocumentPayload(value, "analysis_other_123", value.accountKey), /akun aktif/);
  assert.throws(() => parseLiveDocumentPayload(value, value.analysisId, "github-other"), /akun aktif/);

  const badHash = { ...value, contentHash: "bad" };
  assert.throws(() => parseLiveDocumentPayload(badHash, value.analysisId, value.accountKey), /akun aktif/);
  const missingCatalog = { ...value, document: { ...value.document, interfaceCatalog: null } };
  assert.throws(() => parseLiveDocumentPayload(missingCatalog, value.analysisId, value.accountKey), /akun aktif/);
  const missingDiagramEvidence = {
    ...value,
    document: {
      ...value.document,
      softwareEngineeringDiagram: { ...value.document.softwareEngineeringDiagram, nodeMappings: [{ nodeId: "missing" }] },
    },
  };
  assert.throws(() => parseLiveDocumentPayload(missingDiagramEvidence, value.analysisId, value.accountKey), /akun aktif/);
});

test("document diagrams respect both character and byte budgets without truncation", async () => {
  const value = await fixture();
  const structure = value.document.softwareEngineeringDiagram;
  assert.deepEqual(diagramBudget(structure), { kind: "ready" });

  const tooManyCharacters = { ...structure, mermaid: `flowchart LR\n${"x".repeat(50_001)}` };
  assert.deepEqual(diagramBudget(tooManyCharacters), {
    kind: "unavailable", reason: "Source diagram melewati batas 50.000 karakter atau byte.",
  });
  const tooManyBytes = { ...structure, mermaid: `flowchart LR\n${"é".repeat(26_000)}` };
  assert.ok(tooManyBytes.mermaid.length < 50_000, "byte-budget fixture stays within character limit");
  assert.deepEqual(diagramBudget(tooManyBytes), {
    kind: "unavailable", reason: "Source diagram melewati batas 50.000 karakter atau byte.",
  });

  const tooManyNodes = { ...structure, nodes: Array.from({ length: 501 }, (_, index) => ({ ...structure.nodes[0]!, id: `node-${index}` })) };
  assert.deepEqual(diagramBudget(tooManyNodes), {
    kind: "unavailable", reason: "Diagram melewati batas 500 node atau 500 relasi.",
  });
  const tooManyEdges = { ...structure, edges: Array.from({ length: 501 }, (_, index) => ({ ...structure.edges[0]!, id: `edge-${index}` })) };
  assert.deepEqual(diagramBudget(tooManyEdges), {
    kind: "unavailable", reason: "Diagram melewati batas 500 node atau 500 relasi.",
  });
});
