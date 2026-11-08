import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { CcmV1 } from "@sage/contracts";
import { analyzeDocumentation, DOCUMENTATION_LIMITS } from "../packages/documents/src/semantic/documentation.ts";
import { isDocumentationContext } from "../packages/documents/src/semantic/documentation-validation.ts";
import { buildSemanticModel } from "../packages/documents/src/semantic/build.ts";
import { canonicalSemanticContent } from "../packages/database/src/semantic.ts";
import type { DocumentationContext } from "../packages/documents/src/semantic/documentation.ts";

const encode = (value: string) => new TextEncoder().encode(value);

test("documentation inventory sorts root, package, ADR, and docs candidates deterministically", () => {
  const contents: Record<string, Uint8Array> = {
    "README.md": encode("# Root\n"),
    "packages/widget/package.json": encode("{}"),
    "packages/widget/rEaDmE.Md": encode("# Package\n"),
    "services/php/composer.json": encode("{}"),
    "services/php/README.md": encode("# PHP package\n"),
    "docs/z-last.md": encode("# Last\n"),
    "docs/a-first.md": encode("# First\n"),
    "docs/adr/0002-next.md": encode("# ADR 2\n"),
    "docs/adrs/0001-first.md": encode("# ADR 1\n"),
    "vendor/docs/private.md": encode("# Vendor\n"),
    "dependencies/docs/dependency.md": encode("# Dependency\n"),
    "build/adr/generated.md": encode("# Generated\n"),
  };
  const paths = Object.keys(contents);
  const first = analyzeDocumentation({ sources: contents, snapshotPaths: paths });
  const second = analyzeDocumentation({ sources: contents, snapshotPaths: [...paths].reverse() });

  assert.deepEqual(first, second);
  assert.deepEqual(first.documents.map(({ filePath, kind }) => [filePath, kind]), [
    ["README.md", "root-readme"],
    ["packages/widget/rEaDmE.Md", "package-readme"],
    ["services/php/README.md", "package-readme"],
    ["docs/adr/0002-next.md", "architecture-adr"],
    ["docs/adrs/0001-first.md", "architecture-adr"],
    ["docs/a-first.md", "docs"],
    ["docs/z-last.md", "docs"],
  ]);
  assert.deepEqual(first.coverage.skipped, [
    { filePath: "build/adr/generated.md", reason: "excluded" },
    { filePath: "dependencies/docs/dependency.md", reason: "excluded" },
    { filePath: "vendor/docs/private.md", reason: "excluded" },
  ]);
});

