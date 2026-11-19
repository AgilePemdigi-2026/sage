import { createHash } from "node:crypto";
import type { CcmV1, EvidenceSpan } from "@sage/contracts";
import { ADD_BASELINE_SCHEMA, ARCHIMATE_PROFILE_VERSION, archimatePairAllowed } from "./baseline-add-model.ts";
import type { AddElement, AddBaselineModel, AddRelationship, ArchiMateRelationshipType } from "./baseline-add-model.ts";
import type { SemanticModel } from "./semantic/model.ts";

export { ADD_BASELINE_SCHEMA, ARCHIMATE_PROFILE_VERSION, isAddBaselineModel } from "./baseline-add-model.ts";
export type { AddElement, AddBaselineModel, AddOrigin, AddRelationship, ArchiMateElementType, ArchiMateRelationshipType } from "./baseline-add-model.ts";

const id = (prefix: string, key: string) => `${prefix}:${createHash("sha256").update(key).digest("hex").slice(0, 20)}`;
const uniqueEvidence = (spans: EvidenceSpan[]) => [...new Map(spans.map(span => [`${span.filePath}:${span.startLine}:${span.endLine}:${span.role}`, span])).values()];
function routeMethod(label: string): string | null {
  const match = label.trim().match(/^((?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE)(?:\/(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE))*)\s+(\/\S*)$/iu);
  return match?.[1]?.toUpperCase() ?? null;
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
    description: "Aplikasi dalam cakupan repository yang dianalisis.", origin: "source", featureGroup: null, evidence: [], review: "unreviewed" });
  input.semantic.features.forEach(feature => {
    const serviceId = id("service", feature.id);
    addElement({ id: serviceId, type: "ApplicationService", name: feature.label, description: null, origin: "source", featureGroup: feature.label, evidence: uniqueEvidence(feature.evidence), review: "unreviewed" });
  });
  const semanticToArchimate = new Map<string, string>();
  for (const node of input.semantic.nodes) {
    if (node.kind === "store") {
      const dataId = id("data", node.id); semanticToArchimate.set(node.id, dataId);
      const relatedFeatures = new Set(input.semantic.edges.filter(edge => edge.target === node.id)
        .map(edge => semanticNodes.get(edge.source)?.featureId).filter((featureId): featureId is string => Boolean(featureId)));
      const featureId = relatedFeatures.size === 1 ? [...relatedFeatures][0] : node.featureId;
      addElement({ id: dataId, type: "DataObject", name: node.label, description: node.reason, origin: "source", featureGroup: featureId ? semanticFeatures.get(featureId)?.label ?? null : null, evidence: uniqueEvidence(node.evidence), review: "unreviewed" });
      continue;
    }
    if (node.kind === "component") {
      const method = routeMethod(node.label);
      const componentId = id(method ? "interface" : "function", node.id); semanticToArchimate.set(node.id, componentId);
      addElement({ id: componentId, type: method ? "ApplicationInterface" : "ApplicationFunction", name: node.label,
        description: node.reason, origin: "source",
        featureGroup: node.featureId ? semanticFeatures.get(node.featureId)?.label ?? null : null,
        evidence: uniqueEvidence(node.evidence), review: "unreviewed" });
      if (method) addRelationship({ id: id("composition", `${appId}:${componentId}`), type: "CompositionRelationship", sourceId: appId, targetId: componentId,
        label: "has interface", origin: "source", confidence: "indicated", reason: "The interface contract is declared in the analyzed repository scope; runtime exposure is not inferred.", evidence: uniqueEvidence(node.evidence), review: "unreviewed" });
      else {
        addRelationship({ id: id("assignment", `${appId}:${componentId}`), type: "AssignmentRelationship", sourceId: appId, targetId: componentId,
          label: "assigned internal behavior", origin: "source", confidence: "indicated", reason: "A source-level handler or module is represented as internal application behavior under the repository-scope component; separate deployment is not inferred.", evidence: uniqueEvidence(node.evidence), review: "unreviewed" });
        if (node.featureId) {
          const serviceId = id("service", node.featureId);
          addRelationship({ id: id("realization", `${componentId}:${serviceId}`), type: "RealizationRelationship", sourceId: componentId, targetId: serviceId,
            label: "realizes feature service", origin: "source", confidence: "indicated", reason: "The semantic extractor groups this internal source behavior with the feature entry point; the ArchiMate realization is indicated and should be reviewed.", evidence: uniqueEvidence([...node.evidence, ...(semanticFeatures.get(node.featureId)?.evidence ?? [])]), review: "unreviewed" });
        }
      }
      continue;
    }
    if (node.kind === "feature") semanticToArchimate.set(node.id, id("service", node.featureId ?? node.id));
    if (node.kind === "step") {
      const method = routeMethod(node.label);
      if (!method) continue;
      const interfaceId = id("interface", node.id); semanticToArchimate.set(node.id, interfaceId);
      addElement({ id: interfaceId, type: "ApplicationInterface", name: node.label, description: node.reason, origin: "source",
        featureGroup: node.featureId ? semanticFeatures.get(node.featureId)?.label ?? null : null,
        evidence: uniqueEvidence(node.evidence), review: "unreviewed" });
      addRelationship({ id: id("composition", `${appId}:${interfaceId}`), type: "CompositionRelationship", sourceId: appId, targetId: interfaceId,
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
      confidence, reason, evidence: uniqueEvidence(edge.evidence), review: "unreviewed" });
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
  const accessByData = new Map<string, AddRelationship[]>();
  for (const edge of relationships.values()) if (edge.type === "AccessRelationship") {
    const bucket = accessByData.get(edge.targetId) ?? [];
    bucket.push(edge);
    accessByData.set(edge.targetId, bucket);
  }
  const crud = (app: AddElement, data: AddElement) => {
    const relations = accessByData.get(data.id) ?? [];
    const patterns = {
      create: /\b(?:create|creates|created|insert|inserts|inserted|register|registers|registered)\b/iu,
      read: /\b(?:read|reads|retrieve|retrieves|retrieved|select|selects|find|finds|fetch|fetches)\b/iu,
      update: /\b(?:update|updates|updated|modify|modifies|modified)\b/iu,
      delete: /\b(?:delete|deletes|deleted|remove|removes|removed)\b/iu,
    };
    const operation = (kind: keyof typeof patterns): "yes" | "unknown" => relations.some(edge => patterns[kind].test(edge.label)) ? "yes" : "unknown";
    return { applicationId: app.id, dataId: data.id, create: operation("create"), read: operation("read"),
      update: operation("update"), delete: operation("delete"), evidence: uniqueEvidence(relations.flatMap(edge => edge.evidence)) };
  };
  const links = [...relationships.values()];
  // Access paths belong in the CRUD matrix. The ArchiMate Data Structure view
  // shows only data objects and explicit data-to-data associations.
  const dataViewEdges = links.filter(edge => edge.type === "AssociationRelationship" &&
    elements.get(edge.sourceId)?.type === "DataObject" && elements.get(edge.targetId)?.type === "DataObject");
  const applicationViewEdges = links.filter(edge => applicationViewElementIds.has(edge.sourceId) && applicationViewElementIds.has(edge.targetId));
  return {
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
      applicationData: appElements.flatMap(app => dataElements.filter(data => accessByData.has(data.id)).map(data => crud(app, data))),
      // Calls between source-level components do not prove communication
      // between independently deployed applications or an integration protocol.
      applicationInteractions: [],
    },
    views: {
      dataStructure: { elementIds: [...new Set([...dataElements.map(element => element.id), ...dataViewEdges.flatMap(edge => [edge.sourceId, edge.targetId])])], relationshipIds: dataViewEdges.map(edge => edge.id) },
      applicationCooperation: { elementIds: [...new Set([...applicationViewElements.map(element => element.id), ...applicationViewEdges.flatMap(edge => [edge.sourceId, edge.targetId])])], relationshipIds: applicationViewEdges.map(edge => edge.id) },
    },
    narratives: {
      dataBaseline: `${dataElements.length} data object teridentifikasi dari operasi store yang dianalisis. Owner dan distribusi aktual memerlukan konfirmasi.`,
      applicationBaseline: `${appElements.length} application component repository dan ${interfaces.length} interface teridentifikasi. Functional decomposition berasal dari fitur source yang dikenali.`,
      dataViewIntroduction: `Diagram berikut menampilkan ${dataElements.length} data object dan ${dataViewEdges.length} hubungan antar data object yang dinyatakan pada source snapshot. Katalog dan evidence menyediakan rincian setiap object serta relasi yang terdeteksi.`,
      dataViewInterpretation: dataElements.length
        ? `Gambar ini memperlihatkan data object yang dikenali beserta association yang memiliki bukti source. Node tanpa garis menunjukkan bahwa tidak ada association antar data object yang terkonfirmasi untuk node tersebut pada snapshot ini; kondisi itu tidak membuktikan bahwa hubungan tidak ada di sistem yang berjalan.`
        : "Snapshot ini belum menyediakan data object source-supported untuk ditampilkan pada diagram.",
      applicationViewIntroduction: `Diagram berikut memetakan ${applicationViewElements.length} elemen aplikasi dan ${applicationViewEdges.length} hubungan source-level yang dikenali secara statis. Elemen dikelompokkan menurut tipe ArchiMate; rincian hubungan dan evidence tersedia pada register.`,
      applicationViewInterpretation: applicationViewElements.length
        ? `Gambar ini merangkum hubungan source-level di dalam repository yang dianalisis. Garis solid menunjukkan hubungan proven, sedangkan garis putus-putus menunjukkan pemetaan indicated yang perlu ditinjau. Diagram ini tidak menetapkan batas deployment, business capability, atau perilaku runtime.`
        : "Snapshot ini belum menyediakan elemen aplikasi source-supported untuk ditampilkan pada diagram.",
    },
    limitations: [...new Set([
      ...input.semantic.limitations.map(item => item.reason),
      "Data object mengikuti bukti akses data yang dikenali; model data yang tidak diakses alur terpetakan belum tentu tampil.",
      "Owner data, distribusi deployment, business capability, dan proses bisnis memerlukan input atau konfirmasi pengguna.",
      "Matriks CRUD mencatat hanya operasi dengan label eksplisit; sel unknown tidak berarti aplikasi tidak mengakses data.",
      "Komunikasi antaraplikasi, API gateway, message queue, batch exchange, dan deployment runtime tidak disimpulkan dari pemanggilan komponen di dalam satu repository.",
      "Katalog interface saat ini berisi interface API yang terdeteksi dari semantic model; integrasi tak terlacak tidak diasumsikan.",
    ])],
  };
}
