import type { CcmV1, CcmSnapshot, EvidenceSpan } from "@sage/contracts";

export type SemanticConfidence = "proven" | "indicated";
export type SemanticKind = "actor" | "feature" | "concept" | "component" | "store" | "step" | "decision" | "outcome";
export interface SemanticNode {
  id: string; kind: SemanticKind; label: string; featureId: string | null;
  confidence: SemanticConfidence; reason: string; evidence: EvidenceSpan[]; technicalNodeIds: string[];
}
export interface SemanticEdge {
  id: string; source: string; target: string; label: string;
  confidence: SemanticConfidence; reason: string; evidence: EvidenceSpan[];
}
export interface SemanticFeature {
  id: string; label: string; entryNodeIds: string[]; nodeIds: string[]; edgeIds: string[]; evidence: EvidenceSpan[];
}
export interface SemanticFragment {
  nodes: SemanticNode[]; edges: SemanticEdge[]; features: SemanticFeature[];
  frameworks: string[]; limitations: Array<{ filePath: string; reason: string }>;
}
export interface SemanticModel extends SemanticFragment {
  schemaVersion: "sage-semantic-v1"; extractorVersion: string; sourceCkgHash: string; snapshot: CcmSnapshot;
}
export interface SemanticInput {
  ccm: CcmV1; sourceCkgHash: string; sources: Readonly<Record<string, Uint8Array>>;
}
export interface PresentationOverlay {
  labels: Record<string, string>;
  groups: Record<string, string>;
}
export interface SemanticPayload {
  analysisId: string; accountKey: string; modelHash: string; model: SemanticModel;
  revision: number; overlay: PresentationOverlay;
}
export const EMPTY_OVERLAY: PresentationOverlay = { labels: {}, groups: {} };
