import ts from "typescript";
import { posix } from "node:path";
import type { CcmEdge, CcmNode, EvidenceSpan } from "@sage/contracts";
import type { SemanticEdge, SemanticFeature, SemanticFragment, SemanticInput, SemanticNode } from "./model.ts";
import { compactEvidence, emptyFragment, evidenceSpan, humanLabel, semanticEdgeId, semanticId, semanticNode, technicalNodesForSpan } from "./builder.ts";

type SourceEntry = { path: string; bytes: Uint8Array; source: ts.SourceFile };
type RouteMatch = { method: string; path: string; evidenceNode: ts.IfStatement; evidenceNodes: ts.IfStatement[]; body: ts.Statement; confidence: "proven" | "indicated" };
type ConditionTerm = { expression: ts.Expression; negated: boolean };
const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
const SOURCE_EXTENSIONS = /\.[cm]?[jt]sx?$/u;
const MAX_ROUTE_ALTERNATIVES = 32;

function scriptKind(path: string): ts.ScriptKind {
  if (/\.tsx$/u.test(path)) return ts.ScriptKind.TSX;
  if (/\.[cm]?jsx?$/u.test(path)) return ts.ScriptKind.JSX;
  return ts.ScriptKind.TS;
}

function isString(node: ts.Expression): node is ts.StringLiteralLike {
  return ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node);
}

function conditionAlternatives(node: ts.Expression, negated = false): ConditionTerm[][] {
  while (ts.isParenthesizedExpression(node)) node = node.expression;
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) return conditionAlternatives(node.operand, !negated);
  if (!ts.isBinaryExpression(node)) return [[{ expression: node, negated }]];
  const isOr = node.operatorToken.kind === ts.SyntaxKind.BarBarToken;
  const isAnd = node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken;
  if (!isOr && !isAnd) return [[{ expression: node, negated }]];
  if (isOr !== negated) return [...conditionAlternatives(node.left, negated), ...conditionAlternatives(node.right, negated)].slice(0, MAX_ROUTE_ALTERNATIVES);
  if (isOr || isAnd) {
    const output: ConditionTerm[][] = [];
    for (const left of conditionAlternatives(node.left, negated)) {
      for (const right of conditionAlternatives(node.right, negated)) {
        output.push([...left, ...right]);
        if (output.length >= MAX_ROUTE_ALTERNATIVES) return output;
      }
    }
    return output;
  }
  return [];
}

function propertyAccess(node: ts.Expression, name: string): node is ts.PropertyAccessExpression {
  return ts.isPropertyAccessExpression(node) && node.name.text === name;
}

function routeConditionsFromTerms(terms: ConditionTerm[]): Array<{ method: string; path: string }> {
    let method: string | null = null;
    let length: number | null = null;
    let invalid = false;
    const segments = new Map<number, string>();
    const excludedMethods = new Set<string>();
    const excludedLengths = new Set<number>();
    const excludedSegments = new Map<number, Set<string>>();
    for (const term of terms) {
      const expression = term.expression;
      if (expression.kind === ts.SyntaxKind.FalseKeyword) { if (!term.negated) invalid = true; continue; }
      if (expression.kind === ts.SyntaxKind.TrueKeyword) { if (term.negated) invalid = true; continue; }
      if (!ts.isBinaryExpression(expression) || ![ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(expression.operatorToken.kind)) continue;
      const { left, right } = expression;
      const equality = (expression.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken) !== term.negated;
      const applyLiteral = (subject: "method" | "length" | "segment", key: number | null, value: string | number) => {
        if (subject === "method") {
          const candidate = String(value).toUpperCase();
          if (!METHODS.has(candidate)) return;
          if (equality) { if (method && method !== candidate || excludedMethods.has(candidate)) invalid = true; method = candidate; }
          else { excludedMethods.add(candidate); if (method === candidate) invalid = true; }
          return;
        }
        if (subject === "length") {
          const candidate = Number(value);
          if (equality) { if (length !== null && length !== candidate || excludedLengths.has(candidate)) invalid = true; length = candidate; }
          else { excludedLengths.add(candidate); if (length === candidate) invalid = true; }
          return;
        }
        if (key === null) return;
        const candidate = String(value), previous = segments.get(key);
        const excluded = excludedSegments.get(key) ?? new Set<string>();
        if (equality) { if (previous !== undefined && previous !== candidate || excluded.has(candidate)) invalid = true; segments.set(key, candidate); }
        else { excluded.add(candidate); excludedSegments.set(key, excluded); if (previous === candidate) invalid = true; }
      };
      if (ts.isIdentifier(left) && left.text === "method" && isString(right)) applyLiteral("method", null, right.text);
      else if (ts.isIdentifier(right) && right.text === "method" && isString(left)) applyLiteral("method", null, left.text);
      if (propertyAccess(left, "length") && ts.isIdentifier(left.expression) && left.expression.text === "parts" && ts.isNumericLiteral(right)) applyLiteral("length", null, Number(right.text));
      else if (propertyAccess(right, "length") && ts.isIdentifier(right.expression) && right.expression.text === "parts" && ts.isNumericLiteral(left)) applyLiteral("length", null, Number(left.text));
      const partLiteral = (indexExpression: ts.Expression, valueExpression: ts.Expression) => {
        if (!ts.isElementAccessExpression(indexExpression) || !ts.isIdentifier(indexExpression.expression) || indexExpression.expression.text !== "parts" ||
            !indexExpression.argumentExpression || !ts.isNumericLiteral(indexExpression.argumentExpression) || !isString(valueExpression)) return;
        applyLiteral("segment", Number(indexExpression.argumentExpression.text), valueExpression.text);
      };
      partLiteral(left, right);
      partLiteral(right, left);
    }
    if (invalid || !method || length === null || length < 1 || length > 32 || segments.size === 0) return [];
    const path = `/${Array.from({ length }, (_, index) => segments.get(index) ?? ":param").join("/")}`;
  return [{ method, path }];
}

function requestNameForMethodBinding(fn: ts.FunctionLikeDeclaration): string | null {
  if (!fn.body || !ts.isBlock(fn.body)) return null;
  let found: string | null = null;
  const visit = (node: ts.Node) => {
    if (found || node !== fn.body && ts.isFunctionLike(node)) return;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "method" && node.initializer) {
      let value: ts.Expression = node.initializer;
      while (ts.isBinaryExpression(value) && value.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) value = value.left;
      if (ts.isPropertyAccessExpression(value) && value.name.text === "method" && ts.isIdentifier(value.expression)) found = value.expression.text;
    }
    ts.forEachChild(node, visit);
  };
  visit(fn.body);
  return found;
}

