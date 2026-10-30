import type { CcmEdge, CcmFile, CcmLimitation, CcmNode, EvidenceSpan } from "@sage/contracts";
import type { ArchitectureDocumentV1 } from "./architecture-document.ts";
import type { DiagramProjection } from "./diagrams.ts";

/** Bump when the stable Markdown layout or escaping rules change. */
export const MARKDOWN_RENDERER_VERSION = "1.0.0";

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

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const fields = Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableJson(record[key])}`);
    return `{${fields.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function evidenceLine(span: EvidenceSpan, indent: string): string {
  return `${indent}- Evidence: ${inline(span.role)} in ${inline(span.filePath)}; SHA-256 ${inline(span.fileSha256)}; bytes [${inline(span.startByte)}, ${inline(span.endByte)}); positions [${inline(`${span.startLine}:${span.startColumn}`)}, ${inline(`${span.endLine}:${span.endColumn}`)}) (1-based line:Unicode-code-point column; end exclusive).`;
}

function evidenceLines(spans: readonly EvidenceSpan[], indent: string): string[] {
  return spans.length > 0 ? spans.map(span => evidenceLine(span, indent)) : [`${indent}- Evidence: none recorded.`];
}

function nodeLines(node: CcmNode, indent: string): string[] {
  const lines = [
    `${indent}- Node ID: ${inline(node.id)}`,
    `${indent}  - Kind / origin / language: ${inline(node.kind)} / ${inline(node.origin)} / ${inline(node.language)}`,
    `${indent}  - Name: ${inline(node.name)}`,
    `${indent}  - Qualified name: ${inline(node.qualifiedName)}`,
    `${indent}  - File path: ${inline(node.filePath)}`,
    `${indent}  - Parent node ID: ${inline(node.parentId)}`,
    `${indent}  - Signature: ${inline(node.signature)}`,
    `${indent}  - Attributes (canonical JSON): ${inline(stableJson(node.attributes))}`,
  ];
  if (node.location) lines.push(evidenceLine(node.location, `${indent}  `));
  else lines.push(`${indent}  - Location evidence: none.`);
  return lines;
}

function edgeLines(edge: CcmEdge, indent: string): string[] {
  const lines = [
    `${indent}- Edge ID: ${inline(edge.id)}`,
    `${indent}  - Endpoints: ${inline(edge.sourceId)} → ${inline(edge.targetId)}`,
    `${indent}  - Kind / resolution: ${inline(edge.kind)} / ${inline(edge.resolution)}`,
    `${indent}  - Unresolved reason: ${inline(edge.unresolvedReason)}`,
  ];
  lines.push(...evidenceLines(edge.evidence, `${indent}  `));
  return lines;
}

function codeFence(source: string, language: string): string {
  const runs = source.match(/`+/g) ?? [];
  const fence = "`".repeat(runs.reduce((longest, run) => Math.max(longest, run.length + 1), 3));
  return `${fence}${language}\n${source}\n${fence}`;
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

function edgeMappingLines(
  mapping: DiagramProjection["edgeMappings"][number] | undefined,
  indent: string,
): string[] {
  if (!mapping) return [`${indent}- Diagram mapping: none.`];
  return [
    `${indent}- Diagram mapping: Mermaid line ${inline(mapping.mermaidLine)}; source Mermaid node ID ${inline(mapping.sourceMermaidId)}; target Mermaid node ID ${inline(mapping.targetMermaidId)}.`,
    ...evidenceLines(mapping.evidence, `${indent}  `),
  ];
}

function diagramLines(title: string, diagram: DiagramProjection): string[] {
  const nodeMappingById = new Map(diagram.nodeMappings.map(mapping => [mapping.nodeId, mapping]));
  const edgeMappingById = new Map(diagram.edgeMappings.map(mapping => [mapping.edgeId, mapping]));
  const lines = [
    `## ${title}`,
    "",
    `- Projection kind: ${inline(diagram.kind)}`,
    `- Projection title: ${inline(diagram.title)}`,
    "",
    "### Canonical Mermaid payload",
    "",
    codeFence(diagram.mermaid, "mermaid"),
    "",
    "### Textual node legend",
    "",
    "The entries below retain node facts, IDs, locations, and evidence without requiring a Mermaid renderer.",
    "",
  ];
  if (diagram.nodes.length === 0) lines.push("- No nodes are included in this projection.");
  for (const node of diagram.nodes) {
    lines.push(...nodeLines(node, ""));
    lines.push(...mappingLines(nodeMappingById.get(node.id), "  "), "");
  }
  lines.push(
    "### Textual edges",
    "",
    "Each edge keeps its canonical endpoint IDs, resolution status, unresolved reason, and source evidence.",
    "",
  );
  if (diagram.edges.length === 0) lines.push("- No edges are included in this projection.");
  for (const edge of diagram.edges) {
    lines.push(...edgeLines(edge, ""));
    lines.push(...edgeMappingLines(edgeMappingById.get(edge.id), "  "), "");
  }
  lines.push("### Excluded canonical IDs", "");
  lines.push("Node IDs:");
  if (diagram.excludedNodeIds.length === 0) lines.push("- none");
  for (const id of diagram.excludedNodeIds) lines.push(`- ${inline(id)}`);
  lines.push("", "Edge IDs:");
  if (diagram.excludedEdgeIds.length === 0) lines.push("- none");
  for (const id of diagram.excludedEdgeIds) lines.push(`- ${inline(id)}`);
  lines.push("");
  return lines;
}

/** Render a canonical architecture document as deterministic, standalone Markdown. */
export function renderMarkdownDocument(document: ArchitectureDocumentV1): string {
  const lines = [
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
  if (document.files.length === 0) lines.push("- No source files are recorded in this snapshot.");
  for (const file of document.files) lines.push(...fileLines(file), "");

  lines.push(
    "## Interface Catalog",
    "",
    `- Scope: ${inline(document.interfaceCatalog.scope)}`,
    "",
    "### Source declarations",
    "",
    "Entries cover source declarations represented in the canonical graph. Node IDs, incident edge IDs, export edge IDs, and evidence are listed explicitly.",
    "",
  );
  if (document.interfaceCatalog.entries.length === 0) lines.push("- No catalog declarations are recorded.");
  for (const entry of document.interfaceCatalog.entries) {
    lines.push(`### Declaration ${inline(entry.declaration.id)}`, "");
    lines.push(...nodeLines(entry.declaration, ""));
    lines.push(`- Associated node IDs: ${entry.nodeIds.map(inline).join(", ") || "none"}`);
    lines.push(`- Incident edge IDs: ${entry.edgeIds.map(inline).join(", ") || "none"}`);
    lines.push(`- Export edge IDs: ${entry.exportEdgeIds.map(inline).join(", ") || "none"}`);
    lines.push("- Catalog evidence:", ...(entry.evidence.length > 0
      ? evidenceLines(entry.evidence, "  ")
      : ["  - none recorded"]), "");
  }
  lines.push("### Canonical relations", "");
  if (document.interfaceCatalog.relations.length === 0) lines.push("- No canonical relations are recorded.");
  for (const edge of document.interfaceCatalog.relations) lines.push(...edgeLines(edge, ""), "");

  lines.push("## Status and limitations", "");
  lines.push("The export records canonical snapshot file statuses and Exact/Unresolved relation states. It contains no job timestamp or export ID.", "");
  if (document.limitations.length === 0) lines.push("- No analyzer limitations are recorded.", "");
  else {
    for (const limitation of document.limitations) lines.push(...limitationLines(limitation), "");
  }

  for (const line of diagramLines("Software Engineering Diagram", document.softwareEngineeringDiagram)) lines.push(line);
  for (const line of diagramLines("UML Class Diagram", document.umlClassDiagram)) lines.push(line);
  return `${lines.join("\n").trimEnd()}\n`;
}
