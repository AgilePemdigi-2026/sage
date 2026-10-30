import { createHash } from "node:crypto";
import type { CcmNode, EvidenceRole, EvidenceSpan } from "@sage/contracts";
import type { SemanticConfidence, SemanticFragment, SemanticKind, SemanticNode } from "./model.ts";

export function semanticId(kind: SemanticKind, filePath: string, startByte: number, key: string): string {
  const digest = createHash("sha256").update(`${kind}\0${filePath}\0${startByte}\0${key}`, "utf8").digest("hex").slice(0, 24);
  return `sem_${kind}_${digest}`;
}

export function semanticEdgeId(filePath: string, startByte: number, key: string): string {
  const digest = createHash("sha256").update(`edge\0${filePath}\0${startByte}\0${key}`, "utf8").digest("hex").slice(0, 24);
  return `sem_edge_${digest}`;
}

export function evidenceSpan(filePath: string, bytes: Uint8Array, startUtf16: number, endUtf16: number, role: EvidenceRole = "context"): EvidenceSpan {
  const cached = sourceCache.get(bytes) ?? (() => {
    const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    const lines: Array<{ utf16: number; byte: number }> = [{ utf16: 0, byte: 0 }];
    let utf16 = 0, byte = 0;
    while (utf16 < text.length) {
      const codePoint = text.codePointAt(utf16)!;
      const width = codePoint > 0xffff ? 2 : 1;
      byte += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
      utf16 += width;
      if (codePoint === 0x0a) lines.push({ utf16, byte });
    }
    const value = { text, lines, sha256: createHash("sha256").update(bytes).digest("hex") };
    sourceCache.set(bytes, value);
    return value;
  })();
  const lineFor = (offset: number) => {
    let low = 0, high = cached.lines.length;
    while (low + 1 < high) {
      const middle = (low + high) >>> 1;
      if (cached.lines[middle]!.utf16 <= offset) low = middle;
      else high = middle;
    }
    return low;
  };
  const byteOffset = (offset: number) => {
    const bounded = Math.max(0, Math.min(cached.text.length, offset));
    const line = cached.lines[lineFor(bounded)]!;
    return line.byte + new TextEncoder().encode(cached.text.slice(line.utf16, bounded)).byteLength;
  };
  const startByte = byteOffset(startUtf16), endByte = byteOffset(endUtf16);
  const position = (utf16Offset: number) => {
    const bounded = Math.max(0, Math.min(cached.text.length, utf16Offset));
    const lineIndex = lineFor(bounded), line = cached.lines[lineIndex]!;
    return { line: lineIndex + 1, column: Array.from(cached.text.slice(line.utf16, bounded)).length + 1 };
  };
  const start = position(startUtf16), end = position(endUtf16);
  return {
    filePath,
    fileSha256: cached.sha256,
    startByte, endByte, startLine: start.line, endLine: end.line,
    startColumn: start.column, endColumn: end.column, role,
  };
}

const sourceCache = new WeakMap<Uint8Array, { text: string; lines: Array<{ utf16: number; byte: number }>; sha256: string }>();

export function humanLabel(value: string): string {
  const words = value
    .replace(/([a-z\d])([A-Z])/gu, "$1 $2")
    .replace(/([A-Z])([A-Z][a-z])/gu, "$1 $2")
    .replace(/[._/$\\:[\]{}-]+/gu, " ")
    .replace(/\s+/gu, " ").trim();
  if (!words) return "Fitur aplikasi";
  return words.charAt(0).toLocaleUpperCase("id-ID") + words.slice(1);
}

export function emptyFragment(): SemanticFragment {
  return { nodes: [], edges: [], features: [], frameworks: [], limitations: [] };
}

export function ensureFeatureNode(fragment: SemanticFragment, id: string, label: string, evidence: EvidenceSpan[], confidence: SemanticConfidence = "indicated", reason = "Fitur diringkas berdasarkan deklarasi dan hubungan source yang terdeteksi."): void {
  const existing = fragment.nodes.find(node => node.id === id);
  if (!existing) fragment.nodes.push({ id, kind: "feature", label: humanLabel(label), featureId: null, confidence, reason, evidence: compactEvidence(evidence), technicalNodeIds: [] });
  else {
    existing.evidence = compactEvidence([...existing.evidence, ...evidence]);
  }
  const feature = fragment.features.find(item => item.id === id);
  if (feature && !feature.nodeIds.includes(id)) feature.nodeIds.push(id);
}

export function excludeFromMainFlow(filePath: string): boolean {
  const path = filePath.replaceAll("\\", "/").toLowerCase();
  return /(^|\/)(__tests__|tests?|fixtures?|mocks?|generated|vendor|node_modules|dist|build|coverage|\.next)(\/|$)/u.test(path) ||
    /(^|\/)(next\.config|vitest\.config|jest\.config|playwright\.config|eslint\.config|postcss\.config|tailwind\.config)\./u.test(path) ||
    /\.(test|spec|stories)\.[cm]?[jt]sx?$/u.test(path) || /\.(css|scss|sass|less|md|mdx|json|ya?ml|svg)$/u.test(path);
}

export function semanticNode(input: {
  kind: SemanticKind; filePath: string; startByte: number; key: string; label: string;
  featureId?: string | null; confidence: "proven" | "indicated"; reason: string;
  evidence: EvidenceSpan[]; technicalNodeIds?: string[];
}): SemanticNode {
  return {
    id: semanticId(input.kind, input.filePath, input.startByte, input.key), kind: input.kind, label: humanLabel(input.label),
    featureId: input.featureId ?? null, confidence: input.confidence, reason: input.reason,
    evidence: [...input.evidence], technicalNodeIds: [...new Set(input.technicalNodeIds ?? [])].sort(),
  };
}

export function technicalNodesForSpan(ccmNodes: readonly CcmNode[], filePath: string, startByte: number, endByte: number, kinds?: readonly CcmNode["kind"][]): string[] {
  return ccmNodes.filter(node => node.filePath === filePath && node.location !== null &&
    node.location.startByte >= startByte && node.location.endByte <= endByte && (!kinds || kinds.includes(node.kind)))
    .map(node => node.id).sort();
}

/** Summary evidence for aggregate features/shared nodes: one source range per file.
 * Exact call/guard spans remain on individual nodes and relationships. */
export function compactEvidence(spans: readonly EvidenceSpan[]): EvidenceSpan[] {
  const files = new Map<string, EvidenceSpan>();
  for (const span of spans) {
    const key = `${span.filePath}\0${span.fileSha256}`;
    const existing = files.get(key);
    if (!existing) {files.set(key, {...span,role:"context"});continue;}
    if (span.startByte < existing.startByte) {existing.startByte=span.startByte;existing.startLine=span.startLine;existing.startColumn=span.startColumn;}
    if (span.endByte > existing.endByte) {existing.endByte=span.endByte;existing.endLine=span.endLine;existing.endColumn=span.endColumn;}
  }
  return [...files.values()].sort((a,b)=>a.filePath.localeCompare(b.filePath)||a.startByte-b.startByte);
}
