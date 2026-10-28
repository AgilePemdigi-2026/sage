import assert from "node:assert/strict";
import test from "node:test";
import type { CcmEdge, CcmNode } from "@sage/contracts";
import { projectCompactPdfDiagrams, PDF_PROJECTION_LIMITS } from "../packages/documents/src/pdf-projection.ts";
import type { DiagramProjection } from "../packages/documents/src/diagrams.ts";
import { pdfRendererInternals } from "../packages/documents/src/pdf.ts";

function node(id: string, kind: CcmNode["kind"], name: string, parentId: string | null = null, signature: string | null = null): CcmNode {
  return {
    id, kind, name, qualifiedName: name, parentId, origin: "source", language: "typescript",
    filePath: "src/" + id.slice(-8) + ".ts", location: null, signature, attributes: {},
  };
}

function edge(id: string, sourceId: string, targetId: string, resolution: CcmEdge["resolution"], kind: CcmEdge["kind"] = "CALLS"): CcmEdge {
  return { id, sourceId, targetId, kind, resolution, evidence: [], unresolvedReason: resolution === "Unresolved" ? "UNKNOWN_RECEIVER" : null };
}

function diagram(kind: DiagramProjection["kind"], nodes: CcmNode[], edges: CcmEdge[]): DiagramProjection {
  return { kind, title: kind, mermaid: kind === "uml-class" ? "classDiagram" : "flowchart LR", nodes, edges,
    nodeMappings: [], edgeMappings: [], excludedNodeIds: [], excludedEdgeIds: [] };
}

function fixtures(): { software: DiagramProjection; uml: DiagramProjection } {
  const functions = Array.from({ length: 36 }, (_, i) => node(`node_fn_${String(i).padStart(2, "0")}`, "Function", `${"FunctionLabel".repeat(8)}_${i}`));
  const classes = Array.from({ length: 16 }, (_, i) => node(`node_class_${String(i).padStart(2, "0")}`, "Class", i === 2 ? "ClassLabel".repeat(20) : `Class${i}`));
  const unresolved = Array.from({ length: 3 }, (_, i) => node(`node_unknown_${i}`, "UnresolvedReference", `UNKNOWN_RECEIVER_${i}`));
  const members = classes.flatMap((classifier, i) => Array.from({ length: 8 }, (_, j) =>
    node(`node_member_${String(i).padStart(2, "0")}_${j}`, j % 2 ? "Method" : "Property", `member${i}_${j}`, classifier.id,
      j === 0 && i === 2 ? `method(${"p".repeat(5000)})` : null)));
  const allNodes = [...functions, ...classes, ...unresolved, ...members];
  const edges: CcmEdge[] = [];
  for (let i = 0; i < 72; i += 1) {
    edges.push(edge(`edge_fn_${String(i).padStart(3, "0")}`, functions[i % functions.length]!.id,
      functions[(i * 7 + 3) % functions.length]!.id, i % 13 === 0 ? "Unresolved" : "Exact"));
  }
  for (let i = 0; i < 16; i += 1) {
    edges.push(edge(`edge_uml_${String(i).padStart(3, "0")}`, classes[i % classes.length]!.id,
      i % 5 === 0 ? unresolved[i % unresolved.length]!.id : classes[(i + 1) % classes.length]!.id,
      i % 5 === 0 ? "Unresolved" : "Exact", i % 2 ? "EXTENDS" : "IMPLEMENTS"));
  }
  for (let i = 0; i < 25; i += 1) {
    edges.push(edge(`edge_member_${String(i).padStart(3, "0")}`, members[i]!.id, functions[i % functions.length]!.id, "Exact"));
  }
  return { software: diagram("software-structure", allNodes, edges), uml: diagram("uml-class", [...classes, ...unresolved, ...members], edges.filter(item => item.kind !== "CALLS" || item.sourceId.startsWith("node_class_"))) };
}

