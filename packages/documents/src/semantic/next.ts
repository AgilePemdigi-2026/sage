import ts from "typescript";
import type { CcmNode, EvidenceSpan } from "@sage/contracts";
import type { SemanticEdge, SemanticFeature, SemanticFragment, SemanticInput, SemanticNode } from "./model.ts";
import { compactEvidence, emptyFragment, ensureFeatureNode, evidenceSpan, excludeFromMainFlow, humanLabel, semanticEdgeId, semanticId, semanticNode, technicalNodesForSpan } from "./builder.ts";

type SourceEntry = { path: string; bytes: Uint8Array; text: string; file: ts.SourceFile };
type ApiRoute = { path: string; method: string; entry: SourceEntry; declaration: ts.Node; handlerEntry: SourceEntry; handler: ts.FunctionLikeDeclaration | null; handlerConfidence: "proven" | "indicated"; featureId: string; featureLabel: string; stepId: string; componentId: string };
type StaticRequest = { method: string; path: string; node: ts.Node; confidence: "proven" | "indicated" };
type PageLoadRequest = { request: StaticRequest; reason: string; evidenceNodes: ts.Node[] };
type TransactionCallback = { handler: ts.FunctionLikeDeclaration; parameter: ts.ParameterDeclaration; call: ts.CallExpression };
type StaticNavigation = { path: string; node: ts.Node; confidence: "proven" | "indicated"; reason: string };
type EndpointExport = { method: string; handler: ts.FunctionLikeDeclaration | null; declaration: ts.Node; confidence: "proven" | "indicated"; handlerLabel: string };
type SemanticFlowScope = { entry: SourceEntry; handler: ts.FunctionLikeDeclaration; featureId: string; confidence: "proven" | "indicated" };
type DelegateResolution = { entry: SourceEntry; handler: ts.FunctionLikeDeclaration } | { unresolved: true };
const semanticApiPrefix = /^\/(?:api\/)?/u;

function scriptKind(path: string): ts.ScriptKind | null {
  if (/\.tsx$/u.test(path)) return ts.ScriptKind.TSX;
  if (/\.[cm]?jsx?$/u.test(path)) return ts.ScriptKind.JSX;
  if (/\.[cm]?tsx?$/u.test(path)) return ts.ScriptKind.TS;
  return null;
}

function appRoot(path: string): { route: string; fileKind: "page" | "route" } | null {
  const normalized = path.replaceAll("\\", "/");
  const marker = normalized.match(/(?:^|\/)(?:src\/)?app\//u);
  if (!marker || !/(?:^|\/)(page|route)\.[cm]?[jt]sx?$/u.test(normalized)) return null;
  const start = marker.index! + marker[0].length;
  const relative = normalized.slice(start);
  const file = relative.match(/(?:^|\/)(page|route)\.[cm]?[jt]sx?$/u);
  if (!file) return null;
  let route = relative.slice(0, file.index ?? relative.length).replace(/\(([^/]+)\)\/?/gu, "").replace(/\[\.\.\.([^/]+)\]/gu, ":$1").replace(/\[\[?([^\]]+)\]?\]/gu, ":$1").replace(/\/$/u, "");
  route = `/${route}`.replace(/\/{2,}/gu, "/");
  return { route, fileKind: file[1] as "page" | "route" };
}

function literalText(node: ts.Expression | undefined): string | null {
  if (!node) return null;
  if (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return null;
}

function routePattern(path: string | null): string | null {
  if (path === null || !path.startsWith("/") || path.startsWith("//") || path.includes("\\")) return null;
  const clean = path.split(/[?#]/u, 1)[0]!;
  return clean || "/";
}

function routeFromExpression(expression: ts.Expression | undefined): { path: string | null; confidence: "proven" | "indicated" } {
  const literal = routePattern(literalText(expression));
  if (literal !== null) return { path: literal, confidence: "proven" };
  if (expression && ts.isTemplateExpression(expression)) {
    let route = expression.head.text;
    let confidence: "proven" | "indicated" = "proven";
    for (const span of expression.templateSpans) {
      if (/[?#]/u.test(route)) return { path: routePattern(route), confidence };
      if (!route.endsWith("/")) return { path: null, confidence: "indicated" };
      route += ":dynamic";
      confidence = "indicated";
      route += span.literal.text;
    }
    return { path: routePattern(route), confidence };
  }
  if (expression && ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const prefix = literalText(expression.left);
    if (prefix && prefix.startsWith("/") && /[?#]/u.test(prefix)) return { path: routePattern(prefix), confidence: "proven" };
    if (prefix && prefix.startsWith("/") && prefix.endsWith("/")) return { path: routePattern(`${prefix}:dynamic`), confidence: "indicated" };
  }
  return { path: null, confidence: "indicated" };
}

function routeMatches(declared: string, requested: string): boolean {
  const pattern = normalizeRoute(declared).split("/").map(part => part.startsWith(":") ? "[^/]+" : part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join("/");
  return new RegExp(`^${pattern}/?$`, "u").test(normalizeRoute(requested));
}

function normalizeRoute(path: string): string {
  return path.replace(/\[\.\.\.([^/]+)\]/gu, ":$1").replace(/\[\[?([^\]]+)\]?\]/gu, ":$1").replace(/\/$/u, "") || "/";
}

function methodForFetchFromOptions(options: ts.Expression | undefined): string | null {
  if (!options) return "GET";
  if (!ts.isObjectLiteralExpression(options)) return null;
  const method = options.properties.find((property): property is ts.PropertyAssignment => ts.isPropertyAssignment(property) && propertyName(property.name) === "method");
  if (!method) return options.properties.some(ts.isSpreadAssignment) ? null : "GET";
  const value = literalText(method.initializer);
  return value && /^[A-Za-z]+$/u.test(value) ? value.toUpperCase() : null;
}

function propertyName(name: ts.PropertyName | undefined): string | null {
  if (!name) return null;
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) return name.text;
  return null;
}

function routeFamily(route: string): { key: string; label: string } {
  const routeParts = route.replace(semanticApiPrefix, "").split("/").filter(Boolean);
  const parts = routeParts.filter(part => !part.startsWith(":"));
  const meaningful = parts.filter(part => !/^v\d+$/iu.test(part));
  const dynamicIndex = routeParts.findIndex(part => part.startsWith(":"));
  const nestedResource = dynamicIndex >= 0 ? routeParts.slice(dynamicIndex + 1).find(part => !part.startsWith(":")) : undefined;
  const first = nestedResource ?? meaningful[0] ?? "application";
  const keyParts = /^(auth|authentication|login|logout|signup|register|session)$/iu.test(first) ? ["auth"] : [first];
  const key = keyParts.join("/");
  const label = humanLabel(keyParts.join(" "));
  return { key, label };
}

function nodeRange(entry: SourceEntry, node: ts.Node, role: "declaration" | "reference" | "context" = "context"): EvidenceSpan {
  return evidenceSpan(entry.path, entry.bytes, node.getStart(entry.file), node.end, role);
}

function nameOfHandler(handler: ts.FunctionLikeDeclaration, route: string): string {
  const name = "name" in handler && handler.name && ts.isIdentifier(handler.name) ? handler.name.text : null;
  return humanLabel(name ?? route.split("/").filter(Boolean).at(-1) ?? "Endpoint");
}

function makeEdge(kindPath: string, source: string, target: string, label: string, confidence: "proven" | "indicated", reason: string, evidence: EvidenceSpan): SemanticEdge {
  return { id: semanticEdgeId(evidence.filePath, evidence.startByte, `${source}\0${target}\0${label}\0${kindPath}`), source, target, label, confidence, reason, evidence: [evidence] };
}

function methodExport(statement: ts.Statement, source: ts.SourceFile): EndpointExport | null {
  if (ts.isFunctionDeclaration(statement) && statement.name && hasModifier(statement, ts.SyntaxKind.ExportKeyword)) {
    const method = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].find(item => item === statement.name!.text.toUpperCase());
    if (method) return { method, handler: statement, declaration: statement, confidence: "proven", handlerLabel: nameOfHandler(statement, method) };
  }
  if (ts.isVariableStatement(statement) && hasModifier(statement, ts.SyntaxKind.ExportKeyword)) {
    for (const declaration of statement.declarationList.declarations) {
      if (!declaration.initializer || !ts.isIdentifier(declaration.name)) continue;
      const exportedName = declaration.name.text.toUpperCase();
      const method = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].find(item => item === exportedName);
      const init = unwrap(declaration.initializer);
      if (!method) continue;
      if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) return { method, handler: init, declaration: init, confidence: "proven", handlerLabel: nameOfHandler(init, method) };
      if (ts.isCallExpression(init)) {
        const callbacks: ts.FunctionLikeDeclaration[] = [];
        for (const argument of init.arguments) {
          const callback = unwrap(argument);
          if (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) callbacks.push(callback);
        }
        const handler = callbacks.length === 1 ? callbacks[0]! : null;
        const wrapperName = init.expression.getText(source);
        return { method, handler, declaration: init, confidence: "indicated", handlerLabel: wrapperName };
      }
      if (ts.isIdentifier(init) || ts.isPropertyAccessExpression(init)) return { method, handler: null, declaration: init, confidence: "indicated", handlerLabel: init.getText(source) };
    }
  }
  return null;
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node)?.some(modifier => modifier.kind === kind) ?? false);
}

function unwrap(node: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node)) node = node.expression;
  return node;
}

function responseConstructorName(statement: ts.ReturnStatement): string | null {
  const response = statement.expression && unwrap(statement.expression);
  if (!response) return null;
  if (ts.isNewExpression(response) && ts.isIdentifier(unwrap(response.expression))) return (unwrap(response.expression) as ts.Identifier).text;
  if (!ts.isCallExpression(response) || !ts.isPropertyAccessExpression(unwrap(response.expression))) return null;
  const receiver = (unwrap(response.expression) as ts.PropertyAccessExpression).expression;
  return ts.isIdentifier(receiver) ? receiver.text : null;
}

function isHttpResponseConstructor(entry: SourceEntry, statement: ts.ReturnStatement, name: string): boolean {
  if (name === "Response") return !visibleBindingNames(entry, statement).has(name);
  if (name !== "NextResponse") return false;
  const scopes = lexicalScopes(entry, statement);
  if (scopes.slice(1).some(scope => directlyDeclaredBindings(scope).has(name))) return false;
  const topLevelNames = directlyDeclaredBindings(entry.file);
  const imports = importedNames(entry.file);
  if (topLevelNames.has(name) && !imports.has(name)) return false;
  return importedFrom(entry, name, "NextResponse", ["next/server"]);
}

function responseStatus(entry: SourceEntry, node: ts.Node): number | null {
  const inspect = (statement: ts.ReturnStatement): number | null => {
    const response = statement.expression;
    const responseName = responseConstructorName(statement);
    if (!response || !responseName || !isHttpResponseReturn(entry, statement)) return null;
    let options: ts.Expression | undefined;
    if (ts.isCallExpression(response)) {
      const callee = unwrap(response.expression);
      const method = ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === responseName ? callee.name.text : null;
      if (method === "redirect" && response.arguments[1] && ts.isNumericLiteral(response.arguments[1])) {
        const status = Number(response.arguments[1].text);
        return status >= 100 && status <= 599 ? status : null;
      }
      if (method === "json" || method === "redirect") options = response.arguments[1];
    } else if (ts.isNewExpression(response) && ts.isIdentifier(response.expression) && response.expression.text === responseName) options = response.arguments?.[1];
    if (!options || !ts.isObjectLiteralExpression(options)) return null;
    const property = options.properties.find((item): item is ts.PropertyAssignment => ts.isPropertyAssignment(item) && propertyName(item.name) === "status");
    if (!property || !ts.isNumericLiteral(property.initializer)) return null;
    const status = Number(property.initializer.text);
    return status >= 100 && status <= 599 ? status : null;
  };
  if (ts.isReturnStatement(node)) return inspect(node);
  let status: number | null = null;
  visitExecutable(node, current => {
    if (status === null && ts.isReturnStatement(current)) status = inspect(current);
  });
  return status;
}

function directReturnStatements(node: ts.Statement | undefined): ts.ReturnStatement[] {
  if (!node) return [];
  if (ts.isReturnStatement(node)) return [node];
  if (ts.isBlock(node)) return node.statements.flatMap(statement => directReturnStatements(statement));
  return [];
}

function isCallableBoundary(node: ts.Node): boolean {
  return ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node) || ts.isConstructorDeclaration(node);
}

function visitExecutable(root: ts.Node, visit: (node: ts.Node) => void): void {
  const walk = (node: ts.Node) => {
    if (node !== root && isCallableBoundary(node)) return;
    visit(node);
    ts.forEachChild(node, walk);
  };
  walk(root);
}

function visitHandlerFlow(root: ts.Node, confidence: "proven" | "indicated", visit: (node: ts.Node, confidence: "proven" | "indicated") => void): void {
  const walk = (node: ts.Node, currentConfidence: "proven" | "indicated") => {
    visit(node, currentConfidence);
    ts.forEachChild(node, child => {
      if (isCallableBoundary(child)) {
        const passedToCall = (ts.isArrowFunction(child) || ts.isFunctionExpression(child)) && ts.isCallExpression(node) && node.arguments.some(argument => unwrap(argument) === child);
        if (passedToCall && (ts.isArrowFunction(child) || ts.isFunctionExpression(child)) && child.body) walk(child.body, "indicated");
        return;
      }
      walk(child, currentConfidence);
    });
  };
  walk(root, confidence);
}

function isHttpResponseReturn(entry: SourceEntry, statement: ts.ReturnStatement): boolean {
  const expression = statement.expression && unwrap(statement.expression);
  if (!expression) return false;
  const responseName = responseConstructorName(statement);
  if (!responseName || !isHttpResponseConstructor(entry, statement, responseName)) return false;
  if (ts.isNewExpression(expression)) return ts.isIdentifier(expression.expression) && expression.expression.text === responseName;
  if (!ts.isCallExpression(expression) || !ts.isPropertyAccessExpression(unwrap(expression.expression))) return false;
  const callee = unwrap(expression.expression) as ts.PropertyAccessExpression;
  return ts.isIdentifier(callee.expression) && callee.expression.text === responseName && ["json", "redirect"].includes(callee.name.text);
}

function guardCategory(expression: string): { label: string; reason: string } | null {
  const value = expression.toLowerCase();
  if (/session|auth|cookie|token|bearer|signedin|authenticated/u.test(value)) return { label: "Pemeriksaan sesi atau autentikasi", reason: "Kondisi akses ditemukan pada cabang kode yang mengembalikan respons." };
  if (/role|admin|permission|owner|installation|scope|authoriz/u.test(value)) return { label: "Pemeriksaan peran atau cakupan akses", reason: "Kondisi peran/cakupan ditemukan pada cabang kode yang mengembalikan respons." };
  if (/valid|schema|parse|required|empty|format|zod|issues|errors|\bbody\b|payload|\binput\b/u.test(value)) return { label: "Validasi input", reason: "Kondisi validasi ditemukan pada cabang kode yang mengembalikan respons." };
  if (/active|status|quota|stock|limit|duplicate|already|exists|expired|available|capacity|count/u.test(value)) return { label: "Pemeriksaan aturan fitur", reason: "Kondisi aturan fitur ditemukan pada cabang kode yang mengembalikan respons." };
  return null;
}

function jsxAttributeName(name: ts.JsxAttributeName): string {
  if (ts.isIdentifier(name)) return name.text;
  return name.getText();
}

