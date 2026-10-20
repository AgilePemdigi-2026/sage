import { createHash } from "node:crypto";
import ts from "typescript";
import {
  canonicalizeCcm,
  createEdgeId,
  createNodeId,
  type CcmNode,
  type CcmV1,
  type EdgeKind,
  type EvidenceSpan,
  type Language,
  type UnresolvedReason,
} from "@sage/contracts";
import { analyzeDeclarations, type DeclarationAnalysisInput, type DeclarationAnalysisResult } from "./index.ts";

const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const RESOLVER_VERSION = "0.2.0";
const MAX_CONFIGURATION_BYTES = 1024 * 1024;
const BUILTIN_TYPES = new Set([
  "any", "unknown", "never", "void", "undefined", "null", "string", "number", "boolean", "bigint", "symbol",
  "object", "this", "true", "false", "keyof", "typeof", "readonly", "unique", "infer", "is", "asserts",
]);

type Binding = {
  target: CcmNode | null;
  observed: string;
  reason?: UnresolvedReason;
  namespace?: FileContext;
};
type ResolverMapping = { pattern: string; targets: string[]; base: string };
type ResolverConfig = { mappings: ResolverMapping[]; baseUrl?: string };
type FileContext = {
  path: string;
  language: Language;
  source: string;
  bytes: Uint8Array;
  offsets: Uint32Array;
  fileSha256: string;
  sourceFile: ts.SourceFile;
  moduleNode: CcmNode;
  nodes: CcmNode[];
  declarations: Map<ts.Node, CcmNode>;
  declarationsBySpan: Map<string, CcmNode[]>;
  imports: Map<string, Binding>;
  exported: Map<string, CcmNode[]>;
  uncertainExports: Set<string>;
  locals: Map<string, CcmNode[]>;
  opaqueLocals: Set<string>;
  cjsBindingNames: Set<string>;
  instanceAliases: Map<string, CcmNode>;
  mutated: Set<string>;
  moduleTargets: Map<ts.Node, FileContext | null>;
  config: ResolverConfig;
};
type ResolvedModule = { file: FileContext; reason?: undefined } | { file?: undefined; reason: UnresolvedReason };
type SymbolResult = { target: CcmNode; context: FileContext } | { reason: UnresolvedReason };
type ReceiverResult = { owner: CcmNode; context: FileContext; mode: "static" | "instance" } | { reason: UnresolvedReason };

