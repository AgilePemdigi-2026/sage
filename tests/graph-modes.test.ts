import assert from "node:assert/strict";
import test from "node:test";
import type { GraphEdgeView, GraphNodeView, GraphViewModel } from "../apps/web/components/graph-foundation/graph-projection.ts";
import { GRAPH_RENDER_LIMITS, projectGraphMode } from "../apps/web/components/live-graph/graph-modes.ts";

function node(id: string, kind: string, parentId: string | null = null): GraphNodeView {
  return {
    id,
    parentId,
    name: id,
    label: `${id}\n${kind}`,
    kind: kind as GraphNodeView["kind"],
    category: kind === "Module" ? "Berkas" : kind === "UnresolvedReference" ? "Belum terpecahkan" : "Simbol",
    origin: "source",
    qualifiedName: id,
    filePath: null,
    line: null,
  };
}

function edge(id: string, source: string, target: string, kind: string, resolution: "Exact" | "Unresolved" = "Exact"): GraphEdgeView {
  return {
    id,
    source,
    target,
    kind: kind as GraphEdgeView["kind"],
    resolution,
    label: `${kind} · ${resolution}`,
    unresolvedReason: resolution === "Unresolved" ? "symbol-not-found" as GraphEdgeView["unresolvedReason"] : null,
  };
}

function graph(nodes: GraphNodeView[], edges: GraphEdgeView[]): GraphViewModel {
  return { repository: "owner/repo", branch: "main", commitSha: "a".repeat(40), nodes, edges };
}

const baseGraph = graph([
  node("module-root", "Module"),
  node("module-namespace", "Module", "module-root"),
  node("class-a", "Class", "module-namespace"),
  node("method-a", "Method", "class-a"),
  node("function-a", "Function", "module-root"),
  node("unresolved-a", "UnresolvedReference"),
], [
  edge("contains-root", "module-root", "module-namespace", "CONTAINS"),
  edge("contains-class", "module-namespace", "class-a", "CONTAINS"),
  edge("contains-method", "class-a", "method-a", "CONTAINS"),
  edge("reference-unresolved", "class-a", "unresolved-a", "CALLS", "Unresolved"),
  edge("reference-method-function", "method-a", "function-a", "CALLS"),
  edge("reference-method-self", "method-a", "method-a", "CALLS"),
  edge("reference-method-function-parallel", "method-a", "function-a", "CALLS", "Unresolved"),
  edge("reference-function-class", "function-a", "class-a", "CALLS"),
]);

test("overview preserves the full graph and groups descendants at the nearest existing Module", () => {
  const sourceSnapshot = structuredClone(baseGraph);
  const projected = projectGraphMode(baseGraph, "overview");

  assert.deepEqual(projected.filteredCounts, { nodes: 6, edges: 8, containmentEdges: 3, referenceEdges: 5, exactEdges: 6, unresolvedEdges: 2 });
  assert.deepEqual(projected.visibleCounts, { nodes: 6, edges: 8, containmentEdges: 3, referenceEdges: 5, exactEdges: 6, unresolvedEdges: 2 });
  assert.equal(projected.moduleParentByNodeId["module-namespace"], "module-root");
  assert.equal(projected.moduleParentByNodeId["class-a"], "module-namespace");
  assert.equal(projected.moduleParentByNodeId["method-a"], "module-namespace");
  assert.equal(projected.moduleParentByNodeId["function-a"], "module-root");
  assert.equal(projected.graph.nodes.length, baseGraph.nodes.length);
  assert.deepEqual(baseGraph, sourceSnapshot);
});

test("focus uses a deterministic fallback and keeps only the anchor's incident edges", () => {
  const first = projectGraphMode(baseGraph, "focus", "missing-selection");
  const repeated = projectGraphMode({ ...baseGraph, nodes: [...baseGraph.nodes].reverse() }, "focus", "missing-selection");
  const focused = projectGraphMode(baseGraph, "focus", "method-a");

  assert.equal(first.anchorId, repeated.anchorId);
  assert.equal(first.anchorId, "module-namespace");
  assert.deepEqual(focused.graph.nodes.map((item) => item.id).sort(), ["class-a", "function-a", "method-a"]);
  assert.deepEqual(focused.graph.edges.map((item) => item.id), [
    "contains-method", "reference-method-function", "reference-method-function-parallel", "reference-method-self",
  ]);
  assert.equal(focused.graph.edges.filter((item) => item.id === "reference-method-function" || item.id === "reference-method-function-parallel").length, 2);
  assert.equal(focused.graph.edges.some((item) => item.id === "reference-function-class"), false);
  assert.equal(focused.graph.edges.some((item) => item.id === "reference-unresolved"), false);
  assert.deepEqual(focused.filteredCounts, { nodes: 3, edges: 4, containmentEdges: 1, referenceEdges: 3, exactEdges: 3, unresolvedEdges: 1 });
});

test("all references excludes containment and retains unresolved and repeated endpoints", () => {
  const projected = projectGraphMode(baseGraph, "all-references", "method-a");

  assert.equal(projected.anchorId, "method-a");
  assert.equal(projected.graph.edges.some((item) => item.kind === "CONTAINS"), false);
  assert.ok(projected.graph.nodes.some((item) => item.id === "unresolved-a"));
  assert.equal(projected.graph.edges.filter((item) => item.source === "method-a" && item.target === "function-a").length, 2);
  assert.equal(projected.graph.nodes.length, 4);
  assert.deepEqual(projected.filteredCounts, { nodes: 4, edges: 5, containmentEdges: 0, referenceEdges: 5, exactEdges: 3, unresolvedEdges: 2 });
});

test("renderer budget reports its deterministic subset and never returns a dangling compound parent", () => {
  const nodes = Array.from({ length: 205 }, (_, index) => node(`node-${String(index).padStart(3, "0")}`, index < 4 ? "Module" : "Function", index >= 4 ? "node-000" : null));
  const edges = Array.from({ length: 505 }, (_, index) => edge(`edge-${String(index).padStart(3, "0")}`, "node-004", "node-005", "CALLS"));
  const projected = projectGraphMode(graph(nodes, edges), "overview");
  const returnedIds = new Set(projected.graph.nodes.map((item) => item.id));

  assert.deepEqual(GRAPH_RENDER_LIMITS, { nodes: 200, edges: 500 });
  assert.deepEqual(projected.filteredCounts, { nodes: 205, edges: 505, containmentEdges: 0, referenceEdges: 505, exactEdges: 505, unresolvedEdges: 0 });
  assert.deepEqual(projected.visibleCounts, { nodes: 200, edges: 500, containmentEdges: 0, referenceEdges: 500, exactEdges: 500, unresolvedEdges: 0 });
  assert.deepEqual(projected.omittedCounts, { nodes: 5, edges: 5 });
  for (const parentId of Object.values(projected.moduleParentByNodeId)) assert.ok(returnedIds.has(parentId));
});

test("empty graphs remain empty in every mode", () => {
  for (const mode of ["overview", "focus", "all-references"] as const) {
    const projected = projectGraphMode(graph([], []), mode);
    assert.equal(projected.anchorId, null);
    assert.deepEqual(projected.filteredCounts, { nodes: 0, edges: 0, containmentEdges: 0, referenceEdges: 0, exactEdges: 0, unresolvedEdges: 0 });
    assert.deepEqual(projected.visibleCounts, { nodes: 0, edges: 0, containmentEdges: 0, referenceEdges: 0, exactEdges: 0, unresolvedEdges: 0 });
  }
});
