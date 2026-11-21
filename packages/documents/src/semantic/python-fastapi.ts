import type { CcmNode } from "@sage/contracts";
import { compactEvidence, emptyFragment, humanLabel, semanticEdgeId, semanticId, semanticNode } from "./builder.ts";
import type { SemanticEdge, SemanticFeature, SemanticFragment, SemanticInput, SemanticNode } from "./model.ts";

function nodeEvidence(node: CcmNode) { return node.location ? [{ ...node.location, role: "declaration" as const }] : []; }
function accessEvidence(node: CcmNode) { return node.location ? [{ ...node.location, role: "reference" as const }] : []; }
function routeLabel(node: CcmNode, method: string, path: string): string {
  return `${method} ${path}`;
}
function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"); }
function pythonCodeOnly(source: string): string {
  let tripleQuote: "'''" | '"""' | null = null;
  return source.split("\n").map(line => {
    const output = [...line]; let index = 0;
    const blank = (start: number, end: number) => { for (let cursor = start; cursor < end; cursor++) if (output[cursor] !== "\t") output[cursor] = " "; };
    while (index < line.length) {
      if (tripleQuote) {
        const end = line.indexOf(tripleQuote, index); const stop = end < 0 ? line.length : end + tripleQuote.length;
        blank(index, stop); index = stop; if (end >= 0) tripleQuote = null; continue;
      }
      if (line[index] === "#") { blank(index, line.length); break; }
      const triple = line.slice(index, index + 3);
      if (triple === "'''" || triple === '"""') {
        tripleQuote = triple; const end = line.indexOf(triple, index + 3); const stop = end < 0 ? line.length : end + triple.length;
        blank(index, stop); index = stop; if (end >= 0) tripleQuote = null; continue;
      }
      const quote = line[index];
      if (quote === "'" || quote === '"') {
        const start = index++; while (index < line.length) {
          if (line[index] === "\\") { index += 2; continue; }
          if (line[index] === quote) { index++; break; }
          index++;
        }
        blank(start, Math.min(index, line.length)); continue;
      }
      index++;
    }
    return output.join("");
  }).join("\n");
}
function hasParameterNamed(signature: string | null, binding: string): boolean {
  if (!signature) return true;
  const start = signature.indexOf("("); const end = signature.lastIndexOf(")");
  if (start < 0 || end < start) return true;
  const escaped = escapeRegExp(binding);
  return signature.slice(start + 1, end).split(",").some(parameter => new RegExp(`^\\s*\\*{0,2}${escaped}(?=\\s*(?::|=|,|$))`, "u").test(parameter));
}
function handlerBindsName(handlerCode: string, binding: string): boolean {
  const escaped = escapeRegExp(binding);
  const directBinding = new RegExp(`^\\s*(?:(?:async\\s+)?for\\s+${escaped}\\b|del\\s+${escaped}\\b|(?:global|nonlocal)\\s+.*\\b${escaped}\\b|(?:async\\s+)?(?:def|class)\\s+${escaped}\\b|.*\\bas\\s+${escaped}\\b|.*\\blambda\\s+[^:]*\\b${escaped}\\b)`);
  const importBindsName = (line: string): boolean => {
    const fromImport = line.match(/^\s*from\s+\S+\s+import\s+(.+)$/u);
    if (fromImport) return fromImport[1]!.replace(/[()]/gu, "").split(/\s*,\s*/u).some(item => {
      const [name, alias] = item.trim().split(/\s+as\s+/u);
      return name === "*" || (alias ?? name)?.split(".")[0] === binding;
    });
    const directImport = line.match(/^\s*import\s+(.+)$/u);
    if (!directImport) return false;
    return directImport[1]!.split(/\s*,\s*/u).some(item => {
      const [name, alias] = item.trim().split(/\s+as\s+/u);
      return (alias ?? name?.split(".")[0]) === binding;
    });
  };
  const isNameToken = (leftHandSide: string) => {
    const colon = leftHandSide.indexOf(":");
    const target = colon >= 0 ? leftHandSide.slice(0, colon) : leftHandSide;
    return target.split(/[,\s()[\]{}]+/u).some(token => token.replace(/^\*+/u, "") === binding);
  };
  const lines = handlerCode.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? "";
    if (directBinding.test(line) || new RegExp(`\\b${escaped}\\s*:=`, "u").test(line)) return true;
    let logicalImport = line;
    if (/^\s*from\s+\S+\s+import\b/u.test(line)) {
      const parenthesisBalance = (value: string) => (value.match(/\(/gu)?.length ?? 0) - (value.match(/\)/gu)?.length ?? 0);
      while (index + 1 < lines.length && (parenthesisBalance(logicalImport) > 0 || logicalImport.trimEnd().endsWith("\\"))) {
        logicalImport = `${logicalImport.replace(/\\\s*$/u, "")} ${lines[++index]!.trim()}`;
      }
    }
    if (importBindsName(logicalImport)) return true;
    const assignment = line.match(/(?<![=!<>])(?:\+=|-=|\*=|\/=|\|=|&=|\^=|=(?!=))/u);
    if (assignment && isNameToken(line.slice(0, assignment.index))) return true;
    const annotation = line.match(/^\s*(.+?)\s*:\s*[^=]+$/u);
    if (annotation && isNameToken(annotation[1]!)) return true;
  }
  return false;
}
function bindingIsShadowed(input: { source: string; binding: string; signature: string | null; handlerBody: string; exactImportLines: ReadonlySet<number>; sourceModelDeclarationLine: number | null }): boolean {
  const { source, binding, signature, handlerBody, exactImportLines, sourceModelDeclarationLine } = input;
  if (hasParameterNamed(signature, binding)) return true;
  const handlerCode = pythonCodeOnly(handlerBody);
  if (handlerBindsName(handlerCode, binding)) return true;

  const moduleCode = pythonCodeOnly(source).split("\n");
  const localScopeIndents: number[] = [];
  for (let index = 0; index < moduleCode.length; index++) {
    const line = moduleCode[index] ?? ""; if (!line.trim()) continue;
    const indent = line.match(/^\s*/u)?.[0].length ?? 0;
    while (localScopeIndents.length && indent <= localScopeIndents.at(-1)!) localScopeIndents.pop();
    const lineNumber = index + 1;
    const isModelImport = exactImportLines.has(lineNumber);
    if (!localScopeIndents.length && !isModelImport && lineNumber !== sourceModelDeclarationLine && handlerBindsName(line, binding)) return true;
    if (/^\s*(?:async\s+)?(?:def|class)\s+[A-Za-z_]\w*/u.test(line)) localScopeIndents.push(indent);
  }
  return false;
}

