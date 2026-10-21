import assert from "node:assert/strict";
import test from "node:test";
import type { GraphPayload } from "../apps/web/lib/graphs/types.ts";
import { parseLiveGraphPayload } from "../apps/web/components/live-graph/graph-data.ts";

function payload(): GraphPayload {
  return {
    analysisId: "analysis_123",
    accountKey: "github-user-17",
    ckgSha256: "a".repeat(64),
    configurationHash: "b".repeat(64),
    snapshot: {} as GraphPayload["snapshot"],
    provenance: {} as GraphPayload["provenance"],
    canonicalCounts: { nodes: 2, edges: 1, containmentEdges: 0, referenceEdges: 1, exactEdges: 1, unresolvedEdges: 0 },
    filteredCounts: { nodes: 2, edges: 1 },
    returnedCounts: { nodes: 2, edges: 1 },
    paginated: false,
    limitations: [],
    graph: {
      repository: "owner/repo",
      branch: "main",
      commitSha: "c".repeat(40),
      nodes: [
        { id: "module", parentId: null, name: "module", label: "module\nModule", kind: "Module", category: "Berkas", origin: "source", qualifiedName: "module", filePath: "src/index.ts", line: 1 },
        { id: "function", parentId: "module", name: "run", label: "run\nFunction", kind: "Function", category: "Simbol", origin: "source", qualifiedName: "module.run", filePath: "src/index.ts", line: 2 },
      ],
      edges: [{ id: "calls", source: "module", target: "function", kind: "CALLS", resolution: "Exact", label: "CALLS · Exact", unresolvedReason: null }],
    },
  };
}

test("accepts a complete payload only for the requested analysis and account", () => {
  const value = payload();
  assert.equal(parseLiveGraphPayload(value, "analysis_123", "github-user-17"), value);
});

test("rejects payloads scoped to another analysis or signed-in GitHub account", () => {
  const value = payload();
  assert.throws(() => parseLiveGraphPayload(value, "analysis_other", "github-user-17"), /analisis atau akun aktif/);
  assert.throws(() => parseLiveGraphPayload(value, "analysis_123", "github-user-18"), /analisis atau akun aktif/);
});

test("rejects partial, paginated, inconsistent, or dangling graph responses", () => {
  const paginated = payload();
  (paginated as { paginated: boolean }).paginated = true;
  assert.throws(() => parseLiveGraphPayload(paginated, "analysis_123", "github-user-17"), /tidak lengkap/);

  const partial = payload();
  partial.returnedCounts.nodes = 1;
  assert.throws(() => parseLiveGraphPayload(partial, "analysis_123", "github-user-17"), /Jumlah graph tidak cocok/);

  const dangling = payload();
  dangling.graph.edges[0]!.target = "missing";
  assert.throws(() => parseLiveGraphPayload(dangling, "analysis_123", "github-user-17"), /tidak lengkap/);
});