function pathIsParsed(source: ts.SourceFile, fn: ts.FunctionLikeDeclaration, requestName: string): boolean {
  if (!fn.body || !ts.isBlock(fn.body)) return false;
  let localPathPartsCall = false;
  const isPathPartsCall = (expression: ts.Expression | undefined) => !!expression && ts.isCallExpression(expression) &&
    ts.isIdentifier(expression.expression) && expression.expression.text === "pathParts" && expression.arguments.length === 1 &&
    ts.isIdentifier(expression.arguments[0]!) && expression.arguments[0]!.text === requestName;
  const visit = (node: ts.Node) => {
    if (localPathPartsCall || node !== fn.body && ts.isFunctionLike(node)) return;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "parts" && isPathPartsCall(node.initializer)) localPathPartsCall = true;
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.left) && node.left.text === "parts" && isPathPartsCall(node.right)) localPathPartsCall = true;
    ts.forEachChild(node, visit);
  };
  visit(fn.body);
  if (!localPathPartsCall) return false;
  let helperFound = false;
  const checkHelper = (node: ts.Node) => {
    if (helperFound) return;
    let candidate: ts.FunctionLikeDeclaration | null = null;
    if (ts.isFunctionDeclaration(node) && node.name?.text === "pathParts") candidate = node;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "pathParts" && node.initializer &&
        (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) candidate = node.initializer;
    if (candidate?.body && ts.isBlock(candidate.body) && candidate.parameters.length > 0) {
      const helperRequest = candidate.parameters[0]!.name;
      if (!ts.isIdentifier(helperRequest)) return;
      let hasPathname = false, hasSlashSplit = false;
      const inspect = (child: ts.Node) => {
        if (ts.isPropertyAccessExpression(child) && child.name.text === "pathname") hasPathname = true;
        if (ts.isCallExpression(child) && ts.isPropertyAccessExpression(child.expression) && child.expression.name.text === "split" && child.arguments.length > 0 &&
            ts.isStringLiteralLike(child.arguments[0]!) && child.arguments[0]!.text === "/") hasSlashSplit = true;
        ts.forEachChild(child, inspect);
      };
      inspect(candidate.body);
      if (hasPathname && hasSlashSplit) helperFound = true;
    }
    ts.forEachChild(node, checkHelper);
  };
  checkHelper(source);
  return helperFound;
}

function handlerFunctions(source: ts.SourceFile): ts.FunctionLikeDeclaration[] {
  const output: ts.FunctionLikeDeclaration[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.body && node.name && /^handle.*request$/iu.test(node.name.text) && node.parameters.length >= 2) {
      const requestName = requestNameForMethodBinding(node);
      if (requestName && pathIsParsed(source, node, requestName)) output.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return output;
}

function collectRoutes(fn: ts.FunctionLikeDeclaration): RouteMatch[] {
  if (!fn.body || !ts.isBlock(fn.body)) return [];
  const output: RouteMatch[] = [];
  const alwaysExits = (statement: ts.Statement): boolean => {
    if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement)) return true;
    if (ts.isBlock(statement)) {
      for (const child of statement.statements) if (alwaysExits(child)) return true;
      return false;
    }
    return ts.isIfStatement(statement) && !!statement.elseStatement && alwaysExits(statement.thenStatement) && alwaysExits(statement.elseStatement);
  };
  const visitStatements = (statements: readonly ts.Statement[], contexts: ConditionTerm[][], evidenceNodes: ts.IfStatement[]) => {
    for (const statement of statements) {
      if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement)) break;
      visitStatement(statement, contexts, evidenceNodes);
      if (alwaysExits(statement)) break;
    }
  };
  const combine = (left: ConditionTerm[][], right: ConditionTerm[][]): ConditionTerm[][] => {
    const output: ConditionTerm[][] = [];
    for (const leftTerms of left) {
      for (const rightTerms of right) {
        output.push([...leftTerms, ...rightTerms]);
        if (output.length >= MAX_ROUTE_ALTERNATIVES) return output;
      }
    }
    return output;
  };
  const visitStatement = (statement: ts.Statement, contexts: ConditionTerm[][], evidenceNodes: ts.IfStatement[]) => {
    if (ts.isIfStatement(statement)) {
      const positive = conditionAlternatives(statement.expression);
      const routeContexts = combine(contexts, positive);
      const inherited = new Set(contexts.flatMap(routeConditionsFromTerms).map(match => `${match.method}\0${match.path}`));
      for (const terms of routeContexts) {
        for (const match of routeConditionsFromTerms(terms)) {
          if (inherited.has(`${match.method}\0${match.path}`)) continue;
          output.push({ ...match, evidenceNode: statement, evidenceNodes: [...evidenceNodes, statement], body: statement.thenStatement, confidence: match.path.includes(":param") ? "indicated" : "proven" });
        }
      }
      visitStatement(statement.thenStatement, routeContexts, [...evidenceNodes, statement]);
      if (statement.elseStatement) {
        const negative = combine(contexts, conditionAlternatives(statement.expression, true));
        visitStatement(statement.elseStatement, negative, [...evidenceNodes, statement]);
      }
      return;
    }
    if (ts.isBlock(statement)) { visitStatements(statement.statements, contexts, evidenceNodes); return; }
    if (ts.isTryStatement(statement)) { visitStatements(statement.tryBlock.statements, contexts, evidenceNodes); return; }
    if (ts.isFunctionLike(statement) || ts.isClassDeclaration(statement)) return;
    ts.forEachChild(statement, child => {
      if (ts.isIfStatement(child)) visitStatement(child, contexts, evidenceNodes);
    });
  };
  visitStatements(fn.body.statements, [[]], []);
  const unique = new Map<string, RouteMatch>();
  for (const route of output) unique.set(`${route.method}\0${route.path}\0${route.evidenceNodes.map(node => node.getStart(fn.getSourceFile())).join(",")}`, route);
  const routes = [...unique.values()];
  const pathSpecificity = (path: string) => path.split("/").filter(Boolean);
  return routes.filter(route => {
    const segments = pathSpecificity(route.path);
    if (!segments.includes(":param")) return true;
    return !routes.some(other => {
      if (other === route || other.method !== route.method || !other.evidenceNodes.includes(route.evidenceNode)) return false;
      const otherSegments = pathSpecificity(other.path);
      return otherSegments.length === segments.length && segments.some((segment, index) => segment === ":param" && otherSegments[index] !== ":param") &&
        segments.every((segment, index) => segment === ":param" || otherSegments[index] === segment);
    });
  });
}

