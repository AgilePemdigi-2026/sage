import { compactEvidence, ensureFeatureNode, evidenceSpan, emptyFragment, humanLabel, semanticEdgeId, semanticId } from "./builder.ts";
import type { SemanticEdge, SemanticFragment, SemanticInput, SemanticNode } from "./model.ts";

type Token = { value: string; start: number; end: number; kind: "identifier" | "string" | "number" | "symbol" };
type GroupScope = { prefix: string; middleware: string[]; prefixUnknown: boolean; middlewareUnknown: boolean };
type RouteInfo = { filePath: string; methods: string[]; path: string; controller: string; controllerRef: string; action: string; start: number; end: number; scope: GroupScope };
type HandlerInfo = { start: number; end: number; nameStart: number; nameEnd: number; bodyStart: number; bodyEnd: number };
type PhpMethod = HandlerInfo & { name: string; visibility: "public" | "protected" | "private" | null; parameters: Token[][] };
type PhpClass = { name: string; namespace: string; start: number; end: number; bodyStart: number; bodyEnd: number; methods: Map<string, PhpMethod[]> };
type ServiceClass = { filePath: string; bytes: Uint8Array; source: string; classInfo: PhpClass };
type PhpClassSource = { filePath: string; bytes: Uint8Array; source: string; classInfo: PhpClass };
type MiddlewareAlias = { classRef: string | null; filePath: string; start: number; end: number };
type ServiceCall = { start: number; end: number; target: ServiceClass; method: PhpMethod; bindingEvidence: Array<{ start: number; end: number }> };
const AUTH_MIDDLEWARE = /^(?:auth(?::|$)|auth\.basic)/;

/** Small PHP lexer. It drops comments and treats quoted strings as indivisible tokens. */
function lex(source: string): Token[] {
  const result: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const start = i, c = source[i]!;
    if (/\s/u.test(c)) { i += 1; continue; }
    if (c === "#" || (c === "/" && source[i + 1] === "/")) { while (i < source.length && source[i] !== "\n") i += 1; continue; }
    if (c === "/" && source[i + 1] === "*") { i += 2; while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i += 1; i = Math.min(source.length, i + 2); continue; }
    if (c === "'" || c === '"') {
      const quote = c; i += 1; let value = "";
      while (i < source.length) {
        const ch = source[i]!;
        if (ch === "\\" && i + 1 < source.length) { value += source[i + 1]!; i += 2; continue; }
        if (ch === quote) { i += 1; break; }
        value += ch; i += 1;
      }
      result.push({ value, start, end: i, kind: "string" }); continue;
    }
    if (/[A-Za-z_$\\\u0080-\uffff]/u.test(c)) {
      i += 1; while (i < source.length && /[\w$\\\u0080-\uffff]/u.test(source[i]!)) i += 1;
      result.push({ value: source.slice(start, i), start, end: i, kind: "identifier" }); continue;
    }
    if (/[0-9]/u.test(c)) { i += 1; while (i < source.length && /[\w.]/u.test(source[i]!)) i += 1; result.push({ value: source.slice(start, i), start, end: i, kind: "number" }); continue; }
    const op = ["?->", "::", "->", "=>", "...", "??", "===", "!==", "==", "!=", "<=", ">=", "&&", "||"]
      .find(value => source.startsWith(value, i));
    if (op) { i += op.length; result.push({ value: op, start, end: i, kind: "symbol" }); continue; }
    i += 1; result.push({ value: c, start, end: i, kind: "symbol" });
  }
  return result;
}

function matching(tokens: Token[], start: number, open = "(", close = ")"): number {
  if (tokens[start]?.value !== open) return -1;
  let depth = 0;
  for (let i = start; i < tokens.length; i += 1) {
    if (tokens[i]!.value === open) depth += 1;
    else if (tokens[i]!.value === close && --depth === 0) return i;
  }
  return -1;
}
function splitTop(tokens: Token[], start: number, end: number): Token[][] {
  const out: Token[][] = []; let part: Token[] = [], round = 0, square = 0, curly = 0;
  for (let i = start; i < end; i += 1) {
    const value = tokens[i]!.value;
    if (value === "," && round === 0 && square === 0 && curly === 0) { out.push(part); part = []; continue; }
    if (value === "(") round += 1; else if (value === ")") round -= 1;
    else if (value === "[") square += 1; else if (value === "]") square -= 1;
    else if (value === "{") curly += 1; else if (value === "}") curly -= 1;
    part.push(tokens[i]!);
  }
  if (part.length) out.push(part); return out;
}
function literalString(tokens: Token[]): string | null { return tokens.length === 1 && tokens[0]!.kind === "string" ? tokens[0]!.value : null; }
function simpleArrayStrings(tokens: Token[]): string[] | null {
  if (tokens[0]?.value !== "[" || tokens.at(-1)?.value !== "]") return null;
  const parts = splitTop(tokens, 1, tokens.length - 1), values: string[] = [];
  for (const part of parts) { const value = literalString(part); if (value === null) return null; values.push(value); }
  return values;
}
function callArgs(tokens: Token[], openIndex: number): { args: Token[][]; close: number } | null {
  const close = matching(tokens, openIndex); return close < 0 ? null : { args: splitTop(tokens, openIndex + 1, close), close };
}
function routeMethods(method: string, args: Token[][]): string[] | null {
  if (method === "match") return args[0] ? simpleArrayStrings(args[0])?.map(item => item.toUpperCase()) ?? null : null;
  return [method.toLowerCase()];
}
function classAction(tokens: Token[]): { controller: string; controllerRef: string; action: string } | null {
  if (tokens[0]?.value !== "[" || tokens.at(-1)?.value !== "]") return null;
  const parts = splitTop(tokens, 1, tokens.length - 1);
  if (parts.length !== 2 || parts[0]!.at(-1)?.value !== "class" || parts[1]!.length !== 1 || parts[1]![0]!.kind !== "string") return null;
  const classToken = parts[0]!.slice(0, -2).map(token => token.value).join("").replace(/^\\/u, "");
  const controller = classToken.split("\\").filter(Boolean).at(-1);
  return controller ? { controller, controllerRef: classToken, action: parts[1]![0]!.value } : null;
}
function joinPrefix(prefix: string, child: string): string { return `/${[prefix, child].map(x => x.replace(/^\/+|\/+$/gu, "")).filter(Boolean).join("/")}` || "/"; }
function applicationPhpSource(path: string): boolean {
  return !/(?:^|\/)(?:vendor|node_modules|generated|storage|tests?|fixtures?|mocks?|build|dist)(?:\/|$)/iu.test(path.replaceAll("\\", "/"));
}
function optionsScope(tokens: Token[], scope: GroupScope, limitations: Array<{ filePath: string; reason: string }>, filePath: string): GroupScope {
  const next = { ...scope, middleware: [...scope.middleware] };
  for (const part of splitTop(tokens, 1, tokens.length - 1)) {
    const arrow = part.findIndex(token => token.value === "=>"); if (arrow < 0) continue;
    const key = literalString(part.slice(0, arrow)), value = part.slice(arrow + 1);
    if (key === "prefix") {
      const parsed = literalString(value);
      if (parsed !== null) next.prefix = joinPrefix(next.prefix, parsed);
      else { next.prefixUnknown = true; limitations.push({ filePath, reason: "Route group memiliki prefix dinamis; endpoint di dalamnya tidak ditampilkan karena path tidak dapat dibuktikan." }); }
    }
    if (key === "middleware") {
      const literal = literalString(value), strings = literal === null ? simpleArrayStrings(value) : [literal];
      if (strings) next.middleware.push(...strings);
      else { next.middlewareUnknown = true; limitations.push({ filePath, reason: "Route group memiliki middleware dinamis; pengenal aktor atau autentikasi untuk route turunannya tidak disimpulkan." }); }
    }
  }
  return next;
}
function closureBody(tokens: Token[], start: number, end: number): { from: number; to: number } | null {
  for (let i = start; i < end; i += 1) {
    if (tokens[i]!.value !== "function") continue;
    let brace = i + 1; while (brace < end && tokens[brace]!.value !== "{") brace += 1;
    if (brace >= end) return null;
    const close = matching(tokens, brace, "{", "}"); return close > brace && close < end ? { from: brace + 1, to: close } : null;
  }
  return null;
}

