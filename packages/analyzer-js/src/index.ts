import { createHash } from "node:crypto";
import ts from "typescript";
import {
  canonicalizeCcm,
  createNodeId,
  type CcmFile,
  type CcmLimitation,
  type CcmNode,
  type CcmSnapshot,
  type CcmV1,
  type EvidenceSpan,
  type Language,
  type NodeKind,
} from "@sage/contracts";

export { parseSource } from "./probe.ts";

const ANALYZER_VERSION = "0.1.0";
const RESOLVER_VERSION = "0.1.0";
const DEFAULT_CONFIG_HASH = createHash("sha256")
  .update("sage-analyzer-js-declarations-v1\ntypescript-5.9.3\nscript-target-latest\nno-config\nno-resolution")
  .digest("hex");
const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

type SourceKind = { language: Language; scriptKind: ts.ScriptKind };

export interface DeclarationAnalysisInput {
  snapshot: CcmSnapshot;
  sources: Readonly<Record<string, Uint8Array>>;
}

export interface DeclarationDiagnostic {
  path: string;
  code: number | "INVALID_UTF8" | "PARSER_FAILURE";
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

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function safeRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Reflect.ownKeys(value).every((key) => {
    if (typeof key !== "string") return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return !!descriptor && "value" in descriptor && descriptor.enumerable;
  });
}

function sourceKind(path: string): SourceKind | null {
  const extension = path.slice(path.lastIndexOf(".")).toLowerCase();
  if ([".js", ".mjs", ".cjs"].includes(extension)) return { language: "javascript", scriptKind: ts.ScriptKind.JS };
  if (extension === ".jsx") return { language: "javascript", scriptKind: ts.ScriptKind.JSX };
  if ([".ts", ".mts", ".cts"].includes(extension)) return { language: "typescript", scriptKind: ts.ScriptKind.TS };
  if (extension === ".tsx") return { language: "typescript", scriptKind: ts.ScriptKind.TSX };
  return null;
}

function safePath(path: string): boolean {
  return path.length > 0 && !path.startsWith("/") && !path.includes("\\") && !path.includes("\0") &&
    path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function positionAt(bytes: Uint8Array, offset: number): { line: number; column: number } {
  const prefix = UTF8.decode(bytes.subarray(0, offset));
  const lines = prefix.split("\n");
  return { line: lines.length, column: Array.from(lines.at(-1) ?? "").length + 1 };
}

function byteOffset(source: string, utf16Offset: number): number {
  return Buffer.byteLength(source.slice(0, utf16Offset), "utf8");
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
  source: string | null,
  code: DeclarationDiagnostic["code"],
  message: string,
  utf16Start: number | null = null,
): DeclarationDiagnostic {
  if (source === null || utf16Start === null || utf16Start < 0 || utf16Start > source.length) {
    return { path, code, message, startByte: null, line: null, column: null };
  }
  const startByte = byteOffset(source, utf16Start);
  const position = positionAt(bytes, startByte);
  return { path, code, message, startByte, ...position };
}

function javascriptSyntaxDiagnostics(path: string, source: string, scriptKind: ts.ScriptKind): readonly ts.Diagnostic[] {
  const virtualPath = `/__sage_in_memory__/${path}`;
  const sourceFile = ts.createSourceFile(virtualPath, source, ts.ScriptTarget.Latest, true, scriptKind);
  const options: ts.CompilerOptions = {
    allowJs: true,
    checkJs: false,
    noEmit: true,
    noLib: true,
    noResolve: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.Latest,
    module: ts.ModuleKind.ESNext,
    jsx: ts.JsxEmit.Preserve,
    types: [],
  };
  const host: ts.CompilerHost = {
    getSourceFile: (fileName) => fileName.replace(/\\/g, "/") === virtualPath ? sourceFile : undefined,
    getDefaultLibFileName: () => "",
    writeFile: () => undefined,
    getCurrentDirectory: () => "/__sage_in_memory__",
    getDirectories: () => [],
    fileExists: () => false,
    readFile: () => undefined,
    getCanonicalFileName: (fileName) => fileName,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    directoryExists: () => false,
    realpath: (fileName) => fileName,
  };
  const program = ts.createProgram([virtualPath], options, host);
  return program.getSyntacticDiagnostics(sourceFile);
}

function modifierFlags(node: ts.Node): Set<ts.SyntaxKind> {
  if (!ts.canHaveModifiers(node)) return new Set();
  return new Set((ts.getModifiers(node) ?? []).map((modifier) => modifier.kind));
}

function isExported(node: ts.Node): boolean {
  const flags = modifierFlags(node);
  return flags.has(ts.SyntaxKind.ExportKeyword) || flags.has(ts.SyntaxKind.DefaultKeyword);
}

function declarationName(name: ts.PropertyName | ts.BindingName | undefined): string | null {
  if (!name || ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) return null;
  if (ts.isComputedPropertyName(name)) {
    const expression = name.expression;
    if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression) || ts.isNumericLiteral(expression)) return expression.text;
    return null;
  }
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return null;
}

