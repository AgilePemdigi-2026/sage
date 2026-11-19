/** Canonical headings and numbering for the baseline Architecture Definition Document. */
export const PHASE_C_ADD = {
  document: {
    id: "phase-c-title",
    title: "ARCHITECTURE DEFINITION DOCUMENTS",
  },
  dataArchitecture: { id: "data-architecture", title: "Data Architecture" },
  applicationArchitecture: { id: "application-architecture", title: "Application Architecture" },
  sections: {
    dataPrinciples: { id: "data-principles", number: "1", title: "Data Principles" },
    dataBaseline: { id: "data-baseline", number: "2", title: "Baseline Data Architecture" },
    businessDataModel: { id: "business-data-model", number: "3", title: "Business Data Model (Baseline)" },
    logicalDataModel: { id: "logical-data-model", number: "4", title: "Logical Data Model (Baseline)" },
    dataManagementProcess: { id: "data-management-process", number: "5", title: "Data Management Process Model (Baseline)" },
    dataFunctionMatrix: { id: "data-function-matrix", number: "6", title: "Data Entity/Business Function Matrix (Baseline)" },
    dataCrudMatrix: { id: "data-crud-matrix", number: "7", title: "Data Entity/Application Component CRUD Matrix (Baseline)" },
    applicationDesign: { id: "application-design", number: "8", title: "Application Design (Baseline)" },
    applicationCatalog: { id: "application-catalog", number: "9", title: "Catalog Design" },
    logicalApplicationComponents: { id: "logical-application-components", number: "10", title: "Logical Application Components" },
    interfaceCatalog: { id: "interface-catalog", number: "11", title: "Interface Catalog" },
    applicationInteractions: { id: "application-interactions", number: "12", title: "Application Interaction Matrix" },
  },
} as const;

export const PHASE_C_ADD_TOC = [
  { id: PHASE_C_ADD.document.id, label: PHASE_C_ADD.document.title, level: 0 },
  { id: PHASE_C_ADD.dataArchitecture.id, label: PHASE_C_ADD.dataArchitecture.title, level: 1 },
  ...Object.values(PHASE_C_ADD.sections).filter(section => ["data-principles", "data-baseline", "business-data-model", "logical-data-model", "data-management-process", "data-function-matrix", "data-crud-matrix"].includes(section.id)).map(section => ({ id: section.id, label: `${section.number} ${section.title}`, level: 2 })),
  { id: PHASE_C_ADD.applicationArchitecture.id, label: PHASE_C_ADD.applicationArchitecture.title, level: 1 },
  ...Object.values(PHASE_C_ADD.sections).filter(section => ["application-design", "application-catalog", "logical-application-components", "interface-catalog", "application-interactions"].includes(section.id)).map(section => ({ id: section.id, label: `${section.number} ${section.title}`, level: 2 })),
] as const;

/** Identity of the persisted source model used by all ADD export formats. */
export type AddExportMetadata = { modelHash?: string };

export function addExportModelHash(metadata?: AddExportMetadata): string {
  if (metadata?.modelHash === undefined) return "Not supplied";
  if (!/^[a-f0-9]{64}$/u.test(metadata.modelHash)) throw new Error("Invalid ADD export model hash");
  return metadata.modelHash;
}