function jsxLabel(node: ts.JsxElement | ts.JsxSelfClosingElement): string {
  const attributes = ts.isJsxElement(node) ? node.openingElement.attributes : node.attributes;
  const explicitLabels: string[] = [];
  for (const attribute of attributes.properties) {
    if (ts.isJsxAttribute(attribute) && ["aria-label", "title"].includes(jsxAttributeName(attribute.name))) {
      if (attribute.initializer && ts.isStringLiteralLike(attribute.initializer)) explicitLabels.push(attribute.initializer.text);
    }
  }
  if (explicitLabels.length) return explicitLabels.join(" ").replace(/\s+/gu, " ").trim().slice(0, 120);
  const tag = jsxTag(node);
  if (tag === "form" && ts.isJsxElement(node)) {
    const submitLabels: string[] = [];
    const findSubmit = (child: ts.JsxChild) => {
      if (!ts.isJsxElement(child) && !ts.isJsxSelfClosingElement(child)) return;
      const childTag = jsxTag(child), childAttributes = jsxAttributes(child);
      if (childTag === "form") return;
      const getStringAttribute = (name: string) => {
        const attribute = childAttributes.properties.find((property): property is ts.JsxAttribute => ts.isJsxAttribute(property) && jsxAttributeName(property.name) === name);
        return attribute?.initializer && ts.isStringLiteralLike(attribute.initializer) ? attribute.initializer.text : null;
      };
      const type = getStringAttribute("type");
      if (childTag === "button" && (!type || type.toLowerCase() === "submit")) {
        const label = jsxLabel(child);
        if (label) submitLabels.push(label);
        return;
      }
      if (childTag === "input" && ["submit", "button"].includes(type?.toLowerCase() ?? "")) {
        const value = getStringAttribute("value");
        if (value) submitLabels.push(value);
        return;
      }
      if (ts.isJsxElement(child)) for (const nested of child.children) findSubmit(nested);
    };
    for (const child of node.children) findSubmit(child);
    return submitLabels.join(" ").replace(/\s+/gu, " ").trim().slice(0, 120);
  }
  let text = "";
  const collect = (child: ts.JsxChild) => {
    if (ts.isJsxText(child)) text += ` ${child.text}`;
    else if (ts.isJsxExpression(child) && child.expression && ts.isStringLiteralLike(child.expression)) text += ` ${child.expression.text}`;
    else if (ts.isJsxElement(child)) for (const nested of child.children) collect(nested);
  };
  if (ts.isJsxElement(node)) for (const child of node.children) collect(child);
  for (const attribute of attributes.properties) {
    if (ts.isJsxAttribute(attribute) && jsxAttributeName(attribute.name) === "value" && attribute.initializer && ts.isStringLiteralLike(attribute.initializer)) text += ` ${attribute.initializer.text}`;
  }
  return text.replace(/\s+/gu, " ").trim().slice(0, 120);
}

function jsxTag(node: ts.JsxElement | ts.JsxSelfClosingElement): string {
  const tag = ts.isJsxElement(node) ? node.openingElement.tagName : node.tagName;
  return ts.isIdentifier(tag) ? tag.text : "";
}

function jsxAttributes(node: ts.JsxElement | ts.JsxSelfClosingElement): ts.JsxAttributes {
  return ts.isJsxElement(node) ? node.openingElement.attributes : node.attributes;
}

function functionNamesInEntry(entry: SourceEntry): Set<string> {
  const names = new Set<string>();
  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name) names.add(node.name.text);
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const value = unwrap(node.initializer);
      if (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) names.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(entry.file);
  return names;
}

type FunctionScope = ts.SourceFile | ts.FunctionLikeDeclaration | ts.Block | ts.CaseBlock | ts.CatchClause | ts.ForStatement | ts.ForInStatement | ts.ForOfStatement;

function scopeRoot(scope: FunctionScope): ts.Node | undefined {
  if (ts.isSourceFile(scope) || ts.isBlock(scope) || ts.isCaseBlock(scope) || ts.isCatchClause(scope) || ts.isForStatement(scope) || ts.isForInStatement(scope) || ts.isForOfStatement(scope)) return scope;
  return scope.body;
}

function directlyDeclaredFunctions(scope: FunctionScope): Map<string, ts.FunctionLikeDeclaration[]> {
  const root = scopeRoot(scope);
  const result = new Map<string, ts.FunctionLikeDeclaration[]>();
  if (!root) return result;
  const add = (name: string, fn: ts.FunctionLikeDeclaration) => {
    const candidates = result.get(name) ?? [];
    candidates.push(fn);
    result.set(name, candidates);
  };
  const visit = (node: ts.Node) => {
    if (node !== root && (ts.isBlock(node) || ts.isCaseBlock(node) || ts.isCatchClause(node) || ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node))) return;
    if (node !== root && isCallableBoundary(node)) {
      if (ts.isFunctionDeclaration(node) && node.name) add(node.name.text, node);
      return;
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const value = unwrap(node.initializer);
      if (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) {
        add(node.name.text, value);
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return result;
}

function bindingIdentifiers(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap(element => ts.isOmittedExpression(element) ? [] : bindingIdentifiers(element.name));
}

function directlyDeclaredBindings(scope: FunctionScope): Set<string> {
  const names = new Set<string>();
  const root = scopeRoot(scope);
  if (!root) return names;
  const addImport = (statement: ts.ImportDeclaration) => {
    const clause = statement.importClause;
    if (!clause) return;
    if (clause.name) names.add(clause.name.text);
    if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) names.add(clause.namedBindings.name.text);
    if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) for (const item of clause.namedBindings.elements) names.add(item.name.text);
  };
  if (ts.isFunctionLike(scope)) for (const parameter of scope.parameters) for (const name of bindingIdentifiers(parameter.name)) names.add(name);
  if (ts.isCatchClause(scope) && scope.variableDeclaration) for (const name of bindingIdentifiers(scope.variableDeclaration.name)) names.add(name);
  const visit = (node: ts.Node) => {
    if (node !== root && (ts.isBlock(node) || ts.isCaseBlock(node) || ts.isCatchClause(node) || ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node))) return;
    if (node !== root && isCallableBoundary(node)) {
      if (ts.isFunctionDeclaration(node) && node.name) names.add(node.name.text);
      return;
    }
    if (ts.isImportDeclaration(node)) { addImport(node); return; }
    if (ts.isVariableDeclaration(node)) {
      for (const name of bindingIdentifiers(node.name)) names.add(name);
      return;
    }
    if ((ts.isClassDeclaration(node) || ts.isEnumDeclaration(node)) && node.name) names.add(node.name.text);
    ts.forEachChild(node, visit);
  };
  visit(root);
  return names;
}

function directlyDeclaredVariables(scope: FunctionScope): Map<string, ts.VariableDeclaration[]> {
  const result = new Map<string, ts.VariableDeclaration[]>();
  const root = scopeRoot(scope);
  if (!root) return result;
  const visit = (node: ts.Node) => {
    if (node !== root && (ts.isBlock(node) || ts.isCaseBlock(node) || ts.isCatchClause(node) || ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node))) return;
    if (node !== root && isCallableBoundary(node)) return;
    if (ts.isVariableDeclaration(node)) {
      for (const name of bindingIdentifiers(node.name)) {
        const declarations = result.get(name) ?? [];
        declarations.push(node);
        result.set(name, declarations);
      }
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return result;
}

function lexicalScopes(entry: SourceEntry, referenceNode: ts.Node): FunctionScope[] {
  const scopes: FunctionScope[] = [entry.file];
  const ancestors: FunctionScope[] = [];
  let current: ts.Node | undefined = referenceNode;
  while (current) {
    if (isCallableBoundary(current)) ancestors.push(current as ts.FunctionLikeDeclaration);
    else if (ts.isCaseBlock(current)) ancestors.push(current);
    else if (ts.isCatchClause(current)) ancestors.push(current);
    else if (ts.isForStatement(current) || ts.isForInStatement(current) || ts.isForOfStatement(current)) ancestors.push(current);
    else if (ts.isBlock(current) && !(isCallableBoundary(current.parent) && (current.parent as ts.FunctionLikeDeclaration).body === current)) ancestors.push(current);
    current = current.parent;
  }
  scopes.push(...ancestors.reverse());
  return scopes;
}

function visibleBindingNames(entry: SourceEntry, referenceNode: ts.Node): Set<string> {
  const result = new Set<string>();
  for (const scope of lexicalScopes(entry, referenceNode)) for (const name of directlyDeclaredBindings(scope)) result.add(name);
  return result;
}

function assignedIdentifierTargets(node: ts.Node): ts.Identifier[] {
  if (ts.isIdentifier(node)) return [node];
  if (ts.isArrayLiteralExpression(node)) return node.elements.flatMap(element => assignedIdentifierTargets(element));
  if (ts.isObjectLiteralExpression(node)) return node.properties.flatMap(property => {
    if (ts.isShorthandPropertyAssignment(property)) return [property.name];
    if (ts.isPropertyAssignment(property)) return assignedIdentifierTargets(property.initializer);
    if (ts.isSpreadAssignment(property)) return assignedIdentifierTargets(property.expression);
    return [];
  });
  return [];
}

function rawFunctionMap(entry: SourceEntry, referenceNode: ts.Node): Map<string, ts.FunctionLikeDeclaration> {
  const result = new Map<string, ts.FunctionLikeDeclaration>();
  const blocked = new Set<string>();
  for (const scope of lexicalScopes(entry, referenceNode)) {
    const functions = directlyDeclaredFunctions(scope);
    const bindings = directlyDeclaredBindings(scope);
    for (const name of bindings) {
      const candidates = functions.get(name) ?? [];
      if (candidates.length === 1) {
        const candidate = candidates[0]!;
        const declaration = ts.isArrowFunction(candidate) || ts.isFunctionExpression(candidate) ? candidate.parent : null;
        const immutable = declaration && ts.isVariableDeclaration(declaration) && ts.isVariableDeclarationList(declaration.parent) && (declaration.parent.flags & ts.NodeFlags.Const) !== 0;
        if (immutable || ts.isFunctionDeclaration(candidate)) {
          result.set(name, candidate);
          blocked.delete(name);
        } else {
          result.delete(name);
          blocked.add(name);
        }
      } else {
        result.delete(name);
        blocked.add(name);
      }
    }
    for (const name of blocked) result.delete(name);
  }
  return result;
}

const functionWriteCache = new WeakMap<SourceEntry, WeakMap<ts.FunctionLikeDeclaration, boolean>>();

function functionBindingIsReassigned(entry: SourceEntry, name: string, binding: ts.FunctionLikeDeclaration): boolean {
  if (ts.isArrowFunction(binding) || ts.isFunctionExpression(binding)) {
    const declaration = binding.parent;
    if (!ts.isVariableDeclaration(declaration) || !ts.isVariableDeclarationList(declaration.parent) || (declaration.parent.flags & ts.NodeFlags.Const) === 0) return true;
  }
  const cache = functionWriteCache.get(entry) ?? new WeakMap<ts.FunctionLikeDeclaration, boolean>();
  functionWriteCache.set(entry, cache);
  const previous = cache.get(binding);
  if (previous !== undefined) return previous;
  let reassigned = false;
  const inspect = (node: ts.Node) => {
    if (reassigned) return;
    let targets: ts.Identifier[] = [];
    if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) targets = assignedIdentifierTargets(node.left);
    else if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator)) targets = assignedIdentifierTargets(node.operand);
    else if ((ts.isForInStatement(node) || ts.isForOfStatement(node)) && node.initializer) targets = assignedIdentifierTargets(node.initializer);
    if (targets.some(target => target.text === name && rawFunctionMap(entry, target).get(name) === binding)) reassigned = true;
    ts.forEachChild(node, inspect);
  };
  inspect(entry.file);
  cache.set(binding, reassigned);
  return reassigned;
}

/** Resolve only immutable function values visible at the reference site; other bindings mask outer functions. */
function functionMap(entry: SourceEntry, referenceNode: ts.Node = entry.file): Map<string, ts.FunctionLikeDeclaration> {
  const result = rawFunctionMap(entry, referenceNode);
  for (const [name, fn] of result) if (functionBindingIsReassigned(entry, name, fn)) result.delete(name);
  return result;
}

function visibleVariableDeclaration(entry: SourceEntry, referenceNode: ts.Node, name: string): ts.VariableDeclaration | null {
  let visible: ts.VariableDeclaration | null = null;
  for (const scope of lexicalScopes(entry, referenceNode)) {
    if (!directlyDeclaredBindings(scope).has(name)) continue;
    const declarations = directlyDeclaredVariables(scope).get(name);
    visible = declarations?.length === 1 ? declarations[0]! : null;
  }
  return visible;
}

function importedFrom(entry: SourceEntry, localName: string, exportedName: string, modules: readonly string[]): boolean {
  for (const statement of entry.file.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteralLike(statement.moduleSpecifier) || !modules.includes(statement.moduleSpecifier.text) || !statement.importClause) continue;
    const clause = statement.importClause;
    if (clause.name?.text === localName && exportedName === "default") return true;
    if (!clause.namedBindings) continue;
    if (ts.isNamedImports(clause.namedBindings) && clause.namedBindings.elements.some(item => item.name.text === localName && (item.propertyName?.text ?? item.name.text) === exportedName)) return true;
  }
  return false;
}

function nextRouterReceiver(entry: SourceEntry, node: ts.Node, receiver: ts.Expression): boolean {
  if (!ts.isIdentifier(receiver)) return false;
  const declaration = visibleVariableDeclaration(entry, node, receiver.text);
  if (!declaration?.initializer || !ts.isVariableDeclarationList(declaration.parent) || (declaration.parent.flags & ts.NodeFlags.Const) === 0) return false;
  const initializer = unwrap(declaration.initializer);
  if (!ts.isCallExpression(initializer) || !ts.isIdentifier(unwrap(initializer.expression))) return false;
  const hook = (unwrap(initializer.expression) as ts.Identifier).text;
  const hasLocalHookShadow = lexicalScopes(entry, node).slice(1).some(scope => directlyDeclaredBindings(scope).has(hook));
  return !hasLocalHookShadow && importedFrom(entry, hook, "useRouter", ["next/navigation", "next/router"]);
}

function navigationFromCall(entry: SourceEntry, node: ts.CallExpression, expression: ts.PropertyAccessExpression): StaticNavigation {
  const route = routeFromExpression(node.arguments[0]);
  const verified = nextRouterReceiver(entry, node, expression.expression);
  const confidence = verified && route.confidence === "proven" ? "proven" : "indicated";
  const reason = verified
    ? route.confidence === "proven" ? "Receiver dideklarasikan dari hook useRouter Next.js dan path tujuan literal." : "Hook useRouter Next.js terverifikasi, tetapi path tujuan memuat nilai dinamis."
    : "Method .push/.replace memakai receiver bernama router, tetapi symbol-nya tidak terbukti berasal dari hook useRouter Next.js.";
  return { path: route.path ? normalizePath(route.path) : "", node, confidence, reason };
}

function importedNames(source: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause) continue;
    const clause = statement.importClause;
    if (clause.name) names.add(clause.name.text);
    if (!clause.namedBindings) continue;
    if (ts.isNamespaceImport(clause.namedBindings)) names.add(clause.namedBindings.name.text);
    else for (const element of clause.namedBindings.elements) names.add(element.name.text);
  }
  return names;
}

