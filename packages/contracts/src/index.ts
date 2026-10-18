import { createHash } from "node:crypto";

export const SCHEMA_VERSION = 1 as const;
export const LANGUAGES = ["javascript", "typescript", "php"] as const;
export const NODE_KINDS = ["Module", "Class", "Interface", "Function", "Method", "Property", "UnresolvedReference"] as const;
export const EDGE_KINDS = [
  "CONTAINS", "IMPORTS", "EXPORTS", "EXTENDS", "IMPLEMENTS", "TYPE_REFERENCES", "CALLS",
  "INSTANTIATES", "READS", "WRITES", "THROWS", "INCLUDES",
] as const;
export const NODE_ORIGINS = ["source", "stdlib", "external", "unresolved"] as const;
export const EDGE_RESOLUTIONS = ["Exact", "Unresolved"] as const;
export const UNRESOLVED_REASONS = [
  "DYNAMIC_LOAD", "UNKNOWN_RECEIVER", "EXTERNAL_DEPENDENCY", "UNSUPPORTED_CONSTRUCT", "AMBIGUOUS_SYMBOL",
] as const;
export const EVIDENCE_ROLES = ["declaration", "reference", "context"] as const;

export type Language = (typeof LANGUAGES)[number];
export type NodeKind = (typeof NODE_KINDS)[number];
export type EdgeKind = (typeof EDGE_KINDS)[number];
export type NodeOrigin = (typeof NODE_ORIGINS)[number];
export type EdgeResolution = (typeof EDGE_RESOLUTIONS)[number];
export type UnresolvedReason = (typeof UNRESOLVED_REASONS)[number];
export type EvidenceRole = (typeof EVIDENCE_ROLES)[number];
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export interface EvidenceSpan {
  filePath: string;
  fileSha256: string;
  startByte: number;
  endByte: number;
  startLine: number;
  endLine: number;
  startColumn: number;
  endColumn: number;
  role: EvidenceRole;
}

export interface CcmSnapshot {
  repository: string;
  branch: string | null;
  commitSha: string;
}

export interface CcmProvenance {
  analyzer: { name: string; version: string };
  resolver: { name: string; version: string };
  configHash: string;
}

export interface CcmFile {
  path: string;
  language: Language | null;
  sha256: string;
  sizeBytes: number;
  status: "processed" | "excluded" | "failed";
}

export interface CcmNode {
  id: string;
  kind: NodeKind;
  name: string;
  qualifiedName: string;
  language: Language;
  filePath: string | null;
  location: EvidenceSpan | null;
  parentId: string | null;
  origin: NodeOrigin;
  signature: string | null;
  attributes: Record<string, JsonValue>;
}

export interface CcmEdge {
  id: string;
  sourceId: string;
  targetId: string;
  kind: EdgeKind;
  resolution: EdgeResolution;
  evidence: EvidenceSpan[];
  unresolvedReason: UnresolvedReason | null;
}

export interface CcmLimitation {
  path: string | null;
  reason: string;
  stage: string;
}

/** Serializable snapshot result. Timestamps, queue IDs and job progress belong in an outer envelope. */
export interface CcmV1 {
  schemaVersion: typeof SCHEMA_VERSION;
  snapshot: CcmSnapshot;
  provenance: CcmProvenance;
  files: CcmFile[];
  nodes: CcmNode[];
  edges: CcmEdge[];
  limitations: CcmLimitation[];
}

