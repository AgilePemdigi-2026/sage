import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { chromium } from "playwright";
import { HUMAN_DIAGRAM_THEME, humanNodeName } from "./human-diagrams.ts";
import type { ArchitectureDocumentV1 } from "./architecture-document.ts";
import type { DiagramProjection } from "./diagrams.ts";
import { projectCompactPdfDiagrams, type CompactPdfDiagrams, type PdfDiagramSummary } from "./pdf-projection.ts";

const MAX_MERMAID_SOURCE_CHARS = 50_000;
const MAX_MERMAID_SOURCE_BYTES = 50_000;
const MAX_DIAGRAM_NODES = 500;
const MAX_DIAGRAM_EDGES = 500;
const MAX_SVG_BYTES = 4 * 1024 * 1024;
const MAX_HTML_BYTES = 12 * 1024 * 1024;
const MAX_PDF_BYTES = 32 * 1024 * 1024;
const RENDER_TIMEOUT_MS = 45_000;
export type PdfRenderOptions = { signal?: AbortSignal };
type ViewBox = { x: number; y: number; width: number; height: number };

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

function stableJson(value: unknown): string {
  return JSON.stringify(value);
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

function compactText(value: string, maxCharacters: number): string {
  const characters = Array.from(value);
  return characters.length <= maxCharacters ? value : `${characters.slice(0, maxCharacters - 1).join("")}…`;
}

function renderDocumentHtml(document: ArchitectureDocumentV1, svgs: [string, string], views: CompactPdfDiagrams): string {
  const e = escapePdfHtml;
  const declarationIds = new Set(document.interfaceCatalog.entries.map(row => row.declaration.id));
  const allRows = document.interfaceCatalog.entries.filter(({ declaration: node }) =>
    !(["Method", "Property"].includes(node.kind) && node.parentId && declarationIds.has(node.parentId))).sort((a, b) =>
    (a.declaration.filePath ?? "").localeCompare(b.declaration.filePath ?? "") ||
    (a.declaration.location?.startLine ?? 0) - (b.declaration.location?.startLine ?? 0));
  const rows = allRows.slice(0, 30);
  const membersByParent = new Map<string, Array<(typeof document.softwareEngineeringDiagram.nodes)[number]>>();
  for (const member of document.softwareEngineeringDiagram.nodes) {
    if (!["Method", "Property"].includes(member.kind) || member.parentId === null) continue;
    const members = membersByParent.get(member.parentId) ?? [];
    members.push(member);
    membersByParent.set(member.parentId, members);
  }
  const catalog = rows.map(({ declaration: node }) => {
    const members = membersByParent.get(node.id) ?? [];
    const shownMembers = members.slice(0, 6);
    const contractSource = node.signature ?? (shownMembers.length ? shownMembers.map(member => member.signature ?? member.name).join("; ") : "Kontrak tidak tercatat");
    const contract = compactText(contractSource, 400);
    const notes = [
      members.length > shownMembers.length ? `+${members.length - shownMembers.length} anggota` : "",
      contract !== contractSource ? "kontrak dipotong" : "",
    ].filter(Boolean).join(" · ");
    const location = node.location ? `${node.location.filePath}:${node.location.startLine}–${node.location.endLine}` : "Lokasi tidak tersedia";
    return `<tr><td><strong>${e(compactText(humanNodeName(node), 120))}</strong><small>${e(node.kind)} · ${e(node.language)}</small></td><td><code>${e(contract)}</code>${notes ? `<small>${e(notes)}</small>` : ""}</td><td><code>${e(compactText(location, 180))}</code></td></tr>`;
  }).join("");
  const limitationGroups = new Map<string, Set<string>>();
  for (const item of document.limitations) {
    const paths = limitationGroups.get(item.reason) ?? new Set<string>();
    if (item.path) paths.add(item.path);
    limitationGroups.set(item.reason, paths);
  }
  const allLimitations = [...limitationGroups.entries()].sort(([left], [right]) => left.localeCompare(right));
  const limitations = allLimitations.slice(0, 20).map(([reason, pathSet]) => {
    const paths = [...pathSet].sort().slice(0, 4);
    const remainingPaths = pathSet.size - paths.length;
    return `<li>${paths.length ? e(paths.map(path => compactText(path, 120)).join(", ")) + ": " : ""}${e(compactText(reason, 220))}${remainingPaths > 0 ? ` (+${remainingPaths} paths)` : ""}</li>`;
  }).join("");
  const summaryText = (summary: PdfDiagramSummary, uml: boolean) => {
    const nodeLabel = uml ? "class/interface/target Unresolved" : "node";
    const memberText = uml ? ` Menampilkan ${summary.shownMembers} dari ${summary.totalMembers} anggota; paling banyak 3 per class terpilih.` : "";
    const clipText = summary.clippedValues ? ` ${summary.clippedValues} label atau signature dipendekkan.` : "";
    return `<p class="caption"><strong>Proyeksi ringkas:</strong> menampilkan ${summary.shownNodes} dari ${summary.totalNodes} ${nodeLabel}, ${summary.shownRelations} dari ${summary.totalRelations} kelompok relasi, mencakup ${summary.shownEdges} dari ${summary.totalEdges} catatan relasi source.${memberText}${clipText} Kelompok dibedakan menurut endpoint, kind, dan status Exact/Unresolved. Diagram ini bukan keseluruhan graph; Markdown memuat bukti lengkap.</p>`;
  };
  const diagramPage = (title: string, svg: string, uml: boolean, summary: PdfDiagramSummary) => `<section class="diagram-page"><p class="eyebrow">SAGE / ARSITEKTUR KODE</p><h1>${title}</h1><p>${uml ? "Class, interface, anggota, dan pewarisan yang tercatat pada source." : "Struktur deklarasi dan ketergantungan kode; anggota ditampilkan melalui pemiliknya."}</p><div class="figure">${setSvgRootAttributes(svg, { width: "100%", height: "100%", preserveAspectRatio: "xMidYMid meet" })}</div><div class="legend"><span>Teal: class</span><span>Ungu: interface</span><span>Biru: function</span><span>Abu: module</span><span>Amber / putus-putus: Unresolved</span></div>${summaryText(summary, uml)}<p class="caption">${uml ? "Segitiga kosong: extends; garis putus-putus dengan segitiga: implements. Dependensi Unresolved tidak menyatakan pewarisan yang pasti." : "Panah mengikuti arah relasi source → target. Label contains menyatakan kepemilikan; × menunjukkan jumlah observasi sejenis. Anggota class diringkas ke class pemilik; relasi internal pemilik tidak ditampilkan."} Tidak menyimpulkan layanan bisnis, endpoint runtime, atau cardinality.</p></section>`;
  return `<!doctype html><html lang="id"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; object-src 'none'; base-uri 'none'"><title>${e(document.title)}</title><style>
  *{box-sizing:border-box}body{margin:0;color:#061e42;font:10pt/1.45 Arial,sans-serif}h1{font-size:22pt;line-height:1.2;margin:2mm 0 4mm}h2{font-size:14pt;margin:5mm 0 3mm}p{margin:0 0 3mm}.eyebrow{color:#08796e;font-size:9pt;font-weight:bold;letter-spacing:.12em}.identity{padding:4mm;background:#e6faf6;border-left:4px solid #098577;margin:4mm 0}.stats{display:flex;gap:7mm;color:#506783;margin:3mm 0}table{width:100%;border-collapse:collapse;table-layout:fixed;font-size:9pt}th,td{padding:2mm;border:1px solid #dde5ec;vertical-align:top;text-align:left;overflow-wrap:anywhere}th{background:#eef3f7}th:first-child{width:27%}th:last-child{width:30%}thead{display:table-header-group}tr{break-inside:avoid}small{display:block;color:#506783;margin-top:1mm}code{font:8.5pt/1.4 monospace;white-space:pre-wrap;overflow-wrap:anywhere}.note{padding:3mm;background:#fff4d9;color:#78350f}.diagram-page{break-before:page;height:178mm;display:flex;flex-direction:column;break-inside:avoid}.diagram-page h1{font-size:20pt}.figure{flex:1;min-height:0;width:100%;margin:2mm 0;border:1px solid #dde5ec;border-radius:2mm;padding:3mm}.figure svg{display:block;width:100%;height:100%}.legend{display:flex;flex-wrap:wrap;gap:2mm 6mm;font-size:8pt;padding:2mm;background:#eef3f7}.caption{font-size:8pt;color:#506783;margin-top:2mm}li{overflow-wrap:anywhere}strong{overflow-wrap:anywhere}
  </style></head><body><p class="eyebrow">SAGE / RINGKASAN ARSITEKTUR</p><h1>${e(document.title)}</h1><div class="identity"><strong>${e(document.snapshot.repository)}</strong> · ${e(document.snapshot.branch ?? "Branch tidak tersedia")}<div class="stats"><span>${document.files.length} file</span><span>${document.canonicalCounts.nodes} deklarasi/node</span><span>${document.canonicalCounts.exactEdges} relasi Exact</span><span>${document.canonicalCounts.unresolvedEdges} Unresolved</span></div></div><p>Dokumen ringkas untuk mempelajari kontrak kode, struktur software, dan model class dari snapshot yang dianalisis. Markdown menyimpan register teknis, hash, atribut, dan seluruh evidence.</p>
  ${document.limitations.length ? `<div class="note"><strong>Batasan analisis (${Math.min(allLimitations.length, 20)} dari ${allLimitations.length} jenis; maksimal 4 path per jenis)</strong><ul>${limitations}</ul></div>` : ""}<h2>Interface Catalog</h2><p>Katalog deklarasi source: simbol, kontrak yang tersedia, dan lokasi bukti. Menampilkan ${rows.length} dari ${allRows.length} simbol; kontrak maksimal 400 karakter dan maksimal 6 anggota untuk ringkasan. Interface kode tidak otomatis berarti interface integrasi atau endpoint HTTP. Detail lengkap tersedia di Markdown.</p><table><thead><tr><th>Symbol</th><th>Contract</th><th>Evidence</th></tr></thead><tbody>${catalog || '<tr><td colspan="3">Tidak ada deklarasi source yang tercatat.</td></tr>'}</tbody></table>
  ${diagramPage("Software Engineering Diagram", svgs[0], false, views.softwareSummary)}${diagramPage("UML Class Diagram", svgs[1], true, views.umlSummary)}</body></html>`;
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
    if (hasUnsafeMermaidDirective(diagram.mermaid)) return "PDF_DIAGRAM_SOURCE_INVALID";
  }
  try {
    if (Buffer.byteLength(stableJson(document), "utf8") > MAX_HTML_BYTES) return "PDF_DOCUMENT_LIMIT_EXCEEDED";
  } catch {
    return "PDF_DOCUMENT_INVALID";
  }
  return null;
}

