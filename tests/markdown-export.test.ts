import assert from "node:assert/strict";
import test from "node:test";
import { analyzeReferences } from "@sage/analyzer-js";
import { canonicalizeCkg, type CcmSnapshot } from "@sage/contracts";
import { projectArchitectureDocument } from "../packages/documents/src/architecture-document.ts";
import { MARKDOWN_RENDERER_VERSION, renderMarkdownDocument } from "../packages/documents/src/index.ts";

const configHash = "a".repeat(64);
const snapshot: CcmSnapshot = {
  repository: "fixture/markdown-export",
  branch: "feature/markdown",
  commitSha: "d".repeat(40),
};
const sources = {
  "src/model.ts": new TextEncoder().encode(`
export interface Contract { run(): void; }
export class Base {}
export class Child extends Base implements Contract {
  run(): void { missingCall(); }
}
export class UnknownChild extends MissingBase {}
`),
};

async function buildDocument() {
  const analysis = await analyzeReferences({ snapshot, sources });
  assert.ok(analysis.ccm, `analyzer did not produce a CCM: ${analysis.errorCode}`);
  const canonical = canonicalizeCkg(analysis.ccm, sources, configHash);
  assert.ok(canonical.ok, canonical.ok ? undefined : `CKG validation failed: ${canonical.errorCode}`);
  const projected = projectArchitectureDocument(canonical.json, sources, canonical.sha256);
  assert.ok(projected.ok, projected.ok ? undefined : `document projection failed: ${projected.errorCode}`);
  return projected.value;
}

test("Markdown export is deterministic and includes every architecture artifact and canonical evidence", async () => {
  const document = await buildDocument();
  const markdown = renderMarkdownDocument(document);

  assert.equal(MARKDOWN_RENDERER_VERSION, "1.0.0");
  assert.equal(renderMarkdownDocument(document), markdown, "identical retries produce identical bytes");
  assert.match(markdown, /^## Interface Catalog$/m);
  assert.match(markdown, /^## Software Engineering Diagram$/m);
  assert.match(markdown, /^## UML Class Diagram$/m);
  assert.ok(markdown.includes(document.softwareEngineeringDiagram.kind));
  assert.ok(markdown.includes(document.softwareEngineeringDiagram.title));
  assert.ok(markdown.includes(document.umlClassDiagram.kind));
  assert.ok(markdown.includes(document.umlClassDiagram.title));
  assert.ok(markdown.includes(document.softwareEngineeringDiagram.mermaid));
  assert.ok(markdown.includes(document.umlClassDiagram.mermaid));

  for (const value of [
    document.schemaVersion,
    document.snapshot.repository,
    document.snapshot.branch ?? "null",
    document.snapshot.commitSha,
    document.ckgSha256,
    document.configurationHash,
    document.provenance.analyzer.name,
    document.provenance.analyzer.version,
    document.provenance.resolver.name,
    document.provenance.resolver.version,
    document.files[0]!.path,
    document.files[0]!.sha256,
    document.files[0]!.status,
  ]) assert.ok(markdown.includes(value), `export includes ${value}`);

  const evidence = [
    ...document.interfaceCatalog.entries.flatMap(entry => entry.evidence),
    ...document.interfaceCatalog.relations.flatMap(edge => edge.evidence),
    ...document.softwareEngineeringDiagram.nodes.flatMap(node => node.location ? [node.location] : []),
    ...document.softwareEngineeringDiagram.edges.flatMap(edge => edge.evidence),
    ...document.umlClassDiagram.nodes.flatMap(node => node.location ? [node.location] : []),
    ...document.umlClassDiagram.edges.flatMap(edge => edge.evidence),
  ];
  assert.ok(evidence.length > 0, "the actual analyzer fixture supplies source evidence");
  for (const span of evidence) {
    for (const value of [span.filePath, span.fileSha256, String(span.startByte), String(span.endByte),
      String(span.startLine), String(span.endLine), String(span.startColumn), String(span.endColumn), span.role]) {
      assert.ok(markdown.includes(value), `export includes evidence field ${value}`);
    }
  }
  for (const entry of document.interfaceCatalog.entries) {
    assert.ok(markdown.includes(entry.declaration.id), `catalog includes node ID ${entry.declaration.id}`);
    for (const edgeId of entry.edgeIds) assert.ok(markdown.includes(edgeId), `catalog includes edge ID ${edgeId}`);
  }
  for (const edge of document.interfaceCatalog.relations) {
    assert.ok(markdown.includes(edge.sourceId));
    assert.ok(markdown.includes(edge.targetId));
    assert.ok(markdown.includes(edge.resolution));
  }
  assert.match(markdown, /```mermaid\n/);
  assert.doesNotMatch(markdown, /^!\[/m, "the document has no external image resources");
});

test("Markdown export keeps hostile labels, paths, limitations, and Mermaid fences inert", async () => {
  const document = structuredClone(await buildDocument());
  const hostile = `Report\n# Injected\n<script>alert("x")</script> [link](javascript:alert(1)) https://evil.invalid \`\`\``;
  document.title = hostile;
  document.snapshot.repository = hostile;
  document.files[0]!.path = hostile;
  document.interfaceCatalog.entries[0]!.declaration.name = hostile;
  document.limitations = [{ path: hostile, reason: hostile, stage: hostile }];
  const injectedMermaid = `flowchart LR\n  A["safe"]\n\`\`\`\n# injected markdown\n<script>alert(1)</script>`;
  document.softwareEngineeringDiagram.mermaid = injectedMermaid;

  const markdown = renderMarkdownDocument(document);
  assert.match(markdown, /^## Status and limitations$/m);
  assert.ok(markdown.includes("Limitation:"));
  assert.ok(markdown.includes("```` Report\\n# Injected\\n<script>alert(\"x\")</script>"),
    "inline values use a longer code span and make line breaks visible");
  assert.doesNotMatch(markdown, /^# Injected$/m, "hostile newlines cannot add a Markdown heading");
  assert.doesNotMatch(markdown, /^\[link\]\(javascript:/m, "hostile labels cannot create a Markdown link");
  assert.ok(markdown.includes("javascript:alert(1)"), "the original label remains readable as code");
  assert.ok(markdown.includes("https://evil.invalid"), "URL-like text remains visible without a resource reference");
  assert.ok(markdown.includes(`${injectedMermaid}\n\`\`\`\``),
    "a longer Mermaid fence contains embedded fence markers and hostile lines");
  assert.doesNotMatch(markdown, /^!\[/m, "hostile paths cannot create external image references");
});
