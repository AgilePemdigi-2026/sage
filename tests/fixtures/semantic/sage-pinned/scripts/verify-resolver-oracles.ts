import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export type ResolverLanguage = "javascript" | "typescript" | "php";
export type ResolverEvidence = {
  path: string;
  snippet: string;
  startByte: number;
  endByte: number;
  startLine: number;
  endLine: number;
  startColumn: number;
  endColumn: number;
};
export type ResolverOracleEdge = {
  id: string;
  scenario: string;
  kind: string;
  source: { path: string; qualifiedName: string };
  resolution: "Exact" | "Unresolved";
  target?: { path: string; qualifiedName: string };
  unresolved?: { name: string; reason: string };
  evidence: ResolverEvidence;
};
export type ResolverFixtureFile = {
  path: string;
  language: ResolverLanguage;
  sha256: string;
  sizeBytes: number;
  canary?: string;
};
export type ResolverLanguageCoverage = {
  language: ResolverLanguage;
  minimumExactEdges: number;
  minimumUnresolvedEdges: number;
  requiredScenarios: string[];
};
export type ResolverOracleManifest = {
  schemaVersion: 1;
  reviewStatus: "DRAFT_AWAITING_TEAM_REVIEW";
  reviewedBy: null;
  scope: string;
  files: ResolverFixtureFile[];
  expectedEdges: ResolverOracleEdge[];
  languageCoverage: ResolverLanguageCoverage[];
};

export const resolverOracleRoot = new URL("../", import.meta.url);

export type VerifyResolverOraclesOptions = {
  /** Project root containing tests/fixtures/resolver. Defaults to this script's repository root. */
  root?: URL | string;
  /** Manifest override used by mutation tests. Fixture bytes still come from root. */
  manifest?: unknown;
};

const languages: ResolverLanguage[] = ["javascript", "typescript", "php"];
const edgeKinds = new Set([
  "IMPORTS", "EXPORTS", "EXTENDS", "IMPLEMENTS", "TYPE_REFERENCES", "CALLS", "INSTANTIATES", "READS", "WRITES", "THROWS", "INCLUDES",
]);
const unresolvedReasons = new Set(["DYNAMIC_LOAD", "UNKNOWN_RECEIVER", "EXTERNAL_DEPENDENCY", "UNSUPPORTED_CONSTRUCT", "AMBIGUOUS_SYMBOL"]);
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(code: string): never {
  throw new Error(code);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function safeRelativePath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.startsWith("/") || !/^[A-Za-z0-9._/-]+$/.test(value)) return false;
  const parts = value.split("/");
  return parts.every((part) => part !== "" && part !== "." && part !== "..");
}

function normalizeRoot(root: URL | string | undefined): URL {
  if (root === undefined) return resolverOracleRoot;
  if (root instanceof URL) {
    if (root.protocol !== "file:") fail("RESOLVER_FIXTURE_ROOT_INVALID");
    const normalized = new URL(root.href);
    if (!normalized.pathname.endsWith("/")) normalized.pathname += "/";
    return normalized;
  }
  const path = resolve(root);
  return pathToFileURL(path.endsWith(sep) ? path : `${path}${sep}`);
}

function isWithin(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return relativePath !== "" && relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath);
}

function positionAt(bytes: Buffer, offset: number): { line: number; column: number } {
  let prefix: string;
  try {
    prefix = utf8.decode(bytes.subarray(0, offset));
  } catch {
    fail("RESOLVER_ORACLE_UTF8_BOUNDARY_INVALID");
  }
  const lines = prefix.split("\n");
  return { line: lines.length, column: Array.from(lines.at(-1) ?? "").length + 1 };
}

