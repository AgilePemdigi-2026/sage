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
  narratives: {
    dataBaseline: "One customer object is identified.", applicationBaseline: "One web application is identified.",
    dataViewIntroduction: "Data view short introduction.", dataViewInterpretation: "data view reading explanation.",
    applicationViewIntroduction: "Application view short introduction.", applicationViewInterpretation: "application view reading explanation.",
  },
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
  const latex = createAddLatex(model, overlay, evidenceUrl, { modelHash, generatedAt: "2026-11-19T02:00:00.000Z" });

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
  assert.ok(latex.includes("ARCHITECTURE DEFINITION DOCUMENTS") && latex.includes("Baseline Data and Application Architecture"), "cover uses the requested ADD title and baseline subtitle");
  assert.ok(latex.includes("\\addto\\captionsindonesian{\\renewcommand{\\contentsname}{DAFTAR ISI}}") && latex.includes("\\cfttoctitlefont}{\\hfill\\Large\\bfseries}"), "contents title is uppercase and centered at the top");
  assert.ok(!latex.includes("\\renewcommand{\\cftsecfont}{\\normalfont\\MakeUppercase}"), "contents links keep hyperref-compatible entry styling");
  assert.ok(latex.includes("\\titleformat{\\section}[block]{\\normalfont\\Large\\bfseries\\raggedright}"), "numbered section headings are left-aligned");
  assert.ok(latex.includes("\\fancyhead[L]{\\small\\shortstack[l]{SAGE\\\\ARCHITECTURE DEFINITION DOCUMENTS}}"), "running header identifies SAGE and its ADD title");
  assert.ok(latex.includes("\\fancyhead[R]{\\small 19 November 2026}"), "running header shows only the Jakarta export date on the right");
  assert.ok(!latex.includes("\\fancyhead[L]{\\small\\shortstack[l]{Repository:") && !latex.includes("\\fancyhead[R]{\\small ADD}"), "running header omits repository and branch metadata");
  assert.ok(latex.includes("\\titleformat{\\subsection}[block]{\\normalfont\\large\\bfseries\\raggedright}"), "subsection headings are left-aligned");
  assert.ok(latex.includes("\\setlength{\\tabcolsep}{4pt}") && latex.includes("\\setlength{\\extrarowheight}{2pt}"), "table cells have more inner spacing");
  assert.ok(latex.includes("\\centering\\arraybackslash \\textbf{Data entity}"), "repeated table headings are centered");
  assert.ok(latex.includes("\\endfirsthead") && latex.includes("\\endhead"), "long table headers repeat on continuation pages");
  assert.ok(!latex.includes("PHASE C") && !latex.includes("Phase C:"), "cover, contents, and running header omit Phase C wording");
  assert.ok(!latex.includes("\\begin{landscape}") && !latex.includes("pdflscape"), "ADD pages remain portrait with upright headers and page numbers");
  assert.ok(!latex.includes("\\begin{figure}"), "diagrams remain inline so page composition stays controlled");
  assert.ok(latex.includes("\\renewcommand{\\thefigure}{\\thesection.\\arabic{figure}}"), "figure numbers use the numbered ADD section as their prefix");
  const dataIntro = latex.indexOf("Data view short introduction.");
  const firstDiagram = latex.indexOf("\\begin{tikzpicture}", dataIntro);
  const dataCaption = latex.indexOf("\\captionof{figure}{ArchiMate Data Structure View}", firstDiagram);
  const dataInterpretation = latex.indexOf("Gambar~\\ref{fig:dataStructure-1} memperlihatkan bahwa", dataCaption);
  assert.ok(dataIntro >= 0 && dataIntro < firstDiagram && firstDiagram < dataCaption && dataCaption < dataInterpretation, "PDF order is short introduction, diagram, caption, then an interpretation that cites the figure");
  assert.ok(latex.includes("Gambar~\\ref{fig:applicationCooperation-1} memperlihatkan bahwa"), "application view interpretation cites its printed figure");
  assert.ok(markdown.includes("Data view short introduction.") && markdown.includes("**Interpretation of the data view:** data view reading explanation."), "Markdown exposes the same bounded view narratives around its detailed relationship register");
  assert.ok(!latex.includes("BAB 4"));
});

test("ADD exports reject malformed canonical model hashes", () => {
  assert.throws(() => createAddMarkdown(model, emptyAddReviewOverlay(), evidenceUrl, { modelHash: "not-a-sha256" }), /Invalid ADD export model hash/u);
  assert.throws(() => createAddLatex(model, emptyAddReviewOverlay(), evidenceUrl, { modelHash: "not-a-sha256" }), /Invalid ADD export model hash/u);
});