function normalizeSourcePath(path: string): string | null {
  const parts: string[] = [];
  for (const part of path.replaceAll("\\", "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(part);
  }
  return parts.join("/");
}

function relativeSource(entry: SourceEntry, specifier: string, entries: Map<string, SourceEntry>): SourceEntry | null {
  if (!specifier.startsWith(".")) return null;
  const slash = entry.path.lastIndexOf("/");
  const directory = slash < 0 ? "" : entry.path.slice(0, slash + 1);
  const base = normalizeSourcePath(`${directory}${specifier}`);
  if (base === null) return null;
  const candidates = /\.[cm]?[jt]sx?$/u.test(base)
    ? [base]
    : [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts"].map(extension => `${base}${extension}`).concat(["index.ts", "index.tsx", "index.js", "index.jsx"].map(name => `${base}/${name}`));
  return candidates.map(candidate => entries.get(candidate)).find((candidate): candidate is SourceEntry => candidate !== undefined) ?? null;
}

function importedBinding(entry: SourceEntry, localName: string, entries: Map<string, SourceEntry>): { entry: SourceEntry; exportedName: string } | null {
  for (const statement of entry.file.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteralLike(statement.moduleSpecifier)) continue;
    const clause = statement.importClause;
    const target = relativeSource(entry, statement.moduleSpecifier.text, entries);
    if (!clause || !target) continue;
    if (clause.name?.text === localName) return { entry: target, exportedName: "default" };
    if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings) && clause.namedBindings.name.text === localName) return { entry: target, exportedName: "*" };
    if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      const found = clause.namedBindings.elements.find(item => item.name.text === localName);
      if (found) return { entry: target, exportedName: found.propertyName?.text ?? found.name.text };
    }
  }
  return null;
}

function localExportInitializer(entry: SourceEntry, exportedName: string): ts.Expression | null {
  if (exportedName === "default") {
    const statement = entry.file.statements.find(item => ts.isExportAssignment(item) && !item.isExportEquals);
    return statement && ts.isExportAssignment(statement) ? statement.expression : null;
  }
  for (const statement of entry.file.statements) {
    if (!ts.isVariableStatement(statement) || !hasModifier(statement, ts.SyntaxKind.ExportKeyword)) continue;
    const declaration = statement.declarationList.declarations.find(item => ts.isIdentifier(item.name) && item.name.text === exportedName);
    if (declaration?.initializer) return unwrap(declaration.initializer);
  }
  return null;
}

function localExportFactory(entry: SourceEntry, exportedName: string): ts.FunctionLikeDeclaration | null {
  if (exportedName === "default") return null;
  for (const statement of entry.file.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === exportedName && hasModifier(statement, ts.SyntaxKind.ExportKeyword)) return statement;
    if (!ts.isVariableStatement(statement) || !hasModifier(statement, ts.SyntaxKind.ExportKeyword)) continue;
    const declaration = statement.declarationList.declarations.find(item => ts.isIdentifier(item.name) && item.name.text === exportedName);
    if (!declaration?.initializer) continue;
    const value = unwrap(declaration.initializer);
    if (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) return value;
  }
  return null;
}

function resolveFactory(entry: SourceEntry, name: string, entries: Map<string, SourceEntry>, visited: Set<string>): { entry: SourceEntry; fn: ts.FunctionLikeDeclaration } | null {
  const key = `${entry.path}\0${name}`;
  if (visited.has(key)) return null;
  visited.add(key);
  for (const statement of entry.file.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) return { entry, fn: statement };
    if (ts.isVariableStatement(statement)) {
      const declaration = statement.declarationList.declarations.find(item => ts.isIdentifier(item.name) && item.name.text === name);
      if (declaration?.initializer) {
        const value = unwrap(declaration.initializer);
        if (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) return { entry, fn: value };
      }
    }
  }
  const imported = importedBinding(entry, name, entries);
  if (!imported) return null;
  const importedFactory = localExportFactory(imported.entry, imported.exportedName);
  if (importedFactory) return { entry: imported.entry, fn: importedFactory };
  const initializer = localExportInitializer(imported.entry, imported.exportedName);
  if (initializer && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))) return { entry: imported.entry, fn: initializer };
  return null;
}

function returnedObjectMethod(factory: ts.FunctionLikeDeclaration, propertyNameExpected: string): ts.FunctionLikeDeclaration | null {
  if (!factory.body || !ts.isBlock(factory.body)) return null;
  const returned: ts.ObjectLiteralExpression[] = [];
  let unsupportedReturn = false;
  visitExecutable(factory.body, node => {
    if (!ts.isReturnStatement(node)) return;
    if (node.expression && ts.isObjectLiteralExpression(unwrap(node.expression))) returned.push(unwrap(node.expression) as ts.ObjectLiteralExpression);
    else unsupportedReturn = true;
  });
  if (unsupportedReturn || returned.length !== 1) return null;
  const properties = returned[0]!.properties;
  if (properties.some(property => ts.isSpreadAssignment(property) ||
    ((ts.isPropertyAssignment(property) || ts.isMethodDeclaration(property) || ts.isGetAccessorDeclaration(property) || ts.isSetAccessorDeclaration(property)) && ts.isComputedPropertyName(property.name)))) return null;
  const matches = properties.filter(item => propertyName(item.name) === propertyNameExpected);
  if (matches.length !== 1) return null;
  const member = matches[0]!;
  if (!member) return null;
  if (ts.isMethodDeclaration(member)) return member;
  if (ts.isPropertyAssignment(member)) {
    const initializer = unwrap(member.initializer);
    if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) return initializer;
  }
  return null;
}

function returnedFunction(factory: ts.FunctionLikeDeclaration): ts.FunctionLikeDeclaration | null {
  if (!factory.body) return null;
  if (!ts.isBlock(factory.body)) {
    const value = unwrap(factory.body);
    return ts.isArrowFunction(value) || ts.isFunctionExpression(value) ? value : null;
  }
  const returned: ts.FunctionLikeDeclaration[] = [];
  let unsupportedReturn = false;
  visitExecutable(factory.body, node => {
    if (!ts.isReturnStatement(node)) return;
    if (node.expression) {
      const value = unwrap(node.expression);
      if (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) returned.push(value);
      else unsupportedReturn = true;
    } else unsupportedReturn = true;
  });
  return unsupportedReturn || returned.length !== 1 ? null : returned[0]!;
}

function factoryPropertyBinding(entry: SourceEntry, expression: ts.Expression, entriesByPath: Map<string, SourceEntry>): { targetEntry: SourceEntry; exportedName: string; property: string; factory: { entry: SourceEntry; fn: ts.FunctionLikeDeclaration } } | null {
  const path: string[] = [];
  let root: ts.Expression = unwrap(expression);
  while (ts.isPropertyAccessExpression(root)) { path.unshift(root.name.text); root = unwrap(root.expression); }
  if (!ts.isIdentifier(root) || !path.length) return null;
  if (lexicalScopes(entry, root).slice(1).some(scope => directlyDeclaredBindings(scope).has(root.text))) return null;
  const imported = importedBinding(entry, root.text, entriesByPath);
  if (!imported) return null;
  const targetEntry = imported.entry;
  let exportedName = imported.exportedName;
  let property = path.at(-1)!;
  if (exportedName === "*") {
    exportedName = path[0]!;
    if (path.length < 2) return null;
    property = path.at(-1)!;
  }
  const initializer = localExportInitializer(targetEntry, exportedName);
  if (!initializer || !ts.isCallExpression(initializer)) return null;
  const factoryExpression = unwrap(initializer.expression);
  if (!ts.isIdentifier(factoryExpression)) return null;
  const factory = resolveFactory(targetEntry, factoryExpression.text, entriesByPath, new Set());
  if (!factory) return null;
  return { targetEntry, exportedName, property, factory };
}

function resolveDelegatedProperty(entry: SourceEntry, expression: ts.Expression, entriesByPath: Map<string, SourceEntry>): DelegateResolution | null {
  const binding = factoryPropertyBinding(entry, expression, entriesByPath);
  if (!binding) return null;
  if (!hasStableExportBinding(binding.targetEntry, binding.exportedName, entriesByPath)) return { unresolved: true };
  const factory = binding.factory;
  const handler = returnedObjectMethod(factory.fn, binding.property);
  return handler ? { entry: factory.entry, handler } : { unresolved: true };
}

function isBindingDeclarationIdentifier(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (ts.isVariableDeclaration(parent) && parent.name === node) return true;
  if (ts.isParameter(parent) && parent.name === node) return true;
  if ((ts.isFunctionDeclaration(parent) || ts.isFunctionExpression(parent) || ts.isClassDeclaration(parent) || ts.isClassExpression(parent)) && parent.name === node) return true;
  if (ts.isImportSpecifier(parent) || ts.isNamespaceImport(parent) || ts.isImportClause(parent)) return true;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return true;
  if ((ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent) || ts.isPropertyDeclaration(parent) || ts.isPropertySignature(parent) || ts.isGetAccessorDeclaration(parent) || ts.isSetAccessorDeclaration(parent)) && parent.name === node) return true;
  return false;
}

function isRouteHandlerExportExpression(expression: ts.Expression): boolean {
  let current = expression;
  const propertyNames: string[] = [];
  while (ts.isPropertyAccessExpression(current)) {
    propertyNames.unshift(current.name.text);
    current = current.expression;
  }
  if (!ts.isIdentifier(current) || !propertyNames.length) return false;
  const declaration = expression.parent;
  return ts.isVariableDeclaration(declaration) && declaration.initializer === expression && ts.isIdentifier(declaration.name) &&
    ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].includes(declaration.name.text.toUpperCase()) &&
    ts.isVariableDeclarationList(declaration.parent) && ts.isVariableStatement(declaration.parent.parent) && hasModifier(declaration.parent.parent, ts.SyntaxKind.ExportKeyword);
}

function routeHandlerImportBindings(entry: SourceEntry, target: SourceEntry, exportedName: string, entriesByPath: Map<string, SourceEntry>): Array<{ localName: string; namespace: boolean }> {
  const output: Array<{ localName: string; namespace: boolean }> = [];
  for (const statement of entry.file.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteralLike(statement.moduleSpecifier) || !statement.importClause) continue;
    if (relativeSource(entry, statement.moduleSpecifier.text, entriesByPath)?.path !== target.path) continue;
    const bindings = statement.importClause.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) output.push({ localName: bindings.name.text, namespace: true });
    if (bindings && ts.isNamedImports(bindings)) {
      for (const item of bindings.elements) if ((item.propertyName?.text ?? item.name.text) === exportedName) output.push({ localName: item.name.text, namespace: false });
    }
  }
  return output;
}

function isAllowedRouteHandlerReference(identifier: ts.Identifier, localName: string, namespaceExport?: string): boolean {
  if (identifier.text !== localName) return false;
  let expression: ts.Node = identifier;
  const properties: string[] = [];
  while (ts.isPropertyAccessExpression(expression.parent) && expression.parent.expression === expression) {
    properties.push(expression.parent.name.text);
    expression = expression.parent;
  }
  if (namespaceExport) {
    if (properties.length > 0 && properties[0] !== namespaceExport) return true;
    if (properties[0] !== namespaceExport) return false;
    properties.shift();
  }
  if (properties.length === 0) return false;
  const value = expression as ts.Expression;
  return isRouteHandlerExportExpression(value) || (ts.isCallExpression(value.parent) && value.parent.expression === value);
}

const stableHandlerBindingCache = new WeakMap<SourceEntry, Map<string, boolean>>();

function hasStableExportBinding(entry: SourceEntry, exportedName: string, entriesByPath: Map<string, SourceEntry>): boolean {
  const cache = stableHandlerBindingCache.get(entry) ?? new Map<string, boolean>();
  stableHandlerBindingCache.set(entry, cache);
  const cacheKey = `${exportedName}\0${[...entriesByPath.keys()].sort().join("\0")}`;
  const cached = cache.get(cacheKey);
  if (cached !== undefined) return cached;
  const declarations = entry.file.statements.flatMap(statement => {
    if (!ts.isVariableStatement(statement) || !hasModifier(statement, ts.SyntaxKind.ExportKeyword)) return [];
    return statement.declarationList.declarations.filter(item => ts.isIdentifier(item.name) && item.name.text === exportedName)
      .map(declaration => ({ statement, declaration }));
  });
  if (declarations.length !== 1 || (declarations[0]!.statement.declarationList.flags & ts.NodeFlags.Const) === 0) {
    cache.set(cacheKey, false);
    return false;
  }
  for (const source of entriesByPath.values()) {
    if (source !== entry) {
      for (const statement of source.file.statements) {
        if (!ts.isExportDeclaration(statement) || !statement.moduleSpecifier || !ts.isStringLiteralLike(statement.moduleSpecifier)) continue;
        if (relativeSource(source, statement.moduleSpecifier.text, entriesByPath)?.path !== entry.path) continue;
        if (!statement.exportClause || (ts.isNamedExports(statement.exportClause) && statement.exportClause.elements.some(item => (item.propertyName?.text ?? item.name.text) === exportedName))) {
          cache.set(cacheKey, false);
          return false;
        }
      }
    }
    const bindings = source === entry ? [{ localName: exportedName, namespace: false, namespaceExport: undefined }] :
      routeHandlerImportBindings(source, entry, exportedName, entriesByPath).map(binding => ({ ...binding, namespaceExport: binding.namespace ? exportedName : undefined }));
    for (const binding of bindings) {
      let unsafeUse = false;
      const inspect = (node: ts.Node) => {
        if (unsafeUse) return;
        if (ts.isIdentifier(node) && node.text === binding.localName && !isBindingDeclarationIdentifier(node) &&
          !isAllowedRouteHandlerReference(node, binding.localName, binding.namespaceExport)) unsafeUse = true;
        ts.forEachChild(node, inspect);
      };
      inspect(source.file);
      if (unsafeUse) {
        cache.set(cacheKey, false);
        return false;
      }
    }
  }
  cache.set(cacheKey, true);
  return true;
}

function unwrapAwait(expression: ts.Expression): ts.Expression {
  let value = unwrap(expression);
  while (ts.isAwaitExpression(value)) value = unwrap(value.expression);
  return value;
}

/** Follow a route adapter only when its single return directly invokes a statically resolved handler. */
function resolveReturnedDelegate(entry: SourceEntry, handler: ts.FunctionLikeDeclaration, entriesByPath: Map<string, SourceEntry>): DelegateResolution | null {
  if (!handler.body || !ts.isBlock(handler.body)) return null;
  const returns: ts.ReturnStatement[] = [];
  visitExecutable(handler.body, node => { if (ts.isReturnStatement(node)) returns.push(node); });
  if (returns.length !== 1 || !returns[0]!.expression) return null;
  const returned = unwrapAwait(returns[0]!.expression);
  if (!ts.isCallExpression(returned)) return null;
  const callee = unwrap(returned.expression);
  return ts.isPropertyAccessExpression(callee)
    ? resolveDelegatedProperty(entry, callee, entriesByPath)
    : resolveDelegatedCall(entry, returned, entriesByPath);
}

function resolveDelegatedCall(entry: SourceEntry, expression: ts.Expression, entriesByPath: Map<string, SourceEntry>): { entry: SourceEntry; handler: ts.FunctionLikeDeclaration } | null {
  if (!ts.isCallExpression(expression)) return null;
  const callee = unwrap(expression.expression);
  if (!ts.isIdentifier(callee)) return null;
  const factory = resolveFactory(entry, callee.text, entriesByPath, new Set());
  if (!factory) return null;
  const handler = returnedFunction(factory.fn);
  return handler ? { entry: factory.entry, handler } : null;
}

