import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  canonicalizeCcm,
  createNodeId,
  type CcmFile,
  type CcmLimitation,
  type CcmNode,
  type CcmSnapshot,
  type CcmV1,
  type EvidenceSpan,
  type JsonValue,
  type NodeKind,
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
  limitations: string[];
  diagnostics: Array<{ message: string; line: number; startByte: number | null }>;
}

export interface DeclarationAnalysisInput {
  snapshot: CcmSnapshot;
  sources: Readonly<Record<string, Uint8Array>>;
  signal?: AbortSignal;
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
          !Array.isArray(parsed.limitations) || typeof parsed.parserVersion !== "string" || typeof parsed.phpVersion !== "string") {
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
export async function analyzeDeclarations(input: DeclarationAnalysisInput): Promise<DeclarationAnalysisResult> {
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
    const snapshot = input.snapshot;
    const sourceEntries = Reflect.ownKeys(input.sources).map((key) => {
      if (typeof key !== "string") throw new Error("ANALYZER_INPUT_INVALID");
      const descriptor = Object.getOwnPropertyDescriptor(input.sources, key);
      if (!descriptor || !(descriptor.value instanceof Uint8Array)) throw new Error("ANALYZER_INPUT_INVALID");
      return [key, new Uint8Array(descriptor.value)] as const;
    }).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    if (sourceEntries.length === 0) return failed("ANALYZER_INPUT_INVALID");

    const sourceBytes = Object.fromEntries(sourceEntries) as Record<string, Uint8Array>;
    const files: CcmFile[] = [];
    const nodes: CcmNode[] = [];
    const limitations: CcmLimitation[] = [];
    const diagnostics: DeclarationDiagnostic[] = [];
    const parserVersions = new Set<string>();
    const phpVersions = new Set<string>();
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
      addLimitation(limitations, path, "resolve", "This adapter extracts PHP declarations and syntactic use imports only; it emits no resolver edges.");

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

      for (const reason of parsed.limitations) addLimitation(limitations, path, "declarations", reason);
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

    const unsupportedFiles = files.some((file) => file.status === "excluded");
    const meaningfulLimitations = limitations.some((item) => item.stage !== "resolve");
    const status = processedCount === 0 ? "failed" : failedCount === 0 && !unsupportedFiles && !meaningfulLimitations
      ? "complete"
      : processedCount > 0 ? "partial" : "failed";
    return {
      status,
      ccm: canonical.value,
      canonicalJson: canonical.json,
      contentSha256: canonical.sha256,
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
