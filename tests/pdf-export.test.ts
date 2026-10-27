import assert from "node:assert/strict";
import test from "node:test";
import type { ArchitectureDocumentV1 } from "../packages/documents/src/architecture-document.ts";
import { PDF_RENDERER_VERSION } from "../packages/documents/src/pdf-version.ts";
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
  assert.equal(PDF_RENDERER_VERSION, "1.0.0");
  assert.equal(escapePdfHtml(`</td><script>alert('x')</script>&`), "&lt;/td&gt;&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;&amp;");
  assert.equal(escapePdfHtml("nul\u0000name"), "nul\\u0000name");
  assert.equal(pdfRendererInternals.errorCode(new Error("page.evaluate: Error: PDF_DIAGRAM_FILTER_REJECTED\n    at eval")), "PDF_DIAGRAM_FILTER_REJECTED");
  assert.equal(pdfRendererInternals.errorCode(new Error("an unrelated browser failure")), "PDF_RENDER_FAILED");
});

test("diagram tile planner keeps page-sized overlaps while covering every edge of a large diagram", () => {
  const layout = pdfRendererInternals.makeDiagramLayout({ x: 0, y: 0, width: 3_600, height: 2_000 });
  assert.equal(layout.overview, true);
  assert.ok(layout.tiles.length > 1 && layout.tiles.length <= 24);
  assert.equal(layout.tiles[0]!.label, "A1");
  assert.ok(layout.tiles.every(tile => tile.width > 0 && tile.height > 0 && tile.width <= 1_040 && tile.height <= 600));

  const covered = (axis: "x" | "y", size: number) => {
    const intervals = layout.tiles.map(tile => [tile[axis] - layout.viewBox[axis], tile[axis] - layout.viewBox[axis] + tile[axis === "x" ? "width" : "height"]] as const)
      .sort((left, right) => left[0] - right[0]);
    assert.equal(intervals[0]![0], 0);
    assert.ok(intervals.at(-1)![1] >= size, `${axis} tiles reach the last graph coordinate`);
    for (let index = 1; index < intervals.length; index += 1) {
      assert.ok(intervals[index]![0] <= intervals[index - 1]![1], `${axis} tiles overlap without a gap`);
    }
  };
  covered("x", layout.viewBox.width);
  covered("y", layout.viewBox.height);

  assert.throws(
    () => pdfRendererInternals.makeDiagramLayout({ x: 0, y: 0, width: 40_000, height: 40_000 }),
    /PDF_DIAGRAM_TILE_LIMIT_EXCEEDED/,
    "oversized diagrams fail at the page budget instead of omitting nodes",
  );
});

test("PDF preflight rejects unsafe, oversized, or incomplete diagram data before Chromium starts", async () => {
  const document = emptyDocument();
  assert.equal(pdfRendererInternals.validatePdfDocument(document), null);

  const oversized = structuredClone(document);
  oversized.softwareEngineeringDiagram.mermaid = `flowchart LR\n${"x".repeat(50_000)}`;
  assert.equal(pdfRendererInternals.validatePdfDocument(oversized), "PDF_DIAGRAM_SOURCE_LIMIT_EXCEEDED");
  await assert.rejects(renderPdfDocument(oversized), /PDF_DIAGRAM_SOURCE_LIMIT_EXCEEDED/);

  const unsafe = structuredClone(document);
  unsafe.umlClassDiagram.mermaid = "classDiagram\n  click A \"https://example.invalid\"";
  assert.equal(pdfRendererInternals.validatePdfDocument(unsafe), "PDF_DIAGRAM_SOURCE_INVALID");

  const incomplete = structuredClone(document);
  incomplete.canonicalCounts.nodes = 1;
  assert.equal(pdfRendererInternals.validatePdfDocument(incomplete), "PDF_DOCUMENT_INVALID");
});

test("pre-aborted render requests fail promptly without launching a browser", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(renderPdfDocument(emptyDocument(), { signal: controller.signal }), /PDF_RENDER_ABORTED/);
});