function validateManifest(value: unknown): ResolverOracleManifest {
  if (!isRecord(value) || value.schemaVersion !== 1 || value.reviewStatus !== "DRAFT_AWAITING_TEAM_REVIEW" ||
    value.reviewedBy !== null || !isNonEmptyString(value.scope)) fail("RESOLVER_ORACLE_MANIFEST_INVALID");
  if (!Array.isArray(value.files) || value.files.length === 0 || !Array.isArray(value.expectedEdges) || value.expectedEdges.length === 0 ||
    !Array.isArray(value.languageCoverage)) fail("RESOLVER_ORACLE_MANIFEST_INVALID");

  const fileByPath = new Map<string, ResolverFixtureFile>();
  const languageFiles = new Set<ResolverLanguage>();
  for (const rawFile of value.files) {
    if (!isRecord(rawFile) || !safeRelativePath(rawFile.path) || !languages.includes(rawFile.language as ResolverLanguage) ||
      !/^[a-f0-9]{64}$/.test(String(rawFile.sha256)) || !isInteger(rawFile.sizeBytes) || rawFile.sizeBytes < 0) {
      fail("RESOLVER_FIXTURE_FILE_METADATA_INVALID");
    }
    if (fileByPath.has(rawFile.path)) fail("RESOLVER_FIXTURE_PATH_DUPLICATE");
    const extension = rawFile.path.slice(rawFile.path.lastIndexOf(".") + 1).toLowerCase();
    const expectedLanguage = extension === "php" ? "php" : ["ts", "tsx", "mts", "cts"].includes(extension) ? "typescript" :
      ["js", "jsx", "mjs", "cjs"].includes(extension) ? "javascript" : null;
    if (expectedLanguage !== rawFile.language) fail("RESOLVER_FIXTURE_FILE_METADATA_INVALID");
    if (rawFile.canary !== undefined && !isNonEmptyString(rawFile.canary)) fail("RESOLVER_FIXTURE_FILE_METADATA_INVALID");
    const file = rawFile as unknown as ResolverFixtureFile;
    fileByPath.set(file.path, file);
    languageFiles.add(file.language);
  }
  if (languages.some((language) => !languageFiles.has(language))) fail("RESOLVER_FIXTURE_LANGUAGE_MISSING");

  const edgeIds = new Set<string>();
  const edgeKeys = new Set<string>();
  const edgesByLanguage = new Map<ResolverLanguage, { exact: number; unresolved: number; scenarios: Set<string> }>();
  for (const language of languages) edgesByLanguage.set(language, { exact: 0, unresolved: 0, scenarios: new Set() });
  for (const rawEdge of value.expectedEdges) {
    if (!isRecord(rawEdge) || !isNonEmptyString(rawEdge.id) || !isNonEmptyString(rawEdge.scenario) ||
      !isNonEmptyString(rawEdge.kind) || !edgeKinds.has(rawEdge.kind) || !isRecord(rawEdge.source) ||
      !safeRelativePath(rawEdge.source.path) || !isNonEmptyString(rawEdge.source.qualifiedName) || !isRecord(rawEdge.evidence)) {
      fail("RESOLVER_ORACLE_EDGE_INVALID");
    }
    if (edgeIds.has(rawEdge.id)) fail("RESOLVER_ORACLE_EDGE_DUPLICATE");
    edgeIds.add(rawEdge.id);
    const sourceFile = fileByPath.get(rawEdge.source.path);
    if (!sourceFile) fail("RESOLVER_ORACLE_SOURCE_UNKNOWN");
    const evidence = rawEdge.evidence;
    if (!safeRelativePath(evidence.path) || evidence.path !== rawEdge.source.path || !isNonEmptyString(evidence.snippet)) {
      fail("RESOLVER_ORACLE_EVIDENCE_INVALID");
    }
    for (const key of ["startByte", "endByte", "startLine", "endLine", "startColumn", "endColumn"] as const) {
      if (!isInteger(evidence[key])) fail("RESOLVER_ORACLE_EVIDENCE_INVALID");
      if (key.endsWith("Line") || key.endsWith("Column")) {
        if ((evidence[key] as number) < 1) fail("RESOLVER_ORACLE_EVIDENCE_INVALID");
      } else if ((evidence[key] as number) < 0) fail("RESOLVER_ORACLE_EVIDENCE_INVALID");
    }
    const startByte = evidence.startByte as number;
    const endByte = evidence.endByte as number;
    const startLine = evidence.startLine as number;
    const endLine = evidence.endLine as number;
    if (startByte >= endByte || startLine > endLine) fail("RESOLVER_ORACLE_EVIDENCE_INVALID");

    if (rawEdge.resolution === "Exact") {
      if (!isRecord(rawEdge.target) || !safeRelativePath(rawEdge.target.path) || !isNonEmptyString(rawEdge.target.qualifiedName) ||
        rawEdge.unresolved !== undefined) fail("RESOLVER_ORACLE_EDGE_INVALID");
      if (!fileByPath.has(rawEdge.target.path)) fail("RESOLVER_ORACLE_TARGET_UNKNOWN");
    } else if (rawEdge.resolution === "Unresolved") {
      if (!isRecord(rawEdge.unresolved) || !isNonEmptyString(rawEdge.unresolved.name) || !isNonEmptyString(rawEdge.unresolved.reason) ||
        !unresolvedReasons.has(rawEdge.unresolved.reason) || rawEdge.target !== undefined) fail("RESOLVER_ORACLE_UNRESOLVED_INVALID");
    } else {
      fail("RESOLVER_ORACLE_EDGE_INVALID");
    }
    const targetName = rawEdge.resolution === "Exact"
      ? (rawEdge.target as Record<string, unknown>).qualifiedName
      : (rawEdge.unresolved as Record<string, unknown>).name;
    const edgeKey = JSON.stringify([
      rawEdge.kind, rawEdge.source.qualifiedName, rawEdge.resolution,
      targetName,
      evidence.path, evidence.startByte, evidence.endByte,
    ]);
    if (edgeKeys.has(edgeKey)) fail("RESOLVER_ORACLE_EDGE_DUPLICATE");
    edgeKeys.add(edgeKey);
    const languageEdges = edgesByLanguage.get(sourceFile.language)!;
    languageEdges[rawEdge.resolution === "Exact" ? "exact" : "unresolved"] += 1;
    languageEdges.scenarios.add(rawEdge.scenario);
  }

  if (value.languageCoverage.length !== languages.length) fail("RESOLVER_ORACLE_LANGUAGE_COVERAGE_INVALID");
  const coverageLanguages = new Set<ResolverLanguage>();
  for (const rawCoverage of value.languageCoverage) {
    if (!isRecord(rawCoverage) || !languages.includes(rawCoverage.language as ResolverLanguage) ||
      !isInteger(rawCoverage.minimumExactEdges) || rawCoverage.minimumExactEdges < 1 ||
      !isInteger(rawCoverage.minimumUnresolvedEdges) || rawCoverage.minimumUnresolvedEdges < 1 ||
      !Array.isArray(rawCoverage.requiredScenarios) || rawCoverage.requiredScenarios.length === 0 ||
      !rawCoverage.requiredScenarios.every(isNonEmptyString)) fail("RESOLVER_ORACLE_LANGUAGE_COVERAGE_INVALID");
    const language = rawCoverage.language as ResolverLanguage;
    if (coverageLanguages.has(language)) fail("RESOLVER_ORACLE_LANGUAGE_COVERAGE_DUPLICATE");
    coverageLanguages.add(language);
    const actual = edgesByLanguage.get(language)!;
    if (actual.exact < rawCoverage.minimumExactEdges || actual.unresolved < rawCoverage.minimumUnresolvedEdges) {
      fail(`RESOLVER_ORACLE_LANGUAGE_EDGE_MINIMUM_MISSING: ${language}`);
    }
    for (const scenario of rawCoverage.requiredScenarios) {
      if (!actual.scenarios.has(scenario)) fail(`RESOLVER_ORACLE_REQUIRED_SCENARIO_MISSING: ${language}:${scenario}`);
    }
  }
  if (languages.some((language) => !coverageLanguages.has(language))) fail("RESOLVER_ORACLE_LANGUAGE_COVERAGE_MISSING");
  return value as unknown as ResolverOracleManifest;
}

