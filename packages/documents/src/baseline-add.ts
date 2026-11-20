import { createHash } from "node:crypto";
import type { CcmV1, EvidenceSpan } from "@sage/contracts";
import { ADD_BASELINE_SCHEMA, ARCHIMATE_PROFILE_VERSION, archimatePairAllowed } from "./baseline-add-model.ts";
import type { AddElement, AddBaselineModel, AddRelationship, ArchiMateRelationshipType } from "./baseline-add-model.ts";
import { projectCoreBaselineView } from "./baseline-core-views.ts";
import type { SemanticModel } from "./semantic/model.ts";

export { ADD_BASELINE_SCHEMA, ARCHIMATE_PROFILE_VERSION, isAddBaselineModel } from "./baseline-add-model.ts";
export type { AddElement, AddBaselineModel, AddOrigin, AddRelationship, ArchiMateElementType, ArchiMateRelationshipType } from "./baseline-add-model.ts";

const id = (prefix: string, key: string) => `${prefix}:${createHash("sha256").update(key).digest("hex").slice(0, 20)}`;
const uniqueEvidence = (spans: EvidenceSpan[]) => [...new Map(spans.map(span => [`${span.filePath}:${span.startLine}:${span.endLine}:${span.role}`, span])).values()];
function routeMethod(label: string): string | null {
  const match = label.trim().match(/^((?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE)(?:\/(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE))*)\s+(\/\S*)$/iu);
  return match?.[1]?.toUpperCase() ?? null;
}

function composeBuildContext(node: SemanticModel["nodes"][number]): string | null {
  const context = node.reason.match(/\bbuildContext=([^;]+)/u)?.[1];
  return node.kind === "component" && context ? context : null;
}

function routeHandlerLabel(node: SemanticModel["nodes"][number], semantic: SemanticModel): string {
  if (node.kind !== "component" || !/^(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) API$/u.test(node.label)) return node.label;
  const route = semantic.edges.find(edge => edge.target === node.id && edge.label === "ditangani oleh")
    ?.source;
  const step = route ? semantic.nodes.find(candidate => candidate.id === route) : undefined;
  return step?.kind === "step" && routeMethod(step.label) ? `${step.label} handler` : node.label;
}

function composeApplicationName(node: SemanticModel["nodes"][number]): boolean {
  return node.kind === "component" && composeBuildContext(node) !== null && node.featureId === null;
}