test("GFM blocks, code spans, and relative/reference links carry exact UTF-8 evidence", () => {
  const markdown = [
    "## Café 🛶",
    "",
    "Say `é` now and [read the guide](guide.md#intro).",
    "",
    "- [x] Keep `first`",
    "- [ ] Keep second",
    "",
    "| Name | Value |",
    "| --- | --- |",
    "| mode | `safe` |",
    "",
    "[Reference link][manual], [unresolved][not-there], and [outside](https://example.com/path).",
    "[same page](#cafe) [folder](guide/) [gone](missing.md) [escape](../../outside.md) [bad](javascript:alert(1)).",
    "[encoded absolute](%2Ftarget.ts) [encoded drive](%43%3A%2Ftarget.ts) [encoded scheme](javascript%3Aalert%281%29).",
    "",
    "[manual]: ../notes.md",
    "",
    "```js",
    "console.log('example only');",
    "```",
  ].join("\n");
  const context = analyzeDocumentation({
    sources: { "docs/README.md": encode(markdown) },
    snapshotPaths: ["docs/README.md", "docs/guide.md", "docs/guide/index.md", "notes.md"],
  });
  const document = context.documents[0]!;
  const section = document.sections.find((candidate) => candidate.heading === "Café 🛶")!;
  const paragraph = section.blocks.find((block) => block.kind === "paragraph");
  assert.equal(document.title, "Café 🛶");
  assert.equal(paragraph?.kind, "paragraph");
  if (paragraph?.kind !== "paragraph") throw new Error("expected paragraph block");
  assert.ok(paragraph.text.includes("Say é now"));
  const referenceParagraph = section.blocks.find((block) => block.kind === "paragraph" && block.text.includes("Reference link"));
  assert.equal(referenceParagraph?.kind, "paragraph");
  if (referenceParagraph?.kind !== "paragraph") throw new Error("expected reference paragraph");
  assert.ok(referenceParagraph.text.includes("[unresolved][not-there]"), "unresolved Markdown reference syntax remains inert prose");
  const inlineCode = paragraph.inlineCode.find((entry) => entry.text === "é")!;
  assert.equal(inlineCode.evidence.role, "context");
  assert.equal(inlineCode.evidence.startLine, 3);
  assert.equal(inlineCode.evidence.startColumn, 5);
  assert.equal(inlineCode.evidence.endColumn, 8);
  assert.equal(
    Buffer.from(markdown, "utf8").subarray(inlineCode.evidence.startByte, inlineCode.evidence.endByte).toString("utf8"),
    "`é`",
  );

  const list = section.blocks.find((block) => block.kind === "list");
  assert.equal(list?.kind, "list");
  if (list?.kind === "list") {
    assert.equal(list.items[0]?.checked, true);
    assert.equal(list.items[1]?.checked, false);
    assert.equal(list.items[0]?.inlineCode[0]?.text, "first");
  }
  const table = section.blocks.find((block) => block.kind === "table");
  assert.equal(table?.kind, "table");
  if (table?.kind === "table") {
    assert.deepEqual(table.rows[0]?.cells, ["Name", "Value"]);
    assert.equal(table.rows[0]?.header, true);
    assert.equal(table.inlineCode[0]?.text, "safe");
  }
  const example = section.blocks.find((block) => block.kind === "example");
  assert.deepEqual(example && { kind: example.kind, language: example.language, text: example.text }, {
    kind: "example", language: "js", text: "console.log('example only');",
  });

  const byTarget = new Map(context.references.map((reference) => [reference.target, reference]));
  assert.equal(byTarget.get("guide.md#intro")?.resolution, "resolved");
  assert.equal(byTarget.get("../notes.md")?.resolution, "resolved");
  assert.equal(byTarget.get("https://example.com/path")?.resolution, "external");
  assert.equal(byTarget.get("#cafe")?.resolution, "anchor");
  assert.equal(byTarget.get("guide/")?.resolution, "directory");
  assert.equal(byTarget.get("missing.md")?.resolution, "missing");
  assert.equal(byTarget.get("../../outside.md")?.resolution, "unsafe");
  assert.equal(byTarget.get("javascript:alert(1)")?.resolution, "unsafe");
  assert.equal(byTarget.get("%2Ftarget.ts")?.resolution, "unsafe");
  assert.equal(byTarget.get("%43%3A%2Ftarget.ts")?.resolution, "unsafe");
  assert.equal(byTarget.get("javascript%3Aalert%281%29")?.resolution, "unsafe");
  assert.equal(byTarget.get("../notes.md")?.evidence.role, "reference");
  assert.equal(Object.hasOwn(context, "nodes"), false, "documentation prose is not represented as semantic calls");
  assert.ok(isDocumentationContext(context, new Map([
    ["docs/README.md", document.fileSha256],
    ["docs/guide.md", "a".repeat(64)],
    ["docs/guide/index.md", "b".repeat(64)],
    ["notes.md", "c".repeat(64)],
  ])));
});

test("HTML, MDX-like syntax, and fenced examples stay inert plain documentation", () => {
  const host = globalThis as typeof globalThis & { __documentationParserExecuted?: boolean };
  delete host.__documentationParserExecuted;
  const markdown = [
    "# Safe display",
    "",
    "Visible prose with {globalThis.__documentationParserExecuted = true}.",
    "",
    "<script>globalThis.__documentationParserExecuted = true</script>",
    "<img src=x onerror=globalThis.__documentationParserExecuted=true>",
    "",
    "```js",
    "globalThis.__documentationParserExecuted = true;",
    "```",
  ].join("\n");
  const context = analyzeDocumentation({ sources: { "README.md": encode(markdown) }, snapshotPaths: ["README.md"] });
  const serializedBlocks = JSON.stringify(context.documents[0]?.sections);
  assert.equal(host.__documentationParserExecuted, undefined);
  assert.ok(serializedBlocks?.includes("globalThis.__documentationParserExecuted = true"), "MDX-like prose and examples are retained as inert text");
  assert.ok(!serializedBlocks?.includes("<script>"), "raw HTML nodes are not emitted as renderable markup");
  assert.ok(!serializedBlocks?.includes("onerror="), "raw HTML attributes are dropped");
  assert.deepEqual(Object.keys(context).sort(), ["coverage", "documents", "references"]);
});