export type CcmErrorCode =
  | "CCM_INPUT_INVALID"
  | "CCM_UNKNOWN_FIELD"
  | "CCM_SCHEMA_VERSION_INVALID"
  | "CCM_SNAPSHOT_INVALID"
  | "CCM_PROVENANCE_INVALID"
  | "CCM_FILE_INVALID"
  | "CCM_FILE_PATH_INVALID"
  | "CCM_FILE_DUPLICATE"
  | "CCM_SOURCE_SET_MISMATCH"
  | "CCM_FILE_HASH_MISMATCH"
  | "CCM_FILE_SIZE_MISMATCH"
  | "CCM_NODE_INVALID"
  | "CCM_NODE_REGISTRY_INVALID"
  | "CCM_NODE_ID_INVALID"
  | "CCM_NODE_ID_DUPLICATE"
  | "CCM_NODE_LOCATION_INVALID"
  | "CCM_NODE_PARENT_DANGLING"
  | "CCM_NODE_PARENT_CYCLE"
  | "CCM_EDGE_INVALID"
  | "CCM_EDGE_REGISTRY_INVALID"
  | "CCM_EDGE_ID_INVALID"
  | "CCM_EDGE_ID_DUPLICATE"
  | "CCM_EDGE_ENDPOINT_DANGLING"
  | "CCM_EDGE_RESOLUTION_INVALID"
  | "CCM_EDGE_EVIDENCE_INVALID"
  | "CCM_EDGE_UNRESOLVED_REASON_INVALID"
  | "CCM_UNRESOLVED_PLACEHOLDER_INVALID"
  | "CCM_LIMITATION_INVALID"
  | "CCM_EVIDENCE_INVALID"
  | "CCM_EVIDENCE_BOUNDS_INVALID"
  | "CCM_UTF8_INVALID"
  | "CCM_EVIDENCE_POSITION_INVALID";

export type CcmValidationResult =
  | { ok: true; value: CcmV1 }
  | { ok: false; errorCode: CcmErrorCode };

export type CanonicalCcmResult =
  | { ok: true; value: CcmV1; json: string; sha256: string }
  | { ok: false; errorCode: CcmErrorCode };

export interface NodeIdInput {
  snapshotSha: string;
  language: Language;
  filePath: string | null;
  kind: NodeKind;
  qualifiedName: string;
  startByte: number | null;
  endByte: number | null;
}

export interface EdgeIdInput {
  snapshotSha: string;
  sourceId: string;
  targetId: string;
  kind: EdgeKind;
  resolution: EdgeResolution;
  evidence: EvidenceSpan[];
  unresolvedReason: UnresolvedReason | null;
}

class ContractFailure extends Error {
  constructor(readonly code: CcmErrorCode) {
    super(code);
  }
}

function fail(code: CcmErrorCode): never {
  throw new ContractFailure(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function expectShape(value: unknown, required: readonly string[], optional: readonly string[] = []): asserts value is Record<string, unknown> {
  if (!isRecord(value)) fail("CCM_INPUT_INVALID");
  const allowed = new Set([...required, ...optional]);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.has(key)) fail("CCM_UNKNOWN_FIELD");
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) fail("CCM_INPUT_INVALID");
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) fail("CCM_INPUT_INVALID");
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isInteger(value: unknown, minimum = 0): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}

function isMember<T extends string>(value: unknown, items: readonly T[]): value is T {
  return typeof value === "string" && (items as readonly string[]).includes(value);
}

function isSafeSnapshotPath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.startsWith("/") || value.includes("\\") || value.includes("\0")) return false;
  const parts = value.split("/");
  return parts.every((part) => part !== "" && part !== "." && part !== "..");
}

