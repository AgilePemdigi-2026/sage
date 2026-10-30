import { createHash } from "node:crypto";
import {
  parseCanonicalCkg,
  type CcmEdge,
  type CcmFile,
  type CcmLimitation,
  type CcmNode,
  type CcmProvenance,
  type CcmSnapshot,
  type CkgCounts,
  type EvidenceSpan,
} from "@sage/contracts";
import { projectVerifiedCkgDiagrams, type DiagramProjection } from "./diagrams.ts";

export const ARCHITECTURE_DOCUMENT_SCHEMA_VERSION = "sage-add-v1" as const;

/** A catalog row grounded in one source-origin CCM declaration. */
export interface InterfaceCatalogEntryV1 {
  declaration: CcmNode;
  /** The declaration and canonical graph endpoints directly associated with it. */
  nodeIds: string[];
  /** Canonical incident edge IDs, including containment and unresolved relations. */
  edgeIds: string[];
  /** Declaration and incident-edge evidence, in deterministic source order. */
  evidence: EvidenceSpan[];
  /** Only IDs of canonical EXPORTS edges incident with this declaration. */
  exportEdgeIds: string[];
}

export interface InterfaceCatalogV1 {
  /** Explicitly limits catalog entries to source declarations represented in the CKG. */
  scope: string;
  entries: InterfaceCatalogEntryV1[];
  /** Every canonical CKG edge, preserving Exact/Unresolved status, reason, and evidence. */
  relations: CcmEdge[];
}

/** Deterministic, source-backed projection of a canonical CKG for document generation. */
export interface ArchitectureDocumentV1 {
  schemaVersion: typeof ARCHITECTURE_DOCUMENT_SCHEMA_VERSION;
  title: string;
  ckgSha256: string;
  configurationHash: string;
  snapshot: CcmSnapshot;
  provenance: CcmProvenance;
  canonicalCounts: CkgCounts;
  files: CcmFile[];
  limitations: CcmLimitation[];
  interfaceCatalog: InterfaceCatalogV1;
  softwareEngineeringDiagram: DiagramProjection;
  umlClassDiagram: DiagramProjection;
}

export type ArchitectureDocumentResult =
  | { ok: true; value: ArchitectureDocumentV1; json: string; sha256: string }
  | { ok: false; errorCode: string };

const SHA256 = /^[a-f0-9]{64}$/;
const CATALOG_SCOPE = "Katalog mencatat semua deklarasi source selain Module yang tersedia pada CKG, beserta ID node/relasi dan evidence. Semua relasi canonical dipertahankan dengan status Exact/Unresolved, alasan dan bukti sumber. ID ekspor hanya berasal dari relasi EXPORTS yang tercatat. Katalog ini tidak menyimpulkan visibility, HTTP endpoint, callback, ekspor atau type alias yang belum dibuktikan.";

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareEvidence(left: EvidenceSpan, right: EvidenceSpan): number {
  return compareStrings(left.filePath, right.filePath) || left.startByte - right.startByte ||
    left.endByte - right.endByte || compareStrings(left.role, right.role) ||
    compareStrings(left.fileSha256, right.fileSha256) || left.startLine - right.startLine ||
    left.endLine - right.endLine || left.startColumn - right.startColumn ||
    left.endColumn - right.endColumn;
}