function injectedDependencyCalls(handler: ts.FunctionLikeDeclaration): string[] {
  let outer: ts.FunctionLikeDeclaration | null = null;
  let parent: ts.Node | undefined = handler.parent;
  while (parent) {
    if (isCallableBoundary(parent) && parent !== handler) { outer = parent as ts.FunctionLikeDeclaration; break; }
    parent = parent.parent;
  }
  const parameters = new Set((outer?.parameters ?? []).flatMap(parameter => ts.isIdentifier(parameter.name) ? [parameter.name.text] : []));
  if (!parameters.size || !handler.body) return [];
  const calls = new Set<string>();
  visitHandlerFlow(handler.body, "proven", node => {
    if (!ts.isCallExpression(node)) return;
    let expression: ts.Expression = unwrap(node.expression);
    while (ts.isPropertyAccessExpression(expression)) expression = unwrap(expression.expression);
    if (ts.isIdentifier(expression) && parameters.has(expression.text)) {
      const callee = unwrap(node.expression);
      const name = ts.isPropertyAccessExpression(callee) ? callee.name.text : expression.text;
      calls.add(`${expression.text}.${name}`);
    }
  });
  return [...calls].sort();
}

function requestWrapperParameters(entry: SourceEntry, functions: Map<string, ts.FunctionLikeDeclaration>): Map<string, number> {
  const result = new Map<string, number>();
  for (const [name, fn] of functions) {
    if (!fn.body) continue;
    const first = fn.parameters[0]?.name;
    if (!first || !ts.isIdentifier(first)) continue;
    let wraps = false;
    visitExecutable(fn.body, node => {
      if (ts.isCallExpression(node) && ts.isIdentifier(unwrap(node.expression)) && (unwrap(node.expression) as ts.Identifier).text === "fetch" &&
        !visibleBindingNames(entry, node).has("fetch") && node.arguments[0] && ts.isIdentifier(node.arguments[0]) && node.arguments[0].text === first.text) wraps = true;
    });
    if (wraps) result.set(name, 0);
  }
  return result;
}

