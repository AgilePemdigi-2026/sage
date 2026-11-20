import type { EvidenceSpan } from "@sage/contracts";
import { applyAddReviewOverlay, type AddReviewOverlay } from "./add-overlay.ts";
import type { AddBaselineModel, AddElement, AddRelationship } from "./baseline-add.ts";
import { addExportModelHash, PHASE_C_ADD, PHASE_C_ADD_TOC, type AddExportMetadata } from "./phase-c-add.ts";
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
    (edge.confidence === "proven" ? "Proven" : "Indicated") + " | " + edge.review + " | " + evidenceLinks(edge.evidence, makeUrl) + " |";
}

const relationshipHeader = [
  "| Source | ArchiMate relationship | Label | Target | Confidence | Review | Evidence |",
  "| --- | --- | --- | --- | --- | --- | --- |",
];

const inputRequired = "Requires architect input. The analyzed repository does not establish this information.";

/** Render the supplied PAP template's Phase C baseline section from the canonical model and review overlay. */
export function createAddMarkdown(model: AddBaselineModel, overlay: AddReviewOverlay, makeEvidenceUrl: EvidenceUrlBuilder, metadata?: AddExportMetadata): string {
  model = applyAddReviewOverlay(model, overlay);
  const modelHash = addExportModelHash(metadata);
  const elements = new Map(model.elements.map(element => [element.id, element]));
  const applicationView = projectCoreBaselineView(model, "applicationCooperation");
  const dataView = projectCoreBaselineView(model, "dataStructure");
  const dataViewNarrative = addViewNarratives(model, "dataStructure");
  const applicationViewNarrative = addViewNarratives(model, "applicationCooperation");
  const functions = model.elements.filter(element => element.type === "ApplicationFunction" || element.type === "ApplicationService");
  const contents = PHASE_C_ADD_TOC.map(item => `${"  ".repeat(item.level)}- [${markdownText(item.label)}](#${item.id})`);
  const out = [
    `# <a id="${PHASE_C_ADD.document.id}"></a>${PHASE_C_ADD.document.title}`, "",
    "Architecture Definition Document (ADD): source-grounded baseline for Data Architecture and Application Architecture.", "",
    "| Repository | Branch | Source commit | ArchiMate profile |",
    "| --- | --- | --- | --- |",
    `| ${cell(model.snapshot.repository)} | ${cell(model.snapshot.branch ?? "Not recorded")} | ${model.snapshot.commitSha} | ${model.archimateVersion} |`, "",
    "## Contents", "", ...contents, "",
    `### <a id="${PHASE_C_ADD.dataArchitecture.id}"></a>${PHASE_C_ADD.dataArchitecture.title}`, "",
    `#### <a id="${PHASE_C_ADD.sections.dataPrinciples.id}"></a>${PHASE_C_ADD.sections.dataPrinciples.number} ${PHASE_C_ADD.sections.dataPrinciples.title}`, "",
    inputRequired + " Approved data principles must be supplied by the architecture authority; they are not inferred from code.", "",
    `#### <a id="${PHASE_C_ADD.sections.dataBaseline.id}"></a>${PHASE_C_ADD.sections.dataBaseline.number} ${PHASE_C_ADD.sections.dataBaseline.title}`, "",
    markdownText(model.narratives.dataBaseline), "",
    "Only the baseline is included. Target architecture is a separately governed design input and is not inferred from this source snapshot.", "",
    `##### <a id="${PHASE_C_ADD.sections.businessDataModel.id}"></a>${PHASE_C_ADD.sections.businessDataModel.number} ${PHASE_C_ADD.sections.businessDataModel.title}`, "",
    "###### Data Entity Catalog", "",
    "| Data entity | Feature group | Owner | Distribution | Description | Review | Evidence |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  ];

  for (const row of model.catalogs.dataEntities) {
    const element = elements.get(row.elementId);
    if (!element) continue;
    out.push(`| ${cell(element.name)} | ${cell(element.featureGroup ?? "Unassigned")} | ${cell(row.owner ?? "Requires confirmation")} | Requires enterprise input | ${cell(row.description ?? "")} | ${element.review} | ${evidenceLinks(element.evidence, makeEvidenceUrl)} |`);
  }
  if (!model.catalogs.dataEntities.length) out.push("| No data entity was identified |  |  |  |  |  |  |");

  out.push("", `##### <a id="${PHASE_C_ADD.sections.logicalDataModel.id}"></a>${PHASE_C_ADD.sections.logicalDataModel.number} ${PHASE_C_ADD.sections.logicalDataModel.title}`, "",
    markdownText(dataViewNarrative.introduction), "",
    "This view shows the core source-supported data-object associations. Other data objects remain in the catalog.", "",
    "ArchiMate Information Structure Viewpoint relationship register", "", ...relationshipHeader);
  out.push(...(dataView.relationships.length ? dataView.relationships.map(edge => relationshipRow(edge, elements, makeEvidenceUrl)) : ["| No explicit data-to-data relationship was identified | — | — | — | — | — | — |"]));
  out.push("", "**Interpretation of the data view:** " + markdownText(dataViewNarrative.interpretation), "");

  out.push("", `##### <a id="${PHASE_C_ADD.sections.dataManagementProcess.id}"></a>${PHASE_C_ADD.sections.dataManagementProcess.number} ${PHASE_C_ADD.sections.dataManagementProcess.title}`, "",
    inputRequired + " Data governance, stewardship, retention, and operational procedures are not established by code declarations alone.", "",
    `##### <a id="${PHASE_C_ADD.sections.dataFunctionMatrix.id}"></a>${PHASE_C_ADD.sections.dataFunctionMatrix.number} ${PHASE_C_ADD.sections.dataFunctionMatrix.title}`, "",
    inputRequired + " No approved Phase B business-function catalog or mapping was supplied; this matrix is intentionally omitted.", "",
    `##### <a id="${PHASE_C_ADD.sections.dataCrudMatrix.id}"></a>${PHASE_C_ADD.sections.dataCrudMatrix.number} ${PHASE_C_ADD.sections.dataCrudMatrix.title}`, "",
    "The matrix uses repository-level application components because source code does not establish enterprise business functions. Do not interpret an application component as a business function.", "",
    "| Application component | Data entity | Create | Read | Update | Delete | Evidence |",
    "| --- | --- | --- | --- | --- | --- | --- |");
  for (const row of model.matrices.applicationData) out.push(`| ${cell(elements.get(row.applicationId)?.name ?? row.applicationId)} | ${cell(elements.get(row.dataId)?.name ?? row.dataId)} | ${row.create} | ${row.read} | ${row.update} | ${row.delete} | ${evidenceLinks(row.evidence, makeEvidenceUrl)} |`);
  if (!model.matrices.applicationData.length) out.push("| No confirmed application-data operation |  |  |  |  |  |  |");
  out.push("", "`Unknown` means the operation was not confirmed by supported static evidence; it does not mean `No`.", "",
    `### <a id="${PHASE_C_ADD.applicationArchitecture.id}"></a>${PHASE_C_ADD.applicationArchitecture.title}`, "",
    `#### <a id="${PHASE_C_ADD.sections.applicationDesign.id}"></a>${PHASE_C_ADD.sections.applicationDesign.number} ${PHASE_C_ADD.sections.applicationDesign.title}`, "",
    markdownText(model.narratives.applicationBaseline), "", markdownText(applicationViewNarrative.introduction), "",
    "This view shows the main source-supported application relationships. Endpoint and function details remain in the catalogs.", "",
    "ArchiMate Application Cooperation Viewpoint relationship register", "", ...relationshipHeader);
  out.push(...(applicationView.relationships.length ? applicationView.relationships.map(edge => relationshipRow(edge, elements, makeEvidenceUrl)) : ["| No application cooperation relationship was extracted | — | — | — | — | — | — |"]));
  out.push("", "**Interpretation of the application view:** " + markdownText(applicationViewNarrative.interpretation), "");

  out.push("", `#### <a id="${PHASE_C_ADD.sections.applicationCatalog.id}"></a>${PHASE_C_ADD.sections.applicationCatalog.number} ${PHASE_C_ADD.sections.applicationCatalog.title}`, "",
    "##### Application Portfolio", "",
    "| Application component | State | Description | Review | Evidence |", "| --- | --- | --- | --- | --- |");
  for (const row of model.catalogs.applicationPortfolio) {
    const element = elements.get(row.elementId);
    if (element) out.push(`| ${cell(element.name)} | Baseline | ${cell(row.description ?? "")} | ${element.review} | ${evidenceLinks(element.evidence, makeEvidenceUrl)} |`);
  }
  if (!model.catalogs.applicationPortfolio.length) out.push("| No application component was identified |  |  |  |  |");

  out.push("", `##### <a id="${PHASE_C_ADD.sections.logicalApplicationComponents.id}"></a>${PHASE_C_ADD.sections.logicalApplicationComponents.number} ${PHASE_C_ADD.sections.logicalApplicationComponents.title}`, "",
    "| Type | Component | Feature group | Description | Review | Evidence |", "| --- | --- | --- | --- | --- | --- |");
  for (const element of functions) out.push(`| ${element.type === "ApplicationFunction" ? "Function" : "Service"} | ${cell(element.name)} | ${cell(element.featureGroup ?? "Unassigned")} | ${cell(element.description ?? "")} | ${element.review} | ${evidenceLinks(element.evidence, makeEvidenceUrl)} |`);
  if (!functions.length) out.push("| No logical application component was identified |  |  |  |  |  |");

  out.push("", `##### <a id="${PHASE_C_ADD.sections.interfaceCatalog.id}"></a>${PHASE_C_ADD.sections.interfaceCatalog.number} ${PHASE_C_ADD.sections.interfaceCatalog.title}`, "",
    "| Interface | Protocol | Contract | Review | Evidence |", "| --- | --- | --- | --- | --- |");
  for (const row of model.catalogs.interfaces) {
    const element = elements.get(row.elementId);
    if (element) out.push(`| ${cell(element.name)} | ${cell(row.protocol ?? "Not identified")} | ${cell(row.contract ?? "")} | ${element.review} | ${evidenceLinks(element.evidence, makeEvidenceUrl)} |`);
  }
  if (!model.catalogs.interfaces.length) out.push("| No interface was identified |  |  |  |  |");

  out.push("", `#### <a id="${PHASE_C_ADD.sections.applicationInteractions.id}"></a>${PHASE_C_ADD.sections.applicationInteractions.number} ${PHASE_C_ADD.sections.applicationInteractions.title}`, "");
  if (model.matrices.applicationInteractions.length) {
    out.push("| Source application | Target application | Mechanism | Evidence |", "| --- | --- | --- | --- |");
    for (const row of model.matrices.applicationInteractions) out.push(`| ${cell(elements.get(row.sourceApplicationId)?.name ?? row.sourceApplicationId)} | ${cell(elements.get(row.targetApplicationId)?.name ?? row.targetApplicationId)} | ${cell(row.mechanism)} | ${evidenceLinks(row.evidence, makeEvidenceUrl)} |`);
  } else out.push("No interaction between separately identified applications or communication mechanism was confirmed from this repository snapshot. Internal calls remain in the Application Cooperation view.");

  out.push("", "### Source and analysis notes", "",
    `| Item | Value |`, `| --- | --- |`,
    `| Repository snapshot | ${cell(model.snapshot.repository)} @ ${model.snapshot.commitSha} |`,
    `| Branch | ${cell(model.snapshot.branch ?? "Not recorded")} |`,
    `| Source CKG SHA-256 | ${model.sourceCkgHash} |`,
    `| ADD model SHA-256 | ${modelHash} |`,
    `| Analyzer version | ${cell(model.generation.extractorVersion)} |`,
    `| Narrative assistance | ${cell(model.generation.llmOutcome + (model.generation.llmModel ? " · " + model.generation.llmModel : ""))} |`,
    `| Review overlay | ${overlay.status}, revision ${overlay.revision} |`, "",
    "The application and data views use the same canonical snapshot as this document. `Proven` and `Indicated` describe evidence confidence; they are separate from code-model resolution status.", "",
    "### Items requiring confirmation", "",
    ...(model.limitations.length ? model.limitations.map(item => "- " + markdownText(item, true)) : ["- No additional analyzer limitation was recorded."]), "");
  return out.join("\n");
}