/** All inputs here have passed CKG JSON validation and contain only JSON-compatible values. */
function copyJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function projectInterfaceCatalog(nodes: readonly CcmNode[], edges: readonly CcmEdge[]): InterfaceCatalogV1 {
  const relatedEdges = new Map<string, CcmEdge[]>();
  for (const edge of edges) {
    for (const nodeId of new Set([edge.sourceId, edge.targetId])) {
      const incident = relatedEdges.get(nodeId) ?? [];
      incident.push(edge);
      relatedEdges.set(nodeId, incident);
    }
  }

  const declarations = nodes
    .filter(node => node.origin === "source" && node.kind !== "Module")
    .sort((left, right) => compareStrings(left.id, right.id));
  const entries = declarations.map(declaration => {
    const incident = [...(relatedEdges.get(declaration.id) ?? [])]
      .sort((left, right) => compareStrings(left.id, right.id));
    const associatedNodeIds = new Set<string>([declaration.id]);
    if (declaration.parentId !== null) associatedNodeIds.add(declaration.parentId);
    for (const edge of incident) {
      associatedNodeIds.add(edge.sourceId);
      associatedNodeIds.add(edge.targetId);
    }
    const evidence = [
      ...(declaration.location === null ? [] : [declaration.location]),
      ...incident.flatMap(edge => edge.evidence),
    ].map(span => copyJson(span)).sort(compareEvidence);

    return {
      declaration: copyJson(declaration),
      nodeIds: [...associatedNodeIds].sort(compareStrings),
      edgeIds: incident.map(edge => edge.id),
      evidence,
      exportEdgeIds: incident.filter(edge => edge.kind === "EXPORTS").map(edge => edge.id),
    };
  });

  return {
    scope: CATALOG_SCOPE,
    entries,
    relations: [...edges].sort((left, right) => compareStrings(left.id, right.id)).map(edge => copyJson(edge)),
  };
}

/** Build a deterministic architecture document projection from a source-verified canonical CKG. */
export function projectArchitectureDocument(
  canonicalCkgJson: string,
  sourceBytes: Readonly<Record<string, Uint8Array>>,
  expectedCkgSha256?: string,
): ArchitectureDocumentResult {
  const parsed = parseCanonicalCkg(canonicalCkgJson, sourceBytes, expectedCkgSha256);
  if (!parsed.ok) return { ok: false, errorCode: parsed.errorCode };

  const diagrams = projectVerifiedCkgDiagrams(parsed);
  if (!diagrams.ok) return { ok: false, errorCode: diagrams.errorCode };
  if (diagrams.value.ckgSha256 !== parsed.sha256) {
    return { ok: false, errorCode: "ADD_CKG_PROJECTION_MISMATCH" };
  }

  const ccm = parsed.value.ccm;
  const value: ArchitectureDocumentV1 = {
    schemaVersion: ARCHITECTURE_DOCUMENT_SCHEMA_VERSION,
    title: "Architecture Definition Document",
    ckgSha256: parsed.sha256,
    configurationHash: parsed.value.configurationHash,
    snapshot: copyJson(ccm.snapshot),
    provenance: copyJson(ccm.provenance),
    canonicalCounts: copyJson(parsed.value.counts),
    files: copyJson(ccm.files),
    limitations: copyJson(ccm.limitations),
    interfaceCatalog: projectInterfaceCatalog(ccm.nodes, ccm.edges),
    softwareEngineeringDiagram: diagrams.value.diagrams[1],
    umlClassDiagram: diagrams.value.diagrams[0],
  };
  const json = JSON.stringify(value);
  return { ok: true, value, json, sha256: digest(json) };
}

/** Replay a persisted architecture document and reject any noncanonical or altered projection. */
export function parseCanonicalArchitectureDocument(
  documentJson: string,
  canonicalCkgJson: string,
  sourceBytes: Readonly<Record<string, Uint8Array>>,
  expectedDocumentSha256?: string,
  expectedCkgSha256?: string,
): ArchitectureDocumentResult {
  if (typeof documentJson !== "string") return { ok: false, errorCode: "ADD_JSON_INVALID" };
  if (expectedDocumentSha256 !== undefined && !SHA256.test(expectedDocumentSha256)) {
    return { ok: false, errorCode: "ADD_CONTENT_HASH_INVALID" };
  }
  if (expectedDocumentSha256 !== undefined && digest(documentJson) !== expectedDocumentSha256) {
    return { ok: false, errorCode: "ADD_CONTENT_HASH_MISMATCH" };
  }
  try {
    JSON.parse(documentJson) as unknown;
  } catch {
    return { ok: false, errorCode: "ADD_JSON_INVALID" };
  }

  const expected = projectArchitectureDocument(canonicalCkgJson, sourceBytes, expectedCkgSha256);
  if (!expected.ok) return expected;
  if (expected.json !== documentJson) return { ok: false, errorCode: "ADD_JSON_NOT_CANONICAL" };
  return expected;
}
