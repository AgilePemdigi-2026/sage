import type { CcmV1, CcmSnapshot, EvidenceSpan } from "@sage/contracts";
import type { DocumentationContext } from "./documentation.ts";

export interface RelationshipExplanation {
  kind: string;
  origin: "code" | "documentation" | "mixed";
  rule: string;
  summary: string;
  limitations: string[];
  sourceEdgeIds: string[];
}

export type SemanticConfidence = "proven" | "indicated";
export type SemanticKind = "actor" | "feature" | "concept" | "component" | "store" | "step" | "decision" | "outcome";
export interface SemanticNode {
  id: string; kind: SemanticKind; label: string; featureId: string | null;
  confidence: SemanticConfidence; reason: string; evidence: EvidenceSpan[]; technicalNodeIds: string[];
}
export interface SemanticEdge {
  id: string; source: string; target: string; label: string;
  confidence: SemanticConfidence; reason: string; evidence: EvidenceSpan[];
  explanation?: RelationshipExplanation;
}
export interface SemanticFeature {
  id: string; label: string; entryNodeIds: string[]; nodeIds: string[]; edgeIds: string[]; evidence: EvidenceSpan[];
}
export interface SemanticFragment {
  nodes: SemanticNode[]; edges: SemanticEdge[]; features: SemanticFeature[];
  frameworks: string[]; limitations: Array<{ filePath: string; reason: string }>;
}
export interface SemanticModel extends SemanticFragment {
  schemaVersion: "sage-semantic-v1" | "sage-semantic-v2"; extractorVersion: string; sourceCkgHash: string; snapshot: CcmSnapshot;
  documentation?: DocumentationContext;
}
export interface SemanticInput {
  ccm: CcmV1; sourceCkgHash: string; sources: Readonly<Record<string, Uint8Array>>;
  documentationSources?: Readonly<Record<string, Uint8Array>>;
  snapshotPaths?: readonly string[];
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
