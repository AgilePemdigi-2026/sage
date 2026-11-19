import ts from "typescript";
import type { EvidenceSpan } from "@sage/contracts";
import { excludeFromMainFlow, evidenceSpan, emptyFragment, semanticEdgeId, semanticNode } from "./builder.ts";
import type { SemanticEdge, SemanticFragment, SemanticInput, SemanticNode } from "./model.ts";

const MAX_SOURCE_BYTES = 524_288;
const SOURCE_PATH = /\.[cm]?[jt]sx?$/iu;

type Source = { path: string; bytes: Uint8Array; text: string; file: ts.SourceFile };
type SqlOperation = "reads" | "creates" | "updates" | "deletes";
type TableOperation = { table: string; operation: SqlOperation };
type OperationMetadata = "read" | "create" | "update" | "delete";

function scriptKind(path: string): ts.ScriptKind {
  if (/\.tsx$/iu.test(path)) return ts.ScriptKind.TSX;
  if (/\.jsx$/iu.test(path)) return ts.ScriptKind.JSX;
  if (/\.js$/iu.test(path) || /\.mjs$/iu.test(path) || /\.cjs$/iu.test(path)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function unwrap(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isTypeAssertionExpression(current) ||
      ts.isSatisfiesExpression(current) || ts.isAwaitExpression(current) || ts.isNonNullExpression(current)) {
    current = current.expression;
  }
  return current;
}

function staticString(expression: ts.Expression, constants: ReadonlyMap<string, string>, depth = 0): string | null {
  if (depth > 8) return null;
  const value = unwrap(expression);
  if (ts.isStringLiteralLike(value) || ts.isNoSubstitutionTemplateLiteral(value)) return value.text;
  if (ts.isIdentifier(value)) return constants.get(value.text) ?? null;
  if (ts.isTemplateExpression(value)) {
    let output = value.head.text;
    for (const span of value.templateSpans) {
      const substitution = unwrap(span.expression);
      const resolved = ts.isIdentifier(substitution) ? constants.get(substitution.text) : undefined;
      if (resolved === undefined) return null;
      output += resolved;
      output += span.literal.text;
    }
    return output;
  }
  return null;
}

function collectConstants(file: ts.SourceFile, imported: ReadonlyMap<string, string> = new Map()): Map<string, string> {
  const constants = new Map(imported);
  const declarations = file.statements.flatMap(statement => ts.isVariableStatement(statement) &&
    (statement.declarationList.flags & ts.NodeFlags.Const) ? statement.declarationList.declarations : []);
  for (let pass = 0; pass < 8; pass++) {
    let changed = false;
    for (const declaration of declarations) {
      const value = staticString(declaration.initializer!, constants);
      if (value !== null && constants.get(declaration.name.getText(file)) !== value) {
        constants.set(declaration.name.getText(file), value);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return constants;
}

function resolveImportedSource(importerPath: string, specifier: string, knownPaths: ReadonlySet<string>): string | null {
  const paths = new Set<string>();
  if (specifier.startsWith("@/")) {
    const suffix = specifier.slice(2);
    paths.add(`src/${suffix}`);
    paths.add(suffix);
    paths.add(`app/${suffix}`);
  } else if (specifier.startsWith(".")) {
    const segments = importerPath.split("/");
    segments.pop();
    for (const segment of specifier.split("/")) {
      if (!segment || segment === ".") continue;
      if (segment === "..") segments.pop();
      else segments.push(segment);
    }
    paths.add(segments.join("/"));
  } else return null;
  for (const base of paths) {
    for (const candidate of [base, ...["ts", "tsx", "js", "jsx", "mjs", "cjs"].map(extension => `${base}.${extension}`),
      ...["ts", "tsx", "js", "jsx"].map(extension => `${base}/index.${extension}`)]) {
      if (knownPaths.has(candidate)) return candidate;
    }
  }
  return null;
}

function importBindings(source: Source, knownPaths: ReadonlySet<string>): Array<{ modulePath: string; imported: string; local: string }> {
  const bindings: Array<{ modulePath: string; imported: string; local: string }> = [];
  for (const statement of source.file.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || !statement.importClause) continue;
    const modulePath = resolveImportedSource(source.path, statement.moduleSpecifier.text, knownPaths);
    if (!modulePath) continue;
    const names = statement.importClause.namedBindings;
    if (names && ts.isNamedImports(names)) for (const element of names.elements) {
      bindings.push({ modulePath, imported: element.propertyName?.text ?? element.name.text, local: element.name.text });
    }
  }
  return bindings;
}

function exportedStringConstants(source: Source, constants: ReadonlyMap<string, string>): Map<string, string> {
  const exports = new Map<string, string>();
  for (const statement of source.file.statements) {
    if (!ts.isVariableStatement(statement) || !(statement.modifiers ?? []).some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword) ||
        !(statement.declarationList.flags & ts.NodeFlags.Const)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
      const value = staticString(declaration.initializer, constants);
      if (value !== null) exports.set(declaration.name.text, value);
    }
  }
  return exports;
}

function collectWorkspaceConstants(sources: Source[]): Map<string, Map<string, string>> {
  const knownPaths = new Set(sources.map(source => source.path));
  const bindings = new Map(sources.map(source => [source.path, importBindings(source, knownPaths)]));
  const constants = new Map(sources.map(source => [source.path, new Map<string, string>()]));
  const exports = new Map(sources.map(source => [source.path, new Map<string, string>()]));
  for (let pass = 0; pass < 8; pass++) {
    let changed = false;
    for (const source of sources) {
      const imported = new Map<string, string>();
      for (const binding of bindings.get(source.path) ?? []) {
        const value = exports.get(binding.modulePath)?.get(binding.imported);
        if (value !== undefined) imported.set(binding.local, value);
      }
      const current = collectConstants(source.file, imported);
      const currentExports = exportedStringConstants(source, current);
      const nextConstants = constants.get(source.path)!;
      const nextExports = exports.get(source.path)!;
      const changedCurrent = [...current].some(([name, value]) => nextConstants.get(name) !== value) || nextConstants.size !== current.size;
      const changedExports = [...currentExports].some(([name, value]) => nextExports.get(name) !== value) || nextExports.size !== currentExports.size;
      if (changedCurrent || changedExports) changed = true;
      constants.set(source.path, current);
      exports.set(source.path, currentExports);
    }
    if (!changed) break;
  }
  return constants;
}

function bindingContains(name: ts.BindingName, target: string): boolean {
  if (ts.isIdentifier(name)) return name.text === target;
  return name.elements.some(element => ts.isBindingElement(element) && bindingContains(element.name, target));
}

function nearestScope(node: ts.Node, predicate: (candidate: ts.Node) => boolean): ts.Node | null {
  for (let current: ts.Node | undefined = node; current; current = current.parent) if (predicate(current)) return current;
  return null;
}

function runtimeBindingScope(node: ts.Node): ts.Node | null {
  if (ts.isParameter(node)) return nearestScope(node.parent, ts.isFunctionLike);
  if (ts.isVariableDeclaration(node)) {
    const declarationList = node.parent;
    const declarationContainer = declarationList.parent;
    if (ts.isVariableDeclarationList(declarationList) && (declarationList.flags & ts.NodeFlags.BlockScoped)) {
      if (ts.isForStatement(declarationContainer) || ts.isForInStatement(declarationContainer) || ts.isForOfStatement(declarationContainer)) return declarationContainer;
      return nearestScope(declarationContainer, candidate => ts.isBlock(candidate) || ts.isSourceFile(candidate));
    }
    return nearestScope(declarationContainer, candidate => ts.isFunctionLike(candidate) || ts.isSourceFile(candidate));
  }
  if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) {
    return nearestScope(node.parent, candidate => ts.isBlock(candidate) || ts.isSourceFile(candidate));
  }
  if (ts.isCatchClause(node) && node.variableDeclaration) return node;
  if ((ts.isFunctionExpression(node) || ts.isClassExpression(node)) && node.name) return node;
  return null;
}

function hasLocalBinding(source: Source, reference: ts.Node, name: string): boolean {
  const activeScopes = new Set<ts.Node>();
  for (let current: ts.Node | undefined = reference.parent; current; current = current.parent) {
    if (ts.isSourceFile(current) || ts.isBlock(current) || ts.isFunctionLike(current) || ts.isCatchClause(current) ||
        ts.isForStatement(current) || ts.isForInStatement(current) || ts.isForOfStatement(current)) activeScopes.add(current);
  }
  let shadowed = false;
  const visit = (node: ts.Node): void => {
    if (shadowed) return;
    const scope = runtimeBindingScope(node);
    if (scope && scope !== source.file && activeScopes.has(scope)) {
      if (ts.isVariableDeclaration(node) || ts.isParameter(node)) shadowed = bindingContains(node.name, name);
      else if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isFunctionExpression(node) || ts.isClassExpression(node)) && node.name) shadowed = node.name.text === name;
      else if (ts.isCatchClause(node) && node.variableDeclaration) shadowed = bindingContains(node.variableDeclaration.name, name);
    }
    ts.forEachChild(node, visit);
  };
  visit(source.file);
  return shadowed;
}

