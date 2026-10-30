import type { SemanticModel, PresentationOverlay } from "./model.ts";

const SHA256 = /^[a-f0-9]{64}$/;
const NODE_KINDS = new Set(["actor", "feature", "concept", "component", "store", "step", "decision", "outcome"]);
const CONFIDENCE = new Set(["proven", "indicated"]);
const EVIDENCE_ROLES = new Set(["declaration", "reference", "context"]);

export interface SemanticValidationContext {
  sourceCkgHash?: string;
  snapshot?: unknown;
  ckgNodeIds?: ReadonlySet<string>;
  fileHashes?: ReadonlyMap<string, string>;
}

function plain(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null) && Reflect.ownKeys(value).every(key => {
    if (typeof key !== "string") return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return !!descriptor && descriptor.enumerable && "value" in descriptor;
  });
}

function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return plain(value) && Reflect.ownKeys(value).length === keys.length && Reflect.ownKeys(value).every(key => typeof key === "string" && keys.includes(key));
}

function dataArray(value: unknown, maximum: number): unknown[] | null {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum) return null;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || !keys.includes("length")) return null;
  const result: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return null;
    result.push(descriptor.value);
  }
  return result;
}

function validEvidence(value: unknown, context: SemanticValidationContext): boolean {
  if (!exact(value, ["filePath", "fileSha256", "startByte", "endByte", "startLine", "endLine", "startColumn", "endColumn", "role"])) return false;
  return typeof value.filePath === "string" && value.filePath.length > 0 &&
    typeof value.fileSha256 === "string" && SHA256.test(value.fileSha256) &&
    (context.fileHashes === undefined || context.fileHashes.get(value.filePath) === value.fileSha256) &&
    Number.isSafeInteger(value.startByte) && Number(value.startByte) >= 0 &&
    Number.isSafeInteger(value.endByte) && Number(value.endByte) >= Number(value.startByte) &&
    Number.isSafeInteger(value.startLine) && Number(value.startLine) > 0 &&
    Number.isSafeInteger(value.endLine) && Number(value.endLine) >= Number(value.startLine) &&
    Number.isSafeInteger(value.startColumn) && Number(value.startColumn) > 0 &&
    Number.isSafeInteger(value.endColumn) && Number(value.endColumn) > 0 &&
    typeof value.role === "string" && EVIDENCE_ROLES.has(value.role);
}

