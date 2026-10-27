import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { chromium } from "playwright";
import type { CcmEdge, CcmFile, CcmLimitation, CcmNode, CcmProvenance, CcmSnapshot, EvidenceSpan } from "@sage/contracts";
import type { ArchitectureDocumentV1 } from "./architecture-document.ts";
import type { DiagramProjection } from "./diagrams.ts";
import { PDF_RENDERER_VERSION } from "./pdf-version.ts";

const MAX_MERMAID_SOURCE_CHARS = 50_000;
const MAX_MERMAID_SOURCE_BYTES = 50_000;
const MAX_DIAGRAM_NODES = 500;
const MAX_DIAGRAM_EDGES = 500;
const MAX_SVG_BYTES = 4 * 1024 * 1024;
const MAX_HTML_BYTES = 12 * 1024 * 1024;
const MAX_PDF_BYTES = 32 * 1024 * 1024;
const MAX_TILES_PER_DIAGRAM = 24;
const RENDER_TIMEOUT_MS = 45_000;
const MAX_TILE_WIDTH = 1_040;
const MAX_TILE_HEIGHT = 600;
const TILE_OVERLAP = 48;
const MIN_OVERVIEW_SCALE = 0.9;
const EVIDENCE_RANGE_NOTE = "Byte ranges are zero-based and end-exclusive. Line numbers and Unicode-code-point columns are one-based; end positions are exclusive.";

export type PdfRenderOptions = { signal?: AbortSignal };

type ViewBox = { x: number; y: number; width: number; height: number };
type DiagramTile = ViewBox & { row: number; column: number; label: string };
type DiagramLayout = { viewBox: ViewBox; tiles: DiagramTile[]; overview: boolean; overviewScale: number };
type EvidenceRegistry = { spans: EvidenceSpan[]; idBySpan: Map<string, string> };

function fail(code: string): never {
  throw new Error(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === "string");
}