function pgImportEvidence(source: Source, localName: string, valueNames: readonly string[]): EvidenceSpan | null {
  for (const statement of source.file.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteralLike(statement.moduleSpecifier) ||
        !["pg", "pg-pool"].includes(statement.moduleSpecifier.text) || !statement.importClause?.namedBindings ||
        !ts.isNamedImports(statement.importClause.namedBindings)) continue;
    for (const element of statement.importClause.namedBindings.elements) {
      const imported = element.propertyName?.text ?? element.name.text;
      if (element.name.text === localName && valueNames.includes(imported)) {
        return evidenceSpan(source.path, source.bytes, element.getStart(source.file), element.end, "declaration");
      }
    }
  }
  return null;
}

function importedTypeEvidence(source: Source, localName: string): EvidenceSpan | null {
  return pgImportEvidence(source, localName, ["Pool", "PoolClient", "Client"]);
}

function localVariable(source: Source, name: string, offset: number): ts.VariableDeclaration | null {
  const candidates: Array<{ declaration: ts.VariableDeclaration; scopeWidth: number }> = [];
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name && node.initializer && node.end <= offset) {
      let scope: ts.Node = node.parent;
      while (scope.parent && !ts.isBlock(scope) && !ts.isSourceFile(scope)) scope = scope.parent;
      if (scope.getStart(source.file) <= offset && offset <= scope.end) candidates.push({ declaration: node, scopeWidth: scope.end - scope.getStart(source.file) });
    }
    ts.forEachChild(node, visit);
  };
  visit(source.file);
  candidates.sort((left, right) => left.scopeWidth - right.scopeWidth || right.declaration.getStart(source.file) - left.declaration.getStart(source.file));
  return candidates[0]?.declaration ?? null;
}