function nonblank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** Runtime structural check shared by storage and consumers of the semantic payload. */
export function isSemanticModel(value: unknown, context: SemanticValidationContext = {}): value is SemanticModel {
  if (!exact(value, ["schemaVersion", "extractorVersion", "sourceCkgHash", "snapshot", "nodes", "edges", "features", "frameworks", "limitations"]) ||
      value.schemaVersion !== "sage-semantic-v1" || typeof value.extractorVersion !== "string" || !value.extractorVersion.trim() ||
      typeof value.sourceCkgHash !== "string" || !SHA256.test(value.sourceCkgHash) ||
      (context.sourceCkgHash !== undefined && value.sourceCkgHash !== context.sourceCkgHash) ||
      !exact(value.snapshot, ["repository", "branch", "commitSha"]) || typeof value.snapshot.repository !== "string" ||
      !(value.snapshot.branch === null || typeof value.snapshot.branch === "string") || typeof value.snapshot.commitSha !== "string" ||
      (context.snapshot !== undefined && JSON.stringify(value.snapshot) !== JSON.stringify(context.snapshot))) return false;
  const nodes = dataArray(value.nodes, 30_000);
  const edges = dataArray(value.edges, 100_000);
  const features = dataArray(value.features, 10_000);
  const frameworks = dataArray(value.frameworks, 500);
  const limitations = dataArray(value.limitations, 30_000);
  if (!nodes || !edges || !features || !frameworks || !limitations) return false;
  const nodeIds = new Set<string>();
  const featureIds = new Set<string>();
  const edgeIds = new Set<string>();
  for (const candidate of nodes) {
    if (!exact(candidate, ["id", "kind", "label", "featureId", "confidence", "reason", "evidence", "technicalNodeIds"])) return false;
    const evidence = dataArray(candidate.evidence, 2_000);
    const technicalNodeIds = dataArray(candidate.technicalNodeIds, 30_000);
    if (typeof candidate.id !== "string" || !candidate.id || nodeIds.has(candidate.id) ||
        typeof candidate.kind !== "string" || !NODE_KINDS.has(candidate.kind) ||
        !nonblank(candidate.label) || candidate.label.length > 240 ||
        !(candidate.featureId === null || (typeof candidate.featureId === "string" && candidate.featureId.length > 0)) ||
        typeof candidate.confidence !== "string" || !CONFIDENCE.has(candidate.confidence) ||
        !nonblank(candidate.reason) || candidate.reason.length > 1000 || !evidence || evidence.length === 0 ||
        evidence.some(item => !validEvidence(item, context)) || !technicalNodeIds ||
        technicalNodeIds.some(id => typeof id !== "string" || (context.ckgNodeIds !== undefined && !context.ckgNodeIds.has(id)))) return false;
    nodeIds.add(candidate.id);
  }
  for (const candidate of features) {
    if (!exact(candidate, ["id", "label", "entryNodeIds", "nodeIds", "edgeIds", "evidence"])) return false;
    const entryNodeIds = dataArray(candidate.entryNodeIds, 30_000);
    const memberNodeIds = dataArray(candidate.nodeIds, 30_000);
    const memberEdgeIds = dataArray(candidate.edgeIds, 100_000);
    const evidence = dataArray(candidate.evidence, 2_000);
    if (typeof candidate.id !== "string" || !candidate.id || featureIds.has(candidate.id) ||
        !nonblank(candidate.label) || candidate.label.length > 240 || !entryNodeIds ||
        entryNodeIds.some(id => typeof id !== "string" || !nodeIds.has(id)) || !memberNodeIds ||
        memberNodeIds.some(id => typeof id !== "string" || !nodeIds.has(id)) || !memberEdgeIds ||
        memberEdgeIds.some(id => typeof id !== "string") || !evidence || evidence.length === 0 || evidence.some(item => !validEvidence(item, context))) return false;
    featureIds.add(candidate.id);
  }
  for (const candidate of nodes) {
    if (!exact(candidate, ["id", "kind", "label", "featureId", "confidence", "reason", "evidence", "technicalNodeIds"]) ||
        (candidate.featureId !== null && (typeof candidate.featureId !== "string" || !featureIds.has(candidate.featureId)))) return false;
  }
  for (const candidate of edges) {
    if (!exact(candidate, ["id", "source", "target", "label", "confidence", "reason", "evidence"])) return false;
    const evidence = dataArray(candidate.evidence, 2_000);
    if (typeof candidate.id !== "string" || !candidate.id || edgeIds.has(candidate.id) ||
        typeof candidate.source !== "string" || !nodeIds.has(candidate.source) ||
        typeof candidate.target !== "string" || !nodeIds.has(candidate.target) ||
        !nonblank(candidate.label) || candidate.label.length > 240 ||
        typeof candidate.confidence !== "string" || !CONFIDENCE.has(candidate.confidence) ||
        !nonblank(candidate.reason) || candidate.reason.length > 1000 || !evidence || evidence.length === 0 ||
        evidence.some(item => !validEvidence(item, context))) return false;
    edgeIds.add(candidate.id);
  }
  for (const candidate of features) {
    const feature = candidate as { edgeIds: string[] };
    if (feature.edgeIds.some(id => !edgeIds.has(id))) return false;
  }
  if (frameworks.some(item => typeof item !== "string" || item.length > 100)) return false;
  for (const candidate of limitations) {
    if (!exact(candidate, ["filePath", "reason"]) || typeof candidate.filePath !== "string" ||
        (context.fileHashes !== undefined && !context.fileHashes.has(candidate.filePath)) ||
        typeof candidate.reason !== "string" || candidate.reason.length > 1000) return false;
  }
  return true;
}

export function isPresentationOverlay(value: unknown, model: SemanticModel): value is PresentationOverlay {
  if (!exact(value, ["labels", "groups"]) || !plain(value.labels) || !plain(value.groups)) return false;
  const nodes = new Map(model.nodes.map(node => [node.id, node] as const));
  const featureIds = new Set(model.features.map(feature => feature.id));
  return Object.entries(value.labels).every(([id, label]) => nodes.has(id) && typeof label === "string" &&
      !!label.trim() && [...label.trim()].length <= 120 && !/[\p{Cc}\p{Cf}]/u.test(label)) &&
    Object.entries(value.groups).every(([id, featureId]) => {
      const node = nodes.get(id);
      return !!node && ["concept", "component", "store"].includes(node.kind) &&
        typeof featureId === "string" && featureIds.has(featureId);
    });
}

/** Validate and normalize a user-provided overlay for render or export. */
export function validatePresentationOverlay(model: SemanticModel, value: unknown): PresentationOverlay {
  if (!isPresentationOverlay(value, model)) throw new Error("Presentation overlay is invalid.");
  const labels = Object.fromEntries(Object.entries(value.labels).sort(([left], [right]) => left.localeCompare(right))
    .map(([id, label]) => [id, label.trim()]));
  const groups = Object.fromEntries(Object.entries(value.groups).sort(([left], [right]) => left.localeCompare(right)));
  return { labels, groups };
}
