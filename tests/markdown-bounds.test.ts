import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { analyzeReferences } from "@sage/analyzer-js";
import { canonicalizeCkg, type CcmSnapshot } from "@sage/contracts";
import { projectArchitectureDocument } from "../packages/documents/src/architecture-document.ts";
import {
  MAX_MARKDOWN_EXPORT_BYTES,
  MarkdownExportTooLargeError,
  renderMarkdownDocument,
  renderMarkdownDocumentChunks,
} from "../packages/documents/src/markdown.ts";

const configHash = "a".repeat(64);
const snapshot: CcmSnapshot = {
  repository: "fixture/markdown-export",
  branch: "feature/markdown",
  commitSha: "d".repeat(40),
};
const sources = {
  "src/model.ts": new TextEncoder().encode(`
export interface Contract { run(): void; }
export class Base {}
export class Child extends Base implements Contract {
  run(): void { missingCall(); }
}
export class UnknownChild extends MissingBase {}
`),
};

async function buildDocument() {
  const analysis = await analyzeReferences({ snapshot, sources });
  assert.ok(analysis.ccm, `analyzer did not produce a CCM: ${analysis.errorCode}`);
  const canonical = canonicalizeCkg(analysis.ccm, sources, configHash);
  assert.ok(canonical.ok, canonical.ok ? undefined : `CKG validation failed: ${canonical.errorCode}`);
  const projected = projectArchitectureDocument(canonical.json, sources, canonical.sha256);
  assert.ok(projected.ok, projected.ok ? undefined : `document projection failed: ${projected.errorCode}`);
  return projected.value;
}

function collect(chunks: Iterable<string>): string {
  let output = "";
  for (const chunk of chunks) output += chunk;
  return output;
}

function isExportTooLarge(error: unknown): boolean {
  return error instanceof MarkdownExportTooLargeError && error.code === "EXPORT_TOO_LARGE";
}

test("Markdown chunks preserve the legacy fixture bytes and stay bounded", async () => {
  const document = await buildDocument();
  const chunks = [...renderMarkdownDocumentChunks(document)];
  const rendered = chunks.join("");

  assert.equal(rendered, renderMarkdownDocument(document));
  assert.equal(createHash("sha256").update(rendered, "utf8").digest("hex"),
    "fe284af2f529042baf59db20b6bc0f5e2eef0f334dcf3d9e96276e8d0e1c61aa",
    "the current analyzer fixture renders byte-for-byte like the pre-bounds renderer");
  assert.ok(chunks.every(chunk => Buffer.byteLength(chunk, "utf8") <= 64 * 1024),
    "each chunk fits the writer's bounded write size");
  assert.ok(Buffer.byteLength(rendered, "utf8") < MAX_MARKDOWN_EXPORT_BYTES);

  document.softwareEngineeringDiagram.mermaid += "m".repeat(160 * 1024);
  assert.ok([...renderMarkdownDocumentChunks(document)].length > 1,
    "larger exports are yielded as multiple bounded chunks");
});

test("size limits count UTF-8 bytes and fail without returning partial Markdown", async () => {
  const document = await buildDocument();
  document.title = "🧪 architecture";
  const fullMarkdown = renderMarkdownDocument(document);
  const fullMarkdownBytes = Buffer.byteLength(fullMarkdown, "utf8");
  assert.equal(collect(renderMarkdownDocumentChunks(document, { maxBytes: fullMarkdownBytes })), fullMarkdown,
    "an output exactly at the configured byte limit succeeds");
  assert.throws(() => collect(renderMarkdownDocumentChunks(document, { maxBytes: fullMarkdownBytes - 1 })), isExportTooLarge);

  const firstChunk = renderMarkdownDocumentChunks(document).next().value;
  assert.ok(firstChunk);
  assert.ok(Buffer.byteLength(firstChunk, "utf8") > firstChunk.length,
    "the test prefix contains multi-byte UTF-8 text");

  const utf16LengthLimit = firstChunk.length;
  assert.throws(() => renderMarkdownDocumentChunks(document, { maxBytes: utf16LengthLimit }).next(), isExportTooLarge);
  assert.throws(() => renderMarkdownDocument(document, { maxBytes: utf16LengthLimit }), isExportTooLarge);
});