function validateJsonValue(value: unknown, depth = 0): value is JsonValue {
  if (depth > 64) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) {
    const keys = Reflect.ownKeys(value);
    if (keys.length !== value.length + 1 || keys.some((key) => typeof key !== "string")) return false;
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable || !validateJsonValue(descriptor.value, depth + 1)) return false;
    }
    return true;
  }
  if (!isRecord(value)) return false;
  return Reflect.ownKeys(value).every((key) => {
    if (typeof key !== "string" || key === "__proto__" || key === "constructor" || key === "prototype") return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return !!descriptor && "value" in descriptor && descriptor.enumerable && validateJsonValue(descriptor.value, depth + 1);
  });
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(",")}}`;
}

function digest(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function createNodeId(input: NodeIdInput): string {
  const identity = {
    snapshotSha: input.snapshotSha.toLowerCase(),
    language: input.language,
    filePath: input.filePath,
    kind: input.kind,
    qualifiedName: input.qualifiedName,
    startByte: input.startByte,
    endByte: input.endByte,
  };
  return `node_${digest(stableJson(identity))}`;
}

export function createEdgeId(input: EdgeIdInput): string {
  const evidence = [...input.evidence].sort(compareEvidence);
  const identity = {
    snapshotSha: input.snapshotSha.toLowerCase(),
    sourceId: input.sourceId,
    targetId: input.targetId,
    kind: input.kind,
    resolution: input.resolution,
    evidence,
    unresolvedReason: input.unresolvedReason,
  };
  return `edge_${digest(stableJson(identity))}`;
}

const utf8Decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function positionAt(source: Uint8Array, byteOffset: number): { line: number; column: number } {
  const prefix = utf8Decoder.decode(source.subarray(0, byteOffset));
  const lines = prefix.split("\n");
  return { line: lines.length, column: Array.from(lines.at(-1) ?? "").length + 1 };
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareEvidence(left: EvidenceSpan, right: EvidenceSpan): number {
  return compareStrings(left.filePath, right.filePath) || left.startByte - right.startByte || left.endByte - right.endByte || compareStrings(left.role, right.role);
}

function validateEvidence(
  value: unknown,
  files: Map<string, CcmFile>,
  sources: Readonly<Record<string, Uint8Array>>,
  allowedRoles: readonly EvidenceRole[] = EVIDENCE_ROLES,
): EvidenceSpan {
  expectShape(value, ["filePath", "fileSha256", "startByte", "endByte", "startLine", "endLine", "startColumn", "endColumn", "role"]);
  if (!isSafeSnapshotPath(value.filePath) || !isSha256(value.fileSha256) || !isMember(value.role, allowedRoles) ||
    !isInteger(value.startByte) || !isInteger(value.endByte) || !isInteger(value.startLine, 1) || !isInteger(value.endLine, 1) ||
    !isInteger(value.startColumn, 1) || !isInteger(value.endColumn, 1) || value.startByte >= value.endByte) {
    fail("CCM_EVIDENCE_INVALID");
  }
  const file = files.get(value.filePath);
  const source = sources[value.filePath];
  if (!file || !source || value.fileSha256 !== file.sha256) fail("CCM_EVIDENCE_INVALID");
  if (value.endByte > source.byteLength) fail("CCM_EVIDENCE_BOUNDS_INVALID");
  try {
    const start = positionAt(source, value.startByte);
    const end = positionAt(source, value.endByte);
    if (start.line !== value.startLine || start.column !== value.startColumn || end.line !== value.endLine || end.column !== value.endColumn) {
      fail("CCM_EVIDENCE_POSITION_INVALID");
    }
  } catch (error) {
    if (error instanceof ContractFailure) throw error;
    fail("CCM_UTF8_INVALID");
  }
  return value as unknown as EvidenceSpan;
}

function validateCcmUnsafe(input: unknown, sources: Readonly<Record<string, Uint8Array>>): CcmV1 {
  expectShape(input, ["schemaVersion", "snapshot", "provenance", "files", "nodes", "edges", "limitations"]);
  if (input.schemaVersion !== SCHEMA_VERSION) fail("CCM_SCHEMA_VERSION_INVALID");

  expectShape(input.snapshot, ["repository", "branch", "commitSha"]);
  if (!isNonEmptyString(input.snapshot.repository) || !(input.snapshot.branch === null || isNonEmptyString(input.snapshot.branch)) ||
    typeof input.snapshot.commitSha !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(input.snapshot.commitSha)) {
    fail("CCM_SNAPSHOT_INVALID");
  }
  expectShape(input.provenance, ["analyzer", "resolver", "configHash"]);
  expectShape(input.provenance.analyzer, ["name", "version"]);
  expectShape(input.provenance.resolver, ["name", "version"]);
  if (!isNonEmptyString(input.provenance.analyzer.name) || !isNonEmptyString(input.provenance.analyzer.version) ||
    !isNonEmptyString(input.provenance.resolver.name) || !isNonEmptyString(input.provenance.resolver.version) || !isSha256(input.provenance.configHash)) {
    fail("CCM_PROVENANCE_INVALID");
  }

  if (!Array.isArray(input.files) || !Array.isArray(input.nodes) || !Array.isArray(input.edges) || !Array.isArray(input.limitations)) {
    fail("CCM_INPUT_INVALID");
  }
  if (!isRecord(sources)) fail("CCM_SOURCE_SET_MISMATCH");
  const files: CcmFile[] = [];
  const fileMap = new Map<string, CcmFile>();
  for (const raw of input.files) {
    expectShape(raw, ["path", "language", "sha256", "sizeBytes", "status"]);
    if (!isSafeSnapshotPath(raw.path)) fail("CCM_FILE_PATH_INVALID");
    if (fileMap.has(raw.path)) fail("CCM_FILE_DUPLICATE");
    if (!(raw.language === null || isMember(raw.language, LANGUAGES)) || !isSha256(raw.sha256) || !isInteger(raw.sizeBytes) ||
      !isMember(raw.status, ["processed", "excluded", "failed"] as const) ||
      (raw.language === null && raw.status === "processed")) fail("CCM_FILE_INVALID");
    const file = raw as unknown as CcmFile;
    files.push(file);
    fileMap.set(file.path, file);
  }
  const sourceKeys = Reflect.ownKeys(sources);
  if (sourceKeys.some((key) => typeof key !== "string") || sourceKeys.length !== fileMap.size ||
    sourceKeys.some((key) => !fileMap.has(key as string))) fail("CCM_SOURCE_SET_MISMATCH");
  for (const file of files) {
    const source = sources[file.path];
    if (!(source instanceof Uint8Array)) fail("CCM_SOURCE_SET_MISMATCH");
    if (source.byteLength !== file.sizeBytes) fail("CCM_FILE_SIZE_MISMATCH");
    if (digest(source) !== file.sha256) fail("CCM_FILE_HASH_MISMATCH");
  }

  const nodes: CcmNode[] = [];
  const nodeMap = new Map<string, CcmNode>();
  for (const raw of input.nodes) {
    expectShape(raw, ["id", "kind", "name", "qualifiedName", "language", "filePath", "location", "parentId", "origin", "signature", "attributes"]);
    if (!isMember(raw.kind, NODE_KINDS) || !isMember(raw.language, LANGUAGES) || !isMember(raw.origin, NODE_ORIGINS)) {
      fail("CCM_NODE_REGISTRY_INVALID");
    }
    if (!isNonEmptyString(raw.id) || !isNonEmptyString(raw.name) || !isNonEmptyString(raw.qualifiedName) ||
      !(raw.filePath === null || isSafeSnapshotPath(raw.filePath)) || !(raw.parentId === null || isNonEmptyString(raw.parentId)) ||
      !(raw.signature === null || typeof raw.signature === "string") || !isRecord(raw.attributes) || !validateJsonValue(raw.attributes)) {
      fail("CCM_NODE_INVALID");
    }
    if ((raw.kind === "UnresolvedReference") !== (raw.origin === "unresolved")) fail("CCM_NODE_REGISTRY_INVALID");
    if (nodeMap.has(raw.id)) fail("CCM_NODE_ID_DUPLICATE");

    let location: EvidenceSpan | null = null;
    if (raw.origin === "source") {
      if (!raw.filePath || raw.location === null) fail("CCM_NODE_LOCATION_INVALID");
      const file = fileMap.get(raw.filePath);
      if (!file || file.status !== "processed" || file.language !== raw.language) fail("CCM_NODE_LOCATION_INVALID");
      location = validateEvidence(raw.location, fileMap, sources, ["declaration"]);
      if (location.filePath !== raw.filePath || location.fileSha256 !== file.sha256) fail("CCM_NODE_LOCATION_INVALID");
    } else if (raw.filePath !== null || raw.location !== null || raw.parentId !== null) {
      fail("CCM_NODE_LOCATION_INVALID");
    }

    const node = { ...raw, location } as unknown as CcmNode;
    const expectedId = createNodeId({
      snapshotSha: input.snapshot.commitSha,
      language: node.language,
      filePath: node.filePath,
      kind: node.kind,
      qualifiedName: node.qualifiedName,
      startByte: location?.startByte ?? null,
      endByte: location?.endByte ?? null,
    });
    if (node.id !== expectedId) fail("CCM_NODE_ID_INVALID");
    nodes.push(node);
    nodeMap.set(node.id, node);
  }

  for (const node of nodes) {
    if (node.parentId === null) continue;
    const parent = nodeMap.get(node.parentId);
    if (!parent || parent.origin !== "source" || parent.filePath !== node.filePath || parent.id === node.id) fail("CCM_NODE_PARENT_DANGLING");
  }
  const parentState = new Map<string, 0 | 1 | 2>();
  const visitParent = (id: string): void => {
    const state = parentState.get(id) ?? 0;
    if (state === 1) fail("CCM_NODE_PARENT_CYCLE");
    if (state === 2) return;
    parentState.set(id, 1);
    const parentId = nodeMap.get(id)?.parentId;
    if (parentId) visitParent(parentId);
    parentState.set(id, 2);
  };
  for (const node of nodes) visitParent(node.id);

  const edges: CcmEdge[] = [];
  const edgeIds = new Set<string>();
  const unresolvedTargets = new Set<string>();
  for (const raw of input.edges) {
    expectShape(raw, ["id", "sourceId", "targetId", "kind", "resolution", "evidence", "unresolvedReason"]);
    if (!isMember(raw.kind, EDGE_KINDS)) fail("CCM_EDGE_REGISTRY_INVALID");
    if (!isNonEmptyString(raw.id) || !isNonEmptyString(raw.sourceId) || !isNonEmptyString(raw.targetId)) fail("CCM_EDGE_INVALID");
    if (!isMember(raw.resolution, EDGE_RESOLUTIONS)) fail("CCM_EDGE_RESOLUTION_INVALID");
    if (raw.resolution === "Exact" ? raw.unresolvedReason !== null : !isMember(raw.unresolvedReason, UNRESOLVED_REASONS)) {
      fail("CCM_EDGE_UNRESOLVED_REASON_INVALID");
    }
    if (!Array.isArray(raw.evidence) || raw.evidence.length === 0) fail("CCM_EDGE_EVIDENCE_INVALID");
    const evidence = raw.evidence.map((item) => validateEvidence(item, fileMap, sources));
    if (raw.resolution === "Unresolved" && !evidence.some((item) => item.role === "reference")) fail("CCM_EDGE_EVIDENCE_INVALID");
    if (edgeIds.has(raw.id)) fail("CCM_EDGE_ID_DUPLICATE");
    if (!nodeMap.has(raw.sourceId) || !nodeMap.has(raw.targetId)) fail("CCM_EDGE_ENDPOINT_DANGLING");
    const source = nodeMap.get(raw.sourceId)!;
    const target = nodeMap.get(raw.targetId)!;
    if (source.origin === "unresolved" || (raw.resolution === "Exact" && target.origin === "unresolved") ||
      (raw.resolution === "Unresolved" && (target.origin !== "unresolved" || target.kind !== "UnresolvedReference"))) {
      fail("CCM_UNRESOLVED_PLACEHOLDER_INVALID");
    }
    const edge = { ...raw, evidence } as unknown as CcmEdge;
    if (edge.id !== createEdgeId({
      snapshotSha: input.snapshot.commitSha,
      sourceId: edge.sourceId,
      targetId: edge.targetId,
      kind: edge.kind,
      resolution: edge.resolution,
      evidence: edge.evidence,
      unresolvedReason: edge.unresolvedReason,
    })) fail("CCM_EDGE_ID_INVALID");
    edgeIds.add(edge.id);
    if (edge.resolution === "Unresolved") unresolvedTargets.add(edge.targetId);
    edges.push(edge);
  }
  if (nodes.some((node) => node.origin === "unresolved" && !unresolvedTargets.has(node.id))) fail("CCM_UNRESOLVED_PLACEHOLDER_INVALID");

  const limitations: CcmLimitation[] = [];
  for (const raw of input.limitations) {
    expectShape(raw, ["path", "reason", "stage"]);
    if (!(raw.path === null || (isSafeSnapshotPath(raw.path) && fileMap.has(raw.path))) ||
      !isNonEmptyString(raw.reason) || !isNonEmptyString(raw.stage)) fail("CCM_LIMITATION_INVALID");
    limitations.push(raw as unknown as CcmLimitation);
  }

  return structuredClone({
    schemaVersion: SCHEMA_VERSION,
    snapshot: input.snapshot,
    provenance: input.provenance,
    files,
    nodes,
    edges,
    limitations,
  }) as unknown as CcmV1;
}

/** Validate unknown JSON plus the exact snapshot bytes used to produce it. */
export function validateCcm(input: unknown, sourceBytes: Readonly<Record<string, Uint8Array>>): CcmValidationResult {
  try {
    return { ok: true, value: validateCcmUnsafe(input, sourceBytes) };
  } catch (error) {
    return { ok: false, errorCode: error instanceof ContractFailure ? error.code : "CCM_INPUT_INVALID" };
  }
}

function canonicalModel(model: CcmV1): CcmV1 {
  const evidence = (item: EvidenceSpan): EvidenceSpan => ({
    filePath: item.filePath, fileSha256: item.fileSha256, startByte: item.startByte, endByte: item.endByte,
    startLine: item.startLine, endLine: item.endLine, startColumn: item.startColumn, endColumn: item.endColumn, role: item.role,
  });
  const files = model.files.map((file) => ({
    path: file.path, language: file.language, sha256: file.sha256, sizeBytes: file.sizeBytes, status: file.status,
  })).sort((left, right) => compareStrings(left.path, right.path));
  const nodes = model.nodes.map((node) => ({
    id: node.id, kind: node.kind, name: node.name, qualifiedName: node.qualifiedName, language: node.language,
    filePath: node.filePath, location: node.location ? evidence(node.location) : null, parentId: node.parentId,
    origin: node.origin, signature: node.signature, attributes: sortJsonObject(node.attributes),
  })).sort((left, right) => compareStrings(left.id, right.id));
  const edges = model.edges.map((edge) => ({
    id: edge.id, sourceId: edge.sourceId, targetId: edge.targetId, kind: edge.kind, resolution: edge.resolution,
    evidence: edge.evidence.map(evidence).sort(compareEvidence), unresolvedReason: edge.unresolvedReason,
  })).sort((left, right) => compareStrings(left.id, right.id));
  const limitations = model.limitations.map((limitation) => ({ path: limitation.path, reason: limitation.reason, stage: limitation.stage }))
    .sort((left, right) => compareStrings(stableJson(left), stableJson(right)));
  return {
    schemaVersion: SCHEMA_VERSION,
    snapshot: { repository: model.snapshot.repository, branch: model.snapshot.branch, commitSha: model.snapshot.commitSha.toLowerCase() },
    provenance: {
      analyzer: { name: model.provenance.analyzer.name, version: model.provenance.analyzer.version },
      resolver: { name: model.provenance.resolver.name, version: model.provenance.resolver.version },
      configHash: model.provenance.configHash,
    },
    files, nodes, edges, limitations,
  };
}

function sortJsonValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, JsonValue>;
    return Object.fromEntries(Object.keys(object).sort().map((key) => [key, sortJsonValue(object[key]!)]));
  }
  return value;
}

function sortJsonObject(value: Record<string, JsonValue>): Record<string, JsonValue> {
  return sortJsonValue(value) as Record<string, JsonValue>;
}

/** Canonical JSON/hash cover only CCM v1 fields; event/job metadata belongs outside this payload. */
export function canonicalizeCcm(input: unknown, sourceBytes: Readonly<Record<string, Uint8Array>>): CanonicalCcmResult {
  const validation = validateCcm(input, sourceBytes);
  if (!validation.ok) return validation;
  const value = canonicalModel(validation.value);
  const json = JSON.stringify(value);
  return { ok: true, value, json, sha256: digest(json) };
}

export * from "./stages.ts";
