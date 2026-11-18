import { createHash } from "node:crypto";
import { canonicalizeCcm, createEdgeId, createNodeId, type CcmEdge, type CcmFile, type CcmLimitation, type CcmNode, type CcmSnapshot, type CcmV1, type EvidenceSpan, type JsonValue } from "@sage/contracts";

const VERSION = "sage-python-static-0.1.0";
const sha256 = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
function lineIndent(line: string): number { return line.match(/^[ \t]*/u)?.[0].replaceAll("\t", "    ").length ?? 0; }
function lineOffsets(text: string): number[] {
  const offsets = [0];
  for (let index = 0; index < text.length; index++) if (text[index] === "\n") offsets.push(index + 1);
  return offsets;
}
function pythonCodeLines(lines: string[]): string[] {
  let tripleQuote: "'''" | '"""' | null = null;
  return lines.map(line => {
    const output = [...line];
    let index = 0;
    while (index < line.length) {
      if (tripleQuote) {
        const end = line.indexOf(tripleQuote, index);
        const stop = end < 0 ? line.length : end + tripleQuote.length;
        for (let cursor = index; cursor < stop; cursor++) if (output[cursor] !== "\t") output[cursor] = " ";
        index = stop;
        if (end >= 0) tripleQuote = null;
        continue;
      }
      if (line[index] === "#") {
        for (let cursor = index; cursor < line.length; cursor++) if (output[cursor] !== "\t") output[cursor] = " ";
        break;
      }
      const triple = line.slice(index, index + 3);
      if (triple === "'''" || triple === '"""') {
        tripleQuote = triple;
        const end = line.indexOf(triple, index + 3);
        const stop = end < 0 ? line.length : end + triple.length;
        for (let cursor = index; cursor < stop; cursor++) if (output[cursor] !== "\t") output[cursor] = " ";
        index = stop;
        if (end >= 0) tripleQuote = null;
        continue;
      }
      const quote = line[index];
      if (quote === "'" || quote === '"') {
        index++;
        while (index < line.length) {
          if (line[index] === "\\") { index += 2; continue; }
          if (line[index] === quote) { index++; break; }
          index++;
        }
        continue;
      }
      index++;
    }
    return output.join("");
  });
}
function byteOffset(text: string, utf16: number): number { return Buffer.byteLength(text.slice(0, utf16), "utf8"); }
function evidence(path: string, hash: string, text: string, offsets: number[], startLine: number, endLine: number, role: EvidenceSpan["role"]): EvidenceSpan {
  const startUtf16 = offsets[Math.max(0, startLine - 1)] ?? 0;
  let endUtf16 = Math.min(text.length, offsets[endLine] ?? text.length);
  if (endLine < offsets.length && endUtf16 > startUtf16 && text[endUtf16 - 1] === "\n") endUtf16 -= 1;
  const startPrefix = text.slice(0, startUtf16).split("\n").at(-1) ?? "";
  const endPrefix = text.slice(0, endUtf16).split("\n").at(-1) ?? "";
  const startColumn = Array.from(startPrefix).length + 1;
  const endColumn = Array.from(endPrefix).length + 1;
  const endPosition = text.slice(0, endUtf16).split("\n");
  return { filePath: path, fileSha256: hash, startByte: byteOffset(text, startUtf16), endByte: byteOffset(text, endUtf16), startLine, endLine: endPosition.length, startColumn, endColumn, role };
}
function indentAt(lines: string[], index: number): number { return lineIndent(lines[index] ?? ""); }
function blockEnd(lines: string[], start: number, indent: number): number {
  let end = start;
  for (let index = start + 1; index < lines.length; index++) {
    const line = lines[index] ?? "";
    if (!line.trim() || line.trimStart().startsWith("#")) { end = index; continue; }
    if (indentAt(lines, index) <= indent) break;
    end = index;
  }
  return end;
}
function decoratorStart(lines: string[], index: number): number {
  let start = index;
  for (let cursor = index - 1; cursor >= 0; cursor--) {
    const line = (lines[cursor] ?? "").trim();
    if (line.startsWith("@")) { start = cursor; continue; }
    if (!line || line.startsWith("#")) continue;
    break;
  }
  return start;
}
function decoratorsBefore(lines: string[], index: number): string {
  const start = decoratorStart(lines, index);
  return lines.slice(start, index).join("\n");
}
function pythonModule(path: string): string {
  return path.replace(/\\/gu, "/").replace(/(?:\/__init__)?\.py$/u, "").replaceAll("/", ".") || "__init__";
}
function importModulePath(currentPath: string, requestedModule: string): string {
  const leadingDots = requestedModule.match(/^\.+/u)?.[0].length ?? 0;
  const suffix = requestedModule.slice(leadingDots).replace(/^\./u, "");
  if (leadingDots === 0) return requestedModule;
  const currentParts = pythonModule(currentPath).split(".").filter(Boolean);
  const packageParts = currentPath.endsWith("/__init__.py") ? currentParts : currentParts.slice(0, -1);
  const base = packageParts.slice(0, Math.max(0, packageParts.length - leadingDots + 1));
  return [...base, ...suffix.split(".").filter(Boolean)].join(".");
}
function literalMethodList(value: string): string[] | null {
  const list = value.match(/^\s*\[([\s\S]*)\]\s*$/u)?.[1];
  if (list === undefined || !list.trim()) return null;
  const methods = list.split(",").map(item => item.trim());
  if (methods.some(item => !/^(?:"[A-Za-z]+"|'[A-Za-z]+')$/u.test(item))) return null;
  return methods.map(item => item.slice(1, -1).toUpperCase());
}
function routeAttributes(decorators: string): Record<string, JsonValue> | null {
  // Only accept a complete literal first argument. A quoted prefix followed by
  // concatenation/interpolation is not the route declared at runtime.
  const direct = decorators.match(/@(?:[A-Za-z_]\w*\.)?(get|post|put|patch|delete|options|head|trace)\(\s*(["'])([^"']*)\2(?=\s*(?:,|\)))/iu);
  if (direct) return { routeMethod: direct[1]!.toUpperCase(), routePath: direct[3]!, routeFramework: "python-decorator" };
  const generic = decorators.match(/@(?:[A-Za-z_]\w*\.)?(?:api_route|route)\(\s*(["'])([^"']*)\1(?=\s*(?:,|\)))([^)]*)\)/iu);
  if (generic) {
    const methodsExpression = generic[3]!.match(/\bmethods\s*=\s*(\[[^\]]*\])(?=\s*(?:,|$))/iu)?.[1];
    const methods = methodsExpression ? literalMethodList(methodsExpression) : null;
    if (methods?.length) return { routeMethod: methods.slice(0, 4).join("/"), routePath: generic[2]!, routeFramework: "python-decorator" };
  }
  return null;
}

/** Conservative line-structured Python adapter: declarations, local imports, inheritance, FastAPI-style routes and SQLAlchemy model hints. It never imports or executes repository code. */
export function analyzePythonSources(input: { snapshot: CcmSnapshot; sources: Readonly<Record<string, Uint8Array>> }): { ccm: CcmV1 | null; diagnostics: Array<{ path: string; code: string; message: string; startByte: number | null; line: number | null; column: number | null }> } {
  const entries = Object.entries(input.sources).sort(([a], [b]) => a.localeCompare(b));
  const files: CcmFile[] = [];
  const nodes: CcmNode[] = [];
  const edges: CcmEdge[] = [];
  const limitations: CcmLimitation[] = [];
  const moduleNodes = new Map<string, CcmNode>();
  const declarations = new Map<string, CcmNode[]>();
  const importedBindingsByPath = new Map<string, Map<string, Array<{ node: CcmNode | null; line: number }>>>();
  const bindingAssignmentsByPath = new Map<string, Map<string, number[]>>();
  const moduleClassesByPath = new Map<string, Array<{ node: CcmNode; line: number }>>();
  const unknownImportLinesByPath = new Map<string, number[]>();
  const uncertainBindingLinesByPath = new Map<string, Map<string, number[]>>();
  const topLevelClassIds = new Set<string>();
  const moduleText = new Map<string, { text: string; hash: string; offsets: number[] }>();
  const diagnostics: Array<{ path: string; code: string; message: string; startByte: number | null; line: number | null; column: number | null }> = [];
  const hashSnapshot = input.snapshot.commitSha;

  for (const [path, sourceBytes] of entries) {
    const bytes = new Uint8Array(sourceBytes);
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch { files.push({ path, language: "python", sha256: sha256(bytes), sizeBytes: bytes.byteLength, status: "failed" }); continue; }
    const hash = sha256(bytes); const offsets = lineOffsets(text); const lines = text.split("\n"); const codeLines = pythonCodeLines(lines);
    const assignments = new Map<string, number[]>();
    for (let lineIndex = 0; lineIndex < codeLines.length; lineIndex++) {
      if (indentAt(codeLines, lineIndex) !== 0) continue;
      const assigned = codeLines[lineIndex]?.match(/^\s*([A-Za-z_]\w*)\s*(?::\s*[^=]+)?=(?!=)/u)?.[1];
      if (assigned) assignments.set(assigned, [...(assignments.get(assigned) ?? []), lineIndex + 1]);
      const deleted = codeLines[lineIndex]?.match(/^\s*del\s+([A-Za-z_]\w*)/u)?.[1];
      if (deleted) assignments.set(deleted, [...(assignments.get(deleted) ?? []), lineIndex + 1]);
      const fromImport = codeLines[lineIndex]?.match(/^\s*from\s+\.*[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*\s+import\s+(.+)$/u)?.[1];
      const importMatch = codeLines[lineIndex]?.match(/^\s*import\s+([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)(?:\s+as\s+([A-Za-z_]\w*))?/u);
      const importedNames = fromImport?.replace(/[()]/gu, "").split(/\s*,\s*/u).map(value => {
        const [name, alias] = value.split(/\s+as\s+/u); return alias ?? name;
      }).filter((name): name is string => Boolean(name && /^[A-Za-z_]\w*$/u.test(name))) ?? [];
      if (importMatch) importedNames.push(importMatch[2] ?? importMatch[1]!.split(".")[0]!);
      for (const name of importedNames) assignments.set(name, [...(assignments.get(name) ?? []), lineIndex + 1]);
      if (fromImport && (!importedNames.length || fromImport.includes("*"))) {
        unknownImportLinesByPath.set(path, [...(unknownImportLinesByPath.get(path) ?? []), lineIndex + 1]);
      }
    }
    const uncertainBindings = new Map<string, number[]>();
    const lexicalScopes: number[] = [];
    const recordUncertain = (name: string, line: number) => {
      if (!/^[A-Za-z_]\w*$/u.test(name)) return;
      uncertainBindings.set(name, [...(uncertainBindings.get(name) ?? []), line]);
    };
    for (let lineIndex = 0; lineIndex < codeLines.length; lineIndex++) {
      const raw = codeLines[lineIndex] ?? "";
      if (!raw.trim()) continue;
      const indent = indentAt(codeLines, lineIndex);
      while (lexicalScopes.length && indent <= lexicalScopes.at(-1)!) lexicalScopes.pop();
      const insideLocalScope = lexicalScopes.length > 0;
      if (!insideLocalScope && indent > 0) {
        const assigned = raw.match(/^\s*([A-Za-z_]\w*)\s*(?::\s*[^=]+)?=(?!=)/u)?.[1];
        const deleted = raw.match(/^\s*del\s+([A-Za-z_]\w*)/u)?.[1];
        const declaration = raw.match(/^\s*(?:async\s+)?(?:def|class)\s+([A-Za-z_]\w*)/u)?.[1];
        const loopTarget = raw.match(/^\s*(?:async\s+)?for\s+(.+?)\s+in\b/u)?.[1];
        if (assigned) recordUncertain(assigned, lineIndex + 1);
        if (deleted) recordUncertain(deleted, lineIndex + 1);
        if (declaration) recordUncertain(declaration, lineIndex + 1);
        if (loopTarget) for (const name of loopTarget.match(/[A-Za-z_]\w*/gu) ?? []) recordUncertain(name, lineIndex + 1);
        for (const alias of raw.matchAll(/\bas\s+([A-Za-z_]\w*)/gu)) recordUncertain(alias[1]!, lineIndex + 1);
        const fromImport = raw.match(/^\s*from\s+\.*[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*\s+import\s+(.+)$/u)?.[1];
        const importedNames = fromImport?.replace(/[()]/gu, "").split(/\s*,\s*/u).map(value => {
          const [name, alias] = value.split(/\s+as\s+/u); return alias ?? name;
        }).filter((name): name is string => Boolean(name && /^[A-Za-z_]\w*$/u.test(name))) ?? [];
        const directImport = raw.match(/^\s*import\s+[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*(?:\s+as\s+([A-Za-z_]\w*))?/u);
        for (const name of importedNames) recordUncertain(name, lineIndex + 1);
        if (directImport) recordUncertain(directImport[1] ?? raw.match(/^\s*import\s+([A-Za-z_]\w*)/u)?.[1] ?? "", lineIndex + 1);
        if (fromImport && (!importedNames.length || fromImport.includes("*"))) {
          unknownImportLinesByPath.set(path, [...(unknownImportLinesByPath.get(path) ?? []), lineIndex + 1]);
        }
      }
      if (/^\s*(?:async\s+)?(?:def|class)\s+[A-Za-z_]\w*.*:\s*(?:#.*)?$/u.test(raw)) lexicalScopes.push(indent);
    }
    uncertainBindingLinesByPath.set(path, uncertainBindings);
    bindingAssignmentsByPath.set(path, assignments);
    moduleText.set(path, { text, hash, offsets });
    files.push({ path, language: "python", sha256: hash, sizeBytes: bytes.byteLength, status: "processed" });
    const moduleSpan = bytes.byteLength ? evidence(path, hash, text, offsets, 1, Math.max(1, lines.length), "declaration") : null;
    const moduleName = pythonModule(path);
    const moduleNode: CcmNode | null = moduleSpan ? {
      id: createNodeId({ snapshotSha: hashSnapshot, language: "python", filePath: path, kind: "Module", qualifiedName: moduleName, startByte: 0, endByte: bytes.byteLength }),
      kind: "Module", name: path.split("/").at(-1) ?? path, qualifiedName: moduleName, language: "python", filePath: path,
      location: moduleSpan, parentId: null, origin: "source", signature: null, attributes: { moduleKind: "file" },
    } : null;
    if (moduleNode) { nodes.push(moduleNode); moduleNodes.set(path, moduleNode); declarations.set(path, [moduleNode]); }

    let activeClass: { node: CcmNode; indent: number; end: number; header: string } | null = null;
    for (let index = 0; index < lines.length; index++) {
      const raw = codeLines[index] ?? "";
      const trimmed = raw.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const indent = indentAt(codeLines, index);
      if (activeClass && indent <= activeClass.indent && index > activeClass.end) activeClass = null;
      const classMatch = raw.match(/^\s*class\s+([A-Za-z_]\w*)\s*(?:\(([^)]*)\))?\s*:/u);
      if (classMatch && moduleNode) {
        const end = blockEnd(codeLines, index, indent);
        const start = decoratorStart(codeLines, index);
        const span = evidence(path, hash, text, offsets, start + 1, end + 1, "declaration");
        const bases = classMatch[2]?.trim() ?? "";
        const body = codeLines.slice(index, end + 1).join("\n");
        const baseNames = bases.split(",").map(value => value.trim().split(".").at(-1) ?? "");
        const modelHint = /__tablename__\s*=|__table__\s*=|(?:Column|mapped_column|relationship)\s*\(|Mapped\s*\[|table\s*=\s*True/u.test(body) ||
          baseNames.some(value => /^(?:SQLModel|Model)$/iu.test(value));
        const name = classMatch[1]!;
        const node: CcmNode = { id: createNodeId({ snapshotSha: hashSnapshot, language: "python", filePath: path, kind: "Class", qualifiedName: `${moduleName}.${name}`, startByte: span.startByte, endByte: span.endByte }),
          kind: "Class", name, qualifiedName: `${moduleName}.${name}`, language: "python", filePath: path, location: span, parentId: moduleNode.id, origin: "source", signature: raw.trim(), attributes: { ...(modelHint ? { dataModel: true } : {}), ...(bases ? { bases } : {}) } };
        nodes.push(node); declarations.get(path)!.push(node); activeClass = { node, indent, end, header: raw };
        if (indent === 0) {
          topLevelClassIds.add(node.id);
          moduleClassesByPath.set(path, [...(moduleClassesByPath.get(path) ?? []), { node, line: index + 1 }]);
        }
        continue;
      }
      const functionMatch = raw.match(/^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\((.*)$/u);
      if (functionMatch && moduleNode) {
        const parentClass = activeClass && indent > activeClass.indent ? activeClass.node : null;
        const kind = parentClass ? "Method" : "Function";
        const name = functionMatch[1]!;
        if (indent === 0) assignments.set(name, [...(assignments.get(name) ?? []), index + 1]);
        const end = blockEnd(codeLines, index, indent);
        const start = decoratorStart(codeLines, index);
        const span = evidence(path, hash, text, offsets, start + 1, end + 1, "declaration");
        const decoratorText = decoratorsBefore(codeLines, index);
        const route = routeAttributes(decoratorText);
        if (!route && /@(?:[A-Za-z_]\w*\.)?(?:get|post|put|patch|delete|options|head|trace|api_route|route)\s*\(/iu.test(decoratorText)) {
          limitations.push({ path, stage: "Python static adapter", reason: `Route decorator for ${name} has a dynamic or unsupported path or methods expression; no route fact was inferred.` });
        }
        const node: CcmNode = { id: createNodeId({ snapshotSha: hashSnapshot, language: "python", filePath: path, kind, qualifiedName: `${parentClass?.qualifiedName ?? moduleName}.${name}`, startByte: span.startByte, endByte: span.endByte }),
          kind, name, qualifiedName: `${parentClass?.qualifiedName ?? moduleName}.${name}`, language: "python", filePath: path, location: span, parentId: parentClass?.id ?? moduleNode.id, origin: "source", signature: raw.trim(), attributes: { ...(route ?? {}), ...(route ? { operationName: name } : {}) } };
        nodes.push(node); declarations.get(path)!.push(node);
        continue;
      }
      if (activeClass && indent > activeClass.indent) {
        const property = raw.match(/^\s*([A-Za-z_]\w*)\s*(?::\s*[^=]+)?=\s*(.+)$/u);
        if (property && /(?:Column\s*\(|mapped_column\s*\(|relationship\s*\(|ForeignKey\s*\(|Mapped\s*\[)/u.test(raw)) {
          const span = evidence(path, hash, text, offsets, index + 1, index + 1, "declaration");
          const name = property[1]!;
          const node: CcmNode = { id: createNodeId({ snapshotSha: hashSnapshot, language: "python", filePath: path, kind: "Property", qualifiedName: `${activeClass.node.qualifiedName}.${name}`, startByte: span.startByte, endByte: span.endByte }),
            kind: "Property", name, qualifiedName: `${activeClass.node.qualifiedName}.${name}`, language: "python", filePath: path, location: span, parentId: activeClass.node.id, origin: "source", signature: raw.trim(), attributes: { dataProperty: true, relationProperty: /relationship\s*\(/u.test(raw) } };
          nodes.push(node); declarations.get(path)!.push(node);
        }
      }
    }
    limitations.push({ path, stage: "Python static adapter", reason: "Python support is conservative and line-structured: it records declarations, local inheritance/imports, FastAPI-style route decorators, and SQLAlchemy model hints; it does not execute code or resolve dynamic dispatch, dependency injection, conditional routing, or complete call graphs." });
  }

  const pathByModule = new Map<string, string>();
  for (const path of moduleNodes.keys()) {
    const name = pythonModule(path); pathByModule.set(name, path);
    if (path.endsWith("/__init__.py")) pathByModule.set(name.replace(/\.__init__$/u, ""), path);
  }
  for (const [path, context] of moduleText) {
    const moduleNode = moduleNodes.get(path); if (!moduleNode) continue;
    const { text, hash, offsets } = context; const lines = text.split("\n"); const codeLines = pythonCodeLines(lines);
    const importedBindings = new Map<string, Array<{ node: CcmNode | null; line: number }>>();
    importedBindingsByPath.set(path, importedBindings);
    for (let index = 0; index < codeLines.length; index++) {
      const line = codeLines[index] ?? "";
      if (indentAt(codeLines, index) !== 0) continue;
      const importMatch = line.match(/^\s*(?:from\s+(\.*[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*|\.+)\s+import\s+(.+)|import\s+([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)(?:\s+as\s+([A-Za-z_]\w*))?)/u);
      if (!importMatch) continue;
      const requestedModule = importMatch[1] ?? importMatch[3] ?? "";
      const importedModule = importModulePath(path, requestedModule);
      const span = evidence(path, hash, text, offsets, index + 1, index + 1, "reference");
      const localPath = pathByModule.get(importedModule) ?? pathByModule.get(importedModule.replaceAll(".", "/"));
      const importedNames = importMatch[2]?.replace(/[()]/gu, "").split(/\s*,\s*/u).filter(Boolean) ?? [];
      const importSymbols = importedNames.map(value => {
        const [symbol, alias] = value.split(/\s+as\s+/u);
        return { symbol, alias: alias ?? symbol };
      }).filter((item): item is { symbol: string; alias: string } => Boolean(item.symbol && item.alias));
      const symbolName = importSymbols[0]?.symbol;
      const symbolCandidates = localPath && symbolName ? declarations.get(localPath)?.filter(node => node.kind === "Class" && node.name === symbolName) ?? [] : [];
      const target = localPath ? (symbolName ? symbolCandidates.length === 1 ? symbolCandidates[0] : null : moduleNodes.get(localPath) ?? null) : null;
      for (const imported of importSymbols) {
        const candidates = localPath ? declarations.get(localPath)?.filter(node => node.kind === "Class" && node.name === imported.symbol) ?? [] : [];
        const bound = candidates.length === 1 ? candidates[0] : null;
        const declarationLine = bound?.location?.startLine ?? 0;
        const changedAfterDeclaration = declarationLine > 0 && (
          (bindingAssignmentsByPath.get(localPath!)?.get(imported.symbol) ?? []).some(lineNumber => lineNumber > declarationLine) ||
          (uncertainBindingLinesByPath.get(localPath!)?.get(imported.symbol) ?? []).some(lineNumber => lineNumber > declarationLine) ||
          (unknownImportLinesByPath.get(localPath!) ?? []).some(lineNumber => lineNumber > declarationLine)
        );
        const bindings = importedBindings.get(imported.alias) ?? [];
        bindings.push({ node: bound && !changedAfterDeclaration ? bound : null, line: index + 1 });
        importedBindings.set(imported.alias, bindings);
      }
      if (importMatch[3]) {
        const boundName = importMatch[4] ?? importMatch[3].split(".")[0]!;
        const bindings = importedBindings.get(boundName) ?? [];
        bindings.push({ node: null, line: index + 1 });
        importedBindings.set(boundName, bindings);
      }
      const unresolved: CcmNode | null = target ? null : {
        id: createNodeId({ snapshotSha: hashSnapshot, language: "python", filePath: null, kind: "UnresolvedReference", qualifiedName: `${path}#import:${importedModule}:${index + 1}`, startByte: null, endByte: null }),
        kind: "UnresolvedReference", name: symbolName ?? importedModule, qualifiedName: `${path}#import:${importedModule}:${index + 1}`, language: "python", filePath: null, location: null, parentId: null, origin: "unresolved", signature: null, attributes: { importModule: importedModule },
      };
      if (unresolved) nodes.push(unresolved);
      const targetNode = target ?? unresolved!;
      const resolution: CcmEdge["resolution"] = target ? "Exact" : "Unresolved";
      const edge: CcmEdge = { id: createEdgeId({ snapshotSha: hashSnapshot, sourceId: moduleNode.id, targetId: targetNode.id, kind: "IMPORTS", resolution, evidence: [span], unresolvedReason: target ? null : "EXTERNAL_DEPENDENCY" }), sourceId: moduleNode.id, targetId: targetNode.id, kind: "IMPORTS", resolution, evidence: [span], unresolvedReason: target ? null : "EXTERNAL_DEPENDENCY" };
      edges.push(edge);
    }
  }

  const classNodes = nodes.filter(node => node.language === "python" && node.kind === "Class" && topLevelClassIds.has(node.id));
  for (const node of classNodes) {
    const baseList = typeof node.attributes.bases === "string" ? node.attributes.bases.split(",").map(value => value.trim()).filter(Boolean) : [];
    for (const baseBinding of baseList) {
      if (!/^[A-Za-z_]\w*$/u.test(baseBinding) || !node.filePath) continue;
      const childLine = node.location?.startLine ?? Number.MAX_SAFE_INTEGER;
      const sameFile = (moduleClassesByPath.get(node.filePath) ?? []).filter(candidate => candidate.node.name === baseBinding && candidate.line < childLine);
      const imported = (importedBindingsByPath.get(node.filePath)?.get(baseBinding) ?? []).filter(binding => binding.line < childLine).sort((a, b) => b.line - a.line)[0];
      const assignedLine = (bindingAssignmentsByPath.get(node.filePath)?.get(baseBinding) ?? []).filter(line => line < childLine).sort((a, b) => b - a)[0] ?? 0;
      const uncertainLine = (uncertainBindingLinesByPath.get(node.filePath)?.get(baseBinding) ?? []).filter(line => line < childLine).sort((a, b) => b - a)[0] ?? 0;
      const localClass = sameFile.sort((a, b) => b.line - a.line)[0];
      const candidates = [
        ...(localClass ? [{ line: localClass.line, node: localClass.node }] : []),
        ...(imported ? [{ line: imported.line, node: imported.node }] : []),
        ...(assignedLine && assignedLine !== imported?.line ? [{ line: assignedLine, node: null }] : []),
        ...(uncertainLine ? [{ line: uncertainLine, node: null }] : []),
      ].sort((a, b) => b.line - a.line);
      const latestKnownLine = candidates[0]?.line ?? 0;
      const unknownImportLine = (unknownImportLinesByPath.get(node.filePath) ?? []).filter(line => line < childLine && line > latestKnownLine).sort((a, b) => b - a)[0];
      const target = unknownImportLine ? null : candidates[0]?.node?.kind === "Class" ? candidates[0].node : null;
      if (!target) continue;
      const span = node.location ? { ...node.location, role: "reference" as const } : null; if (!span) continue;
      edges.push({ id: createEdgeId({ snapshotSha: hashSnapshot, sourceId: node.id, targetId: target.id, kind: "EXTENDS", resolution: "Exact", evidence: [span], unresolvedReason: null }), sourceId: node.id, targetId: target.id, kind: "EXTENDS", resolution: "Exact", evidence: [span], unresolvedReason: null });
    }
  }
  const ccm: CcmV1 = { schemaVersion: 1, snapshot: { ...input.snapshot }, provenance: {
    analyzer: { name: "sage-analyzer-python-static", version: VERSION }, resolver: { name: "sage-python-static-resolver", version: VERSION },
    configHash: sha256(`${VERSION}\nline-structured\nno-execution\nfastapi-decorators\nsqlalchemy-hints`),
  }, files, nodes, edges, limitations };
  const sourceBytes = Object.fromEntries(entries);
  const canonical = canonicalizeCcm(ccm, sourceBytes);
  if (!canonical.ok) diagnostics.push({ path: "<snapshot>", code: canonical.errorCode, message: "Python source facts failed CCM validation.", startByte: null, line: null, column: null });
  return { ccm: canonical.ok ? canonical.value : null, diagnostics };
}
