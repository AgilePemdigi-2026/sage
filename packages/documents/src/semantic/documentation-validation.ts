import type {
  DocumentationBlock,
  DocumentationContext,
  DocumentationDocument,
  DocumentationEvidence,
  DocumentationInlineCode,
  DocumentationKind,
  DocumentationListItem,
  DocumentationReference,
  DocumentationReferenceResolution,
  DocumentationSection,
  DocumentationSkipReason,
  DocumentationTableRow,
} from "./documentation.ts";

const MAX_FILES = 100;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_TOTAL_BYTES = 4 * 1024 * 1024;
const MAX_AST_NODES_PER_FILE = 20_000;
const MAX_REFERENCES = MAX_FILES * MAX_AST_NODES_PER_FILE;
const MAX_DOCUMENT_PATH_LENGTH = 4096;
const MAX_SKIPPED_PATH_LENGTH = 65_536;
const MAX_REFERENCE_TARGET_LENGTH = 32_768;
const MAX_CODE_LANGUAGE_LENGTH = 128;
const DOCUMENT_KINDS = new Set<DocumentationKind>(["root-readme", "package-readme", "architecture-adr", "docs"]);
const REFERENCE_RESOLUTIONS = new Set<DocumentationReferenceResolution>(["resolved", "directory", "missing", "external", "anchor", "unsafe"]);
const SKIP_REASONS = new Set<DocumentationSkipReason>([
  "excluded", "unsafe-path", "source-unavailable", "too-large", "aggregate-byte-limit", "file-count-limit",
  "binary", "invalid-utf8", "node-limit", "representation-limit", "parse-error",
]);
const SHA256 = /^[a-f0-9]{64}$/;

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return false;
  }
  return true;
}

function isDenseArray(value: unknown): value is unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || Object.getOwnPropertySymbols(value).length > 0) return false;
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (!lengthDescriptor || lengthDescriptor.enumerable || !("value" in lengthDescriptor)) return false;
  const names = Object.getOwnPropertyNames(value);
  if (names.length !== value.length + 1 || !names.includes("length")) return false;
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return false;
  }
  return true;
}

function hasExactKeys(value: UnknownRecord, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isSafePath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096) return false;
  if (value.startsWith("/") || value.includes("\\") || value.includes("\0") || /^[A-Za-z]:/.test(value)) return false;
  const parts = value.split("/");
  return parts.every((part) => part.length > 0 && part !== "." && part !== ".." && !/[\u0000-\u001f\u007f]/.test(part));
}

function isInteger(value: unknown, minimum: number, maximum = Number.MAX_SAFE_INTEGER): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum;
}

function isEvidence(value: unknown, document: DocumentationDocument, role: "context" | "reference"): value is DocumentationEvidence {
  if (!isRecord(value) || !hasExactKeys(value, [
    "filePath", "fileSha256", "startByte", "endByte", "startLine", "endLine", "startColumn", "endColumn", "role",
  ])) return false;
  return value.filePath === document.filePath
    && value.fileSha256 === document.fileSha256
    && value.role === role
    && isInteger(value.startByte, 0, document.byteLength)
    && isInteger(value.endByte, value.startByte as number, document.byteLength)
    && isInteger(value.startLine, 1)
    && isInteger(value.endLine, value.startLine as number)
    && isInteger(value.startColumn, 1)
    && isInteger(value.endColumn, 1);
}

function isInlineCode(value: unknown, document: DocumentationDocument): value is DocumentationInlineCode {
  return isRecord(value)
    && hasExactKeys(value, ["text", "evidence"])
    && typeof value.text === "string"
    && value.text.length <= MAX_FILE_BYTES
    && isEvidence(value.evidence, document, "context");
}

function isListItem(value: unknown, document: DocumentationDocument): value is DocumentationListItem {
  return isRecord(value)
    && hasExactKeys(value, ["depth", "text", "checked", "evidence", "inlineCode"])
    && isInteger(value.depth, 0, 256)
    && typeof value.text === "string"
    && value.text.length <= MAX_FILE_BYTES
    && (value.checked === null || typeof value.checked === "boolean")
    && isEvidence(value.evidence, document, "context")
    && isDenseArray(value.inlineCode)
    && value.inlineCode.length <= MAX_AST_NODES_PER_FILE
    && value.inlineCode.every((entry) => isInlineCode(entry, document));
}

