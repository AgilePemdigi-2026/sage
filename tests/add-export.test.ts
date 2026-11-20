import assert from "node:assert/strict";
import test from "node:test";
import { emptyAddReviewOverlay } from "../packages/documents/src/add-overlay.ts";
import type { AddBaselineModel } from "../packages/documents/src/baseline-add-model.ts";
import { createAddLatex } from "../packages/documents/src/baseline-latex.ts";
import { createAddMarkdown } from "../packages/documents/src/baseline-markdown.ts";
import { coreRelationshipLabel, projectCoreBaselineView } from "../packages/documents/src/baseline-core-views.ts";

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
    { id: "app:catalog", type: "ApplicationService", name: "Catalog service", description: null, origin: "source", featureGroup: "Catalog", evidence: [{ filePath: "src/routes.ts", fileSha256: "d".repeat(64), startByte: 0, endByte: 12, startLine: 3, endLine: 5, startColumn: 1, endColumn: 13, role: "reference" }], review: "unreviewed" },
    { id: "fn:create", type: "ApplicationFunction", name: "Create customer", description: null, origin: "source", featureGroup: "Customers", evidence: [{ filePath: "src/routes.ts", fileSha256: "d".repeat(64), startByte: 0, endByte: 12, startLine: 3, endLine: 5, startColumn: 1, endColumn: 13, role: "reference" }], review: "unreviewed" },
    { id: "data:customer", type: "DataObject", name: "Customer", description: "Customer record", origin: "source", featureGroup: "Data", evidence: [{ filePath: "src/models/customer.ts", fileSha256: "e".repeat(64), startByte: 0, endByte: 12, startLine: 8, endLine: 11, startColumn: 1, endColumn: 13, role: "reference" }], review: "unreviewed" },
    { id: "data:author", type: "DataObject", name: "Author", description: "Author record", origin: "source", featureGroup: "Data", evidence: [{ filePath: "src/models/author.ts", fileSha256: "e".repeat(64), startByte: 0, endByte: 12, startLine: 4, endLine: 7, startColumn: 1, endColumn: 13, role: "reference" }], review: "unreviewed" },
  ],
  relationships: [
    { id: "rel:app-catalog", type: "CompositionRelationship", sourceId: "app:web", targetId: "app:catalog", label: "contains catalog service", origin: "source", confidence: "proven", reason: "Direct source evidence.", evidence: [{ filePath: "src/routes.ts", fileSha256: "d".repeat(64), startByte: 0, endByte: 12, startLine: 3, endLine: 5, startColumn: 1, endColumn: 13, role: "reference" }], review: "unreviewed" },
    { id: "rel:customer-author", type: "AssociationRelationship", sourceId: "data:customer", targetId: "data:author", label: "references data object", origin: "source", confidence: "proven", reason: "Direct source evidence.", evidence: [{ filePath: "src/models/customer.ts", fileSha256: "e".repeat(64), startByte: 0, endByte: 12, startLine: 8, endLine: 11, startColumn: 1, endColumn: 13, role: "reference" }], review: "unreviewed" },
  ],
  catalogs: {
    dataEntities: [{ elementId: "data:customer", owner: null, description: "Customer record" }, { elementId: "data:author", owner: null, description: "Author record" }],
    applicationPortfolio: [{ elementId: "app:web", planned: false, description: null }, { elementId: "app:catalog", planned: false, description: null }],
    interfaces: [],
  },
  matrices: {
    applicationData: [{ applicationId: "app:web", dataId: "data:customer", create: "yes", read: "unknown", update: "unknown", delete: "unknown", evidence: [{ filePath: "src/routes.ts", fileSha256: "d".repeat(64), startByte: 0, endByte: 12, startLine: 3, endLine: 5, startColumn: 1, endColumn: 13, role: "reference" }] }],
    applicationInteractions: [],
  },
  views: {
    dataStructure: { elementIds: ["data:customer", "data:author"], relationshipIds: ["rel:customer-author"] },
    applicationCooperation: { elementIds: ["app:web", "app:catalog", "fn:create"], relationshipIds: ["rel:app-catalog"] },
  },
  narratives: {
    dataBaseline: "One customer object is identified.", applicationBaseline: "One web application is identified.",
    dataViewIntroduction: "Data view short introduction.", dataViewInterpretation: "data view reading explanation.",
    applicationViewIntroduction: "Application view short introduction.", applicationViewInterpretation: "application view reading explanation.",
  },
  limitations: ["Owner requires confirmation."],
};

