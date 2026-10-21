import assert from "node:assert/strict";
import test from "node:test";
import { analyzeReferences as analyzePhpReferences } from "@sage/analyzer-php";
import { analyzeReferences as analyzeJsReferences } from "@sage/analyzer-js";
import { canonicalizeCkg, type CcmV1, type CcmSnapshot } from "@sage/contracts";
import { projectDiagrams } from "../packages/documents/src/diagrams.ts";

const encoder = new TextEncoder();
const configHash = "a".repeat(64);
const snapshot: CcmSnapshot = {
  repository: "fixture/diagram-projections",
  branch: "test",
  commitSha: "d".repeat(40),
};

function bytes(text: string): Uint8Array {
  return encoder.encode(text);
}

function decodeNumericEntities(value: string): string {
  return value.replace(/#([0-9]+);/g, (_, decimal: string) => String.fromCodePoint(Number(decimal)));
}

async function canonicalize(analysis: { ccm: CcmV1 | null; errorCode: string | null }, sources: Record<string, Uint8Array>) {
  assert.ok(analysis.ccm, `analyzer did not produce a CKG source model: ${analysis.errorCode}`);
  const canonical = canonicalizeCkg(analysis.ccm, sources, configHash);
  if (!canonical.ok) throw new Error(`CKG validation failed: ${canonical.errorCode}`);
  const projected = projectDiagrams(canonical.json, sources, canonical.sha256);
  if (!projected.ok) throw new Error(`projection failed: ${projected.errorCode}`);
  return { canonical, projection: projected.value, ccm: analysis.ccm };
}

test("real JavaScript, TypeScript, and PHP resolver CKGs project without losing canonical facts", async () => {
  const hostile = `</textarea><script>alert("x")</script>\n ] \\ -->|label`;
  const jsSources = {
    "src/app.js": bytes(`
export class Base { call() { return true; } }
export class Child extends Base {
  [${JSON.stringify(hostile)}]() { return "ok"; }
  invoke(target) { return target.run(); }
}
export class MissingChild extends MissingBase {}
export class InvalidXmlNames {
  ["nul\\u0000name"]() {}
  ["surrogate\\uD800name"]() {}
}
`),
  };
  const js = await analyzeJsReferences({ snapshot, sources: jsSources });
  const jsResult = await canonicalize(js, jsSources);

  const tsSources = {
    "src/model.ts": bytes(`
export interface Contract { value: string; }
export class Base {}
export class Child extends Base implements Contract { value = "ready"; }
export class MissingChild extends MissingBase {}
`),
  };
  const ts = await analyzeJsReferences({ snapshot, sources: tsSources });
  const tsResult = await canonicalize(ts, tsSources);

  const phpSources = {
    "src/model.php": bytes(`<?php
namespace DiagramFixture;
class Base {}
interface Contract {}
class Child extends Base implements Contract { public function run(): void {} }
class MissingChild extends MissingBase {}
`),
  };
  const php = await analyzePhpReferences({ snapshot, sources: phpSources });
  const phpResult = await canonicalize(php, phpSources);

  let containmentEdgeCount = 0;
  for (const result of [jsResult, tsResult, phpResult]) {
    const [uml, structure] = result.projection.diagrams;
    assert.equal(result.projection.ckgSha256, result.canonical.sha256);
    assert.deepEqual(result.projection.snapshot, snapshot);
    assert.equal(result.projection.configurationHash, configHash);
    assert.deepEqual(result.projection.canonicalCounts, result.canonical.value.counts);

    assert.deepEqual(structure.nodes, result.ccm.nodes, "the structure projection retains every original node and its evidence");
    assert.deepEqual(structure.edges, result.ccm.edges, "the structure projection retains repeated edges and their evidence");
    assert.equal(structure.nodeMappings.length, result.ccm.nodes.length);
    assert.equal(structure.edgeMappings.length, result.ccm.edges.length);
    assert.equal(structure.excludedNodeIds.length, 0);
    assert.equal(structure.excludedEdgeIds.length, 0);
    assert.ok(structure.mermaid.startsWith("flowchart LR"));
    const containmentEdges = result.ccm.edges.filter(edge => edge.kind === "CONTAINS");
    containmentEdgeCount += containmentEdges.length;
    for (const edge of containmentEdges) {
      const mapping = structure.edgeMappings.find(item => item.edgeId === edge.id);
      assert.ok(mapping, `CONTAINS edge ${edge.id} has a Mermaid mapping`);
      const line = structure.mermaid.split("\n")[mapping.mermaidLine - 1] ?? "";
      assert.ok(decodeNumericEntities(line).includes("CONTAINS · ownership only · Exact"),
        `CONTAINS edge ${edge.id} is labeled as ownership only`);
    }

    const umlNodeIds = [...uml.nodes.map(node => node.id), ...uml.excludedNodeIds].sort();
    const umlEdgeIds = [...uml.edges.map(edge => edge.id), ...uml.excludedEdgeIds].sort();
    assert.deepEqual(umlNodeIds, result.ccm.nodes.map(node => node.id).sort(), "UML lists every omitted node ID");
    assert.deepEqual(umlEdgeIds, result.ccm.edges.map(edge => edge.id).sort(), "UML lists every omitted edge ID");
    assert.ok(uml.edges.every(edge => edge.kind === "EXTENDS" || edge.kind === "IMPLEMENTS"));
    assert.ok(uml.nodes.filter(node => node.kind === "Method" || node.kind === "Property")
      .every(node => uml.nodes.some(parent => parent.id === node.parentId && (parent.kind === "Class" || parent.kind === "Interface"))));
    assert.ok(uml.nodeMappings.every(mapping => mapping.evidence === null || mapping.evidence.role === "declaration"));
    assert.ok(uml.edgeMappings.every(mapping => mapping.evidence.every(evidence => evidence.role === "reference")));
    assert.ok(!uml.mermaid.includes("*--") && !uml.mermaid.includes("o--"), "ownership is not rendered as UML composition or aggregation");
  }
  assert.ok(containmentEdgeCount > 0, "the real resolver fixtures exercise ownership labeling");

  const [tsUml] = tsResult.projection.diagrams;
  assert.ok(tsUml.mermaid.includes("<|--"), "exact EXTENDS is oriented base-to-derived in UML syntax");
  assert.ok(tsUml.mermaid.includes("<|.."), "exact IMPLEMENTS is oriented interface-to-implementer in UML syntax");
  assert.match(decodeNumericEntities(tsUml.mermaid), /\.\.> .*EXTENDS · UNRESOLVED/);
  assert.ok(tsUml.mermaid.includes("<<interface>>"));
  assert.ok(tsUml.nodes.some(node => node.kind === "UnresolvedReference"));
  assert.ok(tsUml.edges.every(edge => edge.resolution === "Exact" || edge.resolution === "Unresolved"));

  const [jsUml] = jsResult.projection.diagrams;
  const hostileMember = jsUml.nodes.find(node => node.kind === "Method" && node.name.includes("textarea"));
  assert.ok(hostileMember, "the resolver's quoted computed method name remains in the UML projection");
  const hostileMapping = jsUml.nodeMappings.find(mapping => mapping.nodeId === hostileMember.id);
  assert.ok(hostileMapping?.parentMermaidId, "the UML compartment mapping links the member to its classifier alias");
  assert.doesNotMatch(jsUml.mermaid, /<\/textarea>|<script>|alert\("x"\)/i, "hostile model text is absent from Mermaid syntax");
  assert.ok(jsUml.mermaid.includes("#60;"), "hostile labels remain represented as numeric entities");
  const jsStructure = jsResult.projection.diagrams[1];
  assert.ok(jsStructure.mermaid.includes("#10;"), "line breaks in names are represented as numeric entities");
  assert.ok(jsStructure.mermaid.includes("#92;u0000"), "NUL remains visible as a safe U+0000 escape");
  assert.ok(jsStructure.mermaid.includes("#92;ud800"), "unpaired surrogates remain visible as safe Unicode escapes");
  assert.doesNotMatch(jsStructure.mermaid, /[\u0000\ud800]/, "invalid XML characters never enter generated Mermaid source");
});

test("projection replay is deterministic and rejects tampered CKG hashes or source bytes", async () => {
  const sources = { "src/model.ts": bytes("export class Base {}\nexport class Child extends Base {}\n") };
  const analysis = await analyzeJsReferences({ snapshot, sources });
  const result = await canonicalize(analysis, sources);

  const first = projectDiagrams(result.canonical.json, sources, result.canonical.sha256);
  const second = projectDiagrams(result.canonical.json, sources, result.canonical.sha256);
  assert.deepEqual(second, first);
  assert.equal(projectDiagrams(result.canonical.json, sources, "0".repeat(64)).ok, false);

  const changedSources = { "src/model.ts": new Uint8Array(sources["src/model.ts"]) };
  changedSources["src/model.ts"]![0] ^= 1;
  const tampered = projectDiagrams(result.canonical.json, changedSources);
  assert.deepEqual(tampered, { ok: false, errorCode: "CCM_FILE_HASH_MISMATCH" });
});

test("projection keeps repeated canonical edges and assigns safe hash-derived aliases", async () => {
  const sources = { "src/model.ts": bytes("function run() {}\nexport class Child { call() { run(); run(); } }\n") };
  const analysis = await analyzeJsReferences({ snapshot, sources });
  assert.ok(analysis.ccm);
  const repeated = analysis.ccm.edges.filter(edge => edge.kind === "CALLS" &&
    analysis.ccm?.nodes.find(node => node.id === edge.sourceId)?.qualifiedName === "src/model.ts.Child.call" &&
    analysis.ccm?.nodes.find(node => node.id === edge.targetId)?.qualifiedName === "src/model.ts.run");
  assert.equal(repeated.length, 2, "the resolver emits one edge per source call site");
  assert.notEqual(repeated[0]?.id, repeated[1]?.id);
  const target = analysis.ccm.nodes.find(node => node.id === repeated[0]?.targetId);
  const source = analysis.ccm.nodes.find(node => node.id === repeated[0]?.sourceId);
  assert.ok(target && source);
  const canonical = canonicalizeCkg(analysis.ccm, sources, configHash);
  assert.equal(canonical.ok, true);
  if (!canonical.ok) return;
  const projected = projectDiagrams(canonical.json, sources, canonical.sha256);
  assert.equal(projected.ok, true);
  if (!projected.ok) return;
  const [uml, structure] = projected.value.diagrams;
  const repeatedProjectionEdges = structure.edges.filter(edge => edge.kind === "CALLS" && edge.sourceId === source.id && edge.targetId === target.id);
  const repeatedMappings = structure.edgeMappings.filter(mapping => repeatedProjectionEdges.some(edge => edge.id === mapping.edgeId));
  assert.equal(repeatedProjectionEdges.length, 2);
  assert.equal(new Set(repeatedMappings.map(mapping => mapping.mermaidLine)).size, 2, "parallel source facts keep separate Mermaid statements");
  const sourceMapping = structure.nodeMappings.find(mapping => mapping.nodeId === source.id);
  const targetMapping = structure.nodeMappings.find(mapping => mapping.nodeId === target.id);
  assert.match(sourceMapping?.mermaidId ?? "", /^N_[a-f0-9]{64}$/);
  assert.match(targetMapping?.mermaidId ?? "", /^N_[a-f0-9]{64}$/);
  assert.equal(uml.edgeMappings.length, uml.edges.length);
  assert.ok(uml.edgeMappings.every(mapping => mapping.edgeId.startsWith("edge_")));
});
