import assert from "node:assert/strict";
import test from "node:test";
import {
  MarkdownExportBindingError,
  MarkdownExportPayloadError,
  markdownDownloadFilename,
  parseMarkdownExportPayload,
} from "../apps/web/components/live-document/export-data.ts";

const expected = {
  analysisId: "analysis_export_123",
  accountKey: "github-export-user",
  documentHash: "a".repeat(64),
};

function payload(status: "QUEUED" | "GENERATING" | "READY" | "FAILED" = "QUEUED") {
  return {
    analysisId: expected.analysisId,
    accountKey: expected.accountKey,
    export: {
      id: "export_123",
      format: "MARKDOWN",
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
