import { createHash } from "node:crypto";
import {
  analyzeDeclarations as analyzeJavaScriptDeclarations,
  type DeclarationDiagnostic as JavaScriptDiagnostic,
} from "@sage/analyzer-js";
import {
  analyzeDeclarations as analyzePhpDeclarations,
  type DeclarationDiagnostic as PhpDiagnostic,
} from "@sage/analyzer-php";
import {
  canonicalizeCcm,
  type CcmFile,
  type CcmLimitation,
  type CcmNode,
  type CcmSnapshot,
  type CcmV1,
  type Language,
} from "@sage/contracts";
import type { SnapshotFile } from "./snapshot/archive.ts";

export const SOURCE_POLICY_VERSION = "sage-source-policy-v1";
export const DEFAULT_MAX_SOURCE_FILE_BYTES = 1024 * 1024;
const MAX_SNAPSHOT_FILES = 2_000;
const MAX_SNAPSHOT_PATH_BYTES = 4_096;
const MAX_SNAPSHOT_PATH_SEGMENTS = 128;

type SourceLanguage = Extract<Language, "javascript" | "typescript" | "php">;

export type SourceExclusionReason =
  | "SUBMODULE_METADATA"
  | "EXCLUDED_DIRECTORY"
  | "MINIFIED_SOURCE"
  | "SOURCE_MAP"
  | "UNSUPPORTED_EXTENSION"
  | "SOURCE_FILE_TOO_LARGE"
  | "NUL_BYTE"
  | "BINARY_FILE"
  | "INVALID_UTF8";

export interface SourceFileReport {
  path: string;
  language: SourceLanguage | null;
  sha256: string;
  byteLength: number;
  status: "eligible" | "excluded";
  reason: SourceExclusionReason | null;
}

export interface SourceLanguageCounts {
  recognized: number;
  eligible: number;
  processed: number;
  failed: number;
}

export interface SourceScanReport {
  policyVersion: typeof SOURCE_POLICY_VERSION;
  status: "ready" | "failed";
  errorCode: "NO_SUPPORTED_SOURCE" | "SNAPSHOT_INVALID" | "INVALID_LIMITS" | null;
  files: SourceFileReport[];
  counts: {
    total: number;
    recognized: number;
    eligible: number;
    excluded: number;
    processed: number;
    failed: number;
    languages: Record<SourceLanguage, SourceLanguageCounts>;
  };
  limitations: Array<{ code: "SUBMODULE_CONTENTS_NOT_INCLUDED"; path: string | null }>;
}

export interface SourceAnalysisDiagnostic {
  path: string;
  language: SourceLanguage;
  code: number | string;
  message: string;
  startByte: number | null;
  line: number | null;
  column: number | null;
}

export interface SourceAnalysisResult {
  status: "complete" | "partial" | "failed";
  errorCode: "NO_SUPPORTED_SOURCE" | "PARSE_FAILED" | "SNAPSHOT_INVALID" | "INVALID_LIMITS" | null;
  report: SourceScanReport;
  ccm: CcmV1 | null;
  canonicalJson: string | null;
  contentSha256: string | null;
  diagnostics: SourceAnalysisDiagnostic[];
}

interface CapturedFile extends SnapshotFile {
  bytes: Uint8Array;
}

interface CaptureResult {
  files: CapturedFile[];
  errorCode: "SNAPSHOT_INVALID" | "INVALID_LIMITS" | null;
}

function emptyLanguageCounts(): Record<SourceLanguage, SourceLanguageCounts> {
  return {
    javascript: { recognized: 0, eligible: 0, processed: 0, failed: 0 },
    typescript: { recognized: 0, eligible: 0, processed: 0, failed: 0 },
    php: { recognized: 0, eligible: 0, processed: 0, failed: 0 },
  };
}

function emptyReport(
  errorCode: SourceScanReport["errorCode"],
  files: SourceFileReport[] = [],
  limitations: SourceScanReport["limitations"] = [],
): SourceScanReport {
  return {
    policyVersion: SOURCE_POLICY_VERSION,
    status: errorCode ? "failed" : "ready",
    errorCode,
    files,
    counts: {
      total: files.length,
      recognized: files.filter((file) => file.language !== null).length,
      eligible: files.filter((file) => file.status === "eligible").length,
      excluded: files.filter((file) => file.status === "excluded").length,
      processed: 0,
      failed: 0,
      languages: emptyLanguageCounts(),
    },
    limitations,
  };
}

