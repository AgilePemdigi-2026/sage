import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { open, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { performance } from "node:perf_hooks";
import { projectArchitectureDocument } from "../packages/documents/src/architecture-document.ts";
import {
  MAX_MARKDOWN_EXPORT_BYTES,
  MarkdownExportTooLargeError,
  renderMarkdownDocumentChunks,
} from "../packages/documents/src/markdown.ts";
import { renderPdfDocument } from "../packages/documents/src/pdf.ts";
import { renderSemanticMarkdown } from "../packages/documents/src/semantic/render.ts";
import type { SemanticModel } from "../packages/documents/src/semantic/model.ts";

// A fresh process mirrors export-worker isolation: no retained analyzer AST, replay model or CCM.
const [input, output] = process.argv.slice(2) as [string, string];
const spec = JSON.parse(await readFile(join(input, ".snapshot.json"), "utf8"));
const slug = spec.repository.split("/").at(-1);
const reportPath = join(output, `${slug}-report.json`);
const report = JSON.parse(await readFile(reportPath, "utf8"));
const sources: Record<string, Uint8Array> = {};

async function collect(path: string): Promise<void> {
  for (const item of await readdir(path, { withFileTypes: true })) {
    if (item.name === ".snapshot.json") continue;
    const full = join(path, item.name);
    if (item.isDirectory()) await collect(full);
    else if (item.isFile()) {
      sources[relative(input, full).replaceAll("\\", "/")] = await readFile(full);
    }
  }
}

interface MarkdownWriteState {
  fileCreated: boolean;
  bytesWritten: number;
}

async function writeMarkdownChunks(
  path: string,
  prefix: string,
  document: Parameters<typeof renderMarkdownDocumentChunks>[0],
  state: MarkdownWriteState,
): Promise<string> {
  const prefixBuffer = Buffer.from(prefix, "utf8");
  if (prefixBuffer.byteLength >= MAX_MARKDOWN_EXPORT_BYTES) {
    throw new MarkdownExportTooLargeError(MAX_MARKDOWN_EXPORT_BYTES);
  }

  const handle = await open(path, "wx", 0o600);
  state.fileCreated = true;
  const hash = createHash("sha256");
  try {
    await handle.writeFile(prefixBuffer);
    hash.update(prefixBuffer);
    state.bytesWritten += prefixBuffer.byteLength;

    const remainingBytes = MAX_MARKDOWN_EXPORT_BYTES - prefixBuffer.byteLength;
    for (const chunk of renderMarkdownDocumentChunks(document, { maxBytes: remainingBytes })) {
      const bytes = Buffer.from(chunk, "utf8");
      await handle.writeFile(bytes);
      hash.update(bytes);
      state.bytesWritten += bytes.byteLength;
    }
    await handle.sync();
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

await collect(input);
const started = performance.now();
let failed = false;
try {
  const model = JSON.parse(await readFile(join(output, `${slug}-semantic.json`), "utf8")) as SemanticModel;
  if (
    createHash("sha256").update(JSON.stringify(model), "utf8").digest("hex") !== report.modelHash ||
    model.snapshot.commitSha !== spec.commit ||
    model.snapshot.repository !== spec.repository
  ) {
    throw new Error("Pinned semantic model differs from source measurement");
  }
  const graphJson = await readFile(join(output, `${slug}-ckg.json`), "utf8");
  console.log(JSON.stringify({ phase: "document-projection", repository: spec.repository }));
  const document = projectArchitectureDocument(graphJson, sources, model.sourceCkgHash);
  if (!document.ok) throw new Error(document.errorCode);

  const presentation = {
    model,
    overlay: { labels: Object.fromEntries(model.features.slice(0, 1).map(feature => [feature.id, "Revisi label teruji"])), groups: {} },
    revision: 1,
  };
  const markdownPrefix = `${renderSemanticMarkdown(presentation)}\n---\n\n`;
  const markdownPrefixBytes = Buffer.byteLength(markdownPrefix, "utf8");
  const metrics: Record<string, unknown> = {
    canonicalDocumentBytes: Buffer.byteLength(document.json, "utf8"),
    markdownStatus: "NOT_RUN",
    markdownBytes: null,
    markdownBytesWritten: 0,
    markdownMaxBytes: MAX_MARKDOWN_EXPORT_BYTES,
    markdownPrefixBytes,
    markdownDocumentMaxBytes: Math.max(0, MAX_MARKDOWN_EXPORT_BYTES - markdownPrefixBytes),
    markdownLimitScope: "semantic-prefix-plus-document",
    markdownSha256: null,
    markdownFileCreated: false,
    markdownPartialFileRemoved: false,
    pdfStatus: "NOT_RUN",
    pdfBytes: null,
    pdfSha256: null,
  };

  console.log(JSON.stringify({ phase: "markdown-render", repository: spec.repository }));
  const markdownPath = join(output, `${slug}-semantic.md`);
  const markdownState: MarkdownWriteState = { fileCreated: false, bytesWritten: 0 };
  try {
    const markdownSha256 = await writeMarkdownChunks(markdownPath, markdownPrefix, document.value, markdownState);
    metrics.markdownStatus = "PASS";
    metrics.markdownBytes = markdownState.bytesWritten;
    metrics.markdownBytesWritten = markdownState.bytesWritten;
    metrics.markdownSha256 = markdownSha256;
  } catch (error) {
    if (markdownState.fileCreated) {
      try {
        await unlink(markdownPath);
        metrics.markdownPartialFileRemoved = true;
      } catch (cleanupError) {
        metrics.markdownCleanupError = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      }
    }
    metrics.markdownBytesWritten = markdownState.bytesWritten;
    if (error instanceof MarkdownExportTooLargeError) {
      failed = true;
      report.exportError = error.code;
      metrics.markdownStatus = error.code;
      metrics.markdownError = error.message;
      metrics.markdownDocumentMaxBytes = error.maxBytes;
    } else {
      failed = true;
      report.exportError = error instanceof Error ? error.message : String(error);
      metrics.markdownStatus = "FAIL";
      metrics.markdownError = report.exportError;
    }
  }
  metrics.markdownFileCreated = markdownState.fileCreated;

  console.log(JSON.stringify({ phase: "pdf-render", repository: spec.repository }));
  const pdfStarted = performance.now();
  try {
    const pdf = await renderPdfDocument(document.value, { semantic: presentation });
    await writeFile(join(output, `${slug}-semantic.pdf`), pdf, { flag: "wx", mode: 0o600 });
    metrics.pdfBytes = pdf.byteLength;
    metrics.pdfSha256 = createHash("sha256").update(pdf).digest("hex");
    metrics.pdfStatus = "PASS";
  } catch (error) {
    failed = true;
    metrics.pdfStatus = "FAIL";
    metrics.pdfError = error instanceof Error ? error.message : String(error);
    report.exportError ??= metrics.pdfError;
  }
  metrics.pdfMs = performance.now() - pdfStarted;
  report.exportMetrics = metrics;
} catch (error) {
  failed = true;
  report.exportError = error instanceof Error ? error.message : String(error);
}

let peak: number | null = null;
try {
  peak = Number((await readFile("/sys/fs/cgroup/memory.peak", "utf8")).trim());
} catch {}
report.exportProcess = {
  runtime: { node: process.version, platform: process.platform, architecture: process.arch },
  elapsedMs: performance.now() - started,
  processPeakRssBytes: process.resourceUsage().maxRSS * 1024,
  containerPeakChargedBytes: peak,
};
report.status = report.sourceStatus !== "PASS" ? report.sourceStatus : failed ? "FAIL_EXPORT" : "PASS";
await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report));
if (failed) process.exitCode = 1;