function sha256(value: string | Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }
function sourceKind(path: string): { language: Language; scriptKind: ts.ScriptKind } | null {
  const extension = path.slice(path.lastIndexOf(".")).toLowerCase();
  if ([".js", ".mjs", ".cjs"].includes(extension)) return { language: "javascript", scriptKind: ts.ScriptKind.JS };
  if (extension === ".jsx") return { language: "javascript", scriptKind: ts.ScriptKind.JSX };
  if ([".ts", ".mts", ".cts"].includes(extension)) return { language: "typescript", scriptKind: ts.ScriptKind.TS };
  if (extension === ".tsx") return { language: "typescript", scriptKind: ts.ScriptKind.TSX };
  return null;
}
function safePath(path: string): boolean {
  return path.length > 0 && !path.startsWith("/") && !path.includes("\\") && !path.includes("\0") &&
    path.split("/").every(part => part !== "" && part !== "." && part !== "..");
}
function safeRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Reflect.ownKeys(value).every(key => {
    if (typeof key !== "string") return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return !!descriptor && "value" in descriptor && descriptor.enumerable;
  });
}
function byteMap(source: string): Uint32Array {
  const offsets = new Uint32Array(source.length + 1);
  let bytes = 0;
  for (let index = 0; index < source.length;) {
    const code = source.codePointAt(index)!;
    const width = code > 0xffff ? 2 : 1;
    offsets[index] = bytes;
    if (width === 2) offsets[index + 1] = bytes;
    bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
    index += width;
    offsets[index] = bytes;
  }
  return offsets;
}
function span(context: FileContext, offsets: Uint32Array, start: number, end: number, role: EvidenceSpan["role"] = "reference"): EvidenceSpan {
  const startByte = offsets[start]!;
  const endByte = offsets[end]!;
  const position = (byte: number) => {
    const prefix = UTF8.decode(context.bytes.subarray(0, byte));
    const parts = prefix.split("\n");
    return { line: parts.length, column: Array.from(parts.at(-1) ?? "").length + 1 };
  };
  const startPosition = position(startByte);
  const endPosition = position(endByte);
  return {
    filePath: context.path,
    fileSha256: context.fileSha256,
    startByte, endByte,
    startLine: startPosition.line, endLine: endPosition.line,
    startColumn: startPosition.column, endColumn: endPosition.column,
    role,
  };
}
function key(path: string, start: number, end: number): string { return `${path}\0${start}\0${end}`; }
function namesFromBinding(name: ts.BindingName, out: string[] = []): string[] {
  if (ts.isIdentifier(name)) out.push(name.text);
  else for (const element of name.elements) if (!ts.isOmittedExpression(element)) namesFromBinding(element.name, out);
  return out;
}
function expressionName(node: ts.Expression | ts.EntityName): string | null {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) {
    const prefix = expressionName(node.expression);
    return prefix ? `${prefix}.${node.name.text}` : null;
  }
  if (ts.isQualifiedName(node)) {
    const prefix = expressionName(node.left);
    return prefix ? `${prefix}.${node.right.text}` : null;
  }
  return null;
}
function normalizePath(path: string): string | null {
  const out: string[] = [];
  for (const part of path.replace(/\\/g, "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") { if (!out.length) return null; out.pop(); }
    else out.push(part);
  }
  return out.length ? out.join("/") : null;
}
function normalizeSnapshotBase(path: string): string | null {
  const out: string[] = [];
  for (const part of path.replace(/\\/g, "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") { if (!out.length) return null; out.pop(); }
    else out.push(part);
  }
  return out.join("/");
}
function isRelativeConfigPath(path: string): boolean {
  return !path.startsWith("/") && !path.startsWith("\\") && !/^[a-z]:/i.test(path) && !/^[a-z][a-z0-9+.-]*:/i.test(path);
}
function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some(modifier => modifier.kind === kind);
}
function isThisExpression(node: ts.Expression): boolean { return node.kind === ts.SyntaxKind.ThisKeyword; }
function isNamedDeclaration(node: ts.Node): node is ts.ClassDeclaration | ts.InterfaceDeclaration | ts.FunctionDeclaration {
  return ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isFunctionDeclaration(node);
}
function declarationKind(node: ts.Node): CcmNode["kind"] | null {
  if (ts.isClassDeclaration(node)) return "Class";
  if (ts.isInterfaceDeclaration(node)) return "Interface";
  if (ts.isFunctionDeclaration(node)) return "Function";
  if (ts.isMethodDeclaration(node) || ts.isMethodSignature(node) || ts.isConstructorDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) return "Method";
  if (ts.isPropertyDeclaration(node) || ts.isPropertySignature(node) || ts.isParameter(node)) return "Property";
  if (ts.isModuleDeclaration(node)) return "Module";
  return null;
}
function declarationFor(node: ts.Node, context: FileContext, offsets: Uint32Array): CcmNode | null {
  const kind = declarationKind(node);
  if (!kind) return null;
  const candidates = context.declarationsBySpan.get(key(context.path, offsets[node.getStart(context.sourceFile)]!, offsets[node.end]!)) ?? [];
  return candidates.find(candidate => candidate.kind === kind) ?? null;
}
function addEdge(ccm: CcmV1, from: CcmNode, to: CcmNode, kind: EdgeKind, evidence: EvidenceSpan, reason: UnresolvedReason | null): void {
  const resolution = reason === null ? "Exact" : "Unresolved";
  const id = createEdgeId({ snapshotSha: ccm.snapshot.commitSha, sourceId: from.id, targetId: to.id, kind, resolution, evidence: [evidence], unresolvedReason: reason });
  if (ccm.edges.some(edge => edge.id === id)) return;
  ccm.edges.push({ id, sourceId: from.id, targetId: to.id, kind, resolution, evidence: [evidence], unresolvedReason: reason });
}
function addUnresolved(ccm: CcmV1, from: CcmNode, kind: EdgeKind, evidence: EvidenceSpan, expression: string, reason: UnresolvedReason): void {
  const qualifiedName = `${evidence.filePath}:${evidence.startByte}:${evidence.endByte}:${reason}:${expression}`;
  const target: CcmNode = {
    id: createNodeId({ snapshotSha: ccm.snapshot.commitSha, language: from.language, filePath: null, kind: "UnresolvedReference", qualifiedName, startByte: null, endByte: null }),
    kind: "UnresolvedReference", name: expression.slice(-80) || "unresolved", qualifiedName, language: from.language,
    filePath: null, location: null, parentId: null, origin: "unresolved", signature: null,
    attributes: { observedExpression: expression.slice(0, 512), reason },
  };
  if (!ccm.nodes.some(node => node.id === target.id)) ccm.nodes.push(target);
  addEdge(ccm, from, target, kind, evidence, reason);
}
function moduleCandidates(resolved: string): string[] {
  const extension = resolved.slice(resolved.lastIndexOf("/") + 1).includes(".")
    ? resolved.slice(resolved.lastIndexOf(".")).toLowerCase() : "";
  if (extension) {
    const stem = resolved.slice(0, -extension.length);
    const mapped: Record<string, string[]> = {
      ".js": [".ts", ".tsx"], ".jsx": [".tsx"], ".mjs": [".mts"], ".cjs": [".cts"],
    };
    return [resolved, ...(mapped[extension] ?? []).map(item => `${stem}${item}`)];
  }
  const extensions = [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"];
  return [...extensions.map(extension => `${resolved}${extension}`), ...extensions.map(extension => `${resolved}/index${extension}`)];
}
function existingModule(candidates: string[], contexts: Map<string, FileContext>): ResolvedModule {
  const found = [...new Set(candidates.filter(candidate => contexts.has(candidate)))];
  if (found.length === 1) return { file: contexts.get(found[0]!)! };
  if (found.length > 1) return { reason: "AMBIGUOUS_SYMBOL" };
  return { reason: "EXTERNAL_DEPENDENCY" };
}
function resolveModule(from: FileContext, specifier: string, contexts: Map<string, FileContext>): ResolvedModule {
  if (specifier.startsWith(".")) {
    const path = normalizePath(`${from.path.slice(0, from.path.lastIndexOf("/") + 1)}${specifier}`);
    return path ? existingModule(moduleCandidates(path), contexts) : { reason: "UNSUPPORTED_CONSTRUCT" };
  }
  const matches = from.config.mappings.flatMap(mapping => {
    let replacement: string | null = null;
    const star = mapping.pattern.indexOf("*");
    if (star < 0) { if (specifier === mapping.pattern) replacement = ""; }
    else {
      const prefix = mapping.pattern.slice(0, star);
      const suffix = mapping.pattern.slice(star + 1);
      if (specifier.startsWith(prefix) && specifier.endsWith(suffix) && specifier.length >= prefix.length + suffix.length) {
        replacement = specifier.slice(prefix.length, specifier.length - suffix.length);
      }
    }
    if (replacement === null) return [];
    return mapping.targets.map(target => normalizePath(`${mapping.base}/${target.replace("*", replacement)}`)).filter((path): path is string => !!path);
  });
  const candidates = matches.length > 0 ? matches : from.config.baseUrl !== undefined
    ? [normalizePath(`${from.config.baseUrl}/${specifier}`)].filter((path): path is string => !!path) : [];
  if (candidates.length === 0) return { reason: "EXTERNAL_DEPENDENCY" };
  return existingModule(candidates.flatMap(moduleCandidates), contexts);
}
function parseConfig(bytes: Uint8Array): unknown {
  const text = UTF8.decode(bytes);
  return JSON.parse(text) as unknown;
}
function configsFor(input: DeclarationAnalysisInput, limitations: CcmV1["limitations"]): { entries: Array<[string, Uint8Array]>; byPath: Map<string, ResolverConfig> } | null {
  const raw = input.configurationSources;
  if (raw === undefined) return { entries: [], byPath: new Map() };
  if (!safeRecord(raw)) return null;
  const entries: Array<[string, Uint8Array]> = [];
  for (const path of Reflect.ownKeys(raw)) {
    if (typeof path !== "string" || !safePath(path)) return null;
    const descriptor = Object.getOwnPropertyDescriptor(raw, path);
    if (!descriptor || !descriptor.enumerable || !(descriptor.value instanceof Uint8Array)) return null;
    const basename = path.slice(path.lastIndexOf("/") + 1);
    if (!["tsconfig.json", "jsconfig.json", "package.json", "composer.json"].includes(basename)) return null;
    entries.push([path, new Uint8Array(descriptor.value)]);
  }
  entries.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  const byPath = new Map<string, ResolverConfig>();
  for (const [path, bytes] of entries) {
    if (!path.endsWith("tsconfig.json") && !path.endsWith("jsconfig.json")) continue;
    if (bytes.byteLength > MAX_CONFIGURATION_BYTES) {
      byPath.set(path, { mappings: [] });
      limitations.push({ path: null, stage: "resolve", reason: "Configuration exceeds the 1 MiB resolver limit; its bytes are hashed but not parsed." });
      continue;
    }
    try {
      const parsed = parseConfig(bytes);
      if (!safeRecord(parsed) || !safeRecord(parsed.compilerOptions ?? {})) throw new Error("invalid config shape");
      const options = (parsed.compilerOptions ?? {}) as Record<string, unknown>;
      const mappings: ResolverMapping[] = [];
      const configDirIndex = path.lastIndexOf("/");
      const configDir = configDirIndex < 0 ? "" : path.slice(0, configDirIndex);
      let baseUrl: string | undefined;
      if (options.baseUrl !== undefined) {
        if (typeof options.baseUrl !== "string" || !isRelativeConfigPath(options.baseUrl)) throw new Error("baseUrl must be a snapshot-relative path");
        const normalizedBase = normalizeSnapshotBase(`${configDir}/${options.baseUrl}`);
        if (normalizedBase === null) throw new Error("baseUrl escapes the snapshot root");
        baseUrl = normalizedBase;
      }
      if (options.paths !== undefined) {
        if (!safeRecord(options.paths)) throw new Error("paths must be an object");
        if (baseUrl === undefined) throw new Error("paths require a string baseUrl in the supported subset");
        for (const [pattern, values] of Object.entries(options.paths)) {
          if ((pattern.match(/\*/g) ?? []).length > 1 || !Array.isArray(values) || values.length === 0 ||
            values.some(value => typeof value !== "string" || !isRelativeConfigPath(value))) {
            throw new Error("only one-wildcard paths with string target arrays are supported");
          }
          mappings.push({ pattern, targets: values as string[], base: baseUrl });
        }
      }
      byPath.set(path, { mappings, ...(baseUrl !== undefined ? { baseUrl } : {}) });
      if (parsed.extends !== undefined || parsed.references !== undefined) {
        limitations.push({ path: null, stage: "resolve", reason: "Config extends and project references are not loaded; only local baseUrl/paths bytes are considered." });
      }
    } catch {
      byPath.set(path, { mappings: [] });
      limitations.push({ path: null, stage: "resolve", reason: "Configuration bytes were not valid supported JSON/baseUrl/paths data; no config file, network, or plugins were loaded." });
    }
  }
  return { entries, byPath };
}
function configForSource(path: string, configs: Map<string, ResolverConfig>): ResolverConfig {
  const parts = path.split("/");
  for (let depth = parts.length - 1; depth >= 0; depth -= 1) {
    const directory = parts.slice(0, depth).join("/");
    const candidates = [directory ? `${directory}/tsconfig.json` : "tsconfig.json", directory ? `${directory}/jsconfig.json` : "jsconfig.json"];
    for (const candidate of candidates) if (configs.has(candidate)) return configs.get(candidate)!;
  }
  return { mappings: [] };
}
function nodeForIdentifier(name: string, context: FileContext): CcmNode | null {
  const nodes = context.locals.get(name) ?? [];
  return nodes.length === 1 && !context.mutated.has(name) ? nodes[0]! : null;
}
function addLocalExport(context: FileContext, name: string, target: CcmNode): void {
  const values = context.exported.get(name) ?? [];
  if (!values.some(item => item.id === target.id)) values.push(target);
  context.exported.set(name, values);
}
function collectDeclarations(context: FileContext, offsets: Uint32Array): void {
  const walkDeclarations = (node: ts.Node) => {
    if (declarationKind(node)) {
      const found = declarationFor(node, context, offsets);
      if (found) context.declarations.set(node, found);
    }
    ts.forEachChild(node, walkDeclarations);
  };
  walkDeclarations(context.sourceFile);
  for (const statement of context.sourceFile.statements) {
    if (isNamedDeclaration(statement) && statement.name) {
      const node = declarationFor(statement, context, offsets);
      if (node) {
        const list = context.locals.get(statement.name.text) ?? [];
        list.push(node); context.locals.set(statement.name.text, list);
        if (hasModifier(statement, ts.SyntaxKind.ExportKeyword)) addLocalExport(context, statement.name.text, node);
        if (hasModifier(statement, ts.SyntaxKind.DefaultKeyword)) addLocalExport(context, "default", node);
      }
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        for (const name of namesFromBinding(declaration.name)) context.opaqueLocals.add(name);
        if (ts.isIdentifier(declaration.name) && declaration.initializer &&
          (statement.declarationList.flags & ts.NodeFlags.Const) !== 0 && ts.isNewExpression(declaration.initializer) && ts.isIdentifier(declaration.initializer.expression)) {
          const instance = nodeForIdentifier(declaration.initializer.expression.text, context);
          if (instance?.kind === "Class" && !context.mutated.has(declaration.name.text)) context.instanceAliases.set(declaration.name.text, instance);
        }
      }
    }
  }
  walkDeclarations(context.sourceFile);
  const markTarget = (target: ts.Expression | ts.BindingName) => {
    if (ts.isParenthesizedExpression(target)) { markTarget(target.expression); return; }
    if (ts.isIdentifier(target)) { context.mutated.add(target.text); return; }
    if (ts.isPropertyAccessExpression(target)) {
      const object = isThisExpression(target.expression) ? "this" : expressionName(target.expression) ?? target.expression.getText(context.sourceFile);
      context.mutated.add(`${object}.${target.name.text}`);
      if (isThisExpression(target.expression)) {
        for (let current: ts.Node | undefined = target.parent; current; current = current.parent) {
          if (!ts.isClassLike(current)) continue;
          const owner = context.declarations.get(current);
          if (owner) {
            context.mutated.add(`${owner.name}.${target.name.text}`);
            context.mutated.add(`${owner.qualifiedName}.${target.name.text}`);
          }
          break;
        }
      }
      return;
    }
    if (ts.isArrayBindingPattern(target) || ts.isObjectBindingPattern(target)) {
      for (const element of target.elements) if (!ts.isOmittedExpression(element)) markTarget(element.name);
      return;
    }
    if (ts.isArrayLiteralExpression(target)) {
      for (const element of target.elements) if (!ts.isOmittedExpression(element)) markTarget(ts.isSpreadElement(element) ? element.expression : element);
      return;
    }
    if (ts.isObjectLiteralExpression(target)) for (const property of target.properties) {
      if (ts.isShorthandPropertyAssignment(property)) markTarget(property.name);
      else if (ts.isPropertyAssignment(property)) markTarget(property.initializer);
      else if (ts.isSpreadAssignment(property)) markTarget(property.expression);
    }
  };
  const walkWrites = (node: ts.Node) => {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) markTarget(node.left);
    if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)) markTarget(node.operand);
    if ((ts.isForInStatement(node) || ts.isForOfStatement(node)) && !ts.isVariableDeclarationList(node.initializer)) markTarget(node.initializer as ts.Expression | ts.BindingName);
    ts.forEachChild(node, walkWrites);
  };
  walkWrites(context.sourceFile);
  for (const name of context.instanceAliases.keys()) if (context.mutated.has(name)) context.instanceAliases.delete(name);
}
function setupContexts(ccm: CcmV1, sources: Readonly<Record<string, Uint8Array>>, configs: Map<string, ResolverConfig>): Map<string, FileContext> {
  const contexts = new Map<string, FileContext>();
  for (const file of ccm.files) {
    if (file.status !== "processed") continue;
    const kind = sourceKind(file.path);
    const bytes = sources[file.path];
    if (!kind || !bytes) continue;
    let source: string;
    try { source = UTF8.decode(bytes); } catch { continue; }
    const offsets = byteMap(source);
    const fileSha256 = sha256(bytes);
    const sourceFile = ts.createSourceFile(file.path, source, ts.ScriptTarget.Latest, true, kind.scriptKind);
    const root = ccm.nodes.find(node => node.kind === "Module" && node.filePath === file.path && node.qualifiedName === file.path);
    if (!root) continue;
    const nodes = ccm.nodes.filter(node => node.filePath === file.path && node.origin === "source");
    const declarationsBySpan = new Map<string, CcmNode[]>();
    for (const node of nodes) if (node.location && ["Class", "Interface", "Function", "Method", "Property", "Module"].includes(node.kind)) {
      const spanKey = key(file.path, node.location.startByte, node.location.endByte);
      const candidates = declarationsBySpan.get(spanKey) ?? [];
      candidates.push(node);
      declarationsBySpan.set(spanKey, candidates);
    }
    contexts.set(file.path, {
      path: file.path, language: kind.language, source, bytes, offsets, fileSha256, sourceFile, moduleNode: root, nodes,
      declarations: new Map(), declarationsBySpan, imports: new Map(), exported: new Map(), uncertainExports: new Set(), locals: new Map(),
      opaqueLocals: new Set(), cjsBindingNames: new Set(), instanceAliases: new Map(), mutated: new Set(), moduleTargets: new Map(), config: configForSource(file.path, configs),
    });
  }
  for (const context of contexts.values()) {
    collectDeclarations(context, context.offsets);
  }
  return contexts;
}
function addContainment(ccm: CcmV1): void {
  const byId = new Map(ccm.nodes.map(node => [node.id, node]));
  for (const node of ccm.nodes) {
    if (!node.parentId || node.origin !== "source" || !node.location) continue;
    const parent = byId.get(node.parentId);
    if (!parent || parent.origin !== "source" || !parent.location) continue;
    addEdge(ccm, parent, node, "CONTAINS", { ...node.location }, null);
  }
}
function addModuleEdge(ccm: CcmV1, context: FileContext, ast: ts.Node, specifier: ts.StringLiteralLike, kind: "IMPORTS" | "EXPORTS", contexts: Map<string, FileContext>): ResolvedModule {
  const offsets = context.offsets;
  const start = specifier.getStart(context.sourceFile) + 1;
  const evidence = span(context, offsets, start, Math.max(start, specifier.end - 1));
  const resolution = resolveModule(context, specifier.text, contexts);
  context.moduleTargets.set(ast, resolution.file ?? null);
  const sourceNode = nearestSourceNode(ast, context);
  if (resolution.file) addEdge(ccm, sourceNode, resolution.file.moduleNode, kind, evidence, null);
  else addUnresolved(ccm, sourceNode, kind, evidence, specifier.text, resolution.reason);
  return resolution;
}
function localImportedNode(context: FileContext, name: string): SymbolResult {
  const nodes = context.exported.get(name) ?? [];
  const stable = nodes.filter(node => !context.mutated.has(node.name));
  if (context.uncertainExports.has(name) || context.uncertainExports.has("*")) return { reason: "UNKNOWN_RECEIVER" };
  if (stable.length === 1) return { target: stable[0]!, context };
  if (stable.length > 1) return { reason: "AMBIGUOUS_SYMBOL" };
  return { reason: nodes.length || context.uncertainExports.has(name) || context.uncertainExports.has("*") ? "UNKNOWN_RECEIVER" : "UNSUPPORTED_CONSTRUCT" };
}
function bindImport(ccm: CcmV1, source: FileContext, localName: string, importedName: string, node: ts.Node, resolution: ResolvedModule | null, targetContext: FileContext | null, contexts: Map<string, FileContext>): void {
  const offsets = byteMap(source.source);
  const evidence = span(source, offsets, node.getStart(source.sourceFile), node.end);
  let result: SymbolResult;
  if (!resolution?.file) result = { reason: resolution?.reason ?? "UNSUPPORTED_CONSTRUCT" };
  else result = localImportedNode(resolution.file, importedName);
  if (result && "target" in result) {
    source.imports.set(localName, { target: result.target, observed: `${targetContext?.path ?? resolution?.file?.path ?? ""}#${importedName}` });
    addEdge(ccm, source.moduleNode, result.target, "IMPORTS", evidence, null);
  } else {
    const reason = result.reason;
    source.imports.set(localName, { target: null, reason, observed: `${targetContext?.path ?? ""}#${importedName}` || importedName });
    addUnresolved(ccm, source.moduleNode, "IMPORTS", evidence, `${targetContext?.path ?? ""}#${importedName}` || importedName, reason);
  }
  void contexts;
}
function addRequireBinding(ccm: CcmV1, context: FileContext, declaration: ts.VariableDeclaration, target: FileContext | null, reason: UnresolvedReason | null): void {
  const offsets = context.offsets;
  const evidenceFor = (node: ts.Node) => span(context, offsets, node.getStart(context.sourceFile), node.end);
  if (ts.isIdentifier(declaration.name)) {
    context.cjsBindingNames.add(declaration.name.text);
    const property = declaration.initializer && ts.isPropertyAccessExpression(declaration.initializer) &&
      ts.isCallExpression(declaration.initializer.expression) && ts.isIdentifier(declaration.initializer.expression.expression) && declaration.initializer.expression.expression.text === "require"
      ? declaration.initializer.name.text : null;
    if (property) {
      if (target) {
        const result = localImportedNode(target, property);
        if ("target" in result) {
          context.imports.set(declaration.name.text, { target: result.target, observed: `${target.path}#${property}` });
          addEdge(ccm, context.moduleNode, result.target, "IMPORTS", evidenceFor(declaration.name), null);
        } else {
          context.imports.set(declaration.name.text, { target: null, reason: result.reason, observed: `${target.path}#${property}` });
          addUnresolved(ccm, context.moduleNode, "IMPORTS", evidenceFor(declaration.name), `${target.path}#${property}`, result.reason);
        }
      } else {
        const unresolvedReason = reason ?? "EXTERNAL_DEPENDENCY";
        context.imports.set(declaration.name.text, { target: null, reason: unresolvedReason, observed: property });
        addUnresolved(ccm, context.moduleNode, "IMPORTS", evidenceFor(declaration.name), property, unresolvedReason);
      }
    } else if (target) context.imports.set(declaration.name.text, { target: target.moduleNode, observed: target.path, namespace: target });
    else context.imports.set(declaration.name.text, { target: null, reason: reason ?? "EXTERNAL_DEPENDENCY", observed: declaration.name.text });
    return;
  }
  if (ts.isObjectBindingPattern(declaration.name)) {
    for (const element of declaration.name.elements) {
      if (!ts.isIdentifier(element.name)) continue;
      context.cjsBindingNames.add(element.name.text);
      const importedName = element.propertyName ? element.propertyName.getText(context.sourceFile) : element.name.text;
      const evidence = evidenceFor(element);
      const result = target ? localImportedNode(target, importedName) : { reason: reason ?? "EXTERNAL_DEPENDENCY" } as const;
      if ("target" in result) {
        context.imports.set(element.name.text, { target: result.target, observed: `${target!.path}#${importedName}` });
        addEdge(ccm, context.moduleNode, result.target, "IMPORTS", evidence, null);
      } else {
        context.imports.set(element.name.text, { target: null, reason: result.reason, observed: `${target?.path ?? ""}#${importedName}` || importedName });
        addUnresolved(ccm, context.moduleNode, "IMPORTS", evidence, `${target?.path ?? ""}#${importedName}` || importedName, result.reason);
      }
    }
  }
}
function processModuleReferences(ccm: CcmV1, contexts: Map<string, FileContext>): void {
  for (const context of contexts.values()) {
    const visit = (node: ts.Node) => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
        const resolution = addModuleEdge(ccm, context, node, node.moduleSpecifier, "IMPORTS", contexts);
        const clause = node.importClause;
        if (clause?.name) bindImport(ccm, context, clause.name.text, "default", clause.name, resolution, resolution.file ?? null, contexts);
        if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) for (const element of clause.namedBindings.elements) {
          bindImport(ccm, context, element.name.text, element.propertyName?.text ?? element.name.text, element, resolution, resolution.file ?? null, contexts);
        }
        if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
          if (resolution.file) context.imports.set(clause.namedBindings.name.text, { target: resolution.file.moduleNode, observed: resolution.file.path, namespace: resolution.file });
          else context.imports.set(clause.namedBindings.name.text, { target: null, reason: resolution.reason, observed: node.moduleSpecifier.text });
        }
      } else if (ts.isExportDeclaration(node)) {
        const resolution = node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)
          ? addModuleEdge(ccm, context, node, node.moduleSpecifier, "EXPORTS", contexts) : null;
        if (node.exportClause && ts.isNamedExports(node.exportClause)) for (const element of node.exportClause.elements) {
          const importedName = element.propertyName?.text ?? element.name.text;
          if (node.moduleSpecifier) {
            if (resolution?.file) {
              const found = localImportedNode(resolution.file, importedName);
              const evidence = span(context, context.offsets, element.getStart(context.sourceFile), element.end);
              if ("target" in found) {
                addLocalExport(context, element.name.text, found.target);
                addEdge(ccm, context.moduleNode, found.target, "EXPORTS", evidence, null);
              } else addUnresolved(ccm, context.moduleNode, "EXPORTS", evidence, `${resolution.file.path}#${importedName}`, found.reason);
            } else {
              const evidence = span(context, context.offsets, element.getStart(context.sourceFile), element.end);
              addUnresolved(ccm, context.moduleNode, "EXPORTS", evidence, `${node.moduleSpecifier.getText(context.sourceFile)}#${importedName}`, resolution?.reason ?? "UNSUPPORTED_CONSTRUCT");
            }
          } else {
            const local = context.imports.get(importedName)?.target ?? nodeForIdentifier(importedName, context);
            const evidence = span(context, context.offsets, element.getStart(context.sourceFile), element.end);
            if (local && local.kind !== "Module") {
              addLocalExport(context, element.name.text, local);
              addEdge(ccm, context.moduleNode, local, "EXPORTS", evidence, null);
            } else addUnresolved(ccm, context.moduleNode, "EXPORTS", evidence, importedName, "UNKNOWN_RECEIVER");
          }
        }
      } else if (ts.isExportAssignment(node)) {
        const expression = node.expression;
        if (ts.isIdentifier(expression)) {
          const local = context.imports.get(expression.text)?.target ?? nodeForIdentifier(expression.text, context);
          if (local) addLocalExport(context, "default", local);
          else context.opaqueLocals.add("default");
        } else context.opaqueLocals.add("default");
      }
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "require" && isUnshadowedCommonJs("require", context, node)) {
        const staticSpecifier = node.arguments.length === 1 && (ts.isStringLiteralLike(node.arguments[0]!) ? node.arguments[0] as ts.StringLiteralLike : null);
        if (staticSpecifier) {
          const resolution = addModuleEdge(ccm, context, node, staticSpecifier, "IMPORTS", contexts);
          const variable = ts.isVariableDeclaration(node.parent) && node.parent.initializer === node &&
            ts.isVariableStatement(node.parent.parent.parent) && ts.isSourceFile(node.parent.parent.parent.parent)
            ? node.parent : null;
          if (variable) addRequireBinding(ccm, context, variable, resolution.file ?? null, resolution.file ? null : resolution.reason);
        } else {
          const enclosing = node.parent && ts.isPropertyAccessExpression(node.parent) ? node.parent : node;
          const argument = node.arguments[0];
          const evidenceNode = argument && !ts.isStringLiteralLike(argument) ? argument : enclosing;
          const evidence = span(context, context.offsets, evidenceNode.getStart(context.sourceFile), evidenceNode.end);
          addUnresolved(ccm, nearestSourceNode(enclosing, context), "IMPORTS", evidence, enclosing.getText(context.sourceFile), "DYNAMIC_LOAD");
        }
      }
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const argument = node.arguments[0];
        if (argument && ts.isStringLiteralLike(argument)) addModuleEdge(ccm, context, node, argument, "IMPORTS", contexts);
        else {
          const evidenceNode = argument ?? node;
          const evidence = span(context, context.offsets, evidenceNode.getStart(context.sourceFile), evidenceNode.end);
          addUnresolved(ccm, nearestSourceNode(node, context), "IMPORTS", evidence, node.getText(context.sourceFile), "DYNAMIC_LOAD");
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(context.sourceFile);
  }
}
function processCommonJsExports(ccm: CcmV1, context: FileContext): void {
  const resolveLocal = (name: string): CcmNode | null => {
    const imported = context.imports.get(name);
    if (imported?.target && !imported.namespace) return imported.target;
    return nodeForIdentifier(name, context);
  };
  const exportExpression = (expression: ts.Expression, exportedName: string, evidence: EvidenceSpan) => {
    if (ts.isIdentifier(expression)) {
      const target = resolveLocal(expression.text);
      if (target) {
        addLocalExport(context, exportedName, target);
        addEdge(ccm, context.moduleNode, target, "EXPORTS", evidence, null);
      } else {
        context.uncertainExports.add(exportedName);
        addUnresolved(ccm, context.moduleNode, "EXPORTS", evidence, expression.text, "UNKNOWN_RECEIVER");
      }
    } else if (ts.isObjectLiteralExpression(expression)) {
      for (const property of expression.properties) {
        if (ts.isShorthandPropertyAssignment(property)) {
          const target = resolveLocal(property.name.text);
          const itemEvidence = span(context, context.offsets, property.getStart(context.sourceFile), property.end);
          if (target) { addLocalExport(context, property.name.text, target); addEdge(ccm, context.moduleNode, target, "EXPORTS", itemEvidence, null); }
          else {
            context.uncertainExports.add(property.name.text);
            addUnresolved(ccm, context.moduleNode, "EXPORTS", itemEvidence, property.name.text, "UNKNOWN_RECEIVER");
          }
        } else if (ts.isPropertyAssignment(property) && (ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name))) {
          const target = ts.isIdentifier(property.initializer) ? resolveLocal(property.initializer.text) : null;
          const itemEvidence = span(context, context.offsets, property.getStart(context.sourceFile), property.end);
          if (target) { addLocalExport(context, property.name.text, target); addEdge(ccm, context.moduleNode, target, "EXPORTS", itemEvidence, null); }
          else {
            context.uncertainExports.add(property.name.text);
            addUnresolved(ccm, context.moduleNode, "EXPORTS", itemEvidence, property.name.text, "UNSUPPORTED_CONSTRUCT");
          }
        }
      }
    } else addUnresolved(ccm, context.moduleNode, "EXPORTS", evidence, expression.getText(context.sourceFile), "UNSUPPORTED_CONSTRUCT");
  };
  let exportsAliasActive = true;
  const handled = new Set<ts.Node>();
  for (const statement of context.sourceFile.statements) {
    if (ts.isExpressionStatement(statement) && ts.isBinaryExpression(statement.expression) && statement.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const assignment = statement.expression;
      const left = assignment.left;
      const evidence = span(context, context.offsets, left.getStart(context.sourceFile), left.end);
      if (ts.isPropertyAccessExpression(left) && ts.isIdentifier(left.expression) && left.expression.text === "module" && left.name.text === "exports" && isUnshadowedCommonJs("module", context, left)) {
        handled.add(assignment);
        for (const name of context.exported.keys()) context.uncertainExports.add(name);
        context.exported.clear();
        exportsAliasActive = false;
        exportExpression(assignment.right, "default", evidence);
      } else if (ts.isPropertyAccessExpression(left) && ts.isPropertyAccessExpression(left.expression) &&
        ts.isIdentifier(left.expression.expression) && left.expression.expression.text === "module" && left.expression.name.text === "exports" &&
        isUnshadowedCommonJs("module", context, left)) {
        handled.add(assignment);
        context.exported.delete(left.name.text);
        context.uncertainExports.delete(left.name.text);
        exportExpression(assignment.right, left.name.text, evidence);
      } else if (ts.isPropertyAccessExpression(left) && ts.isIdentifier(left.expression) && left.expression.text === "exports" &&
        exportsAliasActive && isUnshadowedCommonJs("exports", context, left)) {
        handled.add(assignment);
        context.exported.delete(left.name.text);
        context.uncertainExports.delete(left.name.text);
        exportExpression(assignment.right, left.name.text, evidence);
      } else if (ts.isIdentifier(left) && left.text === "exports" && isUnshadowedCommonJs("exports", context, left)) {
        exportsAliasActive = false;
        handled.add(assignment);
      }
    }
  }
  let conditionalMutation = false;
  const visit = (node: ts.Node) => {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && !handled.has(node)) {
      const left = node.left;
      if (ts.isPropertyAccessExpression(left) && ts.isIdentifier(left.expression) && left.expression.text === "exports" && isUnshadowedCommonJs("exports", context, left)) conditionalMutation = true;
      if (ts.isPropertyAccessExpression(left) && ts.isIdentifier(left.expression) && left.expression.text === "module" && left.name.text === "exports" && isUnshadowedCommonJs("module", context, left)) conditionalMutation = true;
      if (ts.isPropertyAccessExpression(left) && ts.isPropertyAccessExpression(left.expression) && ts.isIdentifier(left.expression.expression) &&
        left.expression.expression.text === "module" && left.expression.name.text === "exports" && isUnshadowedCommonJs("module", context, left)) conditionalMutation = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(context.sourceFile);
  if (conditionalMutation) {
    context.exported.clear();
    context.uncertainExports.add("*");
  }
}
function nearestSourceNode(node: ts.Node, context: FileContext): CcmNode {
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    const found = context.declarations.get(current);
    if (found) return found;
  }
  return context.moduleNode;
}
function directShadow(name: string, use: ts.Node): boolean {
  const scanScope = (scope: ts.Node): boolean => {
    let shadows = false;
    const visit = (node: ts.Node) => {
      if (ts.isFunctionDeclaration(node) && node.name?.text === name) shadows = true;
      if (ts.isClassDeclaration(node) && node.name?.text === name) shadows = true;
      if (node !== scope && (ts.isFunctionLike(node) || ts.isClassLike(node) || ts.isModuleDeclaration(node))) return;
      if (ts.isVariableDeclaration(node) && namesFromBinding(node.name).includes(name)) shadows = true;
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(scope, visit);
    return shadows;
  };
  for (let current: ts.Node | undefined = use.parent; current && !ts.isSourceFile(current); current = current.parent) {
    if (ts.isFunctionLike(current)) {
      if (current.parameters.some(parameter => namesFromBinding(parameter.name).includes(name))) return true;
      if ((ts.isFunctionExpression(current) || ts.isClassExpression(current)) && current.name && ts.isIdentifier(current.name) && current.name.text === name) return true;
      if (scanScope(current)) return true;
    } else if (ts.isBlock(current) || ts.isModuleBlock(current) || ts.isCatchClause(current)) {
      if (ts.isCatchClause(current) && current.variableDeclaration && namesFromBinding(current.variableDeclaration.name).includes(name)) return true;
      if (scanScope(current)) return true;
    }
  }
  return false;
}
function isUnshadowedCommonJs(name: string, context: FileContext, use: ts.Node): boolean {
  const imported = context.sourceFile.statements.some(statement => ts.isImportDeclaration(statement) && statement.importClause && (
    statement.importClause.name?.text === name || (statement.importClause.namedBindings &&
      (ts.isNamespaceImport(statement.importClause.namedBindings) ? statement.importClause.namedBindings.name.text === name :
        statement.importClause.namedBindings.elements.some(element => element.name.text === name)))
  ));
  return !directShadow(name, use) && !imported && !context.opaqueLocals.has(name) && !context.imports.has(name) &&
    (context.locals.get(name)?.length ?? 0) === 0 && !context.mutated.has(name);
}
function resolveSymbol(name: string, context: FileContext, contexts: Map<string, FileContext>, use: ts.Node): SymbolResult {
  if (directShadow(name, use)) return { reason: "UNKNOWN_RECEIVER" };
  if (context.mutated.has(name)) return { reason: "UNKNOWN_RECEIVER" };
  const imported = context.imports.get(name);
  if (imported) {
    if (imported.namespace) return { reason: "UNSUPPORTED_CONSTRUCT" };
    if (imported.target) return { target: imported.target, context: imported.target.filePath ? contexts.get(imported.target.filePath)! : context };
    return { reason: imported.reason ?? "EXTERNAL_DEPENDENCY" };
  }
  if (context.opaqueLocals.has(name) && !context.cjsBindingNames.has(name)) return { reason: "UNKNOWN_RECEIVER" };
  const local = context.locals.get(name) ?? [];
  if (local.length > 1) return { reason: "AMBIGUOUS_SYMBOL" };
  if (local.length === 1) return { target: local[0]!, context };
  return { reason: "UNKNOWN_RECEIVER" };
}
function resolveNamespaceMember(name: string, context: FileContext, contexts: Map<string, FileContext>, use: ts.Node): SymbolResult | null {
  if (!ts.isPropertyAccessExpression(use) || !ts.isIdentifier(use.expression)) return null;
  const binding = context.imports.get(use.expression.text);
  const knownInstance = context.instanceAliases.has(use.expression.text);
  if (directShadow(use.expression.text, use) || context.mutated.has(use.expression.text) ||
    context.mutated.has(`${use.expression.text}.${name}`) || (!knownInstance && context.opaqueLocals.has(use.expression.text) && !context.cjsBindingNames.has(use.expression.text))) {
    if (binding || context.opaqueLocals.has(use.expression.text)) return { reason: "UNKNOWN_RECEIVER" };
  }
  if (!binding?.namespace) return null;
  const exported = binding.namespace.exported.get(name) ?? [];
  const stable = exported.filter(node => !binding.namespace!.mutated.has(node.name));
  if (binding.namespace.uncertainExports.has(name) || binding.namespace.uncertainExports.has("*")) return { reason: "UNKNOWN_RECEIVER" };
  if (stable.length === 1) return { target: stable[0]!, context: binding.namespace };
  if (stable.length > 1) return { reason: "AMBIGUOUS_SYMBOL" };
  return { reason: exported.length || binding.namespace.uncertainExports.has(name) || binding.namespace.uncertainExports.has("*") ? "UNKNOWN_RECEIVER" : "UNSUPPORTED_CONSTRUCT" };
}
function classOwner(type: ts.TypeNode | undefined, context: FileContext, contexts: Map<string, FileContext>, use: ts.Node): { owner: CcmNode; context: FileContext } | null {
  if (!type || !ts.isTypeReferenceNode(type)) return null;
  const name = expressionName(type.typeName);
  if (!name || name.includes(".")) return null;
  const resolved = resolveSymbol(name, context, contexts, use);
  if (!("target" in resolved) || !(resolved.target.kind === "Class" || resolved.target.kind === "Interface")) return null;
  return { owner: resolved.target, context: resolved.context };
}
function collectInstanceAliases(context: FileContext, contexts: Map<string, FileContext>): void {
  for (const statement of context.sourceFile.statements) {
    if (!ts.isVariableStatement(statement) || (statement.declarationList.flags & ts.NodeFlags.Const) === 0) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer || !ts.isNewExpression(declaration.initializer) ||
        !ts.isIdentifier(declaration.initializer.expression) || context.mutated.has(declaration.name.text)) continue;
      const constructor = resolveSymbol(declaration.initializer.expression.text, context, contexts, declaration.initializer.expression);
      if ("target" in constructor && constructor.target.kind === "Class") context.instanceAliases.set(declaration.name.text, constructor.target);
    }
  }
}
function receiverFor(receiver: ts.Expression, use: ts.Node, context: FileContext, contexts: Map<string, FileContext>): ReceiverResult {
  if (isThisExpression(receiver)) {
    for (let current: ts.Node | undefined = use.parent; current; current = current.parent) {
      if (ts.isFunctionDeclaration(current) || ts.isFunctionExpression(current) ||
        (ts.isMethodDeclaration(current) && !ts.isClassLike(current.parent)) ||
        ((ts.isGetAccessorDeclaration(current) || ts.isSetAccessorDeclaration(current)) && !ts.isClassLike(current.parent))) {
        return { reason: "UNKNOWN_RECEIVER" };
      }
      if (ts.isClassLike(current)) {
        const owner = context.declarations.get(current);
        if (!owner) return { reason: "UNKNOWN_RECEIVER" };
        const caller = nearestSourceNode(use, context);
        const mode = (caller.kind === "Method" || caller.kind === "Property") && caller.attributes.static === true ? "static" : "instance";
        return { owner, context, mode };
      }
    }
    return { reason: "UNKNOWN_RECEIVER" };
  }
  if (ts.isIdentifier(receiver)) {
    if (context.mutated.has(receiver.text)) return { reason: "UNKNOWN_RECEIVER" };
    const imported = context.imports.get(receiver.text);
    for (let current: ts.Node | undefined = receiver.parent; current && !ts.isSourceFile(current); current = current.parent) {
      if (ts.isFunctionLike(current)) {
        const parameter = current.parameters.find(item => ts.isIdentifier(item.name) && item.name.text === receiver.text);
        if (parameter) {
          const typed = classOwner(parameter.type, context, contexts, parameter);
          return typed ? { owner: typed.owner, context: typed.context, mode: "instance" } : { reason: "UNKNOWN_RECEIVER" };
        }
        break;
      }
    }
    if (directShadow(receiver.text, receiver) || context.mutated.has(receiver.text)) return { reason: "UNKNOWN_RECEIVER" };
    if (imported?.namespace) return { reason: "UNSUPPORTED_CONSTRUCT" };
    if (context.instanceAliases.has(receiver.text)) return { owner: context.instanceAliases.get(receiver.text)!, context, mode: "instance" };
    const resolved = resolveSymbol(receiver.text, context, contexts, receiver);
    if ("target" in resolved && resolved.target.kind === "Class") return { owner: resolved.target, context: resolved.context, mode: "static" };
  }
  return { reason: "UNKNOWN_RECEIVER" };
}
function memberNodes(owner: CcmNode, name: string, contexts: Map<string, FileContext>): CcmNode[] {
  const ownerContext = owner.filePath ? contexts.get(owner.filePath) : undefined;
  if (!ownerContext) return [];
  return ownerContext.nodes.filter(node => node.parentId === owner.id && node.name === name && (node.kind === "Method" || node.kind === "Property"));
}
function memberWasMutated(receiver: ts.Expression, name: string, owner: CcmNode, context: FileContext, contexts: Map<string, FileContext>): boolean {
  const receiverName = isThisExpression(receiver) ? "this" : expressionName(receiver);
  const keys = [`${receiverName ?? ""}.${name}`, `${owner.name}.${name}`, `${owner.qualifiedName}.${name}`];
  const ownerContext = owner.filePath ? contexts.get(owner.filePath) : undefined;
  return keys.some(item => context.mutated.has(item) || ownerContext?.mutated.has(item));
}
function isWrite(node: ts.PropertyAccessExpression): boolean {
  const parent = node.parent;
  if (ts.isBinaryExpression(parent) && parent.left === node && parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment) return true;
  return (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) &&
    (parent.operator === ts.SyntaxKind.PlusPlusToken || parent.operator === ts.SyntaxKind.MinusMinusToken);
}
function emitNamed(ccm: CcmV1, context: FileContext, contexts: Map<string, FileContext>, use: ts.Node, name: string, kind: EdgeKind): void {
  const from = nearestSourceNode(use, context);
  const evidence = span(context, context.offsets, use.getStart(context.sourceFile), use.end);
  const namespace = resolveNamespaceMember(name, context, contexts, use);
  const resolved = namespace ?? resolveSymbol(name, context, contexts, use);
  if ("target" in resolved) addEdge(ccm, from, resolved.target, kind, evidence, null);
  else addUnresolved(ccm, from, kind, evidence, name, resolved.reason);
}
function addReferences(ccm: CcmV1, contexts: Map<string, FileContext>): void {
  const visitContext = (context: FileContext) => {
    const walk = (node: ts.Node) => {
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
      if (ts.isHeritageClause(node)) {
        const kind: EdgeKind = node.token === ts.SyntaxKind.ExtendsKeyword ? "EXTENDS" : "IMPLEMENTS";
        for (const type of node.types) {
          const name = expressionName(type.expression);
          if (name) emitNamed(ccm, context, contexts, type.expression, name, kind);
        }
      }
      if (ts.isTypeReferenceNode(node)) {
        const name = expressionName(node.typeName);
        if (name && !BUILTIN_TYPES.has(name.split(".").at(-1)!)) emitNamed(ccm, context, contexts, node.typeName, name, "TYPE_REFERENCES");
      }
      if (ts.isCallExpression(node) && node.expression.kind !== ts.SyntaxKind.ImportKeyword &&
        !(ts.isIdentifier(node.expression) && node.expression.text === "require" && isUnshadowedCommonJs("require", context, node))) {
        if (ts.isIdentifier(node.expression)) emitNamed(ccm, context, contexts, node.expression, node.expression.text, "CALLS");
        else if (ts.isPropertyAccessExpression(node.expression)) {
          const expression = node.expression;
          const evidence = span(context, context.offsets, expression.name.getStart(context.sourceFile), expression.name.end);
          const from = nearestSourceNode(node, context);
          const namespace = resolveNamespaceMember(expression.name.text, context, contexts, expression);
          if (namespace) {
            if ("target" in namespace) addEdge(ccm, from, namespace.target, "CALLS", evidence, null);
            else addUnresolved(ccm, from, "CALLS", evidence, expression.getText(context.sourceFile), namespace.reason);
          } else {
            const receiver = receiverFor(expression.expression, expression, context, contexts);
            if ("owner" in receiver) {
              const matches = memberNodes(receiver.owner, expression.name.text, contexts).filter(member => member.kind === "Method" && (member.attributes.static === true) === (receiver.mode === "static"));
              if (memberWasMutated(expression.expression, expression.name.text, receiver.owner, context, contexts)) addUnresolved(ccm, from, "CALLS", evidence, expression.getText(context.sourceFile), "UNKNOWN_RECEIVER");
              else if (matches.length === 1) addEdge(ccm, from, matches[0]!, "CALLS", evidence, null);
              else addUnresolved(ccm, from, "CALLS", evidence, expression.getText(context.sourceFile), matches.length > 1 ? "AMBIGUOUS_SYMBOL" : "UNKNOWN_RECEIVER");
            } else addUnresolved(ccm, from, "CALLS", evidence, expression.getText(context.sourceFile), receiver.reason);
          }
        } else {
          const evidence = span(context, context.offsets, node.expression.getStart(context.sourceFile), node.expression.end);
          addUnresolved(ccm, nearestSourceNode(node, context), "CALLS", evidence, node.expression.getText(context.sourceFile), "UNKNOWN_RECEIVER");
        }
      }
      if (ts.isNewExpression(node)) {
        const name = expressionName(node.expression);
        if (name) emitNamed(ccm, context, contexts, node.expression, name, "INSTANTIATES");
        else {
          const evidence = span(context, context.offsets, node.expression.getStart(context.sourceFile), node.expression.end);
          addUnresolved(ccm, nearestSourceNode(node, context), "INSTANTIATES", evidence, node.expression.getText(context.sourceFile), "UNSUPPORTED_CONSTRUCT");
        }
      }
      if (ts.isPropertyAccessExpression(node) && !ts.isCallExpression(node.parent) && !ts.isPropertyAccessExpression(node.parent) && !ts.isNewExpression(node.parent)) {
        const namespace = resolveNamespaceMember(node.name.text, context, contexts, node);
        const evidence = span(context, context.offsets, node.name.getStart(context.sourceFile), node.name.end);
        const from = nearestSourceNode(node, context);
        if (namespace) {
          if ("target" in namespace) addEdge(ccm, from, namespace.target, isWrite(node) ? "WRITES" : "READS", evidence, null);
          else addUnresolved(ccm, from, isWrite(node) ? "WRITES" : "READS", evidence, node.getText(context.sourceFile), namespace.reason);
        } else {
          const receiver = receiverFor(node.expression, node, context, contexts);
          if ("owner" in receiver) {
            const matches = memberNodes(receiver.owner, node.name.text, contexts).filter(member => member.kind === "Property" && (member.attributes.static === true) === (receiver.mode === "static"));
            if (matches.length === 1) addEdge(ccm, from, matches[0]!, isWrite(node) ? "WRITES" : "READS", evidence, null);
            else addUnresolved(ccm, from, isWrite(node) ? "WRITES" : "READS", evidence, node.getText(context.sourceFile), matches.length > 1 ? "AMBIGUOUS_SYMBOL" : "UNKNOWN_RECEIVER");
          } else if (ts.isIdentifier(node.expression) || isThisExpression(node.expression)) {
            addUnresolved(ccm, from, isWrite(node) ? "WRITES" : "READS", evidence, node.getText(context.sourceFile), receiver.reason);
          }
        }
      }
      ts.forEachChild(node, walk);
    };
    walk(context.sourceFile);
  };
  for (const context of contexts.values()) visitContext(context);
}
function resolve(input: DeclarationAnalysisInput): DeclarationAnalysisResult {
  const base = analyzeDeclarations(input);
  if (!base.ccm || !input || !safeRecord(input.sources)) return base;
  const ccm = structuredClone(base.ccm);
  const sources: Record<string, Uint8Array> = {};
  for (const key of Reflect.ownKeys(input.sources)) {
    if (typeof key !== "string") return { ...base, status: "failed", ccm: null, canonicalJson: null, contentSha256: null, errorCode: "ANALYZER_INPUT_INVALID" };
    const descriptor = Object.getOwnPropertyDescriptor(input.sources, key);
    if (!descriptor || !(descriptor.value instanceof Uint8Array)) return { ...base, status: "failed", ccm: null, canonicalJson: null, contentSha256: null, errorCode: "ANALYZER_INPUT_INVALID" };
    sources[key] = new Uint8Array(descriptor.value);
  }
  const parsedConfigs = configsFor(input, ccm.limitations);
  if (!parsedConfigs) return { ...base, status: "failed", ccm: null, canonicalJson: null, contentSha256: null, errorCode: "ANALYZER_INPUT_INVALID" };
  const contexts = setupContexts(ccm, sources, parsedConfigs.byPath);
  addContainment(ccm);
  for (const context of contexts.values()) processCommonJsExports(ccm, context);
  processModuleReferences(ccm, contexts);
  for (const context of contexts.values()) collectInstanceAliases(context, contexts);
  addReferences(ccm, contexts);
  ccm.limitations = ccm.limitations.filter(item => !(item.stage === "resolve" && item.reason.startsWith("This adapter extracts declarations only;")));
  const configFingerprint = parsedConfigs.entries.map(([path, bytes]) => `${path}:${sha256(bytes)}`).join("\n");
  ccm.provenance = { ...ccm.provenance, resolver: { name: "sage-js-ts-static-resolver", version: RESOLVER_VERSION } };
  ccm.provenance.configHash = sha256(`${ccm.provenance.configHash}\n${RESOLVER_VERSION}\ntypescript-5.9.3\n${configFingerprint}`);
  const canonical = canonicalizeCcm(ccm, sources);
  if (!canonical.ok) return { ...base, status: "failed", ccm: null, canonicalJson: null, contentSha256: null, errorCode: `CCM_INVALID:${canonical.errorCode}` };
  const unresolvedFacts = canonical.value.edges.some(edge => edge.resolution === "Unresolved");
  const meaningfulLimitations = canonical.value.limitations.length > 0;
  const status = base.status === "failed" ? "failed" : meaningfulLimitations || unresolvedFacts ? "partial" : "complete";
  return { ...base, status, ccm: canonical.value, canonicalJson: canonical.json, contentSha256: canonical.sha256 };
}

/** Resolve only static JS/TS facts evidenced by supplied source/configuration bytes; no files, plugins, network, or code are loaded. */
export function analyzeReferences(input: DeclarationAnalysisInput): DeclarationAnalysisResult {
  try { return resolve(input); }
  catch { return { status: "failed", ccm: null, canonicalJson: null, contentSha256: null, diagnostics: [], errorCode: "ANALYZER_FAILURE" }; }
}
