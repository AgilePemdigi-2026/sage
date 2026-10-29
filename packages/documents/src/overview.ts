/** A small, source-backed overview for interactive screens when the full diagram exceeds browser bounds. */
export {
  PDF_PROJECTION_LIMITS as OVERVIEW_LIMITS,
  projectCompactPdfDiagrams as projectBoundedDiagramOverview,
} from "./pdf-projection.ts";
export type {
  CompactPdfDiagrams as BoundedDiagramOverview,
  PdfDiagramSummary as DiagramOverviewSummary,
} from "./pdf-projection.ts";

export { buildArchitectureUml } from "./architecture-uml.ts";
export type { ArchitectureUmlResult, ArchitectureUmlSummary } from "./architecture-uml.ts";
