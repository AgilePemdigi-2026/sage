import type { ArchitectureDocumentV1 } from "@sage/documents/model";
import { HUMAN_DIAGRAM_THEME } from "@sage/documents/human";
import { interactiveDiagramBudget, projectInteractiveDiagram, type InteractiveDiagramProjection } from "./document-data.ts";

type DiagramProjection = ArchitectureDocumentV1["softwareEngineeringDiagram"];

const MAX_SVG_BYTES = 4 * 1024 * 1024;
const BLOCKED_ELEMENTS = new Set([
  "script", "foreignobject", "use", "iframe", "object", "embed", "audio", "video",
  "animate", "animatemotion", "animatetransform", "set",
]);
const ACTIVE_PROTOCOL = /(?:javascript|vbscript|data|file):/iu;
const URL_FUNCTION = /url\(\s*(['"]?)(.*?)\1\s*\)/giu;

export class DiagramRenderError extends Error {
  constructor(readonly code: "OVER_BUDGET" | "INVALID_SVG" | "RENDER_FAILED") {
    super(code === "OVER_BUDGET" ? "Diagram melewati batas keamanan." : "Diagram tidak dapat dirender dengan aman.");
    this.name = "DiagramRenderError";
  }
}

function cssIsLocal(value: string): boolean {
  if (/@import|expression\s*\(|behavior\s*:/iu.test(value) || ACTIVE_PROTOCOL.test(value)) return false;
  URL_FUNCTION.lastIndex = 0;
  for (const match of value.matchAll(URL_FUNCTION)) {
    const target = match[2]?.trim() ?? "";
    if (!target.startsWith("#") || target.length < 2) return false;
  }
  return true;
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

/** Reject active content, network references, and malformed SVG before making an image URL. */
export function sanitizeDiagramSvg(svg: string): string {
  const inputBytes = new TextEncoder().encode(svg).byteLength;
  if (inputBytes > MAX_SVG_BYTES) throw new DiagramRenderError("OVER_BUDGET");
  if (typeof DOMParser === "undefined" || typeof XMLSerializer === "undefined") throw new DiagramRenderError("INVALID_SVG");

  const parsed = new DOMParser().parseFromString(svg, "image/svg+xml");
  if (parsed.querySelector("parsererror")) throw new DiagramRenderError("INVALID_SVG");
  const root = parsed.documentElement;
  if (root.localName.toLowerCase() !== "svg" || root.namespaceURI !== "http://www.w3.org/2000/svg") {
    throw new DiagramRenderError("INVALID_SVG");
  }

  // Mermaid can serialize numeric label entities as literal text, sometimes
  // splitting an entity across positioned rows. Decode one layer in text only.
  for (const textElement of Array.from(root.querySelectorAll("text"))) {
    decodeMermaidTextRows(textElement);
  }

  for (const element of [root, ...Array.from(root.querySelectorAll("*"))]) {
    if (BLOCKED_ELEMENTS.has(element.localName.toLowerCase())) throw new DiagramRenderError("INVALID_SVG");
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim();
      if (name.startsWith("on") || name === "xml:base") throw new DiagramRenderError("INVALID_SVG");
      if (name === "href" || name === "xlink:href" || name === "src") {
        if (!value.startsWith("#") || value.length < 2) throw new DiagramRenderError("INVALID_SVG");
      }
      if (ACTIVE_PROTOCOL.test(value)) throw new DiagramRenderError("INVALID_SVG");
      if (name === "style" && !cssIsLocal(value)) throw new DiagramRenderError("INVALID_SVG");
      if (/\burl\s*\(/iu.test(value) && !cssIsLocal(value)) throw new DiagramRenderError("INVALID_SVG");
    }
    if (element.localName.toLowerCase() === "style" && !cssIsLocal(element.textContent ?? "")) {
      throw new DiagramRenderError("INVALID_SVG");
    }
  }

  const safeSvg = new XMLSerializer().serializeToString(parsed);
  if (new TextEncoder().encode(safeSvg).byteLength > MAX_SVG_BYTES) throw new DiagramRenderError("OVER_BUDGET");
  return safeSvg;
}

/** Render only the canonical server projection with strict Mermaid settings and local SVG references. */
export async function renderCanonicalDiagramSvg(
  diagram: DiagramProjection,
  identitySeed: string,
  isCurrent: () => boolean = () => true,
): Promise<string> {
  return renderInteractiveDiagramSvg(projectInteractiveDiagram(diagram), identitySeed, isCurrent);
}

/** Render a bounded, display-only projection without inserting SVG markup into the active DOM. */
export async function renderInteractiveDiagramSvg(
  projection: InteractiveDiagramProjection,
  identitySeed: string,
  isCurrent: () => boolean = () => true,
): Promise<string> {
  if (interactiveDiagramBudget(projection).kind !== "ready") throw new DiagramRenderError("OVER_BUDGET");
  try {
    const mermaid = (await import("mermaid")).default;
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      htmlLabels: false,
      deterministicIds: true,
      deterministicIDSeed: identitySeed,
      suppressErrorRendering: true,
      logLevel: "error",
      fontFamily: "Inter, sans-serif",
      theme: "base",
            look: "classic",
      themeVariables: HUMAN_DIAGRAM_THEME,
      flowchart: { htmlLabels: false, curve: "linear", wrappingWidth: 240 },
      class: { htmlLabels: false },
    });
    if (!isCurrent()) return "";
    const id = `sage-document-${projection.diagram.kind}-${identitySeed.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) || "canonical"}`;
    const result = await mermaid.render(id, projection.diagram.mermaid.replace(/#95;/g, "_"));
    if (!isCurrent()) return "";
    return sanitizeDiagramSvg(result.svg);
  } catch (error) {
    if (error instanceof DiagramRenderError) throw error;
    throw new DiagramRenderError("RENDER_FAILED");
  }
}

export function diagramSvgObjectUrl(svg: string): string {
  return URL.createObjectURL(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }));
}