function findRequests(fn: ts.FunctionLikeDeclaration, entry: SourceEntry, visited = new Set<ts.Node>(), depth = 0): StaticRequest[] {
  if (!fn.body || visited.has(fn) || depth > 3) return [];
  visited.add(fn);
  const output: StaticRequest[] = [];
  const functions = functionMap(entry, fn);
  const wrappers = requestWrapperParameters(entry, functions);
  const visit = (node: ts.Node) => {
    if (node !== fn && isCallableBoundary(node)) return;
    if (ts.isCallExpression(node)) {
      const callee = unwrap(node.expression);
      if (ts.isIdentifier(callee) && callee.text === "fetch") {
        if (visibleBindingNames(entry, node).has("fetch")) {
          output.push({ method: "GET", path: "", node, confidence: "indicated" });
          return;
        }
        const route = routeFromExpression(node.arguments[0]);
        const method = methodForFetchFromOptions(node.arguments[1]);
        if (route.path && method) output.push({ method, path: normalizeRoute(route.path), node, confidence: route.confidence });
        else if (node.arguments[0]) output.push({ method: "GET", path: "", node, confidence: "indicated" });
      } else if (ts.isIdentifier(callee) && wrappers.has(callee.text)) {
        const index = wrappers.get(callee.text)!;
        const route = routeFromExpression(node.arguments[index]);
        if (route.path) {
          const options = node.arguments[1];
          const method = methodForFetchFromOptions(options);
          output.push({ method: method ?? "GET", path: method ? normalizeRoute(route.path) : "", node, confidence: method ? route.confidence : "indicated" });
        }
      } else if (ts.isIdentifier(callee) && functions.has(callee.text)) {
        output.push(...findRequests(functions.get(callee.text)!, entry, visited, depth + 1));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(fn.body);
  return output;
}

function pageLoadRequests(entry: SourceEntry, handler: ts.FunctionLikeDeclaration, limitations: SemanticFragment["limitations"]): PageLoadRequest[] {
  if (!handler.body) return [];
  const output: PageLoadRequest[] = [];
  const collectFetches = (root: ts.Node, sourceConfidence: "proven" | "indicated", reason: string, evidenceNodes: ts.Node[] = [], visitedFunctions = new Set<ts.FunctionLikeDeclaration>()) => {
    visitExecutable(root, node => {
      if (!ts.isCallExpression(node)) return;
      const callee = unwrap(node.expression);
      if (ts.isIdentifier(callee) && callee.text === "fetch") {
      const shadowed = visibleBindingNames(entry, node).has("fetch");
      const route = shadowed ? { path: null, confidence: "indicated" as const } : routeFromExpression(node.arguments[0]);
      const method = shadowed ? null : methodForFetchFromOptions(node.arguments[1]);
      const request: StaticRequest = route.path && method
        ? { method, path: normalizeRoute(route.path), node, confidence: sourceConfidence === "proven" ? route.confidence : "indicated" }
        : { method: "GET", path: "", node, confidence: "indicated" };
      output.push({ request, evidenceNodes: [...evidenceNodes, node], reason: shadowed
        ? "Nama fetch terikat secara lokal sehingga tidak dapat dipastikan sebagai HTTP global."
        : !route.path || !method ? "URL atau method fetch tidak dapat ditentukan secara statis."
          : reason });
        return;
      }
      if (ts.isPropertyAccessExpression(callee) && ["then", "catch", "finally"].includes(callee.name.text)) {
        for (const argument of node.arguments) {
          const callback = unwrap(argument);
          if ((ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) && callback.body) {
            collectFetches(callback.body, "indicated", "Fetch ditemukan pada callback Promise yang dipanggil dari alur pemuatan halaman; pemanggilan runtime callback tidak diverifikasi.", [...evidenceNodes, node], visitedFunctions);
          }
        }
        return;
      }
      if (ts.isIdentifier(callee)) {
        const helper = functionMap(entry, node).get(callee.text);
        if (helper?.body && !visitedFunctions.has(helper)) {
          const nextVisited = new Set(visitedFunctions);
          nextVisited.add(helper);
          collectFetches(helper.body, "indicated", `Helper lokal ${callee.text} dipanggil dari alur pemuatan halaman, tetapi kondisi runtime helper tidak dianalisis.`, [...evidenceNodes, node], nextVisited);
        }
      }
    });
  };

  // A direct call in the page component runs in the page render path. Nested, uncalled
  // helpers are skipped by visitExecutable and cannot become page-load facts.
  collectFetches(handler.body, "proven", "Pemanggilan fetch literal terlihat langsung pada badan page component.");
  visitExecutable(handler.body, node => {
    if (!ts.isCallExpression(node) || !ts.isIdentifier(unwrap(node.expression))) return;
    const hookName = (unwrap(node.expression) as ts.Identifier).text;
    if (hookName !== "useEffect") return;
    const callbackArgument = node.arguments[0] && unwrap(node.arguments[0]);
    const callback = callbackArgument && (ts.isArrowFunction(callbackArgument) || ts.isFunctionExpression(callbackArgument))
      ? callbackArgument
      : callbackArgument && ts.isIdentifier(callbackArgument) ? functionMap(entry, node).get(callbackArgument.text) ?? null : null;
    if (!callback?.body) {
      if (callbackArgument) limitations.push({ filePath: entry.path, reason: "Callback useEffect tidak berbentuk fungsi inline atau binding lokal statis; request pemuatan halaman tidak ditautkan." });
      return;
    }
    const verifiedHook = !lexicalScopes(entry, node).slice(1).some(scope => directlyDeclaredBindings(scope).has(hookName)) &&
      importedFrom(entry, hookName, "useEffect", ["react"]);
    const before = output.length;
    collectFetches(callback.body, verifiedHook ? "proven" : "indicated", verifiedHook
      ? "Callback useEffect diimpor langsung dari React dan memuat endpoint melalui fetch literal."
      : "Callback dengan nama useEffect memuat fetch literal, tetapi binding hook tidak terbukti berasal dari React.", [node]);
    if (!verifiedHook && output.length > before) limitations.push({ filePath: entry.path, reason: "Callback useEffect memuat request yang tetap berupa indikasi karena import React tidak dapat diverifikasi." });
  });
  const byFetch = new Map<ts.Node, PageLoadRequest>();
  for (const item of output) {
    const existing = byFetch.get(item.request.node);
    if (!existing) byFetch.set(item.request.node, item);
    else {
      existing.request.confidence = existing.request.confidence === "indicated" || item.request.confidence === "indicated" ? "indicated" : "proven";
      existing.reason = [...new Set([existing.reason, item.reason])].join("; ");
      existing.evidenceNodes = [...new Set([...existing.evidenceNodes, ...item.evidenceNodes])];
    }
  }
  return [...byFetch.values()];
}

function findNavigations(fn: ts.FunctionLikeDeclaration, entry: SourceEntry, visited = new Set<ts.Node>(), depth = 0): StaticNavigation[] {
  if (!fn.body || visited.has(fn) || depth > 3) return [];
  visited.add(fn);
  const output: StaticNavigation[] = [];
  const functions = functionMap(entry, fn);
  visitExecutable(fn.body, node => {
    if (!ts.isCallExpression(node)) return;
    const expression = unwrap(node.expression);
    if (ts.isPropertyAccessExpression(expression) && ["push", "replace"].includes(expression.name.text) && /(?:^|\.)router$/iu.test(expression.expression.getText())) {
      output.push(navigationFromCall(entry, node, expression));
      return;
    }
    if (ts.isIdentifier(expression) && functions.has(expression.text)) output.push(...findNavigations(functions.get(expression.text)!, entry, visited, depth + 1));
  });
  return output;
}

function findInlineNavigations(expression: ts.Expression, entry: SourceEntry): StaticNavigation[] {
  if (ts.isIdentifier(expression)) {
    const target = functionMap(entry, expression).get(expression.text);
    return target ? findNavigations(target, entry) : [];
  }
  if (!(ts.isArrowFunction(expression) || ts.isFunctionExpression(expression))) return [];
  const output: StaticNavigation[] = [];
  visitExecutable(expression, node => {
    if (!ts.isCallExpression(node)) return;
    const callee = unwrap(node.expression);
    if (ts.isPropertyAccessExpression(callee) && ["push", "replace"].includes(callee.name.text) && /(?:^|\.)router$/iu.test(callee.expression.getText())) {
      output.push(navigationFromCall(entry, node, callee));
    } else if (ts.isIdentifier(callee)) {
      const target = functionMap(entry, node).get(callee.text);
      if (target) output.push(...findNavigations(target, entry));
    }
  });
  return output;
}

function normalizePath(path: string): string {
  return path.replace(/\[\.\.\.([^/]+)\]/gu, ":$1").replace(/\[\[?([^\]]+)\]?\]/gu, ":$1");
}

function endpointFeatureId(path: string, firstStart: number): { id: string; label: string } {
  const family = routeFamily(path);
  return { id: semanticId("feature", "", firstStart, `next:${family.key}`), label: family.label };
}

function pageDeclaration(entry: SourceEntry): ts.Node {
  return entry.file.statements.find(statement => hasModifier(statement, ts.SyntaxKind.ExportKeyword) && hasModifier(statement, ts.SyntaxKind.DefaultKeyword))
    ?? entry.file.statements[0]
    ?? entry.file;
}

function pageFunction(entry: SourceEntry): ts.FunctionLikeDeclaration | null {
  const declaration = pageDeclaration(entry);
  if (isCallableBoundary(declaration)) return declaration as ts.FunctionLikeDeclaration;
  if (!ts.isExportAssignment(declaration) || declaration.isExportEquals) return null;
  const expression = unwrap(declaration.expression);
  if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) return expression;
  if (ts.isIdentifier(expression)) return functionMap(entry, entry.file).get(expression.text) ?? null;
  return null;
}

function enclosingFunction(node: ts.Node): ts.FunctionLikeDeclaration | null {
  let current: ts.Node | undefined = node;
  while (current) {
    if (isCallableBoundary(current)) return current as ts.FunctionLikeDeclaration;
    current = current.parent;
  }
  return null;
}

function pageLabel(route: string): string {
  if (route === "/") return "Halaman utama";
  const parts = route.split("/").filter(Boolean);
  const last = parts.at(-1) ?? "";
  if (last.startsWith(":")) return humanLabel([...parts.slice(0, -1), "detail"].join(" ") || "Halaman dinamis");
  return humanLabel(parts.join(" "));
}

function explicitActor(entry: SourceEntry, handler: ts.FunctionLikeDeclaration): { label: string; evidence: EvidenceSpan } | null {
  if (!handler.body) return null;
  let actor: { label: string; evidence: EvidenceSpan } | null = null;
  visitExecutable(handler.body, node => {
    if (actor || !ts.isIfStatement(node)) return;
    const raw = node.expression.getText(entry.file);
    const match = raw.match(/(?:user|session|account|member)(?:\.[A-Za-z_$][\w$]*)*\.?(?:role|type)\s*(?:===?|!==?)\s*["']([^"']+)["']/iu)
      ?? raw.match(/(?:role|type)\s*(?:===?|!==?)\s*["']([^"']+)["']/iu);
    if (!match) return;
    actor = { label: humanLabel(match[1]!), evidence: nodeRange(entry, node.expression, "context") };
  });
  return actor;
}

function attachFeature(fragment: SemanticFragment, featureId: string, label: string, entryIds: string[], ids: string[], edgeIds: string[], evidence: EvidenceSpan[]): void {
  const feature = fragment.features.find(item => item.id === featureId);
  if (feature) {
    feature.entryNodeIds = [...new Set([...feature.entryNodeIds, ...entryIds])].sort();
    feature.nodeIds = [...new Set([...feature.nodeIds, ...ids])].sort();
    feature.edgeIds = [...new Set([...feature.edgeIds, ...edgeIds])].sort();
    feature.evidence = compactEvidence([...feature.evidence, ...evidence]);
  } else fragment.features.push({ id: featureId, label, entryNodeIds: [...new Set(entryIds)].sort(), nodeIds: [...new Set(ids)].sort(), edgeIds: [...new Set(edgeIds)].sort(), evidence: compactEvidence(evidence) });
  ensureFeatureNode(fragment, featureId, label, evidence, "indicated", "Feature group is inferred from a shared static route family; the source does not declare a business label.");
}

function findPageRoute(routes: Map<string, SemanticNode>, path: string): SemanticNode | null {
  const normalized = normalizePath(path);
  return [...routes].find(([route]) => routeMatches(route, normalized))?.[1] ?? null;
}

/** Deterministic Next.js app-router/API extractor. Only literal source links become proven flow edges. */
export function extractNext(input: SemanticInput): SemanticFragment {
  const fragment = emptyFragment();
  const entries: SourceEntry[] = [];
  for (const [path, bytes] of Object.entries(input.sources).sort(([a], [b]) => a.localeCompare(b))) {
    const kind = scriptKind(path);
    if (!kind || excludeFromMainFlow(path)) continue;
    const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kind);
    entries.push({ path, bytes, text, file });
  }
  for (const [path] of Object.entries(input.sources).sort(([a], [b]) => a.localeCompare(b))) {
    if (!scriptKind(path) || excludeFromMainFlow(path) || !/(?:^|\/)pages\//u.test(path.replaceAll("\\", "/"))) continue;
    fragment.frameworks.push("Next.js Pages Router");
    fragment.limitations.push({ filePath: path, reason: "Next.js Pages Router ditemukan, tetapi extractor saat ini hanya membuktikan alur App Router." });
  }
  const routeRows: ApiRoute[] = [];
  const pageRoutes = new Map<string, SemanticNode>();
  const pageHandlers: Array<{ route: string; page: SemanticNode; entry: SourceEntry; handler: ts.FunctionLikeDeclaration }> = [];
  const uiEventKinds = new Map<string, string>();
  const semanticFlows: SemanticFlowScope[] = [];
  const ccmNodes = input.ccm.nodes;
  const entriesByPath = new Map(entries.map(entry => [entry.path, entry]));
  for (const entry of entries) {
    const app = appRoot(entry.path);
    if (!app) continue;
    if (app.fileKind === "page") {
      const route = normalizePath(app.route);
      const declaration = pageDeclaration(entry);
      const span = nodeRange(entry, declaration, "declaration");
      const family = endpointFeatureId(route, 0);
      const pageNode = semanticNode({ kind: "feature", filePath: entry.path, startByte: span.startByte, key: `next-page:${route}`, label: pageLabel(route), featureId: family.id,
        confidence: "proven", reason: "Halaman Next.js dideklarasikan oleh page file.", evidence: [span], technicalNodeIds: technicalNodesForSpan(ccmNodes, entry.path, span.startByte, span.endByte, ["Module"]) });
      pageRoutes.set(route, pageNode);
      fragment.nodes.push(pageNode);
      fragment.frameworks.push("Next.js App Router");
      attachFeature(fragment, family.id, family.label, [pageNode.id], [pageNode.id], [], [span]);
      const pageHandler = pageFunction(entry);
      if (pageHandler) {
        semanticFlows.push({ entry, handler: pageHandler, featureId: family.id, confidence: "proven" });
        pageHandlers.push({ route, page: pageNode, entry, handler: pageHandler });
      }
    }
    if (app.fileKind !== "route") continue;
    for (const statement of entry.file.statements) {
      const exported = methodExport(statement, entry.file);
      if (!exported) continue;
      const delegated = !exported.handler
        ? ts.isPropertyAccessExpression(exported.declaration)
          ? resolveDelegatedProperty(entry, exported.declaration, entriesByPath)
          : ts.isCallExpression(exported.declaration) ? resolveDelegatedCall(entry, exported.declaration, entriesByPath) : null
        : resolveReturnedDelegate(entry, exported.handler, entriesByPath);
      const resolvedDelegate = delegated && "handler" in delegated ? delegated : null;
      const unresolvedDelegate = Boolean(delegated && "unresolved" in delegated);
      const handler = resolvedDelegate?.handler ?? (unresolvedDelegate ? null : exported.handler) ?? null;
      const handlerEntry = resolvedDelegate?.entry ?? entry;
      const handlerConfidence = resolvedDelegate ? "proven" : unresolvedDelegate ? "indicated" : exported.confidence;
      const family = endpointFeatureId(app.route, 0);
      const span = nodeRange(entry, exported.declaration, "declaration");
      const stepId = semanticId("step", entry.path, span.startByte, `api:${exported.method}:${app.route}`);
      const componentId = semanticId("component", entry.path, span.startByte, `route-handler:${exported.method}:${app.route}`);
      routeRows.push({ path: normalizePath(app.route), method: exported.method, entry, declaration: exported.declaration, handlerEntry, handler, handlerConfidence, featureId: family.id, featureLabel: family.label, stepId, componentId });
      const actorFact = handler ? explicitActor(handlerEntry, handler) : null;
      const actorLabel = actorFact?.label ?? "Pengguna";
      const actorEvidence = actorFact ? [actorFact.evidence] : [span];
      const actor = semanticNode({ kind: "actor", filePath: entry.path, startByte: actorEvidence[0]!.startByte, key: `next-actor:${actorLabel}`, label: actorLabel,
        confidence: actorFact && handlerConfidence === "proven" ? "proven" : "indicated", reason: actorFact ? "Peran dibandingkan secara eksplisit pada cabang handler endpoint." : "Aktor umum dipakai sebagai placeholder karena repository tidak menyatakan peran pada endpoint ini.", evidence: actorEvidence });
      fragment.nodes.push(actor);
      const apiStep = semanticNode({ kind: "step", filePath: entry.path, startByte: span.startByte, key: `api:${exported.method}:${app.route}`, label: `${exported.method} ${app.route}`,
        featureId: family.id, confidence: "proven", reason: "HTTP method dan app route dideklarasikan secara statis.", evidence: [span], technicalNodeIds: technicalNodesForSpan(ccmNodes, entry.path, span.startByte, span.endByte) });
      apiStep.label = `${exported.method} ${app.route}`;
      const handlerSpan = handler ? nodeRange(handlerEntry, handler, "declaration") : null;
      const componentEvidence = handlerSpan && (handlerSpan.filePath !== span.filePath || handlerSpan.startByte !== span.startByte) ? [span, handlerSpan] : [span];
      const component = semanticNode({ kind: "component", filePath: entry.path, startByte: span.startByte, key: `route-handler:${exported.method}:${app.route}`, label: `${handler ? nameOfHandler(handler, app.route) : humanLabel(exported.handlerLabel)} API`, featureId: family.id,
        confidence: handlerConfidence, reason: handlerConfidence === "proven" ? "Route handler terhubung ke implementasi source yang dideklarasikan." : "Handler didelegasikan atau dibungkus; perilaku penghubung belum terverifikasi.", evidence: componentEvidence, technicalNodeIds: handlerSpan ? technicalNodesForSpan(ccmNodes, handlerSpan.filePath, handlerSpan.startByte, handlerSpan.endByte) : technicalNodesForSpan(ccmNodes, entry.path, span.startByte, span.endByte) });
      const actorEdge = makeEdge("actor-feature", actor.id, apiStep.id, "mengakses endpoint", actorFact && handlerConfidence === "proven" ? "proven" : "indicated", actorFact ? "Peran dibandingkan pada implementasi handler yang terlihat." : "Aktor umum untuk endpoint; peran belum terbukti.", actorEvidence[0]!);
      const featureEdge = makeEdge("feature-step", family.id, apiStep.id, "mencakup", "proven", "Endpoint dideklarasikan di bawah route app yang cocok.", span);
      const handlerEdge = makeEdge("step-handler", apiStep.id, component.id, "ditangani oleh", handlerConfidence, handlerConfidence === "proven" ? "Route handler terhubung secara statis ke implementasi callback atau factory yang cocok." : "Route mengekspor callback/factory yang perilaku atau implementasinya belum diselesaikan.", span);
      if (handlerSpan && componentEvidence.length > 1) handlerEdge.evidence.push(handlerSpan);
      fragment.nodes.push(apiStep, component);
      fragment.edges.push(actorEdge, featureEdge, handlerEdge);
      const nodeIds = [actor.id, apiStep.id, component.id];
      const edgeIds = [actorEdge.id, featureEdge.id, handlerEdge.id];
      const featureEvidence = [span];
      attachFeature(fragment, family.id, family.label, [apiStep.id], nodeIds, edgeIds, featureEvidence);
      fragment.frameworks.push("Next.js App Router");
      if (handler) {
        semanticFlows.push({ entry: handlerEntry, handler, featureId: family.id, confidence: handlerConfidence });
        if (handlerConfidence === "indicated") fragment.limitations.push({ filePath: entry.path, reason: `Endpoint ${exported.method} ${app.route} memakai callback/factory; detail alur callback ditampilkan sebagai indikasi sampai perilaku wrapper terbukti.` });
        const injectedCalls = injectedDependencyCalls(handler);
        if (injectedCalls.length) fragment.limitations.push({ filePath: handlerEntry.path, reason: `Handler memanggil dependency injeksi (${injectedCalls.join(", ")}); implementasi callback yang dipasok factory belum ditautkan ke alur ini.` });
        addGuards(fragment, input, handlerEntry, handler, apiStep.id, family.id, nodeIds, edgeIds, handlerConfidence);
        addStores(fragment, input, handlerEntry, handler, component.id, family.id, nodeIds, edgeIds, handlerConfidence);
        addResponseOutcome(fragment, handlerEntry, handler, apiStep.id, family.id, nodeIds, edgeIds, handlerConfidence);
      } else fragment.limitations.push({ filePath: entry.path, reason: `Endpoint ${exported.method} ${app.route} mendelegasikan handler ke ${exported.handlerLabel}; implementasi handler tidak tersedia pada deklarasi route.` });
    }
  }

  const routes = [...routeRows].sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
  for (const { route, page, entry, handler } of pageHandlers) {
    const pageFeatureId = page.featureId;
    if (!pageFeatureId) continue;
    const handlerSpan = nodeRange(entry, handler, "declaration");
    let pageComponent: SemanticNode | null = null;
    for (const { request, reason, evidenceNodes } of pageLoadRequests(entry, handler, fragment.limitations)) {
      if (!request.path) {
        fragment.limitations.push({ filePath: entry.path, reason: `Pemuatan data halaman ${route} tidak dapat ditautkan: ${reason}` });
        continue;
      }
      const endpoint = matchRoute(routes, request.method, request.path);
      if (!endpoint) {
        fragment.limitations.push({ filePath: entry.path, reason: `Pemuatan data halaman ${route} memanggil ${request.method} ${request.path}, tetapi route API yang cocok tidak ada dalam snapshot.` });
        continue;
      }
      const requestSpan = nodeRange(entry, request.node, "reference");
      const requestEvidence = [...new Map(evidenceNodes.map(node => {
        const span = nodeRange(entry, node, node === request.node ? "reference" : "context");
        return [`${span.startByte}:${span.endByte}`, span] as const;
      })).values()].sort((a, b) => a.startByte - b.startByte);
      if (!pageComponent) {
        const pageName = nameOfHandler(handler, route);
        const label = /page$/iu.test(pageName) ? humanLabel(pageName) : `${humanLabel(pageName)} Page`;
        pageComponent = semanticNode({ kind: "component", filePath: entry.path, startByte: handlerSpan.startByte, key: `page-boundary:${route}`, label,
          featureId: pageFeatureId, confidence: "proven", reason: "Komponen halaman adalah boundary utama yang dideklarasikan Next.js.", evidence: [handlerSpan],
          technicalNodeIds: technicalNodesForSpan(ccmNodes, entry.path, handlerSpan.startByte, handlerSpan.endByte, ["Module"]) });
        fragment.nodes.push(pageComponent);
        const pageEdge = makeEdge("page-component", page.id, pageComponent.id, "ditampilkan melalui", "proven", "Komponen merupakan deklarasi default page route ini.", handlerSpan);
        fragment.edges.push(pageEdge);
        addFeatureMembers(fragment, pageFeatureId, [pageComponent.id], [pageEdge.id], [handlerSpan]);
      }
      const loadStep = semanticNode({ kind: "step", filePath: entry.path, startByte: requestSpan.startByte, key: `page-load:${route}:${request.method}:${request.path}`,
        label: "Memuat data", featureId: pageFeatureId, confidence: request.confidence, reason, evidence: requestEvidence,
        technicalNodeIds: technicalNodesForSpan(ccmNodes, entry.path, requestSpan.startByte, requestSpan.endByte) });
      fragment.nodes.push(loadStep);
      const startEdge = makeEdge("page-load", pageComponent.id, loadStep.id, "memuat data", request.confidence, reason, requestSpan);
      const endpointEdge = makeEdge("page-load-api", loadStep.id, endpoint.stepId, `${request.method} ${request.path}`, request.confidence,
        request.confidence === "proven" ? "Pemanggilan fetch di boundary halaman cocok dengan method dan path route API yang dideklarasikan." : `${reason} Route cocok secara literal, tetapi hubungan pemuatan halaman belum terbukti sepenuhnya.`, requestSpan);
      startEdge.evidence = requestEvidence;
      endpointEdge.evidence = requestEvidence;
      fragment.edges.push(startEdge, endpointEdge);
      addFeatureMembers(fragment, pageFeatureId, [loadStep.id], [startEdge.id], [requestSpan]);
      addFeatureMembers(fragment, endpoint.featureId, [], [endpointEdge.id], [requestSpan]);
    }
  }
  for (const entry of entries) {
    const imports = importedNames(entry.file);
    const allFunctionNames = functionNamesInEntry(entry);
    const walk = (node: ts.Node) => {
      if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
        const tag = jsxTag(node), attrs = jsxAttributes(node), actionProps = attrs.properties.filter((property): property is ts.JsxAttribute => ts.isJsxAttribute(property) && ["onClick", "onSubmit", "action"].includes(jsxAttributeName(property.name)));
        const href = attrs.properties.find((property): property is ts.JsxAttribute => ts.isJsxAttribute(property) && jsxAttributeName(property.name) === "href");
        const hrefExpression = href?.initializer && ts.isJsxExpression(href.initializer) ? href.initializer.expression ?? undefined : href?.initializer;
        const linkRoute = routeFromExpression(hrefExpression);
        const linkPath = linkRoute.path;
        const dynamicHref = Boolean(href?.initializer && !ts.isStringLiteralLike(href.initializer) && linkPath === null);
        const isInteractive = ["button", "form", "a", "Link"].includes(tag);
        if (isInteractive && (actionProps.length || linkPath || dynamicHref)) {
          const label = jsxLabel(node) || (linkPath ? `Buka ${humanLabel(linkPath)}` : tag === "form" ? "Kirim formulir" : "Tindakan pengguna");
          const span = nodeRange(entry, node, "context");
          const event = actionProps[0];
          const visibleFunctions = functionMap(entry, node);
          const functionCalls: string[] = [];
          let staticActionRoute: { path: string; method: string; confidence: "proven" | "indicated" } | null = null;
          if (event?.initializer && ts.isJsxExpression(event.initializer) && event.initializer.expression) {
            const expression = event.initializer.expression;
            if (ts.isIdentifier(expression)) functionCalls.push(expression.text);
            visitExecutable(expression, child => {
              if (ts.isCallExpression(child) && ts.isIdentifier(unwrap(child.expression))) functionCalls.push((unwrap(child.expression) as ts.Identifier).text);
            });
          }
          if (event && jsxAttributeName(event.name) === "action" && event.initializer) {
            const actionExpression = ts.isJsxExpression(event.initializer) ? event.initializer.expression ?? undefined : event.initializer;
            const actionRoute = routeFromExpression(actionExpression);
            if (actionRoute.path) staticActionRoute = { path: normalizePath(actionRoute.path), method: "GET", confidence: actionRoute.confidence };
          }
          if (tag === "form") {
            const methodAttr = attrs.properties.find((property): property is ts.JsxAttribute => ts.isJsxAttribute(property) && jsxAttributeName(property.name) === "method");
            const actionAttr = attrs.properties.find((property): property is ts.JsxAttribute => ts.isJsxAttribute(property) && jsxAttributeName(property.name) === "action");
            if (actionAttr?.initializer) {
              const actionExpression = ts.isJsxExpression(actionAttr.initializer) ? actionAttr.initializer.expression ?? undefined : actionAttr.initializer;
              const actionRoute = routeFromExpression(actionExpression);
              if (actionRoute.path) staticActionRoute = { path: normalizePath(actionRoute.path), method: methodAttr?.initializer && ts.isStringLiteralLike(methodAttr.initializer) ? methodAttr.initializer.text.toUpperCase() : "GET", confidence: actionRoute.confidence };
            }
          }
          const requestsByFunction = new Map<string, StaticRequest[]>();
          const navigationsByFunction = new Map<string, StaticNavigation[]>();
          for (const name of new Set(functionCalls)) {
            const handler = visibleFunctions.get(name);
            if (!handler) continue;
            requestsByFunction.set(name, findRequests(handler, entry));
            navigationsByFunction.set(name, findNavigations(handler, entry));
          }
          const inlineRequest = event?.initializer && ts.isJsxExpression(event.initializer) && event.initializer.expression &&
            (ts.isArrowFunction(event.initializer.expression) || ts.isFunctionExpression(event.initializer.expression))
            ? findRequests(event.initializer.expression, entry) : [];
          const requests = [...functionCalls.flatMap(name => requestsByFunction.get(name) ?? []), ...inlineRequest];
          const navigations = [...new Set([
            ...functionCalls.flatMap(name => navigationsByFunction.get(name) ?? []),
            ...(event?.initializer && ts.isJsxExpression(event.initializer) && event.initializer.expression ? findInlineNavigations(event.initializer.expression, entry) : []),
          ].map(navigation => navigation))];
          if (dynamicHref) fragment.limitations.push({ filePath: entry.path, reason: `Tautan “${label}” memakai href yang tidak cocok dengan path statis yang dapat dipetakan.` });
          const candidates = requests.map(request => ({ request, route: matchRoute(routes, request.method, request.path) })).filter((item): item is { request: StaticRequest; route: ApiRoute } => item.route !== null);
          const unresolvedHandlerCalls = [...new Set(functionCalls.filter(name => imports.has(name) || (allFunctionNames.has(name) && !visibleFunctions.has(name))))];
          if (unresolvedHandlerCalls.length) fragment.limitations.push({ filePath: entry.path, reason: `Aksi “${label}” memanggil handler (${unresolvedHandlerCalls.join(", ")}) yang binding lexical-nya tidak dapat dipastikan; relasi aksi tidak ditegaskan.` });
          if (requests.some(request => !request.path)) fragment.limitations.push({ filePath: entry.path, reason: `Aksi “${label}” menggunakan path/method HTTP yang tidak dapat ditentukan secara statis.` });
          if (requests.some(request => request.path && request.confidence === "indicated")) fragment.limitations.push({ filePath: entry.path, reason: `Aksi “${label}” memiliki parameter URL dinamis; hubungan memakai pola route yang cocok dan tetap berupa indikasi.` });
          if (staticActionRoute) {
            const matched = matchRoute(routes, staticActionRoute.method, staticActionRoute.path);
            if (matched) candidates.push({ request: { ...staticActionRoute, node }, route: matched });
          }
          const pageDestinations: Array<{ path: string; evidence: EvidenceSpan; reason: string; confidence: "proven" | "indicated" }> = [];
          if (linkPath) pageDestinations.push({ path: normalizePath(linkPath), evidence: span, reason: "Href statis atau path berpola cocok dengan route halaman Next.js.", confidence: linkRoute.confidence });
          if (tag === "form" && staticActionRoute?.method === "GET") pageDestinations.push({ path: staticActionRoute.path, evidence: span, reason: "Form GET menunjuk ke route halaman Next.js.", confidence: staticActionRoute.confidence });
          for (const navigation of navigations) {
            if (navigation.confidence === "indicated") fragment.limitations.push({ filePath: entry.path, reason: `Navigasi pada aksi “${label}” hanya berupa indikasi: ${navigation.reason}` });
            if (!navigation.path) fragment.limitations.push({ filePath: entry.path, reason: `Aksi “${label}” memiliki tujuan router dinamis yang tidak dapat dipetakan secara statis.` });
            else pageDestinations.push({ path: navigation.path, evidence: nodeRange(entry, navigation.node, "reference"), reason: navigation.reason, confidence: navigation.confidence });
          }
          for (const destination of pageDestinations) {
            const page = findPageRoute(pageRoutes, destination.path);
            if (!page) {
              fragment.limitations.push({ filePath: entry.path, reason: `Tujuan navigasi ${destination.path} tidak cocok dengan page route dalam snapshot.` });
              continue;
            }
            const uiNode = semanticNode({ kind: "step", filePath: entry.path, startByte: span.startByte, key: `ui:${tag}:${label}:to:${destination.path}`, label, confidence: destination.confidence, reason: "Aksi UI mengarah ke halaman Next.js yang dideklarasikan.", evidence: [span], technicalNodeIds: technicalNodesForSpan(ccmNodes, entry.path, span.startByte, span.endByte) });
            uiNode.featureId = page.featureId;
            uiEventKinds.set(uiNode.id, `${tag}:${event ? jsxAttributeName(event.name) : linkPath ? "href" : "navigation"}`);
            fragment.nodes.push(uiNode);
            const actorEdge = addUiActor(fragment, page.featureId!, uiNode, span);
            const edge = makeEdge("ui-page", uiNode.id, page.id, "membuka halaman", destination.confidence, destination.reason, destination.evidence);
            fragment.edges.push(edge); addFeatureMembers(fragment, page.featureId, [uiNode.id], [edge.id, actorEdge.id], [span, destination.evidence]);
          }
          for (const { request, route } of candidates) {
            const requestHandler = enclosingFunction(request.node);
            if (requestHandler) semanticFlows.push({ entry, handler: requestHandler, featureId: route.featureId, confidence: request.confidence });
            for (const name of functionCalls) {
              const actionHandler = visibleFunctions.get(name);
              if (actionHandler && (requestsByFunction.get(name) ?? []).some(item => matchRoute(routes, item.method, item.path)?.featureId === route.featureId)) {
                semanticFlows.push({ entry, handler: actionHandler, featureId: route.featureId, confidence: request.confidence });
              }
            }
            const uiNode = semanticNode({ kind: "step", filePath: entry.path, startByte: span.startByte, key: `ui:${tag}:${label}:${route.method}:${route.path}`, label, featureId: route.featureId,
              confidence: "proven", reason: "Komponen UI memiliki handler/aksi statis yang memanggil endpoint dengan method dan path yang cocok.", evidence: [span], technicalNodeIds: technicalNodesForSpan(ccmNodes, entry.path, span.startByte, span.endByte) });
            uiEventKinds.set(uiNode.id, `${tag}:${event ? jsxAttributeName(event.name) : "action"}`);
            fragment.nodes.push(uiNode);
            const actorEdge = addUiActor(fragment, route.featureId, uiNode, span);
            const requestEvidence = nodeRange(entry, request.node, "reference");
            const edge = makeEdge("ui-api", uiNode.id, route.stepId, `${request.method} ${request.path}`, request.confidence, request.confidence === "proven" ? "Pemanggilan HTTP statis pada handler UI cocok dengan deklarasi Next route." : "Prefix path dinamis secara statis cocok dengan pola route; nilai parameternya tidak disimpulkan.", requestEvidence);
            fragment.edges.push(edge);
            addFeatureMembers(fragment, route.featureId, [uiNode.id], [edge.id, actorEdge.id], [span, requestEvidence]);
          }
          if (isInteractive && functionCalls.length && !candidates.length && !linkPath && !navigations.length) {
            const isImportedHandler = functionCalls.some(name => imports.has(name));
            if (isImportedHandler) fragment.limitations.push({ filePath: entry.path, reason: `Aksi “${label}” memanggil handler dari modul lain yang belum dapat ditautkan ke alur statis.` });
          }
        }
      }
      ts.forEachChild(node, walk);
    };
    walk(entry.file);
  }
  for (const route of routes) {
    const feature = fragment.features.find(item => item.id === route.featureId);
    if (!feature) continue;
    const routeHasUi = fragment.edges.some(edge => edge.target === route.stepId && edge.label.startsWith(`${route.method} `));
    if (!routeHasUi && route.path.startsWith("/api/")) fragment.limitations.push({ filePath: route.entry.path, reason: `Endpoint ${route.method} ${route.path} ditemukan; tidak ada kontrol UI statis yang terhubung pada snapshot ini.` });
  }
  deduplicateEquivalentUiSteps(fragment, uiEventKinds);
  addDeclaredConcepts(fragment, entries, ccmNodes, semanticFlows);
  fragment.nodes = uniqueNodes(fragment.nodes);
  fragment.edges = uniqueEdges(fragment.edges);
  fragment.features = fragment.features.sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
  fragment.frameworks = [...new Set(fragment.frameworks)].sort();
  fragment.limitations = [...new Map(fragment.limitations.map(item => [`${item.filePath}\0${item.reason}`, item])).values()]
    .sort((a, b) => a.filePath.localeCompare(b.filePath) || a.reason.localeCompare(b.reason));
  return fragment;
}

