import type { AddBaselineModel } from "./baseline-add-model.ts";
import { projectCoreBaselineView } from "./baseline-core-views.ts";

/** Canonical headings and numbering for the repository-derived baseline ADD. */
export const PHASE_C_ADD = {
  document: {
    id: "phase-c-title",
    title: "ARCHITECTURE DEFINITION DOCUMENTS",
  },
  dataArchitecture: { id: "data-architecture", title: "Data Architecture" },
  applicationArchitecture: { id: "application-architecture", title: "Application Architecture" },
  sections: {
    dataBaseline: { id: "data-baseline", title: "Baseline Data Architecture" },
    businessDataModel: { id: "business-data-model", title: "Data Entity Catalog" },
    logicalSchema: { id: "logical-data-model-declarations", title: "Logical Data Model (Repository Baseline)" },
    logicalDataModel: { id: "logical-data-model", title: "ArchiMate Information Structure View" },
    dataCrudMatrix: { id: "data-crud-matrix", title: "Data Entity/Application Component CRUD Matrix" },
    applicationDesign: { id: "application-design", title: "Baseline Application Architecture" },
    applicationCatalog: { id: "application-catalog", title: "Application Portfolio Catalog" },
    logicalApplicationComponents: { id: "logical-application-components", title: "Functional Decomposition" },
    interfaceCatalog: { id: "interface-catalog", title: "Interface Catalog" },
    applicationInteractions: { id: "application-interactions", title: "Application Interaction Matrix" },
  },
} as const;

export type PhaseCAddTocEntry = { id: string; label: string; level: 0 | 1 | 2 };

/** Outline of supported baseline artifacts before a snapshot is selected. */
export const PHASE_C_ADD_TOC: PhaseCAddTocEntry[] = [
  { id: PHASE_C_ADD.document.id, label: PHASE_C_ADD.document.title, level: 0 },
  { id: PHASE_C_ADD.dataArchitecture.id, label: PHASE_C_ADD.dataArchitecture.title, level: 1 },
  ...Object.values(PHASE_C_ADD.sections).slice(0, 5).map(section => ({ id: section.id, label: section.title, level: 2 as const })),
  { id: PHASE_C_ADD.applicationArchitecture.id, label: PHASE_C_ADD.applicationArchitecture.title, level: 1 },
  ...Object.values(PHASE_C_ADD.sections).slice(5).map(section => ({ id: section.id, label: section.title, level: 2 as const })),
];

/** Return portfolio rows backed by source evidence, including for legacy stored models. */
export function sourceBackedApplicationPortfolio(model: AddBaselineModel) {
  const elements = new Map(model.elements.map(element => [element.id, element]));
  return model.catalogs.applicationPortfolio.filter(row => {
    const element = elements.get(row.elementId);
    return element?.type === "ApplicationComponent" && element.evidence.length > 0;
  });
}

/** Return only artifact sections populated by the canonical source projection. */
export function includedAddSections(model: AddBaselineModel): Set<string> {
  const included = new Set<string>();
  if (model.narratives.dataBaseline.trim()) included.add(PHASE_C_ADD.sections.dataBaseline.id);
  if (logicalSchemaRows(model).length) included.add(PHASE_C_ADD.sections.logicalSchema.id);
  if (model.catalogs.dataEntities.length) included.add(PHASE_C_ADD.sections.businessDataModel.id);
  if (projectCoreBaselineView(model, "dataStructure").relationships.length) included.add(PHASE_C_ADD.sections.logicalDataModel.id);
  if (model.matrices.applicationData.some(row => row.create === "yes" || row.read === "yes" || row.update === "yes" || row.delete === "yes")) {
    included.add(PHASE_C_ADD.sections.dataCrudMatrix.id);
  }
  if (projectCoreBaselineView(model, "applicationCooperation").relationships.length) included.add(PHASE_C_ADD.sections.applicationDesign.id);
  if (sourceBackedApplicationPortfolio(model).length) included.add(PHASE_C_ADD.sections.applicationCatalog.id);
  if (model.elements.some(item => item.type === "ApplicationFunction" || item.type === "ApplicationService")) {
    included.add(PHASE_C_ADD.sections.logicalApplicationComponents.id);
  }
  if (model.catalogs.interfaces.length) included.add(PHASE_C_ADD.sections.interfaceCatalog.id);
  if (model.matrices.applicationInteractions.length) included.add(PHASE_C_ADD.sections.applicationInteractions.id);
  return included;
}