function record(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Reflect.ownKeys(value).every((key) => {
    if (typeof key !== "string") return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return !!descriptor && "value" in descriptor && descriptor.enumerable;
  });
}

function safePath(path: string): boolean {
  if (!path || path.startsWith("/") || path.includes("\\") || path.includes("\0") || path.includes(":")) return false;
  if (Buffer.byteLength(path, "utf8") > MAX_SNAPSHOT_PATH_BYTES || path.normalize("NFC") !== path) return false;
  const segments = path.split("/");
  return segments.length <= MAX_SNAPSHOT_PATH_SEGMENTS &&
    segments.every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function pathKey(path: string): string {
  return path.normalize("NFKC").toUpperCase().toLowerCase().normalize("NFC");
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function sourceLanguage(path: string): SourceLanguage | null {
  const extension = path.slice(path.lastIndexOf(".")).toLowerCase();
  if ([".js", ".mjs", ".cjs", ".jsx"].includes(extension)) return "javascript";
  if ([".ts", ".mts", ".cts", ".tsx"].includes(extension)) return "typescript";
  if (extension === ".php") return "php";
  return null;
}

function exclusionReason(
  path: string,
  language: SourceLanguage | null,
  bytes: Uint8Array,
  maxSourceFileBytes: number,
): SourceExclusionReason | null {
  const lowerPath = path.toLowerCase();
  if (lowerPath === ".gitmodules") return "SUBMODULE_METADATA";
  if (path.split("/").some((segment) => [".git", "node_modules", "vendor", "dist", "build", "coverage", ".next"].includes(segment.toLowerCase()))) {
    return "EXCLUDED_DIRECTORY";
  }
  if (lowerPath.endsWith(".map")) return "SOURCE_MAP";
  if (/\.min\.(?:js|mjs|cjs)$/i.test(path)) return "MINIFIED_SOURCE";
  if (!language) return "UNSUPPORTED_EXTENSION";
  if (bytes.byteLength > maxSourceFileBytes) return "SOURCE_FILE_TOO_LARGE";
  if (bytes.includes(0)) return "NUL_BYTE";
  if (bytes.some((byte) => (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0c && byte !== 0x0d) || byte === 0x7f)) {
    return "BINARY_FILE";
  }
  try {
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return "INVALID_UTF8";
  }
  return null;
}

function captureSnapshotFiles(files: readonly SnapshotFile[], maxSourceFileBytes: number | undefined): CaptureResult {
  const maxBytes = maxSourceFileBytes ?? DEFAULT_MAX_SOURCE_FILE_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > DEFAULT_MAX_SOURCE_FILE_BYTES) {
    return { files: [], errorCode: "INVALID_LIMITS" };
  }
  if (!Array.isArray(files) || files.length > MAX_SNAPSHOT_FILES) return { files: [], errorCode: "SNAPSHOT_INVALID" };

  const captured: CapturedFile[] = [];
  const seen = new Map<string, string>();
  const fileKeys = new Set<string>();
  for (const candidate of files as readonly unknown[]) {
    if (!record(candidate) || Reflect.ownKeys(candidate).length !== 4 ||
      !Object.hasOwn(candidate, "relativePath") || !Object.hasOwn(candidate, "sha256") ||
      !Object.hasOwn(candidate, "byteLength") || !Object.hasOwn(candidate, "bytes")) {
      return { files: [], errorCode: "SNAPSHOT_INVALID" };
    }
    const { relativePath, sha256: claimedHash, byteLength, bytes: inputBytes } = candidate;
    if (typeof relativePath !== "string" || !safePath(relativePath) ||
      typeof claimedHash !== "string" || !/^[a-f0-9]{64}$/.test(claimedHash) ||
      !Number.isSafeInteger(byteLength) || (byteLength as number) < 0 || !(inputBytes instanceof Uint8Array)) {
      return { files: [], errorCode: "SNAPSHOT_INVALID" };
    }
    const key = pathKey(relativePath);
    if (seen.has(key)) return { files: [], errorCode: "SNAPSHOT_INVALID" };
    seen.set(key, relativePath);
    const bytes = new Uint8Array(inputBytes);
    if (bytes.byteLength !== byteLength || sha256(bytes) !== claimedHash) {
      return { files: [], errorCode: "SNAPSHOT_INVALID" };
    }
    captured.push({ relativePath, sha256: claimedHash, byteLength: bytes.byteLength, bytes });
    fileKeys.add(key);
  }

  for (const file of captured) {
    const segments = file.relativePath.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      const parentKey = pathKey(segments.slice(0, index).join("/"));
      if (fileKeys.has(parentKey)) return { files: [], errorCode: "SNAPSHOT_INVALID" };
    }
  }
  captured.sort((left, right) => compareStrings(left.relativePath, right.relativePath));
  return { files: captured, errorCode: null };
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function createScanReport(captured: CapturedFile[], maxSourceFileBytes: number): SourceScanReport {
  const files: SourceFileReport[] = [];
  const limitations: SourceScanReport["limitations"] = [];
  for (const file of captured) {
    const language = sourceLanguage(file.relativePath);
    const reason = exclusionReason(file.relativePath, language, file.bytes, maxSourceFileBytes);
    files.push({
      path: file.relativePath,
      language,
      sha256: file.sha256,
      byteLength: file.byteLength,
      status: reason ? "excluded" : "eligible",
      reason,
    });
    if (reason === "SUBMODULE_METADATA") {
      limitations.push({ code: "SUBMODULE_CONTENTS_NOT_INCLUDED", path: file.relativePath });
    }
  }
  const report = emptyReport(files.some((file) => file.status === "eligible") ? null : "NO_SUPPORTED_SOURCE", files, limitations);
  for (const file of files) {
    if (!file.language) continue;
    const counts = report.counts.languages[file.language];
    counts.recognized += 1;
    if (file.status === "eligible") counts.eligible += 1;
  }
  report.counts.recognized = Object.values(report.counts.languages).reduce((sum, item) => sum + item.recognized, 0);
  report.counts.eligible = Object.values(report.counts.languages).reduce((sum, item) => sum + item.eligible, 0);
  report.counts.excluded = report.counts.total - report.counts.eligible;
  return report;
}

/** Apply the deterministic source-only file policy and return metadata without source bytes. */
export function scanSnapshotSources(
  files: readonly SnapshotFile[],
  options?: { maxSourceFileBytes?: number },
): SourceScanReport {
  const maxSourceFileBytes = options?.maxSourceFileBytes;
  const captured = captureSnapshotFiles(files, maxSourceFileBytes);
  if (captured.errorCode) return emptyReport(captured.errorCode);
  return createScanReport(captured.files, maxSourceFileBytes ?? DEFAULT_MAX_SOURCE_FILE_BYTES);
}

function failedResult(report: SourceScanReport, errorCode: SourceAnalysisResult["errorCode"]): SourceAnalysisResult {
  return {
    status: "failed",
    errorCode,
    report,
    ccm: null,
    canonicalJson: null,
    contentSha256: null,
    diagnostics: [],
  };
}

function diagnosticFromJavaScript(item: JavaScriptDiagnostic, language: "javascript" | "typescript"): SourceAnalysisDiagnostic {
  return { ...item, language };
}

function diagnosticFromPhp(item: PhpDiagnostic): SourceAnalysisDiagnostic {
  return { ...item, language: "php" };
}

function compareDiagnostics(left: SourceAnalysisDiagnostic, right: SourceAnalysisDiagnostic): number {
  return compareStrings(left.path, right.path) ||
    (left.startByte ?? -1) - (right.startByte ?? -1) ||
    compareStrings(String(left.code), String(right.code));
}

function sourceFileMap(captured: readonly CapturedFile[], report: SourceScanReport): Record<string, Uint8Array> {
  const eligiblePaths = new Set(report.files.filter((file) => file.status === "eligible").map((file) => file.path));
  return Object.fromEntries(captured.filter((file) => eligiblePaths.has(file.relativePath))
    .map((file) => [file.relativePath, file.bytes] as const));
}

function resultCounts(report: SourceScanReport, files: readonly CcmFile[]): void {
  const byPath = new Map(files.map((file) => [file.path, file] as const));
  report.counts.processed = 0;
  report.counts.failed = 0;
  for (const item of Object.values(report.counts.languages)) {
    item.processed = 0;
    item.failed = 0;
  }
  for (const file of report.files) {
    if (file.status !== "eligible" || !file.language) continue;
    const analysis = byPath.get(file.path);
    if (analysis?.status === "processed") {
      report.counts.processed += 1;
      report.counts.languages[file.language].processed += 1;
    } else if (analysis?.status === "failed") {
      report.counts.failed += 1;
      report.counts.languages[file.language].failed += 1;
    }
  }
}

function limitationForExclusion(file: SourceFileReport): CcmLimitation {
  return {
    path: file.path,
    stage: "language detection",
    reason: `Source policy excluded this file (${file.reason ?? "UNSUPPORTED_EXTENSION"}).`,
  };
}

function adapterFailureFiles(
  paths: readonly string[],
  reportByPath: ReadonlyMap<string, SourceFileReport>,
): CcmFile[] {
  return paths.map((path) => {
    const item = reportByPath.get(path)!;
    return { path, language: item.language, sha256: item.sha256, sizeBytes: item.byteLength, status: "failed" };
  });
}

function hashConfig(maxSourceFileBytes: number, adapterHashes: readonly string[]): string {
  const config = {
    sourcePolicyVersion: SOURCE_POLICY_VERSION,
    maxSourceFileBytes,
    adapters: [
      { name: "sage-analyzer-js-declarations", version: "0.1.0" },
      { name: "sage-analyzer-php-declarations", version: "0.1.0" },
    ],
    adapterConfigHashes: [...adapterHashes].sort(compareStrings),
  };
  return sha256(new TextEncoder().encode(JSON.stringify(config)));
}

function buildCombinedCcm(
  snapshot: CcmSnapshot,
  report: SourceScanReport,
  jsCcm: CcmV1 | null,
  phpCcm: CcmV1 | null,
  adapterFailedPaths: readonly string[],
  configHash: string,
): CcmV1 {
  const eligibleStatus = new Map<string, CcmFile>();
  for (const file of [...(jsCcm?.files ?? []), ...(phpCcm?.files ?? [])]) {
    if (eligibleStatus.has(file.path)) throw new Error("DUPLICATE_SOURCE_FILE");
    eligibleStatus.set(file.path, file);
  }
  const reportByPath = new Map(report.files.map((file) => [file.path, file] as const));
  for (const file of adapterFailureFiles(adapterFailedPaths, reportByPath)) {
    if (eligibleStatus.has(file.path)) throw new Error("DUPLICATE_SOURCE_FILE");
    eligibleStatus.set(file.path, file);
  }

  const files: CcmFile[] = report.files.map((file) => {
    if (file.status === "excluded") {
      return { path: file.path, language: file.language, sha256: file.sha256, sizeBytes: file.byteLength, status: "excluded" };
    }
    const analyzed = eligibleStatus.get(file.path);
    if (!analyzed) throw new Error("SOURCE_FILE_STATUS_MISSING");
    return analyzed;
  });
  const nodes: CcmNode[] = [...(jsCcm?.nodes ?? []), ...(phpCcm?.nodes ?? [])];
  const nodeIds = new Set<string>();
  for (const node of nodes) {
    if (nodeIds.has(node.id)) throw new Error("DUPLICATE_NODE_ID");
    nodeIds.add(node.id);
  }
  const limitations: CcmLimitation[] = [
    ...report.files.filter((file) => file.status === "excluded").map(limitationForExclusion),
    ...report.limitations.map((item) => ({ path: item.path, stage: "snapshot", reason: item.code })),
    ...(jsCcm?.limitations ?? []),
    ...(phpCcm?.limitations ?? []),
  ];
  for (const path of adapterFailedPaths) {
    limitations.push({ path, stage: "parse", reason: "The trusted language adapter could not analyze this source file." });
  }
  return {
    schemaVersion: 1,
    snapshot,
    provenance: {
      analyzer: { name: "sage-source-analysis", version: SOURCE_POLICY_VERSION },
      resolver: { name: "sage-declaration-adapters", version: "0.1.0" },
      configHash,
    },
    files,
    nodes,
    edges: [...(jsCcm?.edges ?? []), ...(phpCcm?.edges ?? [])],
    limitations,
  };
}

function snapshotIsValid(snapshot: CcmSnapshot): boolean {
  return record(snapshot) && typeof snapshot.repository === "string" && snapshot.repository.trim().length > 0 &&
    (snapshot.branch === null || (typeof snapshot.branch === "string" && snapshot.branch.trim().length > 0)) &&
    typeof snapshot.commitSha === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(snapshot.commitSha);
}

/** Detect and analyze only bounded, supported UTF-8 sources without executing repository-controlled files. */
export async function analyzeSnapshotSources(input: {
  snapshot: CcmSnapshot;
  files: readonly SnapshotFile[];
  signal?: AbortSignal;
  maxSourceFileBytes?: number;
}): Promise<SourceAnalysisResult> {
  input.signal?.throwIfAborted();
  const maxSourceFileBytes = input.maxSourceFileBytes ?? DEFAULT_MAX_SOURCE_FILE_BYTES;
  const captured = captureSnapshotFiles(input.files, input.maxSourceFileBytes);
  if (captured.errorCode) return failedResult(emptyReport(captured.errorCode), captured.errorCode);
  const report = createScanReport(captured.files, maxSourceFileBytes);
  if (!snapshotIsValid(input.snapshot)) {
    report.status = "failed";
    report.errorCode = "SNAPSHOT_INVALID";
    return failedResult(report, "SNAPSHOT_INVALID");
  }
  if (report.errorCode) return failedResult(report, report.errorCode);

  const allSources = Object.fromEntries(captured.files.map((file) => [file.relativePath, file.bytes] as const));
  const eligibleSources = sourceFileMap(captured.files, report);
  const jsSources = Object.fromEntries(Object.entries(eligibleSources).filter(([path]) => {
    const language = sourceLanguage(path);
    return language === "javascript" || language === "typescript";
  }));
  const phpSources = Object.fromEntries(Object.entries(eligibleSources).filter(([path]) => sourceLanguage(path) === "php"));
  const diagnostics: SourceAnalysisDiagnostic[] = [];
  let jsCcm: CcmV1 | null = null;
  let phpCcm: CcmV1 | null = null;
  let jsFailurePaths: string[] = [];
  let phpFailurePaths: string[] = [];
  const adapterHashes: string[] = [];

  if (Object.keys(jsSources).length > 0) {
    input.signal?.throwIfAborted();
    const result = analyzeJavaScriptDeclarations({ snapshot: input.snapshot, sources: jsSources });
    if (result.ccm) {
      jsCcm = result.ccm;
      adapterHashes.push(result.ccm.provenance.configHash);
    } else {
      jsFailurePaths = Object.keys(jsSources);
    }
    diagnostics.push(...result.diagnostics.map((item) => {
      const language = sourceLanguage(item.path);
      return diagnosticFromJavaScript(item, language === "typescript" ? "typescript" : "javascript");
    }));
  }

  if (Object.keys(phpSources).length > 0) {
    input.signal?.throwIfAborted();
    const result = await analyzePhpDeclarations({ snapshot: input.snapshot, sources: phpSources, signal: input.signal });
    if (result.ccm) {
      phpCcm = result.ccm;
      adapterHashes.push(result.ccm.provenance.configHash);
    } else {
      phpFailurePaths = Object.keys(phpSources);
    }
    diagnostics.push(...result.diagnostics.map(diagnosticFromPhp));
  }
  input.signal?.throwIfAborted();

  const failedAdapterPaths = [...jsFailurePaths, ...phpFailurePaths];
  const configHash = hashConfig(maxSourceFileBytes, adapterHashes);
  let ccm: CcmV1;
  try {
    ccm = buildCombinedCcm(input.snapshot, report, jsCcm, phpCcm, failedAdapterPaths, configHash);
  } catch {
    report.status = "failed";
    report.errorCode = "SNAPSHOT_INVALID";
    return failedResult(report, "SNAPSHOT_INVALID");
  }
  resultCounts(report, ccm.files);

  const canonical = canonicalizeCcm(ccm, allSources);
  if (!canonical.ok) {
    report.status = "failed";
    report.errorCode = "SNAPSHOT_INVALID";
    return failedResult(report, "SNAPSHOT_INVALID");
  }
  const validFiles = report.counts.processed;
  const status: SourceAnalysisResult["status"] = validFiles === 0
    ? "failed"
    : report.counts.failed > 0 || report.counts.excluded > 0 ||
      ccm.limitations.some((item) => item.stage !== "resolve")
      ? "partial"
      : "complete";
  const errorCode = validFiles === 0 ? "PARSE_FAILED" : null;
  diagnostics.sort(compareDiagnostics);
  return {
    status,
    errorCode,
    report,
    ccm: canonical.value,
    canonicalJson: canonical.json,
    contentSha256: canonical.sha256,
    diagnostics,
  };
}
