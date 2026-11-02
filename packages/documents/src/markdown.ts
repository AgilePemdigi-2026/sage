import type { CcmEdge, CcmFile, CcmLimitation, CcmNode, EvidenceSpan } from "@sage/contracts";
import type { ArchitectureDocumentV1 } from "./architecture-document.ts";
import type { DiagramProjection } from "./diagrams.ts";
import { Buffer } from "node:buffer";

/** Bump when the stable Markdown layout or escaping rules change. */
export const MARKDOWN_RENDERER_VERSION = "1.0.0";
/** Maximum UTF-8 size accepted by the Markdown renderer and its streaming API. */
export const MAX_MARKDOWN_EXPORT_BYTES = 32 * 1024 * 1024;

/** A stable failure code for exports whose rendered Markdown exceeds the size limit. */
export class MarkdownExportTooLargeError extends Error {
  readonly code = "EXPORT_TOO_LARGE";
  readonly maxBytes: number;

  constructor(maxBytes: number) {
    super("Markdown export exceeds the maximum size.");
    this.name = "MarkdownExportTooLargeError";
    this.maxBytes = maxBytes;
  }
}

export interface MarkdownChunkOptions {
  /** A lower per-call limit; callers cannot raise the global 32 MiB ceiling. */
  maxBytes?: number;
}

type MarkdownLine = string | Iterable<string>;

const OUTPUT_CHUNK_CHARACTERS = 64 * 1024;

function visibleText(value: string): string {
  let result = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (character === "\n") result += "\\n";
    else if (character === "\r") result += "\\r";
    else if (character === "\t") result += "\\t";
    else if (codePoint < 0x20 || codePoint === 0x7f || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
      result += `\\u${codePoint.toString(16).padStart(4, "0")}`;
    } else result += character;
  }
  return result;
}

/** Use a dynamically sized code span so arbitrary model text stays literal Markdown. */
function inline(value: string | number | boolean | null): string {
  const text = visibleText(String(value));
  const runs = text.match(/`+/g) ?? [];
  const fence = "`".repeat(runs.reduce((longest, run) => Math.max(longest, run.length), 1) + 1);
  const padded = text.startsWith(" ") || text.endsWith(" ") || text.startsWith("`") || text.endsWith("`")
    ? ` ${text} `
    : text;
  return `${fence}${padded}${fence}`;
}

function* safeStringChunks(value: string): Generator<string> {
  let offset = 0;
  while (offset < value.length) {
    let end = Math.min(offset + OUTPUT_CHUNK_CHARACTERS, value.length);
    if (end < value.length) {
      const previous = value.charCodeAt(end - 1);
      const next = value.charCodeAt(end);
      if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end -= 1;
    }
    yield value.slice(offset, end);
    offset = end;
  }
}

function utf8BytesForCodePoint(codePoint: number): number {
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return 4;
}

function* utf8Chunks(value: string): Generator<string> {
  let start = 0;
  let offset = 0;
  let bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    const characterBytes = utf8BytesForCodePoint(codePoint);
    if (bytes > 0 && bytes + characterBytes > OUTPUT_CHUNK_CHARACTERS) {
      yield value.slice(start, offset);
      start = offset;
      bytes = 0;
    }
    bytes += characterBytes;
    offset += character.length;
    if (bytes === OUTPUT_CHUNK_CHARACTERS) {
      yield value.slice(start, offset);
      start = offset;
      bytes = 0;
    }
  }
  if (start < value.length) yield value.slice(start);
}

function* jsonStringChunks(value: string): Generator<string> {
  yield '"';
  let chunk = "";
  const flush = function* (): Generator<string> {
    if (chunk.length > 0) {
      yield chunk;
      chunk = "";
    }
  };
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    let serialized: string;
    if (character === '"') serialized = '\\"';
    else if (character === "\\") serialized = "\\\\";
    else if (character === "\b") serialized = "\\b";
    else if (character === "\f") serialized = "\\f";
    else if (character === "\n") serialized = "\\n";
    else if (character === "\r") serialized = "\\r";
    else if (character === "\t") serialized = "\\t";
    else if (codePoint < 0x20 || codePoint === 0x7f || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
      serialized = `\\u${codePoint.toString(16).padStart(4, "0")}`;
    } else serialized = character;

    chunk += serialized;
    if (chunk.length >= OUTPUT_CHUNK_CHARACTERS) yield* flush();
  }
  yield* flush();
  yield '"';
}

