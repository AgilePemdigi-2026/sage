import { createHash } from "node:crypto";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import type { EvidenceSpan } from "@sage/contracts";

export type DocumentationKind = "root-readme" | "package-readme" | "architecture-adr" | "docs";
export type DocumentationReferenceResolution = "resolved" | "directory" | "missing" | "external" | "anchor" | "unsafe";
export type DocumentationSkipReason =
  | "excluded"
  | "unsafe-path"
  | "source-unavailable"
  | "too-large"
  | "aggregate-byte-limit"
  | "file-count-limit"
  | "binary"
  | "invalid-utf8"
  | "node-limit"
  | "representation-limit"
  | "parse-error";

export type DocumentationEvidence = EvidenceSpan;

export interface DocumentationInlineCode {
  text: string;
  evidence: DocumentationEvidence;
}

export interface DocumentationParagraphBlock {
  kind: "paragraph" | "blockquote";
  text: string;
  evidence: DocumentationEvidence;
  inlineCode: DocumentationInlineCode[];
}

export interface DocumentationListItem {
  depth: number;
  text: string;
  checked: boolean | null;
  evidence: DocumentationEvidence;
  inlineCode: DocumentationInlineCode[];
}

export interface DocumentationListBlock {
  kind: "list";
  ordered: boolean;
  items: DocumentationListItem[];
  evidence: DocumentationEvidence;
}

export interface DocumentationTableRow {
  cells: string[];
  header: boolean;
  evidence: DocumentationEvidence;
}

export interface DocumentationTableBlock {
  kind: "table";
  rows: DocumentationTableRow[];
  evidence: DocumentationEvidence;
  inlineCode: DocumentationInlineCode[];
}

export interface DocumentationExampleBlock {
  kind: "example";
  text: string;
  language: string | null;
  evidence: DocumentationEvidence;
}

export type DocumentationBlock =
  | DocumentationParagraphBlock
  | DocumentationListBlock
  | DocumentationTableBlock
  | DocumentationExampleBlock;

export interface DocumentationSection {
  heading: string | null;
  depth: number;
  evidence: DocumentationEvidence | null;
  inlineCode: DocumentationInlineCode[];
  blocks: DocumentationBlock[];
}

export interface DocumentationDocument {
  filePath: string;
  kind: DocumentationKind;
  fileSha256: string;
  byteLength: number;
  title: string | null;
  sections: DocumentationSection[];
}

export interface DocumentationReference {
  sourcePath: string;
  target: string;
  targetPath: string | null;
  resolution: DocumentationReferenceResolution;
  evidence: DocumentationEvidence;
}

export interface DocumentationSkippedFile {
  filePath: string;
  reason: DocumentationSkipReason;
}

export interface DocumentationCoverage {
  snapshotPathCount: number;
  candidateFileCount: number;
  documentCount: number;
  /** Bytes admitted to the documentation parser, including whole files later skipped for content errors. */
  documentByteCount: number;
  skipped: DocumentationSkippedFile[];
}

export interface DocumentationContext {
  documents: DocumentationDocument[];
  references: DocumentationReference[];
  coverage: DocumentationCoverage;
}

export interface AnalyzeDocumentationInput {
  sources: Readonly<Record<string, Uint8Array>>;
  snapshotPaths: readonly string[];
}

export const DOCUMENTATION_LIMITS = Object.freeze({
  maxFiles: 100,
  maxFileBytes: 256 * 1024,
  maxTotalBytes: 4 * 1024 * 1024,
  maxAstNodesPerFile: 20_000,
});

const MAX_DOCUMENT_PATH_LENGTH = 4096;
const MAX_REFERENCE_TARGET_LENGTH = 32768;
const MAX_CODE_LANGUAGE_LENGTH = 128;

