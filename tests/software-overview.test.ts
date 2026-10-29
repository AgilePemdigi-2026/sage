import assert from "node:assert/strict";
import test from "node:test";
import type { CcmEdge, CcmNode } from "@sage/contracts";
import type { DiagramProjection } from "../packages/documents/src/diagrams.ts";
import { buildSoftwareOverview } from "../packages/documents/src/software-overview.ts";

function moduleNode(id: string, filePath: string, origin: CcmNode["origin"] = "source"): CcmNode {
  return {
    id, kind: "Module", name: filePath.split("/").at(-1)!, qualifiedName: filePath, language: "typescript",
    filePath, location: { filePath, fileSha256: "a".repeat(64), startByte: 0, endByte: 1, startLine: 1, endLine: 1, startColumn: 1, endColumn: 2, role: "declaration" },
    parentId: null, origin, signature: null, attributes: {},
  };
}

function reference(id: string, sourceId: string, targetId: string, kind: CcmEdge["kind"] = "IMPORTS", resolution: CcmEdge["resolution"] = "Exact", reason: CcmEdge["unresolvedReason"] = null): CcmEdge {
  return {
    id, sourceId, targetId, kind, resolution, unresolvedReason: reason,
    evidence: [{ filePath: "src/a/index.ts", fileSha256: "b".repeat(64), startByte: 2, endByte: 3, startLine: 2, endLine: 2, startColumn: 1, endColumn: 2, role: "reference" }],
  };
}

function projection(nodes: CcmNode[], edges: CcmEdge[] = []): DiagramProjection {
  return { kind: "software-structure", title: "Software Structure", mermaid: "flowchart LR", nodes, edges, nodeMappings: [], edgeMappings: [], excludedNodeIds: [], excludedEdgeIds: [] };
}