async function readFixture(rootPath: string, path: string): Promise<Buffer> {
  if (!safeRelativePath(path)) fail("RESOLVER_FIXTURE_PATH_INVALID");
  const candidate = resolve(rootPath, ...path.split("/"));
  let actualPath: string;
  try {
    actualPath = await realpath(candidate);
  } catch {
    fail("RESOLVER_FIXTURE_FILE_MISSING");
  }
  if (!isWithin(rootPath, actualPath)) fail("RESOLVER_FIXTURE_PATH_INVALID");
  return readFile(actualPath);
}

export async function verifyResolverOracles(options: VerifyResolverOraclesOptions = {}): Promise<ResolverOracleManifest> {
  const rootUrl = normalizeRoot(options.root);
  let rootPath: string;
  try {
    rootPath = await realpath(fileURLToPath(rootUrl));
  } catch {
    fail("RESOLVER_FIXTURE_ROOT_INVALID");
  }
  const manifestValue = options.manifest ?? JSON.parse(await readFile(resolve(rootPath, "tests/fixtures/resolver/resolver-oracle-v1.json"), "utf8")) as unknown;
  const manifest = validateManifest(manifestValue);
  const sourceByPath = new Map<string, Buffer>();
  const canaryLanguages = new Set<ResolverLanguage>();
  for (const file of manifest.files) {
    const bytes = await readFixture(rootPath, file.path);
    let text: string;
    try {
      text = utf8.decode(bytes);
    } catch {
      fail(`RESOLVER_FIXTURE_UTF8_INVALID: ${file.path}`);
    }
    if (bytes.length !== file.sizeBytes || createHash("sha256").update(bytes).digest("hex") !== file.sha256) {
      fail(`RESOLVER_FIXTURE_HASH_MISMATCH: ${file.path}`);
    }
    if (file.canary !== undefined) {
      if (!text.includes(file.canary) || !/\bthrow\b/.test(text)) fail(`RESOLVER_FIXTURE_CANARY_MISSING: ${file.path}`);
      canaryLanguages.add(file.language);
    }
    sourceByPath.set(file.path, bytes);
  }
  if (languages.some((language) => !canaryLanguages.has(language))) fail("RESOLVER_FIXTURE_CANARY_LANGUAGE_MISSING");
  if (![...sourceByPath.values()].some((bytes) => bytes.includes(Buffer.from([0xef, 0xbb, 0xbf]))) ||
    ![...sourceByPath.values()].some((bytes) => bytes.includes(Buffer.from("\r\n"))) ||
    ![...sourceByPath.values()].some((bytes) => bytes.includes(Buffer.from("café", "utf8")))) {
    fail("RESOLVER_FIXTURE_TEXT_FEATURE_MISSING");
  }

  for (const edge of manifest.expectedEdges) {
    const bytes = sourceByPath.get(edge.evidence.path);
    if (!bytes) fail("RESOLVER_ORACLE_EVIDENCE_FILE_UNKNOWN");
    if (edge.evidence.endByte > bytes.length) fail("RESOLVER_ORACLE_BOUNDS_INVALID");
    let literal: string;
    try {
      literal = utf8.decode(bytes.subarray(edge.evidence.startByte, edge.evidence.endByte));
    } catch {
      fail("RESOLVER_ORACLE_UTF8_BOUNDARY_INVALID");
    }
    if (literal !== edge.evidence.snippet) fail("RESOLVER_ORACLE_LITERAL_MISMATCH");
    for (const [byte, line, column] of [
      [edge.evidence.startByte, edge.evidence.startLine, edge.evidence.startColumn],
      [edge.evidence.endByte, edge.evidence.endLine, edge.evidence.endColumn],
    ]) {
      const actual = positionAt(bytes, byte);
      if (actual.line !== line || actual.column !== column) fail("RESOLVER_ORACLE_POSITION_MISMATCH");
    }
  }
  return manifest;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const manifest = await verifyResolverOracles();
  console.log(JSON.stringify({
    status: "PASS",
    files: manifest.files.length,
    languages: languages.filter((language) => manifest.files.some((file) => file.language === language)),
    expectedEdges: manifest.expectedEdges.length,
    integrity: "PASS",
    semanticAcceptance: "NOT_RUN",
    reviewStatus: manifest.reviewStatus,
  }));
}
