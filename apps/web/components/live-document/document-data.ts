import type { ArchitectureDocumentV1 } from "@sage/documents/model";
import { projectHumanDiagram } from "@sage/documents/human";
import { projectBoundedDiagramOverview, type DiagramOverviewSummary } from "@sage/documents/overview";
import type { CcmEdge, CcmNode, EvidenceSpan } from "@sage/contracts";
import type { DocumentPayload } from "../../lib/documents/types.ts";

type DiagramProjection = ArchitectureDocumentV1["softwareEngineeringDiagram"];

type RecordValue = Record<string, unknown>;

const NODE_KINDS = new Set(["Module", "Class", "Interface", "Function", "Method", "Property", "UnresolvedReference"]);
const EDGE_KINDS = new Set([
  "CONTAINS", "IMPORTS", "EXPORTS", "EXTENDS", "IMPLEMENTS", "TYPE_REFERENCES", "CALLS",
  "INSTANTIATES", "READS", "WRITES", "THROWS", "INCLUDES",
]);

function record(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): value is string {
  return typeof value === "string";
}

function nullableText(value: unknown): value is string | null {
  return value === null || text(value);
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function sha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isEvidence(value: unknown): value is EvidenceSpan {
  if (!record(value)) return false;
  return text(value.filePath) && sha256(value.fileSha256) && nonNegativeInteger(value.startByte) &&
    nonNegativeInteger(value.endByte) && nonNegativeInteger(value.startLine) && value.startLine > 0 &&
    nonNegativeInteger(value.endLine) && value.endLine >= value.startLine &&
    nonNegativeInteger(value.startColumn) && value.startColumn > 0 &&
    nonNegativeInteger(value.endColumn) && value.endColumn > 0 &&
    ["declaration", "reference", "context"].includes(String(value.role));
}

function isNode(value: unknown): value is CcmNode {
  if (!record(value) || !record(value.attributes)) return false;
  return text(value.id) && NODE_KINDS.has(String(value.kind)) && text(value.name) && text(value.qualifiedName) &&
    ["javascript", "typescript", "php"].includes(String(value.language)) && nullableText(value.filePath) &&
    (value.location === null || isEvidence(value.location)) && nullableText(value.parentId) &&
    ["source", "stdlib", "external", "unresolved"].includes(String(value.origin)) && nullableText(value.signature);
}

function isEdge(value: unknown): value is CcmEdge {
  if (!record(value) || !Array.isArray(value.evidence) || !value.evidence.every(isEvidence)) return false;
  return text(value.id) && text(value.sourceId) && text(value.targetId) && EDGE_KINDS.has(String(value.kind)) &&
    (value.resolution === "Exact" || value.resolution === "Unresolved") &&
    (value.unresolvedReason === null || text(value.unresolvedReason));
}

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(text);
}

function isDiagram(value: unknown, kind: DiagramProjection["kind"]): value is DiagramProjection {
  if (!record(value) || value.kind !== kind || !text(value.title) || !text(value.mermaid) ||
      !Array.isArray(value.nodes) || !value.nodes.every(isNode) || !Array.isArray(value.edges) || !value.edges.every(isEdge) ||
      !Array.isArray(value.nodeMappings) || !Array.isArray(value.edgeMappings) ||
      !strings(value.excludedNodeIds) || !strings(value.excludedEdgeIds)) return false;
  const nodeIds = new Set((value.nodes as CcmNode[]).map(node => node.id));
  const edgeIds = new Set((value.edges as CcmEdge[]).map(edge => edge.id));
  if (nodeIds.size !== value.nodes.length || edgeIds.size !== value.edges.length) return false;
  if (!(value.nodeMappings as unknown[]).every(mapping => record(mapping) && text(mapping.nodeId) && nodeIds.has(mapping.nodeId) &&
      (mapping.mermaidId === null || text(mapping.mermaidId)) && nonNegativeInteger(mapping.mermaidLine) &&
      (mapping.evidence === null || isEvidence(mapping.evidence)))) return false;
  return (value.edgeMappings as unknown[]).every(mapping => record(mapping) && text(mapping.edgeId) && edgeIds.has(mapping.edgeId) &&
    nonNegativeInteger(mapping.mermaidLine) && text(mapping.sourceMermaidId) && text(mapping.targetMermaidId) &&
    Array.isArray(mapping.evidence) && mapping.evidence.every(isEvidence));
}