function hasComputedName(name: ts.PropertyName | ts.BindingName | undefined): name is ts.ComputedPropertyName {
  return !!name && !ts.isObjectBindingPattern(name) && !ts.isArrayBindingPattern(name) && ts.isComputedPropertyName(name);
}

function spanForNode(path: string, source: string, bytes: Uint8Array, fileSha256: string, node: ts.Node): EvidenceSpan {
  return evidence(path, fileSha256, bytes, byteOffset(source, node.getStart()), byteOffset(source, node.end));
}

function signatureForNode(node: ts.Node, source: string): string | null {
  const body = ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node) ? node.body : undefined;
  if (body) return source.slice(node.getStart(), body.getStart()).trimEnd();
  if (ts.isPropertyDeclaration(node) && node.initializer) return source.slice(node.getStart(), node.initializer.getStart()).trimEnd();
  return null;
}

function attributeRecord(values: Record<string, boolean | string>): CcmNode["attributes"] {
  return values;
}

function addLimitation(
  limitations: CcmLimitation[],
  path: string | null,
  stage: string,
  reason: string,
): void {
  if (!limitations.some((item) => item.path === path && item.stage === stage && item.reason === reason)) {
    limitations.push({ path, stage, reason });
  }
}

function buildFileDeclarations(
  path: string,
  language: Language,
  scriptKind: ts.ScriptKind,
  source: string,
  bytes: Uint8Array,
  fileSha256: string,
  snapshotSha: string,
  nodes: CcmNode[],
  limitations: CcmLimitation[],
  diagnostics: DeclarationDiagnostic[],
): "processed" | "failed" {
  let sourceFile: ts.SourceFile;
  try {
    sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, scriptKind);
  } catch {
    diagnostics.push(diagnostic(path, bytes, source, "PARSER_FAILURE", "TypeScript parser could not build a syntax tree."));
    addLimitation(limitations, path, "parse", "The parser could not build a syntax tree; declarations from this file were omitted.");
    return "failed";
  }

  const parserDiagnostics = [...(sourceFile as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics];
  if (language === "javascript") {
    try {
      parserDiagnostics.push(...javascriptSyntaxDiagnostics(path, source, scriptKind));
    } catch {
      diagnostics.push(diagnostic(path, bytes, source, "PARSER_FAILURE", "JavaScript syntax diagnostics could not be computed."));
      addLimitation(limitations, path, "parse", "JavaScript-only syntax diagnostics failed; declarations from this file were omitted.");
      return "failed";
    }
  }
  const uniqueDiagnostics = [...new Map(parserDiagnostics.map((item) => [
    `${item.code}:${item.start ?? -1}:${ts.flattenDiagnosticMessageText(item.messageText, "\n")}`,
    item,
  ])).values()];
  if (uniqueDiagnostics.length > 0) {
    for (const item of uniqueDiagnostics) {
      diagnostics.push(diagnostic(
        path,
        bytes,
        source,
        item.code,
        ts.flattenDiagnosticMessageText(item.messageText, "\n"),
        item.start ?? null,
      ));
    }
    addLimitation(limitations, path, "parse", `The ${language === "javascript" ? "JavaScript" : "TypeScript"} parser reported ${uniqueDiagnostics.length} syntax diagnostic(s); declarations from this file were omitted.`);
    return "failed";
  }

  addLimitation(limitations, path, "resolve", "This adapter extracts declarations only; it emits no import, call, inheritance, implementation, or type-reference edges.");

  const addNode = (
    kind: NodeKind,
    name: string,
    qualifiedName: string,
    node: ts.Node,
    parent: CcmNode | null,
    attributes: Record<string, boolean | string> = {},
  ): CcmNode => {
    const location = spanForNode(path, source, bytes, fileSha256, node);
    const result: CcmNode = {
      id: createNodeId({
        snapshotSha,
        language,
        filePath: path,
        kind,
        qualifiedName,
        startByte: location.startByte,
        endByte: location.endByte,
      }),
      kind,
      name,
      qualifiedName,
      language,
      filePath: path,
      location,
      parentId: parent?.id ?? null,
      origin: "source",
      signature: signatureForNode(node, source),
      attributes: attributeRecord(attributes),
    };
    nodes.push(result);
    return result;
  };

  let root: CcmNode | null = null;
  if (bytes.byteLength > 0) {
    const name = path.slice(path.lastIndexOf("/") + 1);
    const location = evidence(path, fileSha256, bytes, 0, bytes.byteLength);
    const moduleId = createNodeId({ snapshotSha, language, filePath: path, kind: "Module", qualifiedName: path,
      startByte: location.startByte, endByte: location.endByte });
    root = {
      id: moduleId,
      kind: "Module",
      name,
      qualifiedName: path,
      language,
      filePath: path,
      location,
      parentId: null,
      origin: "source",
      signature: null,
      attributes: { moduleKind: "file" },
    };
    nodes.push(root);
  } else {
    addLimitation(limitations, path, "declarations", "The empty source has no byte range for a Module evidence node; no root node was emitted.");
  }

  const addNamedMember = (
    member: ts.ClassElement | ts.TypeElement,
    parent: CcmNode,
    parentName: string,
  ): void => {
    if (ts.isPropertyDeclaration(member) || ts.isPropertySignature(member)) {
      if (hasComputedName(member.name) && declarationName(member.name) === null) {
        addLimitation(limitations, path, "declarations", "A computed property name depends on runtime evaluation; that property declaration was omitted.");
        return;
      }
      const memberName = declarationName(member.name);
      if (memberName === null || memberName.trim().length === 0) {
        addLimitation(limitations, path, "declarations", "An unnamed property declaration is unsupported and was omitted.");
        return;
      }
      const flags = modifierFlags(member);
      const attributes: Record<string, boolean | string> = {
        exported: false,
        static: flags.has(ts.SyntaxKind.StaticKeyword),
      };
      if (hasComputedName(member.name)) attributes.computed = true;
      if (flags.has(ts.SyntaxKind.ReadonlyKeyword)) attributes.readonly = true;
      addNode("Property", memberName, `${parentName}.${memberName}`, member, parent, attributes);
      return;
    }

    if (ts.isMethodDeclaration(member) || ts.isMethodSignature(member) || ts.isConstructorDeclaration(member) ||
      ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)) {
      if (!ts.isConstructorDeclaration(member) && hasComputedName(member.name) && declarationName(member.name) === null) {
        addLimitation(limitations, path, "declarations", "A computed method name depends on runtime evaluation; that method declaration was omitted.");
        return;
      }
      const memberName = ts.isConstructorDeclaration(member) ? "constructor" : declarationName(member.name);
      if (memberName === null || memberName.trim().length === 0) {
        addLimitation(limitations, path, "declarations", "An unnamed method declaration is unsupported and was omitted.");
        return;
      }
      const flags = modifierFlags(member);
      const accessorPrefix = ts.isGetAccessorDeclaration(member) ? "get " : ts.isSetAccessorDeclaration(member) ? "set " : "";
      const qualifiedMemberName = `${accessorPrefix}${memberName}`;
      const attributes: Record<string, boolean | string> = {
        exported: false,
        static: flags.has(ts.SyntaxKind.StaticKeyword),
      };
      if (!ts.isConstructorDeclaration(member) && hasComputedName(member.name)) attributes.computed = true;
      addNode("Method", qualifiedMemberName, `${parentName}.${qualifiedMemberName}`, member, parent, attributes);

      if (ts.isConstructorDeclaration(member)) {
        for (const parameter of member.parameters) {
          const parameterFlags = modifierFlags(parameter);
          const parameterName = declarationName(parameter.name);
          if (parameterName === null || ![
            ts.SyntaxKind.PublicKeyword,
            ts.SyntaxKind.ProtectedKeyword,
            ts.SyntaxKind.PrivateKeyword,
            ts.SyntaxKind.ReadonlyKeyword,
          ].some((flag) => parameterFlags.has(flag))) continue;
          addNode("Property", parameterName, `${parentName}.${parameterName}`, parameter, parent, {
            exported: false,
            static: false,
            parameterProperty: true,
          });
        }
      }
      return;
    }

    if (!ts.isSemicolonClassElement(member)) {
      addLimitation(limitations, path, "declarations", `The ${ts.SyntaxKind[member.kind]} member is outside the declaration subset and was omitted.`);
    }
  };

  const visitModuleBody = (body: ts.ModuleBody | undefined, parent: CcmNode, parentName: string): void => {
    if (body && ts.isModuleDeclaration(body)) {
      visitModuleDeclaration(body, parent, parentName);
      return;
    }
    if (body && ts.isModuleBlock(body)) visitStatements(body.statements, parent, parentName);
  };

  const visitModuleDeclaration = (declaration: ts.ModuleDeclaration, parent: CcmNode, parentName: string): void => {
    const name = declarationName(declaration.name);
    if (name === null) {
      addLimitation(limitations, path, "declarations", "An ambient module with a computed or unsupported name was omitted.");
      return;
    }
    if (ts.isStringLiteral(declaration.name)) {
      addLimitation(limitations, path, "declarations", "Ambient external module declarations are unsupported and were omitted.");
      return;
    }
    const qualifiedName = `${parentName}.${name}`;
    const moduleNode = addNode("Module", name, qualifiedName, declaration, parent, { moduleKind: "namespace", exported: isExported(declaration) });
    visitModuleBody(declaration.body, moduleNode, qualifiedName);
  };

  const visitStatements = (statements: ts.NodeArray<ts.Statement>, parent: CcmNode | null, parentName: string): void => {
    for (const statement of statements) {
      if (ts.isModuleDeclaration(statement)) {
        if (parent) visitModuleDeclaration(statement, parent, parentName);
        else if (root) visitModuleDeclaration(statement, root, path);
        continue;
      }
      const actualParent = parent ?? root;
      const actualParentName = parentName;
      if (!actualParent) continue;

      if (ts.isClassDeclaration(statement) || ts.isInterfaceDeclaration(statement)) {
        const name = declarationName(statement.name);
        if (name === null) {
          addLimitation(limitations, path, "declarations", "Anonymous class or interface declarations are unsupported and were omitted.");
          continue;
        }
        const qualifiedName = `${actualParentName}.${name}`;
        const classNode = addNode(ts.isClassDeclaration(statement) ? "Class" : "Interface", name, qualifiedName, statement, actualParent, {
          exported: isExported(statement),
          defaultExport: modifierFlags(statement).has(ts.SyntaxKind.DefaultKeyword),
        });
        for (const member of statement.members) addNamedMember(member, classNode, qualifiedName);
        continue;
      }

      if (ts.isFunctionDeclaration(statement)) {
        const name = declarationName(statement.name);
        if (name === null) {
          addLimitation(limitations, path, "declarations", "Anonymous function declarations are unsupported and were omitted.");
          continue;
        }
        const qualifiedName = `${actualParentName}.${name}`;
        addNode("Function", name, qualifiedName, statement, actualParent, {
          exported: isExported(statement),
          defaultExport: modifierFlags(statement).has(ts.SyntaxKind.DefaultKeyword),
        });
        continue;
      }

      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (declaration.initializer && (ts.isClassExpression(declaration.initializer) || ts.isFunctionExpression(declaration.initializer) || ts.isArrowFunction(declaration.initializer))) {
            addLimitation(limitations, path, "declarations", "A class or function expression assigned to a variable is outside this declaration subset and was omitted.");
          }
        }
      }
    }
  };

  if (root) visitStatements(sourceFile.statements, root, path);

  const visitDynamicConstructs = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const specifier = node.arguments[0];
      if (!specifier || !(ts.isStringLiteral(specifier) || ts.isNoSubstitutionTemplateLiteral(specifier))) {
        addLimitation(limitations, path, "dynamic", "A dynamic import uses a runtime-computed module specifier; no target file can be established from source alone.");
      }
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "require") {
      const specifier = node.arguments[0];
      if (!specifier || !(ts.isStringLiteral(specifier) || ts.isNoSubstitutionTemplateLiteral(specifier))) {
        addLimitation(limitations, path, "dynamic", "A require call uses a runtime-computed module specifier; no target file can be established from source alone.");
      }
    }
    if (ts.isCallExpression(node)) {
      addLimitation(limitations, path, "resolve", "Call expressions are deferred to the resolver stage; this adapter does not assert their targets.");
    }
    if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && ts.isIdentifier(node.expression) &&
      (node.expression.text === "eval" || (ts.isNewExpression(node) && node.expression.text === "Function"))) {
      addLimitation(limitations, path, "dynamic", "Dynamic code generation cannot be represented by source declarations and was not executed.");
    }
    if (ts.isElementAccessExpression(node) && node.argumentExpression &&
      !(ts.isStringLiteral(node.argumentExpression) || ts.isNoSubstitutionTemplateLiteral(node.argumentExpression) || ts.isNumericLiteral(node.argumentExpression))) {
      addLimitation(limitations, path, "dynamic", "A computed member access has a runtime-dependent target and is not resolved.");
    }
    if (ts.isEnumDeclaration(node)) {
      addLimitation(limitations, path, "declarations", "Enum declarations are outside the current CCM declaration subset and were omitted.");
    }
    if (ts.isTypeAliasDeclaration(node)) {
      addLimitation(limitations, path, "declarations", "Type alias declarations are outside the current CCM declaration subset and were omitted.");
    }
    if (ts.isVariableStatement(node)) {
      addLimitation(limitations, path, "declarations", "Variable declarations are outside the current CCM declaration subset and were omitted as nodes.");
    }
    if (ts.isExportAssignment(node)) {
      addLimitation(limitations, path, "declarations", "Expression-based exports are outside the current CCM declaration subset and were omitted.");
    }
    if (ts.isClassExpression(node)) {
      addLimitation(limitations, path, "declarations", "Class expressions are outside the current CCM declaration subset and were omitted.");
    }
    if (ts.isFunctionExpression(node) || ts.isArrowFunction(node)) {
      addLimitation(limitations, path, "declarations", "Function expressions and arrow functions are outside the current CCM declaration subset and were omitted.");
    }
    if ((ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isFunctionDeclaration(node)) &&
      !ts.isSourceFile(node.parent) && !ts.isModuleBlock(node.parent)) {
      addLimitation(limitations, path, "declarations", "Declarations nested outside source or namespace module scope are unsupported and were omitted.");
    }
    ts.forEachChild(node, visitDynamicConstructs);
  };
  visitDynamicConstructs(sourceFile);
  return "processed";
}