/** Build a conservative ADD baseline from already verified source facts and semantic evidence. */
export function buildAddBaseline(input: { ccm: CcmV1; semantic: SemanticModel; sourceCkgHash: string }): AddBaselineModel {
  if (!/^[a-f0-9]{64}$/.test(input.sourceCkgHash) || input.semantic.sourceCkgHash !== input.sourceCkgHash ||
      input.semantic.snapshot.commitSha !== input.ccm.snapshot.commitSha) throw new Error("ADD source snapshot mismatch.");
  const elements = new Map<string, AddElement>();
  const relationships = new Map<string, AddRelationship>();
  const addElement = (element: AddElement) => { if (!elements.has(element.id)) elements.set(element.id, element); };
  const addRelationship = (edge: AddRelationship) => {
    const source = elements.get(edge.sourceId); const target = elements.get(edge.targetId);
    if (!source || !target || source.id === target.id || !archimatePairAllowed(edge.type, source.type, target.type)) return;
    if (!relationships.has(edge.id)) relationships.set(edge.id, edge);
  };

  const semanticNodes = new Map(input.semantic.nodes.map(node => [node.id, node]));
  const semanticFeatures = new Map(input.semantic.features.map(feature => [feature.id, feature]));
  const appId = id("application", `${input.ccm.snapshot.repository}:${input.ccm.snapshot.commitSha}`);
  addElement({ id: appId, type: "ApplicationComponent", name: input.ccm.snapshot.repository.split("/").at(-1) ?? input.ccm.snapshot.repository,
    description: "System-level scope represented by the analyzed repository snapshot.", origin: "source", featureGroup: null, evidence: [], review: "unreviewed" });
  const deploymentNodes = input.semantic.nodes.filter(composeApplicationName);
  const deploymentAppIds = new Map<string, string>();
  for (const node of deploymentNodes) {
    const context = composeBuildContext(node)!;
    const deploymentId = id("application", node.id);
    deploymentAppIds.set(node.id, deploymentId);
    addElement({ id: deploymentId, type: "ApplicationComponent", name: node.label,
      description: `${node.reason} Build context “${context}”.`, origin: "source", featureGroup: null,
      evidence: uniqueEvidence(node.evidence), review: "unreviewed" });
    addRelationship({ id: id("composition", `${appId}:${deploymentId}`), type: "CompositionRelationship", sourceId: appId, targetId: deploymentId,
      label: "contains configured service", origin: "source", confidence: "proven",
      reason: "The Compose file declares this build-backed service within the repository-level system scope; this configuration does not establish current runtime availability.",
      evidence: uniqueEvidence(node.evidence), review: "unreviewed" });
  }
  const contextOwner = (path: string): string | null => {
    const matches = deploymentNodes.flatMap(node => {
      const context = composeBuildContext(node)!;
      return context === "." || path === context || path.startsWith(`${context}/`) ? [{ node, context }] : [];
    });
    if (!matches.length) return null;
    const deepest = Math.max(...matches.map(item => item.context === "." ? 0 : item.context.split("/").length));
    const owners = matches.filter(item => (item.context === "." ? 0 : item.context.split("/").length) === deepest);
    return owners.length === 1 ? deploymentAppIds.get(owners[0]!.node.id) ?? null : null;
  };
  const ownerForEvidence = (spans: EvidenceSpan[]): string => {
    const owners = [...new Set(spans.map(span => contextOwner(span.filePath)).filter((owner): owner is string => owner !== null))];
    return owners.length === 1 ? owners[0]! : appId;
  };
  input.semantic.features.forEach(feature => {
    const serviceId = id("service", feature.id);
    addElement({ id: serviceId, type: "ApplicationService", name: feature.label, description: null, origin: "source", featureGroup: feature.label, evidence: uniqueEvidence(feature.evidence), review: "unreviewed" });
  });
  const semanticToArchimate = new Map<string, string>();
  const archimateToSemantic = new Map<string, string>();
  const mapSemanticElement = (nodeId: string, elementId: string) => {
    semanticToArchimate.set(nodeId, elementId);
    archimateToSemantic.set(elementId, nodeId);
  };
  for (const [nodeId, applicationId] of deploymentAppIds) semanticToArchimate.set(nodeId, applicationId);
  for (const node of input.semantic.nodes) {
    if (node.kind === "store") {
      const dataId = id("data", node.id); mapSemanticElement(node.id, dataId);
      const relatedFeatures = new Set(input.semantic.edges.filter(edge => edge.target === node.id)
        .map(edge => semanticNodes.get(edge.source)?.featureId).filter((featureId): featureId is string => Boolean(featureId)));
      const featureId = relatedFeatures.size === 1 ? [...relatedFeatures][0] : node.featureId;
      addElement({ id: dataId, type: "DataObject", name: node.label, description: node.reason, origin: "source", featureGroup: featureId ? semanticFeatures.get(featureId)?.label ?? null : null, evidence: uniqueEvidence(node.evidence), review: "unreviewed" });
      continue;
    }
    if (node.kind === "component") {
      if (composeApplicationName(node)) continue;
      const method = routeMethod(node.label);
      const componentId = id(method ? "interface" : "function", node.id); mapSemanticElement(node.id, componentId);
      addElement({ id: componentId, type: method ? "ApplicationInterface" : "ApplicationFunction", name: method ? node.label : routeHandlerLabel(node, input.semantic),
        description: node.reason, origin: "source",
        featureGroup: node.featureId ? semanticFeatures.get(node.featureId)?.label ?? null : null,
        evidence: uniqueEvidence(node.evidence), review: "unreviewed" });
      const ownerId = ownerForEvidence(node.evidence);
      if (method) addRelationship({ id: id("composition", `${ownerId}:${componentId}`), type: "CompositionRelationship", sourceId: ownerId, targetId: componentId,
        label: "has interface", origin: "source", confidence: "indicated", reason: "The interface contract is declared in the analyzed repository scope; runtime exposure is not inferred.", evidence: uniqueEvidence(node.evidence), review: "unreviewed" });
      else {
        addRelationship({ id: id("assignment", `${ownerId}:${componentId}`), type: "AssignmentRelationship", sourceId: ownerId, targetId: componentId,
          label: "assigned internal behavior", origin: "source", confidence: "indicated", reason: "A source-level handler or module is assigned to the most specific unique Compose build context supported by its evidence; deployment is not inferred from source location alone.", evidence: uniqueEvidence(node.evidence), review: "unreviewed" });
        if (node.featureId) {
          const serviceId = id("service", node.featureId);
          addRelationship({ id: id("realization", `${componentId}:${serviceId}`), type: "RealizationRelationship", sourceId: componentId, targetId: serviceId,
            label: "realizes feature service", origin: "source", confidence: "indicated", reason: "The semantic extractor groups this internal source behavior with the feature entry point; the ArchiMate realization is indicated and should be reviewed.", evidence: uniqueEvidence([...node.evidence, ...(semanticFeatures.get(node.featureId)?.evidence ?? [])]), review: "unreviewed" });
        }
      }
      continue;
    }
    if (node.kind === "feature") mapSemanticElement(node.id, id("service", node.featureId ?? node.id));
    if (node.kind === "step") {
      const method = routeMethod(node.label);
      if (!method) continue;
      const interfaceId = id("interface", node.id); mapSemanticElement(node.id, interfaceId);
      addElement({ id: interfaceId, type: "ApplicationInterface", name: node.label, description: node.reason, origin: "source",
        featureGroup: node.featureId ? semanticFeatures.get(node.featureId)?.label ?? null : null,
        evidence: uniqueEvidence(node.evidence), review: "unreviewed" });
      const ownerId = ownerForEvidence(node.evidence);
      addRelationship({ id: id("composition", `${ownerId}:${interfaceId}`), type: "CompositionRelationship", sourceId: ownerId, targetId: interfaceId,
        label: "has interface", origin: "source", confidence: "indicated", reason: "The HTTP route is declared in the analyzed repository scope; runtime exposure is not inferred.", evidence: uniqueEvidence(node.evidence), review: "unreviewed" });
    }
  }
  for (const edge of input.semantic.edges) {
    let sourceId = semanticToArchimate.get(edge.source); let targetId = semanticToArchimate.get(edge.target);
    if (!sourceId || !targetId) continue;
    const sourceNode = semanticNodes.get(edge.source);
    const targetNode = semanticNodes.get(edge.target);
    let type: ArchiMateRelationshipType = "AssociationRelationship";
    let label = edge.label;
    let reason = edge.reason;
    let confidence = edge.confidence;
    if (sourceNode?.kind === "store" && targetNode?.kind === "store") {
      type = "AssociationRelationship";
      label = "references data object";
      reason = `${edge.reason} This is an explicit data-to-data reference in the source contract.`;
    } else if (sourceNode?.kind === "component" && targetNode?.kind === "component" &&
      elements.get(sourceId)?.type === "ApplicationComponent" && elements.get(targetId)?.type === "ApplicationComponent") {
      type = "FlowRelationship";
      reason = `${edge.reason} Compose configuration and a matching source HTTP client establish an intended integration path; live runtime traffic and availability are not inferred.`;
    } else if (targetNode?.kind === "store" && ["ApplicationFunction", "ApplicationService"].includes(elements.get(sourceId)?.type ?? "")) {
      type = "AccessRelationship";
    }
    else if (sourceNode?.kind === "feature" && targetNode?.kind === "step" &&
      elements.get(sourceId)?.type === "ApplicationService" && elements.get(targetId)?.type === "ApplicationInterface") {
      type = "AssignmentRelationship";
      sourceId = targetId;
      targetId = semanticToArchimate.get(edge.source)!;
      label = "interface assigned to service";
      confidence = "indicated";
      reason = `${edge.reason} Feature membership groups this interface with the service; this assignment is an indicated ArchiMate projection, not a claim of runtime publication.`;
    } else if (sourceNode?.kind === "step" && targetNode?.kind === "component" &&
      elements.get(sourceId)?.type === "ApplicationInterface" && elements.get(targetId)?.type === "ApplicationFunction") {
      type = "TriggeringRelationship";
      reason = `${edge.reason} The source statically links this declared request interface to its handler; runtime reachability is not inferred.`;
    } else if (sourceNode?.kind === "component" && targetNode?.kind === "component" &&
      elements.get(sourceId)?.type === "ApplicationFunction" && elements.get(targetId)?.type === "ApplicationFunction") {
      type = "TriggeringRelationship"; label = "triggers internal behavior";
      reason = `${edge.reason} A statically observed source call is represented as a triggering relationship between internal functions.`;
    } else continue;
    addRelationship({ id: id(type, edge.id), type, sourceId, targetId, label, origin: "source",
      confidence, reason, evidence: uniqueEvidence(edge.evidence),
      ...(type === "AccessRelationship" && edge.dataOperation ? { dataOperation: edge.dataOperation } : {}), review: "unreviewed" });
  }

  // Laravel feature membership and some framework extractors do not emit an
  // explicit feature-to-route edge. Keep the interface traceable, but label
  // this same-feature grouping as indicated rather than claiming direct proof.
  for (const feature of input.semantic.features) {
    const serviceId = id("service", feature.id);
    for (const entryNodeId of feature.entryNodeIds) {
      const entry = semanticNodes.get(entryNodeId);
      if (!entry || entry.kind !== "step" || !routeMethod(entry.label)) continue;
      const interfaceId = semanticToArchimate.get(entry.id);
      if (!interfaceId || [...relationships.values()].some(edge => edge.type === "AssignmentRelationship" && edge.sourceId === interfaceId && edge.targetId === serviceId)) continue;
      addRelationship({ id: id("assignment", `${interfaceId}:${serviceId}`), type: "AssignmentRelationship", sourceId: interfaceId, targetId: serviceId,
        label: "interface assigned to service", origin: "source", confidence: "indicated",
        reason: "The route is listed as an entry point of this extracted feature group; this is an indicated assignment, not evidence of runtime publication.",
        evidence: uniqueEvidence([...feature.evidence, ...entry.evidence]), review: "unreviewed" });
    }
  }

  const dataElements = [...elements.values()].filter(element => element.type === "DataObject").sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const interfaces = [...elements.values()].filter(element => element.type === "ApplicationInterface").sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const appElements = [...elements.values()].filter(element => element.type === "ApplicationComponent").sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const applicationViewElements = [...elements.values()].filter(element =>
    element.type === "ApplicationComponent" || element.type === "ApplicationFunction" ||
    element.type === "ApplicationService" || element.type === "ApplicationInterface");
  const applicationViewElementIds = new Set(applicationViewElements.map(element => element.id));
  const accessByApplicationData = new Map<string, AddRelationship[]>();
  for (const edge of relationships.values()) if (edge.type === "AccessRelationship") {
    const sourceNodeId = archimateToSemantic.get(edge.sourceId);
    const sourceEvidence = (sourceNodeId ? semanticNodes.get(sourceNodeId)?.evidence : undefined) ?? edge.evidence;
    const applicationId = ownerForEvidence(sourceEvidence);
    const key = `${applicationId}\0${edge.targetId}`;
    const bucket = accessByApplicationData.get(key) ?? [];
    bucket.push(edge);
    accessByApplicationData.set(key, bucket);
  }
  const crud = (app: AddElement, dataId: string, relations: AddRelationship[]) => {
    const confirmed = relations.filter(edge => edge.confidence === "proven");
    const operation = (kind: "create" | "read" | "update" | "delete"): "yes" | "unknown" => confirmed.some(edge =>
      edge.dataOperation === kind || edge.dataOperation === "upsert" && (kind === "create" || kind === "update")) ? "yes" : "unknown";
    return { applicationId: app.id, dataId, create: operation("create"), read: operation("read"),
      update: operation("update"), delete: operation("delete"), evidence: uniqueEvidence(relations.flatMap(edge => edge.evidence)) };
  };
  const links = [...relationships.values()];
  const applicationInteractions = links.filter(edge => edge.type === "FlowRelationship" &&
    elements.get(edge.sourceId)?.type === "ApplicationComponent" && elements.get(edge.targetId)?.type === "ApplicationComponent")
    .map(edge => ({ sourceApplicationId: edge.sourceId, targetApplicationId: edge.targetId, mechanism: edge.label, evidence: edge.evidence }));
  // Access paths belong in the CRUD matrix. The ArchiMate Data Structure view
  // shows only data objects and explicit data-to-data associations.
  const dataViewEdges = links.filter(edge => edge.type === "AssociationRelationship" &&
    elements.get(edge.sourceId)?.type === "DataObject" && elements.get(edge.targetId)?.type === "DataObject");
  const applicationViewEdges = links.filter(edge => applicationViewElementIds.has(edge.sourceId) && applicationViewElementIds.has(edge.targetId));
  const model: AddBaselineModel = {
    schemaVersion: ADD_BASELINE_SCHEMA, archimateVersion: ARCHIMATE_PROFILE_VERSION, snapshot: structuredClone(input.ccm.snapshot),
    generation: { extractorVersion: input.semantic.extractorVersion, llmOutcome: "not-requested", llmModel: null },
    sourceCkgHash: input.sourceCkgHash, elements: [...elements.values()].sort((a, b) => a.id.localeCompare(b.id)),
    relationships: links.sort((a, b) => a.id.localeCompare(b.id)),
    catalogs: {
      dataEntities: dataElements.map(element => ({ elementId: element.id, owner: null, description: element.description })),
      applicationPortfolio: appElements.map(element => ({ elementId: element.id, planned: false as const, description: element.description })),
      interfaces: interfaces.map(element => ({ elementId: element.id, protocol: routeMethod(element.name), contract: element.name })),
    },
    matrices: {
      applicationData: [...accessByApplicationData].flatMap(([key, access]) => {
        const [applicationId, dataId] = key.split("\0");
        const application = appElements.find(item => item.id === applicationId);
        return application && dataElements.some(item => item.id === dataId) ? [crud(application, dataId!, access)] : [];
      }),
      applicationInteractions,
    },
    views: {
      dataStructure: { elementIds: [...new Set([...dataElements.map(element => element.id), ...dataViewEdges.flatMap(edge => [edge.sourceId, edge.targetId])])], relationshipIds: dataViewEdges.map(edge => edge.id) },
      applicationCooperation: { elementIds: [...new Set([...applicationViewElements.map(element => element.id), ...applicationViewEdges.flatMap(edge => [edge.sourceId, edge.targetId])])], relationshipIds: applicationViewEdges.map(edge => edge.id) },
    },
    narratives: {
      dataBaseline: `${dataElements.length} data object teridentifikasi dari operasi store yang dianalisis. Owner dan distribusi aktual memerlukan konfirmasi.`,
      applicationBaseline: `Cakupan repository mencakup ${Math.max(0, appElements.length - 1)} build-backed service component yang dideklarasikan pada Docker Compose dan ${interfaces.length} interface. Functional decomposition berasal dari source yang dikenali; konfigurasi tidak membuktikan runtime service aktif.`,
      dataViewIntroduction: "",
      dataViewInterpretation: "",
      applicationViewIntroduction: "",
      applicationViewInterpretation: "",
    },
    limitations: [...new Set([
      ...input.semantic.limitations.map(item => item.reason),
      "Data object mengikuti bukti akses data yang dikenali; model data yang tidak diakses alur terpetakan belum tentu tampil.",
      "Owner data, distribusi deployment, business capability, dan proses bisnis memerlukan input atau konfirmasi pengguna.",
      "Matriks CRUD mencatat hanya operasi dengan label eksplisit; sel unknown tidak berarti aplikasi tidak mengakses data.",
      "Inter-service flow hanya ditampilkan bila konfigurasi Docker Compose mengarah ke nama service dan source pada build context yang cocok membaca environment variable lalu membuat HTTP request. Konfigurasi statis tidak membuktikan traffic atau availability runtime; API gateway, message queue, batch exchange, dan pola dinamis lain belum disimpulkan.",
      "Katalog interface saat ini berisi interface API yang terdeteksi dari semantic model; integrasi tak terlacak tidak diasumsikan.",
    ])],
  };
  const dataCore = projectCoreBaselineView(model, "dataStructure");
  const applicationCore = projectCoreBaselineView(model, "applicationCooperation");
  model.narratives.dataViewIntroduction = `Diagram menampilkan ${dataCore.elements.length} data object yang terhubung oleh ${dataCore.relationships.length} association inti. Katalog juga memuat ${dataCore.omittedElementCount} object yang tidak ditampilkan pada view ini.`;
  model.narratives.applicationViewIntroduction = `Overview menampilkan ${applicationCore.elements.length} komponen atau service aplikasi dengan ${applicationCore.relationships.length} relasi inti. Interface dan fungsi rinci tidak dimasukkan ke diagram ini.`;
  model.narratives.dataViewInterpretation = dataCore.relationships.length
    ? "Diagram ini menampilkan association data yang dikonfirmasi oleh source. Object yang tidak tampak tetap tercantum pada katalog; ketiadaannya pada view ini tidak membuktikan bahwa object atau hubungannya tidak ada pada sistem berjalan."
    : "Snapshot ini belum menyediakan association data yang didukung source untuk ditampilkan pada diagram; data object tetap tersedia pada katalog.";
  model.narratives.applicationViewInterpretation = applicationCore.relationships.length
    ? "Diagram ini merangkum hubungan inti antar komponen aplikasi yang ditemukan pada source. Diagram tidak membuktikan business capability, availability, atau traffic runtime."
    : "Snapshot ini belum menyediakan hubungan inti antar komponen aplikasi yang didukung source untuk ditampilkan pada diagram.";
  return model;
}