function familyFor(path: string): { key: string; label: string } {
  const parts = path.split("/").filter(Boolean);
  if (parts[0]?.toLowerCase() === "api") parts.shift();
  if (/^v\d+$/iu.test(parts[0] ?? "")) parts.shift();
  const root = parts.find(part => !part.startsWith(":")) ?? "application";
  const key = /^(auth|authentication|login|logout|signup|register|session)$/iu.test(root) ? "auth" : root;
  return { key: key.toLowerCase(), label: humanLabel(key) };
}

function nodeEvidence(entry: SourceEntry, node: ts.Node, role: "declaration" | "reference" | "context" = "declaration") {
  return evidenceSpan(entry.path, entry.bytes, node.getStart(entry.source), node.end, role);
}

function isExit(node: ts.Node): boolean {
  let result = false;
  const visit = (child: ts.Node) => {
    if (result || child !== node && ts.isFunctionLike(child)) return;
    if (ts.isReturnStatement(child) || ts.isThrowStatement(child)) result = true;
    else ts.forEachChild(child, visit);
  };
  visit(node);
  return result;
}

function hasPriorExit(node: ts.Node, scope: ts.Node): boolean {
  let current: ts.Node = node;
  while (current !== scope && current.parent) {
    const parent = current.parent;
    if (ts.isBlock(parent) && ts.isStatement(current)) {
      for (const statement of parent.statements) {
        if (statement === current) break;
        if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement)) return true;
      }
    }
    current = parent;
  }
  return false;
}

function reachableExits(branch: ts.Node): ts.Node[] {
  const output: ts.Node[] = [];
  const visit = (node: ts.Node) => {
    if (node !== branch && ts.isFunctionLike(node)) return;
    if (ts.isReturnStatement(node) || ts.isThrowStatement(node)) { output.push(node); return; }
    if (ts.isBlock(node)) {
      for (const statement of node.statements) {
        visit(statement);
        if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement)) break;
      }
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(branch);
  return output;
}

function decisionLabel(condition: string): string {
  if (/auth|session|owner|userId|access|permission|repository\s*!/iu.test(condition)) return "Access check";
  if (/validate|VALIDATION|body|format|required|limit\s*</iu.test(condition)) return "Request validation";
  if (/ready|document|graph|status|analysis\s*!/iu.test(condition)) return "Data availability check";
  if (/github|typeof|function/u.test(condition)) return "Service availability check";
  return "Request condition";
}

function featureFor(route: RouteMatch): { id: string; label: string } {
  const family = familyFor(route.path);
  return { id: semanticId("feature", "node-http", 0, `node-http:${family.key}`), label: family.label };
}

function addEdge(fragment: SemanticFragment, feature: SemanticFeature, edge: SemanticEdge): void {
  fragment.edges.push(edge);
  if (!feature.edgeIds.includes(edge.id)) feature.edgeIds.push(edge.id);
}

function directExits(statement: ts.Statement): Array<ts.ReturnStatement | ts.ThrowStatement> {
  if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement)) return [statement];
  if (!ts.isBlock(statement)) return [];
  const exits: Array<ts.ReturnStatement | ts.ThrowStatement> = [];
  for (const child of statement.statements) {
    if (ts.isReturnStatement(child) || ts.isThrowStatement(child)) {
      exits.push(child);
      break;
    }
    if (ts.isBlock(child)) exits.push(...directExits(child));
    if (statementAlwaysExits(child)) break;
  }
  return exits;
}

function responseLabel(exit: ts.ReturnStatement | ts.ThrowStatement): string {
  if (ts.isThrowStatement(exit)) return "Request rejected";
  const expression = exit.expression;
  if (!expression || !ts.isCallExpression(expression)) return "Response returned";
  const callee = ts.isIdentifier(expression.expression) ? expression.expression.text :
    ts.isPropertyAccessExpression(expression.expression) ? expression.expression.name.text : "";
  if (callee === "writeError") return "Error response";
  if (callee === "writeRedirect") return "Redirect response";
  if (callee === "writeArtifact") return "File download";
  return "Response returned";
}

function callableName(handler: ts.FunctionLikeDeclaration): string | null {
  if (ts.isFunctionDeclaration(handler) && handler.name) return handler.name.text;
  if (ts.isMethodDeclaration(handler) && ts.isIdentifier(handler.name)) return handler.name.text;
  return null;
}

