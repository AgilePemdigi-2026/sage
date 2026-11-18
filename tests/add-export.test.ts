import assert from "node:assert/strict";
import test from "node:test";
import { emptyAddReviewOverlay } from "../packages/documents/src/add-overlay.ts";
import type { AddBaselineModel } from "../packages/documents/src/baseline-add-model.ts";
import { createAddLatex } from "../packages/documents/src/baseline-latex.ts";
import { createAddMarkdown } from "../packages/documents/src/baseline-markdown.ts";

const modelHash = "c".repeat(64);
const commitSha = "a".repeat(40);
const model: AddBaselineModel = {
  schemaVersion: "sage-add-baseline-v1",
  archimateVersion: "3.2",
  generation: { extractorVersion: "test", llmOutcome: "not-requested", llmModel: null },
  snapshot: { repository: "sample/library", branch: "main", commitSha },
  sourceCkgHash: "b".repeat(64),
  elements: [
    { id: "app:web", type: "ApplicationComponent", name: "Web portal", description: null, origin: "source", featureGroup: "Web", evidence: [{ filePath: "src/routes.ts", fileSha256: "d".repeat(64), startByte: 0, endByte: 12, startLine: 3, endLine: 5, startColumn: 1, endColumn: 13, role: "reference" }], review: "unreviewed" },
    { id: "fn:create", type: "ApplicationFunction", name: "Create customer", description: null, origin: "source", featureGroup: "Customers", evidence: [{ filePath: "src/routes.ts", fileSha256: "d".repeat(64), startByte: 0, endByte: 12, startLine: 3, endLine: 5, startColumn: 1, endColumn: 13, role: "reference" }], review: "unreviewed" },
    { id: "data:customer", type: "DataObject", name: "Customer", description: "Customer record", origin: "source", featureGroup: "Data", evidence: [{ filePath: "src/models/customer.ts", fileSha256: "e".repeat(64), startByte: 0, endByte: 12, startLine: 8, endLine: 11, startColumn: 1, endColumn: 13, role: "reference" }], review: "unreviewed" },
  ],
  relationships: [],
  catalogs: {
    dataEntities: [{ elementId: "data:customer", owner: null, description: "Customer record" }],
    applicationPortfolio: [{ elementId: "app:web", planned: false, description: null }],
    interfaces: [],
  },
  matrices: {
    applicationData: [{ applicationId: "app:web", dataId: "data:customer", create: "yes", read: "unknown", update: "unknown", delete: "unknown", evidence: [{ filePath: "src/routes.ts", fileSha256: "d".repeat(64), startByte: 0, endByte: 12, startLine: 3, endLine: 5, startColumn: 1, endColumn: 13, role: "reference" }] }],
    applicationInteractions: [],
  },
  views: {
    dataStructure: { elementIds: ["data:customer"], relationshipIds: [] },
    applicationCooperation: { elementIds: ["app:web", "fn:create"], relationshipIds: [] },
  },
  narratives: { dataBaseline: "One customer object is identified.", applicationBaseline: "One web application is identified." },
  limitations: ["Owner requires confirmation."],
};

const evidenceUrl = (span: { filePath: string; startLine: number; endLine: number }) =>
  `https://github.com/sample/library/blob/${commitSha}/${span.filePath}#L${span.startLine}-L${span.endLine}`;

