import ts from "typescript";
import type { SemanticEdge, SemanticFeature, SemanticFragment, SemanticInput, SemanticNode } from "./model.ts";
import { compactEvidence, emptyFragment, evidenceSpan, humanLabel, semanticEdgeId, semanticId, semanticNode, technicalNodesForSpan } from "./builder.ts";

type SourceEntry = { path: string; bytes: Uint8Array; source: ts.SourceFile };
type RouteMatch = { method: string; path: string; evidenceNode: ts.IfStatement; body: ts.Statement; confidence: "proven" | "indicated" };
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

function conditionAlternatives(node: ts.Expression): ts.Expression[][] {
  while (ts.isParenthesizedExpression(node)) node = node.expression;
  if (!ts.isBinaryExpression(node)) return [[node]];
  if (node.operatorToken.kind === ts.SyntaxKind.BarBarToken) return [...conditionAlternatives(node.left), ...conditionAlternatives(node.right)].slice(0, MAX_ROUTE_ALTERNATIVES);
  if (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
    const output: ts.Expression[][] = [];
    for (const left of conditionAlternatives(node.left)) {
      for (const right of conditionAlternatives(node.right)) {
        output.push([...left, ...right]);
        if (output.length >= MAX_ROUTE_ALTERNATIVES) return output;
      }
    }
    return output;
  }
  return [[node]];
}

function propertyAccess(node: ts.Expression, name: string): node is ts.PropertyAccessExpression {
  return ts.isPropertyAccessExpression(node) && node.name.text === name;
}

function routeConditions(condition: ts.Expression): Array<{ method: string; path: string }> {
  const output: Array<{ method: string; path: string }> = [];
  for (const terms of conditionAlternatives(condition)) {
    let method: string | null = null;
    let length: number | null = null;
    let invalid = terms.some(term => term.kind === ts.SyntaxKind.FalseKeyword);
    const segments = new Map<number, string>();
    for (const term of terms) {
      if (!ts.isBinaryExpression(term) || term.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken) continue;
      const { left, right } = term;
      if (ts.isIdentifier(left) && left.text === "method" && isString(right)) {
        const candidate = right.text.toUpperCase();
        if (METHODS.has(candidate)) {
          if (method && method !== candidate) invalid = true;
          method = candidate;
        }
      } else if (ts.isIdentifier(right) && right.text === "method" && isString(left)) {
        const candidate = left.text.toUpperCase();
        if (METHODS.has(candidate)) {
          if (method && method !== candidate) invalid = true;
          method = candidate;
        }
      }
      if (propertyAccess(left, "length") && ts.isIdentifier(left.expression) && left.expression.text === "parts" && ts.isNumericLiteral(right)) {
        const candidate = Number(right.text); if (length !== null && length !== candidate) invalid = true; length = candidate;
      }
      if (propertyAccess(right, "length") && ts.isIdentifier(right.expression) && right.expression.text === "parts" && ts.isNumericLiteral(left)) {
        const candidate = Number(left.text); if (length !== null && length !== candidate) invalid = true; length = candidate;
      }
      const partLiteral = (indexExpression: ts.Expression, valueExpression: ts.Expression) => {
        if (!ts.isElementAccessExpression(indexExpression) || !ts.isIdentifier(indexExpression.expression) || indexExpression.expression.text !== "parts" ||
            !indexExpression.argumentExpression || !ts.isNumericLiteral(indexExpression.argumentExpression) || !isString(valueExpression)) return;
        const index = Number(indexExpression.argumentExpression.text);
        const previous = segments.get(index);
        if (previous !== undefined && previous !== valueExpression.text) invalid = true;
        segments.set(index, valueExpression.text);
      };
      partLiteral(left, right);
      partLiteral(right, left);
    }
    if (invalid || !method || length === null || length < 1 || length > 32 || segments.size === 0) continue;
    const path = `/${Array.from({ length }, (_, index) => segments.get(index) ?? ":param").join("/")}`;
    output.push({ method, path });
  }
  return output;
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
  const reachableTries: ts.Block[] = [];
  for (const statement of fn.body.statements) {
    if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement)) break;
    if (ts.isTryStatement(statement)) reachableTries.push(statement.tryBlock);
  }
  const scopes = [fn.body, ...reachableTries];
  for (const scope of scopes) {
    for (const statement of scope.statements) {
      if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement)) break;
      if (!ts.isIfStatement(statement)) continue;
      const matches = routeConditions(statement.expression);
      for (const match of matches) output.push({ ...match, evidenceNode: statement, body: statement.thenStatement, confidence: match.path.includes(":param") ? "indicated" : "proven" });
    }
  }
  return output;
}