function localParameterTypeEvidence(source: Source, name: string, offset: number): EvidenceSpan | null {
  const containing: ts.FunctionLikeDeclaration[] = [];
  const findContaining = (node: ts.Node): void => {
    if (node.getStart(source.file) <= offset && offset < node.end) {
      if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node) ||
          ts.isConstructorDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) containing.push(node);
      ts.forEachChild(node, findContaining);
    }
  };
  findContaining(source.file);
  for (const fn of containing.sort((left, right) => left.end - left.getStart(source.file) - (right.end - right.getStart(source.file)))) {
    const parameter = fn.parameters.find(item => ts.isIdentifier(item.name) && item.name.text === name && item.type && ts.isTypeReferenceNode(item.type) && ts.isIdentifier(item.type.typeName));
    if (!parameter || !parameter.type || !ts.isTypeReferenceNode(parameter.type) || !ts.isIdentifier(parameter.type.typeName)) continue;
    const typeName = parameter.type.typeName.text;
    const imported = importedTypeEvidence(source, typeName);
    if (imported) return evidenceSpan(source.path, source.bytes, parameter.type.getStart(source.file), parameter.type.end, "declaration");
  }
  return null;
}

function exportedCallable(source: Source, name: string): ts.FunctionLikeDeclaration | null {
  for (const statement of source.file.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === name && (statement.modifiers ?? []).some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) return statement;
    if (!ts.isVariableStatement(statement) || !(statement.modifiers ?? []).some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== name || !declaration.initializer) continue;
      const initializer = unwrap(declaration.initializer);
      if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) return initializer;
    }
  }
  return null;
}