function hashIsValid(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function hasUnsafeMermaidDirective(source: string): boolean {
  return source.split("\n").some(line => /^\s*%%\s*\{/.test(line) || /^\s*(?:click|href)\s+/i.test(line));
}

function safeSvgViewBox(svg: string): ViewBox {
  const match = svg.match(/\bviewBox\s*=\s*["']\s*(-?(?:\d+(?:\.\d*)?|\.\d+))[ ,]+(-?(?:\d+(?:\.\d*)?|\.\d+))[ ,]+(\d+(?:\.\d*)?|\.\d+)[ ,]+(\d+(?:\.\d*)?|\.\d+)\s*["']/i);
  if (!match) fail("PDF_DIAGRAM_SVG_INVALID");
  const [x, y, width, height] = match.slice(1).map(Number);
  if (![x, y, width, height].every(Number.isFinite) || width! <= 0 || height! <= 0 || width! > 1_000_000 || height! > 1_000_000) {
    fail("PDF_DIAGRAM_SVG_INVALID");
  }
  return { x: x!, y: y!, width: width!, height: height! };
}

/** Restore the projection's underscore escape before Mermaid interprets label text. */
function normalizeMermaidUnderscores(source: string): string {
  // mermaidText encodes `_` as #95;. A literal `#95;` is encoded as #35;95#59;,
  // so replacing only this exact token preserves that source text.
  return source.replace(/#95;/g, "_");
}

function gridCoordinate(index: number): string {
  let value = index + 1;
  let label = "";
  while (value > 0) {
    value -= 1;
    label = String.fromCharCode(65 + value % 26) + label;
    value = Math.floor(value / 26);
  }
  return label;
}

function axisTileStarts(total: number, maxSize: number, overlap: number): number[] {
  if (total <= maxSize) return [0];
  const count = Math.ceil((total - overlap) / (maxSize - overlap));
  if (!Number.isSafeInteger(count) || count < 1 || count > MAX_TILES_PER_DIAGRAM) fail("PDF_DIAGRAM_TILE_LIMIT_EXCEEDED");
  const lastStart = total - maxSize;
  if (count === 1) return [0];
  return Array.from({ length: count }, (_, index) => Math.round(lastStart * index / (count - 1)));
}

function makeDiagramLayout(viewBox: ViewBox): DiagramLayout {
  const overviewScale = Math.min(1, MAX_TILE_WIDTH / viewBox.width, MAX_TILE_HEIGHT / viewBox.height);
  if (overviewScale >= MIN_OVERVIEW_SCALE) {
    return {
      viewBox,
      overview: false,
      overviewScale,
      tiles: [{ ...viewBox, row: 0, column: 0, label: "A1" }],
    };
  }

  const xStarts = axisTileStarts(viewBox.width, MAX_TILE_WIDTH, TILE_OVERLAP);
  const yStarts = axisTileStarts(viewBox.height, MAX_TILE_HEIGHT, TILE_OVERLAP);
  if (xStarts.length * yStarts.length > MAX_TILES_PER_DIAGRAM) fail("PDF_DIAGRAM_TILE_LIMIT_EXCEEDED");
  const tiles: DiagramTile[] = [];
  for (const [row, yOffset] of yStarts.entries()) {
    for (const [column, xOffset] of xStarts.entries()) {
      const width = Math.min(MAX_TILE_WIDTH, viewBox.width - xOffset);
      const height = Math.min(MAX_TILE_HEIGHT, viewBox.height - yOffset);
      tiles.push({
        x: viewBox.x + xOffset,
        y: viewBox.y + yOffset,
        width,
        height,
        row,
        column,
        label: `${gridCoordinate(row)}${column + 1}`,
      });
    }
  }
  return { viewBox, tiles, overview: tiles.length > 1, overviewScale };
}

function visibleText(value: string): string {
  let result = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if ((codePoint < 0x20 && codePoint !== 0x09 && codePoint !== 0x0a && codePoint !== 0x0d) ||
        (codePoint >= 0xd800 && codePoint <= 0xdfff) || codePoint === 0xfffe || codePoint === 0xffff) {
      result += `\\u${codePoint.toString(16).padStart(4, "0")}`;
    } else {
      result += character;
    }
  }
  return result;
}

/** Escape arbitrary architecture data before it enters the renderer's HTML template. */
export function escapePdfHtml(value: string): string {
  return visibleText(value).replace(/[&<>"']/g, character => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]!);
}

function text(value: string | number | boolean | null | undefined): string {
  return `<span class="source-text">${escapePdfHtml(value === undefined ? "undefined" : String(value))}</span>`;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

function prettyJson(value: unknown): string {
  return JSON.stringify(JSON.parse(stableJson(value)), null, 2);
}

function arrayValue(values: readonly string[]): string {
  return values.length === 0
    ? `<span class="muted">None</span>`
    : `<div class="id-list">${values.map(value => `<code>${escapePdfHtml(value)}</code>`).join("")}</div>`;
}

function field(label: string, value: string): string {
  return `<div class="field"><dt>${label}</dt><dd>${value}</dd></div>`;
}

function jsonField(label: string, value: unknown): string {
  return field(label, `<pre>${escapePdfHtml(prettyJson(value))}</pre>`);
}

function fieldsTable(fields: string[]): string {
  return `<dl class="fields">${fields.join("")}</dl>`;
}

function compareEvidence(left: EvidenceSpan, right: EvidenceSpan): number {
  const compareText = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
  return compareText(left.filePath, right.filePath) || left.startByte - right.startByte ||
    left.endByte - right.endByte || compareText(left.role, right.role) ||
    compareText(left.fileSha256, right.fileSha256) || left.startLine - right.startLine ||
    left.endLine - right.endLine || left.startColumn - right.startColumn || left.endColumn - right.endColumn;
}

function buildEvidenceRegistry(document: ArchitectureDocumentV1): EvidenceRegistry {
  const spans = new Map<string, EvidenceSpan>();
  const add = (span: EvidenceSpan | null) => {
    if (span !== null) spans.set(stableJson(span), span);
  };
  const addMany = (items: readonly EvidenceSpan[]) => items.forEach(add);
  for (const entry of document.interfaceCatalog.entries) addMany(entry.evidence);
  for (const edge of document.interfaceCatalog.relations) addMany(edge.evidence);
  for (const diagram of [document.softwareEngineeringDiagram, document.umlClassDiagram]) {
    for (const node of diagram.nodes) add(node.location);
    for (const edge of diagram.edges) addMany(edge.evidence);
    for (const mapping of diagram.nodeMappings) add(mapping.evidence);
    for (const mapping of diagram.edgeMappings) addMany(mapping.evidence);
  }
  const ordered = [...spans.values()].sort(compareEvidence);
  const idBySpan = new Map(ordered.map((span, index) => [stableJson(span), `EV-${String(index + 1).padStart(4, "0")}`]));
  return { spans: ordered, idBySpan };
}

function evidenceRefs(spans: readonly EvidenceSpan[], registry: EvidenceRegistry): string {
  const ids = spans.map(span => registry.idBySpan.get(stableJson(span))).filter((id): id is string => id !== undefined);
  return ids.length === 0 ? `<span class="muted">None</span>` : arrayValue(ids);
}

function compactTable(headers: string[], rows: string[], className = "compact-table"): string {
  return `<table class="${className}"><thead><tr>${headers.map(header => `<th>${header}</th>`).join("")}</tr></thead>
    <tbody>${rows.length > 0 ? rows.join("") : `<tr><td colspan="${headers.length}" class="muted">No records.</td></tr>`}</tbody></table>`;
}

function canonicalNodeRow(node: CcmNode, registry: EvidenceRegistry): string {
  return `<tr>
    <td><code>${escapePdfHtml(node.id)}</code></td>
    <td>${text(`${node.kind} / ${node.origin} / ${node.language}`)}</td>
    <td><strong>${text(node.name)}</strong><br><span>${text(node.qualifiedName)}</span></td>
    <td>${text(node.filePath)}</td>
    <td>${text(node.parentId)}</td>
    <td>${text(node.signature)}</td>
    <td><code class="compact-json">${escapePdfHtml(stableJson(node.attributes))}</code></td>
    <td>${evidenceRefs(node.location ? [node.location] : [], registry)}</td>
  </tr>`;
}

function canonicalEdgeRow(edge: CcmEdge, registry: EvidenceRegistry): string {
  return `<tr>
    <td><code>${escapePdfHtml(edge.id)}</code></td>
    <td><code>${escapePdfHtml(edge.sourceId)}</code><br>→<br><code>${escapePdfHtml(edge.targetId)}</code></td>
    <td>${text(edge.kind)}</td>
    <td><span class="resolution ${edge.resolution === "Exact" ? "exact" : "unresolved"}">${escapePdfHtml(edge.resolution)}</span></td>
    <td>${text(edge.unresolvedReason)}</td>
    <td>${evidenceRefs(edge.evidence, registry)}</td>
  </tr>`;
}

function evidenceRegistryTable(registry: EvidenceRegistry): string {
  const rows = registry.spans.map((span, index) => `<tr>
    <td><code>EV-${String(index + 1).padStart(4, "0")}</code></td>
    <td>${text(span.role)}</td>
    <td>${text(span.filePath)}</td>
    <td><code>${escapePdfHtml(span.fileSha256)}</code></td>
    <td><code>[${span.startByte}, ${span.endByte})</code></td>
    <td><code>${span.startLine}:${span.startColumn}–${span.endLine}:${span.endColumn}</code></td>
  </tr>`);
  return compactTable(["Evidence ID", "Role", "Source file", "File SHA-256", "Byte range", "Line:column range"], rows);
}

function sectionHeading(title: string, description?: string): string {
  return `<header class="section-heading"><h1>${escapePdfHtml(title)}</h1>${description ? `<p>${escapePdfHtml(description)}</p>` : ""}</header>`;
}

function itemSection(title: string, content: string, className = "record"): string {
  return `<section class="${className}"><h3>${escapePdfHtml(title)}</h3>${content}</section>`;
}

function renderCover(document: ArchitectureDocumentV1): string {
  const provenance: CcmProvenance = document.provenance;
  const snapshot: CcmSnapshot = document.snapshot;
  return `<section class="cover">
    <p class="eyebrow">SAGE · ARCHITECTURE EXPORT</p>
    <h1>${escapePdfHtml(document.title)}</h1>
    <p class="cover-summary">Source-grounded architecture facts, diagram projections, and evidence boundaries.</p>
    ${fieldsTable([
      field("Document schema", text(document.schemaVersion)),
      field("PDF renderer", text(PDF_RENDERER_VERSION)),
      field("Repository", text(snapshot.repository)),
      field("Branch", text(snapshot.branch)),
      field("Commit", `<code>${escapePdfHtml(snapshot.commitSha)}</code>`),
      field("Canonical CKG SHA-256", `<code>${escapePdfHtml(document.ckgSha256)}</code>`),
      field("Configuration SHA-256", `<code>${escapePdfHtml(document.configurationHash)}</code>`),
      jsonField("Canonical counts", document.canonicalCounts),
      jsonField("Provenance", provenance),
    ])}
  </section>`;
}

function renderSourceFiles(files: readonly CcmFile[]): string {
  const rows = files.map(file => `<tr>
    <td>${text(file.path)}</td>
    <td>${text(file.language)}</td>
    <td>${text(file.status)}</td>
    <td>${text(file.sizeBytes)}</td>
    <td><code>${escapePdfHtml(file.sha256)}</code></td>
  </tr>`);
  return `<section class="section-block">${sectionHeading("Source files", "Source inventory with canonical byte sizes and SHA-256 values.")}
    ${compactTable(["Path", "Language", "Status", "Size (bytes)", "SHA-256"], rows)}
  </section>`;
}

function renderLimitations(limitations: readonly CcmLimitation[]): string {
  return `<section class="section-block">${sectionHeading("Limitations", "Analyzer and resolver limitations carried by the canonical snapshot.")}
    ${limitations.length === 0 ? `<p class="muted">No limitations are recorded.</p>` : limitations.map((limitation, index) => itemSection(`Limitation ${index + 1}`, fieldsTable([
      field("Stage", text(limitation.stage)),
      field("Path", text(limitation.path)),
      field("Reason", text(limitation.reason)),
    ]), "record limitation")).join("")}
  </section>`;
}

function renderInterfaceCatalog(document: ArchitectureDocumentV1, registry: EvidenceRegistry): string {
  const catalog = document.interfaceCatalog;
  const rows = catalog.entries.map(entry => `<tr>
    <td><code>${escapePdfHtml(entry.declaration.id)}</code><br>${text(entry.declaration.qualifiedName || entry.declaration.name)}<br><span class="muted">Full declaration facts: canonical node register.</span></td>
    <td>${arrayValue(entry.nodeIds)}</td>
    <td>${arrayValue(entry.edgeIds)}</td>
    <td>${arrayValue(entry.exportEdgeIds)}</td>
    <td>${evidenceRefs(entry.evidence, registry)}</td>
  </tr>`);
  return `<section class="section-block">${sectionHeading("Interface Catalog", "Catalog scope, declarations, canonical IDs, explicit exports, and source evidence.")}
    ${fieldsTable([field("Catalog scope", text(catalog.scope))])}
    <h2>Source declarations (${catalog.entries.length})</h2>
    ${compactTable(["Declaration", "Associated node IDs", "Incident edge IDs", "Export edge IDs", "Catalog evidence IDs"], rows, "compact-table catalog-table")}
    <h2>Canonical relations (${catalog.relations.length})</h2>
    <p>Canonical relation records are preserved in source order in the shared edge register, with each edge ID, endpoint, kind, resolution, unresolved reason, and evidence reference.</p>
  </section>`;
}

function renderCanonicalRegister(document: ArchitectureDocumentV1, registry: EvidenceRegistry): string {
  const nodes = document.softwareEngineeringDiagram.nodes;
  const edges = document.interfaceCatalog.relations;
  return `<section class="section-block">${sectionHeading("Canonical node and edge register", "Complete shared node and edge facts. Diagram mappings below point back to these canonical IDs and evidence.")}
    <h2>Nodes (${nodes.length})</h2>
    ${compactTable(["Canonical node ID", "Kind / origin / language", "Name / qualified name", "File path", "Parent ID", "Signature", "Attributes (JSON)", "Location evidence IDs"], nodes.map(node => canonicalNodeRow(node, registry)), "compact-table node-table")}
    <h2>Edges (${edges.length})</h2>
    ${compactTable(["Canonical edge ID", "Source / target node IDs", "Kind", "Resolution", "Unresolved reason", "Evidence IDs"], edges.map(edge => canonicalEdgeRow(edge, registry)), "compact-table edge-table")}
    <h2>Evidence register (${registry.spans.length})</h2>
    <p>Each evidence ID is a stable reference to one unique span. Catalog and diagram mappings reuse these IDs. ${EVIDENCE_RANGE_NOTE}</p>
    ${evidenceRegistryTable(registry)}
  </section>`;
}

function renderNodeMappings(diagram: DiagramProjection, registry: EvidenceRegistry): string {
  const mappingById = new Map(diagram.nodeMappings.map(mapping => [mapping.nodeId, mapping]));
  const rows = diagram.nodes.map(node => {
    const mapping = mappingById.get(node.id);
    return `<tr>
      <td><code>${escapePdfHtml(node.id)}</code></td>
      <td>${mapping ? text(mapping.mermaidId) : `<span class="missing">No mapping</span>`}</td>
      <td>${mapping ? text(mapping.mermaidLine) : `<span class="missing">No mapping</span>`}</td>
      <td>${mapping ? text(mapping.parentMermaidId ?? null) : `<span class="missing">No mapping</span>`}</td>
      <td>${mapping ? arrayValue(mapping.parentContainmentEdgeIds ?? []) : `<span class="missing">No mapping</span>`}</td>
      <td>${mapping ? evidenceRefs(mapping.evidence ? [mapping.evidence] : [], registry) : ""}</td>
    </tr>`;
  }).join("");
  return `<h2>Node mappings (${diagram.nodes.length})</h2>
    <table class="mapping-table"><thead><tr><th>Canonical node ID</th><th>Mermaid node ID</th><th>Line</th><th>Parent Mermaid ID</th><th>Parent containment edge IDs</th><th>Mapping evidence IDs</th></tr></thead>
    <tbody>${rows || `<tr><td colspan="6" class="muted">No included nodes.</td></tr>`}</tbody></table>
    <section class="subsection"><h3>Excluded canonical node IDs</h3>${arrayValue(diagram.excludedNodeIds)}</section>`;
}

function renderEdgeMappings(diagram: DiagramProjection, registry: EvidenceRegistry): string {
  const mappingById = new Map(diagram.edgeMappings.map(mapping => [mapping.edgeId, mapping]));
  const rows = diagram.edges.map(edge => {
    const mapping = mappingById.get(edge.id);
    return `<tr>
      <td><code>${escapePdfHtml(edge.id)}</code></td>
      <td>${mapping ? text(mapping.mermaidLine) : `<span class="missing">No mapping</span>`}</td>
      <td>${mapping ? text(mapping.sourceMermaidId) : `<span class="missing">No mapping</span>`}</td>
      <td>${mapping ? text(mapping.targetMermaidId) : `<span class="missing">No mapping</span>`}</td>
      <td>${mapping ? evidenceRefs(mapping.evidence, registry) : `<span class="muted">None</span>`}</td>
    </tr>`;
  }).join("");
  return `<h2>Edge mappings (${diagram.edges.length})</h2>
    <table class="mapping-table"><thead><tr><th>Canonical edge ID</th><th>Line</th><th>Source Mermaid ID</th><th>Target Mermaid ID</th><th>Mapping evidence IDs</th></tr></thead>
    <tbody>${rows || `<tr><td colspan="5" class="muted">No included edges.</td></tr>`}</tbody></table>
    <section class="subsection"><h3>Excluded canonical edge IDs</h3>${arrayValue(diagram.excludedEdgeIds)}</section>`;
}

function setSvgRootAttributes(svg: string, attributes: Record<string, string>): string {
  const openingTag = /<svg\b[^>]*>/i.exec(svg);
  if (!openingTag || openingTag.index === undefined) fail("PDF_DIAGRAM_SVG_INVALID");
  let updatedRoot = openingTag[0];
  for (const [name, value] of Object.entries(attributes)) {
    const attribute = new RegExp(`(^|\\s)${name}\\s*=\\s*(?:"[^"]*"|'[^']*'|[^\\s>]+)`, "i");
    if (attribute.test(updatedRoot)) {
      updatedRoot = updatedRoot.replace(attribute, (_match, prefix: string) => `${prefix}${name}="${escapePdfHtml(value)}"`);
    } else {
      updatedRoot = updatedRoot.replace(/>$/, ` ${name}="${escapePdfHtml(value)}">`);
    }
  }
  return `${svg.slice(0, openingTag.index)}${updatedRoot}${svg.slice(openingTag.index + openingTag[0].length)}`;
}

function tileSvgMarkup(svg: string, tile: DiagramTile): string {
  const tileSvg = setSvgRootAttributes(svg, {
    viewBox: `${tile.x} ${tile.y} ${tile.width} ${tile.height}`,
    width: `${tile.width}px`,
    height: `${tile.height}px`,
  });
  return `<div class="diagram-svg" data-grid="${escapePdfHtml(tile.label)}">${tileSvg}</div>`;
}

function overviewSvgMarkup(svg: string, layout: DiagramLayout): string {
  const markers = layout.tiles.map(tile => {
    const labelX = tile.x + 10;
    const labelY = tile.y + 25;
    return `<g aria-label="Detail tile ${escapePdfHtml(tile.label)}">
      <rect x="${tile.x}" y="${tile.y}" width="${tile.width}" height="${tile.height}" fill="none" stroke="#b45309" stroke-width="4"/>
      <rect x="${labelX - 4}" y="${labelY - 19}" width="52" height="28" rx="3" fill="#ffffff" stroke="#b45309" stroke-width="1"/>
      <text x="${labelX}" y="${labelY}" fill="#7c2d12" font-family="Arial, sans-serif" font-size="20" font-weight="700">${tile.label}</text>
    </g>`;
  }).join("");
  const tileSvg = setSvgRootAttributes(svg, {
    width: `${MAX_TILE_WIDTH}px`,
    height: `${MAX_TILE_HEIGHT}px`,
    "aria-label": "Full diagram overview; use the detail grid for readable labels",
  })
    .replace(/<\/svg>\s*$/i, `${markers}</svg>`);
  return `<div class="diagram-overview">${tileSvg}</div>`;
}

function renderDiagramSection(
  title: string,
  description: string,
  diagram: DiagramProjection,
  renderedSvg: string,
  layout: DiagramLayout,
  registry: EvidenceRegistry,
): string {
  const diagramPages: string[] = [];
  const projectionNote = `<p class="projection-note">Projection kind: <code>${escapePdfHtml(diagram.kind)}</code> · Projection title: ${escapePdfHtml(diagram.title)} · Included nodes: ${diagram.nodes.length} · Included edges: ${diagram.edges.length}</p>`;
  if (layout.overview) {
    diagramPages.push(`<section class="diagram-page overview-page">
      <div class="figure-heading"><h2>${escapePdfHtml(title)} · Overview</h2><p>This overview preserves the graph shape. Diagram labels are readable in the matching grid tiles.</p>${projectionNote}</div>
      ${overviewSvgMarkup(renderedSvg, layout)}
      <p class="grid-index">Detail tiles: ${layout.tiles.map(tile => `<code>${tile.label}</code>`).join(" ")}. Adjacent tiles overlap to keep relations visible at boundaries.</p>
    </section>`);
  }
  for (const tile of layout.tiles) {
    diagramPages.push(`<section class="diagram-page detail-page">
      <div class="figure-heading"><h2>${escapePdfHtml(title)} · Detail ${tile.label}</h2><p>Diagram coordinates: x=${tile.x}, y=${tile.y}, width=${tile.width}, height=${tile.height}; tiles overlap adjacent areas.</p>${!layout.overview && tile.row === 0 && tile.column === 0 ? projectionNote : ""}</div>
      ${tileSvgMarkup(renderedSvg, tile)}
      <p class="figure-caption">${escapePdfHtml(description)} · Grid ${tile.label}</p>
    </section>`);
  }
  return `<section class="section-block diagram-section">
    <div class="diagram-pages">${diagramPages.join("")}</div>
    ${renderNodeMappings(diagram, registry)}
    ${renderEdgeMappings(diagram, registry)}
  </section>`;
}

function renderDocumentHtml(
  document: ArchitectureDocumentV1,
  renderedSvgs: [string, string],
  layouts: [DiagramLayout, DiagramLayout],
): string {
  const title = visibleText(document.title).slice(0, 200);
  const registry = buildEvidenceRegistry(document);
  return `<!doctype html>
  <html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'"><title>${escapePdfHtml(title)}</title>
  <style>
    :root { color-scheme: light; font-family: Arial, "Liberation Sans", sans-serif; color: #172033; background: #fff; font-size: 10pt; line-height: 1.32; }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; background: #fff; }
    body { font-family: Arial, "Liberation Sans", sans-serif; font-size: 10pt; }
    h1, h2, h3, h4, p { margin: 0; }
    h1 { font-size: 22pt; line-height: 1.15; }
    h2 { margin: 8mm 0 3mm; font-size: 15pt; line-height: 1.2; break-after: avoid; }
    h3 { margin: 0 0 2.5mm; font-size: 11pt; line-height: 1.25; break-after: avoid; }
    h4 { margin: 0 0 1.5mm; font-size: 9pt; color: #334155; break-after: avoid; }
    p { line-height: 1.4; }
    code, pre { font-family: "Liberation Mono", Consolas, monospace; font-size: 8.2pt; }
    code { overflow-wrap: anywhere; white-space: pre-wrap; }
    pre { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word; }
    .source-text { white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word; }
    .cover { min-height: 165mm; display: flex; flex-direction: column; justify-content: center; }
    .eyebrow { margin-bottom: 8mm; color: #1d4ed8; font-size: 9pt; font-weight: 700; letter-spacing: .1em; }
    .cover-summary { margin: 4mm 0 8mm; color: #475569; font-size: 12pt; }
    .evidence-note { margin-top: 7mm; color: #475569; font-size: 8.5pt; }
    .section-block { break-before: page; }
    .section-heading { margin: 0 0 5mm; padding-bottom: 3mm; border-bottom: 1px solid #cbd5e1; }
    .section-heading p { margin-top: 2mm; color: #475569; }
    .fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); border: 1px solid #d7dee9; border-radius: 2mm; margin: 0; }
    .field { min-width: 0; padding: 2mm 2.5mm; border-bottom: 1px solid #e2e8f0; }
    .field:nth-child(odd) { border-right: 1px solid #e2e8f0; }
    .field dt { color: #475569; font-size: 8pt; font-weight: 700; }
    .field dd { margin: .8mm 0 0; min-width: 0; overflow-wrap: anywhere; word-break: break-word; }
    .field dd .fields { border: 0; border-radius: 0; }
    .field dd .field { padding-left: 0; padding-right: 1mm; }
    .field dd .field:nth-child(odd) { border-right: 0; }
    .record { margin: 0 0 4mm; padding: 3mm; border: 1px solid #d7dee9; border-radius: 2mm; break-inside: auto; }
    .record > h3 { padding-bottom: 1.5mm; border-bottom: 1px solid #e2e8f0; }
    .source-file, .limitation, .catalog-entry, .canonical-node, .canonical-edge { break-inside: auto; }
    .subsection { margin: 3mm 0; break-inside: auto; }
    .evidence-item { margin: 1.5mm 0 0; padding: 2mm; background: #f8fafc; border-left: 2px solid #94a3b8; break-inside: auto; }
    .muted { color: #64748b; }
    .missing { color: #b91c1c; font-weight: 700; }
    .resolution { display: inline-block; padding: .4mm 1.5mm; border-radius: 1mm; font-weight: 700; }
    .resolution.exact { background: #dcfce7; color: #166534; }
    .resolution.unresolved { background: #fef3c7; color: #92400e; }
    .id-list { display: flex; flex-wrap: wrap; gap: 1mm 2mm; }
    .compact-table, .mapping-table { width: 100%; border-collapse: collapse; table-layout: fixed; font-size: 9pt; line-height: 1.2; }
    .compact-table th, .compact-table td, .mapping-table th, .mapping-table td { padding: 1.2mm 1.4mm; border: 1px solid #d7dee9; vertical-align: top; text-align: left; overflow-wrap: anywhere; word-break: break-word; }
    .compact-table th, .mapping-table th { background: #eff6ff; color: #1e3a8a; }
    .compact-table thead, .mapping-table thead { display: table-header-group; }
    .compact-table tr, .mapping-table tr { break-inside: auto; }
    .compact-json { white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word; }
    .diagram-pages { margin: 0; }
    .diagram-page { width: 100%; height: 169mm; break-before: page; break-inside: avoid; display: flex; flex-direction: column; justify-content: flex-start; }
    .diagram-page:first-child { break-before: auto; }
    .figure-heading { flex: 0 0 auto; margin-bottom: 2mm; }
    .figure-heading h2 { margin: 0 0 1mm; font-size: 14pt; }
    .figure-heading p, .figure-caption, .grid-index { color: #475569; font-size: 8.5pt; }
    .projection-note { margin-top: 1mm; }
    .diagram-svg { flex: 0 0 auto; max-width: 100%; max-height: 158mm; overflow: hidden; display: flex; align-items: center; justify-content: center; }
    .diagram-svg svg { display: block; max-width: 100%; max-height: 158mm; }
    .diagram-overview { width: 100%; height: 150mm; display: flex; align-items: center; justify-content: center; }
    .diagram-overview svg { display: block; width: 100%; height: 145mm; }
    .grid-index, .figure-caption { margin-top: 2mm; overflow-wrap: anywhere; }
    .overview-page { break-before: page; }
    .mapping-table + .subsection { margin-top: 4mm; }
    @media print { .section-block { break-before: page; } }
  </style></head><body>
    ${renderCover(document)}
    ${renderSourceFiles(document.files)}
    ${renderLimitations(document.limitations)}
    ${renderInterfaceCatalog(document, registry)}
    ${renderCanonicalRegister(document, registry)}
    ${renderDiagramSection("Software Engineering Diagram", "Software structure projection", document.softwareEngineeringDiagram, renderedSvgs[0], layouts[0], registry)}
    ${renderDiagramSection("UML Class Diagram", "Class and interface projection", document.umlClassDiagram, renderedSvgs[1], layouts[1], registry)}
  </body></html>`;
}

function validatePdfDocument(document: ArchitectureDocumentV1): string | null {
  if (!isRecord(document) || document.schemaVersion !== "sage-add-v1" || typeof document.title !== "string" ||
      !hashIsValid(document.ckgSha256) || !hashIsValid(document.configurationHash) ||
      !isRecord(document.snapshot) || typeof document.snapshot.repository !== "string" ||
      !isRecord(document.provenance) || !isRecord(document.canonicalCounts) ||
      !Array.isArray(document.files) || !Array.isArray(document.limitations) ||
      !isRecord(document.interfaceCatalog) || !Array.isArray(document.interfaceCatalog.entries) ||
      !Array.isArray(document.interfaceCatalog.relations) ||
      !isRecord(document.softwareEngineeringDiagram) || !isRecord(document.umlClassDiagram)) {
    return "PDF_DOCUMENT_INVALID";
  }

  const counts = document.canonicalCounts;
  const diagrams = [document.softwareEngineeringDiagram, document.umlClassDiagram] as DiagramProjection[];
  if (![counts.nodes, counts.edges, counts.containmentEdges, counts.referenceEdges, counts.exactEdges, counts.unresolvedEdges]
    .every(count => Number.isSafeInteger(count) && count >= 0) ||
      counts.containmentEdges + counts.referenceEdges !== counts.edges || counts.exactEdges + counts.unresolvedEdges !== counts.edges ||
      document.interfaceCatalog.relations.length !== counts.edges ||
      diagrams[0].nodes.length !== counts.nodes || diagrams[0].edges.length !== counts.edges ||
      diagrams[0].excludedNodeIds.length !== 0 || diagrams[0].excludedEdgeIds.length !== 0 ||
      diagrams[1].nodes.length + diagrams[1].excludedNodeIds.length !== counts.nodes ||
      diagrams[1].edges.length + diagrams[1].excludedEdgeIds.length !== counts.edges) {
    return "PDF_DOCUMENT_INVALID";
  }

  for (const diagram of diagrams) {
    if (typeof diagram.mermaid !== "string" || typeof diagram.title !== "string" ||
        !Array.isArray(diagram.nodes) || !Array.isArray(diagram.edges) ||
        !Array.isArray(diagram.nodeMappings) || !Array.isArray(diagram.edgeMappings) ||
        !isStringArray(diagram.excludedNodeIds) || !isStringArray(diagram.excludedEdgeIds)) return "PDF_DOCUMENT_INVALID";
    if (diagram.mermaid.length > MAX_MERMAID_SOURCE_CHARS || Buffer.byteLength(diagram.mermaid, "utf8") > MAX_MERMAID_SOURCE_BYTES ||
        diagram.nodes.length > MAX_DIAGRAM_NODES || diagram.edges.length > MAX_DIAGRAM_EDGES) return "PDF_DIAGRAM_SOURCE_LIMIT_EXCEEDED";
    if (hasUnsafeMermaidDirective(diagram.mermaid)) return "PDF_DIAGRAM_SOURCE_INVALID";
  }
  try {
    if (Buffer.byteLength(stableJson(document), "utf8") > MAX_HTML_BYTES) return "PDF_DOCUMENT_LIMIT_EXCEEDED";
  } catch {
    return "PDF_DOCUMENT_INVALID";
  }
  return null;
}

async function readMermaidBundle(): Promise<string> {
  const require = createRequire(import.meta.url);
  let entry: string;
  try {
    entry = require.resolve("mermaid");
  } catch {
    fail("PDF_RENDERER_DEPENDENCY_UNAVAILABLE");
  }
  try {
    return await readFile(join(dirname(entry!), "mermaid.min.js"), "utf8");
  } catch {
    fail("PDF_RENDERER_DEPENDENCY_UNAVAILABLE");
  }
}

function createRenderControl(signal: AbortSignal | undefined): {
  race<T>(promise: Promise<T>): Promise<T>;
  close(): void;
} {
  let timer: ReturnType<typeof setTimeout>;
  let abortListener: (() => void) | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("PDF_RENDER_TIMEOUT")), RENDER_TIMEOUT_MS);
  });
  const abortPromise = signal ? new Promise<never>((_, reject) => {
    abortListener = () => reject(new Error("PDF_RENDER_ABORTED"));
    signal.addEventListener("abort", abortListener, { once: true });
    if (signal.aborted) abortListener();
  }) : new Promise<never>(() => undefined);
  return {
    race: promise => Promise.race([promise, timeoutPromise, abortPromise]),
    close: () => {
      clearTimeout(timer!);
      if (signal && abortListener) signal.removeEventListener("abort", abortListener);
    },
  };
}

function validateSignalOptions(options: PdfRenderOptions | undefined): AbortSignal | undefined {
  if (options === undefined) return undefined;
  if (!isRecord(options) || Object.keys(options).some(key => key !== "signal")) fail("PDF_RENDER_OPTIONS_INVALID");
  const signal = options.signal;
  if (signal === undefined) return undefined;
  if (!isRecord(signal) || typeof signal.aborted !== "boolean" || typeof signal.addEventListener !== "function" ||
      typeof signal.removeEventListener !== "function") fail("PDF_RENDER_OPTIONS_INVALID");
  return signal as unknown as AbortSignal;
}

function errorCode(error: unknown): string {
  if (error instanceof Error) {
    if (/^PDF_[A-Z0-9_]+$/.test(error.message)) return error.message;
    const pageEvaluationError = error.message.match(/(?:^|Error:\s*)(PDF_[A-Z0-9_]+)(?:$|[\s:])/);
    if (pageEvaluationError) return pageEvaluationError[1]!;
  }
  return "PDF_RENDER_FAILED";
}

/** Render all architecture artifacts from one canonical document into a bounded, offline PDF. */
export async function renderPdfDocument(
  document: ArchitectureDocumentV1,
  options?: PdfRenderOptions,
): Promise<Uint8Array> {
  const signal = validateSignalOptions(options);
  if (signal?.aborted) fail("PDF_RENDER_ABORTED");
  const validationError = validatePdfDocument(document);
  if (validationError) fail(validationError);

  const control = createRenderControl(signal);
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let context: Awaited<ReturnType<Awaited<ReturnType<typeof chromium.launch>>["newContext"]>> | undefined;
  let completed = false;
  let launchPromise: ReturnType<typeof chromium.launch> | undefined;
  try {
    const mermaidScript = await control.race(readMermaidBundle());
    launchPromise = chromium.launch({
      headless: true,
      timeout: Math.min(20_000, RENDER_TIMEOUT_MS),
      args: ["--disable-background-networking", "--disable-default-apps"],
    });
    const trackedLaunch = launchPromise.then(async created => {
      if (completed) {
        await created.close().catch(() => undefined);
        return created;
      }
      browser = created;
      return created;
    });
    browser = await control.race(trackedLaunch);

    const renderDiagrams = async (): Promise<[{ svg: string; viewBox: ViewBox }, { svg: string; viewBox: ViewBox }]> => {
      const createdContext = await browser!.newContext({ javaScriptEnabled: true, serviceWorkers: "block" });
      context = createdContext;
      let blockedRequestCount = 0;
      await createdContext.route("**/*", route => {
        blockedRequestCount += 1;
        return route.abort();
      });
      const page = await createdContext.newPage();
      await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'"><style>html,body{margin:0;padding:0;background:#fff;font-family:Arial,"Liberation Sans",sans-serif}</style></head><body></body></html>`, { waitUntil: "load" });
      await page.addScriptTag({ content: "globalThis.__name = (value) => value;" });
      await page.addScriptTag({ content: mermaidScript });
      await page.evaluate(() => window.document.fonts.ready);
      const diagrams = [document.softwareEngineeringDiagram, document.umlClassDiagram] as const;
      const results: Array<{ svg: string; viewBox: ViewBox }> = [];
      for (const [index, diagram] of diagrams.entries()) {
        const source = normalizeMermaidUnderscores(diagram.mermaid);
        const renderedSvg = await page.evaluate(async ({ source, identifier, graphHash, maxSvgBytes }) => {
          const renderer = (window as unknown as { mermaid?: {
            initialize: (config: object) => void;
            render: (id: string, text: string) => Promise<{ svg: string }>;
          } }).mermaid;
          if (!renderer) throw new Error("PDF_RENDERER_DEPENDENCY_UNAVAILABLE");
          renderer.initialize({
            startOnLoad: false,
            securityLevel: "strict",
            suppressErrorRendering: true,
            deterministicIds: true,
            deterministicIDSeed: `sage-pdf-${graphHash}`,
            maxTextSize: 50_000,
            maxEdges: 500,
            htmlLabels: false,
            theme: "neutral",
            themeVariables: { fontFamily: 'Arial, "Liberation Sans", sans-serif', fontSize: "16px" },
            flowchart: { htmlLabels: false, curve: "linear" },
            class: { htmlLabels: false, useMaxWidth: false },
          });
          const rendered = await renderer.render(identifier, source);
          if ((window as unknown as { __SAGE_PDF_CANARY__?: unknown }).__SAGE_PDF_CANARY__ !== undefined) {
            throw new Error("PDF_DIAGRAM_SVG_ACTIVE_CONTENT_REJECTED");
          }
          if (new TextEncoder().encode(rendered.svg).byteLength > maxSvgBytes) throw new Error("PDF_DIAGRAM_SVG_LIMIT_EXCEEDED");
          const parser = new DOMParser();
          const parsed = parser.parseFromString(rendered.svg, "image/svg+xml");
          const svg = parsed.documentElement as unknown as SVGElement;
          if (parsed.querySelector("parsererror") || svg.localName !== "svg" || svg.namespaceURI !== "http://www.w3.org/2000/svg") {
            throw new Error("PDF_DIAGRAM_SVG_INVALID");
          }
          for (const textElement of Array.from(svg.querySelectorAll("text"))) {
            const rows = Array.from(textElement.querySelectorAll(".text-outer-tspan"));
            for (const row of rows.length > 0 ? rows : [textElement]) {
              const label = row.textContent ?? "";
              if (!/&#[0-9]+;/.test(label)) continue;
              row.textContent = label.replace(/&#([0-9]+);/g, (entity, digits: string) => {
                const codePoint = Number(digits);
                return Number.isSafeInteger(codePoint) && codePoint >= 0x20 && codePoint <= 0x10ffff &&
                  !(codePoint >= 0xd800 && codePoint <= 0xdfff) && codePoint !== 0xfffe && codePoint !== 0xffff
                  ? String.fromCodePoint(codePoint) : entity;
              });
            }
          }
          const allowedTags = new Set([
            "svg", "defs", "marker", "path", "g", "rect", "circle", "ellipse", "line", "polygon", "polyline",
            "text", "tspan", "style", "title", "desc", "clipPath", "linearGradient", "stop",
          ]);
          const elements = [svg, ...Array.from(svg.querySelectorAll("*"))];
          const filters = Array.from(svg.querySelectorAll("filter"));
          const filterElements = new Set<Element>(filters);
          const filterParts = new Set<Element>(filters.flatMap(filter => Array.from(filter.querySelectorAll("*"))));
          const allowedLocalReference = (value: string) => /^#[A-Za-z0-9_.:-]+$/.test(value.trim());
          const urlReferences = (value: string) => [...value.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gi)].map(match => match[2]!.trim());
          for (const element of elements) {
            const tagName = element.localName;
            const isDecorativeFilter = filterElements.has(element) ||
              (tagName === "feDropShadow" && filterParts.has(element));
            if (element.namespaceURI !== "http://www.w3.org/2000/svg" || (!allowedTags.has(tagName) && !isDecorativeFilter)) {
              throw new Error("PDF_DIAGRAM_SVG_ACTIVE_CONTENT_REJECTED");
            }
            for (const attribute of Array.from(element.attributes)) {
              const name = attribute.localName.toLowerCase();
              const value = attribute.value.trim();
              if (name.startsWith("on")) throw new Error("PDF_DIAGRAM_SVG_EVENT_HANDLER_REJECTED");
              if (name === "href" || name === "src") {
                if (value !== "" && !allowedLocalReference(value)) throw new Error("PDF_DIAGRAM_SVG_EXTERNAL_REFERENCE_REJECTED");
                throw new Error("PDF_DIAGRAM_SVG_LINK_REJECTED");
              }
              if (urlReferences(value).some(reference => !allowedLocalReference(reference))) {
                throw new Error("PDF_DIAGRAM_SVG_EXTERNAL_REFERENCE_REJECTED");
              }
              if (/javascript\s*:/i.test(value)) throw new Error("PDF_DIAGRAM_SVG_ACTIVE_CONTENT_REJECTED");
            }
            if (tagName.toLowerCase() === "style") {
              const style = element.textContent ?? "";
              if (/@import|expression\s*\(|javascript\s*:/i.test(style) ||
                  urlReferences(style).some(reference => !allowedLocalReference(reference))) throw new Error("PDF_DIAGRAM_SVG_STYLE_REJECTED");
            }
          }

          const filterAttributes = new Set(["id", "height", "width"]);
          const shadowAttributes = new Set(["dx", "dy", "stddeviation", "flood-opacity", "flood-color"]);
          for (const filter of filters) {
            const id = filter.getAttribute("id") ?? "";
            const shadow = filter.children.length === 1 ? filter.children[0] : null;
            const dimensionsAreExpected = filter.getAttribute("width") === "130%" || filter.getAttribute("width") === "150%";
            if (!/^sage-pdf-[a-f0-9]{12}-\d+-drop-shadow(?:-small)?$/.test(id) ||
                filter.children.length !== 1 || shadow?.localName !== "feDropShadow" || shadow.children.length !== 0 ||
                !dimensionsAreExpected || filter.getAttribute("height") !== filter.getAttribute("width")) {
              throw new Error("PDF_DIAGRAM_FILTER_REJECTED");
            }
            for (const [element, allowedAttributes] of [[filter, filterAttributes], [shadow, shadowAttributes]] as const) {
              if (Array.from(element.attributes).some(attribute => !allowedAttributes.has(attribute.localName.toLowerCase()))) {
                throw new Error("PDF_DIAGRAM_FILTER_REJECTED");
              }
            }
            if (!["dx", "dy", "stdDeviation", "flood-opacity", "flood-color"].every(name => shadow.hasAttribute(name))) {
              throw new Error("PDF_DIAGRAM_FILTER_REJECTED");
            }
            const numberAttribute = (name: string) => {
              const value = Number(shadow.getAttribute(name));
              return Number.isFinite(value) ? value : Number.NaN;
            };
            const dx = numberAttribute("dx");
            const dy = numberAttribute("dy");
            const deviation = numberAttribute("stdDeviation");
            const opacity = numberAttribute("flood-opacity");
            if (Math.abs(dx) > 8 || Math.abs(dy) > 8 || deviation < 0 || deviation > 4 || opacity < 0 || opacity > 1 ||
                !/^#[0-9a-f]{3,8}$/i.test(shadow.getAttribute("flood-color") ?? "")) {
              throw new Error("PDF_DIAGRAM_FILTER_REJECTED");
            }
          }

          const gradientAttributes = new Set(["id", "x1", "y1", "x2", "y2", "gradientunits", "gradienttransform", "spreadmethod", "class"]);
          const stopAttributes = new Set(["offset", "stop-color", "stop-opacity", "class", "style"]);
          for (const gradient of Array.from(svg.querySelectorAll("linearGradient"))) {
            const stops = Array.from(gradient.children);
            if (!new Set(["defs", "svg"]).has(gradient.parentElement?.localName ?? "") || stops.length < 1 || stops.length > 16 ||
                stops.some(stop => stop.localName !== "stop" || stop.children.length !== 0)) {
              throw new Error("PDF_DIAGRAM_GRADIENT_REJECTED");
            }
            if (Array.from(gradient.attributes).some(attribute => !gradientAttributes.has(attribute.localName.toLowerCase())) ||
                stops.some(stop => Array.from(stop.attributes).some(attribute => !stopAttributes.has(attribute.localName.toLowerCase())))) {
              throw new Error("PDF_DIAGRAM_GRADIENT_REJECTED");
            }
          }
          if (elements.some(element => element.localName === "stop" && element.parentElement?.localName !== "linearGradient")) {
            throw new Error("PDF_DIAGRAM_GRADIENT_REJECTED_ORPHAN_STOP");
          }

          // Mermaid's generated drop shadows are decorative. Validate their local-only references,
          // then remove both definitions and uses so the exported SVG needs no SVG filter support.
          const stripFilterProperty = (value: string) => value
            .replace(/(^|[;{])\s*filter\s*:\s*[^;{}]*(?=;|})/gi, "$1")
            .replace(/;{2,}/g, ";");
          for (const element of elements) {
            if (element.localName === "style") element.textContent = stripFilterProperty(element.textContent ?? "");
            if (element.hasAttribute("filter")) element.removeAttribute("filter");
            if (element.hasAttribute("style")) {
              const style = stripFilterProperty(element.getAttribute("style") ?? "");
              if (style.trim() === "") element.removeAttribute("style");
              else element.setAttribute("style", style);
            }
          }
          for (const filter of filters) filter.remove();
          const sanitizedElements = [svg, ...Array.from(svg.querySelectorAll("*"))];
          if (sanitizedElements.some(element => element.localName === "filter" || element.localName === "feDropShadow" || !allowedTags.has(element.localName))) {
            throw new Error("PDF_DIAGRAM_SVG_ACTIVE_CONTENT_REJECTED");
          }
          const removedFilterIds = new Set(filters.map(filter => filter.getAttribute("id")).filter((id): id is string => !!id));
          for (const element of sanitizedElements) {
            const content = [element.textContent ?? "", ...Array.from(element.attributes, attribute => attribute.value)].join(" ");
            if ([...removedFilterIds].some(id => content.includes(`#${id}`))) throw new Error("PDF_DIAGRAM_FILTER_REFERENCE_REJECTED");
          }
          const serialized = new XMLSerializer().serializeToString(svg);
          if (new TextEncoder().encode(serialized).byteLength > maxSvgBytes) throw new Error("PDF_DIAGRAM_SVG_LIMIT_EXCEEDED");
          return serialized;
        }, { source, identifier: `sage-pdf-${document.ckgSha256.slice(0, 12)}-${index}`, graphHash: document.ckgSha256, maxSvgBytes: MAX_SVG_BYTES });
        results.push({ svg: renderedSvg, viewBox: safeSvgViewBox(renderedSvg) });
      }
      if (blockedRequestCount !== 0) fail("PDF_RENDER_NETWORK_REQUEST_BLOCKED");
      return results as [typeof results[number], typeof results[number]];
    };

    const diagrams = await control.race(renderDiagrams());
    const layouts: [DiagramLayout, DiagramLayout] = [makeDiagramLayout(diagrams[0].viewBox), makeDiagramLayout(diagrams[1].viewBox)];
    const html = renderDocumentHtml(document, [diagrams[0].svg, diagrams[1].svg], layouts);
    if (Buffer.byteLength(html, "utf8") > MAX_HTML_BYTES) fail("PDF_DOCUMENT_LIMIT_EXCEEDED");

    const page = await control.race(context!.newPage());
    await control.race(page.emulateMedia({ media: "print" }));
    await control.race(page.setContent(html, { waitUntil: "load", timeout: RENDER_TIMEOUT_MS }));
    await control.race(page.evaluate(() => window.document.fonts.ready));
    const pdf = await control.race(page.pdf({
      format: "A4",
      landscape: true,
      printBackground: true,
      preferCSSPageSize: false,
      displayHeaderFooter: true,
      headerTemplate: `<div style="width:100%;padding:0 8mm;color:#64748b;font:8px Arial,sans-serif"><span>SAGE Architecture Definition Document</span><span style="float:right">CKG ${escapePdfHtml(document.ckgSha256.slice(0, 12))}</span></div>`,
      footerTemplate: `<div style="width:100%;padding:0 8mm;color:#64748b;font:8px Arial,sans-serif"><span>PDF renderer ${PDF_RENDERER_VERSION}</span><span style="float:right"><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>`,
      margin: { top: "13mm", right: "8mm", bottom: "14mm", left: "8mm" },
    }));
    if (pdf.byteLength < 8 || pdf.byteLength > MAX_PDF_BYTES || Buffer.from(pdf).subarray(0, 5).toString("ascii") !== "%PDF-") {
      fail(pdf.byteLength > MAX_PDF_BYTES ? "PDF_OUTPUT_LIMIT_EXCEEDED" : "PDF_OUTPUT_INVALID");
    }
    return Uint8Array.from(pdf);
  } catch (error) {
    const code = errorCode(error);
    if (code !== "PDF_RENDER_ABORTED" && code !== "PDF_RENDER_TIMEOUT" && error instanceof Error && error.message !== code) {
      fail(code);
    }
    throw error instanceof Error && error.message === code ? error : new Error(code);
  } finally {
    completed = true;
    control.close();
    if (context) await context.close().catch(() => undefined);
    if (browser) await browser.close().catch(() => undefined);
    else if (launchPromise) {
      void launchPromise.then(created => created.close().catch(() => undefined)).catch(() => undefined);
    }
  }
}

/** Browser-free helpers used by focused PDF-renderer unit tests. */
export const pdfRendererInternals = {
  axisTileStarts,
  buildEvidenceRegistry,
  errorCode,
  escapePdfHtml,
  makeDiagramLayout,
  normalizeMermaidUnderscores,
  setSvgRootAttributes,
  validatePdfDocument,
};