function isArchitectureDocument(value: unknown): value is ArchitectureDocumentV1 {
  if (!record(value) || value.schemaVersion !== "sage-add-v1" || !text(value.title) ||
      !sha256(value.ckgSha256) || !sha256(value.configurationHash) || !record(value.snapshot) ||
      !text(value.snapshot.repository) || !nullableText(value.snapshot.branch) ||
      typeof value.snapshot.commitSha !== "string" || !/^[a-f0-9]{40}$/i.test(value.snapshot.commitSha) ||
      !record(value.provenance) || !record(value.provenance.analyzer) || !record(value.provenance.resolver) ||
      !text(value.provenance.analyzer.name) || !text(value.provenance.analyzer.version) ||
      !text(value.provenance.resolver.name) || !text(value.provenance.resolver.version) ||
      !sha256(value.provenance.configHash) || !record(value.canonicalCounts) ||
      !Array.isArray(value.files) || !Array.isArray(value.limitations) || !record(value.interfaceCatalog) ||
      !text(value.interfaceCatalog.scope) || !Array.isArray(value.interfaceCatalog.entries) ||
      !Array.isArray(value.interfaceCatalog.relations) || !isDiagram(value.softwareEngineeringDiagram, "software-structure") ||
      !isDiagram(value.umlClassDiagram, "uml-class")) return false;

  const counts = value.canonicalCounts;
  if (!["nodes", "edges", "containmentEdges", "referenceEdges", "exactEdges", "unresolvedEdges"]
    .every(key => nonNegativeInteger(counts[key]))) return false;
  if (!(value.files as unknown[]).every(file => record(file) && text(file.path) &&
      (file.language === null || ["javascript", "typescript", "php"].includes(String(file.language))) &&
      sha256(file.sha256) && nonNegativeInteger(file.sizeBytes) && ["processed", "excluded", "failed"].includes(String(file.status)))) return false;
  if (!(value.limitations as unknown[]).every(limitation => record(limitation) && nullableText(limitation.path) &&
      text(limitation.reason) && text(limitation.stage))) return false;
  if (!(value.interfaceCatalog.entries as unknown[]).every(entry => record(entry) && isNode(entry.declaration) &&
      strings(entry.nodeIds) && strings(entry.edgeIds) && Array.isArray(entry.evidence) && entry.evidence.every(isEvidence) &&
      strings(entry.exportEdgeIds))) return false;
  return (value.interfaceCatalog.relations as unknown[]).every(isEdge);
}

/** Validate identity and the complete serialized model before it is used in React or Mermaid. */
export function parseLiveDocumentPayload(value: unknown, analysisId: string, accountKey: string): DocumentPayload {
  if (!record(value) || value.analysisId !== analysisId || value.accountKey !== accountKey ||
      !sha256(value.contentHash) || !isArchitectureDocument(value.document) ||
      value.document.ckgSha256.length !== 64) {
    throw new Error("Payload dokumen tidak sesuai dengan analisis atau akun aktif.");
  }
  return value as unknown as DocumentPayload;
}

export type DiagramBudget = { kind: "ready" } | { kind: "unavailable"; reason: string };

export interface InteractiveDiagramProjection {
  diagram: DiagramProjection;
  sourceNodeCount: number;
  sourceEdgeCount: number;
  displayNodeCount: number;
  displayEdgeCount: number;
}

export function boundedDiagramOverview(
  software: DiagramProjection,
  uml: DiagramProjection,
  kind: DiagramProjection["kind"],
): { diagram: DiagramProjection; summary: DiagramOverviewSummary } {
  const overview = projectBoundedDiagramOverview(software, uml);
  return kind === "software-structure"
    ? { diagram: overview.software, summary: overview.softwareSummary }
    : { diagram: overview.uml, summary: overview.umlSummary };
}

export function projectInteractiveDiagram(diagram: DiagramProjection, preserveGrouping = false): InteractiveDiagramProjection {
  const display = preserveGrouping ? diagram : projectHumanDiagram(diagram);
  const displayEdgeCount = preserveGrouping ? new Set(display.edgeMappings.map(mapping => mapping.mermaidLine)).size : display.mermaid.split("\n").filter(line => /^\s*N\d+\s+.+\s+N\d+(?:\s|$)/u.test(line)).length;
  const displayMemberCount = preserveGrouping ? 0 : display.mermaid.split("\n").reduce((count, line) => count + (/^\s{4}(?!<<)\S/u.test(line) ? 1 : 0), 0);
  return {
    diagram: display,
    sourceNodeCount: diagram.nodes.length,
    sourceEdgeCount: diagram.edges.length,
    displayNodeCount: (preserveGrouping ? new Set(display.nodeMappings.map(mapping => mapping.mermaidId).filter(Boolean)).size : display.nodeMappings.filter(mapping => mapping.mermaidId !== null).length) + displayMemberCount,
    displayEdgeCount,
  };
}

/** Apply browser-renderer caps to the human projection, after members and repeated relations are summarized. */
export function interactiveDiagramBudget(projection: InteractiveDiagramProjection): DiagramBudget {
  const bytes = new TextEncoder().encode(projection.diagram.mermaid).byteLength;
  if (projection.diagram.mermaid.length > 50_000 || bytes > 50_000) {
    return { kind: "unavailable", reason: "Diagram hasil ringkasan melewati batas 50.000 karakter atau byte." };
  }
  if (projection.displayNodeCount > 500 || projection.displayEdgeCount > 500) {
    return { kind: "unavailable", reason: "Diagram hasil ringkasan melewati batas 500 elemen atau 500 relasi." };
  }
  return { kind: "ready" };
}

/** Mirror DOC-02's renderer limits, before the expensive browser renderer is loaded. */
export function diagramBudget(diagram: DiagramProjection): DiagramBudget {
  const bytes = new TextEncoder().encode(diagram.mermaid).byteLength;
  if (diagram.mermaid.length > 50_000 || bytes > 50_000) {
    return { kind: "unavailable", reason: "Source diagram melewati batas 50.000 karakter atau byte." };
  }
  if (diagram.nodes.length > 500 || diagram.edges.length > 500) {
    return { kind: "unavailable", reason: "Diagram melewati batas 500 node atau 500 relasi." };
  }
  return { kind: "ready" };
}
