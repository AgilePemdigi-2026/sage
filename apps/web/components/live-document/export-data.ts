export type ExportFormat = "MARKDOWN" | "PDF";
export type ExportStatus = "QUEUED" | "GENERATING" | "READY" | "FAILED";
export type MarkdownExportStatus = ExportStatus;

export type ExportRecord<F extends ExportFormat = ExportFormat> = {
  id: string;
  format: F;
  status: ExportStatus;
  documentHash: string;
  rendererVersion: string;
  contentHash: string | null;
  errorCode: string | null;
};

export type ExportPayload<F extends ExportFormat = ExportFormat> = {
  analysisId: string;
  accountKey: string;
  export: ExportRecord<F>;
};

export type ExportExpectation = {
  analysisId: string;
  accountKey: string;
  documentHash: string;
  exportId?: string;
  /** Defaults to MARKDOWN for callers using the original export contract. */
  format?: ExportFormat;
};

export type MarkdownExportRecord = ExportRecord<"MARKDOWN">;
export type MarkdownExportPayload = ExportPayload<"MARKDOWN">;
export type MarkdownExportExpectation = Omit<ExportExpectation, "format"> & { format?: "MARKDOWN" };

export class ExportBindingError extends Error {
  constructor() {
    super("Ekspor tidak terikat pada analisis, akun, atau snapshot yang sedang ditampilkan.");
    this.name = "ExportBindingError";
  }
}

export class MarkdownExportBindingError extends ExportBindingError {
  constructor() {
    super();
    this.name = "MarkdownExportBindingError";
  }
}

export class ExportPayloadError extends Error {
  constructor(format: ExportFormat = "MARKDOWN") {
    super(`Respons ekspor ${format === "PDF" ? "PDF" : "Markdown"} tidak valid.`);
    this.name = "ExportPayloadError";
  }
}

export class MarkdownExportPayloadError extends ExportPayloadError {
  constructor() {
    super("MARKDOWN");
    this.name = "MarkdownExportPayloadError";
  }
}

function bindingError(format: ExportFormat): ExportBindingError {
  return format === "MARKDOWN" ? new MarkdownExportBindingError() : new ExportBindingError();
}

function payloadError(format: ExportFormat): ExportPayloadError {
  return format === "MARKDOWN" ? new MarkdownExportPayloadError() : new ExportPayloadError("PDF");
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512;
}

function nullableText(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function sha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

/** Validate the API envelope and bind every result to the active canonical snapshot and format. */
export function parseExportPayload(value: unknown, expected: ExportExpectation): ExportPayload {
  const format = expected.format ?? "MARKDOWN";
  if (!record(value) || !record(value.export)) throw payloadError(format);

  if (value.analysisId !== expected.analysisId || value.accountKey !== expected.accountKey ||
      value.export.documentHash !== expected.documentHash ||
      (expected.exportId !== undefined && value.export.id !== expected.exportId)) {
    throw bindingError(format);
  }

  const exported = value.export;
  if (!nonEmptyText(value.analysisId) || !nonEmptyText(value.accountKey) || !nonEmptyText(exported.id) ||
      exported.format !== format || !["QUEUED", "GENERATING", "READY", "FAILED"].includes(String(exported.status)) ||
      !sha256(exported.documentHash) || !nonEmptyText(exported.rendererVersion) ||
      !(exported.contentHash === null || sha256(exported.contentHash)) ||
      (exported.status === "READY" && !sha256(exported.contentHash)) ||
      !nullableText(exported.errorCode)) {
    throw payloadError(format);
  }

  return value as unknown as ExportPayload;
}

/** Validate a Markdown response while retaining the original public parser API. */
export function parseMarkdownExportPayload(value: unknown, expected: MarkdownExportExpectation): MarkdownExportPayload {
  return parseExportPayload(value, { ...expected, format: "MARKDOWN" }) as MarkdownExportPayload;
}

function basename(value: string): string {
  return value.replace(/^.*[\\/]/, "");
}

function safeFilename(value: string, format: ExportFormat): string | null {
  const extension = format === "PDF" ? ".pdf" : ".md";
  const cleaned = basename(value)
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[<>:"|?*]/g, "_")
    .replace(/\.{2,}/g, ".")
    .trim()
    .replace(/[. ]+$/g, "");
  if (!cleaned || cleaned === "." || cleaned === "..") return null;
  const stem = cleaned.replace(/\.(?:md|pdf)$/i, "").replace(/[. ]+$/g, "");
  if (!stem) return null;
  return `${stem}${extension}`;
}

/** Parse a download filename defensively and always return the requested local extension. */
export function exportDownloadFilename(
  contentDisposition: string | null,
  analysisId: string,
  format: ExportFormat,
): string {
  let candidate: string | null = null;
  if (contentDisposition) {
    const extended = /(?:^|;)\s*filename\*\s*=\s*UTF-8''([^;]+)/i.exec(contentDisposition);
    if (extended?.[1]) {
      try { candidate = decodeURIComponent(extended[1].replace(/^"|"$/g, "")); } catch { /* Use plain filename or fallback. */ }
    }
    if (!candidate) {
      const plain = /(?:^|;)\s*filename\s*=\s*(?:"([^"]*)"|([^;\s]*))/i.exec(contentDisposition);
      candidate = plain?.[1] ?? plain?.[2] ?? null;
    }
  }
  const extension = format === "PDF" ? ".pdf" : ".md";
  const fallback = `architecture-${analysisId}${extension}`;
  return (candidate && safeFilename(candidate, format)) || safeFilename(fallback, format) || `architecture-document${extension}`;
}

/** Keep the previous Markdown filename helper available to existing callers. */
export function markdownDownloadFilename(contentDisposition: string | null, analysisId: string): string {
  return exportDownloadFilename(contentDisposition, analysisId, "MARKDOWN");
}