function addFeatureMembers(fragment: SemanticFragment, featureId: string | null, nodeIds: string[], edgeIds: string[], evidence: EvidenceSpan[]): void {
  if (!featureId) return;
  const feature = fragment.features.find(item => item.id === featureId);
  if (!feature) return;
  feature.nodeIds = [...new Set([...feature.nodeIds, ...nodeIds])].sort();
  feature.edgeIds = [...new Set([...feature.edgeIds, ...edgeIds])].sort();
  feature.evidence = compactEvidence([...feature.evidence, ...evidence]);
}

function addUiActor(fragment: SemanticFragment, featureId: string, uiNode: SemanticNode, evidence: EvidenceSpan): SemanticEdge {
  const actorId = semanticId("actor", "", 0, "next-browser-user");
  const actor = fragment.nodes.find(node => node.id === actorId);
  if (!actor) {
    fragment.nodes.push({ id: actorId, kind: "actor", label: "Pengguna", featureId: null, confidence: "indicated", reason: "Kontrol halaman dapat dipicu pengguna, tetapi peran khusus tidak disimpulkan dari UI.", evidence: [evidence], technicalNodeIds: [] });
  } else actor.evidence = compactEvidence([...actor.evidence, evidence]);
  const edge = makeEdge("user-action", actorId, uiNode.id, "melakukan", "indicated", "Kontrol interaktif terlihat di halaman; identitas/peran aktor tidak dinyatakan oleh kontrol itu.", evidence);
  fragment.edges.push(edge);
  addFeatureMembers(fragment, featureId, [actorId, uiNode.id], [edge.id], [evidence]);
  return edge;
}

function matchRoute(routes: ApiRoute[], method: string, path: string): ApiRoute | null {
  const normalized = normalizeRoute(path);
  return routes.find(route => route.method === method.toUpperCase() && routeMatches(route.path, normalized)) ?? null;
}

function uniqueNodes(nodes: SemanticNode[]): SemanticNode[] { return [...new Map(nodes.map(node => [node.id, node])).values()].sort((a, b) => a.id.localeCompare(b.id)); }
function uniqueEdges(edges: SemanticEdge[]): SemanticEdge[] { return [...new Map(edges.map(edge => [edge.id, edge])).values()].sort((a, b) => a.id.localeCompare(b.id)); }

function deduplicateEquivalentUiSteps(fragment: SemanticFragment, eventKinds: ReadonlyMap<string, string>): void {
  const merge = (groups: Iterable<SemanticNode[]>) => {
    const redirects = new Map<string, string>();
    for (const nodes of groups) {
      if (nodes.length < 2) continue;
      nodes.sort((a, b) => a.id.localeCompare(b.id));
      const canonical = nodes[0]!;
      for (const duplicate of nodes.slice(1)) {
        if (duplicate.id === canonical.id) continue;
        redirects.set(duplicate.id, canonical.id);
        canonical.evidence = compactEvidence([...canonical.evidence, ...duplicate.evidence]);
        canonical.technicalNodeIds = [...new Set([...canonical.technicalNodeIds, ...duplicate.technicalNodeIds])].sort();
      }
    }
    if (!redirects.size) return;
    const edgeGroups = new Map<string, SemanticEdge>();
    for (const edge of fragment.edges) {
      const source = redirects.get(edge.source) ?? edge.source;
      const target = redirects.get(edge.target) ?? edge.target;
      const signature = JSON.stringify([source, target, edge.label, edge.confidence, edge.reason]);
      const current = edgeGroups.get(signature);
      if (!current) edgeGroups.set(signature, { ...edge, source, target, evidence: [...edge.evidence] });
      else current.evidence = compactEvidence([...current.evidence, ...edge.evidence]);
    }
    const edges = [...edgeGroups.values()];
    const edgeIds = new Set(edges.map(edge => edge.id));
    for (const feature of fragment.features) {
      feature.entryNodeIds = [...new Set(feature.entryNodeIds.map(id => redirects.get(id) ?? id))].sort();
      feature.nodeIds = [...new Set(feature.nodeIds.map(id => redirects.get(id) ?? id))].sort();
      feature.edgeIds = feature.edgeIds.filter(id => edgeIds.has(id)).sort();
    }
    fragment.nodes = fragment.nodes.filter(node => !redirects.has(node.id));
    fragment.edges = edges;
  };

  const uiSteps = fragment.nodes.filter(node => node.kind === "step" && node.featureId && eventKinds.has(node.id));
  const bySourceControl = new Map<string, SemanticNode[]>();
  for (const node of uiSteps) {
    const source = node.evidence.map(span => `${span.filePath}:${span.fileSha256}:${span.startByte}:${span.endByte}`).sort();
    const signature = JSON.stringify([node.featureId, node.label, node.confidence, eventKinds.get(node.id), source]);
    const group = bySourceControl.get(signature) ?? [];
    group.push(node);
    bySourceControl.set(signature, group);
  }
  merge(bySourceControl.values());

  const byEquivalentAction = new Map<string, SemanticNode[]>();
  for (const node of fragment.nodes) {
    if (node.kind !== "step" || !node.featureId || !eventKinds.has(node.id)) continue;
    const outgoing = fragment.edges.filter(edge => edge.source === node.id)
      .map(edge => [edge.target, edge.label, edge.confidence, edge.reason].join("\0")).sort();
    if (!outgoing.length) continue;
    const signature = JSON.stringify([node.featureId, node.label, node.confidence, node.reason, eventKinds.get(node.id), outgoing]);
    const group = byEquivalentAction.get(signature) ?? [];
    group.push(node);
    byEquivalentAction.set(signature, group);
  }
  merge(byEquivalentAction.values());
}

function conceptTokens(value: string): Set<string> {
  const ignored = new Set(["api", "app", "stage", "stages", "schema", "type", "result", "progress", "state", "data", "payload", "config", "option", "options", "dependency", "dependencies", "handler", "handlers", "reader", "writer", "context", "input", "output"]);
  return new Set(humanLabel(value).toLocaleLowerCase("en-US").split(/[^a-z0-9]+/u).filter(Boolean).map(token => {
    if (token === "analyses") return "analys";
    if (token.endsWith("sis")) return token.slice(0, -2);
    if (token.endsWith("ses")) return token.slice(0, -2);
    if (token.endsWith("ies")) return `${token.slice(0, -3)}y`;
    return token.endsWith("s") && !token.endsWith("ss") ? token.slice(0, -1) : token;
  }).filter(token => token.length > 2 && !ignored.has(token)));
}

function featureForConcept(fragment: SemanticFragment, label: string): SemanticFeature | null {
  const tokens = conceptTokens(label);
  if (!tokens.size) return null;
  const ranked = fragment.features.map(feature => ({ feature, score: [...tokens].filter(token => conceptTokens(feature.label).has(token)).length }))
    .filter(item => item.score > 0).sort((a, b) => b.score - a.score || a.feature.id.localeCompare(b.feature.id));
  return ranked.length && ranked[1]?.score !== ranked[0]!.score ? ranked[0]!.feature : null;
}

function addConceptNode(fragment: SemanticFragment, entry: SourceEntry, declaration: ts.Node, key: string, label: string, confidence: "proven" | "indicated", reason: string, ccmNodes: readonly CcmNode[], parent?: { node: SemanticNode; sequence?: number }): SemanticNode {
  const span = nodeRange(entry, declaration, "declaration");
  const concept = semanticNode({ kind: "concept", filePath: entry.path, startByte: span.startByte, key, label, confidence, reason, evidence: [span], technicalNodeIds: technicalNodesForSpan(ccmNodes, entry.path, span.startByte, span.endByte) });
  fragment.nodes.push(concept);
  if (parent) {
    concept.featureId = parent.node.featureId;
    const qualifier = parent.sequence === undefined ? "" : ` ${parent.sequence}`;
    const edge = makeEdge("catalog-concept", parent.node.id, concept.id, `mencakup tahap${qualifier}`, "proven", "Konsep tercantum secara eksplisit sebagai item pada definisi literal yang sama.", span);
    fragment.edges.push(edge);
    addFeatureMembers(fragment, concept.featureId, [concept.id], [edge.id], [span]);
  } else {
    const feature = featureForConcept(fragment, label);
    if (feature) {
      concept.featureId = feature.id;
      const edge = makeEdge("feature-concept", feature.id, concept.id, "mengelompokkan konsep", "indicated", "Label konsep berbagi istilah dengan label fitur; keanggotaan runtime tidak dinyatakan langsung.", span);
      fragment.edges.push(edge);
      addFeatureMembers(fragment, feature.id, [concept.id], [edge.id], [span]);
    }
  }
  return concept;
}