function importedFunction(source: Source, name: string, sourcesByPath: ReadonlyMap<string, Source>): { source: Source; callable: ts.FunctionLikeDeclaration; importEvidence: EvidenceSpan } | null {
  const knownPaths = new Set(sourcesByPath.keys());
  for (const binding of importBindings(source, knownPaths)) {
    if (binding.local !== name) continue;
    const target = sourcesByPath.get(binding.modulePath);
    const callable = target && exportedCallable(target, binding.imported);
    const statement = source.file.statements.find(item => ts.isImportDeclaration(item) && ts.isStringLiteralLike(item.moduleSpecifier) &&
      resolveImportedSource(source.path, item.moduleSpecifier.text, knownPaths) === binding.modulePath && item.importClause?.namedBindings && ts.isNamedImports(item.importClause.namedBindings) &&
      item.importClause.namedBindings.elements.some(specifier => specifier.name.text === name));
    if (!target || !callable || !statement || !ts.isImportDeclaration(statement)) continue;
    const specifier = statement.importClause?.namedBindings;
    if (!specifier || !ts.isNamedImports(specifier)) continue;
    const element = specifier.elements.find(item => item.name.text === name);
    if (element) return { source: target, callable, importEvidence: evidenceSpan(source.path, source.bytes, element.getStart(source.file), element.end, "reference") };
  }
  return null;
}

