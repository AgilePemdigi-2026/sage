import assert from "node:assert/strict";
import test from "node:test";
import type { CcmEdge, NodeKind } from "@sage/contracts";
import type { GraphEdgeView, GraphNodeView, GraphViewModel } from "../apps/web/components/graph-foundation/graph-projection.ts";
import { filterGraph } from "../apps/web/components/live-graph/graph-filters.ts";
import { GRAPH_RENDER_LIMITS, projectGraphMode } from "../apps/web/components/live-graph/graph-modes.ts";

function node(id: string, kind: NodeKind, name: string, qualifiedName: string, filePath: string | null): GraphNodeView {
  const category = kind === "Module" ? "Berkas"
    : kind === "Class" || kind === "Interface" ? "Struktur"
      : kind === "UnresolvedReference" ? "Belum terpecahkan" : "Simbol";
  return {
    id,
    name,
    label: `${name}\n${kind}`,
    kind,
    category,
    origin: kind === "UnresolvedReference" ? "unresolved" : "source",
    qualifiedName,
    filePath,
    line: filePath ? 1 : null,
  };
}

function edge(id: string, source: string, target: string, kind: CcmEdge["kind"] = "CALLS", resolution: "Exact" | "Unresolved" = "Exact"): GraphEdgeView {
  return {
    id,
    source,
    target,
    kind,
    resolution,
    label: `${kind} · ${resolution}`,
    unresolvedReason: resolution === "Unresolved" ? "UNKNOWN_RECEIVER" : null,
  };
}

function graph(nodes: GraphNodeView[], edges: GraphEdgeView[]): GraphViewModel {
  return { repository: "owner/repo", branch: "main", commitSha: "a".repeat(40), nodes, edges };
}

const canonicalGraph = graph([
  node("module", "Module", "billing", "billing", "src/billing.ts"),
  node("class", "Class", "ReportService", "billing.ReportService", "src/report-service.ts"),
  node("method-save", "Method", "saveReport", "billing.ReportService.saveReport", "src/report-service.ts"),
  node("method-find", "Method", "findReport", "billing.ReportService.findReport", "src/report-service.ts"),
  node("function-normalize", "Function", "normalizeReport", "billing.normalizeReport", "src/report-utils.ts"),
  node("property-name", "Property", "displayName", "billing.ReportService.displayName", "src/report-service.ts"),
  node("unresolved-report", "UnresolvedReference", "missingReport", "billing.missingReport", null),
], [
  edge("contains-class", "module", "class", "CONTAINS"),
  edge("contains-save", "class", "method-save", "CONTAINS"),
  edge("contains-find", "class", "method-find", "CONTAINS"),
  edge("save-find", "method-save", "method-find"),
  edge("save-normalize", "method-save", "function-normalize"),
  edge("save-unresolved", "method-save", "unresolved-report", "CALLS", "Unresolved"),
]);

test("query is a case-insensitive literal substring and is ANDed with exact AST kinds", () => {
  const snapshot = structuredClone(canonicalGraph);
  const filtered = filterGraph(canonicalGraph, " REPORT ", ["Method", "Function"]);

  assert.deepEqual(filtered.graph.nodes.map((item) => item.id), ["method-save", "method-find", "function-normalize"]);
  assert.deepEqual(filtered.graph.edges.map((item) => item.id), ["save-find", "save-normalize"]);
  assert.deepEqual(filtered.counts, { nodes: 3, edges: 2 });
  assert.deepEqual(canonicalGraph, snapshot);
  assert.notEqual(filtered.graph, canonicalGraph);
  assert.notEqual(filtered.graph.nodes, canonicalGraph.nodes);
  assert.notEqual(filtered.graph.edges, canonicalGraph.edges);

  const regexText = filterGraph(canonicalGraph, ".*");
  assert.equal(regexText.graph.nodes.length, 0, "query punctuation must be treated as plain text, not a regular expression");
});

test("query searches canonical name, kind, qualified name, and file path fields", () => {
  assert.deepEqual(filterGraph(canonicalGraph, "METHOD").graph.nodes.map((item) => item.id), ["method-save", "method-find"]);
  assert.deepEqual(filterGraph(canonicalGraph, "BILLING.REPORTSERVICE.SAVEREPORT").graph.nodes.map((item) => item.id), ["method-save"]);
  assert.deepEqual(filterGraph(canonicalGraph, "REPORT-SERVICE.TS").graph.nodes.map((item) => item.id), ["class", "method-save", "method-find", "property-name"]);
  assert.deepEqual(filterGraph(canonicalGraph, "missingReport", ["Method"]).graph.nodes, []);
});