function* stableJsonChunks(value: unknown): Generator<string> {
  if (Array.isArray(value)) {
    yield "[";
    let first = true;
    for (const item of value) {
      if (!first) yield ",";
      yield* stableJsonChunks(item);
      first = false;
    }
    yield "]";
    return;
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    yield "{";
    let first = true;
    for (const key of Object.keys(record).sort()) {
      if (!first) yield ",";
      yield* jsonStringChunks(key);
      yield ":";
      yield* stableJsonChunks(record[key]);
      first = false;
    }
    yield "}";
    return;
  }
  if (typeof value === "string") {
    yield* jsonStringChunks(value);
    return;
  }
  yield JSON.stringify(value) ?? "null";
}

function longestBacktickRun(chunks: Iterable<string>): number {
  let longest = 0;
  let current = 0;
  for (const chunk of chunks) {
    for (const character of chunk) {
      if (character === "`") {
        current += 1;
        longest = Math.max(longest, current);
      } else current = 0;
    }
  }
  return longest;
}

function* stableJsonInlineChunks(value: unknown): Generator<string> {
  const longest = longestBacktickRun(stableJsonChunks(value));
  const fence = "`".repeat(Math.max(2, longest + 1));
  yield fence;
  yield* stableJsonChunks(value);
  yield fence;
}

function* codeFenceChunks(source: string, language: string): Generator<string> {
  const fence = "`".repeat(Math.max(3, longestBacktickRun([source]) + 1));
  yield `${fence}${language}\n`;
  yield* safeStringChunks(source);
  yield `\n${fence}`;
}

function* lineSegments(parts: readonly (string | Iterable<string>)[]): Generator<string> {
  for (const part of parts) {
    if (typeof part === "string") yield* safeStringChunks(part);
    else yield* part;
  }
}

function* lineChunks(line: MarkdownLine): Generator<string> {
  if (typeof line === "string") yield* safeStringChunks(line);
  else yield* line;
}

function* trimmedLineChunks(line: MarkdownLine): Generator<string> {
  let trailingWhitespace = "";
  for (const chunk of lineChunks(line)) {
    const combined = trailingWhitespace + chunk;
    const visibleLength = combined.trimEnd().length;
    if (visibleLength < combined.length) {
      if (visibleLength > 0) yield combined.slice(0, visibleLength);
      trailingWhitespace = combined.slice(visibleLength);
    } else {
      yield combined;
      trailingWhitespace = "";
    }
  }
}

function* documentOutputPieces(document: ArchitectureDocumentV1): Generator<string> {
  let previousLine: MarkdownLine | undefined;
  let pendingBlankLines = 0;
  for (const line of documentLines(document)) {
    if (line === "") {
      if (previousLine !== undefined) pendingBlankLines += 1;
      continue;
    }
    if (previousLine !== undefined) {
      yield* lineChunks(previousLine);
      yield "\n".repeat(pendingBlankLines + 1);
    }
    previousLine = line;
    pendingBlankLines = 0;
  }

  if (previousLine === undefined) {
    yield "\n";
    return;
  }
  yield* trimmedLineChunks(previousLine);
  yield "\n";
}

