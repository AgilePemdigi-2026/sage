import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export type Evidence = { startByte: number; endByte: number; startLine: number; endLine: number; startColumn: number; endColumn: number };
export type FixtureLanguage = "php" | "javascript" | "typescript";
export type FixtureFile = { path: string; sha256: string; sizeBytes: number; language: string | null; syntaxValid: boolean | null };
export type OracleRole = "declaration" | "reference" | "context";
export type OracleResolution = "resolved" | "unresolved";
export type Oracle = { path: string; kind: string; target: string; snippet: string; evidence: Evidence; role?: OracleRole; resolution?: OracleResolution; reason?: string };
export type LanguageCoverage = {
  language: FixtureLanguage;
  minimumOracles: { declarations: number; references: number };
  limitations: Array<{ path: string; target: string; reason: string }>;
};
export type FixtureManifest = {
  schemaVersion: number;
  reviewStatus: string;
  reviewedBy?: string | null;
  scope?: string;
  files: FixtureFile[];
  oracles: Oracle[];
  languageCoverage?: LanguageCoverage[];
  pendingCoverage?: string[];
};

export const fixtureRoot = new URL("../tests/fixtures/", import.meta.url);

export type VerifyFixturesOptions = {
  /** Fixture directory. Defaults to this script's tests/fixtures directory. */
  root?: URL | string;
  /** A manifest override for validation and negative tests. Fixture files still come from root. */
  manifest?: unknown;
};

const supportedLanguages: FixtureLanguage[] = ["javascript", "typescript", "php"];
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

function isFiniteInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value);
}

function isSafeFixturePath(path: unknown): path is string {
  if (typeof path !== "string" || path.length === 0 || path.startsWith("/")) return false;
  // Fixture paths are URL-relative and ASCII. Reject encoded separators/traversal and
  // platform-specific separators before URL or filesystem normalization can hide them.
  if (!/^[A-Za-z0-9._/-]+$/.test(path) || path.includes("\\")) return false;
  const parts = path.split("/");
  return parts.every((part) => part !== "" && part !== "." && part !== "..");
}

function normalizeRoot(root: URL | string | undefined): URL {
  if (root === undefined) return fixtureRoot;
  if (root instanceof URL) {
    if (root.protocol !== "file:") fail("FIXTURE_ROOT_INVALID");
    const url = new URL(root.href);
    if (!url.pathname.endsWith("/")) url.pathname += "/";
    return url;
  }
  const path = resolve(root);
  return pathToFileURL(path.endsWith(sep) ? path : `${path}${sep}`);
}