test("focus and reference modes operate only on query/kind matches and report downstream counts", () => {
  const snapshot = structuredClone(canonicalGraph);
  const filtered = filterGraph(canonicalGraph, "report", ["Method", "Function"]);
  const focus = projectGraphMode(filtered.graph, "focus", "function-normalize");
  const staleFocus = projectGraphMode(filtered.graph, "focus", "class");
  const references = projectGraphMode(filtered.graph, "all-references", "class");
  const filteredIds = new Set(filtered.graph.nodes.map((item) => item.id));

  assert.deepEqual(filtered.counts, { nodes: 3, edges: 2 });
  assert.deepEqual(focus.filteredCounts, { nodes: 2, edges: 1, containmentEdges: 0, referenceEdges: 1, exactEdges: 1, unresolvedEdges: 0 });
  assert.deepEqual(focus.graph.nodes.map((item) => item.id), ["function-normalize", "method-save"]);
  assert.deepEqual(references.filteredCounts, { nodes: 3, edges: 2, containmentEdges: 0, referenceEdges: 2, exactEdges: 2, unresolvedEdges: 0 });
  assert.ok(focus.graph.nodes.every((item) => filteredIds.has(item.id)));
  assert.ok(staleFocus.graph.nodes.every((item) => filteredIds.has(item.id)));
  assert.ok(references.graph.nodes.every((item) => filteredIds.has(item.id)));
  assert.equal(staleFocus.graph.nodes.some((item) => item.id === "class"), false, "a stale excluded focus ID cannot add unmatched context nodes");
  assert.deepEqual(canonicalGraph, snapshot);
});

test("empty results stay empty in every mode and clearing filters restores the full canonical subset", () => {
  const snapshot = structuredClone(canonicalGraph);
  const noMatch = filterGraph(canonicalGraph, "nothing-here", ["Class"]);
  assert.deepEqual(noMatch.counts, { nodes: 0, edges: 0 });

  for (const mode of ["overview", "focus", "all-references"] as const) {
    const projected = projectGraphMode(noMatch.graph, mode, "method-save");
    assert.equal(projected.anchorId, null);
    assert.deepEqual(projected.filteredCounts, { nodes: 0, edges: 0, containmentEdges: 0, referenceEdges: 0, exactEdges: 0, unresolvedEdges: 0 });
    assert.deepEqual(projected.graph.nodes, []);
    assert.deepEqual(projected.graph.edges, []);
  }

  const reset = filterGraph(canonicalGraph, "", []);
  assert.deepEqual(reset.graph, canonicalGraph);
  assert.deepEqual(reset.counts, { nodes: 7, edges: 6 });
  assert.deepEqual(canonicalGraph, snapshot);
});

test("render limits apply after query/kind filtering and preserve the larger filtered counts", () => {
  const nodes = Array.from({ length: 210 }, (_, index) => node(
    `node-${String(index).padStart(3, "0")}`, "Function", `needle-${String(index).padStart(3, "0")}`, `module.needle${String(index).padStart(3, "0")}`, "src/needle.ts",
  ));
  const edges = Array.from({ length: 505 }, (_, index) => edge(`edge-${String(index).padStart(3, "0")}`, "node-000", "node-001"));
  const source = graph(nodes, edges);
  const snapshot = structuredClone(source);
  const filtered = filterGraph(source, "needle", ["Function"]);
  const projected = projectGraphMode(filtered.graph, "overview");

  assert.deepEqual(GRAPH_RENDER_LIMITS, { nodes: 200, edges: 500 });
  assert.deepEqual(filtered.counts, { nodes: 210, edges: 505 });
  assert.deepEqual(projected.filteredCounts, { nodes: 210, edges: 505, containmentEdges: 0, referenceEdges: 505, exactEdges: 505, unresolvedEdges: 0 });
  assert.deepEqual(projected.visibleCounts, { nodes: 200, edges: 500, containmentEdges: 0, referenceEdges: 500, exactEdges: 500, unresolvedEdges: 0 });
  assert.deepEqual(projected.omittedCounts, { nodes: 10, edges: 5 });
  assert.equal(projectGraphMode(source, "overview").graph.nodes.some((item) => item.id === "node-209"), false);
  const beyondBudgetSearch = filterGraph(source, "needle-209");
  assert.deepEqual(beyondBudgetSearch.graph.nodes.map((item) => item.id), ["node-209"]);
  assert.equal(projectGraphMode(beyondBudgetSearch.graph, "overview").graph.nodes.some((item) => item.id === "node-209"), true);
  assert.deepEqual(source, snapshot);
});