function resolveRelativeSource(fromPath: string, specifier: string, entriesByPath: ReadonlyMap<string, SourceEntry>): SourceEntry | null {
  if (!specifier.startsWith(".")) return null;
  const base = posix.normalize(posix.join(posix.dirname(fromPath), specifier));
  const extension = posix.extname(base);
  const candidates = extension
    ? [base, ...([".js", ".mjs", ".cjs"].includes(extension)
      ? [".ts", ".tsx", ".mts", ".cts"].map(sourceExtension => `${base.slice(0, -extension.length)}${sourceExtension}`)
      : [])]
    : [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"].map(sourceExtension => `${base}${sourceExtension}`);
  const matches = [...new Set(candidates)].map(candidate => entriesByPath.get(candidate)).filter((entry): entry is SourceEntry => !!entry);
  return matches.length === 1 ? matches[0]! : null;
}

function namedImportLocalName(source: ts.SourceFile, moduleName: string, importedName: string): string | null {
  const matches: string[] = [];
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || statement.moduleSpecifier.text !== moduleName ||
        !statement.importClause?.namedBindings || !ts.isNamedImports(statement.importClause.namedBindings)) continue;
    for (const element of statement.importClause.namedBindings.elements) {
      if ((element.propertyName?.text ?? element.name.text) === importedName) matches.push(element.name.text);
    }
  }
  return matches.length === 1 ? matches[0]! : null;
}

/**
 * Find a narrow Node HTTP registration: an imported named handler is called
 * with the request/response parameters of a callback passed to node:http's
 * createServer. This proves registration in source, not that the server listens.
 */
function registeredHandlerEvidence(handlerEntry: SourceEntry, handler: ts.FunctionLikeDeclaration,
  entriesByPath: ReadonlyMap<string, SourceEntry>): EvidenceSpan[] {
  const name = callableName(handler);
  if (!name) return [];
  const registrations: EvidenceSpan[][] = [];
  for (const serverEntry of entriesByPath.values()) {
    const createServerName = namedImportLocalName(serverEntry.source, "node:http", "createServer") ??
      namedImportLocalName(serverEntry.source, "http", "createServer");
    if (!createServerName) continue;
    for (const statement of serverEntry.source.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || !statement.importClause?.namedBindings ||
          !ts.isNamedImports(statement.importClause.namedBindings)) continue;
      const targetEntry = resolveRelativeSource(serverEntry.path, statement.moduleSpecifier.text, entriesByPath);
      if (targetEntry?.path !== handlerEntry.path) continue;
      const importedHandler = statement.importClause.namedBindings.elements.find(element =>
        (element.propertyName?.text ?? element.name.text) === name);
      if (!importedHandler) continue;
      const localHandlerName = importedHandler.name.text;
      const walk = (node: ts.Node) => {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === createServerName && node.arguments[0] &&
            (ts.isArrowFunction(node.arguments[0]) || ts.isFunctionExpression(node.arguments[0]))) {
          const callback = node.arguments[0];
          const [requestParameter, responseParameter] = callback.parameters;
          if (requestParameter && responseParameter && ts.isIdentifier(requestParameter.name) && ts.isIdentifier(responseParameter.name)) {
            const callbackBody = callback.body;
            const requestName = requestParameter.name.text;
            const responseName = responseParameter.name.text;
            const findDispatch = (child: ts.Node) => {
              if (child !== callbackBody && ts.isFunctionLike(child)) return;
              if (ts.isCallExpression(child) && ts.isIdentifier(child.expression) && child.expression.text === localHandlerName &&
                  child.arguments.length >= 2 && ts.isIdentifier(child.arguments[0]!) && child.arguments[0]!.text === requestName &&
                  ts.isIdentifier(child.arguments[1]!) && child.arguments[1]!.text === responseName) {
                registrations.push([
                  nodeEvidence(serverEntry, node, "context"),
                  nodeEvidence(serverEntry, statement, "reference"),
                  nodeEvidence(serverEntry, importedHandler, "reference"),
                  nodeEvidence(serverEntry, child, "reference"),
                ]);
                return;
              }
              ts.forEachChild(child, findDispatch);
            };
            findDispatch(callbackBody);
          }
        }
        ts.forEachChild(node, walk);
      };
      walk(serverEntry.source);
    }
  }
  return registrations.length === 1 ? compactEvidence(registrations[0]!) : [];
}

function exactCallableNode(input: SemanticInput, entry: SourceEntry, handler: ts.FunctionLikeDeclaration): CcmNode | null {
  const name = callableName(handler);
  if (!name) return null;
  const span = nodeEvidence(entry, handler);
  const matches = input.ccm.nodes.filter(node => node.filePath === entry.path && ["Function", "Method"].includes(node.kind) && node.name === name && node.location !== null &&
    node.location.startByte <= span.endByte && node.location.endByte >= span.startByte);
  return matches.length === 1 ? matches[0]! : null;
}

function astCallableForNode(entry: SourceEntry, target: CcmNode): ts.FunctionLikeDeclaration | null {
  if (!target.location || target.filePath !== entry.path) return null;
  const matches: ts.FunctionLikeDeclaration[] = [];
  const visit = (node: ts.Node) => {
    if (callableName(node as ts.FunctionLikeDeclaration) === target.name && (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node))) {
      const nodeStart = Buffer.byteLength(entry.source.text.slice(0, node.getStart(entry.source)), "utf8");
      const nodeEnd = Buffer.byteLength(entry.source.text.slice(0, node.end), "utf8");
      if (nodeStart <= target.location!.endByte && nodeEnd >= target.location!.startByte) matches.push(node as ts.FunctionLikeDeclaration);
    }
    ts.forEachChild(node, visit);
  };
  visit(entry.source);
  return matches.length === 1 ? matches[0]! : null;
}

function literalBoolean(expression: ts.Expression): boolean | null {
  const value = ts.isParenthesizedExpression(expression) ? expression.expression : expression;
  if (value.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (value.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (ts.isPrefixUnaryExpression(value) && value.operator === ts.SyntaxKind.ExclamationToken) {
    const nested = literalBoolean(value.operand);
    return nested === null ? null : !nested;
  }
  return null;
}

function statementAlwaysExits(statement: ts.Statement): boolean {
  if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement)) return true;
  if (ts.isBlock(statement)) {
    for (const child of statement.statements) if (statementAlwaysExits(child)) return true;
    return false;
  }
  if (ts.isIfStatement(statement)) {
    const condition = literalBoolean(statement.expression);
    if (condition === true) return statementAlwaysExits(statement.thenStatement);
    if (condition === false) return statement.elseStatement ? statementAlwaysExits(statement.elseStatement) : false;
    return !!statement.elseStatement && statementAlwaysExits(statement.thenStatement) && statementAlwaysExits(statement.elseStatement);
  }
  return false;
}