function* boundedOutputChunks(pieces: Iterable<string>, maxBytes: number): Generator<string> {
  let outputBuffer = "";
  let outputBufferBytes = 0;
  let emittedBytes = 0;

  for (const piece of pieces) {
    for (const chunk of utf8Chunks(piece)) {
      const chunkBytes = Buffer.byteLength(chunk, "utf8");
      if (emittedBytes + outputBufferBytes + chunkBytes > maxBytes) {
        throw new MarkdownExportTooLargeError(maxBytes);
      }
      if (outputBufferBytes > 0 && outputBufferBytes + chunkBytes > OUTPUT_CHUNK_CHARACTERS) {
        emittedBytes += outputBufferBytes;
        yield outputBuffer;
        outputBuffer = "";
        outputBufferBytes = 0;
      }
      outputBuffer += chunk;
      outputBufferBytes += chunkBytes;
      if (outputBufferBytes === OUTPUT_CHUNK_CHARACTERS) {
        emittedBytes += outputBufferBytes;
        yield outputBuffer;
        outputBuffer = "";
        outputBufferBytes = 0;
      }
    }
  }

  if (outputBuffer.length > 0) yield outputBuffer;
}

function evidenceLine(span: EvidenceSpan, indent: string): string {
  return `${indent}- Evidence: ${inline(span.role)} in ${inline(span.filePath)}; SHA-256 ${inline(span.fileSha256)}; bytes [${inline(span.startByte)}, ${inline(span.endByte)}); positions [${inline(`${span.startLine}:${span.startColumn}`)}, ${inline(`${span.endLine}:${span.endColumn}`)}) (1-based line:Unicode-code-point column; end exclusive).`;
}

function* evidenceLines(spans: readonly EvidenceSpan[], indent: string): Generator<string> {
  if (spans.length === 0) {
    yield `${indent}- Evidence: none recorded.`;
    return;
  }
  for (const span of spans) yield evidenceLine(span, indent);
}

function* nodeLines(node: CcmNode, indent: string): Generator<MarkdownLine> {
  yield `${indent}- Node ID: ${inline(node.id)}`;
  yield `${indent}  - Kind / origin / language: ${inline(node.kind)} / ${inline(node.origin)} / ${inline(node.language)}`;
  yield `${indent}  - Name: ${inline(node.name)}`;
  yield `${indent}  - Qualified name: ${inline(node.qualifiedName)}`;
  yield `${indent}  - File path: ${inline(node.filePath)}`;
  yield `${indent}  - Parent node ID: ${inline(node.parentId)}`;
  yield `${indent}  - Signature: ${inline(node.signature)}`;
  yield lineSegments([`${indent}  - Attributes (canonical JSON): `, stableJsonInlineChunks(node.attributes)]);
  if (node.location) yield evidenceLine(node.location, `${indent}  `);
  else yield `${indent}  - Location evidence: none.`;
}

function* edgeLines(edge: CcmEdge, indent: string): Generator<string> {
  yield `${indent}- Edge ID: ${inline(edge.id)}`;
  yield `${indent}  - Endpoints: ${inline(edge.sourceId)} → ${inline(edge.targetId)}`;
  yield `${indent}  - Kind / resolution: ${inline(edge.kind)} / ${inline(edge.resolution)}`;
  yield `${indent}  - Unresolved reason: ${inline(edge.unresolvedReason)}`;
  yield* evidenceLines(edge.evidence, `${indent}  `);
}

function fileLines(file: CcmFile): string[] {
  return [
    `- File: ${inline(file.path)}`,
    `  - Language / status: ${inline(file.language)} / ${inline(file.status)}`,
    `  - Size: ${inline(file.sizeBytes)} bytes; SHA-256: ${inline(file.sha256)}`,
  ];
}

function limitationLines(limitation: CcmLimitation): string[] {
  return [
    `- Stage: ${inline(limitation.stage)}`,
    `  - Path: ${inline(limitation.path)}`,
    `  - Limitation: ${inline(limitation.reason)}`,
  ];
}

function mappingLines(
  mapping: DiagramProjection["nodeMappings"][number] | undefined,
  indent: string,
): string[] {
  if (!mapping) return [`${indent}- Diagram mapping: none.`];
  const lines = [
    `${indent}- Diagram mapping: Mermaid line ${inline(mapping.mermaidLine)}; Mermaid node ID ${inline(mapping.mermaidId)}; parent Mermaid node ID ${inline(mapping.parentMermaidId ?? null)}.`,
  ];
  if (mapping.parentContainmentEdgeIds) {
    lines.push(`${indent}  - Parent containment edge IDs: ${mapping.parentContainmentEdgeIds.map(inline).join(", ") || "none"}.`);
  }
  if (mapping.evidence) lines.push(evidenceLine(mapping.evidence, `${indent}  `));
  else lines.push(`${indent}  - Mapping evidence: none.`);
  return lines;
}