const MARKDOWN_EXTENSION = /\.(?:md|markdown|mdx)$/i;
const README_FILENAME = /^readme\.(?:md|markdown|mdx)$/i;
const EXCLUDED_DIRECTORY_NAMES = new Set([
  ".git", ".next", ".turbo", ".cache", "node_modules", "bower_components", "dependency", "dependencies", "deps",
  "vendor", "vendors", "third_party", "third-party", "build", "dist", "out", "coverage", "generated", "target", "tmp",
]);
const PATH_LIKE_EXTENSIONS = new Set([
  "astro", "bash", "c", "cc", "cfg", "conf", "cpp", "cjs", "css", "csv", "cts", "dockerfile", "env",
  "gql", "go", "graphql", "h", "html", "ini", "java", "js", "json", "jsonc", "jsx", "kt", "less",
  "lock", "markdown", "md", "mdx", "mjs", "mts", "php", "py", "rb", "rs", "sass", "scss", "sh",
  "sql", "svelte", "swift", "toml", "ts", "tsx", "txt", "vue", "xml", "yaml", "yml", "zsh",
]);
const PRIORITY: Record<DocumentationKind, number> = {
  "root-readme": 0,
  "package-readme": 1,
  "architecture-adr": 2,
  docs: 3,
};

interface FileCandidate {
  filePath: string;
  originalPath: string;
  kind: DocumentationKind;
  excluded: boolean;
}

interface MdPosition {
  line: number;
  column: number;
  offset?: number;
}

interface MdNode {
  type: string;
  value?: string;
  url?: string;
  identifier?: string;
  lang?: string | null;
  ordered?: boolean | null;
  checked?: boolean | null;
  children?: MdNode[];
  position?: { start: MdPosition; end: MdPosition };
}

interface ParsedFile {
  document: DocumentationDocument;
  references: DocumentationReference[];
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeSnapshotPath(path: string): string | null {
  if (!path || path.includes("\0") || path.includes("\\") || path.startsWith("/") || /^[A-Za-z]:/.test(path)) return null;
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!parts.length) return null;
      parts.pop();
      continue;
    }
    if (/[\u0000-\u001f\u007f]/.test(part)) return null;
    parts.push(part);
  }
  return parts.length ? parts.join("/") : null;
}

function hasExcludedDirectory(filePath: string): boolean {
  return filePath.split("/").some((part) => EXCLUDED_DIRECTORY_NAMES.has(part.toLowerCase()));
}

function markdownCandidateKind(filePath: string, packageDirectories: ReadonlySet<string>): DocumentationKind | null {
  const parts = filePath.split("/");
  const basename = parts.at(-1) ?? "";
  if (!MARKDOWN_EXTENSION.test(basename)) return null;
  const parent = parts.slice(0, -1).join("/");
  if (parent === "" && README_FILENAME.test(basename)) return "root-readme";
  if (README_FILENAME.test(basename) && packageDirectories.has(parent)) return "package-readme";
  if (parts.slice(0, -1).some((part) => part.toLowerCase() === "adr" || part.toLowerCase() === "adrs")) {
    return "architecture-adr";
  }
  if (parts.slice(0, -1).some((part) => part.toLowerCase() === "docs")) return "docs";
  return null;
}

function sourceHas(sources: Readonly<Record<string, Uint8Array>>, path: string): boolean {
  return Object.prototype.hasOwnProperty.call(sources, path);
}

function pathLooksLikeDocumentation(path: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  const parts = normalized.split("/");
  const basename = parts.at(-1) ?? "";
  return MARKDOWN_EXTENSION.test(basename)
    && (README_FILENAME.test(basename) || parts.some((part) => ["docs", "adr", "adrs"].includes(part.toLowerCase())));
}

function bytesHash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    const current = text.charCodeAt(index);
    if (current === 13) {
      if (text.charCodeAt(index + 1) === 10) index += 1;
      starts.push(index + 1);
    } else if (current === 10) {
      starts.push(index + 1);
    }
  }
  return starts;
}

function makeEvidence(
  node: MdNode,
  filePath: string,
  fileSha256: string,
  text: string,
  starts: readonly number[],
  role: DocumentationEvidence["role"],
): DocumentationEvidence | null {
  const start = node.position?.start;
  const end = node.position?.end;
  if (!start || !end || start.offset === undefined || end.offset === undefined) return null;
  const startOffset = Math.max(0, Math.min(text.length, start.offset));
  const endOffset = Math.max(startOffset, Math.min(text.length, end.offset));
  const startLineOffset = starts[start.line - 1] ?? 0;
  const endLineOffset = starts[end.line - 1] ?? 0;
  return {
    filePath,
    fileSha256,
    startByte: Buffer.byteLength(text.slice(0, startOffset), "utf8"),
    endByte: Buffer.byteLength(text.slice(0, endOffset), "utf8"),
    startLine: start.line,
    endLine: end.line,
    startColumn: Array.from(text.slice(startLineOffset, startOffset)).length + 1,
    endColumn: Array.from(text.slice(endLineOffset, endOffset)).length + 1,
    role,
  };
}

