import type { EvidenceSpan } from "@sage/contracts";
import { applyAddReviewOverlay, type AddReviewOverlay } from "./add-overlay.ts";
import type { AddBaselineModel, AddElement, AddRelationship } from "./baseline-add.ts";
import { logicalSchemaRows, baselineCatalogMappings, addAnalyzerCoverageNotes, addExportModelHash, includedAddSections, phaseCAddContents, phaseCAddNumbers, PHASE_C_ADD, sourceBackedApplicationPortfolio, type AddExportMetadata } from "./phase-c-add.ts";
import { addViewNarratives } from "./baseline-narratives.ts";
import { coreRelationshipLabel, projectCoreBaselineView } from "./baseline-core-views.ts";

export type EvidenceUrlBuilder = (span: EvidenceSpan, fileOnly?: boolean) => string;
const MAX_EVIDENCE_FILES_PER_ROW = 3;

function markdownText(value: string, singleLine = false): string {
  const escaped = value.replaceAll("&", "&amp;").replaceAll("#", "&#35;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll("\\", "&#92;").replaceAll("|", "&#124;").replaceAll("[", "&#91;").replaceAll("]", "&#93;")
    .replaceAll("!", "&#33;").replaceAll(String.fromCharCode(96), "&#96;").replaceAll("*", "&#42;").replaceAll("_", "&#95;");
  return singleLine ? escaped.replace(/[\r\n]+/gu, " ") : escaped;
}
const cell = (value: string) => markdownText(value, true);
function linkDestination(value: string): string { return value.replaceAll("\\", "%5C").replaceAll(" ", "%20").replaceAll("(", "%28").replaceAll(")", "%29").replaceAll("<", "%3C").replaceAll(">", "%3E"); }

function evidenceLinks(spans: EvidenceSpan[], makeUrl: EvidenceUrlBuilder): string {
  if (!spans.length) return "No source evidence";
  const files = [...new Map(spans.map(span => [span.filePath, span])).values()];
  const links = files.slice(0, MAX_EVIDENCE_FILES_PER_ROW).map(span => {
    const label = markdownText(span.filePath, true);
    return "[" + label + "](" + linkDestination(makeUrl(span, true)) + ")";
  });
  if (files.length > links.length) links.push(`+ ${files.length - links.length} additional evidence files`);
  return links.join(", ");
}

function relationshipRow(edge: AddRelationship, elements: ReadonlyMap<string, AddElement>, makeUrl: EvidenceUrlBuilder): string {
  return "| " + cell(elements.get(edge.sourceId)?.name ?? edge.sourceId) + " | " + cell(edge.type) + " | " +
    cell(coreRelationshipLabel(edge) ?? "—") + " | " + cell(elements.get(edge.targetId)?.name ?? edge.targetId) + " | " +
    (edge.confidence === "proven" ? "Proven" : "Indicated") + " | " + evidenceLinks(edge.evidence, makeUrl) + " |";
}

const relationshipHeader = [
  "| Source | ArchiMate relationship | Label | Target | Evidence confidence | Evidence |",
  "| --- | --- | --- | --- | --- | --- |",
];

/** Render a concise, source-backed baseline ADD from the canonical model. */
export function createAddMarkdown(model: AddBaselineModel, overlay: AddReviewOverlay, makeEvidenceUrl: EvidenceUrlBuilder, metadata?: AddExportMetadata): string {
  model = applyAddReviewOverlay(model, overlay);
  const modelHash = addExportModelHash(metadata);
  const elements = new Map(model.elements.map(element => [element.id, element]));
  const mapping = baselineCatalogMappings(model);
  const applicationView = projectCoreBaselineView(model, "applicationCooperation");
  const dataView = projectCoreBaselineView(model, "dataStructure");
  const dataViewNarrative = addViewNarratives(model, "dataStructure");
  const applicationViewNarrative = addViewNarratives(model, "applicationCooperation");
  const functions = model.elements.filter(element => element.type === "ApplicationFunction" || element.type === "ApplicationService");
  const included = includedAddSections(model);
  const numbers = phaseCAddNumbers(model);
  const contents = phaseCAddContents(model).map(item => `${"  ".repeat(item.level)}- [${markdownText(item.label)}](#${item.id})`);
  const heading = (id: string, title: string) => `#### <a id="${id}"></a>${numbers.get(id)}. ${title}`;
  const out = [
    `# <a id="${PHASE_C_ADD.document.id}"></a>${PHASE_C_ADD.document.title}`, "",
    "Baseline Data and Application Architecture generated from evidence in one repository snapshot.", "",
    "| Repository | Branch | Source commit | ArchiMate profile |",
    "| --- | --- | --- | --- |",
    `| ${cell(model.snapshot.repository)} | ${cell(model.snapshot.branch ?? "Not recorded")} | ${model.snapshot.commitSha} | ${model.archimateVersion} |`, "",
    "## Contents", "", ...contents, "",
  ];

  const dataIds = [PHASE_C_ADD.sections.dataBaseline.id, PHASE_C_ADD.sections.businessDataModel.id,
    PHASE_C_ADD.sections.logicalSchema.id, PHASE_C_ADD.sections.logicalDataModel.id, PHASE_C_ADD.sections.dataCrudMatrix.id];
  if (dataIds.some(id => included.has(id))) out.push(`### <a id="${PHASE_C_ADD.dataArchitecture.id}"></a>${PHASE_C_ADD.dataArchitecture.title}`, "");
  if (included.has(PHASE_C_ADD.sections.dataBaseline.id)) {
    out.push(heading(PHASE_C_ADD.sections.dataBaseline.id, PHASE_C_ADD.sections.dataBaseline.title), "", markdownText(model.narratives.dataBaseline), "");
  }
  if (included.has(PHASE_C_ADD.sections.businessDataModel.id)) {
    out.push(heading(PHASE_C_ADD.sections.businessDataModel.id, PHASE_C_ADD.sections.businessDataModel.title), "",
      "| Data entity | Group | Application access | Description | Evidence |", "| --- | --- | --- | --- | --- |");
    for (const row of model.catalogs.dataEntities) {
      const element = elements.get(row.elementId);
      if (element) out.push(`| ${cell(element.name)} | ${cell(element.featureGroup ?? "")} | ${cell(mapping("dataAccess", element.id))} | ${cell(row.description ?? "")} | ${evidenceLinks(element.evidence, makeEvidenceUrl)} |`);
    }
    out.push("");
  }
  if (included.has(PHASE_C_ADD.sections.logicalSchema.id)) {
    out.push(heading(PHASE_C_ADD.sections.logicalSchema.id, PHASE_C_ADD.sections.logicalSchema.title), "",
      "Declared Prisma attributes and relation fields. Multiplicity describes the field from its declaring entity.", "",
      "| Entity | Field | Kind | Type / target | Multiplicity | Evidence |", "| --- | --- | --- | --- | --- | --- |");
    for (const row of logicalSchemaRows(model)) {
      out.push("| " + [row.entity, row.name, row.kind, row.type, row.multiplicity].map(cell).concat(evidenceLinks([row.evidence], makeEvidenceUrl)).join(" | ") + " |");
    }
    out.push("");
  }
  if (included.has(PHASE_C_ADD.sections.logicalDataModel.id)) {
    out.push(heading(PHASE_C_ADD.sections.logicalDataModel.id, PHASE_C_ADD.sections.logicalDataModel.title), "",
      markdownText(dataViewNarrative.introduction), "", "The view contains data objects and associations identified in the analyzed source.", "",
      "ArchiMate Information Structure Viewpoint relationship register", "", ...relationshipHeader,
      ...dataView.relationships.map(edge => relationshipRow(edge, elements, makeEvidenceUrl)),
      "", "**Interpretation:** " + markdownText(dataViewNarrative.interpretation), "");
  }
  if (included.has(PHASE_C_ADD.sections.dataCrudMatrix.id)) {
    const evidencedRows = model.matrices.applicationData.map(row => ({ ...row, operations: [
      row.create === "yes" ? "Create" : "", row.read === "yes" ? "Read" : "",
      row.update === "yes" ? "Update" : "", row.delete === "yes" ? "Delete" : "",
    ].filter(Boolean).join(", ") })).filter(row => row.operations);
    if (evidencedRows.length) {
      out.push(heading(PHASE_C_ADD.sections.dataCrudMatrix.id, PHASE_C_ADD.sections.dataCrudMatrix.title), "",
        "Only operations supported by source evidence are listed; missing operations are not represented as negative facts.", "",
        "| Application component | Data entity | Detected operations | Evidence |", "| --- | --- | --- | --- |");
      for (const row of evidencedRows) out.push(`| ${cell(elements.get(row.applicationId)?.name ?? row.applicationId)} | ${cell(elements.get(row.dataId)?.name ?? row.dataId)} | ${cell(row.operations)} | ${evidenceLinks(row.evidence, makeEvidenceUrl)} |`);
      out.push("");
    }
  }

  const appIds = [PHASE_C_ADD.sections.applicationDesign.id, PHASE_C_ADD.sections.applicationCatalog.id,
    PHASE_C_ADD.sections.logicalApplicationComponents.id, PHASE_C_ADD.sections.interfaceCatalog.id,
    PHASE_C_ADD.sections.applicationInteractions.id];
  if (appIds.some(id => included.has(id))) out.push(`### <a id="${PHASE_C_ADD.applicationArchitecture.id}"></a>${PHASE_C_ADD.applicationArchitecture.title}`, "");
  if (included.has(PHASE_C_ADD.sections.applicationDesign.id)) {
    out.push(heading(PHASE_C_ADD.sections.applicationDesign.id, PHASE_C_ADD.sections.applicationDesign.title), "",
      markdownText(model.narratives.applicationBaseline), "", markdownText(applicationViewNarrative.introduction), "",
      "The view shows source-supported application components and relationships.", "",
      "ArchiMate Application Cooperation Viewpoint relationship register", "", ...relationshipHeader,
      ...applicationView.relationships.map(edge => relationshipRow(edge, elements, makeEvidenceUrl)),
      "", "**Interpretation:** " + markdownText(applicationViewNarrative.interpretation), "");
  }
  if (included.has(PHASE_C_ADD.sections.applicationCatalog.id)) {
    out.push(heading(PHASE_C_ADD.sections.applicationCatalog.id, PHASE_C_ADD.sections.applicationCatalog.title), "",
      "| Application component | State | Description | Evidence |", "| --- | --- | --- | --- |");
    for (const row of sourceBackedApplicationPortfolio(model)) {
      const element = elements.get(row.elementId);
      if (element) out.push(`| ${cell(element.name)} | Baseline | ${cell(row.description ?? "")} | ${evidenceLinks(element.evidence, makeEvidenceUrl)} |`);
    }
    out.push("");
  }
  if (included.has(PHASE_C_ADD.sections.logicalApplicationComponents.id)) {
    out.push(heading(PHASE_C_ADD.sections.logicalApplicationComponents.id, PHASE_C_ADD.sections.logicalApplicationComponents.title), "",
      "| Application | Feature group | Function / service | Description | Evidence |", "| --- | --- | --- | --- | --- |");
    for (const element of functions) out.push(`| ${cell(mapping("application", element.id))} | ${cell(element.featureGroup ?? "")} | ${cell(element.name)} | ${cell(element.description ?? "")} | ${evidenceLinks(element.evidence, makeEvidenceUrl)} |`);
    out.push("");
  }
  if (included.has(PHASE_C_ADD.sections.interfaceCatalog.id)) {
    out.push(heading(PHASE_C_ADD.sections.interfaceCatalog.id, PHASE_C_ADD.sections.interfaceCatalog.title), "",
      "| Interface | Protocol | Contract | Provider | Consumer | Evidence |", "| --- | --- | --- | --- | --- | --- |");
    for (const row of model.catalogs.interfaces) {
      const element = elements.get(row.elementId);
      if (element) out.push(`| ${cell(element.name)} | ${cell(row.protocol ?? "")} | ${cell(row.contract ?? "")} | ${cell(mapping("provider", element.id))} | ${cell(mapping("consumer", element.id))} | ${evidenceLinks(element.evidence, makeEvidenceUrl)} |`);
    }
    out.push("");
  }
  if (included.has(PHASE_C_ADD.sections.applicationInteractions.id)) {
    out.push(heading(PHASE_C_ADD.sections.applicationInteractions.id, PHASE_C_ADD.sections.applicationInteractions.title), "",
      "| Source application | Target application | Mechanism | Evidence |", "| --- | --- | --- | --- |");
    for (const row of model.matrices.applicationInteractions) out.push(`| ${cell(elements.get(row.sourceApplicationId)?.name ?? row.sourceApplicationId)} | ${cell(elements.get(row.targetApplicationId)?.name ?? row.targetApplicationId)} | ${cell(row.mechanism)} | ${evidenceLinks(row.evidence, makeEvidenceUrl)} |`);
    out.push("");
  }

  out.push("### Source and analysis notes", "",
    "| Item | Value |", "| --- | --- |",
    `| Repository snapshot | ${cell(model.snapshot.repository)} @ ${model.snapshot.commitSha} |`,
    `| Branch | ${cell(model.snapshot.branch ?? "Not recorded")} |`,
    `| Source CKG SHA-256 | ${model.sourceCkgHash} |`,
    `| ADD model SHA-256 | ${modelHash} |`,
    `| Analyzer version | ${cell(model.generation.extractorVersion)} |`,
    `| Narrative assistance | ${cell(model.generation.llmOutcome + (model.generation.llmModel ? " · " + model.generation.llmModel : ""))} |`, "",
    "The application and data views use the same analyzed source snapshot. `Proven` and `Indicated` describe evidence confidence and do not change code-model resolution status.", "");
  const coverageNotes = addAnalyzerCoverageNotes(model);
  if (coverageNotes.length) out.push("### Analyzer coverage", "", ...coverageNotes.map(item => "- " + markdownText(item, true)), "");
  return out.join("\n");
}
