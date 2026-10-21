import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { chromium } from "playwright";
import { projectDiagrams, type DiagramBundle, type DiagramProjection } from "./diagrams.ts";

// Mermaid's documented default text ceiling is 50,000 characters. Keep the
// same explicit per-diagram budget and fail the whole render rather than
// silently dropping any projected facts.
const MAX_MERMAID_SOURCE_CHARS = 50_000;
const MAX_MERMAID_SOURCE_BYTES = 50_000;
const MAX_DIAGRAM_NODES = 500;
const MAX_DIAGRAM_EDGES = 500;
const MAX_SVG_BYTES = 4 * 1024 * 1024;
const DEFAULT_RENDER_TIMEOUT_MS = 15_000;
const MAX_RENDER_TIMEOUT_MS = 30_000;

export type RenderedDiagram = Pick<DiagramProjection, "kind" | "title" | "mermaid"> & { svg: string };

export type RenderedDiagramBundle = {
  bundle: DiagramBundle;
  diagrams: [RenderedDiagram, RenderedDiagram];
  rendererVersion: string;
  browserVersion: string;
  blockedRequestCount: number;
};

export type RenderDiagramResult =
  | { ok: true; value: RenderedDiagramBundle }
  | { ok: false; errorCode: string };

export type RenderDiagramOptions = { timeoutMs?: number };

function validTimeout(options: RenderDiagramOptions | undefined): number | null {
  if (options === undefined) return DEFAULT_RENDER_TIMEOUT_MS;
  if (typeof options !== "object" || options === null || Array.isArray(options)) return null;
  const timeout = options.timeoutMs ?? DEFAULT_RENDER_TIMEOUT_MS;
  return Number.isSafeInteger(timeout) && timeout >= 250 && timeout <= MAX_RENDER_TIMEOUT_MS ? timeout : null;
}

async function packageVersion(name: string): Promise<string> {
  const require = createRequire(import.meta.url);
  let location: string;
  try {
    location = require.resolve(name);
  } catch {
    throw new Error("DIAGRAM_RENDERER_DEPENDENCY_UNAVAILABLE");
  }
  let directory = dirname(location);
  for (let depth = 0; depth < 6; depth += 1) {
    try {
      const metadata = JSON.parse(await readFile(join(directory, "package.json"), "utf8")) as { name?: unknown; version?: unknown };
      if (metadata.name === name && typeof metadata.version === "string") return metadata.version;
    } catch {
      // Continue to the parent directory; package subpaths need not expose package.json.
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error("DIAGRAM_RENDERER_DEPENDENCY_UNAVAILABLE");
}

function errorCode(error: unknown): string {
  if (error instanceof Error && error.message.startsWith("DIAGRAM_")) return error.message;
  return "DIAGRAM_RENDER_FAILED";
}

function createTimeout(ms: number): { promise: Promise<never>; cancel(): void } {
  let timer: ReturnType<typeof setTimeout>;
  const promise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("DIAGRAM_RENDER_TIMEOUT")), ms);
  });
  return { promise, cancel: () => clearTimeout(timer!) };
}