function isTableRow(value: unknown, document: DocumentationDocument): value is DocumentationTableRow {
  return isRecord(value)
    && hasExactKeys(value, ["cells", "header", "evidence"])
    && isDenseArray(value.cells)
    && value.cells.length <= MAX_FILE_BYTES
    && value.cells.every((cell) => typeof cell === "string" && cell.length <= MAX_FILE_BYTES)
    && typeof value.header === "boolean"
    && isEvidence(value.evidence, document, "context");
}

function isBlock(value: unknown, document: DocumentationDocument): value is DocumentationBlock {
  if (!isRecord(value) || typeof value.kind !== "string") return false;
  if (value.kind === "paragraph" || value.kind === "blockquote") {
    return hasExactKeys(value, ["kind", "text", "evidence", "inlineCode"])
      && typeof value.text === "string"
      && value.text.length <= MAX_FILE_BYTES
      && isEvidence(value.evidence, document, "context")
      && isDenseArray(value.inlineCode)
      && value.inlineCode.length <= MAX_AST_NODES_PER_FILE
      && value.inlineCode.every((entry) => isInlineCode(entry, document));
  }
  if (value.kind === "list") {
    return hasExactKeys(value, ["kind", "ordered", "items", "evidence"])
      && typeof value.ordered === "boolean"
      && isDenseArray(value.items)
      && value.items.length <= MAX_AST_NODES_PER_FILE
      && value.items.every((item) => isListItem(item, document))
      && isEvidence(value.evidence, document, "context");
  }
  if (value.kind === "table") {
    return hasExactKeys(value, ["kind", "rows", "evidence", "inlineCode"])
      && isDenseArray(value.rows)
      && value.rows.length <= MAX_AST_NODES_PER_FILE
      && value.rows.every((row) => isTableRow(row, document))
      && isEvidence(value.evidence, document, "context")
      && isDenseArray(value.inlineCode)
      && value.inlineCode.length <= MAX_AST_NODES_PER_FILE
      && value.inlineCode.every((entry) => isInlineCode(entry, document));
  }
  if (value.kind === "example") {
    return hasExactKeys(value, ["kind", "text", "language", "evidence"])
      && typeof value.text === "string"
      && value.text.length <= MAX_FILE_BYTES
      && (value.language === null || (typeof value.language === "string" && value.language.length <= MAX_CODE_LANGUAGE_LENGTH))
      && isEvidence(value.evidence, document, "context");
  }
  return false;
}

function isSection(value: unknown, document: DocumentationDocument): value is DocumentationSection {
  return isRecord(value)
    && hasExactKeys(value, ["heading", "depth", "evidence", "inlineCode", "blocks"])
    && (value.heading === null || (typeof value.heading === "string" && value.heading.length <= MAX_FILE_BYTES))
    && isInteger(value.depth, 0, 6)
    && (value.evidence === null || isEvidence(value.evidence, document, "context"))
    && isDenseArray(value.inlineCode)
    && value.inlineCode.length <= MAX_AST_NODES_PER_FILE
    && value.inlineCode.every((entry) => isInlineCode(entry, document))
    && isDenseArray(value.blocks)
    && value.blocks.length <= MAX_AST_NODES_PER_FILE
    && value.blocks.every((block) => isBlock(block, document));
}

function isDocument(value: unknown, fileHashes?: ReadonlyMap<string, string>): value is DocumentationDocument {
  if (!isRecord(value) || !hasExactKeys(value, ["filePath", "kind", "fileSha256", "byteLength", "title", "sections"])) return false;
  if (!isSafePath(value.filePath) || value.filePath.length > MAX_DOCUMENT_PATH_LENGTH || typeof value.kind !== "string" || !DOCUMENT_KINDS.has(value.kind as DocumentationKind)) return false;
  if (typeof value.fileSha256 !== "string" || !SHA256.test(value.fileSha256)) return false;
  if (fileHashes && fileHashes.get(value.filePath) !== value.fileSha256) return false;
  if (!isInteger(value.byteLength, 0, MAX_FILE_BYTES)) return false;
  if (value.title !== null && (typeof value.title !== "string" || value.title.length > MAX_FILE_BYTES)) return false;
  const document = value as unknown as DocumentationDocument;
  return isDenseArray(value.sections)
    && value.sections.length <= MAX_AST_NODES_PER_FILE
    && value.sections.every((section) => isSection(section, document));
}

