import type { CkgCounts } from "@sage/contracts";
import type { GraphEdgeView, GraphNodeView, GraphViewModel } from "../graph-foundation/graph-projection.ts";
import type { GraphPayload } from "../../lib/graphs/types.ts";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function validCkgCounts(value: unknown): value is CkgCounts {
  if (!record(value)) return false;
  return ["nodes", "edges", "containmentEdges", "referenceEdges", "exactEdges", "unresolvedEdges"]
    .every((key) => nonNegativeInteger(value[key]));
}

function validPairCounts(value: unknown): value is { nodes: number; edges: number } {
  return record(value) && nonNegativeInteger(value.nodes) && nonNegativeInteger(value.edges);
}

function isNode(value: unknown): value is GraphNodeView {
  if (!record(value)) return false;
  return typeof value.id === "string" && typeof value.name === "string" && typeof value.label === "string" &&
    typeof value.kind === "string" && typeof value.category === "string" &&
    (value.parentId === undefined || value.parentId === null || typeof value.parentId === "string") &&
    typeof value.qualifiedName === "string" &&
    (value.filePath === null || typeof value.filePath === "string") &&
    (value.line === null || nonNegativeInteger(value.line));
}

function isEdge(value: unknown): value is GraphEdgeView {
  if (!record(value)) return false;
  return typeof value.id === "string" && typeof value.source === "string" && typeof value.target === "string" &&
    typeof value.kind === "string" && (value.resolution === "Exact" || value.resolution === "Unresolved") &&
    typeof value.label === "string" && (value.unresolvedReason === null || typeof value.unresolvedReason === "string");
}

function validGraph(value: unknown): value is GraphViewModel {
  if (!record(value) || typeof value.repository !== "string" ||
    !(value.branch === null || typeof value.branch === "string") || typeof value.commitSha !== "string" ||
    !Array.isArray(value.nodes) || !value.nodes.every(isNode) || !Array.isArray(value.edges) || !value.edges.every(isEdge)) return false;
  const nodeIds = new Set(value.nodes.map((node) => node.id));
  const edgeIds = new Set(value.edges.map((edge) => edge.id));
  return nodeIds.size === value.nodes.length && edgeIds.size === value.edges.length &&
    value.edges.every((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target));
}

function countsFor(graph: GraphViewModel): CkgCounts {
  const containmentEdges = graph.edges.filter((edge) => edge.kind === "CONTAINS").length;
  const exactEdges = graph.edges.filter((edge) => edge.resolution === "Exact").length;
  const unresolvedEdges = graph.edges.length - exactEdges;
  return {
    nodes: graph.nodes.length,
    edges: graph.edges.length,
    containmentEdges,
    referenceEdges: graph.edges.length - containmentEdges,
    exactEdges,
    unresolvedEdges,
  };
}

/** Validate that an API response belongs to this SSR identity and is the complete canonical graph. */
export function parseLiveGraphPayload(value: unknown, analysisId: string, accountKey: string): GraphPayload {
  if (!record(value) || value.analysisId !== analysisId || value.accountKey !== accountKey) {
    throw new Error("Payload graph tidak sesuai dengan analisis atau akun aktif.");
  }
  const canonicalCounts = value.canonicalCounts;
  if (value.paginated !== false || !validCkgCounts(canonicalCounts) ||
    !validPairCounts(value.filteredCounts) || !validPairCounts(value.returnedCounts) || !validGraph(value.graph)) {
    throw new Error("Payload graph tidak lengkap atau tidak valid.");
  }
  const actual = countsFor(value.graph);
  const keys = ["nodes", "edges", "containmentEdges", "referenceEdges", "exactEdges", "unresolvedEdges"] as const;
  if (keys.some((key) => canonicalCounts[key] !== actual[key]) ||
    value.filteredCounts.nodes !== actual.nodes || value.filteredCounts.edges !== actual.edges ||
    value.returnedCounts.nodes !== actual.nodes || value.returnedCounts.edges !== actual.edges) {
    throw new Error("Jumlah graph tidak cocok dengan payload kanonik.");
  }
  if (typeof value.ckgSha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.ckgSha256) ||
    typeof value.configurationHash !== "string" || !/^[a-f0-9]{64}$/.test(value.configurationHash) ||
    !record(value.snapshot) || !record(value.provenance) || !Array.isArray(value.limitations)) {
    throw new Error("Metadata snapshot graph tidak valid.");
  }
  return value as unknown as GraphPayload;
}
