import type { CcmEdge, CcmNode, CcmSnapshot, EvidenceSpan } from "@sage/contracts";

export const SOURCE_PREVIEW_MAX_LINES = 200;
export const SOURCE_PREVIEW_MAX_BYTES = 128 * 1024;

export interface NodeInspectorBindings {
  analysisId: string;
  accountKey: string;
  ckgSha256: string;
  configurationHash: string;
  snapshot: CcmSnapshot;
}

/** Canonical node facts, excluding arbitrary analyzer attributes. */
export type NodeInspectorNode = Pick<
  CcmNode,
  "id" | "kind" | "name" | "qualifiedName" | "language" | "filePath" | "parentId" | "origin" | "signature"
> & { location: EvidenceSpan | null };

export interface NodeInspectorFile {
  id: string;
  path: string;
  sha256: string;
  sizeBytes: number;
}

export interface NodeInspectorRelation {
  edge: CcmEdge;
  peer: NodeInspectorNode;
}

export interface NodeInspectorPayload extends NodeInspectorBindings {
  node: NodeInspectorNode;
  incoming: NodeInspectorRelation[];
  outgoing: NodeInspectorRelation[];
  files: NodeInspectorFile[];
}

export interface SourcePayload extends NodeInspectorBindings {
  file: NodeInspectorFile;
  startLine: number;
  endLine: number;
  totalLines: number;
  text: string;
}

export type InspectorReadState<T> =
  | { kind: "ready"; value: Omit<T, "accountKey"> }
  | { kind: "not-found" }
  | { kind: "not-ready" }
  | { kind: "item-not-found" }
  | { kind: "range-invalid" }
  | { kind: "range-too-large" };

export type NodeInspectorReadState = InspectorReadState<NodeInspectorPayload>;
export type SourceReadState = InspectorReadState<SourcePayload>;