test("streamed stable JSON keeps legacy numeric-key, backtick, and DEL formatting", async () => {
  const document = await buildDocument();
  const node = document.softwareEngineeringDiagram.nodes[0];
  assert.ok(node, "fixture contains a diagram node for stable JSON formatting");
  node.attributes = { "10": "ten", "2": "two", del: "\u007f", tick: "`" };

  const markdown = renderMarkdownDocument(document);
  assert.ok(markdown.includes('Attributes (canonical JSON): ``{"10":"ten","2":"two","del":"\\u007f","tick":"`"}``'),
    "stable JSON retains lexicographic key order, the legacy two-tick fence, and visible DEL escaping");
});

test("UTF-8 chunk writes preserve a supplementary character at a 64 KiB boundary", async () => {
  const document = await buildDocument();
  document.softwareEngineeringDiagram.mermaid = `${"a".repeat(65_535)}🧭${"b".repeat(2_000)}`;
  const chunks = [...renderMarkdownDocumentChunks(document)];
  const chunkBytes = Buffer.concat(chunks.map(chunk => Buffer.from(chunk, "utf8")));
  const fullBytes = Buffer.from(renderMarkdownDocument(document), "utf8");

  assert.deepEqual(chunkBytes, fullBytes, "writing each yielded chunk produces the exact rendered UTF-8 bytes");
  assert.ok(chunks.every(chunk => Buffer.byteLength(chunk, "utf8") <= 64 * 1024),
    "a surrogate pair never gets split across writer chunks");
});

test("rendering stops at the byte cap before reading later diagram sections", async () => {
  const base = await buildDocument();
  let laterDiagramRead = false;
  const document = {
    ...base,
    softwareEngineeringDiagram: {
      ...base.softwareEngineeringDiagram,
      mermaid: "m".repeat(512 * 1024),
    },
  };
  Object.defineProperty(document, "umlClassDiagram", {
    get() {
      laterDiagramRead = true;
      return base.umlClassDiagram;
    },
  });

  const chunks = renderMarkdownDocumentChunks(document, { maxBytes: 128 * 1024 });
  let yielded = 0;
  assert.throws(() => {
    while (true) {
      const next = chunks.next();
      if (next.done) break;
      assert.ok(next.value.length > 0);
      yielded += 1;
    }
  }, isExportTooLarge);
  assert.ok(yielded > 0, "bounded chunks are available before the oversized section");
  assert.equal(laterDiagramRead, false, "the later diagram is not read after the cap is exceeded");
  assert.throws(() => renderMarkdownDocument(document, { maxBytes: 128 * 1024 }), isExportTooLarge,
    "the string renderer throws instead of returning a partial result");
});

test("large evidence lists do not use variadic argument expansion", async () => {
  const document = await buildDocument();
  const edge = document.softwareEngineeringDiagram.edges[0];
  assert.ok(edge, "fixture contains an edge to use for evidence serialization");
  edge.evidence = Array.from({ length: 150_000 }, (_, index) => ({
    role: "reference",
    filePath: "src/model.ts",
    fileSha256: "f".repeat(64),
    startByte: index,
    endByte: index + 1,
    startLine: index + 1,
    startColumn: 1,
    endLine: index + 1,
    endColumn: 2,
  }));

  const iterator = renderMarkdownDocumentChunks(document, { maxBytes: MAX_MARKDOWN_EXPORT_BYTES + 1 });
  assert.equal(iterator.next().done, false);
  assert.throws(() => collect(iterator), error => error instanceof MarkdownExportTooLargeError &&
    error.code === "EXPORT_TOO_LARGE" && error.maxBytes === MAX_MARKDOWN_EXPORT_BYTES,
    "oversized evidence stops through the byte cap, rather than a spread argument limit");
});