test("only standalone path-like inline code becomes a documentation reference", () => {
  const markdown = [
    "# Paths",
    "",
    "Inspect `src/foo.ts`, `./config.json`, `foo.ts`, and `missing.json`.",
    "Ignore `some command` and `result.call()` as path references.",
    "",
    "```ts",
    "src/fenced.ts",
    "```",
  ].join("\n");
  const context = analyzeDocumentation({
    sources: { "README.md": encode(markdown) },
    snapshotPaths: ["README.md", "src/foo.ts", "config.json"],
  });
  const byTarget = new Map(context.references.map((reference) => [reference.target, reference]));
  assert.equal(byTarget.get("src/foo.ts")?.resolution, "resolved");
  assert.equal(byTarget.get("./config.json")?.resolution, "resolved");
  assert.equal(byTarget.get("foo.ts")?.resolution, "missing", "basename matching does not search nested snapshot paths");
  assert.equal(byTarget.get("foo.ts")?.targetPath, "foo.ts");
  assert.equal(byTarget.get("missing.json")?.resolution, "missing");
  assert.equal(byTarget.has("some command"), false);
  assert.equal(byTarget.has("result.call()"), false);
  assert.equal(byTarget.has("src/fenced.ts"), false, "fenced examples are retained as examples, never path references");
  const paragraph = context.documents[0]!.sections[0]!.blocks[0]!;
  assert.equal(paragraph.kind, "paragraph");
  if (paragraph.kind !== "paragraph") throw new Error("expected paragraph block");
  const code = paragraph.inlineCode.find((item) => item.text === "src/foo.ts")!;
  const reference = byTarget.get("src/foo.ts")!;
  assert.equal(code.evidence.role, "context");
  assert.equal(reference.evidence.role, "reference");
  assert.equal(Buffer.from(markdown, "utf8").subarray(reference.evidence.startByte, reference.evidence.endByte).toString(), "`src/foo.ts`");
});

test("whole candidate files are skipped with deterministic reasons and strict byte limits", () => {
  const tooLarge = new Uint8Array(DOCUMENTATION_LIMITS.maxFileBytes + 1).fill(0x61);
  const fullFile = new Uint8Array(DOCUMENTATION_LIMITS.maxFileBytes).fill(0x20);
  const chunks = Array.from({ length: 17 }, (_, index) => `docs/chunk-${String(index).padStart(2, "0")}.md`);
  const paths = ["README.md", ...chunks, "docs/invalid.md", "docs/binary.md", "docs/large.md", "../docs/unsafe.md"];
  const sources: Record<string, Uint8Array> = {
    "README.md": fullFile,
    "docs/invalid.md": new Uint8Array([0xc3, 0x28]),
    "docs/binary.md": new Uint8Array([0x23, 0x20, 0x00, 0x61]),
    "docs/large.md": tooLarge,
  };
  for (const path of chunks) sources[path] = fullFile;
  const context = analyzeDocumentation({
    sources,
    snapshotPaths: paths,
  });
  assert.equal(context.documents[0]?.filePath, "README.md");
  assert.equal(context.documents.length, 15);
  assert.ok(context.documents.length <= DOCUMENTATION_LIMITS.maxFiles);
  assert.ok(context.documents.every((document) => document.byteLength <= DOCUMENTATION_LIMITS.maxFileBytes));
  assert.ok(context.coverage.documentByteCount <= DOCUMENTATION_LIMITS.maxTotalBytes);
  assert.ok(context.coverage.documentByteCount > DOCUMENTATION_LIMITS.maxTotalBytes - DOCUMENTATION_LIMITS.maxFileBytes);
  assert.deepEqual(context.coverage.skipped, [
    { filePath: "../docs/unsafe.md", reason: "unsafe-path" },
    { filePath: "docs/binary.md", reason: "binary" },
    { filePath: "docs/chunk-14.md", reason: "aggregate-byte-limit" },
    { filePath: "docs/chunk-15.md", reason: "aggregate-byte-limit" },
    { filePath: "docs/chunk-16.md", reason: "aggregate-byte-limit" },
    { filePath: "docs/invalid.md", reason: "invalid-utf8" },
    { filePath: "docs/large.md", reason: "too-large" },
  ]);
  assert.equal(context.coverage.candidateFileCount, context.documents.length + context.coverage.skipped.length);
});

test("file-count and AST-node bounds skip complete files", () => {
  const paths = Array.from({ length: 101 }, (_, index) => `docs/${String(index).padStart(3, "0")}.md`);
  const sources = Object.fromEntries(paths.map((path) => [path, encode("# Small\n")])) as Record<string, Uint8Array>;
  const countBound = analyzeDocumentation({ sources, snapshotPaths: paths });
  assert.equal(countBound.documents.length, DOCUMENTATION_LIMITS.maxFiles);
  assert.deepEqual(countBound.coverage.skipped, [{ filePath: "docs/100.md", reason: "file-count-limit" }]);

  const manyBlocks = Array.from({ length: 10_001 }, (_, index) => `Paragraph ${index}\n\n`).join("");
  const astBound = analyzeDocumentation({ sources: { "README.md": encode(manyBlocks) }, snapshotPaths: ["README.md"] });
  assert.deepEqual(astBound.documents, []);
  assert.deepEqual(astBound.coverage.skipped, [{ filePath: "README.md", reason: "node-limit" }]);
});

