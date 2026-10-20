import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  canonicalizeCcm,
  createEdgeId,
  createNodeId,
  EDGE_KINDS,
  type CcmFile,
  type CcmEdge,
  type CcmLimitation,
  type CcmNode,
  type CcmSnapshot,
  type CcmV1,
  type EdgeKind,
  type EvidenceSpan,
  type JsonValue,
  type NodeKind,
  UNRESOLVED_REASONS,
  type UnresolvedReason,
} from "@sage/contracts";

export { parsePhp } from "./probe.ts";

const ANALYZER_VERSION = "0.1.0";
const RESOLVER_VERSION = "0.1.0";
const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const PHP_SCRIPT = fileURLToPath(new URL("../bin/declarations.php", import.meta.url));

interface PhpImportFact {
  name: string;
  alias: string;
  kind: "class" | "function" | "const";
  startByte: number;
  endByte: number;
}

interface PhpDeclarationFact {
  kind: "Class" | "Interface" | "Function" | "Method";
  name: string;
  qualifiedName: string;
  startByte: number;
  endByte: number;
  parentQualifiedName: string | null;
  parentStartByte: number | null;
  parentEndByte: number | null;
  attributes: Record<string, JsonValue>;
}

interface PhpReferenceFact {
  sourceQualifiedName: string;
  sourceKind: string;
  kind: EdgeKind;
  targetKind: string;
  targetQualifiedName: string | null;
  fallbackQualifiedName: string | null;
  startByte: number;
  endByte: number;
  sourceStartByte: number;
  sourceEndByte: number;
  expression: string;
  resolutionHint: string | null;
  reason: UnresolvedReason | null;
}

interface PhpPropertyFact {
  name: string;
  qualifiedName: string;
  parentQualifiedName: string;
  parentStartByte: number;
  parentEndByte: number;
  startByte: number;
  endByte: number;
  attributes: Record<string, JsonValue>;
}

interface PhpNamespaceFact {
  name: string;
  startByte: number | null;
  endByte: number | null;
  imports: PhpImportFact[];
  declarations: PhpDeclarationFact[];
}

interface PhpParseResult {
  valid: boolean;
  parserVersion: string;
  phpVersion: string;
  statementKinds: string[];
  namespaces: PhpNamespaceFact[];
  references: PhpReferenceFact[];
  properties: PhpPropertyFact[];
  referenceLimitations: string[];
  limitations: string[];
  diagnostics: Array<{ message: string; line: number; startByte: number | null }>;
}

export interface DeclarationAnalysisInput {
  snapshot: CcmSnapshot;
  sources: Readonly<Record<string, Uint8Array>>;
  signal?: AbortSignal;
}

export interface ReferenceAnalysisInput extends DeclarationAnalysisInput {
  /** Snapshot-relative supplied config bytes; only composer.json is inspected, as JSON data. */
  configurationSources?: Readonly<Record<string, Uint8Array>>;
}

export interface DeclarationDiagnostic {
  path: string;
  code: "PHP_PARSE_ERROR" | "INVALID_UTF8" | "PHP_PARSER_UNAVAILABLE" | "PHP_PARSER_INVALID_RESPONSE";
  message: string;
  startByte: number | null;
  line: number | null;
  column: number | null;
}

