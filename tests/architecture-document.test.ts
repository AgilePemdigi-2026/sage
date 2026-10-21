import assert from "node:assert/strict";
import test from "node:test";
import { analyzeReferences as analyzePhpReferences } from "@sage/analyzer-php";
import { analyzeReferences as analyzeJsReferences } from "@sage/analyzer-js";
import { canonicalizeCkg, type CcmV1, type CcmSnapshot } from "@sage/contracts";
import {
  parseCanonicalArchitectureDocument,
  projectArchitectureDocument,
} from "../packages/documents/src/architecture-document.ts";

const encoder = new TextEncoder();
const configHash = "a".repeat(64);
const snapshot: CcmSnapshot = {
  repository: "fixture/architecture-document",
  branch: "test",
  commitSha: "d".repeat(40),
};

function bytes(text: string): Uint8Array {
  return encoder.encode(text);
}

function digestProjection(result: ReturnType<typeof projectArchitectureDocument>): string {
  assert.ok(result.ok);
  return result.sha256;
}

async function canonicalizeAnalysis(
  analysis: { ccm: CcmV1 | null; errorCode: string | null },
  sources: Record<string, Uint8Array>,
) {
  assert.ok(analysis.ccm, `analyzer did not produce a CCM: ${analysis.errorCode}`);
  const canonical = canonicalizeCkg(analysis.ccm, sources, configHash);
  assert.ok(canonical.ok, canonical.ok ? undefined : `CKG validation failed: ${canonical.errorCode}`);
  return canonical;
}

test("document projection keeps source declarations, unresolved facts, and diagram mappings for JS, TS, and PHP", async () => {
  const jsSources = {
    "src/model.js": bytes(`
export class Base {}
export class Child extends Base {
  ["nul\\u0000name"]() {}
  ["lone\\uD800surrogate"]() {}
  café() { return "😀"; }
}
export class MissingChild extends MissingBase {}
`),
  };
  const tsSources = {
    "src/model.ts": bytes(`
export interface Contract { value: string; }
export class Implementor implements Contract { value = "ready"; }
export class MissingImplementor extends MissingType {}
`),
  };
  const phpSources = {
    "src/model.php": bytes(`<?php
namespace ArchitectureFixture;
interface Contract {}
class Implementor implements Contract { public function run(): void {} }
class MissingChild extends MissingBase {}
`),
  };
  const cases = [
    { language: "javascript", sources: jsSources, ccm: await analyzeJsReferences({ snapshot, sources: jsSources }) },
    { language: "typescript", sources: tsSources, ccm: await analyzeJsReferences({ snapshot, sources: tsSources }) },
    { language: "php", sources: phpSources, ccm: await analyzePhpReferences({ snapshot, sources: phpSources }) },
  ] as const;

  for (const item of cases) {
    const canonical = await canonicalizeAnalysis(item.ccm, item.sources);
    const projected = projectArchitectureDocument(canonical.json, item.sources, canonical.sha256);
    assert.ok(projected.ok, `${item.language} projection failed: ${projected.ok ? "" : projected.errorCode}`);
    if (!projected.ok) continue;

    const document = projected.value;
    assert.equal(document.schemaVersion, "sage-add-v1");
    assert.equal(document.title, "Architecture Definition Document");
    assert.equal(document.ckgSha256, canonical.sha256);
    assert.equal(document.configurationHash, canonical.value.configurationHash);
    assert.deepEqual(document.snapshot, canonical.value.ccm.snapshot);
    assert.deepEqual(document.provenance, canonical.value.ccm.provenance);
    assert.deepEqual(document.canonicalCounts, canonical.value.counts);
    assert.deepEqual(document.files, canonical.value.ccm.files);
    assert.deepEqual(document.limitations, canonical.value.ccm.limitations);
    assert.deepEqual(document.softwareEngineeringDiagram.kind, "software-structure");
    assert.deepEqual(document.umlClassDiagram.kind, "uml-class");

    const sourceDeclarations = canonical.value.ccm.nodes
      .filter(node => node.origin === "source" && node.kind !== "Module");
    assert.deepEqual(document.interfaceCatalog.entries.map(entry => entry.declaration), sourceDeclarations);
    assert.deepEqual(document.interfaceCatalog.relations, canonical.value.ccm.edges);
    assert.ok(document.interfaceCatalog.scope.includes("selain Module"));
    for (const entry of document.interfaceCatalog.entries) {
      assert.ok(entry.nodeIds.includes(entry.declaration.id));
      assert.ok(entry.evidence.some(span => span.role === "declaration" &&
        span.filePath === entry.declaration.filePath));
      assert.deepEqual(entry.edgeIds, canonical.value.ccm.edges
        .filter(edge => edge.sourceId === entry.declaration.id || edge.targetId === entry.declaration.id)
        .map(edge => edge.id));
      for (const exportEdgeId of entry.exportEdgeIds) {
        const edge = document.interfaceCatalog.relations.find(item => item.id === exportEdgeId);
        assert.equal(edge?.kind, "EXPORTS");
        assert.ok(edge && (edge.sourceId === entry.declaration.id || edge.targetId === entry.declaration.id));
      }
    }
    for (const edge of canonical.value.ccm.edges.filter(item => item.resolution === "Unresolved")) {
      assert.ok(document.interfaceCatalog.relations.some(item => item.id === edge.id),
        `unresolved ${edge.kind} relation ${edge.id} must remain a canonical fact`);
      assert.ok(edge.unresolvedReason);
      assert.ok(edge.evidence.length > 0);
    }
    assert.equal(document.softwareEngineeringDiagram.nodeMappings.length, canonical.value.ccm.nodes.length);
    assert.ok(document.umlClassDiagram.nodeMappings.every(mapping =>
      document.umlClassDiagram.nodes.some(node => node.id === mapping.nodeId)));
    assert.doesNotMatch(projected.json, /"sourceBytes"|"createdAt"|"jobId"/);
    assert.equal(projected.sha256, digestProjection(projectArchitectureDocument(canonical.json, item.sources, canonical.sha256)));

    const replay = parseCanonicalArchitectureDocument(projected.json, canonical.json, item.sources, projected.sha256, canonical.sha256);
    assert.deepEqual(replay, projected);
  }

  const jsCanonical = await canonicalizeAnalysis(cases[0].ccm, jsSources);
  const jsDocument = projectArchitectureDocument(jsCanonical.json, jsSources);
  assert.ok(jsDocument.ok);
  if (jsDocument.ok) {
    assert.ok(jsDocument.json.includes("\\u0000"), "JSON output escapes a source declaration name containing NUL");
    assert.ok(jsDocument.json.includes("\\ud800"), "JSON output escapes a lone surrogate in source evidence");
  }
});