test("overview groups source directories, keeps the connected high-level graph bounded and maps original evidence", () => {
  const nodes = Array.from({ length: 30 }, (_, index) => moduleNode(`m${index}`, `src/feature-${String(index).padStart(2, "0")}/index.ts`));
  const edges = [reference("e1", "m0", "m1"), reference("e2", "m0", "m1", "CALLS"), reference("e3", "m1", "m2")];
  const input = projection(nodes, edges);
  const before = structuredClone(input);
  const result = buildSoftwareOverview(input, { maxGroups: 12 });
  assert.equal(result.groups.length, 30);
  assert.equal(result.summary.shownGroups, 12);
  assert.equal(result.summary.omittedGroups, 18);
  assert.equal(result.diagram.nodes.length, 12);
  assert.match(result.diagram.mermaid, /^flowchart TB/u);
  assert.match(result.diagram.mermaid, /src\/feature#45;00 #183; 1 file/u);
  assert.match(result.diagram.mermaid, /calls #183; imports/u);
  assert.equal(result.relations.length, 2);
  assert.deepEqual(result.relations[0]?.sourceEdgeIds, ["e1", "e2"]);
  assert.equal(result.diagram.edgeMappings.length, 3);
  assert.ok(result.diagram.mermaid.includes(" ~~~ "), "layout spine keeps fan-in readable without adding source relationships");
  assert.equal(result.diagram.edges.length, 3);
  assert.deepEqual(input, before, "the source projection is not mutated");
  const again = buildSoftwareOverview(input, { maxGroups: 12 });
  assert.equal(again.diagram.mermaid, result.diagram.mermaid, "rendering is stable");
  assert.deepEqual(again.relations.map(item => item.sourceEdgeIds), result.relations.map(item => item.sourceEdgeIds));
});

test("overview ranking includes incoming references so heavily used leaf folders remain visible", () => {
  const consumers = Array.from({ length: 20 }, (_, index) => moduleNode(`consumer-${index}`, `src/consumer-${String(index).padStart(2, "0")}/index.ts`));
  const provider = moduleNode("provider", "src/provider/index.ts");
  const edges = consumers.map((node, index) => reference(`e${String(index).padStart(2, "0")}`, node.id, provider.id));
  const result = buildSoftwareOverview(projection([...consumers, provider], edges), { maxGroups: 2 });
  const providerGroup = result.groups.find(group => group.label === "src/provider");
  assert.equal(providerGroup?.referenceCount, 20);
  assert.ok(result.diagram.nodes.some(node => node.id === "provider"));
  assert.equal(result.relations.length, 1);
  assert.deepEqual(result.relations[0]?.sourceEdgeIds, ["e00"]);
});

test("focus expands a source folder to a bounded set of file modules and linked neighboring groups", () => {
  const nodes = [
    ...Array.from({ length: 15 }, (_, index) => moduleNode(`a${index}`, `src/app/books/file-${index}.ts`)),
    moduleNode("b0", "src/lib/client.ts"),
    moduleNode("c0", "src/lib/store.ts"),
  ];
  const edges = [reference("e1", "a0", "b0"), reference("e2", "a1", "b0"), reference("e3", "a2", "c0")];
  const input = projection(nodes, edges);
  const main = buildSoftwareOverview(input);
  const books = main.groups.find(group => group.label === "src/app/books");
  assert.ok(books);
  const focused = buildSoftwareOverview(input, { focusGroupId: books.id, maxFiles: 12 });
  assert.equal(focused.summary.focusGroupId, books.id);
  assert.ok(focused.diagram.nodes.length <= 12);
  assert.equal(focused.summary.shownFiles, 8, "eight focused files leave space for up to four neighboring directory cards");
  assert.match(focused.diagram.mermaid, /file#45;0\.ts/u);
  assert.match(focused.diagram.mermaid, /src\/lib/u);
  assert.ok(focused.relations.length >= 1);
  assert.equal(focused.diagram.nodes.every(node => node.kind === "Module" && node.origin === "source"), true);
});

test("focus filters off-screen relations before applying edge and relation caps", () => {
  const nodes = [
    moduleNode("focus", "src/app/books/index.ts"),
    moduleNode("target", "src/lib/target.ts"),
    moduleNode("offscreen-source", "src/other/source.ts"),
    moduleNode("offscreen-target", "src/other/target.ts"),
  ];
  const edges = [
    ...Array.from({ length: 520 }, (_, index) => reference(`e${String(index).padStart(4, "0")}`, "offscreen-source", "offscreen-target")),
    reference("z-focus", "focus", "target"),
  ];
  const input = projection(nodes, edges);
  const books = buildSoftwareOverview(input).groups.find(group => group.label === "src/app/books");
  assert.ok(books);
  const focused = buildSoftwareOverview(input, { focusGroupId: books.id });
  assert.deepEqual(focused.relations.flatMap(relation => relation.sourceEdgeIds), ["z-focus"]);
  assert.deepEqual(focused.diagram.edges.map(edge => edge.id), ["z-focus"]);
  assert.deepEqual(focused.diagram.edgeMappings.map(mapping => mapping.edgeId), ["z-focus"]);
});

test("unresolved facts stay diagnostics, containment and other-origin placeholders do not become groups", () => {
  const nodes = [moduleNode("a", "src/a/index.ts"), moduleNode("external", "vendor/pkg.ts", "external"), {
    ...moduleNode("unknown", "src/a/index.ts", "unresolved"), kind: "UnresolvedReference" as const, origin: "unresolved" as const, name: "missing",
  }];
  const edges = [
    reference("e-contains", "a", "unknown", "CONTAINS"),
    reference("e-exact-external", "a", "external"),
    reference("e-missing", "a", "unknown", "CALLS", "Unresolved", "UNKNOWN_RECEIVER"),
  ];
  const result = buildSoftwareOverview(projection(nodes, edges));
  assert.equal(result.groups.length, 1);
  assert.equal(result.diagram.edges.length, 0);
  assert.equal(result.summary.unresolvedReferences, 1);
  assert.deepEqual(result.unresolved.map(item => [item.reason, item.count, item.edgeIds]), [["UNKNOWN_RECEIVER", 1, ["e-missing"]]]);
  assert.doesNotMatch(result.diagram.mermaid, /missing/u);
});

test("hostile paths are encoded as Mermaid text and source records stay capped", () => {
  const hostilePath = 'src/app/[<script>\uD800]/page"] --> HACK %%';
  const nodes = [moduleNode("a", hostilePath), moduleNode("b", "src/safe/index.ts")];
  const edges = Array.from({ length: 620 }, (_, index) => reference(`e${String(index).padStart(4, "0")}`, "a", "b"));
  const result = buildSoftwareOverview(projection(nodes, edges), { maxGroups: 12 });
  assert.equal(result.relations.length, 1);
  assert.equal(result.relations[0]!.sourceEdgeIds.length, 500);
  assert.equal(result.summary.omittedSourceEdgeRecords, 120);
  assert.equal(result.diagram.edges.length, 500, "all edges represented by evidence mappings remain in the projection");
  assert.doesNotMatch(result.diagram.mermaid, /<script>|HACK|%%/u);
  assert.ok(result.diagram.mermaid.includes("#60;"), "unsafe label punctuation is escaped as Mermaid text");
  assert.ok(result.diagram.mermaid.includes("#92;ud800"), "unpaired surrogates stay visible without emitting invalid XML");
  assert.equal(result.diagram.edgeMappings.length, 500);
});

test("invalid limits and unknown focus groups fail explicitly", () => {
  const input = projection([moduleNode("a", "src/a.ts")]);
  assert.throws(() => buildSoftwareOverview(input, { maxGroups: 21 }), RangeError);
  assert.throws(() => buildSoftwareOverview(input, { maxFiles: 13 }), RangeError);
  assert.throws(() => buildSoftwareOverview(input, { focusGroupId: "g_unknown" }), RangeError);
});
