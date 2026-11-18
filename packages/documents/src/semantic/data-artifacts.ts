import type { EvidenceSpan } from "@sage/contracts";
import { emptyFragment, evidenceSpan, humanLabel, semanticEdgeId, semanticNode } from "./builder.ts";
import type { SemanticEdge, SemanticFragment, SemanticInput } from "./model.ts";

const MAX_CONTRACT_BYTES = 1_048_576;
const EXCLUDED = /(^|\/)(?:vendor|node_modules|dist|build|coverage|generated|fixtures?|mocks?)(\/|$)/iu;
type Source = { path: string; bytes: Uint8Array; text: string };
function readSources(input: SemanticInput): Source[] {
  return Object.entries(input.sources).filter(([path, bytes]) => !EXCLUDED.test(path) && bytes.byteLength <= MAX_CONTRACT_BYTES && /\.(?:sql|json|ya?ml|prisma)$/iu.test(path))
    .map(([path, bytes]) => ({ path, bytes, text: new TextDecoder("utf-8", { fatal: false }).decode(bytes) })).sort((a, b) => a.path.localeCompare(b.path));
}
function span(source: Source, start: number, end: number, role: EvidenceSpan["role"]): EvidenceSpan {
  return evidenceSpan(source.path, source.bytes, start, Math.max(start + 1, end), role);
}
function jsonPropertyOffset(text: string, key: string, startAt: number): number {
  const needle = JSON.stringify(key); let cursor = startAt;
  while (cursor < text.length) {
    const found = text.indexOf(needle, cursor); if (found < 0) return -1;
    if (/^\s*:/u.test(text.slice(found + needle.length))) return found;
    cursor = found + needle.length;
  }
  return -1;
}
function addData(fragment: SemanticFragment, source: Source, start: number, end: number, name: string, idKey: string, reason: string): string {
  const node = semanticNode({ kind: "store", filePath: source.path, startByte: span(source, start, end, "declaration").startByte, key: idKey,
    label: humanLabel(name), featureId: null, confidence: "proven", reason, evidence: [span(source, start, end, "declaration")] });
  fragment.nodes.push(node); return node.id;
}
function addInterface(fragment: SemanticFragment, source: Source, start: number, end: number, method: string, path: string): void {
  const evidence = span(source, start, end, "declaration");
  const node = semanticNode({ kind: "component", filePath: source.path, startByte: evidence.startByte, key: `openapi:${method}:${path}`,
    label: `${method} ${path}`, confidence: "proven", reason: "HTTP method and path are declared in an OpenAPI contract; runtime implementation and availability are not inferred.", evidence: [evidence] });
  node.label = `${method} ${path}`;
  fragment.nodes.push(node);
}
function addDataRelation(fragment: SemanticFragment, source: Source, start: number, end: number, from: string, to: string, key: string): void {
  if (from === to) return;
  const evidence = span(source, start, end, "reference");
  const edge: SemanticEdge = { id: semanticEdgeId(source.path, evidence.startByte, key), source: from, target: to, label: "references data object", confidence: "proven",
    reason: "A schema reference or relational foreign key names the target data object.", evidence: [evidence] };
  fragment.edges.push(edge);
}
function prismaRelationName(fieldDeclaration: string): string | null {
  const argumentsText = fieldDeclaration.match(/@relation\s*\(([^)]*)\)/u)?.[1];
  if (!argumentsText) return null;
  const positional = argumentsText.match(/^\s*["']([^"']+)["']/u)?.[1];
  const named = argumentsText.match(/(?:^|,)\s*name\s*:\s*["']([^"']+)["']/u)?.[1];
  return named ?? positional ?? null;
}
function decodeOpenApiJson(fragment: SemanticFragment, source: Source, root: Record<string, unknown>): void {
  const isOpenApi = typeof root.openapi === "string" || typeof root.swagger === "string";
  const pathEntries = isOpenApi && root.paths && typeof root.paths === "object" && !Array.isArray(root.paths) ? Object.entries(root.paths as Record<string, unknown>) : [];
  for (const [path, raw] of pathEntries) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || !path.startsWith("/")) continue;
    for (const method of Object.keys(raw as Record<string, unknown>)) {
      if (!/^(?:get|post|put|patch|delete|options|head|trace)$/iu.test(method)) continue;
      const start = source.text.indexOf(JSON.stringify(method), source.text.indexOf(JSON.stringify(path)));
      if (start >= 0) addInterface(fragment, source, start, start + JSON.stringify(method).length, method.toUpperCase(), path);
    }
  }
  const schemas = root.components && typeof root.components === "object" && !Array.isArray(root.components)
    ? ((root.components as Record<string, unknown>).schemas as Record<string, unknown> | undefined)
    : undefined;
  const definitions = (root.definitions ?? root.$defs) as Record<string, unknown> | undefined;
  const records = schemas && typeof schemas === "object" && !Array.isArray(schemas) ? schemas : definitions && typeof definitions === "object" && !Array.isArray(definitions) ? definitions : {};
  const schemaContainer = source.text.indexOf(schemas ? '"schemas"' : root.definitions ? '"definitions"' : '"$defs"');
  for (const name of Object.keys(records)) {
    const literal = JSON.stringify(name); const start = schemaContainer < 0 ? -1 : jsonPropertyOffset(source.text, name, schemaContainer + 1);
    if (start >= 0) addData(fragment, source, start, start + literal.length, name, `schema:${name}`, isOpenApi ? "Data schema declared under OpenAPI components.schemas." : "Data entity declared in a JSON Schema definitions section.");
  }
  // JSON data objects are cataloged from declarations. Reference edges are omitted until a syntax-aware JSON span mapper is available.
  if (isOpenApi) fragment.frameworks.push("OpenAPI contract");
}
function parseOpenApiYaml(fragment: SemanticFragment, source: Source): void {
  if (!/^\s*(?:openapi|swagger)\s*:\s*["']?[23]/mu.test(source.text)) return;
  const lines = source.text.split("\n");
  let inPaths = false; let inSchemas = false; let currentPath: string | null = null; let currentSchema: string | null = null;
  const schemaIds = new Map<string, string>();
  const pendingRefs: Array<{ from: string; toName: string; start: number; end: number }> = [];
  let offset = 0;
  for (const line of lines) {
    const pathStart = offset; const pathEnd = offset + line.length;
    const root = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):(?:\s|$)/u);
    if (root) {
      inPaths = root[1] === "paths";
      inSchemas = false;
      currentPath = null;
      currentSchema = null;
    }
    if (/^\s{2}schemas:\s*$/u.test(line) && !inPaths) { inSchemas = true; currentSchema = null; }
    else if (/^\s{2}[A-Za-z][A-Za-z0-9_-]*:\s*$/u.test(line) && !/^\s{2}schemas:/u.test(line) && inSchemas) inSchemas = false;
    if (inPaths) {
      const route = line.match(/^\s{2}(\/[^:]+):\s*$/u);
      if (route) currentPath = route[1]!;
      else {
        const method = line.match(/^\s{4}(get|post|put|patch|delete|options|head|trace):\s*$/iu);
        if (method && currentPath) addInterface(fragment, source, pathStart, pathEnd, method[1]!.toUpperCase(), currentPath);
      }
    }
    if (inSchemas) {
      const schema = line.match(/^\s{4}([A-Za-z_][A-Za-z0-9_-]*):\s*$/u);
      if (schema) { currentSchema = schema[1]!; schemaIds.set(currentSchema, addData(fragment, source, pathStart, pathEnd, currentSchema, `openapi-yaml:${currentSchema}`, "Data entity declared in OpenAPI components.schemas.")); }
      const ref = line.match(/\$ref:\s*["']?#\/components\/schemas\/([A-Za-z_][A-Za-z0-9_-]*)/u);
      if (currentSchema && ref) { const from = schemaIds.get(currentSchema); if (from) pendingRefs.push({ from, toName: ref[1]!, start: pathStart, end: pathEnd }); }
    }
    offset += line.length + 1;
  }
  for (const item of pendingRefs) { const target = schemaIds.get(item.toName); if (target) addDataRelation(fragment, source, item.start, item.end, item.from, target, `openapi-yaml:${item.from}:${item.toName}:${item.start}`); }
  fragment.frameworks.push("OpenAPI contract");
}
function maskSqlCommentsAndStrings(input: string): string {
  const output = input.split("");
  const mask = (start: number, end: number) => {
    for (let index = start; index < end; index++) if (output[index] !== "\n" && output[index] !== "\r") output[index] = " ";
  };
  const maskQuoted = (start: number, quote: string, doubledEscape: string): number => {
    let index = start + quote.length;
    while (index < input.length) {
      if (input.startsWith(doubledEscape + doubledEscape, index)) { index += doubledEscape.length * 2; continue; }
      if (input.startsWith(quote, index)) return index + quote.length;
      if (input[index] === "\\" && index + 1 < input.length) { index += 2; continue; }
      index++;
    }
    return input.length;
  };
  for (let index = 0; index < input.length;) {
    if (input.startsWith("--", index)) {
      let end = input.indexOf("\n", index + 2); if (end < 0) end = input.length;
      mask(index, end); index = end; continue;
    }
    if (input.startsWith("/*", index)) {
      let depth = 1; let end = index + 2;
      while (end < input.length && depth > 0) {
        if (input.startsWith("/*", end)) { depth++; end += 2; }
        else if (input.startsWith("*/", end)) { depth--; end += 2; }
        else end++;
      }
      mask(index, end); index = end; continue;
    }
    if (input[index] === "'") {
      const end = maskQuoted(index, "'", "'"); mask(index, end); index = end; continue;
    }
    if (input[index] === "$") {
      const dollarQuote = input.slice(index).match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/u)?.[0];
      if (dollarQuote) {
        const closing = input.indexOf(dollarQuote, index + dollarQuote.length);
        const end = closing < 0 ? input.length : closing + dollarQuote.length;
        mask(index, end); index = end; continue;
      }
    }
    // Double quotes, backticks, and brackets delimit identifiers in supported
    // SQL dialects, so leave their contents visible to the DDL scanner.
    if (input[index] === '"') { index = maskQuoted(index, '"', '"'); continue; }
    if (input[index] === "`") { index = maskQuoted(index, "`", "`"); continue; }
    if (input[index] === "[") {
      let end = index + 1;
      while (end < input.length) {
        if (input.startsWith("]]", end)) { end += 2; continue; }
        if (input[end] === "]") { end++; break; }
        end++;
      }
      index = end; continue;
    }
    index++;
  }
  return output.join("");
}
function parseSql(fragment: SemanticFragment, source: Source): void {
  const text = maskSqlCommentsAndStrings(source.text);
  const tablePattern = /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:["'`\[]?([A-Za-z_][\w$]*)["'`\]]?\s*\.\s*)?["'`\[]?([A-Za-z_][\w$]*)["'`\]]?\s*\(/giu;
  const tables: Array<{ schema: string | null; name: string; id: string; start: number; bodyStart: number; end: number }> = [];
  for (const match of text.matchAll(tablePattern)) {
    const schema = match[1] ?? null; const name = match[2]!; const start = match.index!; const bodyStart = start + match[0].length; let depth = 1; let end = bodyStart;
    while (end < text.length && depth > 0) { if (text[end] === "(") depth++; else if (text[end] === ")") depth--; end++; }
    if (depth !== 0) continue;
    const originalStart = source.text.indexOf(match[2]!, start); const id = addData(fragment, source, originalStart, originalStart + name.length, name, `sql-table:${schema ?? ""}.${name}`, "Relational table declared by CREATE TABLE DDL.");
    tables.push({ schema, name, id, start, bodyStart, end });
  }
  for (const table of tables) {
    const body = text.slice(table.bodyStart, table.end);
    for (const reference of body.matchAll(/\bREFERENCES\s+(?:["'`\[]?([A-Za-z_][\w$]*)["'`\]]?\s*\.\s*)?["'`\[]?([A-Za-z_][\w$]*)["'`\]]?/giu)) {
      const referencedSchema = reference[1] ?? null;
      const referencedName = reference[2]!;
      const candidates = tables.filter(candidate => candidate.name.toLowerCase() === referencedName.toLowerCase() &&
        (referencedSchema === null || candidate.schema?.toLowerCase() === referencedSchema.toLowerCase()));
      // An unqualified duplicate table name is ambiguous; do not assert a proven FK target.
      if (candidates.length !== 1) continue;
      const target = candidates[0]!;
      const start = table.bodyStart + reference.index!; const evidenceStart = source.text.indexOf(referencedName, start);
      if (evidenceStart >= 0) addDataRelation(fragment, source, evidenceStart, evidenceStart + referencedName.length, table.id, target.id, `sql-fk:${table.schema ?? ""}.${table.name}:${target.schema ?? ""}.${target.name}:${evidenceStart}`);
    }
  }
}

type PrismaModelBlock = { source: Source; masked: string; name: string; nameStart: number; bodyStart: number; bodyEnd: number };

function maskPrismaComments(text: string): string {
  const output = text.split("");
  let quote = false, escaped = false, blockDepth = 0;
  for (let index = 0; index < text.length; index++) {
    const current = text[index]!, next = text[index + 1];
    if (quote) {
      if (escaped) escaped = false;
      else if (current === "\\") escaped = true;
      else if (current === '"') quote = false;
      continue;
    }
    if (blockDepth > 0) {
      if (current === "/" && next === "*") { output[index] = output[index + 1] = " "; blockDepth++; index++; }
      else if (current === "*" && next === "/") { output[index] = output[index + 1] = " "; blockDepth--; index++; }
      else if (current !== "\n" && current !== "\r") output[index] = " ";
      continue;
    }
    if (current === '"') { quote = true; continue; }
    if (current === "/" && next === "*") { output[index] = output[index + 1] = " "; blockDepth = 1; index++; continue; }
    if (current === "/" && next === "/") {
      while (index < text.length && text[index] !== "\n" && text[index] !== "\r") output[index++] = " ";
      index--;
    }
  }
  return output.join("");
}

function prismaSchemaRoot(path: string): string {
  const segments = path.replaceAll("\\", "/").split("/");
  const prismaIndex = segments.lastIndexOf("prisma");
  if (prismaIndex >= 0) return segments.slice(0, prismaIndex + 1).join("/");
  return segments.slice(0, -1).join("/");
}

function prismaModels(fragment: SemanticFragment, sources: Source[]): void {
  const models: PrismaModelBlock[] = [];
  for (const source of sources.filter(item => /\.prisma$/iu.test(item.path))) {
    const masked = maskPrismaComments(source.text);
    const headerPattern = /^[ \t]*model[ \t]+([A-Za-z_][A-Za-z0-9_]*)[ \t]*\{[ \t]*$/gmu;
    let header: RegExpExecArray | null;
    while ((header = headerPattern.exec(masked))) {
      const name = header[1]!;
      const nameStart = header.index + header[0].indexOf(name);
      const bodyStart = header.index + header[0].length;
      const closePattern = /^[ \t]*\}[ \t]*$/gmu;
      closePattern.lastIndex = bodyStart;
      const close = closePattern.exec(masked);
      if (!close) {
        fragment.limitations.push({ filePath: source.path, reason: `Prisma model ${name} has no closing block; no model facts were extracted.` });
        break;
      }
      models.push({ source, masked, name, nameStart, bodyStart, bodyEnd: close.index });
      headerPattern.lastIndex = close.index + close[0].length;
    }
  }

  const identifiers = new Map<PrismaModelBlock, string>();
  const bySchemaAndName = new Map<string, PrismaModelBlock[]>();
  for (const model of models) {
    const id = addData(fragment, model.source, model.nameStart, model.nameStart + model.name.length, model.name,
      `prisma-model:${model.name}`, "Data model explicitly declared by a Prisma model block.");
    identifiers.set(model, id);
    const key = `${prismaSchemaRoot(model.source.path)}\0${model.name}`;
    const matches = bySchemaAndName.get(key) ?? [];
    matches.push(model);
    bySchemaAndName.set(key, matches);
  }

  const relations = new Map<string, { source: Source; fromId: string; toId: string; key: string; offset: number; evidence: EvidenceSpan[] }>();
  for (const model of models) {
    let lineStart = model.bodyStart;
    while (lineStart < model.bodyEnd) {
      const newline = model.masked.indexOf("\n", lineStart);
      const lineEnd = newline < 0 || newline > model.bodyEnd ? model.bodyEnd : newline;
      const line = model.masked.slice(lineStart, lineEnd).replace(/\r$/u, "");
      const field = line.match(/^([ \t]*)([A-Za-z_][A-Za-z0-9_]*)[ \t]+([A-Za-z_][A-Za-z0-9_]*)(?:\[\])?(?:\?)?(?:[ \t]+.*)?$/u);
      if (field) {
        const targetType = field[3]!;
        const targetKey = `${prismaSchemaRoot(model.source.path)}\0${targetType}`;
        const targets = bySchemaAndName.get(targetKey) ?? [];
        if (targets.length === 1) {
          const target = targets[0]!;
          if (model === target) {
            fragment.limitations.push({ filePath: model.source.path, reason: `Self-referential Prisma relation ${model.name}.${field[2]} is not represented by the current ADD relationship profile.` });
            lineStart = newline < 0 || newline >= model.bodyEnd ? model.bodyEnd : newline + 1;
            continue;
          }
          const typeStartInLine = field[1]!.length + field[2]!.length + line.slice(field[1]!.length + field[2]!.length).match(/^[ \t]*/u)![0].length;
          const edgeStart = lineStart + typeStartInLine;
          const ordered = [model, target].sort((left, right) => left.name.localeCompare(right.name) || left.source.path.localeCompare(right.source.path));
          const relationName = prismaRelationName(line) ?? "default";
          const relationKey = `${prismaSchemaRoot(model.source.path)}\0${ordered[0]!.name}\0${ordered[1]!.name}\0${relationName}`;
          const current = relations.get(relationKey) ?? {
            source: ordered[0]!.source, fromId: identifiers.get(ordered[0]!)!, toId: identifiers.get(ordered[1]!)!,
            key: `prisma-relation:${ordered[0]!.name}:${ordered[1]!.name}:${relationName}`, offset: ordered[0]!.nameStart, evidence: [],
          };
          current.evidence.push(span(model.source, edgeStart, edgeStart + targetType.length, "reference"));
          relations.set(relationKey, current);
        } else if (targets.length > 1) {
          fragment.limitations.push({ filePath: model.source.path, reason: `Prisma relation field ${model.name}.${field[2]} has an ambiguous target ${targetType}; no relationship was inferred.` });
        }
      }
      if (newline < 0 || newline >= model.bodyEnd) break;
      lineStart = newline + 1;
    }
  }
  for (const relation of relations.values()) {
    const evidence = [...new Map(relation.evidence.map(item => [`${item.filePath}:${item.startByte}:${item.endByte}`, item])).values()]
      .sort((left, right) => left.filePath.localeCompare(right.filePath) || left.startByte - right.startByte);
    fragment.edges.push({ id: semanticEdgeId(relation.source.path, relation.offset, relation.key), source: relation.fromId, target: relation.toId,
      label: "references data object", confidence: "proven",
      reason: "Prisma model fields explicitly declare a relation between the two data models. This is a source contract, not evidence of application runtime traffic.", evidence });
  }
  if (models.length > 0) fragment.frameworks.push("Prisma schema");
}

/** Extract explicit logical data structures and interface contracts; physical deployment and runtime traffic remain outside this projection. */
export function extractDataArtifacts(input: SemanticInput): SemanticFragment {
  const fragment = emptyFragment();
  const sources = readSources(input);
  prismaModels(fragment, sources);
  for (const source of sources) {
    if (!source.text.trim() || source.bytes.includes(0)) continue;
    if (/\.prisma$/iu.test(source.path)) {
      if (!source.text.includes("model")) fragment.limitations.push({ filePath: source.path, reason: "Prisma schema contains no supported model blocks; no architecture facts were inferred from its filename." });
      continue;
    }
    const priorNodes = fragment.nodes.length; const priorEdges = fragment.edges.length;
    if (/\.sql$/iu.test(source.path)) parseSql(fragment, source);
    else if (/\.ya?ml$/iu.test(source.path)) parseOpenApiYaml(fragment, source);
    else if (/\.json$/iu.test(source.path) && /(?:openapi|swagger|schema|\.schema\.)/iu.test(source.path)) {
      try { const value: unknown = JSON.parse(source.text); if (value && typeof value === "object" && !Array.isArray(value)) decodeOpenApiJson(fragment, source, value as Record<string, unknown>); }
      catch { /* Invalid JSON is reported in limitations below; no partial data model is asserted. */ }
    }
    if (fragment.nodes.length > priorNodes || fragment.edges.length > priorEdges) continue;
    if (/\.sql$/iu.test(source.path) || /\.ya?ml$/iu.test(source.path) || /\.json$/iu.test(source.path) && /(?:openapi|swagger|schema|\.schema\.)/iu.test(source.path)) {
      fragment.limitations.push({ filePath: source.path, reason: "Structured contract file did not match supported static SQL/OpenAPI/JSON Schema patterns; no architecture facts were inferred from its filename alone." });
    }
  }
  fragment.nodes = [...new Map(fragment.nodes.map(node => [node.id, node])).values()];
  fragment.edges = [...new Map(fragment.edges.map(edge => [edge.id, edge])).values()];
  return fragment;
}
