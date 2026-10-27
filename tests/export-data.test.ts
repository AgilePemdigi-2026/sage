import assert from "node:assert/strict";
import test from "node:test";
import {
  ExportPayloadError,
  MarkdownExportBindingError,
  MarkdownExportPayloadError,
  exportDownloadFilename,
  markdownDownloadFilename,
  parseExportPayload,
  parseMarkdownExportPayload,
} from "../apps/web/components/live-document/export-data.ts";

const expected = {
  analysisId: "analysis_export_123",
  accountKey: "github-export-user",
  documentHash: "a".repeat(64),
};

function payload(
  status: "QUEUED" | "GENERATING" | "READY" | "FAILED" = "QUEUED",
  format: "MARKDOWN" | "PDF" = "MARKDOWN",
) {
  return {
    analysisId: expected.analysisId,
    accountKey: expected.accountKey,
    export: {
      id: "export_123",
      format,
      status,
      documentHash: expected.documentHash,
      rendererVersion: "1.0.0",
      contentHash: status === "READY" ? "b".repeat(64) : null,
      errorCode: status === "FAILED" ? "RENDER_FAILED" : null,
    },
  };
}

test("Markdown export responses bind the account, analysis, snapshot, and requested export", () => {
  assert.equal(parseMarkdownExportPayload(payload(), expected).export.status, "QUEUED");
  assert.equal(parseMarkdownExportPayload(payload("READY"), { ...expected, exportId: "export_123" }).export.contentHash, "b".repeat(64));
  assert.throws(() => parseMarkdownExportPayload(payload(), { ...expected, analysisId: "analysis_other" }), MarkdownExportBindingError);
  assert.throws(() => parseMarkdownExportPayload(payload(), { ...expected, accountKey: "github_other" }), MarkdownExportBindingError);
  assert.throws(() => parseMarkdownExportPayload(payload(), { ...expected, documentHash: "c".repeat(64) }), MarkdownExportBindingError);
  assert.throws(() => parseMarkdownExportPayload(payload(), { ...expected, exportId: "export_other" }), MarkdownExportBindingError);
});

test("generic export parser requires the expected format and defaults legacy calls to Markdown", () => {
  assert.equal(parseExportPayload(payload(), expected).export.format, "MARKDOWN");
  assert.equal(parseExportPayload(payload("READY", "PDF"), { ...expected, format: "PDF" }).export.format, "PDF");
  assert.throws(() => parseExportPayload(payload(), { ...expected, format: "PDF" }), ExportPayloadError);
  assert.throws(() => parseExportPayload(payload("READY", "PDF"), { ...expected, format: "MARKDOWN" }), MarkdownExportPayloadError);
  assert.throws(() => parseExportPayload({
    ...payload("READY", "PDF"), export: { ...payload("READY", "PDF").export, contentHash: null },
  }, { ...expected, format: "PDF" }), ExportPayloadError);
});

test("Markdown export parser rejects incomplete or malformed export metadata", () => {
  assert.throws(() => parseMarkdownExportPayload(null, expected), MarkdownExportPayloadError);
  assert.throws(() => parseMarkdownExportPayload({
    ...payload(), export: { ...payload().export, format: "PDF" },
  }, expected), MarkdownExportPayloadError);
  assert.throws(() => parseMarkdownExportPayload({
    ...payload("READY"), export: { ...payload("READY").export, contentHash: "not-a-hash" },
  }, expected), MarkdownExportPayloadError);
  assert.throws(() => parseMarkdownExportPayload({
    ...payload("READY"), export: { ...payload("READY").export, contentHash: null },
  }, expected), MarkdownExportPayloadError);
});

test("download filenames are reduced to safe Markdown basenames", () => {
  assert.equal(markdownDownloadFilename("attachment; filename*=UTF-8''Architecture%20Overview.md", expected.analysisId), "Architecture Overview.md");
  assert.equal(markdownDownloadFilename('attachment; filename="../../secret?.txt"', expected.analysisId), "secret_.txt.md");
  assert.equal(markdownDownloadFilename('attachment; filename="../"', expected.analysisId), `architecture-${expected.analysisId}.md`);
  assert.equal(markdownDownloadFilename(null, expected.analysisId), `architecture-${expected.analysisId}.md`);
});

test("PDF download filenames keep a safe basename and always end in .pdf", () => {
  assert.equal(exportDownloadFilename("attachment; filename*=UTF-8''Architecture%20Overview.pdf", expected.analysisId, "PDF"), "Architecture Overview.pdf");
  assert.equal(exportDownloadFilename('attachment; filename="../../secret?.txt"', expected.analysisId, "PDF"), "secret_.txt.pdf");
  assert.equal(exportDownloadFilename("attachment; filename*=UTF-8''..%2F..%2Funsafe%3F.pdf", expected.analysisId, "PDF"), "unsafe_.pdf");
  assert.equal(exportDownloadFilename('attachment; filename="C:\\Temp\\report.exe"', expected.analysisId, "PDF"), "report.exe.pdf");
  assert.equal(exportDownloadFilename('attachment; filename="../"', expected.analysisId, "PDF"), `architecture-${expected.analysisId}.pdf`);
  assert.equal(exportDownloadFilename(null, expected.analysisId, "PDF"), `architecture-${expected.analysisId}.pdf`);
});