function validateManifest(value: unknown): FixtureManifest {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isNonEmptyString(value.reviewStatus) || !isNonEmptyString(value.scope)) {
    fail("FIXTURE_MANIFEST_INVALID");
  }
  if (value.reviewedBy !== null && !isNonEmptyString(value.reviewedBy)) fail("FIXTURE_REVIEW_METADATA_INVALID");
  if (value.reviewStatus === "DRAFT_AWAITING_TEAM_REVIEW" && value.reviewedBy !== null) fail("FIXTURE_REVIEW_METADATA_INVALID");
  if (!Array.isArray(value.files) || value.files.length === 0 || !Array.isArray(value.oracles)) fail("FIXTURE_MANIFEST_INVALID");
  if (value.pendingCoverage !== undefined && (!Array.isArray(value.pendingCoverage) || !value.pendingCoverage.every(isNonEmptyString))) {
    fail("FIXTURE_MANIFEST_INVALID");
  }

  const filePaths = new Set<string>();
  for (const rawFile of value.files) {
    if (!isRecord(rawFile) || !isSafeFixturePath(rawFile.path)) fail("FIXTURE_PATH_INVALID");
    if (filePaths.has(rawFile.path)) fail("FIXTURE_PATH_DUPLICATE");
    filePaths.add(rawFile.path);
    if (!/^[a-f0-9]{64}$/.test(String(rawFile.sha256)) || !isFiniteInteger(rawFile.sizeBytes) || rawFile.sizeBytes < 0) {
      fail("FIXTURE_FILE_METADATA_INVALID");
    }
    const language = rawFile.language;
    if (language !== null && !supportedLanguages.includes(language as FixtureLanguage)) fail("FIXTURE_FILE_METADATA_INVALID");
    if (language === null ? rawFile.syntaxValid !== null : typeof rawFile.syntaxValid !== "boolean") fail("FIXTURE_FILE_METADATA_INVALID");
  }

  const files = new Map((value.files as FixtureFile[]).map((file) => [file.path, file]));
  const oracleKeys = new Set<string>();
  for (const rawOracle of value.oracles) {
    if (!isRecord(rawOracle) || !isSafeFixturePath(rawOracle.path) || !isNonEmptyString(rawOracle.kind) ||
      !isNonEmptyString(rawOracle.target) || !isNonEmptyString(rawOracle.snippet)) fail("ORACLE_METADATA_INVALID");
    const file = files.get(rawOracle.path);
    if (!file) fail("ORACLE_FILE_UNKNOWN");
    if (!file.language) fail("ORACLE_LANGUAGE_UNKNOWN");
    if (rawOracle.role !== "declaration" && rawOracle.role !== "reference" && rawOracle.role !== "context") fail("ORACLE_METADATA_INVALID");
    if (rawOracle.role === "reference") {
      if (rawOracle.resolution !== "resolved" && rawOracle.resolution !== "unresolved") fail("ORACLE_METADATA_INVALID");
      if (rawOracle.resolution === "unresolved" && !isNonEmptyString(rawOracle.reason)) fail("ORACLE_REASON_REQUIRED");
      if (rawOracle.resolution === "resolved" && rawOracle.reason !== undefined) fail("ORACLE_METADATA_INVALID");
    } else if (rawOracle.resolution !== undefined || rawOracle.reason !== undefined) {
      fail("ORACLE_METADATA_INVALID");
    }
    if (rawOracle.kind === "Unresolved" && (rawOracle.role !== "reference" || rawOracle.resolution !== "unresolved")) fail("ORACLE_METADATA_INVALID");
    const evidence = rawOracle.evidence;
    if (!isRecord(evidence)) fail("ORACLE_EVIDENCE_INVALID");
    const coordinates = ["startByte", "endByte", "startLine", "endLine", "startColumn", "endColumn"] as const;
    for (const key of coordinates) {
      const coordinate = evidence[key];
      if (!isFiniteInteger(coordinate)) fail("ORACLE_EVIDENCE_INVALID");
      if (key.endsWith("Line") || key.endsWith("Column")) {
        if (coordinate < 1) fail("ORACLE_EVIDENCE_INVALID");
      } else if (coordinate < 0) fail("ORACLE_EVIDENCE_INVALID");
    }
    if ((evidence.startByte as number) >= (evidence.endByte as number)) fail("ORACLE_EVIDENCE_INVALID");
    const key = JSON.stringify([rawOracle.path, rawOracle.kind, rawOracle.target, rawOracle.role, evidence.startByte, evidence.endByte]);
    if (oracleKeys.has(key)) fail("ORACLE_DUPLICATE");
    oracleKeys.add(key);
  }

  if (!Array.isArray(value.languageCoverage)) fail("FIXTURE_LANGUAGE_COVERAGE_INVALID");
  const coverageLanguages = new Set<FixtureLanguage>();
  for (const rawCoverage of value.languageCoverage) {
    if (!isRecord(rawCoverage) || !supportedLanguages.includes(rawCoverage.language as FixtureLanguage)) fail("FIXTURE_LANGUAGE_COVERAGE_INVALID");
    const language = rawCoverage.language as FixtureLanguage;
    if (coverageLanguages.has(language)) fail("FIXTURE_LANGUAGE_COVERAGE_DUPLICATE");
    coverageLanguages.add(language);
    if (!isRecord(rawCoverage.minimumOracles) || !isFiniteInteger(rawCoverage.minimumOracles.declarations) ||
      rawCoverage.minimumOracles.declarations < 1 || !isFiniteInteger(rawCoverage.minimumOracles.references) || rawCoverage.minimumOracles.references < 1) {
      fail("FIXTURE_LANGUAGE_COVERAGE_INVALID");
    }
    if (!Array.isArray(rawCoverage.limitations) || rawCoverage.limitations.length === 0) fail("FIXTURE_LANGUAGE_LIMITATION_REQUIRED");
    for (const rawLimitation of rawCoverage.limitations) {
      if (!isRecord(rawLimitation) || !isSafeFixturePath(rawLimitation.path) || !isNonEmptyString(rawLimitation.target) || !isNonEmptyString(rawLimitation.reason)) {
        fail("FIXTURE_LANGUAGE_COVERAGE_INVALID");
      }
      const file = files.get(rawLimitation.path);
      if (!file || file.language !== language) fail("FIXTURE_LANGUAGE_COVERAGE_INVALID");
      const matchingOracle = (value.oracles as Oracle[]).some((oracle) => oracle.path === rawLimitation.path && oracle.target === rawLimitation.target &&
        oracle.role === "reference" && oracle.resolution === "unresolved" && oracle.reason === rawLimitation.reason);
      if (!matchingOracle) fail("FIXTURE_LANGUAGE_LIMITATION_ORACLE_MISSING");
    }
  }
  if (supportedLanguages.some((language) => !coverageLanguages.has(language))) fail("FIXTURE_LANGUAGE_COVERAGE_MISSING");
  for (const oracle of value.oracles as Oracle[]) {
    if (oracle.role === "reference" && oracle.resolution === "unresolved") {
      const coverage = (value.languageCoverage as LanguageCoverage[]).find((item) => item.language === files.get(oracle.path)?.language);
      const hasLimitation = coverage?.limitations.some((item) => item.path === oracle.path && item.target === oracle.target && item.reason === oracle.reason);
      if (!hasLimitation) fail("FIXTURE_LANGUAGE_LIMITATION_ORACLE_MISSING");
    }
  }

  const counts = new Map<FixtureLanguage, { declarations: number; references: number }>();
  for (const language of supportedLanguages) counts.set(language, { declarations: 0, references: 0 });
  for (const oracle of value.oracles as Oracle[]) {
    const language = files.get(oracle.path)!.language as FixtureLanguage;
    if (oracle.role === "declaration") counts.get(language)!.declarations += 1;
    if (oracle.role === "reference") counts.get(language)!.references += 1;
  }
  for (const coverage of value.languageCoverage as LanguageCoverage[]) {
    const count = counts.get(coverage.language)!;
    if (count.declarations < coverage.minimumOracles.declarations || count.references < coverage.minimumOracles.references) {
      fail(`FIXTURE_LANGUAGE_ORACLE_MINIMUM_MISSING: ${coverage.language}`);
    }
  }

  return value as unknown as FixtureManifest;
}

