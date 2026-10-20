import { createHash } from "node:crypto";
import {
  createEdgeId,
  createNodeId,
  validateCcm,
  type CcmEdge,
  type CcmNode,
  type CcmV1,
  type EvidenceSpan,
} from "@sage/contracts";

const snapshotSha = "a136f9c488b04116ac641732e451d2c4a8b6291e";
const sourceText = {
  "src/report.ts": [
    'import { formatLabel } from "./label";',
    'import type { ReportInput } from "./types";',
    "",
    "export class ReportService implements ReportInput {",
    '  readonly label = "report";',
    "  build(input: string): string {",
    "    return formatLabel(input);",
    "  }",
    "}",
    "",
    "export function startReport(input: string, formatter: { format(value: string): string }): string {",
    "  const service = new ReportService();",
    "  if (input.trim()) {",
    "    return service.build(input);",
    "  }",
    "  return formatter.format(input);",
    "}",
    "",
  ].join("\n"),
  "src/types.ts": [
    "export interface ReportInput {",
    "  build(input: string): string;",
    "}",
    "",
  ].join("\n"),
  "src/label.ts": [
    "export function formatLabel(value: string): string {",
    "  return value.trim();",
    "}",
    "",
  ].join("\n"),
} as const;

const sourceBytes: Record<keyof typeof sourceText, Uint8Array> = {
  "src/report.ts": Buffer.from(sourceText["src/report.ts"], "utf8"),
  "src/types.ts": Buffer.from(sourceText["src/types.ts"], "utf8"),
  "src/label.ts": Buffer.from(sourceText["src/label.ts"], "utf8"),
};

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function positionAt(bytes: Uint8Array, offset: number): { line: number; column: number } {
  const prefix = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, offset));
  const lines = prefix.split("\n");
  return { line: lines.length, column: Array.from(lines.at(-1) ?? "").length + 1 };
}

function evidence(path: keyof typeof sourceText, marker: string, role: EvidenceSpan["role"]): EvidenceSpan {
  const bytes = sourceBytes[path];
  const markerBytes = Buffer.from(marker, "utf8");
  const startByte = Buffer.from(bytes).indexOf(markerBytes);
  if (startByte < 0) throw new Error(`Fixture marker not found: ${path}`);
  const endByte = startByte + markerBytes.byteLength;
  const start = positionAt(bytes, startByte);
  const end = positionAt(bytes, endByte);
  return {
    filePath: path,
    fileSha256: sha256(bytes),
    startByte,
    endByte,
    startLine: start.line,
    endLine: end.line,
    startColumn: start.column,
    endColumn: end.column,
    role,
  };
}

function sourceNode(options: {
  kind: CcmNode["kind"];
  name: string;
  qualifiedName: string;
  path: keyof typeof sourceText;
  marker: string;
  parentId?: string | null;
  wholeFile?: boolean;
}): CcmNode {
  const location = evidence(options.path, options.wholeFile ? sourceText[options.path] : options.marker, "declaration");
  return {
    id: createNodeId({
      snapshotSha,
      language: "typescript",
      filePath: options.path,
      kind: options.kind,
      qualifiedName: options.qualifiedName,
      startByte: location.startByte,
      endByte: location.endByte,
    }),
    kind: options.kind,
    name: options.name,
    qualifiedName: options.qualifiedName,
    language: "typescript",
    filePath: options.path,
    location,
    parentId: options.parentId ?? null,
    origin: "source",
    signature: null,
    attributes: {},
  };
}

function unresolvedNode(): CcmNode {
  const kind = "UnresolvedReference" as const;
  const qualifiedName = "formatter.format";
  return {
    id: createNodeId({
      snapshotSha,
      language: "typescript",
      filePath: null,
      kind,
      qualifiedName,
      startByte: null,
      endByte: null,
    }),
    kind,
    name: qualifiedName,
    qualifiedName,
    language: "typescript",
    filePath: null,
    location: null,
    parentId: null,
    origin: "unresolved",
    signature: null,
    attributes: {},
  };
}

function edge(options: {
  source: CcmNode;
  target: CcmNode;
  kind: CcmEdge["kind"];
  path: keyof typeof sourceText;
  marker: string;
  resolution?: CcmEdge["resolution"];
  unresolvedReason?: CcmEdge["unresolvedReason"];
}): CcmEdge {
  const resolution = options.resolution ?? "Exact";
  const unresolvedReason = options.unresolvedReason ?? null;
  const span = evidence(options.path, options.marker, "reference");
  const edgeValue = {
    sourceId: options.source.id,
    targetId: options.target.id,
    kind: options.kind,
    resolution,
    evidence: [span],
    unresolvedReason,
  };
  return {
    id: createEdgeId({ snapshotSha, ...edgeValue }),
    ...edgeValue,
  };
}