const evidenceUrl = (span: { filePath: string; startLine: number; endLine: number }, fileOnly = false) =>
  `https://github.com/sample/library/blob/${commitSha}/${span.filePath}${fileOnly ? "" : `#L${span.startLine}-L${span.endLine}`}`;

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
  assert.ok(!markdown.includes("#L") && !latex.includes("#L"), "ADD exports link to the pinned file without line anchors to keep dense tables readable");
  assert.ok(markdown.includes("| Review overlay | reviewed, revision 7 |"));
  assert.ok(latex.includes("Review overlay") && latex.includes("reviewed, revision 7"));
  assert.equal(model.elements.find(element => element.id === "data:customer")?.name, "Customer", "rendering an overlay does not mutate canonical source facts");
  assert.ok(latex.includes("a4paper"), "LaTeX output declares A4 paper");
  assert.ok(latex.indexOf("\\PassOptionsToPackage{table}{xcolor}") < latex.indexOf("\\usepackage{tikz}"), "table colors are passed before TikZ loads xcolor");
  assert.ok(latex.includes("C = Create, R = Read, U = Update, D = Delete") && latex.includes("Y = confirmed, N = explicitly absent, ? = unknown"), "compact CRUD matrix declares its legend");
  assert.ok(latex.includes(" & Y &") && latex.includes(" & ? &"), "CRUD cells use compact, unambiguous marks");
  assert.ok(latex.includes("\\renewcommand{\\thesection}{\\arabic{section}}"), "LaTeX uses the agreed simple section numbering");
  assert.ok(latex.includes("ARCHITECTURE DEFINITION DOCUMENTS") && latex.includes("Baseline Data and Application Architecture"), "cover uses the requested ADD title and baseline subtitle");
  assert.ok(latex.includes("\\addto\\captionsindonesian{\\renewcommand{\\contentsname}{DAFTAR ISI}}") && latex.includes("\\cfttoctitlefont}{\\hfill\\Large\\bfseries}"), "contents title is uppercase and centered at the top");
  assert.ok(!latex.includes("\\renewcommand{\\cftsecfont}{\\normalfont\\MakeUppercase}"), "contents links keep hyperref-compatible entry styling");
  assert.ok(latex.includes("\\titleformat{\\section}[block]{\\normalfont\\Large\\bfseries\\raggedright}"), "numbered section headings are left-aligned");
  assert.ok(latex.includes("\\fancyhead[L]{\\small\\shortstack[l]{SAGE\\\\ARCHITECTURE DEFINITION DOCUMENTS}}"), "running header identifies SAGE and its ADD title");
  assert.ok(latex.includes("\\fancyhead[R]{\\small 19 November 2026}"), "running header shows only the Jakarta export date on the right");
  assert.ok(!latex.includes("\\fancyhead[L]{\\small\\shortstack[l]{Repository:") && !latex.includes("\\fancyhead[R]{\\small ADD}"), "running header omits repository and branch metadata");
  assert.ok(latex.includes("\\titleformat{\\subsection}[block]{\\normalfont\\large\\bfseries\\raggedright}"), "subsection headings are left-aligned");
  assert.ok(latex.includes("\\scriptsize\\color{gray!70}Application Component") && latex.includes("\\normalsize\\bfseries Customer portal"), "ArchiMate element type remains a secondary label while the application name leads the node");
  assert.ok(latex.includes("\\scriptsize\\color{gray!70}Data Object") && latex.includes("\\normalsize\\bfseries Customer record"), "data-object name leads its node label as well");
  assert.ok(latex.includes("\\setlength{\\tabcolsep}{3pt}") && latex.includes("\\setlength{\\extrarowheight}{4pt}"), "table cells have inner and vertical spacing from their borders");
  assert.ok(latex.includes(">{\\centering\\arraybackslash}p{"), "table columns center content with padding defined in the column layout");
  assert.ok(latex.includes("\\endfirsthead") && latex.includes("\\endhead"), "long table headers repeat on continuation pages");
  assert.ok(latex.includes("\\href{") && !latex.includes("#L"), "PDF evidence links show file paths without line ranges");
  assert.ok(!latex.includes("PHASE C") && !latex.includes("Phase C:"), "cover, contents, and running header omit Phase C wording");
  assert.ok(!latex.includes("\\begin{landscape}") && !latex.includes("pdflscape"), "ADD pages remain portrait with upright headers and page numbers");
  assert.ok(!latex.includes("\\begin{figure}"), "diagrams remain inline so page composition stays controlled");
  assert.ok(latex.includes("\\renewcommand{\\thefigure}{\\thesection.\\arabic{figure}}"), "figure numbers use the numbered ADD section as their prefix");
  const dataIntro = latex.indexOf("Data view short introduction.");
  const firstDiagram = latex.indexOf("\\begin{tikzpicture}", dataIntro);
  const dataCaption = latex.indexOf("\\captionof{figure}{ArchiMate Information Structure Viewpoint}", firstDiagram);
  const dataInterpretation = latex.indexOf("Gambar~\\ref{fig:dataStructure-1} memperlihatkan bahwa", dataCaption);
  assert.ok(dataIntro >= 0 && dataIntro < firstDiagram && firstDiagram < dataCaption && dataCaption < dataInterpretation, "PDF order is short introduction, diagram, caption, then an interpretation that cites the figure");
  assert.ok(latex.includes("Gambar~\\ref{fig:applicationCooperation-1} memperlihatkan bahwa"), "application view interpretation cites its printed figure");
  assert.ok(markdown.includes("Data view short introduction.") && markdown.includes("**Interpretation of the data view:** data view reading explanation."), "Markdown exposes the same bounded view narratives");
  assert.ok(!markdown.includes("| Reason | Evidence |"), "Markdown keeps the PDF's compact relationship register instead of repeating verbose reasoning");
  assert.ok(!latex.includes("BAB 4"));
});