function isReference(value: unknown, documents: ReadonlyMap<string, DocumentationDocument>, fileHashes?: ReadonlyMap<string, string>): value is DocumentationReference {
  if (!isRecord(value) || !hasExactKeys(value, ["sourcePath", "target", "targetPath", "resolution", "evidence"])) return false;
  if (typeof value.sourcePath !== "string" || typeof value.target !== "string" || value.target.length > MAX_REFERENCE_TARGET_LENGTH) return false;
  if (typeof value.resolution !== "string" || !REFERENCE_RESOLUTIONS.has(value.resolution as DocumentationReferenceResolution)) return false;
  const source = documents.get(value.sourcePath);
  if (!source || !isEvidence(value.evidence, source, "reference")) return false;
  if (value.resolution === "external" || value.resolution === "unsafe") return value.targetPath === null;
  if (value.resolution === "missing" && value.targetPath === null) return value.target.length > 0;
  if (!isSafePath(value.targetPath)) return false;
  if (value.resolution === "anchor") return value.targetPath === value.sourcePath;
  if (value.resolution === "resolved") {
    return fileHashes ? fileHashes.has(value.targetPath) : true;
  }
  if (value.resolution === "directory") {
    if (!fileHashes) return true;
    const prefix = `${value.targetPath}/`;
    for (const path of fileHashes.keys()) if (path.startsWith(prefix)) return true;
    return false;
  }
  if (value.resolution === "missing") {
    if (!fileHashes) return true;
    if (fileHashes.has(value.targetPath)) return false;
    const prefix = `${value.targetPath}/`;
    for (const path of fileHashes.keys()) if (path.startsWith(prefix)) return false;
    return true;
  }
  return false;
}

function isCoverage(value: unknown, context: Omit<DocumentationContext, "coverage">): boolean {
  if (!isRecord(value) || !hasExactKeys(value, ["snapshotPathCount", "candidateFileCount", "documentCount", "documentByteCount", "skipped"])) return false;
  if (!isInteger(value.snapshotPathCount, 0) || !isInteger(value.candidateFileCount, 0, value.snapshotPathCount as number)) return false;
  if (!isInteger(value.documentCount, 0, MAX_FILES) || value.documentCount !== context.documents.length) return false;
  if (!isInteger(value.documentByteCount, 0, MAX_TOTAL_BYTES)) return false;
  const summedBytes = context.documents.reduce((sum, document) => sum + document.byteLength, 0);
  if ((value.documentByteCount as number) < summedBytes) return false;
  if (!isDenseArray(value.skipped) || value.skipped.length > (value.candidateFileCount as number)) return false;
  const paths = new Set<string>();
  for (const skipped of value.skipped) {
    if (!isRecord(skipped) || !hasExactKeys(skipped, ["filePath", "reason"])) return false;
    if (typeof skipped.filePath !== "string" || skipped.filePath.length === 0 || skipped.filePath.length > MAX_SKIPPED_PATH_LENGTH) return false;
    if (typeof skipped.reason !== "string" || !SKIP_REASONS.has(skipped.reason as DocumentationSkipReason)) return false;
    if (paths.has(skipped.filePath)) return false;
    paths.add(skipped.filePath);
  }
  return value.candidateFileCount === context.documents.length + value.skipped.length;
}

/** Validate the bounded, source-backed documentation sidecar without importing parser runtime code. */
export function isDocumentationContext(value: unknown, fileHashes?: ReadonlyMap<string, string>): value is DocumentationContext {
  try {
    if (!isRecord(value) || !hasExactKeys(value, ["documents", "references", "coverage"])) return false;
    if (!isDenseArray(value.documents) || value.documents.length > MAX_FILES) return false;
    const documents = new Map<string, DocumentationDocument>();
    let totalBytes = 0;
    for (const candidate of value.documents) {
      if (!isDocument(candidate, fileHashes)) return false;
      const document = candidate as DocumentationDocument;
      if (documents.has(document.filePath)) return false;
      documents.set(document.filePath, document);
      totalBytes += document.byteLength;
      if (totalBytes > MAX_TOTAL_BYTES) return false;
    }
    if (!isDenseArray(value.references) || value.references.length > MAX_REFERENCES) return false;
    if (!value.references.every((reference) => isReference(reference, documents, fileHashes))) return false;
    const partial = { documents: value.documents as DocumentationDocument[], references: value.references as DocumentationReference[] };
    return isCoverage(value.coverage, partial);
  } catch {
    return false;
  }
}
