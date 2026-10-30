import ts from "typescript";
import type { CcmNode, EvidenceSpan } from "@sage/contracts";
import type { SemanticEdge, SemanticFeature, SemanticFragment, SemanticInput, SemanticNode } from "./model.ts";
import { compactEvidence, emptyFragment, ensureFeatureNode, evidenceSpan, excludeFromMainFlow, humanLabel, semanticEdgeId, semanticId, semanticNode, technicalNodesForSpan } from "./builder.ts";

type SourceEntry = { path: string; bytes: Uint8Array; text: string; file: ts.SourceFile };
type ApiRoute = { path: string; method: string; entry: SourceEntry; declaration: ts.Node; handlerEntry: SourceEntry; handler: ts.FunctionLikeDeclaration | null; handlerConfidence: "proven" | "indicated"; featureId: string; featureLabel: string; stepId: string; componentId: string };
type StaticRequest = { method: string; path: string; node: ts.Node; confidence: "proven" | "indicated" };
type StaticNavigation = { path: string; node: ts.Node; confidence: "proven" | "indicated" };
type EndpointExport = { method: string; handler: ts.FunctionLikeDeclaration | null; declaration: ts.Node; confidence: "proven" | "indicated"; handlerLabel: string };
type SemanticFlowScope = { entry: SourceEntry; handler: ts.FunctionLikeDeclaration; featureId: string; confidence: "proven" | "indicated" };
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