function* edgeMappingLines(
  mapping: DiagramProjection["edgeMappings"][number] | undefined,
  indent: string,
): Generator<string> {
  if (!mapping) {
    yield `${indent}- Diagram mapping: none.`;
    return;
  }
  yield `${indent}- Diagram mapping: Mermaid line ${inline(mapping.mermaidLine)}; source Mermaid node ID ${inline(mapping.sourceMermaidId)}; target Mermaid node ID ${inline(mapping.targetMermaidId)}.`;
  yield* evidenceLines(mapping.evidence, `${indent}  `);
}

function* diagramLines(title: string, diagram: DiagramProjection): Generator<MarkdownLine> {
  yield* [
    `## ${title}`,
    "",
    `- Projection kind: ${inline(diagram.kind)}`,
    `- Projection title: ${inline(diagram.title)}`,
    "",
    "### Canonical Mermaid payload",
    "",
    codeFenceChunks(diagram.mermaid, "mermaid"),
    "",
    "### Textual node legend",
    "",
    "The entries below retain node facts, IDs, locations, and evidence without requiring a Mermaid renderer.",
    "",
  ];
  const nodeMappingById = new Map(diagram.nodeMappings.map(mapping => [mapping.nodeId, mapping]));
  const edgeMappingById = new Map(diagram.edgeMappings.map(mapping => [mapping.edgeId, mapping]));
  if (diagram.nodes.length === 0) yield "- No nodes are included in this projection.";
  for (const node of diagram.nodes) {
    yield* nodeLines(node, "");
    for (const line of mappingLines(nodeMappingById.get(node.id), "  ")) yield line;
    yield "";
  }
  yield* [
    "### Textual edges",
    "",
    "Each edge keeps its canonical endpoint IDs, resolution status, unresolved reason, and source evidence.",
    "",
  ];
  if (diagram.edges.length === 0) yield "- No edges are included in this projection.";
  for (const edge of diagram.edges) {
    yield* edgeLines(edge, "");
    yield* edgeMappingLines(edgeMappingById.get(edge.id), "  ");
    yield "";
  }
  yield "### Excluded canonical IDs";
  yield "";
  yield "Node IDs:";
  if (diagram.excludedNodeIds.length === 0) yield "- none";
  for (const id of diagram.excludedNodeIds) yield `- ${inline(id)}`;
  yield "";
  yield "Edge IDs:";
  if (diagram.excludedEdgeIds.length === 0) yield "- none";
  for (const id of diagram.excludedEdgeIds) yield `- ${inline(id)}`;
  yield "";
}

