import {
  EDGE_KINDS,
  EDGE_RESOLUTIONS,
  EVIDENCE_ROLES,
  LANGUAGES,
  NODE_KINDS,
  NODE_ORIGINS,
  UNRESOLVED_REASONS,
} from "@sage/contracts";
import type { CcmSnapshot, EvidenceSpan } from "@sage/contracts";
import type {
  NodeInspectorFile,
  NodeInspectorNode,
  NodeInspectorPayload,
  NodeInspectorRelation,
  SourcePayload,
} from "../../lib/graphs/inspector-types.ts";

export interface InspectorBindings {
  analysisId: string;
  accountKey: string;
  ckgSha256: string;
  configurationHash: string;
  snapshot: CcmSnapshot;
}

export interface NodeInspectorExpectation extends InspectorBindings {
  nodeId: string;
}

export interface SourceExpectation extends InspectorBindings {
  file: NodeInspectorFile;
  startLine: number;
  endLine: number;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): value is string {
  return typeof value === "string";
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function hash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function sameSnapshot(value: unknown, expected: CcmSnapshot): boolean {
  return record(value) && value.repository === expected.repository && value.branch === expected.branch &&
    value.commitSha === expected.commitSha;
}

function sameBindings(value: unknown, expected: InspectorBindings): boolean {
  return record(value) && value.analysisId === expected.analysisId && value.accountKey === expected.accountKey &&
    value.ckgSha256 === expected.ckgSha256 && value.configurationHash === expected.configurationHash &&
    sameSnapshot(value.snapshot, expected.snapshot);
}

function isEvidence(value: unknown): value is EvidenceSpan {
  return record(value) && text(value.filePath) && hash(value.fileSha256) &&
    nonNegativeInteger(value.startByte) && nonNegativeInteger(value.endByte) && value.startByte < value.endByte &&
    positiveInteger(value.startLine) && positiveInteger(value.endLine) && value.endLine >= value.startLine &&
    positiveInteger(value.startColumn) && positiveInteger(value.endColumn) &&
    (EVIDENCE_ROLES as readonly unknown[]).includes(value.role);
}

function isNode(value: unknown): value is NodeInspectorNode {
  return record(value) && text(value.id) && (NODE_KINDS as readonly unknown[]).includes(value.kind) &&
    text(value.name) && text(value.qualifiedName) && (LANGUAGES as readonly unknown[]).includes(value.language) &&
    (value.filePath === null || text(value.filePath)) &&
    (value.location === null || isEvidence(value.location)) &&
    (value.parentId === null || text(value.parentId)) &&
    (NODE_ORIGINS as readonly unknown[]).includes(value.origin) &&
    (value.signature === null || text(value.signature));
}

function isFile(value: unknown): value is NodeInspectorFile {
  return record(value) && text(value.id) && /^file-[a-f0-9]{64}$/.test(value.id) &&
    text(value.path) && hash(value.sha256) && nonNegativeInteger(value.sizeBytes);
}

function isRelation(value: unknown): value is NodeInspectorRelation {
  if (!record(value) || !record(value.edge) || !isNode(value.peer)) return false;
  const edge = value.edge;
  return text(edge.id) && text(edge.sourceId) && text(edge.targetId) &&
    (EDGE_KINDS as readonly unknown[]).includes(edge.kind) &&
    (EDGE_RESOLUTIONS as readonly unknown[]).includes(edge.resolution) &&
    Array.isArray(edge.evidence) && edge.evidence.length > 0 && edge.evidence.every(isEvidence) &&
    (edge.resolution === "Exact" ? edge.unresolvedReason === null :
      (UNRESOLVED_REASONS as readonly unknown[]).includes(edge.unresolvedReason) && edge.evidence.some((evidence) => isEvidence(evidence) && evidence.role === "reference"));
}

/** Validate a direct-node response and bind it to the current analysis, owner and canonical snapshot. */
export function parseNodeInspectorPayload(value: unknown, expected: NodeInspectorExpectation): NodeInspectorPayload {
  if (!record(value) || !sameBindings(value, expected) || !isNode(value.node) || value.node.id !== expected.nodeId ||
    !Array.isArray(value.incoming) || !value.incoming.every(isRelation) ||
    !Array.isArray(value.outgoing) || !value.outgoing.every(isRelation) ||
    !Array.isArray(value.files) || !value.files.every(isFile)) {
    throw new Error("Payload detail node tidak cocok dengan snapshot aktif atau tidak valid.");
  }

  const incoming = value.incoming as NodeInspectorRelation[];
  const outgoing = value.outgoing as NodeInspectorRelation[];
  const files = value.files as NodeInspectorFile[];
  const nodeId = expected.nodeId;
  const incomingIds = new Set<string>();
  const outgoingIds = new Set<string>();
  const fileIds = new Set<string>();
  for (const { edge, peer } of incoming) {
    if (edge.targetId !== nodeId || edge.sourceId !== peer.id || incomingIds.has(edge.id)) {
      throw new Error("Payload detail node memiliki endpoint atau bukti file yang tidak konsisten.");
    }
    incomingIds.add(edge.id);
  }
  for (const { edge, peer } of outgoing) {
    if (edge.sourceId !== nodeId || edge.targetId !== peer.id || outgoingIds.has(edge.id)) {
      throw new Error("Payload detail node memiliki endpoint atau bukti file yang tidak konsisten.");
    }
    outgoingIds.add(edge.id);
  }
  for (const file of files) {
    if (fileIds.has(file.id)) throw new Error("Payload detail node memiliki endpoint atau bukti file yang tidak konsisten.");
    fileIds.add(file.id);
  }
  return value as unknown as NodeInspectorPayload;
}

/** Validate a bounded source response against the exact file and line window requested by the inspector. */
export function parseSourcePayload(value: unknown, expected: SourceExpectation): SourcePayload {
  if (!record(value) || !sameBindings(value, expected) || !isFile(value.file) ||
    value.file.id !== expected.file.id || value.file.path !== expected.file.path ||
    value.file.sha256 !== expected.file.sha256 || value.file.sizeBytes !== expected.file.sizeBytes ||
    !positiveInteger(value.startLine) || value.startLine !== expected.startLine ||
    !positiveInteger(value.endLine) || value.endLine < value.startLine || value.endLine > expected.endLine ||
    value.endLine - value.startLine + 1 > 200 || !positiveInteger(value.totalLines) ||
    value.endLine > value.totalLines || !text(value.text)) {
    throw new Error("Payload source tidak cocok dengan file atau rentang bukti aktif.");
  }
  return value as unknown as SourcePayload;
}

/** Select at most 200 lines around a span while keeping its first line in the preview. */
export function sourceRangeForEvidence(evidence: Pick<EvidenceSpan, "startLine" | "endLine">, maxLines = 200): { startLine: number; endLine: number } {
  const limit = Math.max(1, Math.min(200, Math.floor(maxLines)));
  const spanLines = evidence.endLine - evidence.startLine + 1;
  const context = Math.min(3, Math.floor(Math.max(0, limit - Math.min(spanLines, limit)) / 2));
  const startLine = Math.max(1, evidence.startLine - context);
  const endLine = Math.min(evidence.endLine + context, startLine + limit - 1);
  return { startLine, endLine };
}

/** Find source metadata by the full canonical path/hash pair from node or edge evidence. */
export function fileForEvidence(files: readonly NodeInspectorFile[], evidence: Pick<EvidenceSpan, "filePath" | "fileSha256">): NodeInspectorFile | null {
  return files.find((file) => file.path === evidence.filePath && file.sha256 === evidence.fileSha256) ?? null;
}