/** Collect only calls reachable from this route branch; callable values stay deferred. */
function directReachableCalls(root: ts.Node): ts.CallExpression[] {
  const calls: ts.CallExpression[] = [];
  const scanNode = (node: ts.Node) => {
    if (node !== root && ts.isFunctionLike(node)) return;
    if (ts.isCallExpression(node)) calls.push(node);
    if (ts.isBinaryExpression(node) && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken].includes(node.operatorToken.kind)) {
      scanNode(node.left);
      const left = literalBoolean(node.left);
      if (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken && left === false || node.operatorToken.kind === ts.SyntaxKind.BarBarToken && left === true) return;
      scanNode(node.right);
      return;
    }
    if (ts.isConditionalExpression(node)) {
      scanNode(node.condition);
      const condition = literalBoolean(node.condition);
      if (condition === true) scanNode(node.whenTrue);
      else if (condition === false) scanNode(node.whenFalse);
      else { scanNode(node.whenTrue); scanNode(node.whenFalse); }
      return;
    }
    ts.forEachChild(node, scanNode);
  };
  const scanStatement = (statement: ts.Statement): boolean => {
    if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) return false;
    if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement)) {
      if (statement.expression) scanNode(statement.expression);
      return true;
    }
    if (ts.isBlock(statement)) return scanStatements(statement.statements);
    if (ts.isIfStatement(statement)) {
      const condition = literalBoolean(statement.expression);
      if (condition === true) return scanStatement(statement.thenStatement);
      if (condition === false) return statement.elseStatement ? scanStatement(statement.elseStatement) : false;
      scanNode(statement.expression);
      const thenExits = scanStatement(statement.thenStatement);
      const elseExits = statement.elseStatement ? scanStatement(statement.elseStatement) : false;
      return thenExits && elseExits;
    }
    if (ts.isWhileStatement(statement)) {
      scanNode(statement.expression);
      if (literalBoolean(statement.expression) !== false) scanStatement(statement.statement);
      return false;
    }
    if (ts.isForStatement(statement)) {
      if (statement.initializer) scanNode(statement.initializer);
      if (statement.condition) scanNode(statement.condition);
      if (statement.condition && literalBoolean(statement.condition) === false) return false;
      const bodyExits = scanStatement(statement.statement);
      if (statement.incrementor && !bodyExits) scanNode(statement.incrementor);
      return false;
    }
    if (ts.isTryStatement(statement)) {
      const tryExits = scanStatement(statement.tryBlock);
      const catchExits = statement.catchClause ? scanStatement(statement.catchClause.block) : false;
      const finallyExits = statement.finallyBlock ? scanStatement(statement.finallyBlock) : false;
      return finallyExits || tryExits && catchExits;
    }
    if (ts.isSwitchStatement(statement)) return false;
    scanNode(statement);
    return false;
  };
  const scanStatements = (statements: readonly ts.Statement[]): boolean => {
    for (const statement of statements) {
      if (scanStatement(statement) || statementAlwaysExits(statement)) return true;
    }
    return false;
  };
  if (ts.isBlock(root)) scanStatements(root.statements);
  else if (ts.isStatement(root)) scanStatement(root);
  else scanNode(root);
  return [...new Set(calls)];
}

function storeOperation(call: ts.CallExpression): { table: string; operation: string } | null {
  if (!ts.isPropertyAccessExpression(call.expression)) return null;
  const operation = call.expression.name.text;
  if (!/^(?:find|select|count|aggregate|list|get|all|query|create|insert|upsert|save|write|update|delete|remove)/iu.test(operation)) return null;
  const segments: string[] = [];
  let current: ts.Expression = call.expression.expression;
  while (ts.isPropertyAccessExpression(current)) { segments.unshift(current.name.text); current = current.expression; }
  if (ts.isIdentifier(current)) segments.unshift(current.text);
  if (!/^(?:prisma|db|database|client)$/iu.test(segments[0] ?? "") || segments.length < 2) return null;
  return { table: segments[1]!, operation };
}

function callConditions(entry: SourceEntry, call: ts.CallExpression, stopAt: ts.Node): ReturnType<typeof nodeEvidence>[] {
  const spans: ReturnType<typeof nodeEvidence>[] = [];
  let parent: ts.Node | undefined = call.parent;
  while (parent && parent !== stopAt) {
    if (ts.isIfStatement(parent)) spans.push(nodeEvidence(entry, parent.expression, "context"));
    parent = parent.parent;
  }
  return spans;
}