function* documentLines(document: ArchitectureDocumentV1): Generator<MarkdownLine> {
  yield* [
    `# ${inline(document.title)}`,
    "",
    "## Snapshot and provenance",
    "",
    `- Schema version: ${inline(document.schemaVersion)}`,
    `- Repository: ${inline(document.snapshot.repository)}`,
    `- Branch: ${inline(document.snapshot.branch)}`,
    `- Commit SHA: ${inline(document.snapshot.commitSha)}`,
    `- Canonical CKG SHA-256: ${inline(document.ckgSha256)}`,
    `- Configuration hash: ${inline(document.configurationHash)}`,
    `- Analyzer: ${inline(document.provenance.analyzer.name)} version ${inline(document.provenance.analyzer.version)}`,
    `- Resolver: ${inline(document.provenance.resolver.name)} version ${inline(document.provenance.resolver.version)}`,
    `- Provenance configuration hash: ${inline(document.provenance.configHash)}`,
    `- Markdown renderer version: ${inline(MARKDOWN_RENDERER_VERSION)}`,
    "",
    "### Canonical counts",
    "",
    `- Nodes: ${inline(document.canonicalCounts.nodes)}`,
    `- Edges: ${inline(document.canonicalCounts.edges)}`,
    `- Containment edges: ${inline(document.canonicalCounts.containmentEdges)}`,
    `- Reference edges: ${inline(document.canonicalCounts.referenceEdges)}`,
    `- Exact edges: ${inline(document.canonicalCounts.exactEdges)}`,
    `- Unresolved edges: ${inline(document.canonicalCounts.unresolvedEdges)}`,
    "",
    "## Snapshot files and status",
    "",
    "File status is reported per snapshot file; relationship resolution is reported as Exact or Unresolved in the catalog and diagrams.",
    "",
  ];
  if (document.files.length === 0) yield "- No source files are recorded in this snapshot.";
  for (const file of document.files) {
    yield* fileLines(file);
    yield "";
  }

  yield* [
    "## Interface Catalog",
    "",
    `- Scope: ${inline(document.interfaceCatalog.scope)}`,
    "",
    "### Source declarations",
    "",
    "Entries cover source declarations represented in the canonical graph. Node IDs, incident edge IDs, export edge IDs, and evidence are listed explicitly.",
    "",
  ];
  if (document.interfaceCatalog.entries.length === 0) yield "- No catalog declarations are recorded.";
  for (const entry of document.interfaceCatalog.entries) {
    yield `### Declaration ${inline(entry.declaration.id)}`;
    yield "";
    yield* nodeLines(entry.declaration, "");
    yield `- Associated node IDs: ${entry.nodeIds.map(inline).join(", ") || "none"}`;
    yield `- Incident edge IDs: ${entry.edgeIds.map(inline).join(", ") || "none"}`;
    yield `- Export edge IDs: ${entry.exportEdgeIds.map(inline).join(", ") || "none"}`;
    yield "- Catalog evidence:";
    if (entry.evidence.length > 0) yield* evidenceLines(entry.evidence, "  ");
    else yield "  - none recorded";
    yield "";
  }
  yield "### Canonical relations";
  yield "";
  if (document.interfaceCatalog.relations.length === 0) yield "- No canonical relations are recorded.";
  for (const edge of document.interfaceCatalog.relations) {
    yield* edgeLines(edge, "");
    yield "";
  }

  yield "## Status and limitations";
  yield "";
  yield "The export records canonical snapshot file statuses and Exact/Unresolved relation states. It contains no job timestamp or export ID.";
  yield "";
  if (document.limitations.length === 0) {
    yield "- No analyzer limitations are recorded.";
    yield "";
  }
  else {
    for (const limitation of document.limitations) {
      yield* limitationLines(limitation);
      yield "";
    }
  }

  yield* diagramLines("Software Engineering Diagram", document.softwareEngineeringDiagram);
  yield* diagramLines("UML Class Diagram", document.umlClassDiagram);
}

/** Yield standalone Markdown chunks while enforcing the UTF-8 byte cap. */
export function* renderMarkdownDocumentChunks(
  document: ArchitectureDocumentV1,
  options: MarkdownChunkOptions = {},
): Generator<string> {
  const requestedMaxBytes = options.maxBytes ?? MAX_MARKDOWN_EXPORT_BYTES;
  if (!Number.isSafeInteger(requestedMaxBytes) || requestedMaxBytes < 1) {
    throw new RangeError("maxBytes must be a positive safe integer.");
  }
  const maxBytes = Math.min(requestedMaxBytes, MAX_MARKDOWN_EXPORT_BYTES);
  yield* boundedOutputChunks(documentOutputPieces(document), maxBytes);
}

/** Render a canonical architecture document as deterministic, standalone Markdown. */
export function renderMarkdownDocument(
  document: ArchitectureDocumentV1,
  options: MarkdownChunkOptions = {},
): string {
  let rendered = "";
  for (const chunk of renderMarkdownDocumentChunks(document, options)) rendered += chunk;
  return rendered;
}
