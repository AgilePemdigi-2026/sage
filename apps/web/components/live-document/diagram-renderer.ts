import type { ArchitectureDocumentV1 } from "@sage/documents/model";
import { diagramBudget } from "./document-data.ts";

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
  if (diagramBudget(diagram).kind !== "ready") throw new DiagramRenderError("OVER_BUDGET");
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
    });
    if (!isCurrent()) return "";
    const id = `sage-document-${diagram.kind}-${identitySeed.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) || "canonical"}`;
    const result = await mermaid.render(id, diagram.mermaid);
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
