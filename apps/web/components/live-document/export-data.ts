export type MarkdownExportStatus = "QUEUED" | "GENERATING" | "READY" | "FAILED";

export type MarkdownExportRecord = {
  id: string;
  format: "MARKDOWN";
  status: MarkdownExportStatus;
  documentHash: string;
  rendererVersion: string;
  contentHash: string | null;
  errorCode: string | null;
};

export type MarkdownExportPayload = {
  analysisId: string;
  accountKey: string;
  export: MarkdownExportRecord;
};

export type MarkdownExportExpectation = {
  analysisId: string;
  accountKey: string;
  documentHash: string;
  exportId?: string;
};

export class MarkdownExportBindingError extends Error {
  constructor() {
    super("Ekspor tidak terikat pada analisis, akun, atau snapshot yang sedang ditampilkan.");
    this.name = "MarkdownExportBindingError";
  }
}

export class MarkdownExportPayloadError extends Error {
  constructor() {
    super("Respons ekspor Markdown tidak valid.");
    this.name = "MarkdownExportPayloadError";
  }
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

/** Validate the API envelope and bind every result to the active canonical snapshot. */
export function parseMarkdownExportPayload(value: unknown, expected: MarkdownExportExpectation): MarkdownExportPayload {
  if (!record(value) || !record(value.export)) throw new MarkdownExportPayloadError();

  if (value.analysisId !== expected.analysisId || value.accountKey !== expected.accountKey ||
      value.export.documentHash !== expected.documentHash ||
      (expected.exportId !== undefined && value.export.id !== expected.exportId)) {
    throw new MarkdownExportBindingError();
  }

  const exported = value.export;
  if (!nonEmptyText(value.analysisId) || !nonEmptyText(value.accountKey) || !nonEmptyText(exported.id) ||
      exported.format !== "MARKDOWN" || !["QUEUED", "GENERATING", "READY", "FAILED"].includes(String(exported.status)) ||
      !sha256(exported.documentHash) || !nonEmptyText(exported.rendererVersion) ||
      !(exported.contentHash === null || sha256(exported.contentHash)) ||
      !nullableText(exported.errorCode)) {
    throw new MarkdownExportPayloadError();
  }

  return value as unknown as MarkdownExportPayload;
}

function basename(value: string): string {
  return value.replace(/^.*[\\/]/, "");
}

function safeFilename(value: string): string | null {
  const cleaned = basename(value)
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[<>:"|?*]/g, "_")
    .replace(/\.{2,}/g, ".")
    .trim()
    .replace(/[. ]+$/g, "");
  if (!cleaned || cleaned === "." || cleaned === "..") return null;
  const stem = cleaned.replace(/\.md$/i, "").replace(/[. ]+$/g, "");
  if (!stem) return null;
  return `${stem}.md`;
}

/** Parse a download filename defensively and always return a local .md filename. */
export function markdownDownloadFilename(contentDisposition: string | null, analysisId: string): string {
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
  return (candidate && safeFilename(candidate)) || safeFilename(`architecture-${analysisId}.md`) || "architecture-document.md";
}