test("ReqFlow application names lead ArchiMate component labels", () => {
  const reqflow = structuredClone(model);
  reqflow.elements.find(element => element.id === "app:web")!.name = "ReqFlow";
  const application = reqflow.elements.find(element => element.id === "app:catalog")!;
  application.type = "ApplicationComponent";
  application.name = "Application";
  application.description = "Application service extracted from Compose.";
  reqflow.catalogs.applicationPortfolio.find(row => row.elementId === "app:catalog")!.description = application.description;
  reqflow.elements.push({ id: "app:nlp", type: "ApplicationComponent", name: "NLP", description: "NLP service extracted from Compose.", origin: "source", featureGroup: null, evidence: model.elements[0]!.evidence, review: "unreviewed" });
  reqflow.catalogs.applicationPortfolio.push({ elementId: "app:nlp", planned: false, description: "NLP service extracted from Compose." });
  reqflow.relationships.push({ id: "rel:application-nlp", type: "FlowRelationship", sourceId: "app:catalog", targetId: "app:nlp", label: "HTTP request using NLP_SERVICE_URL", origin: "source", confidence: "proven", reason: "Configured integration path in the source fixture.", evidence: model.elements[0]!.evidence, review: "unreviewed" });
  reqflow.views.applicationCooperation.elementIds.push("app:nlp");
  reqflow.views.applicationCooperation.relationshipIds.push("rel:application-nlp");
  const core = projectCoreBaselineView(reqflow, "applicationCooperation");
  assert.deepEqual(new Set(core.elements.map(element => element.name)), new Set(["ReqFlow", "Application", "NLP"]));
  const latex = createAddLatex(reqflow, emptyAddReviewOverlay(), evidenceUrl, { modelHash });
  for (const name of ["ReqFlow", "Application", "NLP"]) assert.ok(latex.includes(`\\normalsize\\bfseries ${name}`), `${name} is the dominant node label`);
  assert.ok(latex.includes("\\scriptsize\\color{gray!70}Application Component"), "ArchiMate type remains present as the secondary label");
});

test("ADD exports reject malformed canonical model hashes", () => {
  assert.throws(() => createAddMarkdown(model, emptyAddReviewOverlay(), evidenceUrl, { modelHash: "not-a-sha256" }), /Invalid ADD export model hash/u);
  assert.throws(() => createAddLatex(model, emptyAddReviewOverlay(), evidenceUrl, { modelHash: "not-a-sha256" }), /Invalid ADD export model hash/u);
});