test("empty graph projection is canonical and source/hash checks fail closed", () => {
  const emptyCcm: CcmV1 = {
    schemaVersion: 1,
    snapshot,
    provenance: {
      analyzer: { name: "fixture", version: "1" },
      resolver: { name: "fixture", version: "1" },
      configHash,
    },
    files: [],
    nodes: [],
    edges: [],
    limitations: [],
  };
  const sources: Record<string, Uint8Array> = {};
  const canonical = canonicalizeCkg(emptyCcm, sources, configHash);
  assert.ok(canonical.ok);
  if (!canonical.ok) return;

  const projected = projectArchitectureDocument(canonical.json, sources, canonical.sha256);
  assert.ok(projected.ok);
  if (!projected.ok) return;
  assert.deepEqual(projected.value.interfaceCatalog.entries, []);
  assert.deepEqual(projected.value.interfaceCatalog.relations, []);
  assert.deepEqual(projected.value.softwareEngineeringDiagram.nodes, []);
  assert.deepEqual(projected.value.umlClassDiagram.nodes, []);

  assert.deepEqual(projectArchitectureDocument(canonical.json, sources, "0".repeat(64)), {
    ok: false,
    errorCode: "CKG_CONTENT_HASH_MISMATCH",
  });
  assert.deepEqual(parseCanonicalArchitectureDocument(projected.json, canonical.json, sources, "0".repeat(64)), {
    ok: false,
    errorCode: "ADD_CONTENT_HASH_MISMATCH",
  });
  assert.deepEqual(parseCanonicalArchitectureDocument("{", canonical.json, sources), {
    ok: false,
    errorCode: "ADD_JSON_INVALID",
  });
});