/** Extract explicit FastAPI-style route decorators and SQLAlchemy model declarations from the Python adapter facts. */
export function extractPythonFastApi(input: SemanticInput): SemanticFragment {
  const fragment = emptyFragment();
  const pythonNodes = input.ccm.nodes.filter(node => node.language === "python");
  const routeNodes = pythonNodes.filter(node => node.kind === "Function" && typeof node.attributes.routeMethod === "string" && typeof node.attributes.routePath === "string");
  const modelNodes = pythonNodes.filter(node => node.kind === "Class" && node.attributes.dataModel === true);
  if (!routeNodes.length && !modelNodes.length) return fragment;
  if (routeNodes.length) fragment.frameworks.push("FastAPI-style Python routes");
  if (modelNodes.length) fragment.frameworks.push("SQLAlchemy-style data models");
  const semanticNodes = new Map<string, SemanticNode>();
  const features = new Map<string, SemanticFeature>();
  const edges = new Map<string, SemanticEdge>();
  const pythonNodesById = new Map(pythonNodes.map(node => [node.id, node]));
  const modelIds = new Set(modelNodes.map(node => node.id));
  const modulesById = new Map(pythonNodes.filter(node => node.kind === "Module").map(node => [node.id, node]));
  const modelBindingsByFile = new Map<string, Map<string, Map<string, CcmNode>>>();
  const exactImportLinesByFile = new Map<string, Map<string, Set<number>>>();
  const addModelBinding = (filePath: string, binding: string, model: CcmNode) => {
    const bindings = modelBindingsByFile.get(filePath) ?? new Map<string, Map<string, CcmNode>>();
    const candidates = bindings.get(binding) ?? new Map<string, CcmNode>();
    candidates.set(model.id, model);
    bindings.set(binding, candidates);
    modelBindingsByFile.set(filePath, bindings);
  };
  for (const model of modelNodes) if (model.filePath && model.name) addModelBinding(model.filePath, model.name, model);
  const decodedSources = new Map<string, string>();
  const textFor = (filePath: string): string => {
    const cached = decodedSources.get(filePath); if (cached !== undefined) return cached;
    const bytes = input.sources[filePath];
    const text = bytes ? new TextDecoder("utf-8", { fatal: false }).decode(bytes) : "";
    decodedSources.set(filePath, text); return text;
  };
  for (const edge of input.ccm.edges) {
    if (edge.kind !== "IMPORTS" || edge.resolution !== "Exact") continue;
    const sourceModule = modulesById.get(edge.sourceId);
    const model = pythonNodesById.get(edge.targetId);
    if (!sourceModule?.filePath || !model || !modelIds.has(model.id) || !model.name) continue;
    const importLineNumber = edge.evidence[0]?.startLine;
    const importLine = importLineNumber ? textFor(sourceModule.filePath).split("\n")[importLineNumber - 1] ?? "" : "";
    const imported = importLine.match(/^\s*from\s+.+?\s+import\s+(.+)\s*$/u)?.[1]?.replace(/[()]/gu, "");
    if (!imported) continue;
    // The Python adapter resolves a single explicit class target per import
    // edge. Match only that bound symbol and its alias; unresolved and
    // multi-symbol imports stay out of the semantic model.
    const binding = imported.split(/\s*,\s*/u).map(item => {
      const [name, alias] = item.trim().split(/\s+as\s+/u);
      return { name, alias: alias ?? name };
    }).find(item => item.name === model.name);
    if (binding?.alias && /^[A-Za-z_]\w*$/u.test(binding.alias)) {
      addModelBinding(sourceModule.filePath, binding.alias, model);
      if (importLineNumber) {
        const fileLines = exactImportLinesByFile.get(sourceModule.filePath) ?? new Map<string, Set<number>>();
        const lines = fileLines.get(binding.alias) ?? new Set<number>();
        lines.add(importLineNumber); fileLines.set(binding.alias, lines); exactImportLinesByFile.set(sourceModule.filePath, fileLines);
      }
    }
  }
  const modelsBoundAs = (filePath: string, name: string): CcmNode[] => [...(modelBindingsByFile.get(filePath)?.get(name)?.values() ?? [])];
  const actorId = semanticId("actor", "python", 0, "python-api-client");
  const storeIdByTechnicalNode = new Map<string, string>();
  const modelDeclarationLineById = new Map(modelNodes.map(model => {
    if (!model.filePath || !model.signature) return [model.id, null] as const;
    const firstLine = Math.max(0, (model.location?.startLine ?? 1) - 1);
    const lineIndex = textFor(model.filePath).split("\n").findIndex((line, index) => index >= firstLine && line.trim() === model.signature);
    return [model.id, lineIndex >= 0 ? lineIndex + 1 : null] as const;
  }));
  for (const model of modelNodes) {
    if (!model.filePath) continue;
    const storeId = semanticId("store", model.filePath, model.location?.startByte ?? 0, `sqlalchemy:${model.id}`);
    storeIdByTechnicalNode.set(model.id, storeId);
    const store = semanticNode({ kind: "store", filePath: model.filePath, startByte: model.location?.startByte ?? 0, key: model.id, label: humanLabel(model.name), featureId: null,
      confidence: "indicated", reason: "The declaration matches a SQLAlchemy-style base or table marker; ORM registration and runtime persistence are not verified.", evidence: nodeEvidence(model), technicalNodeIds: [model.id] });
    store.id = storeId; semanticNodes.set(storeId, store);
  }

  for (const route of routeNodes) {
    const filePath = route.filePath; const bytes = filePath ? input.sources[filePath] : undefined;
    if (!filePath || !bytes || !route.location) continue;
    const path = route.attributes.routePath as string;
    const methods = (route.attributes.routeMethod as string).split(/[\/,]/u).map(method => method.trim().toUpperCase()).filter(method => /^[A-Z]+$/u.test(method)).slice(0, 5);
    if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\") || !methods.length) {
      fragment.limitations.push({ filePath, reason: "Python route decorator is dynamic or outside the supported literal method/path pattern; it is not included as a proven route." });
      continue;
    }
    const body = new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(route.location.startByte, route.location.endByte));
    const signatureOffset = route.signature ? body.indexOf(route.signature) : -1;
    const handlerBody = signatureOffset >= 0 ? body.slice(signatureOffset + route.signature!.length) : "";
    const executableBody = pythonCodeOnly(handlerBody);
    const routeEvidence = [{ ...route.location, role: "declaration" as const }];
    for (const method of methods) {
      const label = routeLabel(route, method, path);
      const featureId = semanticId("feature", filePath, route.location.startByte, `python:${method}:${path}:${route.id}`);
      const featureNode = semanticNode({ kind: "feature", filePath, startByte: route.location.startByte, key: featureId, label: humanLabel(route.name), featureId: null,
        confidence: "proven", reason: "Feature group is derived from a literal route decorator and its handler declaration.", evidence: routeEvidence, technicalNodeIds: [route.id] });
      featureNode.id = featureId;
      semanticNodes.set(featureId, featureNode);
      const stepId = semanticId("step", filePath, route.location.startByte, `python:route:${method}:${path}:${route.id}`);
      const step = semanticNode({ kind: "step", filePath, startByte: route.location.startByte, key: `${method}:${path}:${route.id}`, label, featureId,
        confidence: "proven", reason: "HTTP method and route path are literal values on the handler decorator; runtime mounting is not inferred.", evidence: routeEvidence, technicalNodeIds: [route.id] });
      step.label = label;
      step.id = stepId; semanticNodes.set(stepId, step);
      const handlerId = semanticId("component", filePath, route.location.startByte, `python:handler:${route.id}`);
      const handler = semanticNode({ kind: "component", filePath, startByte: route.location.startByte, key: route.id, label: humanLabel(route.name), featureId,
        confidence: "proven", reason: "The decorated route points directly to this handler declaration.", evidence: routeEvidence, technicalNodeIds: [route.id] });
      handler.id = handlerId; semanticNodes.set(handlerId, handler);
      const feature: SemanticFeature = { id: featureId, label: humanLabel(route.name), entryNodeIds: [stepId], nodeIds: [featureId, actorId, stepId, handlerId], edgeIds: [], evidence: compactEvidence(routeEvidence) };
      features.set(featureId, feature);
      const actorEvidence = compactEvidence(routeEvidence);
      let actor = semanticNodes.get(actorId);
      if (!actor) { actor = semanticNode({ kind: "actor", filePath, startByte: route.location.startByte, key: "python-api-client", label: "API client", featureId: null,
        confidence: "indicated", reason: "An HTTP route decorator is present; the source does not identify the real-world caller or authenticate its identity.", evidence: actorEvidence }); actor.id = actorId; semanticNodes.set(actorId, actor); }
      else actor.evidence = compactEvidence([...actor.evidence, ...actorEvidence]);
      const actorEdge: SemanticEdge = { id: semanticEdgeId(filePath, route.location.startByte, `python:actor:${actorId}:${stepId}`), source: actorId, target: stepId, label: "sends HTTP request", confidence: "indicated", reason: "The route declaration defines an HTTP entry point; runtime requests and caller identity are not verified.", evidence: actorEvidence };
      const handlerEdge: SemanticEdge = { id: semanticEdgeId(filePath, route.location.startByte, `python:handler:${stepId}:${handlerId}`), source: stepId, target: handlerId, label: "handled by", confidence: "proven", reason: "The route decorator is attached to the handler declaration.", evidence: routeEvidence };
      edges.set(actorEdge.id, actorEdge); edges.set(handlerEdge.id, handlerEdge);
      feature.edgeIds.push(actorEdge.id, handlerEdge.id);

      const hasDataOperation = /(?:\b[A-Za-z_]\w*(?:\s*\.\s*[A-Za-z_]\w*)*\s*\.\s*(?:query|add|add_all|merge|delete|execute|scalars)\s*\(|\b(?:session|db|database)\s*\.\s*get\s*\(|\bselect\s*\()/iu.test(executableBody);
      if (hasDataOperation) {
        let linkedModel = false; let ambiguousBinding = false;
        for (const [bindingName, candidates] of modelBindingsByFile.get(filePath) ?? []) {
          if (!new RegExp(`\\b${escapeRegExp(bindingName)}\\b`, "u").test(executableBody)) continue;
          if (candidates.size !== 1) {
            ambiguousBinding = true;
            fragment.limitations.push({ filePath, reason: `Handler ${route.name} references ambiguous Python model binding ${bindingName}; no data access relationship was inferred.` });
            continue;
          }
          const model = [...candidates.values()][0]!;
          const exactImportLines = exactImportLinesByFile.get(filePath)?.get(bindingName) ?? new Set<number>();
          if (bindingIsShadowed({ source: textFor(filePath), binding: bindingName, signature: route.signature, handlerBody, exactImportLines,
            sourceModelDeclarationLine: model.filePath === filePath ? modelDeclarationLineById.get(model.id) ?? null : null })) {
            ambiguousBinding = true;
            fragment.limitations.push({ filePath, reason: `Handler ${route.name} shadows or rebinds Python model binding ${bindingName}; no data access relationship was inferred.` });
            continue;
          }
          const storeId = storeIdByTechnicalNode.get(model.id); if (!storeId) continue;
          linkedModel = true;
          feature.nodeIds.push(storeId);
          const storeEdge: SemanticEdge = { id: semanticEdgeId(filePath, route.location.startByte, `python:store:${handlerId}:${storeId}`), source: handlerId, target: storeId, label: "accesses data model", confidence: "indicated", reason: "The handler references an unambiguous local or explicitly imported model binding alongside a database operation token; dynamic persistence is not followed.", evidence: compactEvidence([...accessEvidence(route), ...nodeEvidence(model)]) };
          edges.set(storeEdge.id, storeEdge); feature.edgeIds.push(storeEdge.id);
        }
        if (!linkedModel && !ambiguousBinding && modelNodes.length) fragment.limitations.push({ filePath, reason: `Handler ${route.name} contains a database operation but no unambiguous local or explicitly imported data model binding was identified.` });
      }
      if (/\b(if|try|except|raise|HTTPException)\b/u.test(executableBody)) fragment.limitations.push({ filePath, reason: `Handler ${route.name} contains a conditional or error branch; this first Python adapter records the entry and direct data references but does not project decision outcomes.` });
    }
  }

  const storeByTechnicalNode = new Map([...semanticNodes.values()].filter(node => node.kind === "store").flatMap(store => store.technicalNodeIds.map(id => [id, store] as const)));
  for (const property of pythonNodes.filter(node => node.kind === "Property" && node.attributes.relationProperty === true)) {
    const owner = property.parentId ? pythonNodes.find(node => node.id === property.parentId) : null;
    const sourceStore = owner ? storeByTechnicalNode.get(owner.id) : null;
    if (!sourceStore || !property.location || !property.signature) continue;
    const targetName = property.signature.match(/relationship\s*\(\s*["']([A-Za-z_]\w*)["']/u)?.[1];
    if (!targetName) {
      fragment.limitations.push({ filePath: property.filePath ?? "", reason: `SQLAlchemy relationship ${property.name} does not use a supported literal model name; no data relationship was inferred.` });
      continue;
    }
    const targetCandidates = targetName && property.filePath ? modelsBoundAs(property.filePath, targetName) : [];
    if (targetCandidates.length > 1) {
      fragment.limitations.push({ filePath: property.filePath ?? "", reason: `SQLAlchemy relationship target ${targetName} is ambiguous in this module; no data relationship was inferred.` });
      continue;
    }
    if (!targetCandidates.length) {
      fragment.limitations.push({ filePath: property.filePath ?? "", reason: `SQLAlchemy relationship target ${targetName} could not be resolved to one local or explicitly imported model; no data relationship was inferred.` });
      continue;
    }
    const targetNode = targetCandidates[0] ?? null;
    const targetStore = targetNode ? storeByTechnicalNode.get(targetNode.id) : null;
    if (!targetStore) continue;
    if (targetStore.id === sourceStore.id) {
      fragment.limitations.push({ filePath: property.filePath ?? "", reason: `SQLAlchemy self-reference on ${property.name} is not represented in the current ADD profile.` });
      continue;
    }
    const edge: SemanticEdge = { id: semanticEdgeId(property.filePath ?? "", property.location.startByte, `python:data-relation:${sourceStore.id}:${targetStore.id}`), source: sourceStore.id, target: targetStore.id,
      label: "has relationship to", confidence: "proven", reason: "A SQLAlchemy relationship property names an unambiguous local or explicitly imported data model.", evidence: [{ ...property.location, role: "reference" }] };
    edges.set(edge.id, edge);
  }
  for (const feature of features.values()) {
    const related = [...edges.values()].filter(edge => feature.nodeIds.includes(edge.source) || feature.nodeIds.includes(edge.target));
    feature.edgeIds = [...new Set([...feature.edgeIds, ...related.map(edge => edge.id)])];
    feature.nodeIds = [...new Set(feature.nodeIds)];
    fragment.features.push(feature);
  }
  fragment.nodes = [...semanticNodes.values()].sort((a, b) => a.id.localeCompare(b.id));
  fragment.edges = [...edges.values()].sort((a, b) => a.id.localeCompare(b.id));
  fragment.limitations = [...new Map(fragment.limitations.map(item => [`${item.filePath}:${item.reason}`, item])).values()];
  return fragment;
}