function returnsNullOrUndefinedOnly(callback: ts.Expression | undefined): boolean {
  if (!callback || !(ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) return false;
  if (!ts.isBlock(callback.body)) return callback.body.kind === ts.SyntaxKind.NullKeyword ||
    ts.isIdentifier(callback.body) && callback.body.text === "undefined";
  const returns: ts.Expression[] = [];
  let unsupported = false;
  const visit = (node: ts.Node): void => {
    if (node !== callback.body && ts.isFunctionLike(node)) return;
    if (ts.isReturnStatement(node)) {
      if (node.expression) returns.push(node.expression);
      else unsupported = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(callback.body);
  return !unsupported && returns.length > 0 && returns.every(value => value.kind === ts.SyntaxKind.NullKeyword || ts.isIdentifier(value) && value.text === "undefined");
}

function pgQueryBindingEvidence(source: Source, expression: ts.Expression, sourcesByPath: ReadonlyMap<string, Source>, visited = new Set<string>(), depth = 0): EvidenceSpan[] | null {
  if (depth > 10) return null;
  const value = unwrap(expression);
  if (ts.isNewExpression(value) && ts.isIdentifier(value.expression)) {
    const driver = pgImportEvidence(source, value.expression.text, ["Pool", "Client"]);
    return driver ? [driver, evidenceSpan(source.path, source.bytes, value.getStart(source.file), value.end, "reference")] : null;
  }
  if (ts.isIdentifier(value)) {
    const typeImport = importedTypeEvidence(source, value.text);
    const parameterType = typeImport && localParameterTypeEvidence(source, value.text, expression.getStart(source.file));
    if (typeImport && parameterType) return [typeImport, parameterType];
    const declaration = localVariable(source, value.text, expression.getStart(source.file));
    if (declaration?.initializer) return pgQueryBindingEvidence(source, declaration.initializer, sourcesByPath, visited, depth + 1);
    const localFunction = exportedCallable(source, value.text) ?? (() => {
      const candidate = source.file.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === value.text);
      return candidate && ts.isFunctionDeclaration(candidate) ? candidate : null;
    })();
    if (localFunction) return pgFunctionReturnEvidence(source, localFunction, sourcesByPath, visited, depth + 1);
    return null;
  }
  if (ts.isPropertyAccessExpression(value)) {
    const propertyName = value.getText(source.file);
    const writes: ts.Expression[] = [];
    const scan = (node: ts.Node): void => {
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && node.left.getText(source.file) === propertyName) writes.push(node.right);
      ts.forEachChild(node, scan);
    };
    scan(source.file);
    if (!writes.length) return null;
    const evidence = writes.map(write => pgQueryBindingEvidence(source, write, sourcesByPath, visited, depth + 1));
    if (evidence.some(item => item === null)) return null;
    return evidence.flatMap(item => item ?? []);
  }
  if (ts.isCallExpression(value)) {
    if (ts.isPropertyAccessExpression(value.expression) && value.expression.name.text === "catch" && returnsNullOrUndefinedOnly(value.arguments[0])) {
      const promise = pgQueryBindingEvidence(source, value.expression.expression, sourcesByPath, visited, depth + 1);
      return promise ? [...promise, evidenceSpan(source.path, source.bytes, value.getStart(source.file), value.end, "reference")] : null;
    }
    if (ts.isPropertyAccessExpression(value.expression) && value.expression.name.text === "connect") {
      const pool = pgQueryBindingEvidence(source, value.expression.expression, sourcesByPath, visited, depth + 1);
      return pool ? [...pool, evidenceSpan(source.path, source.bytes, value.getStart(source.file), value.end, "reference")] : null;
    }
    if (!ts.isIdentifier(value.expression)) return null;
    const calleeName = value.expression.text;
    const localFunction = exportedCallable(source, calleeName) ?? (() => {
      const candidate = source.file.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === calleeName);
      return candidate && ts.isFunctionDeclaration(candidate) ? candidate : null;
    })();
    if (localFunction) return pgFunctionReturnEvidence(source, localFunction, sourcesByPath, visited, depth + 1);
    const imported = importedFunction(source, calleeName, sourcesByPath);
    if (!imported) return null;
    return pgFunctionReturnEvidence(imported.source, imported.callable, sourcesByPath, visited, depth + 1,
      [imported.importEvidence]);
  }
  if (ts.isBinaryExpression(value) && [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(value.operatorToken.kind)) {
    const left = pgQueryBindingEvidence(source, value.left, sourcesByPath, visited, depth + 1);
    const right = pgQueryBindingEvidence(source, value.right, sourcesByPath, visited, depth + 1);
    return left && right ? [...left, ...right] : null;
  }
  if (ts.isConditionalExpression(value)) {
    const left = pgQueryBindingEvidence(source, value.whenTrue, sourcesByPath, visited, depth + 1);
    const right = pgQueryBindingEvidence(source, value.whenFalse, sourcesByPath, visited, depth + 1);
    return left && right ? [...left, ...right] : null;
  }
  return null;
}

function pgFunctionReturnEvidence(source: Source, callable: ts.FunctionLikeDeclaration, sourcesByPath: ReadonlyMap<string, Source>, visited: Set<string>, depth: number, prefix: EvidenceSpan[] = []): EvidenceSpan[] | null {
  const key = `${source.path}:${callable.getStart(source.file)}`;
  if (visited.has(key) || !callable.body || !ts.isBlock(callable.body)) return null;
  const nextVisited = new Set(visited); nextVisited.add(key);
  const returns: ts.ReturnStatement[] = [];
  const findReturns = (node: ts.Node): void => {
    if (ts.isReturnStatement(node)) returns.push(node);
    else if (node !== callable.body && ts.isFunctionLike(node)) return;
    ts.forEachChild(node, findReturns);
  };
  findReturns(callable.body);
  if (!returns.length) return null;
  const evidences: EvidenceSpan[] = [...prefix];
  for (const statement of returns) {
    if (!statement.expression) return null;
    const resolved = pgQueryBindingEvidence(source, statement.expression, sourcesByPath, nextVisited, depth + 1);
    if (resolved) { evidences.push(...resolved); continue; }
    const property = unwrap(statement.expression);
    if (!ts.isPropertyAccessExpression(property)) return null;
    const assignment = pgQueryBindingEvidence(source, property, sourcesByPath, nextVisited, depth + 1);
    if (!assignment) return null;
    evidences.push(...assignment);
  }
  evidences.push(evidenceSpan(source.path, source.bytes, callable.getStart(source.file), callable.end, "declaration"));
  return [...new Map(evidences.map(item => [`${item.filePath}:${item.startByte}:${item.endByte}`, item])).values()];
}

function maskSqlValues(sql: string): string {
  const output = [...sql];
  const blank = (start: number, end: number) => { for (let index = start; index < end; index++) if (output[index] !== "\n" && output[index] !== "\r") output[index] = " "; };
  for (let index = 0; index < sql.length;) {
    if (sql.startsWith("--", index)) {
      const end = sql.indexOf("\n", index + 2);
      const stop = end < 0 ? sql.length : end;
      blank(index, stop); index = stop; continue;
    }
    if (sql.startsWith("/*", index)) {
      let depth = 1; let end = index + 2;
      while (end < sql.length && depth > 0) {
        if (sql.startsWith("/*", end)) { depth++; end += 2; }
        else if (sql.startsWith("*/", end)) { depth--; end += 2; }
        else end++;
      }
      blank(index, end); index = end; continue;
    }
    if (sql[index] === "'") {
      let end = index + 1;
      while (end < sql.length) {
        if (sql.startsWith("''", end)) { end += 2; continue; }
        if (sql[end] === "\\" && end + 1 < sql.length) { end += 2; continue; }
        if (sql[end] === "'") { end++; break; }
        end++;
      }
      blank(index, end); index = end; continue;
    }
    index++;
  }
  return output.join("");
}

function tableNameMatches(source: string, cursor: number): { table: string; end: number } | null {
  const pattern = /^\s*(?:(?:"([^"]+)"|([A-Za-z_][\w$]*))\s*\.\s*)?(?:"([^"]+)"|([A-Za-z_][\w$]*))/u;
  const match = source.slice(cursor).match(pattern);
  if (!match) return null;
  return { table: match[3] ?? match[4] ?? "", end: cursor + match[0].length };
}

function sqlDepthAt(source: string, end: number): number {
  let depth = 0;
  for (let index = 0; index < end; index++) {
    if (source[index] === "(") depth++;
    else if (source[index] === ")") depth = Math.max(0, depth - 1);
  }
  return depth;
}

function hasSelectInCurrentScope(source: string, cursor: number): boolean {
  const targetDepth = sqlDepthAt(source, cursor);
  let depth = 0;
  let start = 0;
  for (let index = 0; index < cursor; index++) {
    if (source[index] === "(") {
      depth++;
      if (depth === targetDepth) start = index + 1;
    } else if (source[index] === ")") depth = Math.max(0, depth - 1);
    else if (source[index] === ";" && depth === targetDepth) start = index + 1;
  }
  const scope = source.slice(start, cursor);
  const selectMatches = scope.matchAll(/\bSELECT\b/giu);
  for (const match of selectMatches) if (sqlDepthAt(scope, match.index!) === 0) return true;
  return false;
}

function cteNames(sql: string): Set<string> {
  const names = new Set<string>();
  const masked = maskSqlValues(sql);
  const withClauses = masked.matchAll(/\bWITH(?:\s+RECURSIVE)?\s+([A-Za-z_][\w$]*)\s+AS\s*\(/giu);
  for (const match of withClauses) {
    names.add(match[1]!.toLowerCase());
    const afterFirst = masked.slice(match.index! + match[0].length);
    // Subsequent CTEs are comma-separated at the WITH clause's nesting level.
    for (const later of afterFirst.matchAll(/,\s*([A-Za-z_][\w$]*)\s+AS\s*\(/giu)) names.add(later[1]!.toLowerCase());
  }
  return names;
}

function sqlTableOperations(sql: string, knownTables: ReadonlySet<string>): TableOperation[] {
  const masked = maskSqlValues(sql);
  const operations: TableOperation[] = [];
  const add = (operation: SqlOperation, cursor: number) => {
    const table = tableNameMatches(masked, cursor);
    if (!table?.table || /^(?:set|of|nowait|skip|share|key)$/iu.test(table.table)) return;
    operations.push({ table: table.table, operation });
  };
  for (const match of masked.matchAll(/\bINSERT\s+INTO\s+/giu)) add("creates", match.index! + match[0].length);
  for (const match of masked.matchAll(/\bUPDATE\s+/giu)) {
    const before = masked.slice(0, match.index!).match(/([A-Za-z_][\w$]*)\s*$/u)?.[1]?.toUpperCase();
    if (before === "FOR" || before === "DO") continue;
    add("updates", match.index! + match[0].length);
  }
  for (const match of masked.matchAll(/\bDELETE\s+FROM\s+/giu)) add("deletes", match.index! + match[0].length);
  const ctes = cteNames(masked);
  for (const match of masked.matchAll(/\b(?:FROM|JOIN)\s+/giu)) {
    const keywordStart = match.index!;
    if (!hasSelectInCurrentScope(masked, keywordStart)) continue;
    const table = tableNameMatches(masked, keywordStart + match[0].length);
    if (!table?.table) continue;
    const normalized = normalizedName(table.table);
    if (knownTables.has(normalized)) operations.push({ table: table.table, operation: "reads" });
    else if (!ctes.has(table.table.toLowerCase())) operations.push({ table: table.table, operation: "reads" });
  }
  if (/\bON\s+CONFLICT\b[\s\S]*?\bDO\s+UPDATE\b/iu.test(masked)) {
    for (const item of operations.filter(item => item.operation === "creates")) operations.push({ table: item.table, operation: "updates" });
  }
  return [...new Map(operations.map(item => [`${item.operation}\0${item.table.toLowerCase()}`, item])).values()];
}

function normalizedName(value: string): string {
  return value.toLocaleLowerCase("en-US").replace(/[^\p{L}\p{N}]/gu, "");
}

function queryArgument(source: Source, node: ts.CallExpression, constants: ReadonlyMap<string, string>): string | null {
  const argument = node.arguments[0];
  if (!argument) return null;
  let shadowed = false;
  const visit = (candidate: ts.Node): void => {
    if (shadowed) return;
    if (ts.isIdentifier(candidate) && hasLocalBinding(source, candidate, candidate.text)) shadowed = true;
    else ts.forEachChild(candidate, visit);
  };
  visit(argument);
  return shadowed ? null : staticString(argument, constants);
}

function nearestFunction(components: SemanticNode[], filePath: string, offset: number): SemanticNode | null {
  const candidates = components.flatMap(node => node.evidence
    .filter(span => span.filePath === filePath && span.startByte <= offset && offset < span.endByte)
    .map(span => ({ node, width: span.endByte - span.startByte })));
  candidates.sort((left, right) => left.width - right.width || left.node.id.localeCompare(right.node.id));
  return candidates[0]?.node ?? null;
}

function functionName(declaration: ts.FunctionLikeDeclaration, file: ts.SourceFile): string {
  const named = (declaration as ts.FunctionLikeDeclaration & { name?: ts.PropertyName }).name;
  if (named && ts.isIdentifier(named)) return named.text;
  const parent = declaration.parent;
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
  if (ts.isPropertyAssignment(parent) && (ts.isIdentifier(parent.name) || ts.isStringLiteral(parent.name))) return parent.name.text;
  if (ts.isPropertyDeclaration(parent) && (ts.isIdentifier(parent.name) || ts.isStringLiteral(parent.name))) return parent.name.text;
  return `Backend SQL operation at line ${file.getLineAndCharacterOfPosition(declaration.getStart(file)).line + 1}`;
}

function syntheticBackendFunction(source: Source, call: ts.CallExpression): SemanticNode | null {
  let current: ts.Node | undefined = call.parent;
  while (current && !ts.isFunctionLike(current)) current = current.parent;
  if (!current || !("body" in current) || !current.body) return null;
  const start = current.getStart(source.file);
  const end = current.end;
  const evidence = evidenceSpan(source.path, source.bytes, start, end, "declaration");
  return semanticNode({ kind: "component", filePath: source.path, startByte: evidence.startByte,
    key: `static-sql-function:${functionName(current, source.file)}`, label: functionName(current, source.file), featureId: null,
    confidence: "proven", reason: "Backend function containing a statically resolved SQL query.", evidence: [evidence] });
}

function gatherSources(input: SemanticInput): Source[] {
  return Object.entries(input.sources)
    .filter(([path, bytes]) => SOURCE_PATH.test(path) && !excludeFromMainFlow(path) && bytes.byteLength <= MAX_SOURCE_BYTES)
    .map(([path, bytes]) => {
      const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
      return { path, bytes, text, file: ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, scriptKind(path)) };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
}

function isBackendSource(source: Source): boolean {
  if (/^\s*["']use client["']/mu.test(source.text)) return false;
  const path = source.path.replaceAll("\\", "/");
  return /(^|\/)(?:api|backend|server|controllers?|services?|routes?|routers?|handlers?)(\/|$)/iu.test(path) ||
    /\.(?:server)\.[cm]?[jt]sx?$/iu.test(path) ||
    /^\s*["']use server["']/mu.test(source.text) ||
    /\bfrom\s*["']server-only["']/u.test(source.text);
}

/** Link static backend SQL calls to schema-backed data objects without using UI labels as CRUD evidence. */
export function extractSqlAccess(input: SemanticInput, schemaStores: SemanticNode[], sourceComponents: SemanticNode[]): SemanticFragment {
  const fragment = emptyFragment();
  const sources = gatherSources(input);
  const sourcesByPath = new Map(sources.map(source => [source.path, source]));
  const constantsByPath = collectWorkspaceConstants(sources);
  const storesByName = new Map<string, SemanticNode[]>();
  for (const store of schemaStores.filter(node => node.kind === "store" && node.reason.includes("Relational table declared by CREATE TABLE DDL."))) {
    const key = normalizedName(store.label);
    storesByName.set(key, [...(storesByName.get(key) ?? []), store]);
  }
  const components = sourceComponents.filter(node => node.kind === "component");
  for (const source of sources) {
    if (!isBackendSource(source)) continue;
    // Migration and seed scripts describe schema setup, not application CRUD behavior.
    if (/(^|\/)(?:migrations?|seeds?)(\/|$)/iu.test(source.path) || /(^|\/)(?:migrate|seed)(?:\.[cm]?[jt]sx?)?$/iu.test(source.path)) continue;
    const constants = constantsByPath.get(source.path) ?? new Map<string, string>();
    const visits = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "query") {
        const sql = queryArgument(source, node, constants);
        if (sql === null) {
          fragment.limitations.push({ filePath: source.path, reason: "A backend .query() call does not resolve to a literal or unshadowed immutable SQL constant; CRUD was not inferred from its query shape." });
        } else {
          const databaseEvidence = pgQueryBindingEvidence(source, node.expression.expression, sourcesByPath);
          if (!databaseEvidence) {
            fragment.limitations.push({ filePath: source.path, reason: "A static backend .query() call could not be tied to a locally verified node-postgres Pool, Client, or PoolClient; no CRUD fact was inferred." });
            ts.forEachChild(node, visits);
            return;
          }
          const tables = sqlTableOperations(sql, new Set(storesByName.keys()));
          if (tables.length) {
            const start = node.expression.getStart(source.file);
            const end = Math.max(node.arguments[0]?.end ?? node.end, node.expression.end);
            const queryEvidence = evidenceSpan(source.path, source.bytes, start, end, "reference");
            const behavior = nearestFunction(components, source.path, queryEvidence.startByte) ?? syntheticBackendFunction(source, node);
            if (!behavior) {
              fragment.limitations.push({ filePath: source.path, reason: "Static SQL was found, but no enclosing backend function could be mapped to it; no application-data matrix relation was asserted." });
            } else {
              if (!sourceComponents.some(candidate => candidate.id === behavior.id) && !fragment.nodes.some(candidate => candidate.id === behavior.id)) fragment.nodes.push(behavior);
              for (const item of tables) {
                const candidates = storesByName.get(normalizedName(item.table)) ?? [];
                if (candidates.length !== 1) {
                  if (item.operation === "reads") continue;
                  fragment.limitations.push({ filePath: source.path, reason: `Static SQL ${item.operation} references ${item.table}, but the snapshot has no unique matching schema-backed data object; no CRUD fact was asserted.` });
                  continue;
                }
                const store = candidates[0]!;
                const evidence = [...behavior.evidence.filter(span => span.filePath === source.path && span.startByte <= queryEvidence.startByte && span.endByte >= queryEvidence.endByte).slice(0, 1), queryEvidence, ...databaseEvidence, ...store.evidence];
                const edge: SemanticEdge = {
                  id: semanticEdgeId(source.path, queryEvidence.startByte, `sql-access:${behavior.id}:${item.operation}:${store.id}`),
                  source: behavior.id, target: store.id, label: `${item.operation} ${store.label}`, confidence: "proven",
                  dataOperation: ({ reads: "read", creates: "create", updates: "update", deletes: "delete" } as const satisfies Record<SqlOperation, OperationMetadata>)[item.operation],
                  reason: `A statically resolved backend .query() call is tied to a node-postgres client imported from pg and contains a ${item.operation} statement naming ${item.table}; the matching data object is declared in the analyzed schema snapshot. This is source-level access evidence, not proof of successful runtime execution.`,
                  evidence: [...new Map(evidence.map(span => [`${span.filePath}:${span.startByte}:${span.endByte}`, span])).values()],
                };
                fragment.edges.push(edge);
              }
            }
          }
        }
      }
      ts.forEachChild(node, visits);
    };
    visits(source.file);
  }
  if (fragment.edges.length) fragment.frameworks.push("Static backend SQL access");
  return fragment;
}