function childNodes(node: MdNode): MdNode[] {
  return Array.isArray(node.children) ? node.children : [];
}

function plainText(node: MdNode): string {
  if (node.type === "html") return "";
  if (node.type === "text" || node.type === "inlineCode" || node.type === "code") return node.value ?? "";
  if (node.type === "image" || node.type === "imageReference") return (node as MdNode & { alt?: string | null }).alt ?? "";
  if (node.type === "break") return "\n";
  return childNodes(node).map(plainText).join("");
}

function inlineCodeFor(
  node: MdNode,
  evidenceFor: (candidate: MdNode, role?: DocumentationEvidence["role"]) => DocumentationEvidence | null,
): DocumentationInlineCode[] {
  const result: DocumentationInlineCode[] = [];
  const stack = [node];
  while (stack.length) {
    const current = stack.pop()!;
    if (current.type === "inlineCode") {
      const evidence = evidenceFor(current, "context");
      if (evidence) result.push({ text: current.value ?? "", evidence });
    }
    const children = childNodes(current);
    for (let index = children.length - 1; index >= 0; index -= 1) stack.push(children[index]!);
  }
  return result;
}

function astIsWithinLimits(root: MdNode): boolean {
  const stack: Array<{ node: MdNode; depth: number }> = [{ node: root, depth: 0 }];
  let count = 0;
  while (stack.length) {
    const current = stack.pop()!;
    count += 1;
    if (count > DOCUMENTATION_LIMITS.maxAstNodesPerFile || current.depth > 256) return false;
    for (const child of childNodes(current.node)) stack.push({ node: child, depth: current.depth + 1 });
  }
  return true;
}

function resolveReference(
  target: string,
  sourcePath: string,
  snapshotPathSet: ReadonlySet<string>,
  snapshotDirectorySet: ReadonlySet<string>,
): Pick<DocumentationReference, "targetPath" | "resolution"> {
  if (/^[A-Za-z]:/.test(target)) return { targetPath: null, resolution: "unsafe" };
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(target)?.[1]?.toLowerCase();
  if (scheme) {
    if (["javascript", "data", "vbscript", "file", "blob", "about"].includes(scheme)) return { targetPath: null, resolution: "unsafe" };
    return { targetPath: null, resolution: "external" };
  }
  if (target.startsWith("//")) return { targetPath: null, resolution: "external" };
  if (target.startsWith("/") || target.startsWith("\\") || target.includes("\\")) return { targetPath: null, resolution: "unsafe" };

  const fragmentIndex = target.indexOf("#");
  const withoutFragment = fragmentIndex < 0 ? target : target.slice(0, fragmentIndex);
  const queryIndex = withoutFragment.indexOf("?");
  const rawPath = queryIndex < 0 ? withoutFragment : withoutFragment.slice(0, queryIndex);
  const hasFragment = fragmentIndex >= 0;
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(rawPath);
  } catch {
    return { targetPath: null, resolution: "unsafe" };
  }
  if (/[\u0000-\u001f\u007f]/.test(decodedPath)
    || decodedPath.includes("\\")
    || decodedPath.startsWith("/")
    || /^[A-Za-z]:/.test(decodedPath)
    || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(decodedPath)) return { targetPath: null, resolution: "unsafe" };
  if (!decodedPath) return { targetPath: sourcePath, resolution: "anchor" };

  const parent = sourcePath.split("/").slice(0, -1).join("/");
  const joined = parent ? `${parent}/${decodedPath}` : decodedPath;
  const targetPath = normalizeSnapshotPath(joined);
  if (!targetPath) return { targetPath: null, resolution: "unsafe" };
  if (!snapshotPathSet.has(targetPath)) {
    return snapshotDirectorySet.has(targetPath)
      ? { targetPath, resolution: "directory" }
      : { targetPath, resolution: "missing" };
  }
  if (hasFragment && targetPath === sourcePath) return { targetPath, resolution: "anchor" };
  return { targetPath, resolution: "resolved" };
}