/** Build a compact contents list from the artifacts actually found in this repository snapshot. */
export function phaseCAddContents(model: AddBaselineModel): PhaseCAddTocEntry[] {
  const included = includedAddSections(model);
  const dataIds = [PHASE_C_ADD.sections.dataBaseline.id, PHASE_C_ADD.sections.businessDataModel.id,
    PHASE_C_ADD.sections.logicalSchema.id, PHASE_C_ADD.sections.logicalDataModel.id, PHASE_C_ADD.sections.dataCrudMatrix.id];
  const appIds = [PHASE_C_ADD.sections.applicationDesign.id, PHASE_C_ADD.sections.applicationCatalog.id,
    PHASE_C_ADD.sections.logicalApplicationComponents.id, PHASE_C_ADD.sections.interfaceCatalog.id,
    PHASE_C_ADD.sections.applicationInteractions.id];
  const entry: PhaseCAddTocEntry[] = [{ id: PHASE_C_ADD.document.id, label: PHASE_C_ADD.document.title, level: 0 }];
  if (dataIds.some(id => included.has(id))) {
    entry.push({ id: PHASE_C_ADD.dataArchitecture.id, label: PHASE_C_ADD.dataArchitecture.title, level: 1 });
    for (const id of dataIds) if (included.has(id)) {
      const section = Object.values(PHASE_C_ADD.sections).find(item => item.id === id)!;
      entry.push({ id, label: `${entry.filter(item => item.level === 2).length + 1}. ${section.title}`, level: 2 });
    }
  }
  if (appIds.some(id => included.has(id))) {
    entry.push({ id: PHASE_C_ADD.applicationArchitecture.id, label: PHASE_C_ADD.applicationArchitecture.title, level: 1 });
    for (const id of appIds) if (included.has(id)) {
      const section = Object.values(PHASE_C_ADD.sections).find(item => item.id === id)!;
      entry.push({ id, label: `${entry.filter(item => item.level === 2).length + 1}. ${section.title}`, level: 2 });
    }
  }
  return entry;
}

/** Stable dynamic section numbers shared by the web view and document exports. */
export function phaseCAddNumbers(model: AddBaselineModel): ReadonlyMap<string, number> {
  const numbers = new Map<string, number>();
  for (const item of phaseCAddContents(model)) if (item.level === 2) numbers.set(item.id, numbers.size + 1);
  return numbers;
}

/** Ignore legacy confirmation placeholders when rendering an evidence-only baseline. */
export function addAnalyzerCoverageNotes(model: AddBaselineModel): string[] {
  const manualInput = /not assessed|requires?\s+(?:architect|enterprise|user)?\s*input|requires?\s+confirmation|not supplied|items requiring confirmation|must be confirmed/iu;
  return model.limitations.filter(item => !manualInput.test(item));
}

/** Identity of the persisted source model used by all ADD export formats. */
export type AddExportMetadata = { modelHash?: string; generatedAt?: string };

export function addExportModelHash(metadata?: AddExportMetadata): string {
  if (metadata?.modelHash === undefined) return "Not supplied";
  if (!/^[a-f0-9]{64}$/u.test(metadata.modelHash)) throw new Error("Invalid ADD export model hash");
  return metadata.modelHash;
}

/** Format the export timestamp as a date in the project's Jakarta timezone. */
export function addExportGeneratedDate(metadata?: AddExportMetadata): string {
  const generatedAt = metadata?.generatedAt === undefined ? new Date() : new Date(metadata.generatedAt);
  if (!Number.isFinite(generatedAt.getTime())) throw new Error("Invalid ADD export generated date");
  return new Intl.DateTimeFormat("id-ID", {
    day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Jakarta",
  }).format(generatedAt);
}

/** Project catalog mappings only from retained source-backed relationships. */
export function baselineCatalogMappings(model: AddBaselineModel) {
  const elements = new Map(model.elements.map(element => [element.id, element]));
  const names = new Map<string, Set<string>>();
  function add(kind: string, id: string, name: string) {
    const key = `${kind}:${id}`;
    if (!names.has(key)) names.set(key, new Set());
    names.get(key)!.add(name);
  }
  for (const edge of model.relationships) {
    const source = elements.get(edge.sourceId);
    const target = elements.get(edge.targetId);
    if (!source || !target || edge.review === "rejected" || !edge.evidence.length) continue;
    const label = source.name + (edge.confidence === "indicated" ? " (indicated)" : "");
    if (source.type === "ApplicationComponent" && target.type === "ApplicationInterface" && edge.type === "CompositionRelationship") add("provider", target.id, label);
    if (source.type === "ApplicationComponent" && edge.type === "AssignmentRelationship" && ["ApplicationFunction", "ApplicationService"].includes(target.type)) add("application", target.id, label);
    if (source.type === "ApplicationComponent" && target.type === "ApplicationInterface" && edge.type === "FlowRelationship" && edge.confidence === "proven") add("consumer", target.id, source.name);
  }
  for (const row of model.matrices.applicationData) {
    const application = elements.get(row.applicationId);
    if (application && row.evidence.length && [row.create, row.read, row.update, row.delete].includes("yes")) add("dataAccess", row.dataId, application.name);
  }
  return (kind: "provider" | "consumer" | "application" | "dataAccess", id: string) =>
    [...(names.get(`${kind}:${id}`) ?? [])].sort().join(", ");
}

export function logicalSchemaRows(model: AddBaselineModel) {
  return model.elements.flatMap(element => (element.dataFields ?? []).map(field => ({
    entity: element.name, ...field, kind: field.targetNodeId ? "Relation" : "Attribute",
  })));
}