test("Markdown and LaTeX render the same canonical hash, review revision, and overlay corrections", () => {
  const overlay = {
    ...emptyAddReviewOverlay(),
    revision: 7,
    status: "reviewed" as const,
    elements: {
      "app:web": { name: "Customer portal", featureGroup: "Customer access", review: "confirmed" as const },
      "data:customer": { name: "Customer record", featureGroup: "Customer data", review: "confirmed" as const },
    },
  };
  const markdown = createAddMarkdown(model, overlay, evidenceUrl, { modelHash });
  const latex = createAddLatex(model, overlay, evidenceUrl, { modelHash });

  for (const output of [markdown, latex]) {
    assert.ok(output.includes(modelHash), "export identifies the persisted canonical ADD model");
    assert.ok(output.includes("revision 7"), "export identifies the same review overlay revision");
    assert.ok(output.includes("Customer record"), "export includes the corrected data label");
    assert.ok(output.includes("Customer data"), "export includes the corrected feature group");
    assert.ok(output.includes("confirmed"), "export carries the review status");
    assert.ok(output.includes("src/models/customer.ts"), "export retains source evidence path");
    assert.ok(output.includes(commitSha), "export keeps the pinned commit identity");
  }
  assert.ok(markdown.includes("#L8-L11"));
  assert.ok(latex.includes("#L8-L11"));
  assert.ok(markdown.includes("| Review overlay | reviewed, revision 7 |"));
  assert.ok(latex.includes("Review overlay") && latex.includes("reviewed, revision 7"));
  assert.equal(model.elements.find(element => element.id === "data:customer")?.name, "Customer", "rendering an overlay does not mutate canonical source facts");
  assert.ok(latex.includes("a4paper"), "LaTeX output declares A4 paper");
  assert.ok(latex.indexOf("\\PassOptionsToPackage{table}{xcolor}") < latex.indexOf("\\usepackage{tikz}"), "table colors are passed before TikZ loads xcolor");
  assert.ok(latex.includes("C = Create, R = Read, U = Update, D = Delete") && latex.includes("Y = confirmed, N = explicitly absent, ? = unknown"), "compact CRUD matrix declares its legend");
  assert.ok(latex.includes("arraybackslash Y") && latex.includes("arraybackslash ?"), "CRUD cells use compact, unambiguous marks");
  assert.ok(latex.includes("\\renewcommand{\\thesection}{\\arabic{section}}"), "LaTeX uses the agreed simple section numbering");
  assert.ok(!latex.includes("BAB 4"));
});

test("ADD exports reject malformed canonical model hashes", () => {
  assert.throws(() => createAddMarkdown(model, emptyAddReviewOverlay(), evidenceUrl, { modelHash: "not-a-sha256" }), /Invalid ADD export model hash/u);
  assert.throws(() => createAddLatex(model, emptyAddReviewOverlay(), evidenceUrl, { modelHash: "not-a-sha256" }), /Invalid ADD export model hash/u);
});

test("Application Cooperation PDF keeps all relationships across landscape pages", () => {
  const expanded = structuredClone(model);
  const applicationId = "app:web";
  for (let index = 0; index < 17; index++) {
    const elementId = `interface:${index}`;
    const relationshipId = `relationship:${index}`;
    expanded.elements.push({
      id: elementId, type: "ApplicationInterface", name: `GET /api/items/${index}`, description: null,
      origin: "source", featureGroup: "Items", evidence: expanded.elements[0]!.evidence, review: "unreviewed",
    });
    expanded.relationships.push({
      id: relationshipId, type: "CompositionRelationship", sourceId: applicationId, targetId: elementId,
      label: "exposes interface", origin: "source", confidence: "proven", reason: "Directly represented fixture relationship.",
      evidence: expanded.elements[0]!.evidence, review: "unreviewed",
    });
    expanded.views.applicationCooperation.elementIds.push(elementId);
    expanded.views.applicationCooperation.relationshipIds.push(relationshipId);
  }

  const latex = createAddLatex(expanded, emptyAddReviewOverlay(), evidenceUrl, { modelHash });
  const diagramStart = latex.indexOf("ArchiMate Application Cooperation View");
  const diagramEnd = latex.indexOf("Full relationship explanations remain available", diagramStart);
  const diagrams = latex.slice(diagramStart, diagramEnd);
  assert.equal((diagrams.match(/\\draw\[/gu) ?? []).length, 17, "all 17 source relationships are drawn, including continuation pages");
  assert.match(diagrams, /\\begin\{landscape\}/u, "the multi-lane application view uses landscape pages");
});