function membersForType(type: ts.TypeNode): readonly ts.TypeElement[] {
  if (ts.isTypeLiteralNode(type)) return type.members;
  if (ts.isIntersectionTypeNode(type)) return type.types.flatMap(membersForType);
  return [];
}

function schemaObject(expression: ts.Expression): ts.ObjectLiteralExpression | null {
  let current = unwrap(expression);
  while (ts.isCallExpression(current)) {
    const callee = unwrap(current.expression);
    if (ts.isPropertyAccessExpression(callee) && callee.name.text === "object" && current.arguments[0] && ts.isObjectLiteralExpression(unwrap(current.arguments[0]))) {
      return unwrap(current.arguments[0]) as ts.ObjectLiteralExpression;
    }
    current = unwrap(current.expression);
  }
  return null;
}

type ConceptDeclaration = { entry: SourceEntry; declaration: ts.Node; name: string; schema: boolean };

function typeShapeMembers(node: ts.Node): readonly ts.TypeElement[] | null {
  if (ts.isInterfaceDeclaration(node)) return node.members;
  if (ts.isTypeAliasDeclaration(node)) return membersForType(node.type);
  return null;
}

function hasDataShape(node: ts.Node): boolean {
  const members = typeShapeMembers(node);
  if (members) return members.filter(member => ts.isPropertySignature(member)).length >= 2;
  if (ts.isVariableDeclaration(node) && node.initializer) return (schemaObject(node.initializer)?.properties.length ?? 0) >= 2;
  return false;
}

function declarationByName(entry: SourceEntry, name: string, exportedOnly: boolean): ConceptDeclaration | null {
  if (name === "default") {
    for (const statement of entry.file.statements) {
      if ((ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) && hasModifier(statement, ts.SyntaxKind.DefaultKeyword) && hasDataShape(statement)) {
        return { entry, declaration: statement, name: statement.name.text, schema: false };
      }
    }
    const assignment = entry.file.statements.find((statement): statement is ts.ExportAssignment => ts.isExportAssignment(statement) && !statement.isExportEquals);
    if (assignment) {
      const expression = unwrap(assignment.expression);
      if (ts.isIdentifier(expression)) return declarationByName(entry, expression.text, false);
      if (ts.isCallExpression(expression) && schemaObject(expression) && schemaObject(expression)!.properties.length >= 2) {
        return { entry, declaration: assignment, name: "default", schema: true };
      }
    }
    return null;
  }
  for (const statement of entry.file.statements) {
    if (ts.isInterfaceDeclaration(statement) && statement.name.text === name && (!exportedOnly || hasModifier(statement, ts.SyntaxKind.ExportKeyword)) && hasDataShape(statement)) {
      return { entry, declaration: statement, name, schema: false };
    }
    if (ts.isTypeAliasDeclaration(statement) && statement.name.text === name && (!exportedOnly || hasModifier(statement, ts.SyntaxKind.ExportKeyword)) && hasDataShape(statement)) {
      return { entry, declaration: statement, name, schema: false };
    }
    if (!ts.isVariableStatement(statement) || (exportedOnly && !hasModifier(statement, ts.SyntaxKind.ExportKeyword))) continue;
    const declaration = statement.declarationList.declarations.find(item => ts.isIdentifier(item.name) && item.name.text === name);
    if (declaration && hasDataShape(declaration) && declaration.initializer && schemaObject(declaration.initializer)) {
      return { entry, declaration, name, schema: true };
    }
  }
  return null;
}

function resolveExportedConcept(entry: SourceEntry, exportedName: string, entries: Map<string, SourceEntry>, visited = new Set<string>()): ConceptDeclaration | null {
  const key = `${entry.path}\0${exportedName}`;
  if (visited.has(key)) return null;
  visited.add(key);
  const direct = declarationByName(entry, exportedName, true);
  if (direct) return direct;
  for (const statement of entry.file.statements) {
    if (!ts.isExportDeclaration(statement)) continue;
    const target = statement.moduleSpecifier && ts.isStringLiteralLike(statement.moduleSpecifier)
      ? relativeSource(entry, statement.moduleSpecifier.text, entries)
      : null;
    if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      const item = statement.exportClause.elements.find(element => element.name.text === exportedName);
      if (!item) continue;
      const originalName = item.propertyName?.text ?? item.name.text;
      if (target) {
        const resolved = resolveExportedConcept(target, originalName, entries, visited);
        if (resolved) return resolved;
      } else {
        const local = declarationByName(entry, originalName, false);
        if (local) return local;
      }
      continue;
    }
    if (target && !statement.exportClause) {
      const resolved = resolveExportedConcept(target, exportedName, entries, visited);
      if (resolved) return resolved;
    }
  }
  return null;
}

function referenceRootAndName(node: ts.EntityName): { root: string; name: string } {
  if (ts.isIdentifier(node)) return { root: node.text, name: node.text };
  let current: ts.EntityName = node;
  while (ts.isQualifiedName(current)) current = current.left;
  return { root: current.text, name: node.right.text };
}

function unresolvedProjectImport(entry: SourceEntry, localName: string, entries: Map<string, SourceEntry>): { moduleName: string; exportedName: string } | null {
  for (const statement of entry.file.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteralLike(statement.moduleSpecifier)) continue;
    const moduleName = statement.moduleSpecifier.text;
    const projectSpecifier = moduleName.startsWith(".") || /^(?:@\/|~\/|src\/|app\/)/u.test(moduleName);
    if (!projectSpecifier) continue;
    const clause = statement.importClause;
    if (!clause) continue;
    let exportedName: string | null = null;
    if (clause.name?.text === localName) exportedName = "default";
    if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings) && clause.namedBindings.name.text === localName) exportedName = "*";
    if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      const item = clause.namedBindings.elements.find(element => element.name.text === localName);
      if (item) exportedName = item.propertyName?.text ?? item.name.text;
    }
    if (exportedName && !relativeSource(entry, moduleName, entries)) return { moduleName, exportedName };
  }
  return null;
}

function resolveFlowType(entry: SourceEntry, reference: ts.TypeReferenceNode, entries: Map<string, SourceEntry>): { declaration: ConceptDeclaration; referenceName: ts.Node } | { unresolved: string; referenceName: ts.Node } | null {
  const { root, name } = referenceRootAndName(reference.typeName);
  const localImport = importedBinding(entry, root, entries);
  if (localImport) {
    const exportedName = localImport.exportedName === "*" ? name : localImport.exportedName;
    const declaration = resolveExportedConcept(localImport.entry, exportedName, entries);
    if (declaration) return { declaration, referenceName: reference.typeName };
    return { unresolved: `impor relatif ${root} dari ${localImport.entry.path} tidak memiliki deklarasi object shape yang dapat dibaca`, referenceName: reference.typeName };
  }
  const local = declarationByName(entry, name, false);
  if (local) return { declaration: local, referenceName: reference.typeName };
  const unresolved = unresolvedProjectImport(entry, root, entries);
  if (unresolved) {
    const sourceKind = unresolved.moduleName.startsWith(".") ? "impor relatif" : "alias source";
    return { unresolved: `${sourceKind} ${unresolved.exportedName} dari ${unresolved.moduleName} tidak tersedia atau tidak dapat diselesaikan`, referenceName: reference.typeName };
  }
  return null;
}

function resolveFlowSchema(entry: SourceEntry, identifier: ts.Identifier, entries: Map<string, SourceEntry>): ConceptDeclaration | null {
  const imported = importedBinding(entry, identifier.text, entries);
  if (imported) return resolveExportedConcept(imported.entry, imported.exportedName, entries);
  const local = declarationByName(entry, identifier.text, false);
  return local?.schema ? local : null;
}

function isRuntimeIdentifierReference(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
  if ((ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent) || ts.isPropertyDeclaration(parent) || ts.isPropertySignature(parent)) && parent.name === node) return false;
  if ((ts.isFunctionDeclaration(parent) || ts.isFunctionExpression(parent) || ts.isClassDeclaration(parent) || ts.isClassExpression(parent) || ts.isInterfaceDeclaration(parent) || ts.isTypeAliasDeclaration(parent)) && parent.name === node) return false;
  if (ts.isVariableDeclaration(parent) && parent.name === node) return false;
  if (ts.isParameter(parent) && parent.name === node) return false;
  if (ts.isImportSpecifier(parent) || ts.isNamespaceImport(parent) || ts.isImportClause(parent)) return false;
  if (ts.isTypeReferenceNode(parent) || ts.isTypeQueryNode(parent)) return false;
  return true;
}

function addFlowConceptUse(fragment: SemanticFragment, scope: SemanticFlowScope, declaration: ConceptDeclaration, reference: ts.Node, ccmNodes: readonly CcmNode[], conceptFeatures: Map<string, Set<string>>): void {
  const declarationSpan = nodeRange(declaration.entry, declaration.declaration, "declaration");
  const label = declaration.name.replace(/(?:Schema|Definition|Definitions|Catalog)$/iu, "");
  const confidence = declaration.schema || scope.confidence === "indicated" ? "indicated" : "proven";
  const reason = declaration.schema
    ? "Referensi pada alur utama cocok dengan object schema berisi field literal; library pembentuk schema belum diverifikasi."
    : "Tipe berbentuk data dirujuk langsung dari signature atau handler/page yang terhubung ke alur utama.";
  let concept = fragment.nodes.find(node => node.kind === "concept" && node.evidence.some(span => span.filePath === declaration.entry.path && span.startByte === declarationSpan.startByte));
  if (!concept) {
    concept = semanticNode({ kind: "concept", filePath: declaration.entry.path, startByte: declarationSpan.startByte,
      key: `flow-contract:${declaration.schema ? "schema" : "type"}:${declaration.name}`, label, confidence, reason,
      evidence: [declarationSpan], technicalNodeIds: technicalNodesForSpan(ccmNodes, declaration.entry.path, declarationSpan.startByte, declarationSpan.endByte) });
    fragment.nodes.push(concept);
  } else if (concept.confidence === "indicated" && confidence === "proven") {
    concept.confidence = "proven";
    concept.reason = reason;
  }
  const featureIds = conceptFeatures.get(concept.id) ?? new Set<string>();
  featureIds.add(scope.featureId);
  conceptFeatures.set(concept.id, featureIds);
  concept.featureId = featureIds.size === 1 ? scope.featureId : null;
  const useSpan = nodeRange(scope.entry, reference, "reference");
  const edge = makeEdge("flow-concept", scope.featureId, concept.id, "mengelompokkan konsep terkait", "indicated",
    "Referensi statis menghubungkan deklarasi ke alur ini; pengelompokan sebagai konsep fitur tetap merupakan interpretasi model.", useSpan);
  fragment.edges.push(edge);
  addFeatureMembers(fragment, scope.featureId, [concept.id], [edge.id], [useSpan, declarationSpan]);
}

function addUnresolvedFlowConcept(fragment: SemanticFragment, scope: SemanticFlowScope, label: string, reason: string, reference: ts.Node): void {
  const span = nodeRange(scope.entry, reference, "reference");
  const concept = semanticNode({ kind: "concept", filePath: scope.entry.path, startByte: span.startByte,
    key: `unresolved-flow-contract:${label}`, label, featureId: scope.featureId, confidence: "indicated",
    reason: `Nama kontrak dipakai oleh alur utama, tetapi deklarasinya tidak dapat dibaca: ${reason}.`, evidence: [span] });
  fragment.nodes.push(concept);
  const edge = makeEdge("flow-concept", scope.featureId, concept.id, "merujuk kontrak", "indicated", concept.reason, span);
  fragment.edges.push(edge);
  addFeatureMembers(fragment, scope.featureId, [concept.id], [edge.id], [span]);
  fragment.limitations.push({ filePath: scope.entry.path, reason: `Kontrak “${label}” terkait alur utama, tetapi deklarasi source tidak tersedia untuk verifikasi: ${reason}.` });
}

function addReferencedContracts(fragment: SemanticFragment, scopes: readonly SemanticFlowScope[], entries: readonly SourceEntry[], ccmNodes: readonly CcmNode[]): void {
  const entriesByPath = new Map(entries.map(entry => [entry.path, entry]));
  const uniqueScopes = new Map<string, SemanticFlowScope>();
  for (const scope of scopes) uniqueScopes.set(`${scope.entry.path}\0${scope.handler.pos}:${scope.handler.end}\0${scope.featureId}`, scope);
  const conceptFeatures = new Map<string, Set<string>>();
  const unresolvedSeen = new Set<string>();
  for (const scope of uniqueScopes.values()) {
    const typeReferences = new Set<ts.TypeReferenceNode>();
    const addTypeRefs = (root: ts.Node) => {
      const visit = (node: ts.Node) => {
        if (ts.isTypeReferenceNode(node)) typeReferences.add(node);
        ts.forEachChild(node, visit);
      };
      visit(root);
    };
    for (const parameter of scope.handler.parameters) addTypeRefs(parameter);
    if (scope.handler.type) addTypeRefs(scope.handler.type);
    if (scope.handler.body) visitHandlerFlow(scope.handler.body, scope.confidence, node => {
      if (ts.isTypeReferenceNode(node)) typeReferences.add(node);
    });
    for (const reference of typeReferences) {
      const resolved = resolveFlowType(scope.entry, reference, entriesByPath);
      if (!resolved) continue;
      if ("declaration" in resolved) addFlowConceptUse(fragment, scope, resolved.declaration, resolved.referenceName, ccmNodes, conceptFeatures);
      else {
        const { root, name } = referenceRootAndName(reference.typeName);
        const dedupe = `${scope.entry.path}\0${scope.featureId}\0${name}\0${resolved.unresolved}`;
        if (!unresolvedSeen.has(dedupe)) {
          unresolvedSeen.add(dedupe);
          addUnresolvedFlowConcept(fragment, scope, name, resolved.unresolved, resolved.referenceName);
        }
        void root;
      }
    }
    if (!scope.handler.body) continue;
    visitHandlerFlow(scope.handler.body, scope.confidence, (node, flowConfidence) => {
      if (!ts.isIdentifier(node) || !isRuntimeIdentifierReference(node)) return;
      const declaration = resolveFlowSchema(scope.entry, node, entriesByPath);
      if (!declaration?.schema) return;
      addFlowConceptUse(fragment, { ...scope, confidence: flowConfidence }, declaration, node, ccmNodes, conceptFeatures);
    });
  }
}

