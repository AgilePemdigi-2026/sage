import assert from "node:assert/strict";
import test from "node:test";
import type { ArchitectureDocumentV1 } from "../packages/documents/src/architecture-document.ts";
import { PDF_RENDERER_VERSION } from "../packages/documents/src/pdf-version.ts";
import { projectCompactPdfDiagrams } from "../packages/documents/src/pdf-projection.ts";
import { escapePdfHtml, pdfRendererInternals, renderPdfDocument } from "../packages/documents/src/pdf.ts";

function diagram(kind: "software-structure" | "uml-class") {
  return {
    kind,
    title: kind,
    mermaid: kind === "software-structure" ? "flowchart LR" : "classDiagram\n  note \"empty\"",
    nodes: [],
    edges: [],
    nodeMappings: [],
    edgeMappings: [],
    excludedNodeIds: [],
    excludedEdgeIds: [],
  };
}

function emptyDocument(): ArchitectureDocumentV1 {
  return {
    schemaVersion: "sage-add-v1",
    title: "Architecture Definition Document",
    ckgSha256: "a".repeat(64),
    configurationHash: "b".repeat(64),
    snapshot: { repository: "fixture/pdf", branch: "main", commitSha: "c".repeat(40) },
    provenance: {
      analyzer: { name: "fixture", version: "1" },
      resolver: { name: "fixture", version: "1" },
      configHash: "b".repeat(64),
    },
    canonicalCounts: { nodes: 0, edges: 0, containmentEdges: 0, referenceEdges: 0, exactEdges: 0, unresolvedEdges: 0 },
    files: [],
    limitations: [],
    interfaceCatalog: { scope: "source declarations", entries: [], relations: [] },
    softwareEngineeringDiagram: diagram("software-structure"),
    umlClassDiagram: diagram("uml-class"),
  };
}

test("PDF renderer version is stable and HTML escaping keeps source labels inert", () => {
  assert.equal(PDF_RENDERER_VERSION, "2.2.0");
  assert.equal(escapePdfHtml(`</td><script>alert('x')</script>&`), "&lt;/td&gt;&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;&amp;");
  assert.equal(escapePdfHtml("nul\u0000name"), "nul\\u0000name");
  assert.equal(pdfRendererInternals.errorCode(new Error("page.evaluate: Error: PDF_DIAGRAM_FILTER_REJECTED\n    at eval")), "PDF_DIAGRAM_FILTER_REJECTED");
  assert.equal(pdfRendererInternals.errorCode(new Error("an unrelated browser failure")), "PDF_RENDER_FAILED");
});

test("compact PDF embeds each diagram once and omits machine registers and hashes", () => {
  const document = emptyDocument();
  const compactViews = projectCompactPdfDiagrams(document.softwareEngineeringDiagram, document.umlClassDiagram);
  const html = pdfRendererInternals.renderDocumentHtml(document, ['<svg viewBox="0 0 3600 2000"><text>Structure</text></svg>', '<svg viewBox="0 0 320 200"><text>Classes</text></svg>'], compactViews);
  assert.equal((html.match(/<svg /g) ?? []).length, 2);
  assert.ok(!html.includes(document.ckgSha256));
  assert.ok(!html.includes(document.snapshot.commitSha));
  assert.doesNotMatch(html, /data-grid|Detail A1|Canonical node and edge register/);
  assert.match(html, /preserveAspectRatio="xMidYMid meet"/);
  assert.match(html, /menampilkan 0 dari 0 node, 0 dari 0 kelompok relasi/);
});

test("SVG viewport sizing updates root attributes without changing child rectangle dimensions", () => {
  const source = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 160" width="320"><rect x="1" y="2" width="40" height="20" stroke-width="3"/></svg>`;
  const updated = pdfRendererInternals.setSvgRootAttributes(source, {
    viewBox: "10 20 1040 600",
    width: "1040px",
    height: "600px",
  });
  const root = /<svg\b[^>]*>/i.exec(updated)?.[0] ?? "";
  assert.match(root, /\bviewBox="10 20 1040 600"/);
  assert.match(root, /\bwidth="1040px"/);
  assert.match(root, /\bheight="600px"/);
  assert.match(updated, /<rect x="1" y="2" width="40" height="20" stroke-width="3"\/>/,
    "a missing root height must not rewrite the child rect height");
});

test("PDF source restores projection underscores while preserving literal #95; labels", () => {
  // These are the exact mermaidText encodings for UNKNOWN_RECEIVER and UNKNOWN#95;RECEIVER.
  const underscoreLabel = 'flowchart LR\n  A["UNKNOWN#95;RECEIVER"]';
  const literalTokenLabel = 'flowchart LR\n  A["UNKNOWN#35;95#59;RECEIVER"]';
  assert.equal(
    pdfRendererInternals.normalizeMermaidUnderscores(underscoreLabel),
    'flowchart LR\n  A["UNKNOWN_RECEIVER"]',
  );
  assert.equal(
    pdfRendererInternals.normalizeMermaidUnderscores(literalTokenLabel),
    literalTokenLabel,
    "escaped literal hash and semicolon tokens must not be recursively decoded",
  );

  const otherProjectionEscapes = 'flowchart LR\n  A["#60;script#62; #35; #59;"]';
  assert.equal(pdfRendererInternals.normalizeMermaidUnderscores(otherProjectionEscapes), otherProjectionEscapes,
    "other Mermaid/XML delimiter escapes remain unchanged");
});

test("PDF preflight leaves renderer caps for the bounded projection and rejects unsafe or incomplete data", async () => {
  const document = emptyDocument();
  assert.equal(pdfRendererInternals.validatePdfDocument(document), null);

  const oversized = structuredClone(document);
  oversized.softwareEngineeringDiagram.mermaid = `flowchart LR\n${"x".repeat(50_000)}`;
  assert.equal(pdfRendererInternals.validatePdfDocument(oversized), null,
    "the saved source rendering may exceed renderer limits when the actual bounded view remains small");
  const projected = projectCompactPdfDiagrams(oversized.softwareEngineeringDiagram, oversized.umlClassDiagram);
  assert.equal(pdfRendererInternals.validateRendererDiagram(projected.software), null);
  assert.ok(projected.software.mermaid.length < 50_000);

  const unsafe = structuredClone(document);
  unsafe.umlClassDiagram.mermaid = "classDiagram\n  click A \"https://example.invalid\"";
  assert.equal(pdfRendererInternals.validatePdfDocument(unsafe), "PDF_DIAGRAM_SOURCE_INVALID");

  const incomplete = structuredClone(document);
  incomplete.canonicalCounts.nodes = 1;
  assert.equal(pdfRendererInternals.validatePdfDocument(incomplete), "PDF_DOCUMENT_INVALID");

  const actualRendererOversized = structuredClone(document.softwareEngineeringDiagram);
  actualRendererOversized.mermaid = `flowchart LR\n${"x".repeat(50_000)}`;
  assert.equal(pdfRendererInternals.validateRendererDiagram(actualRendererOversized), "PDF_DIAGRAM_SOURCE_LIMIT_EXCEEDED");
});

test("pre-aborted render requests fail promptly without launching a browser", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(renderPdfDocument(emptyDocument(), { signal: controller.signal }), /PDF_RENDER_ABORTED/);
});