function isPathLikeInlineCode(value: string): boolean {
  if (!value || !/^(?:\.{1,2}\/)?[\p{L}\p{N}_.@+-]+(?:\/[\p{L}\p{N}_.@+-]+)*(?:\/)?$/u.test(value)) return false;
  const hasSlash = value.includes("/");
  const basename = value.split("/").at(-1) ?? "";
  const extension = /\.([A-Za-z0-9]+)$/.exec(basename)?.[1]?.toLowerCase();
  return hasSlash || (extension !== undefined && PATH_LIKE_EXTENSIONS.has(extension));
}

function parseFile(
  filePath: string,
  kind: DocumentationKind,
  bytes: Uint8Array,
  snapshotPathSet: ReadonlySet<string>,
  snapshotDirectorySet: ReadonlySet<string>,
): ParsedFile | DocumentationSkipReason {
  if (bytes.byteLength > DOCUMENTATION_LIMITS.maxFileBytes) return "too-large";
  if (bytes.some((byte) => byte === 0)) return "binary";
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return "invalid-utf8";
  }
  const controlCount = (text.match(/[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/g) ?? []).length;
  if (controlCount > 8 && controlCount / Math.max(1, text.length) > 0.01) return "binary";

  let root: MdNode;
  try {
    root = fromMarkdown(text, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] }) as unknown as MdNode;
  } catch {
    return "parse-error";
  }
  if (!astIsWithinLimits(root)) return "node-limit";

  const fileSha256 = bytesHash(bytes);
  const starts = lineStarts(text);
  const evidenceFor = (node: MdNode, role: DocumentationEvidence["role"] = "context") =>
    makeEvidence(node, filePath, fileSha256, text, starts, role);
  const definitions = new Map<string, string>();
  const allNodes = [root];
  while (allNodes.length) {
    const node = allNodes.pop()!;
    if (node.type === "definition" && typeof node.identifier === "string" && typeof node.url === "string") {
      const identifier = node.identifier.toLowerCase();
      if (!definitions.has(identifier)) definitions.set(identifier, node.url);
    }
    const children = childNodes(node);
    for (let index = children.length - 1; index >= 0; index -= 1) allNodes.push(children[index]!);
  }

  const references: DocumentationReference[] = [];
  const stack = [root];
  while (stack.length) {
    const node = stack.pop()!;
    const target = node.type === "link" && typeof node.url === "string"
      ? node.url
      : node.type === "linkReference" && typeof node.identifier === "string"
        ? definitions.get(node.identifier.toLowerCase()) ?? null
        : null;
    if (node.type === "link" || node.type === "linkReference") {
      const evidence = evidenceFor(node, "reference");
      if (evidence) {
        const unresolvedIdentifier = node.type === "linkReference" && typeof node.identifier === "string";
        const referenceTarget = target ?? (unresolvedIdentifier ? node.identifier! : "");
        if (referenceTarget.length > MAX_REFERENCE_TARGET_LENGTH) return "representation-limit";
        const resolution = target === null
          ? { targetPath: null, resolution: "missing" as const }
          : resolveReference(target, filePath, snapshotPathSet, snapshotDirectorySet);
        if (resolution.targetPath !== null && resolution.targetPath.length > MAX_DOCUMENT_PATH_LENGTH) return "representation-limit";
        references.push({
          sourcePath: filePath,
          target: referenceTarget,
          ...resolution,
          evidence,
        });
      }
    }
    if (node.type === "inlineCode" && typeof node.value === "string" && isPathLikeInlineCode(node.value)) {
      if (node.value.length > MAX_REFERENCE_TARGET_LENGTH) return "representation-limit";
      const resolution = resolveReference(node.value, filePath, snapshotPathSet, snapshotDirectorySet);
      if (resolution.targetPath !== null && resolution.targetPath.length > MAX_DOCUMENT_PATH_LENGTH) return "representation-limit";
      const evidence = evidenceFor(node, "reference");
      if (evidence) {
        references.push({
          sourcePath: filePath,
          target: node.value,
          ...resolution,
          evidence,
        });
      }
    }
    const children = childNodes(node);
    for (let index = children.length - 1; index >= 0; index -= 1) stack.push(children[index]!);
  }

  const sections: DocumentationSection[] = [{ heading: null, depth: 0, evidence: null, inlineCode: [], blocks: [] }];
  let title: string | null = null;
  let currentSection = sections[0]!;
  const rootChildren = childNodes(root);
  for (const node of rootChildren) {
    if (node.type === "heading") {
      const heading = plainText(node).trim();
      const evidence = evidenceFor(node);
      currentSection = {
        heading,
        depth: Math.max(1, Math.min(6, Number((node as MdNode & { depth?: number }).depth) || 1)),
        evidence,
        inlineCode: inlineCodeFor(node, evidenceFor),
        blocks: [],
      };
      sections.push(currentSection);
      if (title === null && heading) title = heading;
      continue;
    }
    const evidence = evidenceFor(node);
    if (!evidence) continue;
    if (node.type === "paragraph") {
      currentSection.blocks.push({ kind: "paragraph", text: plainText(node), evidence, inlineCode: inlineCodeFor(node, evidenceFor) });
    } else if (node.type === "blockquote") {
      currentSection.blocks.push({ kind: "blockquote", text: plainText(node), evidence, inlineCode: inlineCodeFor(node, evidenceFor) });
    } else if (node.type === "code") {
      if ((node.lang?.length ?? 0) > MAX_CODE_LANGUAGE_LENGTH) return "representation-limit";
      currentSection.blocks.push({ kind: "example", text: node.value ?? "", language: node.lang ?? null, evidence });
    } else if (node.type === "list") {
      const items: DocumentationListItem[] = [];
      const collectItems = (list: MdNode, depth: number) => {
        for (const item of childNodes(list)) {
          if (item.type !== "listItem") continue;
          const itemChildren = childNodes(item);
          const contentNodes = itemChildren.filter((child) => child.type !== "list");
          const itemEvidence = evidenceFor(item);
          if (itemEvidence) {
            items.push({
              depth,
              text: contentNodes.map(plainText).join("\n"),
              checked: typeof item.checked === "boolean" ? item.checked : null,
              evidence: itemEvidence,
              inlineCode: contentNodes.flatMap((child) => inlineCodeFor(child, evidenceFor)),
            });
          }
          for (const nested of itemChildren) if (nested.type === "list") collectItems(nested, depth + 1);
        }
      };
      collectItems(node, 0);
      currentSection.blocks.push({ kind: "list", ordered: node.ordered === true, items, evidence });
    } else if (node.type === "table") {
      const rows: DocumentationTableRow[] = [];
      const tableRows = childNodes(node);
      for (const [rowIndex, row] of tableRows.entries()) {
        const rowEvidence = evidenceFor(row);
        if (!rowEvidence) continue;
        rows.push({
          cells: childNodes(row).map(plainText),
          header: rowIndex === 0,
          evidence: rowEvidence,
        });
      }
      currentSection.blocks.push({ kind: "table", rows, evidence, inlineCode: inlineCodeFor(node, evidenceFor) });
    }
  }

  if (sections.length === 1 && sections[0]!.blocks.length === 0) sections.length = 0;
  else if (sections[0]!.heading === null && sections[0]!.blocks.length === 0) sections.shift();
  return {
    document: {
      filePath,
      kind,
      fileSha256,
      byteLength: bytes.byteLength,
      title,
      sections,
    },
    references,
  };
}

