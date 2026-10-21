import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { analyzeReferences as analyzeJs } from "@sage/analyzer-js";
import { analyzeReferences as analyzePhp } from "@sage/analyzer-php";
import { canonicalizeCkg, type CcmSnapshot, type CcmV1 } from "@sage/contracts";
import { renderDiagramBundle } from "../packages/documents/src/render-diagrams.ts";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifactRoot = resolve(repositoryRoot, "artifacts/document-diagrams");
const snapshot: CcmSnapshot = {
  repository: "fixture/document-diagram-renderer",
  branch: "test",
  commitSha: "a".repeat(40),
};
const skipVisualArtifacts = process.argv.includes("--skip-visual-artifacts");

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function assertSafeSvgMarkup(svg: string): void {
  const forbiddenElements = new Set(["script", "foreignobject", "iframe", "object", "embed", "image", "audio", "video", "a", "set", "animate", "animatetransform", "animatemotion"]);
  const tags = [...svg.matchAll(/<([A-Za-z][A-Za-z0-9:.-]*)\b([^<>]*)>/g)];
  assert.ok(tags.length > 0, "serialized SVG must contain markup");
  for (const tag of tags) {
    assert.equal(forbiddenElements.has(tag[1]!.toLowerCase()), false, "SVG must not contain active or linked elements");
    const attributes = tag[2]!;
    assert.doesNotMatch(attributes, /\s+on[a-z]+\s*=/i, "SVG elements must not have event attributes");
    assert.doesNotMatch(attributes, /\s+(?:href|src)\s*=/i, "SVG elements must not carry links");
    assert.doesNotMatch(attributes, /javascript\s*:/i, "SVG attributes must not contain executable URLs");
    assert.doesNotMatch(attributes, /url\(\s*(['"]?)(?!#)/i, "SVG URL references must stay local");
  }
  assert.doesNotMatch(svg, /<\s*(?:script|foreignObject|iframe|object|embed|image|audio|video|a)\b/i);
}

async function readVisibleSvgText(markups: readonly string[]): Promise<string[]> {
  const browser = await chromium.launch({ headless: true, timeout: 10_000, args: ["--disable-background-networking", "--disable-default-apps"] });
  try {
    const context = await browser.newContext({ javaScriptEnabled: true, serviceWorkers: "block" });
    await context.route("**/*", route => route.abort());
    const page = await context.newPage();
    await page.setContent("<!doctype html><html><head><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; script-src 'unsafe-inline'; object-src 'none'\"></head><body></body></html>");
    return await page.evaluate(function collectSvgText(svgMarkups: string[]) {
      const visibleText: string[] = [];
      for (const markup of svgMarkups) {
        const parsed = new DOMParser().parseFromString(markup, "image/svg+xml");
        if (parsed.querySelector("parsererror") || parsed.documentElement.namespaceURI !== "http://www.w3.org/2000/svg") {
          throw new Error("DIAGRAM_TEST_SVG_INVALID");
        }
        let text = "";
        for (const element of Array.from(parsed.documentElement.querySelectorAll("text"))) {
          text += `${element.textContent ?? ""}\n`;
        }
        visibleText.push(text);
      }
      return visibleText;
    }, [...markups]);
  } finally {
    await browser.close();
  }
}

async function verifyUmlCompartments(bundle: Awaited<ReturnType<typeof renderDiagramBundle>>): Promise<void> {
  assert.ok(bundle.ok);
  const uml = bundle.value.bundle.diagrams[0];
  const require = createRequire(import.meta.url);
  const script = await readFile(resolve(dirname(require.resolve("mermaid")), "mermaid.min.js"), "utf8");
  const browser = await chromium.launch({ headless: true, timeout: 10_000 });
  try {
    const context = await browser.newContext({ serviceWorkers: "block" });
    await context.route("**/*", route => route.abort());
    const page = await context.newPage();
    await page.setContent("<!doctype html><html><head><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; object-src 'none'\"></head><body></body></html>");
    await page.addScriptTag({ content: "globalThis.__name = (value) => value;" });
    await page.addScriptTag({ content: script });
    const parsed = await page.evaluate(async (source: string) => {
      const mermaid = (window as unknown as { mermaid: {
        initialize(config: object): void;
        mermaidAPI: { getDiagramFromText(source: string): Promise<{ db: { getClasses(): Map<string, {
          methods: unknown[]; members: unknown[];
        }> } }> };
      } }).mermaid;
      mermaid.initialize({ securityLevel: "strict", htmlLabels: false, startOnLoad: false });
      const diagram = await mermaid.mermaidAPI.getDiagramFromText(source);
      return Array.from(diagram.db.getClasses(), ([id, item]) => ({ id, methods: item.methods.length, properties: item.members.length }));
    }, uml.mermaid);
    for (const language of ["javascript", "typescript", "php"]) {
      assert.ok(uml.nodes.some(node => node.kind === "Method" && node.language === language), `method fixture required for ${language}`);
    }
    for (const classifier of uml.nodes.filter(node => node.kind === "Class" || node.kind === "Interface")) {
      const alias = uml.nodeMappings.find(mapping => mapping.nodeId === classifier.id)!.mermaidId;
      const actual = parsed.find(item => item.id === alias);
      assert.ok(actual, `Mermaid classifier missing: ${alias}`);
      assert.equal(actual.methods, uml.nodes.filter(node => node.parentId === classifier.id && node.kind === "Method").length,
        `native Mermaid method compartment differs for ${classifier.language} ${classifier.name}`);
      assert.equal(actual.properties, uml.nodes.filter(node => node.parentId === classifier.id && node.kind === "Property").length,
        `native Mermaid property compartment differs for ${classifier.language} ${classifier.name}`);
    }
  } finally {
    await browser.close();
  }
}

function combineModels(js: CcmV1, php: CcmV1, sources: Readonly<Record<string, Uint8Array>>) {
  const configurationHash = digest([js.provenance.configHash, php.provenance.configHash].sort().join("\n"));
  const model: CcmV1 = {
    schemaVersion: 1,
    snapshot,
    provenance: {
      analyzer: { name: "sage-document-diagram-renderer-test", version: "1" },
      resolver: { name: "sage-document-diagram-renderer-test", version: "1" },
      configHash: configurationHash,
    },
    files: [...js.files, ...php.files],
    nodes: [...js.nodes, ...php.nodes],
    edges: [...js.edges, ...php.edges],
    limitations: [...js.limitations, ...php.limitations],
  };
  const canonical = canonicalizeCkg(model, sources, configurationHash);
  assert.equal(canonical.ok, true, canonical.ok ? undefined : `fixture CKG rejected: ${canonical.errorCode}`);
  if (!canonical.ok) throw new Error("DIAGRAM_TEST_CKG_INVALID");
  return canonical;
}

async function renderToVisualEvidence(
  diagrams: readonly { title: string; svg: string }[],
  report: Record<string, unknown>,
): Promise<void> {
  await mkdir(artifactRoot, { recursive: true });
  const browser = await chromium.launch({ headless: true, timeout: 10_000, args: ["--disable-background-networking", "--disable-default-apps"] });
  let requestCount = 0;
  try {
    const context = await browser.newContext({ javaScriptEnabled: true, serviceWorkers: "block", viewport: { width: 1440, height: 1000 } });
    await context.route("**/*", route => {
      requestCount += 1;
      return route.abort();
    });

    for (const [index, diagram] of diagrams.entries()) {
      const page = await context.newPage();
      await page.setContent(`<!doctype html><html lang="id"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; object-src 'none'; base-uri 'none'"><style>body{font:16px Arial,sans-serif;margin:32px;color:#142033}main{max-width:1360px;margin:0 auto}h1{font-size:24px;margin:0 0 24px}svg{max-width:100%;height:auto}</style></head><body><main><h1></h1><div id="diagram"></div></main></body></html>`);
      await page.evaluate(({ title, svg }) => {
        const parsed = new DOMParser().parseFromString(svg, "image/svg+xml");
        if (parsed.querySelector("parsererror") || parsed.documentElement.namespaceURI !== "http://www.w3.org/2000/svg") {
          throw new Error("DIAGRAM_QA_SVG_INVALID");
        }
        document.querySelector("h1")!.textContent = title;
        document.getElementById("diagram")!.append(document.importNode(parsed.documentElement, true));
      }, diagram);
      await page.screenshot({ path: resolve(artifactRoot, `${index === 0 ? "uml-class" : "software-structure"}.png`), fullPage: true });
      await page.close();
    }

    const pdfPage = await context.newPage();
    await pdfPage.setContent(`<!doctype html><html lang="id"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; object-src 'none'; base-uri 'none'"><style>@page{size:A4;margin:14mm}body{font:12px Arial,sans-serif;color:#142033}.diagram-page{break-after:page;page-break-after:always;height:255mm;display:flex;flex-direction:column}.diagram-page:last-child{break-after:auto;page-break-after:auto}h1{font-size:19px;margin:0 0 18px}svg{width:100%;height:230mm;flex-shrink:0}</style></head><body><main></main></body></html>`);
    await pdfPage.evaluate(items => {
      const main = document.querySelector("main")!;
      for (const item of items) {
        const page = document.createElement("section");
        page.className = "diagram-page";
        const heading = document.createElement("h1");
        heading.textContent = item.title;
        page.append(heading);
        const parsed = new DOMParser().parseFromString(item.svg, "image/svg+xml");
        if (parsed.querySelector("parsererror") || parsed.documentElement.namespaceURI !== "http://www.w3.org/2000/svg") {
          throw new Error("DIAGRAM_QA_SVG_INVALID");
        }
        page.append(document.importNode(parsed.documentElement, true));
        main.append(page);
      }
    }, diagrams);
    await pdfPage.pdf({ path: resolve(artifactRoot, "diagram-qa.pdf"), format: "A4", printBackground: true });
    assert.equal(requestCount, 0, "QA preview must not request network resources");
    const pdf = await stat(resolve(artifactRoot, "diagram-qa.pdf"));
    assert.ok(pdf.size > 1_000, "QA PDF must contain rendered diagrams");
    await writeFile(resolve(artifactRoot, "test-report.json"), `${JSON.stringify({ ...report, qaPdfBytes: pdf.size, qaNetworkRequests: requestCount }, null, 2)}\n`);
  } finally {
    await browser.close();
  }
}

async function verifyTimeoutAndAtomicFailure(canonicalJson: string, sources: Readonly<Record<string, Uint8Array>>, expectedSha256: string) {
  const originalLaunch = chromium.launch.bind(chromium);
  let closed = false;
  const timeoutBrowser = {
    newContext: async () => ({
      route: async () => undefined,
      newPage: async () => ({
        setContent: async () => undefined,
        addScriptTag: async () => undefined,
        evaluate: async () => new Promise<never>(() => undefined),
      }),
    }),
    close: async () => { closed = true; },
    version: () => "timeout-test",
  } as unknown as Awaited<ReturnType<typeof chromium.launch>>;
  Object.defineProperty(chromium, "launch", { configurable: true, writable: true, value: async () => timeoutBrowser });
  try {
    const timeout = await renderDiagramBundle(canonicalJson, sources, expectedSha256, { timeoutMs: 250 });
    assert.deepEqual(timeout, { ok: false, errorCode: "DIAGRAM_RENDER_TIMEOUT" });
    assert.equal(closed, true, "timeout must close its browser even when page evaluation is hung");
  } finally {
    Object.defineProperty(chromium, "launch", { configurable: true, writable: true, value: originalLaunch });
  }

  let evaluationCount = 0;
  closed = false;
  const failureBrowser = {
    newContext: async () => ({
      route: async () => undefined,
      newPage: async () => ({
        setContent: async () => undefined,
        addScriptTag: async () => undefined,
        evaluate: async () => {
          evaluationCount += 1;
          if (evaluationCount === 1) return '<svg xmlns="http://www.w3.org/2000/svg"><text>first diagram</text></svg>';
          throw new Error("DIAGRAM_SVG_ACTIVE_CONTENT_REJECTED");
        },
      }),
    }),
    close: async () => { closed = true; },
    version: () => "failure-test",
  } as unknown as Awaited<ReturnType<typeof chromium.launch>>;
  Object.defineProperty(chromium, "launch", { configurable: true, writable: true, value: async () => failureBrowser });
  try {
    const failure = await renderDiagramBundle(canonicalJson, sources, expectedSha256);
    assert.deepEqual(failure, { ok: false, errorCode: "DIAGRAM_SVG_ACTIVE_CONTENT_REJECTED" });
    assert.equal(evaluationCount, 2, "failure after one rendered diagram must discard the partial bundle");
    assert.equal(closed, true, "a failed renderer must close its browser");
  } finally {
    Object.defineProperty(chromium, "launch", { configurable: true, writable: true, value: originalLaunch });
  }
}

const jsCanaryMarker = `/tmp/sage-document-diagram-js-canary-${process.pid}`;
const phpCanaryMarker = `/tmp/sage-document-diagram-php-canary-${process.pid}`;
await rm(jsCanaryMarker, { force: true });
await rm(phpCanaryMarker, { force: true });

try {
  const encoder = new TextEncoder();
  const jsSources = {
    "src/js/model.js": encoder.encode(`
export class Base { run() { return true; } }
export class DiagramCanary extends Base {
  ["</textarea><script>window.__SAGE_DIAGRAM_CANARY__=true</script><img src='http://127.0.0.1:9/sage-diagram-canary' onerror='window.__SAGE_DIAGRAM_CANARY__=true'>"]() {}
  invoke(target) { return target.run(); }
}
export class MissingChild extends MissingBase {}
globalThis.__SAGE_DIAGRAM_CANARY__ = true;
require("node:fs").writeFileSync(${JSON.stringify(jsCanaryMarker)}, "executed");
`),
  };
  const tsSources = {
    "src/ts/model.ts": encoder.encode(`
export interface Contract { value: string; run(value: string): void; }
export class Parent {}
export class Child extends Parent implements Contract { value = "ready"; run(value: string) { return value; } }
export class MissingChild extends MissingBase {}
`),
  };
  const phpSources = {
    "src/php/model.php": encoder.encode(`<?php
namespace DiagramFixture;
file_put_contents(${JSON.stringify(phpCanaryMarker)}, 'executed');
class Base { public function run(): void {} }
interface Contract {}
final class Child extends Base implements Contract { public function invoke(): void {} }
final class MissingChild extends MissingBase {}
`),
  };
  const jsAndTsSources = { ...jsSources, ...tsSources };
  const allSourcesWithTs = { ...jsSources, ...tsSources, ...phpSources };
  const jsAnalysis = analyzeJs({ snapshot, sources: jsAndTsSources });
  const phpAnalysis = await analyzePhp({ snapshot, sources: phpSources });
  const jsModel = jsAnalysis.ccm;
  const phpModel = phpAnalysis.ccm;
  assert.ok(jsModel, `JavaScript and TypeScript fixture analysis failed: ${jsAnalysis.errorCode}`);
  assert.ok(phpModel, `PHP fixture analysis failed: ${phpAnalysis.errorCode}`);
  const canonical = combineModels(jsModel, phpModel, allSourcesWithTs);
  assert.ok(canonical.value.ccm.nodes.some(node => node.language === "javascript"));
  assert.ok(canonical.value.ccm.nodes.some(node => node.language === "typescript"));
  assert.ok(canonical.value.ccm.nodes.some(node => node.language === "php"));
  assert.equal(await pathExists(jsCanaryMarker), false, "JavaScript source is analyzed as bytes and never executed");
  assert.equal(await pathExists(phpCanaryMarker), false, "PHP source is parsed and never included or executed");
  assert.equal((globalThis as typeof globalThis & { __SAGE_DIAGRAM_CANARY__?: boolean }).__SAGE_DIAGRAM_CANARY__, undefined);

  const rendered = await renderDiagramBundle(canonical.json, allSourcesWithTs, canonical.sha256);
  assert.equal(rendered.ok, true, rendered.ok ? undefined : `renderer failed: ${rendered.errorCode}`);
  if (!rendered.ok) throw new Error("DIAGRAM_TEST_RENDER_FAILED");
  assert.equal(rendered.value.rendererVersion, "mermaid@12.2.0");
  assert.ok(rendered.value.browserVersion.length > 0);
  assert.equal(rendered.value.blockedRequestCount, 0, "diagram rendering must not attempt external network requests");
  assert.deepEqual(rendered.value.diagrams.map(diagram => diagram.kind), ["uml-class", "software-structure"]);
  await verifyUmlCompartments(rendered);
  const visibleLabels = await readVisibleSvgText(rendered.value.diagrams.map(diagram => diagram.svg));
  assert.ok(visibleLabels.every(labels => labels.includes("DiagramCanary")), "visible model labels must survive SVG rendering");
  assert.doesNotMatch(visibleLabels.join("\n"), /&#58;/, "ordinary path and location punctuation remains readable");
  assert.ok(visibleLabels.some(labels => ["sage", "diagram", "canary"].every(word => labels.includes(word))), "hostile URL words remain visible in the safely encoded label");
  for (const diagram of rendered.value.diagrams) {
    assertSafeSvgMarkup(diagram.svg);
  }
  assert.equal(await pathExists(jsCanaryMarker), false, "rendering must not execute source canary code");
  assert.equal(await pathExists(phpCanaryMarker), false, "rendering must not execute PHP source canary code");
  assert.equal((globalThis as typeof globalThis & { __SAGE_DIAGRAM_CANARY__?: boolean }).__SAGE_DIAGRAM_CANARY__, undefined);

  const invalid = await renderDiagramBundle("{invalid JSON", allSourcesWithTs);
  assert.deepEqual(invalid, { ok: false, errorCode: "CKG_JSON_INVALID" });
  const badHash = await renderDiagramBundle(canonical.json, allSourcesWithTs, "0".repeat(64));
  assert.deepEqual(badHash, { ok: false, errorCode: "CKG_CONTENT_HASH_MISMATCH" });
  const invalidOptions = await renderDiagramBundle(canonical.json, allSourcesWithTs, canonical.sha256, { timeoutMs: 1 });
  assert.deepEqual(invalidOptions, { ok: false, errorCode: "DIAGRAM_RENDER_OPTIONS_INVALID" });
  await verifyTimeoutAndAtomicFailure(canonical.json, allSourcesWithTs, canonical.sha256);

  const functionOnlySources = { "src/js/functions.js": encoder.encode("export function summarize(value) { return value; }\n") };
  const functionOnlyAnalysis = analyzeJs({ snapshot, sources: functionOnlySources });
  assert.ok(functionOnlyAnalysis.ccm, `function-only fixture analysis failed: ${functionOnlyAnalysis.errorCode}`);
  const functionOnlyCanonical = canonicalizeCkg(functionOnlyAnalysis.ccm, functionOnlySources, functionOnlyAnalysis.ccm.provenance.configHash);
  assert.equal(functionOnlyCanonical.ok, true, functionOnlyCanonical.ok ? undefined : `function-only fixture CKG rejected: ${functionOnlyCanonical.errorCode}`);
  if (!functionOnlyCanonical.ok) throw new Error("DIAGRAM_TEST_FUNCTION_ONLY_CKG_INVALID");
  const functionOnlyRendered = await renderDiagramBundle(functionOnlyCanonical.json, functionOnlySources, functionOnlyCanonical.sha256);
  assert.equal(functionOnlyRendered.ok, true, functionOnlyRendered.ok ? undefined : `empty UML render failed: ${functionOnlyRendered.errorCode}`);
  if (!functionOnlyRendered.ok) throw new Error("DIAGRAM_TEST_EMPTY_UML_RENDER_FAILED");
  assert.equal(functionOnlyRendered.value.bundle.diagrams[0].nodes.length, 0, "function-only repositories have a valid empty UML projection");
  assert.ok(functionOnlyRendered.value.diagrams[0].svg.includes("<svg"), "empty UML projection still serializes as SVG");
  const emptyUmlText = await readVisibleSvgText([functionOnlyRendered.value.diagrams[0].svg]);
  assert.ok(["Tidak", "deklarasi", "class", "interface", "CKG"].every(word => emptyUmlText[0]?.includes(word)), "empty UML explains why it has no classifier nodes");

  const emptyConfigurationHash = digest("sage-empty-diagram-configuration");
  const emptyModel: CcmV1 = {
    schemaVersion: 1,
    snapshot,
    provenance: {
      analyzer: { name: "sage-document-diagram-renderer-test", version: "1" },
      resolver: { name: "sage-document-diagram-renderer-test", version: "1" },
      configHash: emptyConfigurationHash,
    },
    files: [],
    nodes: [],
    edges: [],
    limitations: [],
  };
  const emptyCanonical = canonicalizeCkg(emptyModel, {}, emptyConfigurationHash);
  assert.equal(emptyCanonical.ok, true, emptyCanonical.ok ? undefined : `empty fixture CKG rejected: ${emptyCanonical.errorCode}`);
  if (!emptyCanonical.ok) throw new Error("DIAGRAM_TEST_EMPTY_CKG_INVALID");
  const emptyRendered = await renderDiagramBundle(emptyCanonical.json, {}, emptyCanonical.sha256);
  assert.equal(emptyRendered.ok, true, emptyRendered.ok ? undefined : `zero-node CKG render failed: ${emptyRendered.errorCode}`);
  if (!emptyRendered.ok) throw new Error("DIAGRAM_TEST_ZERO_NODE_RENDER_FAILED");
  assert.equal(emptyRendered.value.bundle.diagrams[1].nodes.length, 0, "empty CKG keeps the structure diagram empty");
  assert.ok(emptyRendered.value.diagrams.every(diagram => diagram.svg.includes("<svg")), "empty CKG renders both diagram SVGs");

  const oversizedLabel = "<".repeat(13_000);
  const oversizedSources = { "src/ts/oversized.ts": encoder.encode(`export class Oversized { ["${oversizedLabel}"]() {} }\n`) };
  const oversizedAnalysis = analyzeJs({ snapshot, sources: oversizedSources });
  assert.ok(oversizedAnalysis.ccm, `oversized fixture analysis failed: ${oversizedAnalysis.errorCode}`);
  const oversizedConfigurationHash = oversizedAnalysis.ccm.provenance.configHash;
  const oversizedCanonical = canonicalizeCkg(oversizedAnalysis.ccm, oversizedSources, oversizedConfigurationHash);
  assert.equal(oversizedCanonical.ok, true, oversizedCanonical.ok ? undefined : `oversized fixture CKG rejected: ${oversizedCanonical.errorCode}`);
  if (!oversizedCanonical.ok) throw new Error("DIAGRAM_TEST_OVERSIZED_CKG_INVALID");
  const tooLarge = await renderDiagramBundle(oversizedCanonical.json, oversizedSources, oversizedCanonical.sha256);
  assert.deepEqual(tooLarge, { ok: false, errorCode: "DIAGRAM_SOURCE_LIMIT_EXCEEDED" });

  const report = {
    status: "PASS",
    snapshot: rendered.value.bundle.snapshot,
    ckgSha256: rendered.value.bundle.ckgSha256,
    languages: ["javascript", "typescript", "php"],
    canonicalNodeCount: rendered.value.bundle.canonicalCounts.nodes,
    canonicalEdgeCount: rendered.value.bundle.canonicalCounts.edges,
    diagrams: rendered.value.diagrams.map(diagram => ({ kind: diagram.kind, title: diagram.title, svgBytes: Buffer.byteLength(diagram.svg) })),
    rendererVersion: rendered.value.rendererVersion,
    browserVersion: rendered.value.browserVersion,
    blockedRequests: rendered.value.blockedRequestCount,
    security: { maliciousLabelReadable: true, activeSvgContent: false, sourceExecution: false, networkRequests: 0 },
    failureChecks: ["invalid CKG", "hash mismatch", "invalid options", "50 KB Mermaid-source ceiling rejects rather than truncating", "hung render timeout closes browser", "second diagram failure discards partial bundle", "function-only CKG renders an empty UML with a visible explanation", "zero-node CKG renders both diagrams"],
    visualArtifacts: skipVisualArtifacts ? "skipped by --skip-visual-artifacts" : "artifacts/document-diagrams/diagram-qa.pdf and screenshots",
  };
  if (!skipVisualArtifacts) {
    // Keep print readability independent of the deliberately long hostile-label security fixture.
    const printSources = {
      "app.js": encoder.encode("export function run() {}\n"),
      "model.ts": encoder.encode("export class Base {}\nexport class Child extends Base { value = 1; }\n"),
      "app.php": encoder.encode("<?php function run(): void {}\n"),
    };
    const printJs = analyzeJs({ snapshot, sources: { "app.js": printSources["app.js"], "model.ts": printSources["model.ts"] } });
    const printPhp = await analyzePhp({ snapshot, sources: { "app.php": printSources["app.php"] } });
    assert.ok(printJs.ccm);
    assert.ok(printPhp.ccm);
    const printCanonical = combineModels(printJs.ccm, printPhp.ccm, printSources);
    const printRendered = await renderDiagramBundle(printCanonical.json, printSources, printCanonical.sha256);
    assert.equal(printRendered.ok, true, printRendered.ok ? undefined : printRendered.errorCode);
    if (!printRendered.ok) throw new Error("DIAGRAM_TEST_PRINT_RENDER_FAILED");
    await renderToVisualEvidence(printRendered.value.diagrams, {
      ...report,
      printFixture: { ckgSha256: printCanonical.sha256, counts: printCanonical.value.counts,
        purpose: "compact mixed-language print fixture; hostile labels tested separately above" },
    });
  }
  console.log(JSON.stringify(report, null, 2));
} finally {
  await rm(jsCanaryMarker, { force: true });
  await rm(phpCanaryMarker, { force: true });
}