function parseRouteStatements(tokens: Token[], start: number, end: number, scope: GroupScope, out: RouteInfo[], limitations: Array<{ filePath: string; reason: string }>, filePath: string): void {
  for (let i = start; i + 3 < end; i += 1) {
    if (tokens[i]!.value.replace(/^\\/u, "").split("\\").at(-1)?.toLowerCase() !== "route" || tokens[i + 1]!.value !== "::" || tokens[i + 3]!.value !== "(") continue;
    const method = tokens[i + 2]!.value.toLowerCase(); const parsed = callArgs(tokens, i + 3); if (!parsed) continue;
    if (method === "group") {
      const local = parsed.args[0]?.[0]?.value === "[" ? optionsScope(parsed.args[0]!, scope, limitations, filePath) : { ...scope, middleware: [...scope.middleware] };
      if (parsed.args[0]?.[0]?.value !== "[") {
        local.prefixUnknown = true; local.middlewareUnknown = true;
        limitations.push({ filePath, reason: "Konfigurasi Route::group tidak literal; prefix dan middleware tidak disimpulkan dan route turunan disembunyikan." });
      }
      const closure = closureBody(tokens, i + 4, parsed.close);
      if (closure) { parseRouteStatements(tokens, closure.from, closure.to, local, out, limitations, filePath); i = closure.to; }
      else { limitations.push({ filePath, reason: "Route group memakai callback dinamis yang tidak bisa ditelusuri." }); i = parsed.close; }
      continue;
    }
    if (["prefix", "middleware", "domain", "name", "where", "withoutmiddleware"].includes(method)) {
      const local = { ...scope, middleware: [...scope.middleware] };
      if (method === "prefix" && parsed.args[0]) {
        const value = literalString(parsed.args[0]);
        if (value !== null) local.prefix = joinPrefix(local.prefix, value);
        else { local.prefixUnknown = true; limitations.push({ filePath, reason: "Route memiliki prefix dinamis; endpoint tidak ditampilkan karena path tidak dapat dibuktikan." }); }
      }
      if (method === "middleware" && parsed.args[0]) {
        const literal = literalString(parsed.args[0]), values = literal === null ? simpleArrayStrings(parsed.args[0]!) : [literal];
        if (values) local.middleware.push(...values);
        else { local.middlewareUnknown = true; limitations.push({ filePath, reason: "Route memiliki middleware dinamis; autentikasi dan aktor tidak disimpulkan." }); }
      }
      if (method === "domain" && parsed.args[0] && literalString(parsed.args[0]) === null) limitations.push({ filePath, reason: "Route domain dinamis tidak dapat ditentukan; route tetap dicatat berdasarkan path literal saja." });
      let cursor = parsed.close + 1, chainEnd = cursor;
      while (cursor + 1 < end && tokens[cursor]!.value === "->" && tokens[cursor + 2]?.value === "(") {
        const chainStart = cursor;
        const chainMethod = tokens[cursor + 1]!.value.toLowerCase(), chain = callArgs(tokens, cursor + 2); if (!chain) break;
        if (chainMethod === "prefix" && chain.args[0]) {
          const value = literalString(chain.args[0]);
          if (value !== null) local.prefix = joinPrefix(local.prefix, value);
          else { local.prefixUnknown = true; limitations.push({ filePath, reason: "Fluent Route memiliki prefix dinamis; endpoint tidak ditampilkan karena path tidak dapat dibuktikan." }); }
        }
        if (chainMethod === "middleware" && chain.args[0]) {
          const literal = literalString(chain.args[0]), values = literal === null ? simpleArrayStrings(chain.args[0]!) : [literal];
          if (values) local.middleware.push(...values);
          else { local.middlewareUnknown = true; limitations.push({ filePath, reason: "Fluent Route memiliki middleware dinamis; autentikasi dan aktor tidak disimpulkan." }); }
        }
        if (chainMethod === "domain" && chain.args[0] && literalString(chain.args[0]) === null) limitations.push({ filePath, reason: "Fluent Route memiliki domain dinamis; domain tidak disimpulkan dari path." });
        chainEnd = chain.close + 1; cursor = chain.close + 1;
        if (chainMethod === "group") {
          const closure = closureBody(tokens, chainStart + 3, chain.close);
          if (closure) { parseRouteStatements(tokens, closure.from, closure.to, local, out, limitations, filePath); i = closure.to; }
          else { limitations.push({ filePath, reason: "Route group memakai callback dinamis yang tidak bisa ditelusuri." }); i = chain.close; }
          break;
        }
      }
      if (chainEnd > parsed.close + 1) i = Math.max(i, chainEnd - 1);
      else limitations.push({ filePath, reason: `Route ${method} memakai fluent modifier di luar group; endpoint belum ditautkan.` });
      continue;
    }
    const methods = routeMethods(method, parsed.args); const pathArg = method === "match" ? parsed.args[1] : parsed.args[0];
    const path = pathArg ? literalString(pathArg) : null;
    const actionArg = parsed.args.find(arg => classAction(arg) !== null); const action = actionArg ? classAction(actionArg) : null;
    if (!methods || !path || !action || !methods.length) {
      if (["get", "post", "put", "patch", "delete", "head", "options", "match", "any"].includes(method)) limitations.push({ filePath, reason: `Route ${method.toUpperCase()} dinamis atau callback tidak dapat ditautkan ke controller secara statis.` });
      else if (["resource", "apiresource", "controller", "redirect", "view", "fallback"].includes(method)) limitations.push({ filePath, reason: `Deklarasi Route::${method} belum diperluas menjadi endpoint; alurnya tidak ditampilkan sebagai fakta.` });
      else limitations.push({ filePath, reason: `Deklarasi Route::${method} belum didukung; alurnya tidak ditampilkan sebagai fakta.` });
      i = parsed.close; continue;
    }
    if (scope.prefixUnknown) { i = parsed.close; continue; }
    const routeScope = { ...scope, middleware: [...scope.middleware] };
    let routeEnd = parsed.close, modifier = parsed.close + 1;
    while (modifier + 2 < end && tokens[modifier]!.value === "->" && tokens[modifier + 2]!.value === "(") {
      const name = tokens[modifier + 1]!.value.toLowerCase(), call = callArgs(tokens, modifier + 2);
      if (!call) break;
      routeEnd = call.close;
      if (name === "middleware" && call.args[0]) {
        const literal = literalString(call.args[0]), values = literal === null ? simpleArrayStrings(call.args[0]!) : [literal];
        if (values) routeScope.middleware.push(...values);
        else { routeScope.middlewareUnknown = true; limitations.push({ filePath, reason: "Route-level middleware dinamis; autentikasi dan aktor tidak disimpulkan." }); }
      } else if (name === "withoutmiddleware") {
        const literal = call.args[0] ? literalString(call.args[0]!) : null, values = literal === null && call.args[0] ? simpleArrayStrings(call.args[0]!) : literal === null ? null : [literal];
        if (values) routeScope.middleware = routeScope.middleware.filter(value => !values.includes(value));
        else { routeScope.middlewareUnknown = true; limitations.push({ filePath, reason: "Route-level withoutMiddleware dinamis; status autentikasi tidak disimpulkan." }); }
      }
      modifier = call.close + 1;
    }
    if (routeScope.middlewareUnknown) limitations.push({ filePath, reason: `Route ${method.toUpperCase()} ${path} memiliki middleware dinamis; endpoint dicatat dengan aktor generik tanpa klaim akses publik atau terautentikasi.` });
    out.push({ filePath, methods, path: joinPrefix(routeScope.prefix, path), controller: action.controller, controllerRef: action.controllerRef, action: action.action, start: tokens[i]!.start, end: tokens[routeEnd]!.end, scope: routeScope });
    i = routeEnd;
  }
}
function findHandlers(tokens: Token[]): Map<string, HandlerInfo[]> {
  const map = new Map<string, HandlerInfo[]>();
  for (let i = 0; i + 3 < tokens.length; i += 1) {
    if (tokens[i]!.value !== "function" || tokens[i + 1]!.value !== "&" && tokens[i + 1]!.value !== "(" && !/^[A-Za-z_]/u.test(tokens[i + 1]!.value)) continue;
    let nameAt = i + 1; if (tokens[nameAt]!.value === "&") nameAt += 1;
    if (tokens[nameAt]!.value === "(") continue;
    const name = tokens[nameAt]!.value.toLowerCase(); let open = nameAt + 1; while (open < tokens.length && tokens[open]!.value !== "{") open += 1;
    const close = matching(tokens, open, "{", "}"); if (close < 0) continue;
    const list = map.get(name) ?? []; list.push({ start: tokens[i]!.start, end: tokens[close]!.end, nameStart: tokens[nameAt]!.start, nameEnd: tokens[nameAt]!.end, bodyStart: open + 1, bodyEnd: close }); map.set(name, list); i = nameAt;
  }
  return map;
}
function routeClassImports(source: string): Map<string, string> {
  const tokens = lex(source), imports = new Map<string, string>();
  for (let i = 0; i + 1 < tokens.length; i += 1) {
    if (tokens[i]!.value !== "use" || tokens[i + 1]!.value === "(" || ["function", "const"].includes(tokens[i + 1]!.value.toLowerCase())) continue;
    let end = i + 1; while (end < tokens.length && tokens[end]!.value !== ";") end += 1;
    const name = tokens[i + 1]!.value.replace(/^\\/u, "");
    if (!name || name === "{") continue;
    const aliasAt = tokens.slice(i + 2, end).findIndex(token => token.value.toLowerCase() === "as");
    const alias = aliasAt >= 0 ? tokens[i + 2 + aliasAt + 1]?.value : name.split("\\").at(-1);
    if (alias) imports.set(alias.toLowerCase(), name);
    i = end;
  }
  return imports;
}
function resolveControllerPath(controllerRef: string, routeSource: string, classIndex: PhpClassSource[]): string | null {
  const imports = routeClassImports(routeSource), namespace = imports.get(controllerRef.split("\\")[0]!.toLowerCase());
  const resolved = namespace ? [namespace, ...controllerRef.split("\\").slice(1)].join("\\") : controllerRef;
  const exact = classIndex.filter(item => `${item.classInfo.namespace ? `${item.classInfo.namespace}\\` : ""}${item.classInfo.name}`.toLowerCase() === resolved.toLowerCase());
  return exact.length === 1 ? exact[0]!.filePath : null;
}
function phpClassDeclaration(source: string): { name: string; start: number; end: number } | null {
  const tokens = lex(source);
  for (let i = 0; i + 1 < tokens.length; i += 1) if (tokens[i]!.value === "class" && tokens[i + 1]!.kind === "identifier") return { name: tokens[i + 1]!.value, start: tokens[i]!.start, end: tokens[i + 1]!.end };
  return null;
}
function phpClassName(source: string): string | null { return phpClassDeclaration(source)?.name ?? null; }
function eloquentClass(source: string): { name: string; start: number; end: number } | null {
  const tokens = lex(source);
  for (let i = 0; i + 1 < tokens.length; i += 1) {
    if (tokens[i]!.value !== "class" || tokens[i + 1]!.kind !== "identifier") continue;
    const name = tokens[i + 1]!;
    let open = i + 2, parent: string | null = null;
    while (open < tokens.length && tokens[open]!.value !== "{") {
      if (tokens[open]!.value === "extends" && tokens[open + 1]?.kind === "identifier") parent = tokens[open + 1]!.value.replace(/^\\/u, "");
      open += 1;
    }
    if (parent && ["Model", "Authenticatable", "Pivot", "Illuminate\\Database\\Eloquent\\Model"].includes(parent)) return { name: name.value, start: tokens[i]!.start, end: name.end };
    return null;
  }
  return null;
}
function phpClasses(source: string): PhpClass[] {
  const tokens = lex(source), result: PhpClass[] = [];
  let namespace = "";
  for (let i = 0; i + 1 < tokens.length; i += 1) {
    if (tokens[i]!.value === "namespace") {
      let end = i + 1; while (end < tokens.length && tokens[end]!.value !== ";" && tokens[end]!.value !== "{") end += 1;
      namespace = tokens.slice(i + 1, end).map(token => token.value).join("").replace(/^\\|\\$/gu, "");
      continue;
    }
    if (tokens[i]!.value !== "class" || tokens[i + 1]!.kind !== "identifier" || tokens[i - 1]?.value === "new") continue;
    let open = i + 2;
    while (open < tokens.length && tokens[open]!.value !== "{" && tokens[open]!.value !== ";") open += 1;
    if (tokens[open]?.value !== "{") continue;
    const close = matching(tokens, open, "{", "}"); if (close < 0) continue;
    const methods = new Map<string, PhpMethod[]>();
    for (let j = open + 1; j < close; j += 1) {
      if (tokens[j]!.value !== "function") continue;
      let nameAt = j + 1; if (tokens[nameAt]?.value === "&") nameAt += 1;
      if (!tokens[nameAt] || tokens[nameAt]!.kind !== "identifier" || tokens[nameAt + 1]?.value !== "(") continue;
      const paramsClose = matching(tokens, nameAt + 1); if (paramsClose < 0) continue;
      let bodyOpen = paramsClose + 1; while (bodyOpen < close && tokens[bodyOpen]!.value !== "{" && tokens[bodyOpen]!.value !== ";") bodyOpen += 1;
      if (tokens[bodyOpen]?.value !== "{") { j = bodyOpen; continue; }
      const bodyClose = matching(tokens, bodyOpen, "{", "}"); if (bodyClose < 0) continue;
      let visibility: PhpMethod["visibility"] = null;
      for (let before = j - 1; before >= Math.max(open + 1, j - 7); before -= 1) {
        const value = tokens[before]!.value.toLowerCase();
        if (["public", "protected", "private"].includes(value)) { visibility = value as NonNullable<PhpMethod["visibility"]>; break; }
        if ([";", "{", "}"].includes(value)) break;
      }
      const name = tokens[nameAt]!.value.toLowerCase();
      const method: PhpMethod = {
        name, visibility,
        start: tokens[j]!.start, end: tokens[bodyClose]!.end,
        nameStart: tokens[nameAt]!.start, nameEnd: tokens[nameAt]!.end,
        bodyStart: bodyOpen + 1, bodyEnd: bodyClose,
        parameters: splitTop(tokens, nameAt + 2, paramsClose),
      };
      const list = methods.get(name) ?? []; list.push(method); methods.set(name, list); j = bodyClose;
    }
    result.push({ name: tokens[i + 1]!.value, namespace, start: tokens[i]!.start, end: tokens[close]!.end, bodyStart: open + 1, bodyEnd: close, methods });
    i = close;
  }
  return result;
}
function resolvePhpClassRef(reference: string, namespace: string, imports: Map<string, string>): string {
  const absolute = reference.startsWith("\\"), clean = reference.replace(/^\\/u, "");
  if (absolute) return clean;
  const [first, ...rest] = clean.split("\\");
  const imported = imports.get(first!.toLowerCase());
  if (imported) return [imported, ...rest].join("\\");
  return namespace ? `${namespace}\\${clean}` : clean;
}
function isServicePath(path: string): boolean { return applicationPhpSource(path) && /(?:^|\/)Services?\//iu.test(path) && path.endsWith(".php"); }
function buildServiceIndex(paths: string[], sources: Readonly<Record<string, Uint8Array>>): ServiceClass[] {
  const result: ServiceClass[] = [];
  for (const filePath of paths.filter(isServicePath)) {
    const bytes = sources[filePath]!, source = new TextDecoder().decode(bytes);
    for (const classInfo of phpClasses(source)) result.push({ filePath, bytes, source, classInfo });
  }
  return result;
}
function buildPhpClassIndex(paths: string[], sources: Readonly<Record<string, Uint8Array>>): PhpClassSource[] {
  const result: PhpClassSource[] = [];
  for (const filePath of paths.filter(path => applicationPhpSource(path) && path.endsWith(".php"))) {
    const bytes = sources[filePath]!, source = new TextDecoder().decode(bytes);
    for (const classInfo of phpClasses(source)) result.push({ filePath, bytes, source, classInfo });
  }
  return result;
}
function resolveIndexedClass(reference: string, index: PhpClassSource[]): PhpClassSource | null {
  const exact = index.filter(item => `${item.classInfo.namespace ? `${item.classInfo.namespace}\\` : ""}${item.classInfo.name}`.toLowerCase() === reference.toLowerCase());
  if (exact.length === 1) return exact[0]!;
  return null;
}
function phpNamespace(source: string): string { return phpClasses(source)[0]?.namespace ?? ""; }
function parseMiddlewareAliases(paths: string[], sources: Readonly<Record<string, Uint8Array>>): Map<string, MiddlewareAlias | null> {
  const aliases = new Map<string, MiddlewareAlias | null>();
  const invalidateDynamic = (tokens: Token[], start: number, end: number) => {
    for (const key of aliases.keys()) aliases.set(key, null);
    for (let i = start; i + 1 < end; i += 1) {
      const key = literalString([tokens[i]!]);
      if (key !== null && tokens[i + 1]!.value === "=>") aliases.set(key.toLowerCase(), null);
    }
  };
  const files = paths.filter(path => applicationPhpSource(path) && (/(?:^|\/)bootstrap\/app\.php$/u.test(path) || /(?:^|\/)app\/Http\/Kernel\.php$/u.test(path)));
  for (const filePath of files) {
    const bytes = sources[filePath]!, source = new TextDecoder().decode(bytes), tokens = lex(source), imports = routeClassImports(source), namespace = phpNamespace(source);
    const register = (open: number, close: number) => {
      for (const entry of splitTop(tokens, open + 1, close)) {
        const arrow = entry.findIndex(token => token.value === "=>"), name = arrow > 0 ? literalString(entry.slice(0, arrow)) : null;
        if (!name) continue;
        const classAt = entry.findIndex((token, index) => token.value === "::" && entry[index + 1]?.value.toLowerCase() === "class");
        const reference = classAt > arrow ? resolvePhpClassRef(entry.slice(arrow + 1, classAt).map(token => token.value).join(""), namespace, imports) : null;
        const value: MiddlewareAlias = { classRef: reference, filePath, start: entry[0]!.start, end: entry.at(-1)!.end };
        const key = name.toLowerCase(), prior = aliases.get(key);
        aliases.set(key, prior === undefined ? value : prior && prior.classRef === value.classRef ? prior : null);
      }
    };
    for (let i = 0; i + 2 < tokens.length; i += 1) {
      if (tokens[i]!.value.toLowerCase() === "alias" && tokens[i + 1]!.value === "(") {
        const call = callArgs(tokens, i + 1), argument = call?.args[0];
        if (call && argument) {
          const open = argument[0]?.value === "[" ? i + 2 : -1;
          const close = open >= 0 ? matching(tokens, open, "[", "]") : -1;
          if (close > open && close === i + 1 + argument.length) register(open, close);
          else invalidateDynamic(tokens, i + 2, call.close);
          i = call.close;
        }
      }
      if (["$routeMiddleware", "$middlewareAliases"].includes(tokens[i]!.value) && tokens[i + 1]?.value === "=") {
        const right = i + 2;
        let end = right; while (end < tokens.length && tokens[end]!.value !== ";") end += 1;
        const open = tokens[right]?.value === "[" ? right : -1;
        const close = tokens[open]?.value === "[" ? matching(tokens, open, "[", "]") : -1;
        if (close > open && close === end - 1) register(open, close);
        else invalidateDynamic(tokens, right, end);
        i = end;
      }
    }
  }
  return aliases;
}
function serviceClassFor(reference: string, services: ServiceClass[]): ServiceClass | null {
  const resolved = reference.toLowerCase();
  const exact = services.filter(item => `${item.classInfo.namespace ? `${item.classInfo.namespace}\\` : ""}${item.classInfo.name}`.toLowerCase() === resolved);
  if (exact.length === 1) return exact[0]!;
  return null;
}
function serviceLike(reference: string): boolean {
  return /(?:^|\\)(?:[\w]+Service|[\w]+ServiceInterface|[\w]+Manager|[\w]+Processor|[\w]+Gateway)$/iu.test(reference) || /(?:^|\\)Services?\\/iu.test(reference);
}
function controllerServiceBindings(tokens: Token[], handler: HandlerInfo, source: string): { owner: PhpClass | null; bindings: Map<string, { reference: string; evidence: Array<{ start: number; end: number }> }>; parameters: Map<string, string> } {
  const owner = phpClasses(source).find(item => handler.start >= item.start && handler.start < item.end) ?? null;
  const bindings = new Map<string, { reference: string; evidence: Array<{ start: number; end: number }> }>(), parameters = new Map<string, string>();
  const constructors = owner?.methods.get("__construct") ?? [];
  if (constructors.length !== 1 || !owner) return { owner, bindings, parameters };
  const constructor = constructors[0]!, imports = routeClassImports(source);
  for (const parameter of constructor.parameters) {
    const variableIndex = parameter.findIndex(token => token.kind === "identifier" && token.value.startsWith("$"));
    if (variableIndex < 0 || parameter.slice(0, variableIndex).some(token => token.value === "|")) continue;
    const variable = parameter[variableIndex]!, typeTokens = parameter.slice(0, variableIndex).filter(token => token.kind === "identifier" && !["public", "protected", "private", "readonly", "static", "final"].includes(token.value.toLowerCase()));
    const type = typeTokens.at(-1)?.value;
    if (!type || ["string", "int", "float", "bool", "array", "iterable", "mixed", "object", "callable", "self", "static", "parent"].includes(type.toLowerCase())) continue;
    const reference = resolvePhpClassRef(type, owner.namespace, imports), parameterEvidence = { start: parameter[0]!.start, end: variable.end };
    parameters.set(variable.value.slice(1), reference);
    const promoted = parameter.slice(0, variableIndex).some(token => ["public", "protected", "private"].includes(token.value.toLowerCase()));
    if (promoted) {
      bindings.set(variable.value.slice(1), { reference, evidence: [parameterEvidence] });
      continue;
    }
    for (let i = constructor.bodyStart; i + 4 < constructor.bodyEnd; i += 1) {
      if (tokens[i]!.value !== "$this" || !["->", "?->"].includes(tokens[i + 1]!.value) || tokens[i + 3]!.value !== "=" || tokens[i + 4]!.value !== variable.value) continue;
      const assignment = { start: tokens[i]!.start, end: tokens[i + 4]!.end };
      bindings.set(tokens[i + 2]!.value, { reference, evidence: [parameterEvidence, assignment] });
    }
  }
  return { owner, bindings, parameters };
}
function findServiceCalls(tokens: Token[], handler: HandlerInfo, controllerSource: string, services: ServiceClass[]): { calls: ServiceCall[]; limitations: string[] } {
  const { owner, bindings, parameters } = controllerServiceBindings(tokens, handler, controllerSource);
  const calls: ServiceCall[] = [], limitations: string[] = [];
  if (!owner) return { calls, limitations };
  const imports = routeClassImports(controllerSource);
  const reportUnresolved = (label: string) => limitations.push(`Service call ${label} tidak dapat dihubungkan ke satu method source secara statis.`);
  const add = (start: number, end: number, reference: string, methodName: string, bindingEvidence: Array<{ start: number; end: number }>) => {
    const target = serviceClassFor(reference, services);
    if (!target) { reportUnresolved(`${reference}@${methodName}`); return; }
    const methods = target.classInfo.methods.get(methodName.toLowerCase()) ?? [];
    if (methods.length !== 1 || methods[0]!.visibility === "private" || methods[0]!.visibility === "protected") { reportUnresolved(`${target.classInfo.name}@${methodName}`); return; }
    calls.push({ start, end, target, method: methods[0]!, bindingEvidence });
  };
  for (let i = handler.bodyStart; i + 5 < handler.bodyEnd; i += 1) {
    if (tokens[i]!.value === "$this" && ["->", "?->"].includes(tokens[i + 1]!.value) && ["->", "?->"].includes(tokens[i + 3]!.value) && tokens[i + 4]!.kind === "identifier" && tokens[i + 5]!.value === "(") {
      const property = tokens[i + 2]!.value, methodName = tokens[i + 4]!.value, callClose = matching(tokens, i + 5);
      const binding = bindings.get(property);
      if (binding) add(tokens[i]!.start, tokens[callClose > 0 ? callClose : i + 5]!.end, binding.reference, methodName, binding.evidence);
      else if (parameters.has(property) || /(?:service|manager|processor|gateway|repository)$/iu.test(property)) reportUnresolved(`$this->${property}->${methodName}`);
    }
  }
  const localAssignments = new Map<string, Array<{ index: number; reference: string | null; start: number; end: number }>>();
  for (let i = handler.bodyStart; i + 3 < handler.bodyEnd; i += 1) {
    if (tokens[i]!.kind !== "identifier" || !tokens[i]!.value.startsWith("$") || tokens[i + 1]!.value !== "=" || tokens[i + 2]!.value !== "new") continue;
    const type = tokens[i + 3]!;
    if (type.kind !== "identifier" || type.value.startsWith("$")) {
      const list = localAssignments.get(tokens[i]!.value.slice(1)) ?? []; list.push({ index: i, reference: null, start: tokens[i]!.start, end: type.end }); localAssignments.set(tokens[i]!.value.slice(1), list); continue;
    }
    const reference = resolvePhpClassRef(type.value, owner.namespace, imports);
    const list = localAssignments.get(tokens[i]!.value.slice(1)) ?? []; list.push({ index: i, reference, start: tokens[i]!.start, end: type.end }); localAssignments.set(tokens[i]!.value.slice(1), list);
  }
  for (let i = handler.bodyStart; i + 3 < handler.bodyEnd; i += 1) {
    if (tokens[i]!.kind !== "identifier" || !tokens[i]!.value.startsWith("$") || ["$this", "$request"].includes(tokens[i]!.value) || !["->", "?->"].includes(tokens[i + 1]!.value) || tokens[i + 2]!.kind !== "identifier" || tokens[i + 3]!.value !== "(") continue;
    const variable = tokens[i]!.value.slice(1), candidates = localAssignments.get(variable)?.filter(item => item.index < i) ?? [];
    const latest = candidates.at(-1);
    if (!latest) continue;
    const reassigned = tokens.slice(latest.index + 1, i).some((token, offset, slice) => token.value === `$${variable}` && slice[offset + 1]?.value === "=");
    const methodName = tokens[i + 2]!.value, callClose = matching(tokens, i + 3);
    if (reassigned || !latest.reference) {
      if (!latest.reference || serviceLike(latest.reference)) reportUnresolved(`$${variable}->${methodName}`);
      continue;
    }
    if (serviceClassFor(latest.reference, services) || serviceLike(latest.reference)) add(tokens[i]!.start, tokens[callClose > 0 ? callClose : i + 3]!.end, latest.reference, methodName, [{ start: latest.start, end: latest.end }]);
  }
  return { calls: [...new Map(calls.map(call => [`${call.start}:${call.target.filePath}:${call.method.nameStart}`, call])).values()], limitations: [...new Set(limitations)] };
}
function literalHttpStatus(tokens: Token[]): Token | null {
  return tokens.length === 1 && tokens[0]!.kind === "number" && /^(?:[1-5]\d\d)$/u.test(tokens[0]!.value) ? tokens[0]! : null;
}
function explicitResponseStatus(tokens: Token[], returnAt: number, statementEnd: number): Token | null {
  for (let i = returnAt + 1; i < statementEnd; i += 1) {
    if (tokens[i + 1]?.value !== "(") continue;
    const call = callArgs(tokens, i + 1); if (!call) continue;
    const method = tokens[i]!.value.toLowerCase();
    let status: Token | null = null;
    if (["json", "response", "jsonresponse", "setstatuscode"].includes(method)) {
      for (const argument of call.args) {
        const named = argument.findIndex((item, index) => item.value.toLowerCase() === "status" && argument[index + 1]?.value === ":");
        if (named >= 0) status = literalHttpStatus(argument.slice(named + 2));
        if (status) break;
      }
      if (!status) {
        const positional = method === "setstatuscode" ? call.args[0] : call.args[1];
        if (positional) status = literalHttpStatus(positional);
      }
    }
    if (status) return status;
    i = call.close;
  }
  return null;
}

function conditionPresentation(tokens: Token[], source: string, start: number, end: number): { label: string; detail: string } {
  const conditionTokens = tokens.slice(start, end);
  const words = conditionTokens.map(token => token.value.toLowerCase().replace(/^\$/u, ""));
  const hasAny = (...needles: string[]) => words.some(word => needles.includes(word));
  const detail = source.slice(conditionTokens[0]?.start ?? 0, conditionTokens.at(-1)?.end ?? 0).trim().slice(0, 800);

  if (hasAny("is_admin", "isadmin", "hasrole", "has_role") || (hasAny("role", "permission", "can") && words.includes("admin"))) {
    return { label: "Pemeriksaan izin administrator", detail };
  }
  if (hasAny("role", "permission", "haspermission", "has_permission", "can")) return { label: "Pemeriksaan peran atau izin", detail };
  if (hasAny("user", "auth", "authenticated", "loggedin", "logged_in", "guest")) return { label: "Pemeriksaan autentikasi", detail };
  if (hasAny("request") && hasAny("input", "has", "filled", "validate", "required", "isset", "empty", "exists")) return { label: "Kelengkapan input", detail };
  if (hasAny("today", "yesterday", "wheredate")) return { label: "Pemeriksaan data hari ini", detail };
  if (hasAny("exists", "find", "first", "count", "is_null", "isnull")) return { label: "Pemeriksaan keberadaan data", detail };

  const businessVariable = conditionTokens.find(token => token.kind === "identifier" && token.value.startsWith("$") && !["$this", "$request", "$user", "$next"].includes(token.value.toLowerCase()));
  if (businessVariable) return { label: `Periksa ${humanLabel(businessVariable.value.slice(1))}`, detail };
  return { label: "Pemeriksaan kondisi bisnis", detail };
}

function functionDecisions(
  tokens: Token[], handler: HandlerInfo, source: string, bytes: Uint8Array, file: string,
  technicalNodeIds: string[], componentId: string, featureId: string,
  addNode: (node: SemanticNode) => string, addEdge: (edge: SemanticEdge) => string,
  context: "controller" | "middleware" = "controller",
): { nodeIds: string[]; edgeIds: string[] } {
  const nodeIds: string[] = [], edgeIds: string[] = [];
  const decisions: Array<{ token: Token; label: string; status: string; detail?: string; conditionClose?: number; branchFrom?: number; branchTo?: number }> = [];
  const outcomes: Array<{ token: Token; end: number; label: string }> = [];
  for (let i = handler.bodyStart; i < handler.bodyEnd; i += 1) {
    const token = tokens[i]!;
    if (token.value === "if" && tokens[i + 1]?.value === "(") {
      const close = matching(tokens, i + 1); if (close > 0) {
        const condition = conditionPresentation(tokens, source, i + 2, close);
        let branchFrom = close + 1, branchTo = close;
        while (branchFrom < handler.bodyEnd && tokens[branchFrom]!.value === ")") branchFrom += 1;
        if (tokens[branchFrom]?.value === "{") { const branchClose = matching(tokens, branchFrom, "{", "}"); if (branchClose > branchFrom) { branchFrom += 1; branchTo = branchClose; } }
        else { branchTo = branchFrom; while (branchTo < handler.bodyEnd && tokens[branchTo]!.value !== ";") branchTo += 1; }
        decisions.push({ token, label: condition.label, detail: condition.detail, status: "guard", conditionClose: close, branchFrom, branchTo });
      }
    }
    if (["abort", "abort_if", "abort_unless"].includes(token.value) && tokens[i + 1]?.value === "(") {
      const close = matching(tokens, i + 1);
      const args = close > 0 ? splitTop(tokens, i + 2, close) : [];
      const statusArg = token.value === "abort" ? args[0] : args[1];
      const code = statusArg ? literalHttpStatus(statusArg)?.value : null;
      decisions.push({ token, label: `Permintaan ditolak${code ? ` (HTTP ${code})` : ""}`, status: "abort" });
    }
    if (token.value === "throw" && tokens[i + 1]?.value === "new") decisions.push({ token, label: "Kegagalan melempar exception", status: "exception" });
    if (token.value === "validate" && tokens[i - 1]?.value === "->") decisions.push({ token, label: "Validasi input", status: "validation" });
    if (token.value === "return") {
      let end = i + 1; while (end < handler.bodyEnd && tokens[end]!.value !== ";" && end < i + 45) end += 1;
      const status = explicitResponseStatus(tokens, i, end);
      if (status) outcomes.push({ token, end: status.end, label: `Mengembalikan respons HTTP ${status.value}` });
    }
  }
  const unique = new Map<string, typeof decisions[number]>(); for (const decision of decisions) unique.set(`${decision.token.start}:${decision.label}`, decision);
  for (const decision of unique.values()) {
    const id = semanticId("decision", file, Buffer.byteLength(source.slice(0, decision.token.start), "utf8"), decision.label);
    const decisionEnd = decision.conditionClose === undefined ? decision.token.end : tokens[decision.conditionClose]!.end;
    const reason = decision.status === "guard"
      ? `Percabangan if eksplisit dalam ${context === "middleware" ? "middleware" : "controller"} yang dirujuk route. Kondisi source: ${decision.detail ?? "tidak tersedia"}.`
      : `Pemeriksaan atau hasil kegagalan eksplisit dalam ${context === "middleware" ? "middleware" : "controller"} yang dirujuk route.`;
    const node: SemanticNode = { id, kind: "decision", label: humanLabel(decision.label), featureId, confidence: "proven", reason, evidence: [evidenceSpan(file, bytes, decision.token.start, decisionEnd, "declaration")], technicalNodeIds };
    nodeIds.push(addNode(node));
    edgeIds.push(addEdge({ id: semanticEdgeId(file, Buffer.byteLength(source.slice(0, decision.token.start), "utf8"), `handler-decision:${componentId}:${id}`), source: componentId, target: id, label: decision.status === "guard" ? "memeriksa" : decision.status === "validation" ? "memvalidasi" : "menangani", confidence: "proven", reason: node.reason, evidence: node.evidence }));
  }
  for (const outcome of outcomes) {
    const id = semanticId("outcome", file, Buffer.byteLength(source.slice(0, outcome.token.start), "utf8"), outcome.label);
    const evidence = [evidenceSpan(file, bytes, outcome.token.start, outcome.end, "reference")];
    nodeIds.push(addNode({ id, kind: "outcome", label: outcome.label, featureId, confidence: "proven", reason: `Kode mengembalikan status HTTP yang eksplisit dalam ${context === "middleware" ? "middleware" : "controller"} route.`, evidence, technicalNodeIds }));
    edgeIds.push(addEdge({ id: semanticEdgeId(file, Buffer.byteLength(source.slice(0, outcome.token.start), "utf8"), `handler-outcome:${componentId}:${id}`), source: componentId, target: id, label: "menghasilkan", confidence: "proven", reason: "Return status HTTP literal dalam handler.", evidence }));
    const owner = [...unique.values()].filter(item => item.status === "guard" && item.branchFrom !== undefined && outcome.token.start >= tokens[item.branchFrom]!.start && outcome.token.start <= tokens[item.branchTo!]!.end).sort((a, b) => (a.branchTo ?? 0) - (b.branchTo ?? 0))[0];
    if (owner) {
      const decisionId = semanticId("decision", file, Buffer.byteLength(source.slice(0, owner.token.start), "utf8"), owner.label);
      edgeIds.push(addEdge({ id: semanticEdgeId(file, Buffer.byteLength(source.slice(0, outcome.token.start), "utf8"), `decision-outcome:${decisionId}:${id}`), source: decisionId, target: id, label: "jika kondisi terpenuhi", confidence: "proven", reason: "Return terjadi di dalam cabang if yang terdeteksi secara statis.", evidence: [evidenceSpan(file, bytes, owner.token.start, tokens[owner.conditionClose!]!.end, "reference"), ...evidence] }));
    }
  }
  return { nodeIds: [...new Set(nodeIds)], edgeIds: [...new Set(edgeIds)] };
}

function middlewareAdminGuardProven(tokens: Token[], method: PhpMethod): boolean {
  for (let i = method.bodyStart; i < method.bodyEnd; i += 1) {
    if (tokens[i]!.value !== "if" || tokens[i + 1]?.value !== "(") continue;
    const conditionEnd = matching(tokens, i + 1);
    if (conditionEnd < 0) continue;
    const condition = tokens.slice(i + 2, conditionEnd).map(token => token.value.toLowerCase());
    const checksIdentity = condition.some(value => value.includes("user"));
    const checksAdmin = condition.some(value => /^(?:is_admin|isadmin|hasrole|role|permission|can)$/u.test(value));
    if (!checksIdentity || !checksAdmin) continue;
    let branchStart = conditionEnd + 1, branchEnd = branchStart;
    if (tokens[branchStart]?.value === "{") {
      const close = matching(tokens, branchStart, "{", "}");
      if (close < 0) continue;
      branchStart += 1; branchEnd = close;
    } else {
      while (branchEnd < method.bodyEnd && tokens[branchEnd]!.value !== ";") branchEnd += 1;
    }
    for (let cursor = branchStart; cursor < branchEnd; cursor += 1) {
      if (tokens[cursor]!.value === "return") {
        let end = cursor + 1; while (end < branchEnd && tokens[end]!.value !== ";") end += 1;
        const status = explicitResponseStatus(tokens, cursor, end);
        if (status && ["401", "403"].includes(status.value)) return true;
      }
      if (["abort", "abort_if", "abort_unless"].includes(tokens[cursor]!.value) && tokens[cursor + 1]?.value === "(") {
        const close = matching(tokens, cursor + 1), args = close > 0 ? splitTop(tokens, cursor + 2, close) : [];
        const statusArg = tokens[cursor]!.value === "abort" ? args[0] : args[1];
        if (statusArg && ["401", "403"].includes(literalHttpStatus(statusArg)?.value ?? "")) return true;
      }
    }
  }
  return false;
}

function nextClosureCalls(tokens: Token[], method: PhpMethod): Array<{ start: number; end: number }> {
  const calls: Array<{ start: number; end: number }> = [];
  let braceDepth = 0, topLevelReturn = false;
  for (let i = method.bodyStart; i < method.bodyEnd; i += 1) {
    const value = tokens[i]!.value;
    if (value === "$next" && braceDepth === 0 && !topLevelReturn && tokens[i + 1]?.value === "(") {
      const call = callArgs(tokens, i + 1);
      if (call && call.args.length === 1) { calls.push({ start: tokens[i]!.start, end: tokens[call.close]!.end }); i = call.close; }
    }
    if (value === "return" && braceDepth === 0 && tokens[i + 1]?.value !== "$next") topLevelReturn = true;
    if (value === "{") braceDepth += 1;
    else if (value === "}") braceDepth = Math.max(0, braceDepth - 1);
  }
  return calls;
}

/** Extract statically declared Laravel API boundaries and source-local controller decisions. */
export function extractLaravel(input: SemanticInput): SemanticFragment {
  const fragment = emptyFragment(); const paths = Object.keys(input.sources).sort();
  const services = buildServiceIndex(paths, input.sources);
  const phpClassIndex = buildPhpClassIndex(paths, input.sources);
  const middlewareAliases = parseMiddlewareAliases(paths, input.sources);
  const routePaths = paths.filter(path => applicationPhpSource(path) && /(?:^|\/)routes\/[^/]+\.php$/u.test(path));
  const routeInfo: RouteInfo[] = [];
  for (const file of routePaths) {
    const bytes = input.sources[file]!, source = new TextDecoder().decode(bytes), tokens = lex(source);
    const routeCountBefore = routeInfo.length;
    parseRouteStatements(tokens, 0, tokens.length, { prefix: "", middleware: [], prefixUnknown: false, middlewareUnknown: false }, routeInfo, fragment.limitations, file);
    if (routeInfo.length > routeCountBefore && /(?:^|\/)routes\/api\.php$/iu.test(file)) fragment.limitations.push({ filePath: file, reason: "Prefix runtime routes/api.php (misalnya /api) dapat ditentukan pada konfigurasi bootstrap Laravel dan tidak disimpulkan dari deklarasi route saja." });
  }
  if (!routeInfo.length) return fragment;
  fragment.frameworks.push("Laravel API");
  const ccmNodes = input.ccm.nodes;
  const addNode = (node: SemanticNode) => {
    const existing = fragment.nodes.find(item => item.id === node.id);
    if (!existing) fragment.nodes.push(node);
    else {
      existing.evidence = compactEvidence([...existing.evidence, ...node.evidence]);
      existing.technicalNodeIds = [...new Set([...existing.technicalNodeIds, ...node.technicalNodeIds])].sort();
      if (existing.featureId !== node.featureId) existing.featureId = null;
    }
    return node.id;
  };
  const addEdge = (edge: SemanticEdge) => { if (!fragment.edges.some(item => item.id === edge.id)) fragment.edges.push(edge); return edge.id; };
  const featureMap = new Map<string, { id: string; label: string; routeIds: string[]; entryNodeIds: string[]; nodeIds: string[]; edgeIds: string[]; evidence: ReturnType<typeof evidenceSpan>[] }>();
  for (const route of routeInfo) {
    const routeFile = route.filePath;
    const routeSource = new TextDecoder().decode(input.sources[routeFile]!);
    const routeBytes = input.sources[routeFile]!;
    const featureLabel = humanLabel(route.controller.replace(/Controller$/u, "")) || humanLabel(route.path.split("/").filter(Boolean).at(-1) ?? "API");
    const featureId = semanticId("feature", routeFile, 0, `laravel:${featureLabel.toLowerCase()}`);
    const feature = featureMap.get(featureId) ?? { id: featureId, label: featureLabel, routeIds: [], entryNodeIds: [], nodeIds: [], edgeIds: [], evidence: [] };
    featureMap.set(featureId, feature);
    const routeEvidence = evidenceSpan(routeFile, routeBytes, route.start, route.end, "declaration"); feature.evidence = compactEvidence([...feature.evidence, routeEvidence]);
    const handlerPath = resolveControllerPath(route.controllerRef, routeSource, phpClassIndex);
    if (!handlerPath) fragment.limitations.push({ filePath: routeFile, reason: `Controller ${route.controller} belum dapat diselesaikan ke file source secara unik; isi handler tidak ditampilkan.` });
    const handlerBytes = handlerPath ? input.sources[handlerPath]! : null;
    const handlerSource = handlerBytes ? new TextDecoder().decode(handlerBytes) : "";
    const handlerTokens = handlerBytes ? lex(handlerSource) : [];
    const handlers = handlerBytes ? findHandlers(handlerTokens).get(route.action.toLowerCase()) ?? [] : [];
    const controllerClass = handlerBytes ? phpClassName(handlerSource) : null;
    const sourceName = controllerClass ?? route.controller;
    const matchingCcm = ccmNodes.filter(node => node.kind === "Class" && node.name.toLowerCase() === sourceName.toLowerCase() && (handlerPath === null || node.filePath === handlerPath));
    const controllerNodeIds = matchingCcm.map(node => node.id);
    const routeId = semanticId("component", routeFile, Buffer.byteLength(routeSource.slice(0, route.start), "utf8"), `route:${route.methods.join(",")}:${route.path}:${route.controller}@${route.action}`);
    const auth = route.scope.middlewareUnknown ? undefined : route.scope.middleware.find(item => AUTH_MIDDLEWARE.test(item));
    const admin = !route.scope.middlewareUnknown && route.scope.middleware.some(item => /^admin(?::|$)/iu.test(item));
    const actorLabel = admin ? "Administrator API client" : auth ? "Authenticated API client" : "API client";
    const middlewareAlias = admin ? middlewareAliases.get("admin") : undefined;
    const middlewareSource = middlewareAlias?.classRef ? resolveIndexedClass(middlewareAlias.classRef, phpClassIndex) : null;
    const middlewareMethods = middlewareSource?.classInfo.methods.get("handle") ?? [];
    const adminMethod = middlewareMethods.length === 1 && middlewareMethods[0]!.visibility !== "private" && middlewareMethods[0]!.visibility !== "protected" ? middlewareMethods[0]! : null;
    const adminGuardProven = !!(middlewareSource && adminMethod && middlewareAdminGuardProven(lex(middlewareSource.source), adminMethod));
    if (admin && (!middlewareAlias?.classRef || !middlewareSource || !adminMethod)) {
      fragment.limitations.push({ filePath: routeFile, reason: "Middleware alias admin tidak dapat ditelusuri ke satu class dan method handle source; penjagaan admin ditampilkan sebagai indikasi." });
    } else if (admin && !adminGuardProven) {
      fragment.limitations.push({ filePath: middlewareSource!.filePath, reason: "Middleware admin terhubung ke method handle, tetapi pemeriksaan identitas dan respons penolakan 401/403 tidak terbukti bersama; akses administrator ditandai sebagai indikasi." });
    }
    const actorConfidence = admin ? adminGuardProven ? "proven" : "indicated" : "proven";
    const actorReason = admin
      ? adminGuardProven ? "Alias admin terhubung ke middleware yang memeriksa identitas/izin dan menolak akses dengan status HTTP literal." : "Route memakai alias admin, tetapi pemeriksaan izin belum dibuktikan sepenuhnya pada middleware source."
      : auth ? `Route dilindungi middleware eksplisit ${auth}.` : "Route memiliki deklarasi handler pada permukaan API yang dipindai; middleware tingkat aplikasi tidak disimpulkan.";
    const actorId = addNode({ id: semanticId("actor", routeFile, 0, `${actorLabel}:${route.scope.middleware.join("|")}`), kind: "actor", label: actorLabel, featureId, confidence: actorConfidence, reason: actorReason, evidence: [routeEvidence], technicalNodeIds: [] });
    addNode({ id: routeId, kind: "step", label: `${route.methods.join("/").toUpperCase()} ${route.path}`, featureId, confidence: "proven", reason: "Route dengan path dan method literal terhubung ke controller method statis.", evidence: [routeEvidence], technicalNodeIds: [] });
    feature.routeIds.push(routeId); feature.entryNodeIds.push(routeId); feature.nodeIds.push(actorId, routeId);
    addEdge({ id: semanticEdgeId(routeFile, Buffer.byteLength(routeSource.slice(0, route.start), "utf8"), `client-route:${actorId}:${routeId}`), source: actorId, target: routeId, label: auth ? "dilindungi oleh" : "menerima permintaan dari", confidence: actorConfidence, reason: actorReason, evidence: [routeEvidence] });
    feature.edgeIds.push(semanticEdgeId(routeFile, Buffer.byteLength(routeSource.slice(0, route.start), "utf8"), `client-route:${actorId}:${routeId}`));
    const actionHandler = handlers.length === 1 ? handlers[0]! : null;
    const actionStart = actionHandler?.nameStart ?? route.start, actionEnd = actionHandler?.nameEnd ?? route.end;
    const controllerId = addNode({ id: semanticId("component", handlerPath ?? routeFile, handlerBytes ? Buffer.byteLength(handlerSource.slice(0, actionStart), "utf8") : Buffer.byteLength(routeSource.slice(0, route.start), "utf8"), `controller:${route.controller}@${route.action}`), kind: "component", label: `${route.controller}@${route.action}`, featureId, confidence: "proven", reason: "Action controller dirujuk secara literal oleh deklarasi route.", evidence: [handlerBytes && actionHandler ? evidenceSpan(handlerPath!, handlerBytes, actionStart, actionEnd, "declaration") : routeEvidence], technicalNodeIds: controllerNodeIds });
    const routeControllerEdge = semanticEdgeId(routeFile, Buffer.byteLength(routeSource.slice(0, route.start), "utf8"), `route-controller:${routeId}:${controllerId}`);
    addEdge({ id: routeControllerEdge, source: routeId, target: controllerId, label: "menjalankan", confidence: "proven", reason: "Route menyebut pasangan controller::method secara literal.", evidence: [routeEvidence] });
    feature.nodeIds.push(controllerId); feature.edgeIds.push(routeControllerEdge);
    if (admin) {
      if (middlewareAlias?.classRef && middlewareSource && adminMethod) {
        const aliasBytes = input.sources[middlewareAlias.filePath]!;
        const aliasEvidence = evidenceSpan(middlewareAlias.filePath, aliasBytes, middlewareAlias.start, middlewareAlias.end, "reference");
        const middlewareBytes = middlewareSource.bytes;
        const middlewareTokens = lex(middlewareSource.source);
        const middlewareClassCcmIds = ccmNodes.filter(node => node.kind === "Class" && node.name === middlewareSource.classInfo.name && node.filePath === middlewareSource.filePath).map(node => node.id);
        const middlewareId = addNode({
          id: semanticId("component", middlewareSource.filePath, Buffer.byteLength(middlewareSource.source.slice(0, adminMethod.nameStart), "utf8"), `middleware:${middlewareSource.classInfo.namespace}:${middlewareSource.classInfo.name}@${adminMethod.name}`),
          kind: "component", label: `${middlewareSource.classInfo.name}@${adminMethod.name}`, featureId,
          confidence: adminGuardProven ? "proven" : "indicated",
          reason: adminGuardProven ? "Alias Laravel statis menunjuk method middleware dengan penjagaan administrator eksplisit." : "Alias Laravel statis menunjuk method middleware, tetapi penjagaan administrator belum dibuktikan sepenuhnya.",
          evidence: [aliasEvidence, evidenceSpan(middlewareSource.filePath, middlewareBytes, adminMethod.nameStart, adminMethod.nameEnd, "declaration")],
          technicalNodeIds: middlewareClassCcmIds,
        });
        feature.nodeIds.push(middlewareId);
        const routeMiddlewareEdge = semanticEdgeId(routeFile, Buffer.byteLength(routeSource.slice(0, route.start), "utf8"), `route-middleware:${routeId}:${middlewareId}`);
        addEdge({ id: routeMiddlewareEdge, source: routeId, target: middlewareId, label: "diperiksa oleh", confidence: middlewareAlias && middlewareSource ? "proven" : "indicated", reason: "Route memakai alias middleware admin yang dicari pada konfigurasi Laravel.", evidence: [routeEvidence, aliasEvidence] });
        feature.edgeIds.push(routeMiddlewareEdge);
        const middlewareFlow = functionDecisions(middlewareTokens, adminMethod, middlewareSource.source, middlewareBytes, middlewareSource.filePath, middlewareClassCcmIds, middlewareId, featureId, addNode, addEdge, "middleware");
        feature.nodeIds.push(...middlewareFlow.nodeIds); feature.edgeIds.push(...middlewareFlow.edgeIds);
        const nextCalls = nextClosureCalls(middlewareTokens, adminMethod);
        if (!nextCalls.length) fragment.limitations.push({ filePath: middlewareSource.filePath, reason: "Middleware handle tidak memiliki pemanggilan $next($request) yang dapat dibuktikan; kelanjutan ke controller tidak ditampilkan." });
        for (const nextCall of nextCalls) {
          const nextEvidence = evidenceSpan(middlewareSource.filePath, middlewareBytes, nextCall.start, nextCall.end, "reference");
          const edgeId = semanticEdgeId(middlewareSource.filePath, Buffer.byteLength(middlewareSource.source.slice(0, nextCall.start), "utf8"), `middleware-controller:${middlewareId}:${controllerId}`);
          addEdge({ id: edgeId, source: middlewareId, target: controllerId, label: "meneruskan permintaan ke", confidence: "proven", reason: "Middleware memanggil closure $next dengan satu argumen setelah resolusi alias dan route controller statis.", evidence: [aliasEvidence, nextEvidence, routeEvidence] });
          feature.edgeIds.push(edgeId);
        }
      }
    }
    if (handlerPath && handlerBytes) {
      if (handlers.length !== 1) fragment.limitations.push({ filePath: handlerPath, reason: handlers.length ? `Method ${route.action} memiliki beberapa deklarasi; urutan alur diabaikan.` : `Method ${route.action} tidak ditemukan sebagai method controller statis.` });
      else {
        const handler = handlers[0]!;
        const handlerFlow = functionDecisions(handlerTokens, handler, handlerSource, handlerBytes, handlerPath, controllerNodeIds, controllerId, featureId, addNode, addEdge);
        feature.nodeIds.push(...handlerFlow.nodeIds); feature.edgeIds.push(...handlerFlow.edgeIds);
        const serviceResolution = findServiceCalls(handlerTokens, handler, handlerSource, services);
        for (const reason of serviceResolution.limitations) fragment.limitations.push({ filePath: handlerPath, reason });
        for (const call of serviceResolution.calls) {
          const serviceName = call.target.classInfo.name;
          const serviceId = semanticId("component", call.target.filePath, Buffer.byteLength(call.target.source.slice(0, call.method.start), "utf8"), `service:${call.target.classInfo.namespace}:${serviceName}@${call.method.name}`);
          const methodStartByte = Buffer.byteLength(call.target.source.slice(0, call.method.start), "utf8"), methodEndByte = Buffer.byteLength(call.target.source.slice(0, call.method.end), "utf8");
          const technicalNodeIds = ccmNodes.filter(node => node.filePath === call.target.filePath && (node.name === serviceName || (node.location !== null && node.location.startByte >= methodStartByte && node.location.endByte <= methodEndByte))).map(node => node.id);
          const declarationEvidence = evidenceSpan(call.target.filePath, call.target.bytes, call.method.nameStart, call.method.nameEnd, "declaration");
          addNode({ id: serviceId, kind: "component", label: `${serviceName}@${call.method.name}`, featureId, confidence: "proven", reason: "Pemanggilan pada dependency controller statis cocok dengan satu method service yang dapat diakses.", evidence: [declarationEvidence], technicalNodeIds });
          const callSiteEvidence = evidenceSpan(handlerPath, handlerBytes, call.start, call.end, "reference");
          const dependencyEvidence = call.bindingEvidence.map(span => evidenceSpan(handlerPath, handlerBytes, span.start, span.end, "reference"));
          const edgeId = semanticEdgeId(handlerPath, Buffer.byteLength(handlerSource.slice(0, call.start), "utf8"), `controller-service:${controllerId}:${serviceId}:${call.method.name}`);
          addEdge({ id: edgeId, source: controllerId, target: serviceId, label: "memanggil layanan", confidence: "proven", reason: "Constructor injection atau constructor local dan pemanggilan method service terhubung secara statis.", evidence: [callSiteEvidence, ...dependencyEvidence, declarationEvidence] });
          feature.nodeIds.push(serviceId); feature.edgeIds.push(edgeId);
        }
        const controllerClassInfo = phpClasses(handlerSource).find(item => handler.start >= item.start && handler.start < item.end);
        const controllerNamespace = controllerClassInfo?.namespace ?? "";
        const controllerImports = routeClassImports(handlerSource);
        const models = paths.filter(path => applicationPhpSource(path) && /(?:^|\/)Models?\//u.test(path)).flatMap(path => {
          const sourceBytes = input.sources[path]!, source = new TextDecoder().decode(sourceBytes), declaration = phpClasses(source)[0], eloquent = eloquentClass(source);
          return declaration ? [{ path, name: declaration.name, namespace: declaration.namespace, fullName: declaration.namespace ? `${declaration.namespace}\\${declaration.name}` : declaration.name, start: declaration.start, end: declaration.end, eloquent: eloquent !== null }] : [];
        });
        for (let tokenIndex = handler.bodyStart; tokenIndex < handler.bodyEnd; tokenIndex += 1) {
          const tokenNode = handlerTokens[tokenIndex]!;
          if (tokenNode.kind !== "identifier") continue;
          const previous = handlerTokens[tokenIndex - 1]?.value;
          const knownOperations = ["create", "insert", "upsert", "save", "update", "updateOrCreate", "firstOrCreate", "delete", "destroy", "first", "find", "findOrFail", "firstOrFail", "get", "all", "where", "whereDate", "whereHas", "with", "count", "exists", "query", "pluck", "value", "sum", "paginate", "orderBy"];
          const staticOperation = previous === "::" && knownOperations.includes(tokenNode.value);
          const chainedOperation = previous === "->" && knownOperations.includes(tokenNode.value);
          const operation = (staticOperation || chainedOperation) && handlerTokens[tokenIndex + 1]?.value === "(";
          if (!operation) continue;
          let modelName: string | null = null, modelPath: string | null = null;
          const statementStart = Math.max(handler.bodyStart, handlerTokens.slice(handler.bodyStart, tokenIndex).map(t => t.value).lastIndexOf(";") + handler.bodyStart + 1);
          for (let cursor = tokenIndex - 1; cursor >= statementStart + 1; cursor -= 1) {
            const rawCandidate = handlerTokens[cursor - 1]?.value;
            if (handlerTokens[cursor]?.value !== "::" || !rawCandidate) continue;
            const resolvedCandidate = resolvePhpClassRef(rawCandidate, controllerNamespace, controllerImports);
            const match = models.find(model => model.fullName.toLowerCase() === resolvedCandidate.toLowerCase());
            if (match) { modelName = match.name; modelPath = match.path; break; }
            const sameShortName = models.find(model => model.name.toLowerCase() === rawCandidate.replace(/^\\/u, "").split("\\").at(-1)?.toLowerCase());
            if (sameShortName) fragment.limitations.push({ filePath: handlerPath, reason: "Static model reference " + rawCandidate + " resolves to a different namespace than " + sameShortName.fullName + "; Eloquent link is omitted." });
          }
          if (!modelName) continue;
          const modelBytes = modelPath ? input.sources[modelPath]! : null;
          const storeId = semanticId("store", modelPath ?? handlerPath, modelBytes ? 0 : tokenNode.start, `eloquent:${modelName}`);
          const modelDeclaration = modelPath ? models.find(model => model.path === modelPath)! : null;
          const confidence = modelDeclaration?.eloquent ? "proven" : "indicated";
          if (modelDeclaration && !modelDeclaration.eloquent) fragment.limitations.push({ filePath: modelPath!, reason: `Model ${modelName} digunakan oleh controller tetapi deklarasi parent-nya tidak membuktikan Eloquent secara langsung; hubungan ditandai sebagai indikasi.` });
          addNode({ id: storeId, kind: "store", label: humanLabel(modelName), featureId, confidence, reason: modelDeclaration?.eloquent ? "Pemanggilan query Eloquent statis dan deklarasi model turunan Eloquent ditemukan pada source." : "Pemanggilan model statis ditemukan tetapi inheritance Eloquent tidak dibuktikan secara langsung.", evidence: [evidenceSpan(handlerPath, handlerBytes, tokenNode.start, tokenNode.end, "reference"), ...(modelBytes && modelPath && modelDeclaration ? [evidenceSpan(modelPath, modelBytes, modelDeclaration.start, modelDeclaration.end, "declaration" as const)] : [])], technicalNodeIds: modelPath ? ccmNodes.filter(node => node.kind === "Class" && node.name === modelName && node.filePath === modelPath).map(node => node.id) : [] });
          const edgeId = semanticEdgeId(handlerPath, Buffer.byteLength(handlerSource.slice(0, tokenNode.start), "utf8"), `store:${controllerId}:${storeId}:${tokenNode.value}`);
          const label = ["create", "insert", "upsert", "save", "update", "updateOrCreate", "firstOrCreate", "delete", "destroy"].includes(tokenNode.value) ? tokenNode.value === "delete" || tokenNode.value === "destroy" ? "menghapus" : "menyimpan" : "membaca";
          addEdge({ id: edgeId, source: controllerId, target: storeId, label, confidence, reason: "Pemanggilan operasi query statis pada model Eloquent dalam method controller yang dirujuk route.", evidence: [evidenceSpan(handlerPath, handlerBytes, tokenNode.start, handlerTokens[tokenIndex + 1]!.end, "reference")] });
          feature.nodeIds.push(storeId); feature.edgeIds.push(edgeId);
        }
      }
    }
  }
  for (const feature of featureMap.values()) {
    const uniqueNodes = [...new Set(feature.nodeIds)]; const uniqueEdges = [...new Set(feature.edgeIds)];
    const linkedEdges = fragment.edges.filter(edge => uniqueNodes.includes(edge.source) && uniqueNodes.includes(edge.target)).map(edge => edge.id);
    fragment.features.push({ id: feature.id, label: feature.label, entryNodeIds: [...new Set(feature.entryNodeIds)], nodeIds: uniqueNodes, edgeIds: [...new Set([...uniqueEdges, ...linkedEdges])], evidence: feature.evidence });
    ensureFeatureNode(fragment, feature.id, feature.label, feature.evidence, "proven", "Fitur diturunkan dari controller yang dirujuk route literal dan evidence route yang cocok.");
  }
  fragment.nodes = [...new Map(fragment.nodes.map(node => [node.id, node])).values()].sort((a, b) => a.id.localeCompare(b.id));
  fragment.edges = [...new Map(fragment.edges.map(edge => [edge.id, edge])).values()].sort((a, b) => a.id.localeCompare(b.id));
  fragment.features.sort((a, b) => a.id.localeCompare(b.id));
  fragment.limitations = [...new Map(fragment.limitations.map(item => [`${item.filePath}:${item.reason}`, item])).values()];
  return fragment;
}