test("old verbose narratives and repeated generic relationship labels do not contradict core diagrams", () => {
  const legacy = structuredClone(model);
  legacy.narratives.dataViewIntroduction = "Diagram ini menampilkan 10 data object dan 4 relasi data.";
  legacy.narratives.dataViewInterpretation = "Node tanpa garis tidak membuktikan hubungan.";
  legacy.narratives.applicationViewIntroduction = "Diagram berikut memetakan 99 elemen aplikasi dan 255 hubungan source-level.";
  legacy.narratives.applicationViewInterpretation = "Garis solid menunjukkan hubungan proven dan dashed menunjukkan indicated; interface dan function ada di diagram.";
  const latex = createAddLatex(legacy, emptyAddReviewOverlay(), evidenceUrl, { modelHash });
  const markdown = createAddMarkdown(legacy, emptyAddReviewOverlay(), evidenceUrl, { modelHash });
  for (const output of [latex, markdown]) {
    assert.ok(!output.includes("Garis solid menunjukkan") && !output.includes("Node tanpa garis"), "confidence is not encoded by ArchiMate connector style");
    assert.ok(!output.includes("255 hubungan source-level"), "stale descriptions that count hidden endpoint detail are replaced");
  }
  assert.ok(!markdown.includes("references data object"), "repeated generic data association labels are removed from the compact register");
  assert.equal(coreRelationshipLabel({ ...model.relationships[0]!, label: "contains application component" }), null, "composition is already conveyed by its ArchiMate end marker, so a generic text label is omitted");
});

test("PDF keeps dense evidence rows within a readable compact table", () => {
  const expanded = structuredClone(model);
  expanded.elements.find(element => element.id === "app:web")!.name = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  expanded.elements.find(element => element.id === "data:customer")!.name = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
  expanded.elements[0]!.evidence = Array.from({ length: 5 }, (_, index) => ({
    filePath: `src/evidence-${index + 1}.ts`, fileSha256: "d".repeat(64), startByte: index, endByte: index + 1,
    startLine: index + 1, endLine: index + 2, startColumn: 1, endColumn: 2, role: "reference" as const,
  }));

  const latex = createAddLatex(expanded, emptyAddReviewOverlay(), evidenceUrl, { modelHash });
  assert.ok(latex.includes("AAAAAAAA\\allowbreak{}A") && latex.includes("BBBBBBBB\\allowbreak{}B"), "long labels have safe wrap points inside centered table cells");
  assert.ok(latex.includes("+ 2 additional evidence files"), "PDF reports when a row has evidence files omitted for compactness");
  assert.ok(latex.includes("src/evidence-1.ts") && latex.includes("src/evidence-3.ts"), "PDF keeps the first three unique evidence files");
  assert.ok(!latex.includes("src/evidence-4.ts") && !latex.includes("src/evidence-5.ts"), "PDF omits additional links instead of overflowing the table row");

  expanded.matrices.applicationData[0]!.evidence = expanded.elements[0]!.evidence;
  const markdown = createAddMarkdown(expanded, emptyAddReviewOverlay(), evidenceUrl, { modelHash });
  assert.ok(markdown.length < 20_000, "Markdown remains a compact counterpart to the PDF instead of expanding each span and reason");
  assert.ok(markdown.includes("+ 2 additional evidence files") && !markdown.includes("#L"), "Markdown uses the same compact, file-level evidence style");
});