export interface DeclarationAnalysisResult {
  status: "complete" | "partial" | "failed";
  ccm: CcmV1 | null;
  canonicalJson: string | null;
  contentSha256: string | null;
  diagnostics: DeclarationDiagnostic[];
  errorCode: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
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
  return path.length > 0 && !path.startsWith("/") && !path.includes("\\") && !path.includes("\0") &&
    path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function positionAt(bytes: Uint8Array, offset: number): { line: number; column: number } {
  const prefix = UTF8.decode(bytes.subarray(0, offset));
  const lines = prefix.split("\n");
  return { line: lines.length, column: Array.from(lines.at(-1) ?? "").length + 1 };
}

function evidence(path: string, fileSha256: string, bytes: Uint8Array, startByte: number, endByte: number): EvidenceSpan {
  const start = positionAt(bytes, startByte);
  const end = positionAt(bytes, endByte);
  return {
    filePath: path,
    fileSha256,
    startByte,
    endByte,
    startLine: start.line,
    endLine: end.line,
    startColumn: start.column,
    endColumn: end.column,
    role: "declaration",
  };
}

function diagnostic(
  path: string,
  bytes: Uint8Array,
  code: DeclarationDiagnostic["code"],
  message: string,
  startByte: number | null = null,
  line: number | null = null,
): DeclarationDiagnostic {
  if (startByte === null || startByte < 0 || startByte > bytes.byteLength) {
    return { path, code, message, startByte: null, line, column: null };
  }
  try {
    return { path, code, message, startByte, ...positionAt(bytes, startByte) };
  } catch {
    return { path, code, message, startByte: null, line, column: null };
  }
}

function addLimitation(limitations: CcmLimitation[], path: string | null, stage: string, reason: string): void {
  if (!limitations.some((item) => item.path === path && item.stage === stage && item.reason === reason)) {
    limitations.push({ path, stage, reason });
  }
}

function parseWithPhp(bytes: Uint8Array, signal?: AbortSignal): Promise<PhpParseResult> {
  return new Promise((resolve, reject) => {
    const child = execFile("php", [PHP_SCRIPT], { timeout: 10000, maxBuffer: 4 * 1024 * 1024, signal }, (error, stdout) => {
      if (error) {
        if (signal?.aborted) {
          reject(signal.reason ?? error);
          return;
        }
        reject(new Error("PHP_PARSER_UNAVAILABLE"));
        return;
      }
      try {
        const parsed = JSON.parse(stdout) as PhpParseResult;
        if (!parsed || typeof parsed.valid !== "boolean" || !Array.isArray(parsed.namespaces) ||
          !Array.isArray(parsed.limitations) || !Array.isArray(parsed.references) || !Array.isArray(parsed.properties) ||
          !Array.isArray(parsed.referenceLimitations) || typeof parsed.parserVersion !== "string" || typeof parsed.phpVersion !== "string") {
          reject(new Error("PHP_PARSER_INVALID_RESPONSE"));
          return;
        }
        resolve(parsed);
      } catch {
        reject(new Error("PHP_PARSER_INVALID_RESPONSE"));
      }
    });
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(Buffer.from(bytes));
  });
}

function validSnapshot(value: unknown): value is CcmSnapshot {
  if (!isRecord(value)) return false;
  const repository = value.repository;
  const branch = value.branch;
  const commitSha = value.commitSha;
  return typeof repository === "string" && repository.trim().length > 0 &&
    (branch === null || (typeof branch === "string" && branch.trim().length > 0)) &&
    typeof commitSha === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(commitSha);
}

function nodeFromFact(
  fact: PhpDeclarationFact,
  path: string,
  bytes: Uint8Array,
  fileSha256: string,
  snapshotSha: string,
  parentId: string | null,
): CcmNode {
  const location = evidence(path, fileSha256, bytes, fact.startByte, fact.endByte);
  return {
    id: createNodeId({
      snapshotSha,
      language: "php",
      filePath: path,
      kind: fact.kind as NodeKind,
      qualifiedName: fact.qualifiedName,
      startByte: location.startByte,
      endByte: location.endByte,
    }),
    kind: fact.kind,
    name: fact.name,
    qualifiedName: fact.qualifiedName,
    language: "php",
    filePath: path,
    location,
    parentId,
    origin: "source",
    signature: null,
    attributes: fact.attributes,
  };
}

function isImportFact(value: unknown, bytes: Uint8Array): value is PhpImportFact {
  if (!isRecord(value)) return false;
  return typeof value.name === "string" && value.name.length > 0 && typeof value.alias === "string" && value.alias.length > 0 &&
    (value.kind === "class" || value.kind === "function" || value.kind === "const") &&
    Number.isSafeInteger(value.startByte) && Number.isSafeInteger(value.endByte) &&
    (value.startByte as number) >= 0 && (value.startByte as number) < (value.endByte as number) &&
    (value.endByte as number) <= bytes.byteLength;
}

function isReferenceFact(value: unknown, bytes: Uint8Array): value is PhpReferenceFact {
  if (!isRecord(value)) return false;
  return typeof value.sourceQualifiedName === "string" && typeof value.sourceKind === "string" &&
    typeof value.kind === "string" && (EDGE_KINDS as readonly string[]).includes(value.kind) &&
    typeof value.targetKind === "string" &&
    (value.targetQualifiedName === null || typeof value.targetQualifiedName === "string") &&
    (value.fallbackQualifiedName === null || typeof value.fallbackQualifiedName === "string") &&
    Number.isSafeInteger(value.startByte) && Number.isSafeInteger(value.endByte) &&
    (value.startByte as number) >= 0 && (value.startByte as number) < (value.endByte as number) &&
    (value.endByte as number) <= bytes.byteLength &&
    Number.isSafeInteger(value.sourceStartByte) && Number.isSafeInteger(value.sourceEndByte) &&
    (value.sourceStartByte as number) >= 0 && (value.sourceStartByte as number) < (value.sourceEndByte as number) &&
    (value.sourceEndByte as number) <= bytes.byteLength &&
    typeof value.expression === "string" &&
    (value.resolutionHint === null || typeof value.resolutionHint === "string") &&
    (value.reason === null || (typeof value.reason === "string" && (UNRESOLVED_REASONS as readonly string[]).includes(value.reason)));
}

function isPropertyFact(value: unknown, bytes: Uint8Array): value is PhpPropertyFact {
  if (!isRecord(value) || !isRecord(value.attributes)) return false;
  return typeof value.name === "string" && value.name.length > 0 && typeof value.qualifiedName === "string" &&
    typeof value.parentQualifiedName === "string" && Number.isSafeInteger(value.parentStartByte) &&
    Number.isSafeInteger(value.parentEndByte) && Number.isSafeInteger(value.startByte) && Number.isSafeInteger(value.endByte) &&
    (value.startByte as number) >= 0 && (value.startByte as number) < (value.endByte as number) &&
    (value.endByte as number) <= bytes.byteLength && (value.parentStartByte as number) >= 0 &&
    (value.parentStartByte as number) < (value.parentEndByte as number) && (value.parentEndByte as number) <= bytes.byteLength;
}

function referenceEvidence(path: string, fileHash: string, bytes: Uint8Array, startByte: number, endByte: number): EvidenceSpan {
  return { ...evidence(path, fileHash, bytes, startByte, endByte), role: "reference" };
}

interface Psr4Mapping {
  prefix: string;
  directory: string;
  composerPath: string;
}

interface ComposerConfiguration {
  mappings: Psr4Mapping[];
  hash: string;
}

function resolveComposerDirectory(composerPath: string, configuredDirectory: string): string | null {
  if (configuredDirectory.startsWith("/") || configuredDirectory.includes("\\") || configuredDirectory.includes("\0")) return null;
  const parent = composerPath.includes("/") ? composerPath.slice(0, composerPath.lastIndexOf("/")) : "";
  const segments = parent === "" ? [] : parent.split("/");
  for (const segment of configuredDirectory.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") return null;
    segments.push(segment);
  }
  return segments.join("/");
}

function parseComposerConfiguration(
  sources: Readonly<Record<string, Uint8Array>>,
  limitations: CcmLimitation[],
): ComposerConfiguration {
  const mappings: Psr4Mapping[] = [];
  const hashes: Array<{ path: string; sha256: string }> = [];
  for (const [path, bytes] of Object.entries(sources).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    if (path.slice(path.lastIndexOf("/") + 1).toLowerCase() !== "composer.json") continue;
    const fileHash = sha256(bytes);
    hashes.push({ path, sha256: fileHash });
    if (bytes.byteLength > 1024 * 1024) {
      addLimitation(limitations, null, "resolve", `Composer mapping file ${path} exceeded the 1 MiB static JSON limit and was ignored.`);
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(UTF8.decode(bytes));
    } catch {
      addLimitation(limitations, null, "resolve", `Composer mapping file ${path} was not valid UTF-8 JSON and was ignored.`);
      continue;
    }
    if (!isRecord(parsed)) {
      addLimitation(limitations, null, "resolve", `Composer mapping file ${path} did not contain a JSON object and was ignored.`);
      continue;
    }
    for (const sectionName of ["autoload", "autoload-dev"] as const) {
      const section = parsed[sectionName];
      if (section === undefined) continue;
      if (!isRecord(section)) {
        addLimitation(limitations, null, "resolve", `Composer ${sectionName} in ${path} was not an object; its mappings were ignored.`);
        continue;
      }
      if (section.classmap !== undefined) {
        addLimitation(limitations, null, "resolve", `Composer ${sectionName}.classmap in ${path} is not used to prove PHP declarations; symbol nodes remain required.`);
      }
      if (section["psr-0"] !== undefined) {
        addLimitation(limitations, null, "resolve", `Composer ${sectionName}.psr-0 in ${path} is not interpreted by this resolver.`);
      }
      if (section.files !== undefined) {
        addLimitation(limitations, null, "resolve", `Composer ${sectionName}.files in ${path} is not loaded or executed by this resolver.`);
      }
      const psr4 = section["psr-4"];
      if (psr4 === undefined) continue;
      if (!isRecord(psr4)) {
        addLimitation(limitations, null, "resolve", `Composer ${sectionName}.psr-4 in ${path} was not an object; its mappings were ignored.`);
        continue;
      }
      for (const [prefix, configuredDirectories] of Object.entries(psr4)) {
        const directories = typeof configuredDirectories === "string" ? [configuredDirectories]
          : Array.isArray(configuredDirectories) && configuredDirectories.every((item) => typeof item === "string")
            ? configuredDirectories as string[] : null;
        if (!directories || (prefix !== "" && !prefix.endsWith("\\"))) {
          addLimitation(limitations, null, "resolve", `Composer PSR-4 mapping ${prefix} in ${path} was invalid and ignored.`);
          continue;
        }
        for (const directory of directories) {
          const resolvedDirectory = resolveComposerDirectory(path, directory);
          if (resolvedDirectory === null) {
            addLimitation(limitations, null, "resolve", `Composer PSR-4 directory ${directory} in ${path} was unsafe and ignored.`);
            continue;
          }
          mappings.push({ prefix, directory: resolvedDirectory, composerPath: path });
        }
      }
    }
  }
  mappings.sort((left, right) => right.prefix.length - left.prefix.length || left.prefix.localeCompare(right.prefix) || left.directory.localeCompare(right.directory));
  return { mappings, hash: sha256(JSON.stringify(hashes)) };
}

function composerCandidatePaths(qualifiedName: string, config: ComposerConfiguration): string[] {
  const matches = config.mappings.filter((mapping) => qualifiedName.startsWith(mapping.prefix));
  if (matches.length === 0) return [];
  const longest = Math.max(...matches.map((mapping) => mapping.prefix.length));
  const namespaced = qualifiedName.slice(longest).replaceAll("\\", "/");
  return matches.filter((mapping) => mapping.prefix.length === longest).map((mapping) =>
    [mapping.directory, `${namespaced}.php`].filter(Boolean).join("/"));
}

function phpNameKey(value: string): string {
  return value.replace(/^\\+/, "").toLocaleLowerCase("en-US");
}

function allowedClassKinds(referenceKind: EdgeKind): readonly NodeKind[] {
  return referenceKind === "IMPLEMENTS" ? ["Interface"] : referenceKind === "EXTENDS"
    ? ["Class", "Interface"] : referenceKind === "INSTANTIATES" ? ["Class"] : ["Class", "Interface"];
}

interface Resolution {
  node: CcmNode | null;
  reason: UnresolvedReason | null;
}

function resolvePhpReferences(
  ccm: CcmV1,
  parsedFiles: ReadonlyMap<string, PhpParseResult>,
  sourceBytes: Readonly<Record<string, Uint8Array>>,
  configuration: ComposerConfiguration,
  limitations: CcmLimitation[],
): CcmV1 {
  const nodes = [...ccm.nodes];
  const edges: CcmEdge[] = [];
  const unresolvedNodes = new Map<string, CcmNode>();
  const classes = (): CcmNode[] => nodes.filter((node) => node.language === "php" && (node.kind === "Class" || node.kind === "Interface"));
  const functions = (): CcmNode[] => nodes.filter((node) => node.language === "php" && node.kind === "Function");
  const methods = (): CcmNode[] => nodes.filter((node) => node.language === "php" && node.kind === "Method");

  for (const [path, parsed] of parsedFiles) {
    const bytes = sourceBytes[path];
    if (!bytes) continue;
    const file = ccm.files.find((item) => item.path === path);
    if (!file) continue;
    for (const raw of parsed.properties as unknown[]) {
      if (!isPropertyFact(raw, bytes)) {
        addLimitation(limitations, path, "resolve", "One or more PHP property references had invalid declaration spans and were omitted.");
        continue;
      }
      const parent = nodes.find((node) => node.language === "php" && (node.kind === "Class" || node.kind === "Interface") &&
        node.filePath === path && node.qualifiedName === raw.parentQualifiedName && node.location?.startByte === raw.parentStartByte &&
        node.location?.endByte === raw.parentEndByte);
      if (!parent || !parent.location || raw.startByte < parent.location.startByte || raw.endByte > parent.location.endByte) {
        addLimitation(limitations, path, "resolve", "A PHP property could not be attached to its exact containing class declaration and was omitted.");
        continue;
      }
      const location = evidence(path, file.sha256, bytes, raw.startByte, raw.endByte);
      nodes.push({
        id: createNodeId({ snapshotSha: ccm.snapshot.commitSha, language: "php", filePath: path, kind: "Property",
          qualifiedName: raw.qualifiedName, startByte: location.startByte, endByte: location.endByte }),
        kind: "Property", name: raw.name, qualifiedName: raw.qualifiedName, language: "php", filePath: path,
        location, parentId: parent.id, origin: "source", signature: null, attributes: raw.attributes,
      });
    }
  }

  const sourceFor = (path: string, fact: PhpReferenceFact): CcmNode | null => {
    const qname = fact.sourceKind === "Module" && fact.sourceQualifiedName.startsWith("@@FILE_MODULE@@")
      ? path + fact.sourceQualifiedName.slice("@@FILE_MODULE@@".length)
      : fact.sourceQualifiedName === "@@FILE_MODULE@@" || fact.sourceQualifiedName === "" ? path : fact.sourceQualifiedName;
    const kind = fact.sourceKind as NodeKind;
    return nodes.find((node) => node.language === "php" && node.filePath === path && node.kind === kind && node.qualifiedName === qname &&
      node.location?.startByte === fact.sourceStartByte && node.location?.endByte === fact.sourceEndByte) ?? null;
  };

  const findClasses = (name: string, kinds: readonly NodeKind[] = ["Class", "Interface"]): CcmNode[] =>
    classes().filter((node) => kinds.includes(node.kind) && phpNameKey(node.qualifiedName) === phpNameKey(name));
  const findFunctions = (name: string): CcmNode[] =>
    functions().filter((node) => phpNameKey(node.qualifiedName) === phpNameKey(name));
  const parentClassReferences = new Map<string, Array<{ source: CcmNode; targetName: string }>>();

  const normalizeFact = (path: string, raw: unknown, bytes: Uint8Array): PhpReferenceFact | null => {
    if (!isReferenceFact(raw, bytes)) {
      addLimitation(limitations, path, "resolve", "One or more PHP references had invalid evidence or AST metadata and were omitted.");
      return null;
    }
    const sourceQualifiedName = raw.sourceQualifiedName.startsWith("@@FILE_MODULE@@")
      ? path + raw.sourceQualifiedName.slice("@@FILE_MODULE@@".length)
      : raw.sourceQualifiedName === "@@FILE_MODULE@@" || raw.sourceQualifiedName === "" ? path : raw.sourceQualifiedName;
    return { ...raw, sourceQualifiedName };
  };

  const allFacts: Array<{ path: string; fact: PhpReferenceFact; source: CcmNode }> = [];
  for (const [path, parsed] of parsedFiles) {
    const bytes = sourceBytes[path];
    if (!bytes) continue;
    for (const raw of parsed.references as unknown[]) {
      const fact = normalizeFact(path, raw, bytes);
      if (!fact) continue;
      const source = sourceFor(path, fact);
      if (!source) {
        addLimitation(limitations, path, "resolve", `A ${fact.kind} reference from ${fact.sourceQualifiedName} had no exact source declaration node.`);
        continue;
      }
      allFacts.push({ path, fact, source });
    }
  }

  const resolveClassSymbol = (name: string, kind: EdgeKind): Resolution => {
    const candidates = findClasses(name, allowedClassKinds(kind));
    if (candidates.length === 1) return { node: candidates[0]!, reason: null };
    if (candidates.length > 1) return { node: null, reason: "AMBIGUOUS_SYMBOL" };
    return { node: null, reason: "EXTERNAL_DEPENDENCY" };
  };

  const resolveFunctionSymbol = (name: string, fallback: string | null): Resolution => {
    const first = findFunctions(name);
    if (first.length === 1) return { node: first[0]!, reason: null };
    if (first.length > 1) return { node: null, reason: "AMBIGUOUS_SYMBOL" };
    if (fallback !== null) {
      const global = findFunctions(fallback);
      if (global.length === 1) return { node: global[0]!, reason: null };
      if (global.length > 1) return { node: null, reason: "AMBIGUOUS_SYMBOL" };
    }
    return { node: null, reason: "EXTERNAL_DEPENDENCY" };
  };

  // Establish parent links only from declaration-backed class/interface facts.
  for (const entry of allFacts) {
    if (entry.fact.kind !== "EXTENDS" || !entry.fact.targetQualifiedName) continue;
    const target = resolveClassSymbol(entry.fact.targetQualifiedName, "EXTENDS");
    if (!target.node) continue;
    const list = parentClassReferences.get(entry.source.id) ?? [];
    list.push({ source: entry.source, targetName: target.node.qualifiedName });
    parentClassReferences.set(entry.source.id, list);
  }

  const findMethodsInClass = (classNode: CcmNode, methodName: string, visited = new Set<string>()): { nodes: CcmNode[]; ambiguous: boolean } => {
    if (visited.has(classNode.id)) return { nodes: [], ambiguous: true };
    const nextVisited = new Set(visited).add(classNode.id);
    const direct = methods().filter((node) => node.parentId === classNode.id && node.name.toLocaleLowerCase("en-US") === methodName.toLocaleLowerCase("en-US"));
    if (direct.length > 0) return { nodes: direct, ambiguous: direct.length > 1 };
    const parents = parentClassReferences.get(classNode.id) ?? [];
    const resolved: CcmNode[] = [];
    let ambiguous = parents.length > 1;
    for (const parent of parents) {
      const parentNodes = findClasses(parent.targetName);
      if (parentNodes.length !== 1) {
        ambiguous = ambiguous || parentNodes.length > 1;
        continue;
      }
      const inherited = findMethodsInClass(parentNodes[0]!, methodName, nextVisited);
      resolved.push(...inherited.nodes.filter((method) => method.attributes.visibility !== "private"));
      ambiguous = ambiguous || inherited.ambiguous;
    }
    return { nodes: [...new Map(resolved.map((node) => [node.id, node])).values()], ambiguous };
  };

  const isSameOrSubclass = (candidate: CcmNode, expectedParent: CcmNode, visited = new Set<string>()): boolean => {
    if (candidate.id === expectedParent.id) return true;
    if (visited.has(candidate.id)) return false;
    const nextVisited = new Set(visited).add(candidate.id);
    for (const parent of parentClassReferences.get(candidate.id) ?? []) {
      const parents = findClasses(parent.targetName, ["Class"]);
      if (parents.length === 1 && isSameOrSubclass(parents[0]!, expectedParent, nextVisited)) return true;
    }
    return false;
  };

  const canAccessMethod = (entry: { fact: PhpReferenceFact; source: CcmNode }, method: CcmNode, targetClass: CcmNode): boolean => {
    const visibility = method.attributes.visibility;
    if (visibility !== "private" && visibility !== "protected") return true;
    const owner = ownerClass(entry.source);
    const declaringClass = method.parentId ? nodes.find((node) => node.id === method.parentId) : undefined;
    if (!owner || !declaringClass) return false;
    if (visibility === "private") return owner.id === declaringClass.id;
    if (owner.id === declaringClass.id) return true;
    if (!isSameOrSubclass(owner, declaringClass)) return false;
    if (entry.fact.resolutionHint === "parent-static" || entry.fact.resolutionHint === "instance-this" ||
      entry.fact.resolutionHint === "late-static") return true;
    if (entry.fact.resolutionHint === "typed-receiver") return isSameOrSubclass(targetClass, owner);
    if (entry.fact.resolutionHint === "static") return isSameOrSubclass(owner, targetClass);
    return false;
  };

  const canAccessProperty = (entry: { fact: PhpReferenceFact; source: CcmNode }, property: CcmNode, targetClass: CcmNode): boolean => {
    const visibility = property.attributes.visibility;
    if (visibility !== "private" && visibility !== "protected") return true;
    const owner = ownerClass(entry.source);
    const declaringClass = property.parentId ? nodes.find((node) => node.id === property.parentId) : undefined;
    if (!owner || !declaringClass) return false;
    if (visibility === "private") return owner.id === declaringClass.id;
    if (owner.id === declaringClass.id) return true;
    if (!isSameOrSubclass(owner, declaringClass)) return false;
    if (entry.fact.resolutionHint?.startsWith("parent-static-property") || entry.fact.resolutionHint === "late-static-property") return true;
    if (entry.fact.resolutionHint === "property") return isSameOrSubclass(targetClass, owner);
    if (entry.fact.resolutionHint === "static-property") return isSameOrSubclass(owner, targetClass);
    return false;
  };

  const ownerClass = (source: CcmNode): CcmNode | null => source.kind === "Method" && source.parentId
    ? nodes.find((node) => node.id === source.parentId && (node.kind === "Class" || node.kind === "Interface")) ?? null
    : source.kind === "Class" || source.kind === "Interface" ? source : null;

  const resolveMethodSymbol = (entry: { path: string; fact: PhpReferenceFact; source: CcmNode }): Resolution => {
    const fact = entry.fact;
    const split = fact.targetQualifiedName?.lastIndexOf("::") ?? -1;
    if (split < 0 || fact.targetQualifiedName === null) return { node: null, reason: fact.reason ?? "UNSUPPORTED_CONSTRUCT" };
    let className = fact.targetQualifiedName.slice(0, split);
    const methodName = fact.targetQualifiedName.slice(split + 2);
    if (phpNameKey(className) === "parent") {
      const owner = ownerClass(entry.source);
      if (!owner) return { node: null, reason: "UNSUPPORTED_CONSTRUCT" };
      const parents = parentClassReferences.get(owner.id) ?? [];
      if (parents.length !== 1) return { node: null, reason: parents.length > 1 ? "AMBIGUOUS_SYMBOL" : "EXTERNAL_DEPENDENCY" };
      className = parents[0]!.targetName;
    }
    const classCandidates = findClasses(className);
    if (classCandidates.length !== 1) return { node: null, reason: classCandidates.length > 1 ? "AMBIGUOUS_SYMBOL" : "EXTERNAL_DEPENDENCY" };
    const lookup = findMethodsInClass(classCandidates[0]!, methodName);
    if (lookup.ambiguous || lookup.nodes.length > 1) return { node: null, reason: "AMBIGUOUS_SYMBOL" };
    if (lookup.nodes.length === 0) return { node: null, reason: "UNSUPPORTED_CONSTRUCT" };
    const method = lookup.nodes[0]!;
    if (!canAccessMethod(entry, method, classCandidates[0]!)) return { node: null, reason: "UNSUPPORTED_CONSTRUCT" };
    const dispatchSensitive = fact.resolutionHint === "instance-this" || fact.resolutionHint === "typed-receiver" || fact.resolutionHint === "late-static";
    const sealedDispatch = classCandidates[0]!.attributes.final === true || method.attributes.final === true || method.attributes.visibility === "private";
    if (dispatchSensitive && !sealedDispatch) return { node: null, reason: "AMBIGUOUS_SYMBOL" };
    return { node: method, reason: null };
  };

  const resolvePropertySymbol = (entry: { path: string; fact: PhpReferenceFact; source: CcmNode }): Resolution => {
    const fact = entry.fact;
    const separator = fact.targetQualifiedName?.lastIndexOf(".") ?? -1;
    if (separator < 0 || fact.targetQualifiedName === null) return { node: null, reason: fact.reason ?? "UNKNOWN_RECEIVER" };
    let className = fact.targetQualifiedName.slice(0, separator);
    const propertyName = fact.targetQualifiedName.slice(separator + 1);
    if (phpNameKey(className) === "parent") {
      const owner = ownerClass(entry.source);
      if (!owner) return { node: null, reason: "UNSUPPORTED_CONSTRUCT" };
      const parents = parentClassReferences.get(owner.id) ?? [];
      if (parents.length !== 1) return { node: null, reason: parents.length > 1 ? "AMBIGUOUS_SYMBOL" : "EXTERNAL_DEPENDENCY" };
      className = parents[0]!.targetName;
    }
    const classesFound = findClasses(className, ["Class"]);
    if (classesFound.length !== 1) return { node: null, reason: classesFound.length > 1 ? "AMBIGUOUS_SYMBOL" : "EXTERNAL_DEPENDENCY" };
    const findProperty = (classNode: CcmNode, visited = new Set<string>()): { nodes: CcmNode[]; ambiguous: boolean } => {
      if (visited.has(classNode.id)) return { nodes: [], ambiguous: true };
      const nextVisited = new Set(visited).add(classNode.id);
      const direct = nodes.filter((node) => node.kind === "Property" && node.parentId === classNode.id && node.name === propertyName);
      if (direct.length > 0) return { nodes: direct, ambiguous: direct.length > 1 };
      const parents = parentClassReferences.get(classNode.id) ?? [];
      const inherited: CcmNode[] = [];
      let ambiguous = parents.length > 1;
      for (const parent of parents) {
        const parentNodes = findClasses(parent.targetName, ["Class"]);
        if (parentNodes.length !== 1) {
          ambiguous = ambiguous || parentNodes.length > 1;
          continue;
        }
        const found = findProperty(parentNodes[0]!, nextVisited);
        inherited.push(...found.nodes.filter((property) => property.attributes.visibility !== "private"));
        ambiguous = ambiguous || found.ambiguous;
      }
      return { nodes: [...new Map(inherited.map((node) => [node.id, node])).values()], ambiguous };
    };
    const found = findProperty(classesFound[0]!);
    if (found.ambiguous || found.nodes.length > 1) return { node: null, reason: "AMBIGUOUS_SYMBOL" };
    if (found.nodes.length === 0) return { node: null, reason: "UNSUPPORTED_CONSTRUCT" };
    if (!canAccessProperty(entry, found.nodes[0]!, classesFound[0]!)) return { node: null, reason: "UNSUPPORTED_CONSTRUCT" };
    const isStaticReference = fact.resolutionHint?.includes("static-property") ?? false;
    if (found.nodes[0]!.attributes.static !== isStaticReference) return { node: null, reason: "UNSUPPORTED_CONSTRUCT" };
    const sealed = classesFound[0]!.attributes.final === true || found.nodes[0]!.attributes.visibility === "private";
    if (fact.resolutionHint?.includes("property") && !sealed) return { node: null, reason: "AMBIGUOUS_SYMBOL" };
    return { node: found.nodes[0]!, reason: null };
  };

  const findUnresolvedNode = (fact: PhpReferenceFact): CcmNode => {
    const symbolName = fact.targetQualifiedName ?? fact.expression;
    // Node identity excludes evidence/expression. Reuse the same unresolved
    // symbol node across call sites; target kind must be encoded into its qname
    // only when another kind already owns the same identity.
    const key = `${fact.targetKind}\0${symbolName}`;
    const existing = unresolvedNodes.get(key);
    if (existing) return existing;
    let qualifiedName = symbolName;
    const nodeId = (candidate: string): string => createNodeId({ snapshotSha: ccm.snapshot.commitSha, language: "php", filePath: null,
      kind: "UnresolvedReference", qualifiedName: candidate, startByte: null, endByte: null });
    const collides = (candidate: string): boolean => [...ccm.nodes, ...unresolvedNodes.values()]
      .some((node) => node.kind === "UnresolvedReference" && node.id === nodeId(candidate));
    if (collides(qualifiedName)) {
      qualifiedName = `@${fact.targetKind}:${symbolName}`;
      let suffix = 2;
      while (collides(qualifiedName)) qualifiedName = `@${fact.targetKind}:${symbolName}:${suffix++}`;
    }
    const name = symbolName.split(/[\\/.]/).at(-1) ?? symbolName;
    const node: CcmNode = {
      id: nodeId(qualifiedName),
      kind: "UnresolvedReference", name, qualifiedName, language: "php", filePath: null, location: null,
      parentId: null, origin: "unresolved", signature: null,
      attributes: { observedExpression: fact.expression, targetKind: fact.targetKind },
    };
    unresolvedNodes.set(key, node);
    return node;
  };

  for (const entry of allFacts) {
    const { path, fact, source } = entry;
    const bytes = sourceBytes[path]!;
    const sourceFile = ccm.files.find((file) => file.path === path)!;
    const refEvidence = referenceEvidence(path, sourceFile.sha256, bytes, fact.startByte, fact.endByte);
    let resolution: Resolution;
    if (fact.reason !== null) {
      resolution = { node: null, reason: fact.reason };
    } else if (fact.kind === "CALLS" && fact.targetKind === "Method") {
      resolution = resolveMethodSymbol(entry);
    } else if ((fact.kind === "READS" || fact.kind === "WRITES") && fact.targetKind === "Property") {
      resolution = resolvePropertySymbol(entry);
    } else if (fact.targetKind === "Function" && fact.targetQualifiedName !== null) {
      resolution = resolveFunctionSymbol(fact.targetQualifiedName, fact.fallbackQualifiedName);
    } else if ((fact.targetKind === "Class" || fact.targetKind === "Interface") && fact.targetQualifiedName !== null) {
      resolution = resolveClassSymbol(fact.targetQualifiedName, fact.kind);
    } else {
      resolution = { node: null, reason: "UNSUPPORTED_CONSTRUCT" };
    }

    if (!resolution.node && resolution.reason === "EXTERNAL_DEPENDENCY" && fact.targetQualifiedName !== null &&
      (fact.targetKind === "Class" || fact.targetKind === "Interface")) {
      const candidatePaths = composerCandidatePaths(fact.targetQualifiedName, configuration);
      if (candidatePaths.some((candidatePath) => Object.hasOwn(sourceBytes, candidatePath))) {
        resolution = { node: null, reason: "UNSUPPORTED_CONSTRUCT" };
        addLimitation(limitations, path, "resolve", `Composer PSR-4 maps ${fact.targetQualifiedName} to supplied source bytes without a unique parsed declaration.`);
      }
    }

    let target = resolution.node;
    let edgeResolution: CcmEdge["resolution"] = "Exact";
    let unresolvedReason: UnresolvedReason | null = null;
    if (!target) {
      edgeResolution = "Unresolved";
      unresolvedReason = resolution.reason ?? "UNSUPPORTED_CONSTRUCT";
      target = findUnresolvedNode(fact);
    }
    edges.push({
      id: createEdgeId({ snapshotSha: ccm.snapshot.commitSha, sourceId: source.id, targetId: target.id, kind: fact.kind,
        resolution: edgeResolution, evidence: [refEvidence], unresolvedReason }),
      sourceId: source.id, targetId: target.id, kind: fact.kind, resolution: edgeResolution,
      evidence: [refEvidence], unresolvedReason,
    });
  }

  nodes.push(...unresolvedNodes.values());
  const configHash = sha256(`sage-analyzer-php-static-resolver-v2\n${ccm.provenance.configHash}\n${configuration.hash}\nnikic-php-parser-static-ast-v1\ncomposer-psr4-static-hints-v1`);
  return {
    ...ccm,
    provenance: { ...ccm.provenance, resolver: { name: "sage-analyzer-php-static-resolver", version: "0.2.0" }, configHash },
    nodes,
    edges,
    limitations: [...limitations, ...ccm.limitations].filter((item, index, all) =>
      all.findIndex((candidate) => candidate.path === item.path && candidate.stage === item.stage && candidate.reason === item.reason) === index),
  };
}

function isDeclarationFact(value: unknown, bytes: Uint8Array): value is PhpDeclarationFact {
  if (!isRecord(value) || !isRecord(value.attributes)) return false;
  return ["Class", "Interface", "Function", "Method"].includes(String(value.kind)) &&
    typeof value.name === "string" && value.name.length > 0 && typeof value.qualifiedName === "string" && value.qualifiedName.length > 0 &&
    Number.isSafeInteger(value.startByte) && Number.isSafeInteger(value.endByte) &&
    (value.startByte as number) >= 0 && (value.startByte as number) < (value.endByte as number) &&
    (value.endByte as number) <= bytes.byteLength &&
    (value.parentQualifiedName === null || typeof value.parentQualifiedName === "string") &&
    (value.parentStartByte === null || Number.isSafeInteger(value.parentStartByte)) &&
    (value.parentEndByte === null || Number.isSafeInteger(value.parentEndByte));
}

/** Parse PHP snapshot bytes into deterministic CCM v1 declaration nodes without executing project source. */
async function analyze(input: ReferenceAnalysisInput, includeReferences: boolean): Promise<DeclarationAnalysisResult> {
  const failed = (errorCode: string): DeclarationAnalysisResult => ({
    status: "failed",
    ccm: null,
    canonicalJson: null,
    contentSha256: null,
    diagnostics: [],
    errorCode,
  });

  try {
    input?.signal?.throwIfAborted();
    if (!input || !validSnapshot(input.snapshot) || !isRecord(input.sources)) return failed("ANALYZER_INPUT_INVALID");
    const snapshot = { repository: input.snapshot.repository, branch: input.snapshot.branch, commitSha: input.snapshot.commitSha };
    const sourceEntries = Reflect.ownKeys(input.sources).map((key) => {
      if (typeof key !== "string") throw new Error("ANALYZER_INPUT_INVALID");
      const descriptor = Object.getOwnPropertyDescriptor(input.sources, key);
      if (!descriptor || !(descriptor.value instanceof Uint8Array)) throw new Error("ANALYZER_INPUT_INVALID");
      return [key, new Uint8Array(descriptor.value)] as const;
    }).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    if (sourceEntries.length === 0) return failed("ANALYZER_INPUT_INVALID");

    const configurationSources: Record<string, Uint8Array> = {};
    if (input.configurationSources !== undefined) {
      if (!isRecord(input.configurationSources)) return failed("ANALYZER_INPUT_INVALID");
      let configurationBytes = 0;
      for (const key of Reflect.ownKeys(input.configurationSources)) {
        if (typeof key !== "string" || !safePath(key)) return failed("ANALYZER_INPUT_INVALID");
        const descriptor = Object.getOwnPropertyDescriptor(input.configurationSources, key);
        if (!descriptor || !(descriptor.value instanceof Uint8Array)) return failed("ANALYZER_INPUT_INVALID");
        configurationBytes += descriptor.value.byteLength;
        if (configurationBytes > 8 * 1024 * 1024) return failed("ANALYZER_INPUT_INVALID");
        configurationSources[key] = new Uint8Array(descriptor.value);
      }
    }

    const sourceBytes = Object.fromEntries(sourceEntries) as Record<string, Uint8Array>;
    const files: CcmFile[] = [];
    const nodes: CcmNode[] = [];
    const limitations: CcmLimitation[] = [];
    const diagnostics: DeclarationDiagnostic[] = [];
    const parserVersions = new Set<string>();
    const phpVersions = new Set<string>();
    const parsedFiles = new Map<string, PhpParseResult>();
    let processedCount = 0;
    let failedCount = 0;

    for (const [path, bytes] of sourceEntries) {
      input.signal?.throwIfAborted();
      if (!safePath(path)) return failed("CCM_FILE_PATH_INVALID");
      const fileHash = sha256(bytes);
      if (!path.toLowerCase().endsWith(".php")) {
        files.push({ path, language: null, sha256: fileHash, sizeBytes: bytes.byteLength, status: "excluded" });
        addLimitation(limitations, path, "language detection", "This file extension is outside the PHP declaration adapter and the file was excluded.");
        continue;
      }

      try {
        UTF8.decode(bytes);
      } catch {
        files.push({ path, language: "php", sha256: fileHash, sizeBytes: bytes.byteLength, status: "failed" });
        diagnostics.push(diagnostic(path, bytes, "INVALID_UTF8", "The PHP source is not valid UTF-8."));
        addLimitation(limitations, path, "parse", "Invalid UTF-8 bytes prevent syntax parsing; declarations from this file were omitted.");
        failedCount += 1;
        continue;
      }

      let parsed: PhpParseResult;
      try {
        parsed = await parseWithPhp(bytes, input.signal);
      } catch (error) {
        if (input.signal?.aborted) input.signal.throwIfAborted();
        const code = error instanceof Error && error.message === "PHP_PARSER_INVALID_RESPONSE"
          ? "PHP_PARSER_INVALID_RESPONSE"
          : "PHP_PARSER_UNAVAILABLE";
        files.push({ path, language: "php", sha256: fileHash, sizeBytes: bytes.byteLength, status: "failed" });
        diagnostics.push(diagnostic(path, bytes, code, "The trusted PHP parser could not return a valid result."));
        addLimitation(limitations, path, "parse", "The trusted PHP parser failed; declarations from this file were omitted.");
        failedCount += 1;
        continue;
      }

      parserVersions.add(parsed.parserVersion);
      phpVersions.add(parsed.phpVersion);
      if (!parsed.valid) {
        files.push({ path, language: "php", sha256: fileHash, sizeBytes: bytes.byteLength, status: "failed" });
        for (const item of parsed.diagnostics) {
          diagnostics.push(diagnostic(path, bytes, "PHP_PARSE_ERROR", item.message, item.startByte, item.line));
        }
        addLimitation(limitations, path, "parse", `The PHP parser reported ${parsed.diagnostics.length} syntax diagnostic(s); declarations from this file were omitted.`);
        failedCount += 1;
        continue;
      }

      files.push({ path, language: "php", sha256: fileHash, sizeBytes: bytes.byteLength, status: "processed" });
      processedCount += 1;
      parsedFiles.set(path, parsed);
      if (!includeReferences) {
        addLimitation(limitations, path, "resolve", "This adapter extracts PHP declarations and syntactic use imports only; it emits no resolver edges.");
      }

      if (bytes.byteLength === 0) {
        addLimitation(limitations, path, "declarations", "The empty source has no byte range for a Module evidence node; no root node was emitted.");
        continue;
      }

      const basename = path.slice(path.lastIndexOf("/") + 1);
      const rootLocation = evidence(path, fileHash, bytes, 0, bytes.byteLength);
      const root: CcmNode = {
        id: createNodeId({
          snapshotSha: snapshot.commitSha,
          language: "php",
          filePath: path,
          kind: "Module",
          qualifiedName: path,
          startByte: 0,
          endByte: bytes.byteLength,
        }),
        kind: "Module",
        name: basename,
        qualifiedName: path,
        language: "php",
        filePath: path,
        location: rootLocation,
        parentId: null,
        origin: "source",
        signature: null,
        attributes: { moduleKind: "file" },
      };
      nodes.push(root);

      for (const namespace of parsed.namespaces) {
        let namespaceParent: CcmNode = root;
        if (namespace.startByte !== null && namespace.endByte !== null && namespace.startByte < namespace.endByte) {
          const namespaceName = namespace.name || "(global)";
          const namespaceQualifiedName = `${path}#namespace:${namespaceName}`;
          const imports = namespace.imports.filter((item) => isImportFact(item, bytes));
          if (imports.length !== namespace.imports.length) {
            addLimitation(limitations, path, "declarations", "One or more use import spans were invalid and omitted from namespace metadata.");
          }
          namespaceParent = {
            id: createNodeId({
              snapshotSha: snapshot.commitSha,
              language: "php",
              filePath: path,
              kind: "Module",
              qualifiedName: namespaceQualifiedName,
              startByte: namespace.startByte,
              endByte: namespace.endByte,
            }),
            kind: "Module",
            name: namespaceName,
            qualifiedName: namespaceQualifiedName,
            language: "php",
            filePath: path,
            location: evidence(path, fileHash, bytes, namespace.startByte, namespace.endByte),
            parentId: root.id,
            origin: "source",
            signature: null,
            attributes: {
              moduleKind: "namespace",
              namespace: namespace.name,
              useImports: imports.map((item) => ({
                name: item.name,
                alias: item.alias,
                kind: item.kind,
                startByte: item.startByte,
                endByte: item.endByte,
              })),
            },
          };
          nodes.push(namespaceParent);
        } else if (namespace.imports.length > 0) {
          // In the global namespace, keep syntactic imports on the file module.
          const imports = namespace.imports.filter((item) => isImportFact(item, bytes));
          root.attributes.useImports = imports.map((item) => ({
            name: item.name,
            alias: item.alias,
            kind: item.kind,
            startByte: item.startByte,
            endByte: item.endByte,
          }));
        }

        const classNodes = new Map<string, CcmNode>();
        for (const fact of namespace.declarations) {
          if (!isDeclarationFact(fact, bytes)) {
            addLimitation(limitations, path, "declarations", "A parser declaration had an invalid source span and was omitted.");
            continue;
          }
          let parent = namespaceParent;
          if (fact.kind === "Method" && fact.parentQualifiedName !== null && fact.parentStartByte !== null && fact.parentEndByte !== null) {
            parent = classNodes.get(`${fact.parentQualifiedName}\0${fact.parentStartByte}\0${fact.parentEndByte}`) ?? namespaceParent;
          }
          const node = nodeFromFact(fact, path, bytes, fileHash, snapshot.commitSha, parent.id);
          nodes.push(node);
          if (fact.kind === "Class" || fact.kind === "Interface") {
            classNodes.set(`${fact.qualifiedName}\0${fact.startByte}\0${fact.endByte}`, node);
          }
        }
      }

      for (const reason of parsed.limitations) {
        if (includeReferences && /Property declarations are outside this S1|Constructor-promoted properties are outside this S1/.test(reason)) continue;
        addLimitation(limitations, path, "declarations", reason);
      }
      if (includeReferences) {
        for (const reason of parsed.referenceLimitations) addLimitation(limitations, path, "resolve", reason);
      }
    }

    const parserVersion = [...parserVersions].sort().join(",") || "unavailable";
    const phpVersion = [...phpVersions].sort().join(",") || "unavailable";
    const ccm: CcmV1 = {
      schemaVersion: 1,
      snapshot: { repository: snapshot.repository, branch: snapshot.branch, commitSha: snapshot.commitSha },
      provenance: {
        analyzer: { name: "sage-analyzer-php-declarations", version: `${ANALYZER_VERSION}+nikic-php-parser-${parserVersion}+php-${phpVersion}` },
        resolver: { name: "sage-no-resolver", version: RESOLVER_VERSION },
        configHash: sha256(`sage-analyzer-php-declarations-v1\nnikic/php-parser-${parserVersion}\nphp-${phpVersion}\nno-config\nno-resolution\nnamespace-use-import-metadata-v1`),
      },
      files,
      nodes,
      edges: [],
      limitations,
    };
    const canonical = canonicalizeCcm(ccm, sourceBytes);
    if (!canonical.ok) return failed(`CCM_INVALID:${canonical.errorCode}`);

    let finalCcm = canonical.value;
    let finalJson = canonical.json;
    let finalHash = canonical.sha256;
    if (includeReferences) {
      const resolverLimitations = [...limitations];
      const configuration = parseComposerConfiguration(configurationSources, resolverLimitations);
      const resolved = resolvePhpReferences(finalCcm, parsedFiles, sourceBytes, configuration, resolverLimitations);
      const resolvedCanonical = canonicalizeCcm(resolved, sourceBytes);
      if (!resolvedCanonical.ok) return failed(`CCM_INVALID:${resolvedCanonical.errorCode}`);
      finalCcm = resolvedCanonical.value;
      finalJson = resolvedCanonical.json;
      finalHash = resolvedCanonical.sha256;
    }

    const unsupportedFiles = files.some((file) => file.status === "excluded");
    const meaningfulLimitations = finalCcm.limitations.some((item) => includeReferences || item.stage !== "resolve");
    const unresolvedEdges = finalCcm.edges.some((edge) => edge.resolution === "Unresolved");
    const status = processedCount === 0 ? "failed" : failedCount === 0 && !unsupportedFiles && !meaningfulLimitations && !unresolvedEdges
      ? "complete"
      : processedCount > 0 ? "partial" : "failed";
    return {
      status,
      ccm: finalCcm,
      canonicalJson: finalJson,
      contentSha256: finalHash,
      diagnostics: diagnostics.sort((left, right) =>
        (left.path < right.path ? -1 : left.path > right.path ? 1 : 0) ||
        (left.startByte ?? -1) - (right.startByte ?? -1) ||
        (left.code < right.code ? -1 : left.code > right.code ? 1 : 0)),
      errorCode: null,
    };
  } catch (error) {
    if (input?.signal?.aborted) input.signal.throwIfAborted();
    return failed(error instanceof Error && error.message === "ANALYZER_INPUT_INVALID" ? "ANALYZER_INPUT_INVALID" : "ANALYZER_FAILURE");
  }
}

/** Parse PHP declarations and resolve only references backed by supplied snapshot declarations. */
export function analyzeReferences(input: ReferenceAnalysisInput): Promise<DeclarationAnalysisResult> {
  return analyze(input, true);
}

/** Preserve the S1 declaration-only API and its no-edge contract. */
export function analyzeDeclarations(input: DeclarationAnalysisInput): Promise<DeclarationAnalysisResult> {
  return analyze(input, false);
}