function responseStatus(node: ts.Node): number | null {
  const inspect = (statement: ts.ReturnStatement): number | null => {
    const response = statement.expression;
    if (!response) return null;
    let options: ts.Expression | undefined;
    if (ts.isCallExpression(response)) {
      const callee = unwrap(response.expression);
      const method = ts.isPropertyAccessExpression(callee) && /(?:^|\.)(?:Next)?Response$/u.test(callee.expression.getText()) ? callee.name.text : null;
      if (method === "redirect" && response.arguments[1] && ts.isNumericLiteral(response.arguments[1])) {
        const status = Number(response.arguments[1].text);
        return status >= 100 && status <= 599 ? status : null;
      }
      if (method === "json" || method === "redirect") options = response.arguments[1];
    } else if (ts.isNewExpression(response) && /^(?:Next)?Response$/u.test(response.expression.getText())) options = response.arguments?.[1];
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

function containsReturn(node: ts.Node, root = node): boolean {
  if (ts.isReturnStatement(node)) return true;
  let result = false;
  ts.forEachChild(node, child => {
    if (result) return;
    if (child !== root && isCallableBoundary(child)) return;
    result = containsReturn(child, root);
  });
  return result;
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

function isHttpResponseReturn(statement: ts.ReturnStatement): boolean {
  const expression = statement.expression && unwrap(statement.expression);
  if (!expression) return false;
  if (ts.isNewExpression(expression)) return /^(?:Next)?Response$/u.test(expression.expression.getText());
  if (!ts.isCallExpression(expression) || !ts.isPropertyAccessExpression(unwrap(expression.expression))) return false;
  const callee = unwrap(expression.expression) as ts.PropertyAccessExpression;
  return /(?:^|\.)(?:Next)?Response$/u.test(callee.expression.getText()) && ["json", "redirect"].includes(callee.name.text);
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

function functionMap(entry: SourceEntry): Map<string, ts.FunctionLikeDeclaration> {
  const result = new Map<string, ts.FunctionLikeDeclaration>();
  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name) result.set(node.name.text, node);
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const value = unwrap(node.initializer);
      if (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) result.set(node.name.text, value);
    }
    if (ts.isMethodDeclaration(node)) {
      const name = propertyName(node.name);
      if (name) result.set(name, node);
    }
    ts.forEachChild(node, visit);
  };
  visit(entry.file);
  return result;
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

function normalizeSourcePath(path: string): string {
  const parts: string[] = [];
  for (const part of path.replaceAll("\\", "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop(); else parts.push(part);
  }
  return parts.join("/");
}

function relativeSource(entry: SourceEntry, specifier: string, entries: Map<string, SourceEntry>): SourceEntry | null {
  if (!specifier.startsWith(".")) return null;
  const slash = entry.path.lastIndexOf("/");
  const directory = slash < 0 ? "" : entry.path.slice(0, slash + 1);
  const base = normalizeSourcePath(`${directory}${specifier}`);
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
  const member = returned[0]!.properties.find(item => propertyName(item.name) === propertyNameExpected);
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

function resolveDelegatedProperty(entry: SourceEntry, expression: ts.Expression, entriesByPath: Map<string, SourceEntry>): { entry: SourceEntry; handler: ts.FunctionLikeDeclaration } | null {
  const path: string[] = [];
  let root: ts.Expression = unwrap(expression);
  while (ts.isPropertyAccessExpression(root)) { path.unshift(root.name.text); root = unwrap(root.expression); }
  if (!ts.isIdentifier(root) || !path.length) return null;
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
  const handler = returnedObjectMethod(factory.fn, property);
  return handler ? { entry: factory.entry, handler } : null;
}

function unwrapAwait(expression: ts.Expression): ts.Expression {
  let value = unwrap(expression);
  while (ts.isAwaitExpression(value)) value = unwrap(value.expression);
  return value;
}

/** Follow a route adapter only when its single return directly invokes a statically resolved handler. */
function resolveReturnedDelegate(entry: SourceEntry, handler: ts.FunctionLikeDeclaration, entriesByPath: Map<string, SourceEntry>): { entry: SourceEntry; handler: ts.FunctionLikeDeclaration } | null {
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

function requestWrapperParameters(functions: Map<string, ts.FunctionLikeDeclaration>): Map<string, number> {
  const result = new Map<string, number>();
  for (const [name, fn] of functions) {
    if (!fn.body) continue;
    const first = fn.parameters[0]?.name;
    if (!first || !ts.isIdentifier(first)) continue;
    let wraps = false;
    visitExecutable(fn.body, node => {
      if (ts.isCallExpression(node) && ts.isIdentifier(unwrap(node.expression)) && (unwrap(node.expression) as ts.Identifier).text === "fetch" && node.arguments[0] && ts.isIdentifier(node.arguments[0]) && node.arguments[0].text === first.text) wraps = true;
    });
    if (wraps) result.set(name, 0);
  }
  return result;
}

function findRequests(fn: ts.FunctionLikeDeclaration, entry: SourceEntry, functions: Map<string, ts.FunctionLikeDeclaration>, wrappers: Map<string, number>, visited = new Set<ts.Node>(), depth = 0): StaticRequest[] {
  if (!fn.body || visited.has(fn) || depth > 3) return [];
  visited.add(fn);
  const output: StaticRequest[] = [];
  const visit = (node: ts.Node) => {
    if (node !== fn && isCallableBoundary(node)) return;
    if (ts.isCallExpression(node)) {
      const callee = unwrap(node.expression);
      if (ts.isIdentifier(callee) && callee.text === "fetch") {
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
        output.push(...findRequests(functions.get(callee.text)!, entry, functions, wrappers, visited, depth + 1));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(fn.body);
  return output;
}

function findNavigations(fn: ts.FunctionLikeDeclaration, functions: Map<string, ts.FunctionLikeDeclaration>, visited = new Set<ts.Node>(), depth = 0): StaticNavigation[] {
  if (!fn.body || visited.has(fn) || depth > 3) return [];
  visited.add(fn);
  const output: StaticNavigation[] = [];
  visitExecutable(fn.body, node => {
    if (!ts.isCallExpression(node)) return;
    const expression = unwrap(node.expression);
    if (ts.isPropertyAccessExpression(expression) && ["push", "replace"].includes(expression.name.text) && /(?:^|\.)router$/iu.test(expression.expression.getText())) {
      const route = routeFromExpression(node.arguments[0]);
      output.push({ path: route.path ? normalizePath(route.path) : "", node, confidence: route.confidence });
      return;
    }
    if (ts.isIdentifier(expression) && functions.has(expression.text)) output.push(...findNavigations(functions.get(expression.text)!, functions, visited, depth + 1));
  });
  return output;
}

function findInlineNavigations(expression: ts.Expression, functions: Map<string, ts.FunctionLikeDeclaration>): StaticNavigation[] {
  if (ts.isIdentifier(expression) && functions.has(expression.text)) return findNavigations(functions.get(expression.text)!, functions);
  if (!(ts.isArrowFunction(expression) || ts.isFunctionExpression(expression))) return [];
  const output: StaticNavigation[] = [];
  visitExecutable(expression, node => {
    if (!ts.isCallExpression(node)) return;
    const callee = unwrap(node.expression);
    if (ts.isPropertyAccessExpression(callee) && ["push", "replace"].includes(callee.name.text) && /(?:^|\.)router$/iu.test(callee.expression.getText())) {
      const route = routeFromExpression(node.arguments[0]);
      output.push({ path: route.path ? normalizePath(route.path) : "", node, confidence: route.confidence });
    } else if (ts.isIdentifier(callee) && functions.has(callee.text)) output.push(...findNavigations(functions.get(callee.text)!, functions));
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
  if (ts.isIdentifier(expression)) return functionMap(entry).get(expression.text) ?? null;
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
      if (pageHandler) semanticFlows.push({ entry, handler: pageHandler, featureId: family.id, confidence: "proven" });
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
      const handler = delegated?.handler ?? exported.handler ?? null;
      const handlerEntry = delegated?.entry ?? entry;
      const handlerConfidence = delegated ? "proven" : exported.confidence;
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
  for (const entry of entries) {
    const functions = functionMap(entry);
    const imports = importedNames(entry.file);
    const wrappers = requestWrapperParameters(functions);
    const apiCalls = new Map<string, StaticRequest[]>();
    const navigationCalls = new Map<string, StaticNavigation[]>();
    for (const [name, fn] of functions) {
      apiCalls.set(name, findRequests(fn, entry, functions, wrappers));
      navigationCalls.set(name, findNavigations(fn, functions));
    }
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
          const inlineRequest = event?.initializer && ts.isJsxExpression(event.initializer) && event.initializer.expression &&
            (ts.isArrowFunction(event.initializer.expression) || ts.isFunctionExpression(event.initializer.expression))
            ? findRequests(event.initializer.expression, entry, functions, wrappers) : [];
          const requests = [...functionCalls.flatMap(name => apiCalls.get(name) ?? []), ...inlineRequest];
          const navigations = [...new Set([
            ...functionCalls.flatMap(name => navigationCalls.get(name) ?? []),
            ...(event?.initializer && ts.isJsxExpression(event.initializer) && event.initializer.expression ? findInlineNavigations(event.initializer.expression, functions) : []),
          ].map(navigation => navigation))];
          if (dynamicHref) fragment.limitations.push({ filePath: entry.path, reason: `Tautan “${label}” memakai href yang tidak cocok dengan path statis yang dapat dipetakan.` });
          const candidates = requests.map(request => ({ request, route: matchRoute(routes, request.method, request.path) })).filter((item): item is { request: StaticRequest; route: ApiRoute } => item.route !== null);
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
            if (!navigation.path) fragment.limitations.push({ filePath: entry.path, reason: `Aksi “${label}” memiliki tujuan router dinamis yang tidak dapat dipetakan secara statis.` });
            else pageDestinations.push({ path: navigation.path, evidence: nodeRange(entry, navigation.node, "reference"), reason: "router.push/replace memakai path statis atau berpola yang cocok dengan route halaman.", confidence: navigation.confidence });
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
              const actionHandler = functions.get(name);
              if (actionHandler && (apiCalls.get(name) ?? []).some(item => matchRoute(routes, item.method, item.path)?.featureId === route.featureId)) {
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
    if (ts.isIfStatement(node) && (containsReturn(node.thenStatement) || (node.elseStatement && containsReturn(node.elseStatement)))) {
      const raw = node.expression.getText(entry.file);
      const category = guardCategory(raw);
      if (category) {
        const decisionSpan = nodeRange(entry, node.expression, "context");
        const decision = semanticNode({ kind: "decision", filePath: entry.path, startByte: decisionSpan.startByte, key: `guard:${endpointId}:${raw}`, label: category.label,
          featureId, confidence: currentConfidence, reason: currentConfidence === "proven" ? category.reason : `${category.reason} Callback atau pemanggilan wrapper belum sepenuhnya terverifikasi.`, evidence: [decisionSpan], technicalNodeIds: technicalNodesForSpan(input.ccm.nodes, entry.path, decisionSpan.startByte, decisionSpan.endByte) });
        fragment.nodes.push(decision); nodeIds.push(decision.id);
        const edge = makeEdge("guard", endpointId, decision.id, "memeriksa", currentConfidence, decision.reason, decisionSpan);
        fragment.edges.push(edge); edgeIds.push(edge.id);
        const denied = node.elseStatement ? null : responseStatus(node.thenStatement);
        if (denied && denied >= 400) {
          const resultSpan = nodeRange(entry, node.thenStatement, "context");
          const outcome = semanticNode({ kind: "outcome", filePath: entry.path, startByte: resultSpan.startByte, key: `guard-response:${endpointId}:${denied}:${resultSpan.startByte}`,
            label: `Permintaan ditolak (${denied})`, featureId, confidence: currentConfidence, reason: currentConfidence === "proven" ? "Cabang guard mengembalikan status HTTP eksplisit." : "Status cabang callback terlihat, tetapi pemanggilan callback belum sepenuhnya terverifikasi.", evidence: [resultSpan] });
          fragment.nodes.push(outcome); nodeIds.push(outcome.id);
          const resultEdge = makeEdge("guard-outcome", decision.id, outcome.id, "gagal jika kondisi terpenuhi", currentConfidence, outcome.reason, resultSpan);
          fragment.edges.push(resultEdge); edgeIds.push(resultEdge.id);
        }
        addFeatureMembers(fragment, featureId, [decision.id], [edge.id], [decisionSpan]);
      }
    }
  });
}

function addStores(fragment: SemanticFragment, input: SemanticInput, entry: SourceEntry, handler: ts.FunctionLikeDeclaration, componentId: string, featureId: string, nodeIds: string[], edgeIds: string[], confidence: "proven" | "indicated"): void {
  if (!handler.body) return;
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
        if (["prisma", "db", "database", "client"].includes(segments[0] ?? "") && segments.length >= 2 && /^(find|create|update|delete|upsert|count|aggregate)/u.test(method)) {
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

function addResponseOutcome(fragment: SemanticFragment, entry: SourceEntry, handler: ts.FunctionLikeDeclaration, endpointId: string, featureId: string, nodeIds: string[], edgeIds: string[], confidence: "proven" | "indicated"): void {
  if (!handler.body) return;
  visitHandlerFlow(handler.body, confidence, (statement, currentConfidence) => {
    if (!ts.isReturnStatement(statement) || !isHttpResponseReturn(statement)) return;
    const status = responseStatus(statement);
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