/** Parse JS/TS snapshot bytes into deterministic CCM v1 declaration nodes without loading project config or executing source. */
export function analyzeDeclarations(input: DeclarationAnalysisInput): DeclarationAnalysisResult {
  const failed = (errorCode: string): DeclarationAnalysisResult => ({
    status: "failed",
    ccm: null,
    canonicalJson: null,
    contentSha256: null,
    diagnostics: [],
    errorCode,
  });

  try {
    if (!input || !safeRecord(input.snapshot) || !safeRecord(input.sources)) return failed("ANALYZER_INPUT_INVALID");
    const snapshot = input.snapshot as unknown as CcmSnapshot;
    const sourceEntries = Reflect.ownKeys(input.sources).map((key) => {
      if (typeof key !== "string") throw new Error("ANALYZER_INPUT_INVALID");
      const descriptor = Object.getOwnPropertyDescriptor(input.sources, key);
      if (!descriptor || !(descriptor.value instanceof Uint8Array)) throw new Error("ANALYZER_INPUT_INVALID");
      return [key, new Uint8Array(descriptor.value)] as const;
    }).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);

    const sourceBytes = Object.fromEntries(sourceEntries) as Record<string, Uint8Array>;
    const files: CcmFile[] = [];
    const nodes: CcmNode[] = [];
    const limitations: CcmLimitation[] = [];
    const diagnostics: DeclarationDiagnostic[] = [];
    let processedCount = 0;
    let failedCount = 0;

    for (const [path, bytes] of sourceEntries) {
      if (!safePath(path)) return failed("CCM_FILE_PATH_INVALID");
      const hash = sha256(bytes);
      const kind = sourceKind(path);
      if (!kind) {
        files.push({ path, language: null, sha256: hash, sizeBytes: bytes.byteLength, status: "excluded" });
        addLimitation(limitations, path, "language detection", "This file extension is outside the JavaScript/TypeScript declaration adapter and the file was excluded.");
        continue;
      }

      let source: string;
      try {
        source = UTF8.decode(bytes);
      } catch {
        files.push({ path, language: kind.language, sha256: hash, sizeBytes: bytes.byteLength, status: "failed" });
        diagnostics.push(diagnostic(path, bytes, null, "INVALID_UTF8", "The source file is not valid UTF-8."));
        addLimitation(limitations, path, "parse", "Invalid UTF-8 bytes prevent syntax parsing; declarations from this file were omitted.");
        failedCount += 1;
        continue;
      }

      const fileStatus = buildFileDeclarations(
        path,
        kind.language,
        kind.scriptKind,
        source,
        bytes,
        hash,
        snapshot.commitSha,
        nodes,
        limitations,
        diagnostics,
      );
      files.push({ path, language: kind.language, sha256: hash, sizeBytes: bytes.byteLength, status: fileStatus });
      if (fileStatus === "processed") processedCount += 1;
      else failedCount += 1;
    }

    const ccm: CcmV1 = {
      schemaVersion: 1,
      snapshot: {
        repository: snapshot.repository,
        branch: snapshot.branch,
        commitSha: snapshot.commitSha,
      },
      provenance: {
        analyzer: { name: "sage-analyzer-js-declarations", version: ANALYZER_VERSION },
        resolver: { name: "sage-no-resolver", version: RESOLVER_VERSION },
        configHash: DEFAULT_CONFIG_HASH,
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
        (String(left.code) < String(right.code) ? -1 : String(left.code) > String(right.code) ? 1 : 0)),
      errorCode: null,
    };
  } catch (error) {
    return failed(error instanceof Error && error.message === "ANALYZER_INPUT_INVALID" ? "ANALYZER_INPUT_INVALID" : "ANALYZER_FAILURE");
  }
}