test("Application Cooperation PDF shows a connected high-level view without endpoint clutter", () => {
  const expanded = structuredClone(model);
  const applicationId = "app:web";
  for (let index = 0; index < 17; index++) {
    const elementId = `service:${index}`;
    const relationshipId = `relationship:${index}`;
    expanded.elements.push({
      id: elementId, type: "ApplicationService", name: `Catalog service ${index}`, description: null,
      origin: "source", featureGroup: "Items", evidence: expanded.elements[0]!.evidence, review: "unreviewed",
    });
    expanded.relationships.push({
      id: relationshipId, type: "ServingRelationship", sourceId: applicationId, targetId: elementId,
      label: "serves catalog feature", origin: "source", confidence: "proven", reason: "Directly represented fixture relationship.",
      evidence: expanded.elements[0]!.evidence, review: "unreviewed",
    });
    expanded.views.applicationCooperation.elementIds.push(elementId);
    expanded.views.applicationCooperation.relationshipIds.push(relationshipId);
  }

  const latex = createAddLatex(expanded, emptyAddReviewOverlay(), evidenceUrl, { modelHash });
  const core = projectCoreBaselineView(expanded, "applicationCooperation");
  const diagramStart = latex.indexOf("\\section{Application Design (Baseline)}");
  const diagramEnd = latex.indexOf("\\section{Catalog Design}", diagramStart);
  const diagrams = latex.slice(diagramStart, diagramEnd);
  assert.equal(core.relationships.length, 7, "the stakeholder view caps core relationships at seven");
  assert.equal((diagrams.match(/\\draw\[/gu) ?? []).length, 7, "only selected core relationships are drawn");
  assert.equal((diagrams.match(/\\node\[appcomponentnode\]/gu) ?? []).length + (diagrams.match(/\\node\[appservicenode\]/gu) ?? []).length, 8, "each connected component/service appears once rather than once per edge");
  assert.equal((diagrams.match(/\\clearpage/gu) ?? []).length, 0, "the core application view does not split into endpoint-style continuation pages");
  assert.ok(diagrams.includes("ArchiMate Application Cooperation Viewpoint") && diagrams.includes("{Diamond[fill=gray!80!black]}-") && diagrams.includes("-{Stealth[open]}"), "the view is named correctly and uses native composition and serving markers");
  assert.ok(diagrams.includes("Detailed source relationships remain in the corresponding catalog") && diagrams.includes("serves catalog feature"), "lower-level detail is pointed to in the catalog and repeated generic labels stay out of the diagram");
  assert.ok(!/\d+ lower-level or non-core relationship/u.test(diagrams), "large omission counts do not clutter the stakeholder view");
  assert.ok(!diagrams.includes("PROVEN") && !diagrams.includes("Composition: exposes interface"), "evidence confidence and verbose relationship text do not clutter the diagram");
});

test("Information Structure PDF keeps only connected, source-confirmed data relationships", () => {
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
  const core = projectCoreBaselineView(expanded, "dataStructure");
  assert.ok(core.relationships.length > 0 && core.relationships.length <= 7, "the view caps output while preserving source relationships");
  assert.equal((diagrams.match(/\\draw\[/gu) ?? []).length, core.relationships.length, "only the selected source relationships are drawn");
  assert.equal((diagrams.match(/\\node\[datanode\]/gu) ?? []).length, core.elements.length, "each data object is drawn once, with no orphan catalog objects");
  assert.equal((diagrams.match(/\\clearpage/gu) ?? []).length, 0, "the view avoids repeated continuation pages");
  assert.ok(diagrams.includes("ArchiMate Information Structure Viewpoint") && diagrams.includes("\\draw[draw=gray!80!black,thick]"), "the information structure view uses the plain ArchiMate association notation");
  const figureContent = diagrams.slice(0, diagrams.indexOf("The compact register lists"));
  assert.ok(diagrams.includes("Detailed source relationships remain in the corresponding catalog") && !figureContent.includes("links entity 0"), "the diagram omits repetitive association labels and points to source detail in the catalog");
  assert.ok(!diagrams.includes("\\begin{landscape}"), "data views keep page headings and numbers upright");
});

test("core view projection preserves connected source evidence and excludes function-level detail", () => {
  const expanded = structuredClone(model);
  const appId = "app:web";
  for (let index = 0; index < 5; index++) {
    const id = `service:core-${index}`;
    expanded.elements.push({ id, type: "ApplicationService", name: `Core service ${index}`, description: null,
      origin: "source", featureGroup: "Core", evidence: expanded.elements[0]!.evidence, review: "unreviewed" });
    expanded.views.applicationCooperation.elementIds.push(id);
    expanded.relationships.push({ id: `serves:${index}`, type: "ServingRelationship", sourceId: appId, targetId: id,
      label: "serves application function", origin: "source", confidence: "proven", reason: "Static source evidence.",
      evidence: expanded.elements[0]!.evidence, review: "unreviewed" });
    expanded.views.applicationCooperation.relationshipIds.push(`serves:${index}`);
  }
  const projection = projectCoreBaselineView(expanded, "applicationCooperation");
  const ids = new Set(projection.elements.map(element => element.id));
  assert.ok(projection.relationships.length > 0);
  assert.ok(projection.relationships.every(edge => ids.has(edge.sourceId) && ids.has(edge.targetId)), "every displayed relationship connects displayed elements");
  assert.ok(projection.elements.every(element => element.type === "ApplicationComponent" || element.type === "ApplicationService"), "functions and interfaces are not promoted into the stakeholder view");
  assert.ok(projection.relationships.length <= 16 && projection.elements.length <= 18, "the view remains bounded for human reading");
});