test("projection is stable for reordered source and CCM inputs without mutating caller data", async () => {
  const sources: Record<string, Uint8Array> = {
    "src/a.ts": bytes("export interface A { run(): void; }\n"),
    "src/b.ts": bytes("export class B extends MissingBase {}\n"),
  };
  const analysis = await analyzeJsReferences({ snapshot, sources });
  assert.ok(analysis.ccm);
  const canonical = canonicalizeCkg(analysis.ccm, sources, configHash);
  assert.ok(canonical.ok);
  if (!canonical.ok) return;

  const beforeSources = Object.fromEntries(Object.entries(sources).map(([path, value]) => [path, new Uint8Array(value)]));
  const first = projectArchitectureDocument(canonical.json, sources, canonical.sha256);
  assert.ok(first.ok);
  if (!first.ok) return;
  const reorderedCcm = {
    ...analysis.ccm,
    files: [...analysis.ccm.files].reverse(),
    nodes: [...analysis.ccm.nodes].reverse(),
    edges: [...analysis.ccm.edges].reverse(),
  };
  const reorderedCanonical = canonicalizeCkg(reorderedCcm, Object.fromEntries(Object.entries(sources).reverse()), configHash);
  assert.ok(reorderedCanonical.ok);
  if (!reorderedCanonical.ok) return;
  assert.equal(reorderedCanonical.json, canonical.json);

  const second = projectArchitectureDocument(reorderedCanonical.json, Object.fromEntries(Object.entries(sources).reverse()), reorderedCanonical.sha256);
  assert.deepEqual(second, first);
  assert.deepEqual(Object.keys(sources), Object.keys(beforeSources));
  for (const path of Object.keys(sources)) assert.deepEqual(sources[path], beforeSources[path]);
  assert.deepEqual(analysis.ccm.nodes, reorderedCcm.nodes.slice().reverse(), "the original analyzer CCM remains unmodified");
});

test("canonical document replay rejects metadata, catalog, mapping, and JSON tampering", async () => {
  const sources = { "src/model.ts": bytes("export class Child extends MissingBase {}\n") };
  const analysis = await analyzeJsReferences({ snapshot, sources });
  assert.ok(analysis.ccm);
  const canonical = canonicalizeCkg(analysis.ccm, sources, configHash);
  assert.ok(canonical.ok);
  if (!canonical.ok) return;
  const projected = projectArchitectureDocument(canonical.json, sources, canonical.sha256);
  assert.ok(projected.ok);
  if (!projected.ok) return;

  const alteredMetadata = JSON.parse(projected.json) as Record<string, unknown>;
  alteredMetadata.title = "Changed title";
  const alteredMetadataJson = JSON.stringify(alteredMetadata);
  assert.deepEqual(parseCanonicalArchitectureDocument(alteredMetadataJson, canonical.json, sources), {
    ok: false,
    errorCode: "ADD_JSON_NOT_CANONICAL",
  });

  const alteredCatalog = JSON.parse(projected.json) as {
    interfaceCatalog: { entries: Array<{ nodeIds: string[] }> };
  };
  alteredCatalog.interfaceCatalog.entries[0]!.nodeIds = [];
  assert.deepEqual(parseCanonicalArchitectureDocument(JSON.stringify(alteredCatalog), canonical.json, sources), {
    ok: false,
    errorCode: "ADD_JSON_NOT_CANONICAL",
  });

  const alteredMapping = JSON.parse(projected.json) as {
    softwareEngineeringDiagram: { nodeMappings: Array<{ mermaidLine: number }> };
  };
  alteredMapping.softwareEngineeringDiagram.nodeMappings[0]!.mermaidLine += 1;
  assert.deepEqual(parseCanonicalArchitectureDocument(JSON.stringify(alteredMapping), canonical.json, sources), {
    ok: false,
    errorCode: "ADD_JSON_NOT_CANONICAL",
  });

  assert.deepEqual(parseCanonicalArchitectureDocument(`${projected.json} `, canonical.json, sources), {
    ok: false,
    errorCode: "ADD_JSON_NOT_CANONICAL",
  });
  assert.deepEqual(parseCanonicalArchitectureDocument(`${projected.json.slice(0, -1)},"extra":true}`, canonical.json, sources), {
    ok: false,
    errorCode: "ADD_JSON_NOT_CANONICAL",
  });

  const changedSources = { "src/model.ts": new Uint8Array(sources["src/model.ts"]) };
  changedSources["src/model.ts"]![0] ^= 1;
  assert.deepEqual(parseCanonicalArchitectureDocument(projected.json, canonical.json, changedSources), {
    ok: false,
    errorCode: "CCM_FILE_HASH_MISMATCH",
  });
});
