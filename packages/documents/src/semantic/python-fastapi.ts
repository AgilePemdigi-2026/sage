import type { CcmNode } from "@sage/contracts";
import { compactEvidence, emptyFragment, humanLabel, semanticEdgeId, semanticId, semanticNode } from "./builder.ts";
import type { SemanticEdge, SemanticFeature, SemanticFragment, SemanticInput, SemanticNode } from "./model.ts";

function nodeEvidence(node: CcmNode) { return node.location ? [{ ...node.location, role: "declaration" as const }] : []; }
function accessEvidence(node: CcmNode) { return node.location ? [{ ...node.location, role: "reference" as const }] : []; }
function routeLabel(node: CcmNode, method: string, path: string): string {
  return `${method} ${path}`;
}
function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"); }

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
  const actorId = semanticId("actor", "python", 0, "python-api-client");
  const storeIdByTechnicalNode = new Map<string, string>();
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

      for (const model of modelNodes) {
        if (!model.name || !new RegExp(`\\b${escapeRegExp(model.name)}\\b`, "u").test(body)) continue;
        if (!/(?:query|select|add|add_all|merge|delete|get|execute|scalars|session\s*\.)/iu.test(body)) continue;
        const storeId = storeIdByTechnicalNode.get(model.id); if (!storeId) continue;
        feature.nodeIds.push(storeId);
        const storeEdge: SemanticEdge = { id: semanticEdgeId(filePath, route.location.startByte, `python:store:${handlerId}:${storeId}`), source: handlerId, target: storeId, label: "accesses data model", confidence: "indicated", reason: "The handler body references a model declaration alongside a database operation token; indirect or dynamic persistence is not followed.", evidence: compactEvidence([...accessEvidence(route), ...nodeEvidence(model)]) };
        edges.set(storeEdge.id, storeEdge); feature.edgeIds.push(storeEdge.id);
      }
      if (/\b(if|try|except|raise|HTTPException)\b/u.test(body)) fragment.limitations.push({ filePath, reason: `Handler ${route.name} contains a conditional or error branch; this first Python adapter records the entry and direct data references but does not project decision outcomes.` });
    }
  }

  const storeByTechnicalNode = new Map([...semanticNodes.values()].filter(node => node.kind === "store").flatMap(store => store.technicalNodeIds.map(id => [id, store] as const)));
  for (const property of pythonNodes.filter(node => node.kind === "Property" && node.attributes.relationProperty === true)) {
    const owner = property.parentId ? pythonNodes.find(node => node.id === property.parentId) : null;
    const sourceStore = owner ? storeByTechnicalNode.get(owner.id) : null;
    if (!sourceStore || !property.location || !property.signature) continue;
    const targetName = property.signature.match(/relationship\s*\(\s*["']?([A-Za-z_]\w*)/u)?.[1];
    const targetNode = targetName ? modelNodes.find(node => node.name === targetName) : null;
    const targetStore = targetNode ? storeByTechnicalNode.get(targetNode.id) : null;
    if (!targetStore || targetStore.id === sourceStore.id) continue;
    const edge: SemanticEdge = { id: semanticEdgeId(property.filePath ?? "", property.location.startByte, `python:data-relation:${sourceStore.id}:${targetStore.id}`), source: sourceStore.id, target: targetStore.id,
      label: "has relationship to", confidence: "proven", reason: "A SQLAlchemy relationship property names a locally declared data model.", evidence: [{ ...property.location, role: "reference" }] };
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