function positionAt(data: Buffer, byte: number): { line: number; column: number } {
  let prefix: string;
  try {
    prefix = utf8.decode(data.subarray(0, byte));
  } catch {
    fail("ORACLE_UTF8_BOUNDARY_INVALID");
  }
  const lines = prefix.split("\n");
  return { line: lines.length, column: Array.from(lines.at(-1)!).length + 1 };
}

function isInside(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return relativePath !== "" && relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath);
}

async function readFixture(root: string, path: string): Promise<Buffer> {
  if (!isSafeFixturePath(path)) fail("FIXTURE_PATH_INVALID");
  const candidate = resolve(root, ...path.split("/"));
  let actualPath: string;
  try {
    actualPath = await realpath(candidate);
  } catch {
    fail("FIXTURE_FILE_MISSING");
  }
  if (!isInside(root, actualPath)) fail("FIXTURE_PATH_INVALID");
  return readFile(actualPath);
}

export async function verifyFixtures(options: VerifyFixturesOptions = {}): Promise<FixtureManifest> {
  const rootUrl = normalizeRoot(options.root);
  let root: string;
  try {
    root = await realpath(fileURLToPath(rootUrl));
  } catch {
    fail("FIXTURE_ROOT_INVALID");
  }
  const rawManifest = options.manifest === undefined
    ? JSON.parse(await readFile(resolve(root, "manifest.json"), "utf8")) as unknown
    : options.manifest;
  const manifest = validateManifest(rawManifest);
  const contents = new Map<string, Buffer>();
  for (const item of manifest.files) {
    const data = await readFixture(root, item.path);
    try {
      utf8.decode(data);
    } catch {
      fail(`FIXTURE_UTF8_INVALID: ${item.path}`);
    }
    if (data.length !== item.sizeBytes || createHash("sha256").update(data).digest("hex") !== item.sha256) {
      fail(`FIXTURE_HASH_MISMATCH: ${item.path}`);
    }
    contents.set(item.path, data);
  }
  for (const oracle of manifest.oracles) {
    const data = contents.get(oracle.path);
    if (!data) fail("ORACLE_FILE_UNKNOWN");
    const e = oracle.evidence;
    if (e.startByte < 0 || e.endByte > data.length || e.startByte >= e.endByte) fail("ORACLE_BOUNDS_INVALID");
    let snippet: string;
    try {
      snippet = utf8.decode(data.subarray(e.startByte, e.endByte));
    } catch {
      fail("ORACLE_UTF8_BOUNDARY_INVALID");
    }
    if (snippet !== oracle.snippet) fail("ORACLE_SNIPPET_MISMATCH");
    for (const [byte, line, column] of [[e.startByte, e.startLine, e.startColumn], [e.endByte, e.endLine, e.endColumn]]) {
      const actual = positionAt(data, byte);
      if (actual.line !== line || actual.column !== column) fail("ORACLE_POSITION_MISMATCH");
    }
  }
  return manifest;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const manifest = await verifyFixtures();
  console.log(JSON.stringify({ files: manifest.files.length, oracles: manifest.oracles.length, integrity: "PASS", semanticAcceptance: "NOT_RUN", reviewStatus: manifest.reviewStatus }));
}