test("compact PDF projections are deterministic, source-backed, bounded, and leave graph inputs unchanged", () => {
  const { software, uml } = fixtures();
  const originalSoftware = JSON.stringify(software);
  const originalUml = JSON.stringify(uml);
  const result = projectCompactPdfDiagrams(software, uml);
  assert.equal(JSON.stringify(software), originalSoftware);
  assert.equal(JSON.stringify(uml), originalUml);

  assert.ok(result.softwareSummary.shownNodes <= PDF_PROJECTION_LIMITS.structureNodes);
  assert.ok(result.softwareSummary.shownRelations <= PDF_PROJECTION_LIMITS.relationGroups);
  assert.ok(result.softwareSummary.shownEdges <= PDF_PROJECTION_LIMITS.relationRecords);
  assert.ok(result.umlSummary.shownNodes <= PDF_PROJECTION_LIMITS.umlClassifiers);
  assert.ok(result.umlSummary.shownMembers <= PDF_PROJECTION_LIMITS.umlClassifiers * PDF_PROJECTION_LIMITS.membersPerClassifier);
  assert.ok(result.umlSummary.totalNodes > result.umlSummary.shownNodes);
  assert.ok(result.umlSummary.totalMembers > result.umlSummary.shownMembers);
  assert.ok(result.softwareSummary.clippedValues > 0);
  assert.ok(result.umlSummary.clippedValues > 0);
  assert.match(result.uml.mermaid, /Label/);

  const originalNodeIds = new Set(software.nodes.map(item => item.id));
  const originalEdges = new Map(software.edges.map(item => [item.id, item]));
  assert.ok(result.software.nodes.every(item => originalNodeIds.has(item.id)));
  assert.ok(result.software.edges.every(item => {
    const source = originalEdges.get(item.id);
    return source !== undefined && source.sourceId === item.sourceId && source.targetId === item.targetId && source.resolution === item.resolution;
  }));
  assert.ok(result.software.edges.some(item => item.resolution === "Exact"));
  assert.ok(result.software.edges.some(item => item.resolution === "Unresolved"));
  assert.ok(result.software.mermaid.length < 50_000);
  assert.equal(pdfRendererInternals.validateRendererDiagram(result.software), null);
  assert.ok(result.uml.mermaid.length < 50_000);
  assert.equal(pdfRendererInternals.validateRendererDiagram(result.uml), null);
  assert.ok(result.uml.edges.some(item => item.resolution === "Exact"));
  assert.ok(result.uml.edges.some(item => item.resolution === "Unresolved"));
});

test("compact projections do not depend on canonical array order", () => {
  const { software, uml } = fixtures();
  const baseline = projectCompactPdfDiagrams(software, uml);
  const permuted = projectCompactPdfDiagrams(
    { ...software, nodes: [...software.nodes].reverse(), edges: [...software.edges].reverse() },
    { ...uml, nodes: [...uml.nodes].reverse(), edges: [...uml.edges].reverse() },
  );
  assert.equal(permuted.software.mermaid, baseline.software.mermaid);
  assert.equal(permuted.uml.mermaid, baseline.uml.mermaid);
  assert.deepEqual(permuted.softwareSummary, baseline.softwareSummary);
  assert.deepEqual(permuted.umlSummary, baseline.umlSummary);
});

test("one hundred duplicate calls consume one relation group instead of hiding connected source relations", () => {
  const connected = [node("node_a", "Function", "A"), node("node_b", "Function", "B"),
    node("node_c", "Function", "C"), node("node_d", "Function", "D")];
  const isolated = Array.from({ length: 6 }, (_, index) => node(`node_isolated_${index}`, "Function", `Isolated${index}`));
  const manyCalls = Array.from({ length: 100 }, (_, index) => edge(`edge_ab_${String(index).padStart(3, "0")}`, "node_a", "node_b", "Exact"));
  const input = diagram("software-structure", [...connected, ...isolated], [
    ...manyCalls,
    edge("edge_bc", "node_b", "node_c", "Exact"),
    edge("edge_cd", "node_c", "node_d", "Unresolved"),
  ]);
  const emptyUml = diagram("uml-class", [], []);
  const result = projectCompactPdfDiagrams(input, emptyUml);
  assert.equal(result.softwareSummary.shownRelations, 3);
  assert.equal(result.softwareSummary.shownEdges, 102);
  assert.equal(result.softwareSummary.shownNodes, 4);
  const shownIds = new Set(result.software.nodes.map(item => item.id));
  assert.deepEqual([...shownIds].sort(), ["node_a", "node_b", "node_c", "node_d"]);
  assert.ok(result.software.edges.some(item => item.resolution === "Unresolved"));
});