function addExactCrossFileEffects(fragment: SemanticFragment, input: SemanticInput, entriesByPath: ReadonlyMap<string, SourceEntry>,
  entry: SourceEntry, handler: ts.FunctionLikeDeclaration, route: RouteMatch, routeId: string, routeEvidence: EvidenceSpan[], feature: SemanticFeature, nodeMap: Map<string, SemanticNode>): void {
  const callerCcm = exactCallableNode(input, entry, handler);
  if (!callerCcm) return;
  const calls = directReachableCalls(route.body);
  const resolved: Array<{ call: ts.CallExpression; targetNode: CcmNode; targetEntry: SourceEntry; target: ts.FunctionLikeDeclaration; ccmEdge: CcmEdge }> = [];
  for (const call of calls) {
    const callSpan = nodeEvidence(entry, call, "reference");
    const siteEdges = input.ccm.edges.filter(edge => edge.kind === "CALLS" && edge.sourceId === callerCcm.id &&
      edge.evidence.some(span => span.filePath === entry.path && span.startByte >= callSpan.startByte && span.endByte <= callSpan.endByte));
    if (siteEdges.length !== 1 || siteEdges[0]!.resolution !== "Exact") {
      if (siteEdges.length) fragment.limitations.push({ filePath: entry.path, reason: "Cross-file call in a Node HTTP route has an unresolved or ambiguous CKG binding; the target effect is omitted." });
      continue;
    }
    const ccmEdge = siteEdges[0]!;
    const targetNode = input.ccm.nodes.find(node => node.id === ccmEdge.targetId);
    if (!targetNode || !targetNode.filePath || targetNode.filePath === entry.path || !["Function", "Method"].includes(targetNode.kind)) continue;
    const targetEntry = entriesByPath.get(targetNode.filePath);
    const target = targetEntry && astCallableForNode(targetEntry, targetNode);
    if (!targetEntry || !target || !target.body) {
      fragment.limitations.push({ filePath: entry.path, reason: "Exact CKG call target does not map to one supplied function body; cross-file effects are omitted." });
      continue;
    }
    resolved.push({ call, targetNode, targetEntry, target, ccmEdge });
  }
  if (!resolved.length) return;
  const handlerSpan = nodeEvidence(entry, handler);
  const callerName = callableName(handler) ?? "Node HTTP handler";
  const callerId = semanticId("component", entry.path, handlerSpan.startByte, `node-http-handler:${callerName}`);
  if (!nodeMap.has(callerId)) {
    const caller = semanticNode({ kind: "component", filePath: entry.path, startByte: handlerSpan.startByte, key: `node-http-handler:${callerName}`,
      label: `${humanLabel(callerName)} Handler`, featureId: feature.id, confidence: "indicated",
      reason: "Named Node HTTP handler contains exact CKG call sites; runtime route mounting remains unverified.", evidence: [handlerSpan],
      technicalNodeIds: [callerCcm.id] });
    nodeMap.set(callerId, caller); feature.nodeIds.push(callerId);
  }
  const handlerEdge = { id: semanticEdgeId(entry.path, handlerSpan.startByte, `node-http:route-handler:${routeId}:${callerId}`), source: routeId, target: callerId,
    label: "ditangani oleh", confidence: "indicated", reason: "Route guard berada di dalam handler bernama; runtime mounting belum diverifikasi.", evidence: compactEvidence([...routeEvidence, handlerSpan]) } satisfies SemanticEdge;
  addEdge(fragment, feature, handlerEdge);
  for (const item of resolved) {
    if (!item.target.body) continue;
    const targetBody = item.target.body;
    const targetSpan = nodeEvidence(item.targetEntry, item.target);
    const serviceId = semanticId("component", item.targetEntry.path, targetSpan.startByte, `node-http-service:${item.targetNode.qualifiedName}`);
    if (!nodeMap.has(serviceId)) {
      const service = semanticNode({ kind: "component", filePath: item.targetEntry.path, startByte: targetSpan.startByte, key: `node-http-service:${item.targetNode.qualifiedName}`,
        label: humanLabel(item.targetNode.qualifiedName), featureId: feature.id, confidence: "indicated",
        reason: "One exact CKG CALLS edge links the route handler to this source declaration; runtime mounting is unverified.", evidence: [targetSpan],
        technicalNodeIds: [item.targetNode.id] });
      nodeMap.set(serviceId, service); feature.nodeIds.push(serviceId);
    }
    const callSpan = nodeEvidence(entry, item.call, "reference");
    const callEdge = { id: semanticEdgeId(entry.path, callSpan.startByte, `node-http:handler-service:${callerId}:${serviceId}`), source: callerId, target: serviceId,
      label: "memanggil fungsi", confidence: "indicated", reason: "Call site matches one exact CKG CALLS edge; only this direct target is traced, runtime route mounting is unverified, and transitive helper calls are omitted.",
      evidence: [...compactEvidence(routeEvidence), callSpan, ...item.ccmEdge.evidence, ...callConditions(entry, item.call, route.body), targetSpan] } satisfies SemanticEdge;
    addEdge(fragment, feature, callEdge);
    const serviceCalls = directReachableCalls(targetBody);
    for (const operationCall of serviceCalls) {
      const operation = storeOperation(operationCall);
      if (!operation) continue;
      const operationSpan = nodeEvidence(item.targetEntry, operationCall, "reference");
      const storeId = semanticId("store", item.targetEntry.path, 0, `node-http-store:${operation.table.toLowerCase()}`);
      const existingStore = nodeMap.get(storeId);
      if (!existingStore) {
        const store = semanticNode({ kind: "store", filePath: item.targetEntry.path, startByte: operationSpan.startByte, key: `node-http-store:${operation.table}`,
          label: humanLabel(operation.table), featureId: feature.id, confidence: "indicated",
          reason: `Operasi ${operation.operation} menyebut tabel literal melalui pola receiver database, tetapi binding store tidak diverifikasi.`,
          evidence: [operationSpan], technicalNodeIds: technicalNodesForSpan(input.ccm.nodes, item.targetEntry.path, operationSpan.startByte, operationSpan.endByte) });
        store.id = storeId;
        nodeMap.set(storeId, store); feature.nodeIds.push(storeId);
      } else {
        existingStore.evidence = compactEvidence([...existingStore.evidence, operationSpan]);
        if (existingStore.featureId !== feature.id) existingStore.featureId = null;
      }
      const label = /^(?:find|select|count|aggregate|list|get|all|query)/iu.test(operation.operation) ? "membaca" : /^(?:delete|remove)/iu.test(operation.operation) ? "menghapus" : /^(?:update|upsert)/iu.test(operation.operation) ? "mengubah" : "menyimpan";
      const storeEdge = { id: semanticEdgeId(item.targetEntry.path, operationSpan.startByte, `node-http:service-store:${serviceId}:${storeId}:${operation.operation}`),
        source: serviceId, target: storeId, label, confidence: "indicated", reason: "Operasi store langsung berada di dalam fungsi yang dipanggil oleh route handler; receiver database belum diverifikasi dan helper lanjutan tidak ditelusuri.",
        evidence: [operationSpan, ...callConditions(item.targetEntry, operationCall, targetBody)] } satisfies SemanticEdge;
      addEdge(fragment, feature, storeEdge);
    }
  }
}