/** Fresh human mappings count rendered boxes; nodes also retain member evidence used for aggregation. */
function validateRendererDiagram(diagram: DiagramProjection): string | null {
  if (diagram.mermaid.length > MAX_MERMAID_SOURCE_CHARS || Buffer.byteLength(diagram.mermaid, "utf8") > MAX_MERMAID_SOURCE_BYTES ||
      diagram.nodeMappings.length > MAX_DIAGRAM_NODES || diagram.edges.length > MAX_DIAGRAM_EDGES) {
    return "PDF_DIAGRAM_SOURCE_LIMIT_EXCEEDED";
  }
  if (hasUnsafeMermaidDirective(diagram.mermaid)) return "PDF_DIAGRAM_SOURCE_INVALID";
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
  const compactViews = projectCompactPdfDiagrams(document.softwareEngineeringDiagram, document.umlClassDiagram);
  const projectedError = validateRendererDiagram(compactViews.software) ?? validateRendererDiagram(compactViews.uml);
  if (projectedError) fail(projectedError);

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
      const diagrams = [compactViews.software, compactViews.uml];
      const results: Array<{ svg: string; viewBox: ViewBox }> = [];
      for (const [index, diagram] of diagrams.entries()) {
        const source = normalizeMermaidUnderscores(diagram.mermaid);
        const renderedSvg = await page.evaluate(async ({ source, identifier, graphHash, maxSvgBytes, theme }) => {
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
            theme: "base",
            look: "classic",
            themeVariables: theme,
            flowchart: { htmlLabels: false, curve: "linear", wrappingWidth: 240 },
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
function decodeMermaidTextRows(textElement: Element): void {
  const positionedRows = Array.from(textElement.querySelectorAll(".text-outer-tspan"));
  const rows = positionedRows.length > 0 ? positionedRows : [textElement];
  const original = rows.map((row) => row.textContent ?? "");
  const offsets: number[] = [];
  let length = 0;
  for (const row of original) {
    offsets.push(length);
    length += row.length;
  }

  const joined = original.join("");
  const matches = Array.from(joined.matchAll(/&#([0-9]+);/g));
  for (const match of matches.reverse()) {
    const start = match.index;
    const entity = match[0];
    const end = start + entity.length;
    const codePoint = Number(match[1]);
    if (!Number.isSafeInteger(codePoint) || codePoint < 0x20 || codePoint > 0x10ffff ||
        (codePoint >= 0xd800 && codePoint <= 0xdfff) || codePoint === 0xfffe || codePoint === 0xffff) {
      continue;
    }

    let startRow = -1;
    let endRow = -1;
    for (let index = 0; index < original.length; index += 1) {
      const rowStart = offsets[index]!;
      const rowEnd = rowStart + original[index]!.length;
      if (start >= rowStart && start < rowEnd) startRow = index;
      if (end > rowStart && end <= rowEnd) endRow = index;
    }
    if (startRow < 0 || endRow < startRow) continue;

    const startInRow = start - offsets[startRow]!;
    const endInRow = end - offsets[endRow]!;
    const decoded = String.fromCodePoint(codePoint);
    if (startRow === endRow) {
      const rowText = rows[startRow]!.textContent ?? "";
      rows[startRow]!.textContent = rowText.slice(0, startInRow) + decoded + rowText.slice(endInRow);
      continue;
    }

    const firstRowText = rows[startRow]!.textContent ?? "";
    rows[startRow]!.textContent = firstRowText.slice(0, startInRow) + decoded;
    for (let index = startRow + 1; index <= endRow; index += 1) {
      const rowText = rows[index]!.textContent ?? "";
      rows[index]!.textContent = index === endRow ? rowText.slice(endInRow) : "";
    }
  }
}

          for (const textElement of Array.from(svg.querySelectorAll("text"))) decodeMermaidTextRows(textElement);
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
        }, { source, identifier: `sage-pdf-${document.ckgSha256.slice(0, 12)}-${index}`, graphHash: document.ckgSha256, maxSvgBytes: MAX_SVG_BYTES, theme: HUMAN_DIAGRAM_THEME });
        results.push({ svg: renderedSvg, viewBox: safeSvgViewBox(renderedSvg) });
      }
      if (blockedRequestCount !== 0) fail("PDF_RENDER_NETWORK_REQUEST_BLOCKED");
      return results as [typeof results[number], typeof results[number]];
    };

    const diagrams = await control.race(renderDiagrams());
    const html = renderDocumentHtml(document, [diagrams[0].svg, diagrams[1].svg], compactViews);
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
      headerTemplate: `<div style="width:100%;padding:0 8mm;color:#64748b;font:8px Arial,sans-serif"><span>SAGE Architecture Definition Document</span></div>`,
      footerTemplate: `<div style="width:100%;padding:0 8mm;color:#64748b;font:8px Arial,sans-serif"><span>SAGE · Ringkasan untuk developer</span><span style="float:right"><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>`,
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
  errorCode,
  escapePdfHtml,
  renderDocumentHtml,
  normalizeMermaidUnderscores,
  setSvgRootAttributes,
  validatePdfDocument,
  validateRendererDiagram,
};