test("many unresolved targets do not displace real UML classifiers and their members", () => {
  const classes = Array.from({ length: 5 }, (_, index) => node(`node_real_${index}`, "Class", `RealClass${index}`));
  const unresolved = Array.from({ length: 24 }, (_, index) => node(`node_unresolved_${index}`, "UnresolvedReference", `UnknownTarget${index}`));
  const members = classes.flatMap((classifier, index) => Array.from({ length: 6 }, (_, memberIndex) =>
    node(`node_real_${index}_member_${memberIndex}`, memberIndex % 2 ? "Method" : "Property", `member${memberIndex}`, classifier.id)));
  const relations: CcmEdge[] = [];
  for (const [classIndex, classifier] of classes.entries()) {
    for (const [referenceIndex, target] of unresolved.entries()) {
      relations.push(edge(`edge_${classIndex}_${referenceIndex}`, classifier.id, target.id, "Unresolved", "IMPLEMENTS"));
    }
  }
  const inputUml = diagram("uml-class", [...classes, ...unresolved, ...members], relations);
  const emptySoftware = diagram("software-structure", [...classes, ...unresolved, ...members], relations);
  const result = projectCompactPdfDiagrams(emptySoftware, inputUml);
  const shownClasses = result.uml.nodes.filter(item => item.kind === "Class");
  const shownMembers = result.uml.nodes.filter(item => item.kind === "Method" || item.kind === "Property");
  assert.ok(shownClasses.length >= 3);
  assert.ok(shownMembers.length >= 3);
  const shownIds = new Set(result.uml.nodes.map(item => item.id));
  assert.ok(result.uml.edges.length > 0);
  assert.ok(result.uml.edges.every(item => shownIds.has(item.sourceId) && shownIds.has(item.targetId)));
  assert.ok(result.uml.edges.some(item => item.resolution === "Unresolved"));
  assert.equal(pdfRendererInternals.validateRendererDiagram(result.uml), null);
});


test("member evidence records do not count as rendered boxes after owner aggregation", () => {
  const owners = [node("owner_a", "Class", "Caller"), node("owner_b", "Class", "Callee")];
  const members = owners.flatMap(owner => Array.from({ length: 300 }, (_, index) =>
    node(`${owner.id}_member_${index}`, "Method", `method${index}`, owner.id)));
  const edges = Array.from({ length: 300 }, (_, index) =>
    edge(`call_${index}`, `owner_a_member_${index}`, `owner_b_member_${index}`, "Exact"));
  const input = diagram("software-structure", [...owners, ...members], edges);
  const result = projectCompactPdfDiagrams(input, diagram("uml-class", [], []));
  assert.equal(result.software.nodes.length, 602, "retain original member endpoint evidence");
  assert.equal(result.software.nodeMappings.length, 2, "only owning class boxes are rendered");
  assert.equal(result.softwareSummary.shownRelations, 1);
  assert.equal(result.softwareSummary.shownEdges, 300);
  assert.deepEqual(result.software.edges, edges.slice().sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  assert.ok(result.software.mermaid.length < 1000);
  assert.equal(pdfRendererInternals.validateRendererDiagram(result.software), null);
  const overBudget = { ...result.software, nodeMappings: Array.from({ length: 501 }, () => result.software.nodeMappings[0]!) };
  assert.equal(pdfRendererInternals.validateRendererDiagram(overBudget), "PDF_DIAGRAM_SOURCE_LIMIT_EXCEEDED");
});