/** Extract only explicit method/path guards from a small Node HTTP handler shape. */
export function extractNodeHttp(input: SemanticInput): SemanticFragment {
  const fragment = emptyFragment();
  const featureMap = new Map<string, SemanticFeature>();
  const nodeMap = new Map<string, SemanticNode>();
  const seenRouteKeys = new Set<string>();
  const entries = Object.entries(input.sources).sort(([a], [b]) => a.localeCompare(b)).flatMap(([path, bytes]) => {
    if (!SOURCE_EXTENSIONS.test(path) || /(^|\/)(node_modules|vendor|dist|build|coverage|tests?|fixtures?)(\/|$)/iu.test(path)) return [];
    const text = new TextDecoder().decode(bytes);
    return [{ path, bytes, source: ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, scriptKind(path)) }];
  });
  const entriesByPath = new Map(entries.map(entry => [entry.path, entry]));
  for (const entry of entries) {
    const { path, source } = entry;
    for (const handler of handlerFunctions(source)) {
      const routes = collectRoutes(handler);
      if (!routes.length) {
        fragment.limitations.push({ filePath: path, reason: "Node HTTP handler detected, but no static method and path guard was recognized; dynamic dispatch is not inferred." });
        continue;
      }
      const registrationEvidence = registeredHandlerEvidence(entry, handler, entriesByPath);
      fragment.limitations.push({ filePath: path, reason: registrationEvidence.length
        ? "The named handler is called from a node:http createServer callback in the supplied source; server.listen execution and application runtime reachability are not verified."
        : "Method/path guard chains in the named HTTP handler are extracted; runtime mounting and framework-level reachability are not verified." });
      for (const route of routes) {
        const routeKey = `${path}\0${route.method}\0${route.path}\0${route.evidenceNode.getStart(source)}`;
        if (seenRouteKeys.has(routeKey)) continue;
        seenRouteKeys.add(routeKey);
        const routeSpan = nodeEvidence(entry, route.evidenceNode);
        const routeEvidence = compactEvidence(route.evidenceNodes.map(node => nodeEvidence(entry, node)));
        const feature = featureFor(route);
        let featureModel = featureMap.get(feature.id);
        if (!featureModel) {
          featureModel = { ...feature, entryNodeIds: [], nodeIds: [], edgeIds: [], evidence: [] };
          featureMap.set(feature.id, featureModel);
          const featureNode = semanticNode({ kind: "feature", filePath: path, startByte: routeSpan.startByte, key: feature.id, label: feature.label, featureId: null,
            confidence: "indicated", reason: "Kelompok fitur diringkas dari kandidat path; registrasi handler belum diverifikasi.", evidence: routeEvidence });
          featureNode.id = feature.id;
          nodeMap.set(featureNode.id, featureNode);
          featureModel.nodeIds.push(featureNode.id);
        }
        featureModel.evidence = compactEvidence([...featureModel.evidence, ...routeEvidence]);

        const routeLabel = `${route.method} ${route.path}`;
        const routeId = semanticId("step", path, routeSpan.startByte, `node-http:${routeLabel}`);
        const routeNode = semanticNode({ kind: "step", filePath: path, startByte: routeSpan.startByte, key: routeLabel, label: routeLabel,
          featureId: featureModel.id, confidence: "indicated", reason: "Method dan path guard ditemukan pada handler bernama; runtime mounting dan reachability aplikasi belum diverifikasi.", evidence: routeEvidence,
          technicalNodeIds: [...new Set(routeEvidence.flatMap(span => technicalNodesForSpan(input.ccm.nodes, span.filePath, span.startByte, span.endByte)))] });
        routeNode.id = routeId;
        routeNode.label = routeLabel;
        nodeMap.set(routeId, routeNode);
        featureModel.entryNodeIds.push(routeId);
        featureModel.nodeIds.push(routeId);
        const featureEdge = { id: semanticEdgeId(path, routeSpan.startByte, `node-http:feature:${featureModel.id}:${routeId}`), source: featureModel.nodeIds.find(id => nodeMap.get(id)?.kind === "feature")!, target: routeId,
          label: "includes endpoint", confidence: "indicated", reason: "Endpoint dikelompokkan berdasarkan literal route path.", evidence: routeEvidence } satisfies SemanticEdge;
        addEdge(fragment, featureModel, featureEdge);

        // Keep an explicit external request boundary in the overview. Without
        // this source-backed actor edge, every Node HTTP relationship stays
        // inside one feature frame and the overview collapses it to no lines.
        const requestParameter = handler.parameters[0];
        const actorId = semanticId("actor", "node-http", 0, "node-http:api-client");
        const actorEvidence = requestParameter ? nodeEvidence(entry, requestParameter) : routeSpan;
        const actorEvidenceSpans = compactEvidence([actorEvidence, ...registrationEvidence]);
        const actorReason = registrationEvidence.length
          ? "A named Node HTTP handler parses method and path guards and is imported into a node:http createServer callback with the same request/response parameters; server.listen reachability is not inferred."
          : "A named request handler reads an HTTP method and URL path; caller identity and runtime mounting are not inferred.";
        let actor = nodeMap.get(actorId);
        if (!actor) {
          actor = semanticNode({ kind: "actor", filePath: path, startByte: actorEvidence.startByte, key: "node-http:api-client",
            label: "API client", featureId: null, confidence: "indicated",
            reason: actorReason,
            evidence: actorEvidenceSpans, technicalNodeIds: [] });
          actor.id = actorId;
          nodeMap.set(actorId, actor);
        } else {
          actor.evidence = compactEvidence([...actor.evidence, ...actorEvidenceSpans]);
          if (registrationEvidence.length) actor.reason = actorReason;
        }
        if (!featureModel.nodeIds.includes(actorId)) featureModel.nodeIds.push(actorId);
        const actorEdge = { id: semanticEdgeId(path, routeSpan.startByte, `node-http:client-route:${actorId}:${routeId}`), source: actorId, target: routeId,
          label: "sends request", confidence: "indicated", reason: registrationEvidence.length
            ? "The request/response pair is forwarded by an imported handler inside a node:http createServer callback; listener execution and client identity remain unverified."
            : "The HTTP request parameter and literal method/path guard are present in source; runtime mounting remains unverified.",
          evidence: compactEvidence([actorEvidence, ...registrationEvidence, ...routeEvidence]) } satisfies SemanticEdge;
        addEdge(fragment, featureModel, actorEdge);

        for (const exit of directExits(route.body)) {
          const exitSpan = nodeEvidence(entry, exit);
          const outcomeLabel = responseLabel(exit);
          const outcomeId = semanticId("outcome", path, exitSpan.startByte, `node-http:response:${routeId}:${outcomeLabel}`);
          if (!nodeMap.has(outcomeId)) {
            const outcome = semanticNode({ kind: "outcome", filePath: path, startByte: exitSpan.startByte,
              key: `node-http:response:${routeId}:${outcomeLabel}`, label: outcomeLabel, featureId: featureModel.id,
              confidence: "indicated", reason: "A direct return or throw is present in this candidate route branch; runtime execution is unverified.",
              evidence: [exitSpan], technicalNodeIds: technicalNodesForSpan(input.ccm.nodes, path, exitSpan.startByte, exitSpan.endByte) });
            outcome.id = outcomeId;
            nodeMap.set(outcomeId, outcome);
            featureModel.nodeIds.push(outcomeId);
          }
          const outcomeEdge = { id: semanticEdgeId(path, exitSpan.startByte, `node-http:route-response:${routeId}:${outcomeId}`),
            source: routeId, target: outcomeId, label: "returns", confidence: "indicated",
            reason: "The direct response return or rejection belongs to the candidate method/path branch; runtime mounting remains unverified.",
            evidence: compactEvidence([...routeEvidence, exitSpan]) } satisfies SemanticEdge;
          addEdge(fragment, featureModel, outcomeEdge);
        }
        addExactCrossFileEffects(fragment, input, entriesByPath, entry, handler, route, routeId, routeEvidence, featureModel, nodeMap);

        const body = route.body;
        const visitDecisions = (node: ts.Node) => {
          if (node !== body && ts.isFunctionLike(node)) return;
          if (ts.isIfStatement(node) && !hasPriorExit(node, body) && (isExit(node.thenStatement) || node.elseStatement && isExit(node.elseStatement))) {
            const guardSpan = nodeEvidence(entry, node.expression);
            const label = decisionLabel(node.expression.getText(source));
            const decision = semanticNode({ kind: "decision", filePath: path, startByte: guardSpan.startByte, key: `${routeId}:${node.expression.getText(source)}`,
              label, featureId: featureModel!.id, confidence: "indicated", reason: `Kondisi source pada kandidat handler: ${node.expression.getText(source).slice(0, 180)}`,
              evidence: [guardSpan], technicalNodeIds: technicalNodesForSpan(input.ccm.nodes, path, guardSpan.startByte, guardSpan.endByte) });
            if (!nodeMap.has(decision.id)) {
              nodeMap.set(decision.id, decision);
              featureModel!.nodeIds.push(decision.id);
              const decisionEdge = { id: semanticEdgeId(path, guardSpan.startByte, `node-http:checks:${routeId}:${decision.id}`), source: routeId, target: decision.id,
                label: "memeriksa kondisi", confidence: "indicated", reason: "Percabangan berada di dalam kandidat guard route; handler belum diverifikasi terpasang.", evidence: [guardSpan] } satisfies SemanticEdge;
              addEdge(fragment, featureModel!, decisionEdge);
            }
            const branchNodes = [node.thenStatement, ...(node.elseStatement ? [node.elseStatement] : [])];
            for (const branch of branchNodes) {
              if (!isExit(branch)) continue;
              const exitNodes = reachableExits(branch);
              for (const exit of exitNodes) {
                const exitSpan = nodeEvidence(entry, exit);
                const expressionText = ts.isReturnStatement(exit) ? exit.expression?.getText(source) ?? "" : "";
                const outcomeLabel = ts.isThrowStatement(exit) ? "Request rejected" : /writeRedirect/u.test(expressionText) ? "Redirect response" : /writeError/u.test(expressionText) ? "Error response" : "Response returned";
                const outcome = semanticNode({ kind: "outcome", filePath: path, startByte: exitSpan.startByte, key: `${routeId}:${exit.getStart(source)}`,
                  label: outcomeLabel, featureId: featureModel!.id, confidence: "indicated", reason: "Return atau throw ditemukan pada cabang kandidat handler; efek runtime belum diverifikasi.", evidence: [exitSpan],
                  technicalNodeIds: technicalNodesForSpan(input.ccm.nodes, path, exitSpan.startByte, exitSpan.endByte) });
                if (nodeMap.has(outcome.id)) continue;
                nodeMap.set(outcome.id, outcome);
                featureModel!.nodeIds.push(outcome.id);
                const outcomeEdge = { id: semanticEdgeId(path, exitSpan.startByte, `node-http:branch:${decision.id}:${outcome.id}`), source: decision.id, target: outcome.id,
                  label: "menghasilkan", confidence: "indicated", reason: "Return atau throw berada pada cabang kondisi kandidat handler.", evidence: [exitSpan] } satisfies SemanticEdge;
                addEdge(fragment, featureModel!, outcomeEdge);
              }
            }
          }
          ts.forEachChild(node, visitDecisions);
        };
        visitDecisions(body);
      }
    }
  }
  fragment.nodes = [...nodeMap.values()].sort((a, b) => a.id.localeCompare(b.id));
  fragment.features = [...featureMap.values()].map(feature => ({
    ...feature,
    entryNodeIds: [...new Set(feature.entryNodeIds)].sort(),
    nodeIds: [...new Set(feature.nodeIds)].sort(),
    edgeIds: [...new Set(feature.edgeIds)].sort(),
    evidence: compactEvidence(feature.evidence),
  })).sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
  fragment.edges.sort((a, b) => a.id.localeCompare(b.id));
  fragment.frameworks = fragment.features.length ? ["Node.js HTTP API"] : [];
  fragment.limitations = [...new Map(fragment.limitations.map(item => [`${item.filePath}\0${item.reason}`, item])).values()]
    .sort((a, b) => a.filePath.localeCompare(b.filePath) || a.reason.localeCompare(b.reason));
  return fragment;
}