test("overlong parsed values skip the whole document and canonical model validation still succeeds", () => {
  const cases = [
    `# Oversized language\n\n\`\`\`${"x".repeat(129)}\ncode\n\`\`\`\n`,
    `# Oversized external target\n\n[site](https://example.org/${"x".repeat(32768)})\n`,
    `# Oversized relative target\n\n[local](${"x".repeat(4097)})\n`,
  ];
  for (const markdown of cases) {
    const context = analyzeDocumentation({ sources: { "README.md": encode(markdown) }, snapshotPaths: ["README.md"] });
    assert.deepEqual(context.documents, []);
    assert.deepEqual(context.coverage.skipped, [{ filePath: "README.md", reason: "representation-limit" }]);
    assert.equal(isDocumentationContext(context), true);
  }

  const longSourcePath = `docs/${"p".repeat(4089)}.md`;
  assert.equal(longSourcePath.length, 4097);
  const longPathContext = analyzeDocumentation({
    sources: { [longSourcePath]: encode("# Too long path\n") },
    snapshotPaths: [longSourcePath],
  });
  assert.deepEqual(longPathContext.coverage.skipped, [{ filePath: longSourcePath, reason: "representation-limit" }]);
  assert.equal(isDocumentationContext(longPathContext), true);

  const badReadme = encode(cases[0]!);
  const fileSha256 = createHash("sha256").update(badReadme).digest("hex");
  const ccm: CcmV1 = {
    schemaVersion: 1,
    snapshot: { repository: "fixture/docs", branch: "main", commitSha: "a".repeat(40) },
    provenance: { analyzer: { name: "fixture", version: "1" }, resolver: { name: "fixture", version: "1" }, configHash: "b".repeat(64) },
    files: [{ path: "README.md", language: null, sha256: fileSha256, sizeBytes: badReadme.byteLength, status: "excluded" }],
    nodes: [],
    edges: [],
    limitations: [],
  };
  const model = buildSemanticModel({
    ccm,
    sourceCkgHash: "c".repeat(64),
    sources: {},
    documentationSources: { "README.md": badReadme },
    snapshotPaths: ["README.md"],
  });
  assert.deepEqual(model.documentation?.coverage.skipped, [{ filePath: "README.md", reason: "representation-limit" }]);
  assert.equal(isDocumentationContext(model.documentation, new Map([["README.md", fileSha256]])), true);
  assert.doesNotThrow(() => canonicalSemanticContent(model, model.sourceCkgHash, new Set(), new Map([["README.md", fileSha256]]), ccm.snapshot));
});

test("validator binds every evidence span and rejects accessors, sparse arrays, and inconsistent references", () => {
  const source = "# Valid\n\nText with `code`.\n";
  const context = analyzeDocumentation({ sources: { "README.md": encode(source) }, snapshotPaths: ["README.md"] });
  assert.ok(isDocumentationContext(context));

  const badSpan = structuredClone(context) as DocumentationContext;
  badSpan.documents[0]!.sections[0]!.blocks[0]!.evidence.endByte = source.length + 100;
  assert.equal(isDocumentationContext(badSpan), false);

  const badRef = structuredClone(context) as DocumentationContext;
  badRef.references.push({
    sourcePath: "README.md", target: "missing.md", targetPath: "missing.md", resolution: "resolved",
    evidence: {
      filePath: "README.md", fileSha256: context.documents[0]!.fileSha256, startByte: 0, endByte: 1,
      startLine: 1, endLine: 1, startColumn: 1, endColumn: 2, role: "reference",
    },
  });
  badRef.coverage.candidateFileCount += 1;
  assert.equal(isDocumentationContext(badRef, new Map([["README.md", context.documents[0]!.fileSha256]])), false);

  const accessorPayload = { ...context };
  Object.defineProperty(accessorPayload, "documents", { enumerable: true, get: () => context.documents });
  assert.equal(isDocumentationContext(accessorPayload), false);

  const sparsePayload = structuredClone(context) as DocumentationContext;
  sparsePayload.documents = new Array(1);
  assert.equal(isDocumentationContext(sparsePayload), false);

  const customPrototypePayload = structuredClone(context) as DocumentationContext;
  let invoked = false;
  Object.setPrototypeOf(customPrototypePayload.documents, { [Symbol.iterator]() { invoked = true; throw new Error("must stay data"); } });
  assert.equal(isDocumentationContext(customPrototypePayload), false);
  assert.equal(invoked, false, "validation must not invoke methods on a custom array prototype");
});