function familyFor(path: string): { key: string; label: string } {
  const parts = path.split("/").filter(Boolean);
  if (parts[0]?.toLowerCase() === "api") parts.shift();
  if (/^v\d+$/iu.test(parts[0] ?? "")) parts.shift();
  const root = parts.find(part => !part.startsWith(":")) ?? "application";
  const key = /^(auth|authentication|login|logout|signup|register|session)$/iu.test(root) ? "auth" : root;
  return { key: key.toLowerCase(), label: humanLabel(key) };
}

function nodeEvidence(entry: SourceEntry, node: ts.Node) {
  return evidenceSpan(entry.path, entry.bytes, node.getStart(entry.source), node.end, "declaration");
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

/** Extract only explicit method/path guards from a small Node HTTP handler shape. */
export function extractNodeHttp(input: SemanticInput): SemanticFragment {
  const fragment = emptyFragment();
  const featureMap = new Map<string, SemanticFeature>();
  const nodeMap = new Map<string, SemanticNode>();
  const seenRouteKeys = new Set<string>();
  for (const [path, bytes] of Object.entries(input.sources).sort(([a], [b]) => a.localeCompare(b))) {
    if (!SOURCE_EXTENSIONS.test(path) || /(^|\/)(node_modules|vendor|dist|build|coverage|tests?|fixtures?)(\/|$)/iu.test(path)) continue;
    const text = new TextDecoder().decode(bytes);
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, scriptKind(path));
    const entry = { path, bytes, source };
    for (const handler of handlerFunctions(source)) {
      const routes = collectRoutes(handler);
      if (!routes.length) {
        fragment.limitations.push({ filePath: path, reason: "Node HTTP handler detected, but no static method and path guard was recognized; dynamic dispatch is not inferred." });
        continue;
      }
      fragment.limitations.push({ filePath: path, reason: "Only direct route guards in the named HTTP handler are extracted; nested route composition, runtime mounting, and reachability are not verified." });
      for (const route of routes) {
        const routeKey = `${path}\0${route.method}\0${route.path}\0${route.evidenceNode.getStart(source)}`;
        if (seenRouteKeys.has(routeKey)) continue;
        seenRouteKeys.add(routeKey);
        const routeSpan = nodeEvidence(entry, route.evidenceNode);
        const feature = featureFor(route);
        let featureModel = featureMap.get(feature.id);
        if (!featureModel) {
          featureModel = { ...feature, entryNodeIds: [], nodeIds: [], edgeIds: [], evidence: [] };
          featureMap.set(feature.id, featureModel);
          const featureNode = semanticNode({ kind: "feature", filePath: path, startByte: routeSpan.startByte, key: feature.id, label: feature.label, featureId: null,
            confidence: "indicated", reason: "Kelompok fitur diringkas dari kandidat path; registrasi handler belum diverifikasi.", evidence: [routeSpan] });
          featureNode.id = feature.id;
          nodeMap.set(featureNode.id, featureNode);
          featureModel.nodeIds.push(featureNode.id);
        }
        featureModel.evidence = compactEvidence([...featureModel.evidence, routeSpan]);

        const routeLabel = `${route.method} ${route.path}`;
        const routeId = semanticId("step", path, routeSpan.startByte, `node-http:${routeLabel}`);
        const routeNode = semanticNode({ kind: "step", filePath: path, startByte: routeSpan.startByte, key: routeLabel, label: routeLabel,
          featureId: featureModel.id, confidence: "indicated", reason: "Method dan path match guard ditemukan pada handler bernama; runtime mounting dan reachability aplikasi belum diverifikasi.", evidence: [routeSpan],
          technicalNodeIds: technicalNodesForSpan(input.ccm.nodes, path, routeSpan.startByte, routeSpan.endByte) });
        routeNode.id = routeId;
        routeNode.label = routeLabel;
        nodeMap.set(routeId, routeNode);
        featureModel.entryNodeIds.push(routeId);
        featureModel.nodeIds.push(routeId);
        const featureEdge = { id: semanticEdgeId(path, routeSpan.startByte, `node-http:feature:${featureModel.id}:${routeId}`), source: featureModel.nodeIds.find(id => nodeMap.get(id)?.kind === "feature")!, target: routeId,
          label: "includes endpoint", confidence: "indicated", reason: "Endpoint dikelompokkan berdasarkan literal route path.", evidence: [routeSpan] } satisfies SemanticEdge;
        addEdge(fragment, featureModel, featureEdge);

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