function addDeclaredConcepts(fragment: SemanticFragment, entries: readonly SourceEntry[], ccmNodes: readonly CcmNode[], scopes: readonly SemanticFlowScope[]): void {
  addReferencedContracts(fragment, scopes, entries, ccmNodes);
  for (const entry of entries) {
    for (const statement of entry.file.statements) {
      if (!ts.isVariableStatement(statement) || !hasModifier(statement, ts.SyntaxKind.ExportKeyword)) continue;
      for (const declaration of statement.declarationList.declarations) {
        if (!declaration.initializer || !ts.isIdentifier(declaration.name)) continue;
        const name = declaration.name.text;
        const initializer = unwrap(declaration.initializer);
        if (!/DEFINITIONS$/u.test(name) || !ts.isArrayLiteralExpression(initializer) || initializer.elements.length < 2) continue;
        const rows = initializer.elements.filter(ts.isObjectLiteralExpression);
        if (rows.length !== initializer.elements.length) continue;
        const label = name.replace(/_?DEFINITIONS$/u, "").toLocaleLowerCase("en-US");
        const catalog = addConceptNode(fragment, entry, declaration, `catalog:${name}`, label, "proven", "Array ekspor berisi definisi objek literal yang mendeklarasikan item domain.", ccmNodes);
        for (const [index, row] of rows.entries()) {
          const labelProperty = row.properties.find(property => ts.isPropertyAssignment(property) && propertyName(property.name) === "label");
          const keyProperty = row.properties.find(property => ts.isPropertyAssignment(property) && propertyName(property.name) === "key");
          if (!labelProperty || !ts.isPropertyAssignment(labelProperty) || !keyProperty || !ts.isPropertyAssignment(keyProperty)) continue;
          const rowLabel = literalText(labelProperty.initializer), rowKey = literalText(keyProperty.initializer);
          if (!rowLabel || !rowKey) continue;
          const sequenceProperty = row.properties.find(property => ts.isPropertyAssignment(property) && propertyName(property.name) === "sequence");
          const sequence = sequenceProperty && ts.isPropertyAssignment(sequenceProperty) && ts.isNumericLiteral(sequenceProperty.initializer) ? Number(sequenceProperty.initializer.text) : index + 1;
          addConceptNode(fragment, entry, row, `catalog-item:${name}:${rowKey}`, rowLabel, "proven", "Item dan label literal dideklarasikan dalam katalog ekspor.", ccmNodes, { node: catalog, sequence });
        }
      }
    }
  }
}

function addGuards(fragment: SemanticFragment, input: SemanticInput, entry: SourceEntry, handler: ts.FunctionLikeDeclaration, endpointId: string, featureId: string, nodeIds: string[], edgeIds: string[], confidence: "proven" | "indicated"): void {
  if (!handler.body) return;
  visitHandlerFlow(handler.body, confidence, (node, currentConfidence) => {
    if (!ts.isIfStatement(node)) return;
    const raw = node.expression.getText(entry.file);
    const category = guardCategory(raw);
    const branches = [
      { statement: node.thenStatement, condition: "gagal jika kondisi terpenuhi" },
      { statement: node.elseStatement, condition: "gagal jika kondisi tidak terpenuhi" },
    ].filter((branch): branch is { statement: ts.Statement; condition: string } => branch.statement !== undefined);
    const failures = branches.flatMap(branch => directReturnStatements(branch.statement)
      .map(statement => ({ branch, statement, status: responseStatus(entry, statement) }))
      .filter((item): item is { branch: typeof branch; statement: ts.ReturnStatement; status: number } => item.status !== null && item.status >= 400));
    if (!category && failures.length === 0) return;

    const decisionSpan = nodeRange(entry, node.expression, "context");
    const reason = category
      ? currentConfidence === "proven" ? category.reason : `${category.reason} Callback atau pemanggilan wrapper belum sepenuhnya terverifikasi.`
      : `Kondisi if langsung diikuti respons HTTP gagal yang terverifikasi; ekspresi dipertahankan tanpa menebak jenis autentikasi, validasi, atau aturan bisnis.`;
    const decision = semanticNode({ kind: "decision", filePath: entry.path, startByte: decisionSpan.startByte, key: `guard:${endpointId}:${decisionSpan.startByte}:${raw}`,
      label: category?.label ?? "Pemeriksaan kondisi", featureId, confidence: currentConfidence, reason, evidence: [decisionSpan],
      technicalNodeIds: technicalNodesForSpan(input.ccm.nodes, entry.path, decisionSpan.startByte, decisionSpan.endByte) });
    fragment.nodes.push(decision); nodeIds.push(decision.id);
    const edge = makeEdge("guard", endpointId, decision.id, "memeriksa", currentConfidence, decision.reason, decisionSpan);
    fragment.edges.push(edge); edgeIds.push(edge.id);
    const memberNodes = [decision.id];
    const memberEdges = [edge.id];
    const memberEvidence = [decisionSpan];
    for (const failure of failures) {
      const resultSpan = nodeRange(entry, failure.statement, "context");
      const message = literalHttpFailureMessage(failure.statement);
      const suffix = message ? `: ${humanLabel(message)}` : "";
      const outcomeReason = currentConfidence === "proven"
        ? "Cabang mengembalikan respons HTTP dengan status kegagalan eksplisit."
        : "Status HTTP kegagalan tertulis pada cabang callback, tetapi perilaku pemanggil atau wrapper belum sepenuhnya terverifikasi.";
      const outcome = semanticNode({ kind: "outcome", filePath: entry.path, startByte: resultSpan.startByte, key: `guard-response:${endpointId}:${failure.status}:${resultSpan.startByte}`,
        label: `Permintaan ditolak (${failure.status})${suffix}`, featureId, confidence: currentConfidence, reason: outcomeReason, evidence: [resultSpan] });
      fragment.nodes.push(outcome); nodeIds.push(outcome.id);
      const resultEdge = makeEdge("guard-outcome", decision.id, outcome.id, failure.branch.condition, currentConfidence, outcome.reason, resultSpan);
      fragment.edges.push(resultEdge); edgeIds.push(resultEdge.id);
      memberNodes.push(outcome.id); memberEdges.push(resultEdge.id); memberEvidence.push(resultSpan);
    }
    addFeatureMembers(fragment, featureId, memberNodes, memberEdges, memberEvidence);
  });
}

function transactionCallbacks(handler: ts.FunctionLikeDeclaration, confidence: "proven" | "indicated"): Map<ts.FunctionLikeDeclaration, TransactionCallback> {
  const callbacks = new Map<ts.FunctionLikeDeclaration, TransactionCallback>();
  if (!handler.body) return callbacks;
  visitHandlerFlow(handler.body, confidence, node => {
    if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(unwrap(node.expression)) || (unwrap(node.expression) as ts.PropertyAccessExpression).name.text !== "$transaction") return;
    const callback = node.arguments[0] && unwrap(node.arguments[0]);
    if (!(callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)))) return;
    const parameter = callback.parameters[0];
    if (parameter && ts.isIdentifier(parameter.name)) callbacks.set(callback, { handler: callback, parameter, call: node });
  });
  return callbacks;
}

function transactionForReference(entry: SourceEntry, node: ts.Node, receiverName: string, transactions: ReadonlyMap<ts.FunctionLikeDeclaration, TransactionCallback>): TransactionCallback | null {
  const nearestBinding = [...lexicalScopes(entry, node)].reverse().find(scope => directlyDeclaredBindings(scope).has(receiverName));
  if (!nearestBinding || !isCallableBoundary(nearestBinding)) return null;
  const callback = transactions.get(nearestBinding as ts.FunctionLikeDeclaration);
  return callback && ts.isIdentifier(callback.parameter.name) && callback.parameter.name.text === receiverName ? callback : null;
}

function addStores(fragment: SemanticFragment, input: SemanticInput, entry: SourceEntry, handler: ts.FunctionLikeDeclaration, componentId: string, featureId: string, nodeIds: string[], edgeIds: string[], confidence: "proven" | "indicated"): void {
  if (!handler.body) return;
  const transactions = transactionCallbacks(handler, confidence);
  visitHandlerFlow(handler.body, confidence, (node, currentConfidence) => {
    if (ts.isCallExpression(node)) {
      const expression = unwrap(node.expression);
      if (ts.isPropertyAccessExpression(expression)) {
        const method = expression.name.text;
        const segments: string[] = [];
        let current: ts.Expression = expression.expression;
        while (ts.isPropertyAccessExpression(current)) { segments.unshift(current.name.text); current = current.expression; }
        if (ts.isIdentifier(current)) segments.unshift(current.text);
        let table: string | null = null;
        let operation = method;
        let operationConfidence = currentConfidence;
        let operationReason = "ORM/query client call menyebut entity atau tabel secara literal.";
        let transaction: TransactionCallback | null = null;
        if (segments.length >= 2 && /^(find|create|update|delete|upsert|count|aggregate)/u.test(method)) transaction = transactionForReference(entry, node, segments[0]!, transactions);
        if (transaction) {
          table = segments[1]!;
          operationConfidence = "indicated";
          operationReason = `Operasi ${method} memakai parameter ${segments[0]} dari callback literal $transaction; hubungan transaksi terlihat, tetapi binding client/ORM tidak diverifikasi.`;
        } else if (["prisma", "db", "database", "client"].includes(segments[0] ?? "") && segments.length >= 2 && /^(find|create|update|delete|upsert|count|aggregate)/u.test(method)) {
          table = segments[1]!;
          operationConfidence = currentConfidence === "proven" ? "indicated" : currentConfidence;
          operationReason = `Pemanggilan ${method} pada pola receiver ${segments[0]} menyebut entity secara literal, tetapi binding receiver belum diverifikasi sebagai ORM.`;
        }
        if (segments[0] === "supabase" && method === "from" && node.arguments[0]) {
          const terminal = supabaseTerminalOperation(node);
          const literalTable = literalText(node.arguments[0]);
          if (terminal && literalTable) {
            table = literalTable;
            operation = terminal;
            operationConfidence = currentConfidence === "proven" ? "indicated" : currentConfidence;
            operationReason = `Fluent query ${terminal} mengikuti .from() dengan nama tabel literal; binding client supabase belum diverifikasi melalui tipe.`;
          }
        }
        if (table && !/^(raw|query|execute)$/iu.test(table)) {
          const span = nodeRange(entry, node, "reference");
          const store = semanticNode({ kind: "store", filePath: entry.path, startByte: span.startByte, key: `store:${table}`, label: humanLabel(table), featureId,
            confidence: operationConfidence, reason: operationConfidence === "proven" ? operationReason : `${operationReason} Eksekusi operasi belum sepenuhnya terverifikasi.`, evidence: [span], technicalNodeIds: technicalNodesForSpan(input.ccm.nodes, entry.path, span.startByte, span.endByte) });
          fragment.nodes.push(store); nodeIds.push(store.id);
          const label = /^(find|count|aggregate|select|single|maybeSingle)/u.test(operation) ? "membaca" : /^(delete)/u.test(operation) ? "menghapus" : /^(update)/u.test(operation) ? "mengubah" : "menyimpan";
          const edge = makeEdge("data-access", componentId, store.id, label, operationConfidence, store.reason, span);
          if (transaction) {
            const callSpan = nodeRange(entry, transaction.call.expression, "reference");
            const callbackSpan = nodeRange(entry, transaction.parameter, "declaration");
            store.evidence = [...store.evidence, callSpan, callbackSpan].sort((a, b) => a.startByte - b.startByte);
            edge.evidence = [...edge.evidence, callSpan, callbackSpan].sort((a, b) => a.startByte - b.startByte);
          }
          fragment.edges.push(edge); edgeIds.push(edge.id); addFeatureMembers(fragment, featureId, [store.id], [edge.id], [span]);
        }
      }
    }
  });
}

function supabaseTerminalOperation(fromCall: ts.CallExpression): string | null {
  const access = fromCall.parent;
  if (!ts.isPropertyAccessExpression(access) || access.expression !== fromCall || !ts.isCallExpression(access.parent) || access.parent.expression !== access) return null;
  const method = access.name.text;
  return ["select", "insert", "upsert", "update", "delete", "single", "maybeSingle"].includes(method) ? method : null;
}

function literalErrorProperty(value: ts.Expression | undefined): string | null {
  if (!value || !ts.isObjectLiteralExpression(unwrap(value))) return null;
  const object = unwrap(value) as ts.ObjectLiteralExpression;
  for (const name of ["error", "message"]) {
    const property = object.properties.find(item => (ts.isPropertyAssignment(item) || ts.isShorthandPropertyAssignment(item)) && propertyName(item.name) === name);
    if (property && ts.isPropertyAssignment(property)) {
      const initializer = unwrap(property.initializer);
      const message = literalText(initializer) ?? (ts.isTemplateExpression(initializer)
        ? [initializer.head.text, ...initializer.templateSpans.flatMap(span => ["…", span.literal.text])].join("")
        : null);
      if (message?.trim()) return message.trim().slice(0, 120);
    }
  }
  return null;
}

function literalBusinessFailure(statement: ts.ReturnStatement): string | null {
  return literalErrorProperty(statement.expression);
}

function literalHttpFailureMessage(statement: ts.ReturnStatement): string | null {
  const expression = statement.expression && unwrap(statement.expression);
  return expression && ts.isCallExpression(expression) ? literalErrorProperty(expression.arguments[0]) : null;
}

function addResponseOutcome(fragment: SemanticFragment, entry: SourceEntry, handler: ts.FunctionLikeDeclaration, endpointId: string, featureId: string, nodeIds: string[], edgeIds: string[], confidence: "proven" | "indicated"): void {
  if (!handler.body) return;
  visitHandlerFlow(handler.body, confidence, (statement, currentConfidence) => {
    if (!ts.isReturnStatement(statement)) return;
    const businessFailure = literalBusinessFailure(statement);
    if (businessFailure) {
      const span = nodeRange(entry, statement, "context");
      const reason = "Objek return berisi pesan error literal; kegagalan bisnis ditampilkan sebagai indikasi dan field status payload bukan status HTTP.";
      const outcome = semanticNode({ kind: "outcome", filePath: entry.path, startByte: span.startByte, key: `business-failure:${endpointId}:${span.startByte}`,
        label: `Gagal: ${humanLabel(businessFailure)}`, featureId, confidence: "indicated", reason, evidence: [span] });
      fragment.nodes.push(outcome); nodeIds.push(outcome.id);
      const edge = makeEdge("business-failure", endpointId, outcome.id, "gagal dengan", "indicated", reason, span);
      fragment.edges.push(edge); edgeIds.push(edge.id); addFeatureMembers(fragment, featureId, [outcome.id], [edge.id], [span]);
      return;
    }
    if (!isHttpResponseReturn(entry, statement)) {
      if (responseConstructorName(statement) && /^(?:Response|NextResponse)$/u.test(responseConstructorName(statement)!)) {
        fragment.limitations.push({ filePath: entry.path, reason: `Return memakai nama ${responseConstructorName(statement)}, tetapi binding-nya tidak dapat diverifikasi sebagai Web Response.` });
      }
      return;
    }
    const status = responseStatus(entry, statement);
    if (status !== null && status >= 400) return;
    const span = nodeRange(entry, statement, "context");
    const responseConfidence = currentConfidence === "proven" && status ? "proven" : "indicated";
    const outcome = semanticNode({ kind: "outcome", filePath: entry.path, startByte: span.startByte, key: `response:${endpointId}:${span.startByte}`, label: status ? `Respons selesai (${status})` : "Respons dikirim",
      featureId, confidence: responseConfidence, reason: responseConfidence === "proven" ? "Status HTTP tertulis pada response." : "Return response terlihat; status atau perilaku wrapper belum dipastikan.", evidence: [span] });
    fragment.nodes.push(outcome); nodeIds.push(outcome.id);
    const edge = makeEdge("endpoint-response", endpointId, outcome.id, "menghasilkan", outcome.confidence, outcome.reason, span);
    fragment.edges.push(edge); edgeIds.push(edge.id); addFeatureMembers(fragment, featureId, [outcome.id], [edge.id], [span]);
  });
}
