import { buildSoftwareOverview } from "@sage/documents/overview";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { canonicalizeCkg } from "@sage/contracts";
import { projectArchitectureDocument } from "@sage/documents/model";
import type { DocumentPayload } from "../apps/web/lib/documents/types.ts";
import { boundedDiagramOverview, diagramBudget, interactiveDiagramBudget, parseLiveDocumentPayload, projectInteractiveDiagram } from "../apps/web/components/live-document/document-data.ts";
import { githubEvidenceHref } from "../apps/web/components/live-document/evidence-link-data.ts";

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

test("evidence links use the immutable snapshot and reject unsafe repository paths", () => {
  const sha = "0123456789abcdef0123456789abcdef01234567";
  const evidence = { filePath: "src/space here/a#b.ts", startLine: 12, endLine: 18 };
  assert.equal(
    githubEvidenceHref("owner/repo", sha, evidence),
    `https://github.com/owner/repo/blob/${sha}/src/space%20here/a%23b.ts#L12-L18`,
  );
  assert.equal(githubEvidenceHref("owner/repo", sha, { ...evidence, endLine: 12 }),
    `https://github.com/owner/repo/blob/${sha}/src/space%20here/a%23b.ts#L12`);
  assert.equal(githubEvidenceHref("owner/repo", sha, { ...evidence, filePath: "../secret.ts" }), null);
  assert.equal(githubEvidenceHref("owner/repo", sha, { ...evidence, filePath: "/secret.ts" }), null);
  assert.equal(githubEvidenceHref("owner/repo", sha, { ...evidence, filePath: "src\\secret.ts" }), null);
  assert.equal(githubEvidenceHref("owner/repo", sha, { ...evidence, filePath: "src/file.ts", startLine: 0 }), null);
  assert.equal(githubEvidenceHref("owner/repo", "branch-name", evidence), null);
  assert.equal(githubEvidenceHref("owner/../repo", sha, evidence), null);
});

test("interactive diagrams apply renderer budgets after the human projection collapses members", async () => {
  const value = await fixture();
  const source = value.document.softwareEngineeringDiagram;
  const owner = { ...source.nodes[0]!, id: "overview-owner", kind: "Class" as const, parentId: null, name: "Owner", qualifiedName: "Owner", signature: null };
  const methods = Array.from({ length: 600 }, (_, index) => ({
    ...owner, id: `overview-method-${index}`, kind: "Method" as const, parentId: owner.id, name: `method${index}`, qualifiedName: `Owner.method${index}`,
  }));
  const raw = { ...source, nodes: [owner, ...methods], edges: [], mermaid: "flowchart LR" };
  const projected = projectInteractiveDiagram(raw);
  assert.equal(projected.sourceNodeCount, 601);
  assert.equal(projected.displayNodeCount, 1);
  assert.deepEqual(interactiveDiagramBudget(projected), { kind: "ready" });
});

test("oversized interactive diagrams have a bounded, source-backed overview fallback", async () => {
  const value = await fixture();
  const source = value.document.softwareEngineeringDiagram;
  const classes = Array.from({ length: 1_000 }, (_, index) => ({
    ...source.nodes[0]!, id: `overview-class-${index}`, kind: "Class" as const, parentId: null,
    name: `Class${index}`, qualifiedName: `Class${index}`, signature: null,
  }));
  const full = { ...source, nodes: classes, edges: [], mermaid: "flowchart LR" };
  const fullProjection = projectInteractiveDiagram(full);
  assert.equal(interactiveDiagramBudget(fullProjection).kind, "unavailable");

  const overview = boundedDiagramOverview(full, value.document.umlClassDiagram, "software-structure");
  const compactProjection = projectInteractiveDiagram(overview.diagram);
  assert.equal(overview.summary.totalNodes, 1_000);
  assert.ok(overview.summary.shownNodes <= 8);
  assert.deepEqual(interactiveDiagramBudget(compactProjection), { kind: "ready" });
  assert.ok(compactProjection.diagram.nodeMappings.every(mapping => classes.some(node => node.id === mapping.nodeId)));
});

test("interactive edge budget counts labeled unresolved and aggregated relation groups", async () => {
  const value = await fixture();
  const source = value.document.softwareEngineeringDiagram;
  const template = source.nodes[0]!;
  const nodes = Array.from({ length: 26 }, (_, index) => ({ ...template, id: `budget-node-${index}`, kind: "Class" as const, parentId: null, name: `Class${index}`, qualifiedName: `Class${index}`, signature: null }));
  const edges = nodes.flatMap((from, i) => nodes.flatMap((to, j) => i === j ? [] : [{
    id: `budget-edge-${i}-${j}`, sourceId: from.id, targetId: to.id, kind: "CALLS" as const,
    resolution: "Unresolved" as const, unresolvedReason: "UNKNOWN_RECEIVER" as const, evidence: [],
  }]));
  const raw = { ...source, nodes, edges, mermaid: "flowchart LR" };
  const projection = projectInteractiveDiagram(raw);
  assert.equal(projection.displayEdgeCount, 650);
  assert.equal(interactiveDiagramBudget(projection).kind, "unavailable");
  const duplicated = { ...raw, edges: edges.flatMap(edge => [edge, { ...edge, id: `${edge.id}-duplicate` }]) };
  assert.equal(projectInteractiveDiagram(duplicated).displayEdgeCount, 650);
  const overview = boundedDiagramOverview(raw, value.document.umlClassDiagram, "software-structure");
  assert.equal(interactiveDiagramBudget(projectInteractiveDiagram(overview.diagram)).kind, "ready");
});


test("grouped architecture budgets count visible boxes instead of repeated source mappings", async () => {
  const value = await fixture();
  const source = value.document.softwareEngineeringDiagram;
  const modules = Array.from({ length: 1200 }, (_, index) => ({
    ...source.nodes[0]!, id: `group-module-${index}`, kind: "Module" as const, origin: "source" as const,
    parentId: null, filePath: `src/${index < 600 ? "alpha" : "beta"}/file${index}.ts`, name: `file${index}`, qualifiedName: `file${index}`, signature: null,
  }));
  const grouped = buildSoftwareOverview({ ...source, nodes: modules, edges: [] });
  const projection = projectInteractiveDiagram(grouped.diagram, true);
  assert.equal(projection.diagram.mermaid, grouped.diagram.mermaid, "custom source grouping must survive the human-renderer boundary");
  assert.equal(projection.displayNodeCount, 2);
  assert.equal(projection.displayEdgeCount, 0);
  assert.deepEqual(interactiveDiagramBudget(projection), { kind: "ready" });
});