function containment(source: CcmNode, target: CcmNode): CcmEdge {
  if (!target.location) throw new Error("Fixture containment requires a source declaration.");
  const value = {
    sourceId: source.id,
    targetId: target.id,
    kind: "CONTAINS" as const,
    resolution: "Exact" as const,
    evidence: [{ ...target.location }],
    unresolvedReason: null,
  };
  return { id: createEdgeId({ snapshotSha, ...value }), ...value };
}

const reportModule = sourceNode({ kind: "Module", name: "report.ts", qualifiedName: "src/report.ts", path: "src/report.ts", marker: "", wholeFile: true });
const reportClass = sourceNode({ kind: "Class", name: "ReportService", qualifiedName: "ReportService", path: "src/report.ts", marker: [
  "export class ReportService implements ReportInput {", '  readonly label = "report";',
  "  build(input: string): string {", "    return formatLabel(input);", "  }", "}",
].join("\n"), parentId: reportModule.id });
const reportMethod = sourceNode({ kind: "Method", name: "build", qualifiedName: "ReportService.build", path: "src/report.ts", marker: "build(input: string): string {\n    return formatLabel(input);\n  }", parentId: reportClass.id });
const reportProperty = sourceNode({ kind: "Property", name: "label", qualifiedName: "ReportService.label", path: "src/report.ts", marker: 'readonly label = "report";', parentId: reportClass.id });
const startReport = sourceNode({ kind: "Function", name: "startReport", qualifiedName: "startReport", path: "src/report.ts", marker: sourceText["src/report.ts"].slice(sourceText["src/report.ts"].indexOf("export function startReport")).trimEnd(), parentId: reportModule.id });
const typeModule = sourceNode({ kind: "Module", name: "types.ts", qualifiedName: "src/types.ts", path: "src/types.ts", marker: "", wholeFile: true });
const reportInput = sourceNode({ kind: "Interface", name: "ReportInput", qualifiedName: "ReportInput", path: "src/types.ts", marker: sourceText["src/types.ts"].trimEnd(), parentId: typeModule.id });
const labelModule = sourceNode({ kind: "Module", name: "label.ts", qualifiedName: "src/label.ts", path: "src/label.ts", marker: "", wholeFile: true });
const formatLabel = sourceNode({ kind: "Function", name: "formatLabel", qualifiedName: "formatLabel", path: "src/label.ts", marker: sourceText["src/label.ts"].trimEnd(), parentId: labelModule.id });
const unresolvedCall = unresolvedNode();

const nodes = [reportModule, reportClass, reportMethod, reportProperty, startReport, typeModule, reportInput, labelModule, formatLabel, unresolvedCall];
const edges = [
  containment(reportModule, reportClass),
  containment(reportClass, reportMethod),
  containment(reportClass, reportProperty),
  edge({ source: reportModule, target: reportInput, kind: "IMPORTS", path: "src/report.ts", marker: 'import type { ReportInput } from "./types"' }),
  edge({ source: reportClass, target: reportInput, kind: "IMPLEMENTS", path: "src/report.ts", marker: "implements ReportInput" }),
  edge({ source: reportModule, target: formatLabel, kind: "IMPORTS", path: "src/report.ts", marker: 'import { formatLabel } from "./label"' }),
  edge({ source: reportMethod, target: formatLabel, kind: "CALLS", path: "src/report.ts", marker: "formatLabel(input)" }),
  edge({ source: startReport, target: reportMethod, kind: "CALLS", path: "src/report.ts", marker: "service.build(input)" }),
  edge({ source: startReport, target: unresolvedCall, kind: "CALLS", path: "src/report.ts", marker: "formatter.format(input)", resolution: "Unresolved", unresolvedReason: "UNKNOWN_RECEIVER" }),
];

const files: CcmV1["files"] = Object.entries(sourceBytes).map(([path, bytes]) => ({
  path,
  language: "typescript",
  sha256: sha256(bytes),
  sizeBytes: bytes.byteLength,
  status: "processed",
}));

export interface GraphFixture {
  payload: CcmV1;
  sourceBytes: Readonly<Record<string, Uint8Array>>;
}

/** Small deterministic source-backed example. Every source span and identifier is derived from these bytes. */
export function createGraphFixture(): GraphFixture {
  return {
    payload: {
      schemaVersion: 1,
      snapshot: { repository: "contoh/report-service", branch: "fixture", commitSha: snapshotSha },
      provenance: {
        analyzer: { name: "sage-fixture", version: "1.0.0" },
        resolver: { name: "sage-fixture-resolver", version: "1.0.0" },
        configHash: "0".repeat(64),
      },
      files,
      nodes,
      edges,
      limitations: [],
    },
    sourceBytes,
  };
}

export function validateGraphFixture(fixture: GraphFixture = createGraphFixture()) {
  return validateCcm(fixture.payload, fixture.sourceBytes);
}