function containsUnsafeMermaidDirective(source: string): boolean {
  return source.split("\n").some(line => /^\s*%%\s*\{/.test(line) || /^\s*(?:click|href)\s+/i.test(line));
}

function withinRendererBudget(source: string, nodeCount: number, edgeCount: number): boolean {
  return source.length <= MAX_MERMAID_SOURCE_CHARS &&
    Buffer.byteLength(source, "utf8") <= MAX_MERMAID_SOURCE_BYTES &&
    nodeCount <= MAX_DIAGRAM_NODES && edgeCount <= MAX_DIAGRAM_EDGES;
}

/**
 * Validate a canonical source graph, project its facts, and render only the generated
 * Mermaid text in a local, network-blocked Chromium instance.
 */
export async function renderDiagramBundle(
  canonicalCkgJson: string,
  sourceBytes: Readonly<Record<string, Uint8Array>>,
  expectedSha256?: string,
  options?: RenderDiagramOptions,
): Promise<RenderDiagramResult> {
  const timeoutMs = validTimeout(options);
  if (timeoutMs === null) return { ok: false, errorCode: "DIAGRAM_RENDER_OPTIONS_INVALID" };

  const projection = projectDiagrams(canonicalCkgJson, sourceBytes, expectedSha256);
  if (!projection.ok) return projection;
  if (!Array.isArray(projection.value.diagrams) || projection.value.diagrams.length !== 2) {
    return { ok: false, errorCode: "DIAGRAM_BUNDLE_INVALID" };
  }

  for (const diagram of projection.value.diagrams) {
    if (!withinRendererBudget(diagram.mermaid, diagram.nodes.length, diagram.edges.length)) {
      return { ok: false, errorCode: "DIAGRAM_SOURCE_LIMIT_EXCEEDED" };
    }
    if (containsUnsafeMermaidDirective(diagram.mermaid)) return { ok: false, errorCode: "DIAGRAM_SOURCE_INVALID" };
  }

  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let deadline: ReturnType<typeof createTimeout> | undefined;
  const startedAt = Date.now();
  let blockedRequestCount = 0;
  try {
    browser = await chromium.launch({ headless: true, timeout: timeoutMs, args: ["--disable-background-networking", "--disable-default-apps"] });
    const remainingMs = timeoutMs - (Date.now() - startedAt);
    if (remainingMs <= 0) throw new Error("DIAGRAM_RENDER_TIMEOUT");
    deadline = createTimeout(remainingMs);
    const render = async () => {
      const context = await browser!.newContext({ javaScriptEnabled: true, serviceWorkers: "block" });
      await context.route("**/*", route => {
        blockedRequestCount += 1;
        return route.abort();
      });
      const page = await context.newPage();
      await page.setContent(`<!doctype html><html lang="id"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"><meta name="viewport" content="width=device-width, initial-scale=1"><style>html,body{margin:0;padding:16px;background:#fff}body{font:14px Arial,sans-serif}svg{max-width:100%;height:auto}</style></head><body></body></html>`);
      // tsx preserves names with this helper when Playwright serializes callbacks.
      await page.addScriptTag({ content: "globalThis.__name = (value) => value;" });
      const require = createRequire(import.meta.url);
      const mermaidEntry = require.resolve("mermaid");
      const mermaidScript = await readFile(join(dirname(mermaidEntry), "mermaid.min.js"), "utf8");
      await page.addScriptTag({ content: mermaidScript });

      const diagrams: RenderedDiagram[] = [];
      for (const [index, diagram] of projection.value.diagrams.entries()) {
        const result = await page.evaluate(async ({ source, identifier }) => {
          const renderer = (window as unknown as { mermaid?: {
            initialize: (config: object) => void;
            render: (id: string, text: string) => Promise<{ svg: string }>;
          } }).mermaid;
          if (!renderer) throw new Error("DIAGRAM_RENDERER_UNAVAILABLE");
          renderer.initialize({
            startOnLoad: false,
            securityLevel: "strict",
            suppressErrorRendering: true,
            deterministicIds: true,
            maxTextSize: 50_000,
            maxEdges: 500,
            htmlLabels: false,
            theme: "neutral",
            flowchart: { htmlLabels: false, curve: "linear" },
            class: { htmlLabels: false, useMaxWidth: true },
          });
          const rendered = await renderer.render(identifier, source);
          if ((window as unknown as { __SAGE_DIAGRAM_CANARY__?: unknown }).__SAGE_DIAGRAM_CANARY__ !== undefined) {
            throw new Error("DIAGRAM_SVG_ACTIVE_CONTENT_REJECTED");
          }
          const parser = new DOMParser();
          const parsed = parser.parseFromString(rendered.svg, "image/svg+xml");
          const svg = parsed.documentElement;
          if (parsed.querySelector("parsererror") || svg.localName !== "svg" ||
              svg.namespaceURI !== "http://www.w3.org/2000/svg") throw new Error("DIAGRAM_SVG_INVALID");
          // Mermaid can serialize numeric label entities as literal text. Decode one
          // layer in text nodes only: never parse labels as HTML or SVG markup.
          for (const textElement of Array.from(svg.querySelectorAll("text"))) {
            const rows = Array.from(textElement.querySelectorAll(".text-outer-tspan"));
            // Mermaid may split an entity across adjacent inline tspans. Decode
            // each positioned row as a whole while retaining multiline layout.
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
          const elements = [svg, ...Array.from(svg.querySelectorAll("*"))];
          const allowedLocalReference = (value: string) => /^#[A-Za-z0-9_.:-]+$/.test(value.trim());
          const urlReferences = (value: string) => [...value.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gi)].map(match => match[2]!.trim());
          for (const element of elements) {
            const tagName = element.localName.toLowerCase();
            if (element.namespaceURI !== "http://www.w3.org/2000/svg" ||
                ["script", "foreignobject", "iframe", "object", "embed", "image", "audio", "video", "a", "set", "animate", "animatetransform", "animatemotion"].includes(tagName)) {
              throw new Error("DIAGRAM_SVG_ACTIVE_CONTENT_REJECTED");
            }
            for (const attribute of Array.from(element.attributes)) {
              const name = attribute.localName.toLowerCase();
              const value = attribute.value.trim();
              if (name.startsWith("on")) throw new Error("DIAGRAM_SVG_EVENT_HANDLER_REJECTED");
              if (name === "href" || name === "src") {
                if (value !== "" && !allowedLocalReference(value)) throw new Error("DIAGRAM_SVG_EXTERNAL_REFERENCE_REJECTED");
                throw new Error("DIAGRAM_SVG_LINK_REJECTED");
              }
              const references = urlReferences(value);
              if (references.some(reference => !allowedLocalReference(reference))) {
                throw new Error("DIAGRAM_SVG_EXTERNAL_REFERENCE_REJECTED");
              }
              if (/javascript\s*:/i.test(value)) throw new Error("DIAGRAM_SVG_ACTIVE_CONTENT_REJECTED");
            }
            if (tagName === "style") {
              const style = element.textContent ?? "";
              if (/@import|expression\s*\(|javascript\s*:/i.test(style) ||
                  urlReferences(style).some(reference => !allowedLocalReference(reference))) {
                throw new Error("DIAGRAM_SVG_STYLE_REJECTED");
              }
            }
          }
          return new XMLSerializer().serializeToString(svg);
        }, { source: diagram.mermaid, identifier: `sage-diagram-${projection.value.ckgSha256.slice(0, 12)}-${index}` });
        if (Buffer.byteLength(result, "utf8") > MAX_SVG_BYTES) throw new Error("DIAGRAM_SVG_LIMIT_EXCEEDED");
        diagrams.push({ kind: diagram.kind, title: diagram.title, mermaid: diagram.mermaid, svg: result });
      }
      return diagrams;
    };

    const diagrams = await Promise.race([render(), deadline.promise]);
    return {
      ok: true,
      value: {
        bundle: projection.value,
        diagrams: diagrams as [RenderedDiagram, RenderedDiagram],
        rendererVersion: `mermaid@${await packageVersion("mermaid")}`,
        browserVersion: browser.version(),
        blockedRequestCount,
      },
    };
  } catch (error) {
    if (!browser && Date.now() - startedAt >= timeoutMs) return { ok: false, errorCode: "DIAGRAM_RENDER_TIMEOUT" };
    return { ok: false, errorCode: errorCode(error) };
  } finally {
    deadline?.cancel();
    if (browser) await browser.close().catch(() => undefined);
  }
}