export function analyzeDocumentation(input: AnalyzeDocumentationInput): DocumentationContext {
  const pathEntries: Array<{ originalPath: string; filePath: string }> = [];
  const unsafeCandidatesByPath = new Map<string, DocumentationSkippedFile>();
  for (const rawPath of input.snapshotPaths) {
    const normalizedPath = normalizeSnapshotPath(rawPath);
    if (!normalizedPath || normalizedPath !== rawPath) {
      if (pathLooksLikeDocumentation(rawPath)) unsafeCandidatesByPath.set(rawPath, { filePath: rawPath, reason: "unsafe-path" });
      continue;
    }
    pathEntries.push({ originalPath: rawPath, filePath: normalizedPath });
  }
  pathEntries.sort((left, right) => compareText(left.filePath, right.filePath) || compareText(left.originalPath, right.originalPath));
  const uniquePathEntries = pathEntries.filter((entry, index) => index === 0 || entry.filePath !== pathEntries[index - 1]!.filePath);
  const snapshotPathSet = new Set(uniquePathEntries.map((entry) => entry.filePath));
  const snapshotDirectorySet = new Set<string>();
  for (const path of snapshotPathSet) {
    const parts = path.split("/");
    for (let index = 1; index < parts.length; index += 1) snapshotDirectorySet.add(parts.slice(0, index).join("/"));
  }
  const packageDirectories = new Set(
    uniquePathEntries
      .filter((entry) => ["package.json", "composer.json"].includes(entry.filePath.split("/").at(-1) ?? ""))
      .map((entry) => entry.filePath.split("/").slice(0, -1).join("/")),
  );

  const candidates: FileCandidate[] = [];
  for (const entry of uniquePathEntries) {
    const kind = markdownCandidateKind(entry.filePath, packageDirectories);
    if (!kind) continue;
    candidates.push({ filePath: entry.filePath, originalPath: entry.originalPath, kind, excluded: hasExcludedDirectory(entry.filePath) });
  }
  candidates.sort((left, right) => PRIORITY[left.kind] - PRIORITY[right.kind] || compareText(left.filePath, right.filePath));

  const documents: DocumentationDocument[] = [];
  const references: DocumentationReference[] = [];
  const skipped: DocumentationSkippedFile[] = [...unsafeCandidatesByPath.values()];
  let selectedFileCount = 0;
  let documentByteCount = 0;

  for (const candidate of candidates) {
    if (candidate.excluded) {
      skipped.push({ filePath: candidate.filePath, reason: "excluded" });
      continue;
    }
    if (candidate.filePath.length > MAX_DOCUMENT_PATH_LENGTH) {
      skipped.push({ filePath: candidate.filePath, reason: "representation-limit" });
      continue;
    }
    if (selectedFileCount >= DOCUMENTATION_LIMITS.maxFiles) {
      skipped.push({ filePath: candidate.filePath, reason: "file-count-limit" });
      continue;
    }
    const sourcePath = sourceHas(input.sources, candidate.originalPath)
      ? candidate.originalPath
      : sourceHas(input.sources, candidate.filePath) ? candidate.filePath : null;
    if (sourcePath === null) {
      skipped.push({ filePath: candidate.filePath, reason: "source-unavailable" });
      continue;
    }
    const bytes = input.sources[sourcePath]!;
    if (bytes.byteLength > DOCUMENTATION_LIMITS.maxFileBytes) {
      skipped.push({ filePath: candidate.filePath, reason: "too-large" });
      continue;
    }
    if (documentByteCount + bytes.byteLength > DOCUMENTATION_LIMITS.maxTotalBytes) {
      skipped.push({ filePath: candidate.filePath, reason: "aggregate-byte-limit" });
      continue;
    }
    selectedFileCount += 1;
    documentByteCount += bytes.byteLength;
    const parsed = parseFile(candidate.filePath, candidate.kind, bytes, snapshotPathSet, snapshotDirectorySet);
    if (typeof parsed === "string") {
      skipped.push({ filePath: candidate.filePath, reason: parsed });
      continue;
    }
    documents.push(parsed.document);
    references.push(...parsed.references);
  }

  skipped.sort((left, right) => compareText(left.filePath, right.filePath) || compareText(left.reason, right.reason));
  references.sort((left, right) => compareText(left.sourcePath, right.sourcePath)
    || compareText(left.evidence.startByte.toString().padStart(12, "0"), right.evidence.startByte.toString().padStart(12, "0"))
    || compareText(left.target, right.target));
  return {
    documents,
    references,
    coverage: {
      snapshotPathCount: input.snapshotPaths.length,
      candidateFileCount: candidates.length + unsafeCandidatesByPath.size,
      documentCount: documents.length,
      documentByteCount,
      skipped,
    },
  };
}