test("PDF keeps dense evidence rows within a readable compact table", () => {
  const expanded = structuredClone(model);
  expanded.elements[0]!.evidence = Array.from({ length: 5 }, (_, index) => ({
    filePath: `src/evidence-${index + 1}.ts`, fileSha256: "d".repeat(64), startByte: index, endByte: index + 1,
    startLine: index + 1, endLine: index + 2, startColumn: 1, endColumn: 2, role: "reference" as const,
  }));

  const latex = createAddLatex(expanded, emptyAddReviewOverlay(), evidenceUrl, { modelHash });
  assert.ok(latex.includes("+ 2 more evidence links in Markdown"), "PDF reports when a row has evidence links omitted for compactness");
  assert.ok(latex.includes("src/evidence-1.ts") && latex.includes("src/evidence-3.ts"), "PDF keeps the first three evidence links");
  assert.ok(!latex.includes("src/evidence-4.ts") && !latex.includes("src/evidence-5.ts"), "PDF omits additional links instead of overflowing the table row");
});

test("Application Cooperation PDF keeps all relationships on upright, connected pages", () => {
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
  const diagramStart = latex.indexOf("\\section{Application Design (Baseline)}");
  const diagramEnd = latex.indexOf("\\section{Catalog Design}", diagramStart);
  const diagrams = latex.slice(diagramStart, diagramEnd);
  assert.equal((diagrams.match(/\\draw\[/gu) ?? []).length, 17, "all 17 source relationships are drawn, including continuation pages");
  assert.equal((diagrams.match(/\\clearpage/gu) ?? []).length, 3, "five relationship rows are kept per upright A4 diagram page");
  assert.ok(diagrams.includes("\\draw[draw=gray!75,thick,{Diamond[fill=gray]}-]") && diagrams.includes("Composition: exposes interface") && diagrams.includes("PROVEN"), "ArchiMate relationship notation and evidence confidence remain distinct");
  assert.ok(!diagrams.includes("fill=white") && diagrams.includes("-- (t0_0.west)"), "edge labels do not mask the continuous relationship line");
});

test("Data Structure PDF keeps relationships on upright pages with clear connectors", () => {
  const expanded = structuredClone(model);
  const dataIds: string[] = [];
  for (let index = 0; index < 30; index++) {
    const elementId = `data:entity-${index}`;
    dataIds.push(elementId);
    expanded.elements.push({
      id: elementId, type: "DataObject", name: `Entity ${index}`, description: null,
      origin: "source", featureGroup: "Records", evidence: expanded.elements[2]!.evidence, review: "unreviewed",
    });
    expanded.catalogs.dataEntities.push({ elementId, owner: null, description: null });
    expanded.views.dataStructure.elementIds.push(elementId);
  }
  expanded.views.dataStructure.relationshipIds = [];
  for (let index = 0; index < 17; index++) {
    const relationshipId = `data-relationship:${index}`;
    expanded.relationships.push({
      id: relationshipId, type: "AssociationRelationship", sourceId: dataIds[index]!, targetId: dataIds[24 + (index % 6)]!,
      label: `links entity ${index}`, origin: "source", confidence: "proven", reason: "Direct source relation.",
      evidence: expanded.elements[2]!.evidence, review: "unreviewed",
    });
    expanded.views.dataStructure.relationshipIds.push(relationshipId);
  }

  const latex = createAddLatex(expanded, emptyAddReviewOverlay(), evidenceUrl, { modelHash });
  const diagramStart = latex.indexOf("\\section{Logical Data Model (Baseline)}");
  const diagramEnd = latex.indexOf("\\section{Data Management Process Model (Baseline)}", diagramStart);
  const diagrams = latex.slice(diagramStart, diagramEnd);
  assert.equal((diagrams.match(/\\draw\[/gu) ?? []).length, 17, "all relationships are drawn even when endpoint nodes fall in different data catalog pages");
  for (let index = 0; index < 17; index++) assert.ok(diagrams.includes(`links entity ${index}`));
  assert.equal((diagrams.match(/\\clearpage/gu) ?? []).length, 4, "all 17 relationships and seven isolated objects continue across upright A4 pages");
  assert.ok(diagrams.includes("Association: links entity 0") && diagrams.includes("\\draw[draw=gray!75,thick]"), "the data-object association type, label, and connector are visible");
  assert.ok(!diagrams.includes("\\begin{landscape}"), "data views keep page headings and numbers upright");
});
