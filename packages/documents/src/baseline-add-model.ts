import { EVIDENCE_ROLES } from "@sage/contracts/registries";
import type { CcmV1, EvidenceSpan } from "@sage/contracts";
import type { DataOperation } from "./semantic/model.ts";

export const ADD_BASELINE_SCHEMA = "sage-add-baseline-v1" as const;
export const ARCHIMATE_PROFILE_VERSION = "3.2" as const;

export type ArchiMateElementType =
  | "ApplicationComponent" | "ApplicationFunction" | "ApplicationService"
  | "ApplicationInterface" | "DataObject";
export type ArchiMateRelationshipType =
  | "CompositionRelationship" | "AssignmentRelationship" | "ServingRelationship" | "RealizationRelationship" | "TriggeringRelationship"
  | "AccessRelationship" | "FlowRelationship" | "AssociationRelationship";
export type AddOrigin = "source" | "llm-proposal" | "user-confirmed";

export interface AddElement {
  id: string;
  type: ArchiMateElementType;
  name: string;
  description: string | null;
  origin: AddOrigin;
  featureGroup?: string | null;
  evidence: EvidenceSpan[];
  review: "unreviewed" | "confirmed" | "rejected";
}

export interface AddRelationship {
  id: string;
  type: ArchiMateRelationshipType;
  sourceId: string;
  targetId: string;
  label: string;
  origin: AddOrigin;
  confidence: "proven" | "indicated";
  reason: string;
  evidence: EvidenceSpan[];
  dataOperation?: DataOperation;
  review: "unreviewed" | "confirmed" | "rejected";
}

export interface AddBaselineModel {
  schemaVersion: typeof ADD_BASELINE_SCHEMA;
  archimateVersion: typeof ARCHIMATE_PROFILE_VERSION;
  generation: { extractorVersion: string; llmOutcome: "not-requested" | "used" | "unavailable" | "not-configured"; llmModel: string | null };
  snapshot: CcmV1["snapshot"];
  sourceCkgHash: string;
  elements: AddElement[];
  relationships: AddRelationship[];
  catalogs: {
    dataEntities: Array<{ elementId: string; owner: string | null; description: string | null }>;
    applicationPortfolio: Array<{ elementId: string; planned: false; description: string | null }>;
    interfaces: Array<{ elementId: string; protocol: string | null; contract: string | null }>;
  };
  matrices: {
    applicationData: Array<{ applicationId: string; dataId: string; create: "yes" | "no" | "unknown"; read: "yes" | "no" | "unknown"; update: "yes" | "no" | "unknown"; delete: "yes" | "no" | "unknown"; evidence: EvidenceSpan[] }>;
    applicationInteractions: Array<{ sourceApplicationId: string; targetApplicationId: string; mechanism: string; evidence: EvidenceSpan[] }>;
  };
  views: {
    dataStructure: { elementIds: string[]; relationshipIds: string[] };
    applicationCooperation: { elementIds: string[]; relationshipIds: string[] };
  };
  narratives: {
    dataBaseline: string;
    applicationBaseline: string;
    /** Optional for compatibility with ADD snapshots created before diagram narratives were added. */
    dataViewIntroduction?: string;
    dataViewInterpretation?: string;
    applicationViewIntroduction?: string;
    applicationViewInterpretation?: string;
  };
  limitations: string[];
}

const ELEMENT_TYPES = new Set<ArchiMateElementType>(["ApplicationComponent", "ApplicationFunction", "ApplicationService", "ApplicationInterface", "DataObject"]);
const RELATIONSHIP_TYPES = new Set<ArchiMateRelationshipType>(["CompositionRelationship", "AssignmentRelationship", "ServingRelationship", "RealizationRelationship", "TriggeringRelationship", "AccessRelationship", "FlowRelationship", "AssociationRelationship"]);
const ADD_ORIGINS = new Set<AddOrigin>(["source", "llm-proposal", "user-confirmed"]);
const CONFIDENCE = new Set(["proven", "indicated"]);
const REVIEW = new Set(["unreviewed", "confirmed", "rejected"]);
const DATA_OPERATIONS = new Set<DataOperation>(["create", "read", "update", "delete", "upsert", "persist"]);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isText = (value: unknown, max = 100_000): value is string => typeof value === "string" && value.length <= max;

function isEvidence(value: unknown): value is EvidenceSpan {
  if (!isRecord(value)) return false;
  return typeof value.filePath === "string" && value.filePath.length > 0 && value.filePath.length <= 4096 &&
    typeof value.fileSha256 === "string" && /^[a-f0-9]{64}$/u.test(value.fileSha256) &&
    Number.isSafeInteger(value.startByte) && Number.isSafeInteger(value.endByte) && Number(value.startByte) >= 0 && Number(value.endByte) > Number(value.startByte) &&
    Number.isSafeInteger(value.startLine) && Number.isSafeInteger(value.endLine) && Number(value.startLine) > 0 && Number(value.endLine) >= Number(value.startLine) &&
    Number.isSafeInteger(value.startColumn) && Number.isSafeInteger(value.endColumn) && Number(value.startColumn) > 0 && Number(value.endColumn) > 0 &&
    EVIDENCE_ROLES.includes(value.role as EvidenceSpan["role"]);
}

export function archimatePairAllowed(type: ArchiMateRelationshipType, source: ArchiMateElementType, target: ArchiMateElementType): boolean {
  switch (type) {
    case "CompositionRelationship": return source === "ApplicationComponent" && ["ApplicationComponent", "ApplicationInterface"].includes(target);
    case "AssignmentRelationship": return ["ApplicationComponent", "ApplicationInterface"].includes(source) && ["ApplicationFunction", "ApplicationService"].includes(target);
    case "ServingRelationship": return source === "ApplicationService" && ["ApplicationComponent", "ApplicationFunction", "ApplicationInterface", "ApplicationService"].includes(target);
    case "RealizationRelationship": return ["ApplicationComponent", "ApplicationFunction"].includes(source) && target === "ApplicationService";
    case "TriggeringRelationship": return ["ApplicationInterface", "ApplicationFunction", "ApplicationService"].includes(source) && ["ApplicationFunction", "ApplicationService"].includes(target);
    case "AccessRelationship": return ["ApplicationFunction", "ApplicationService"].includes(source) && target === "DataObject";
    case "FlowRelationship": return ["ApplicationComponent", "ApplicationService", "ApplicationInterface"].includes(source) && ["ApplicationComponent", "ApplicationService", "ApplicationInterface"].includes(target);
    case "AssociationRelationship": return true;
  }
}

/** Validate the supported ADD/ArchiMate profile subset before persistence, UI use, or export. */
export function isAddBaselineModel(value: unknown): value is AddBaselineModel {
  if (!isRecord(value) || value.schemaVersion !== ADD_BASELINE_SCHEMA || value.archimateVersion !== ARCHIMATE_PROFILE_VERSION ||
      !isRecord(value.snapshot) || !isText(value.snapshot.repository, 300) || !value.snapshot.repository ||
      !(value.snapshot.branch === null || isText(value.snapshot.branch, 300)) || typeof value.snapshot.commitSha !== "string" || !/^[a-f0-9]{40}$/u.test(value.snapshot.commitSha) ||
      typeof value.sourceCkgHash !== "string" || !/^[a-f0-9]{64}$/u.test(value.sourceCkgHash) || !isRecord(value.generation) ||
      !isText(value.generation.extractorVersion, 80) || !["not-requested", "used", "unavailable", "not-configured"].includes(String(value.generation.llmOutcome)) ||
      !(value.generation.llmModel === null || isText(value.generation.llmModel, 180)) ||
      !Array.isArray(value.elements) || !Array.isArray(value.relationships) || !isRecord(value.catalogs) || !isRecord(value.matrices) ||
      !isRecord(value.views) || !isRecord(value.narratives) || !Array.isArray(value.limitations) || !isText(value.narratives.dataBaseline) ||
      !isText(value.narratives.applicationBaseline) ||
      ![value.narratives.dataViewIntroduction, value.narratives.dataViewInterpretation,
        value.narratives.applicationViewIntroduction, value.narratives.applicationViewInterpretation]
        .every(item => item === undefined || isText(item, 1400)) ||
      !value.limitations.every(item => isText(item))) return false;

  const elements = new Map<string, AddElement>();
  for (const item of value.elements) {
    if (!isRecord(item) || typeof item.id !== "string" || !item.id || item.id.length > 180 || elements.has(item.id) ||
        !ELEMENT_TYPES.has(item.type as ArchiMateElementType) || !isText(item.name, 1000) || !item.name.trim() ||
        !(item.description === null || isText(item.description)) || !ADD_ORIGINS.has(item.origin as AddOrigin) ||
        !(item.featureGroup === undefined || item.featureGroup === null || isText(item.featureGroup, 300)) ||
        !Array.isArray(item.evidence) || !item.evidence.every(isEvidence) || !REVIEW.has(item.review as string)) return false;
    elements.set(item.id, item as unknown as AddElement);
  }
  const relationships = new Map<string, AddRelationship>();
  for (const item of value.relationships) {
    if (!isRecord(item) || typeof item.id !== "string" || !item.id || item.id.length > 180 || relationships.has(item.id) ||
        !RELATIONSHIP_TYPES.has(item.type as ArchiMateRelationshipType) || typeof item.sourceId !== "string" || typeof item.targetId !== "string" ||
        item.sourceId === item.targetId || !isText(item.label, 1000) || !ADD_ORIGINS.has(item.origin as AddOrigin) || !CONFIDENCE.has(item.confidence as string) ||
        !isText(item.reason) || !Array.isArray(item.evidence) || !item.evidence.every(isEvidence) ||
        !(item.dataOperation === undefined || DATA_OPERATIONS.has(item.dataOperation as DataOperation)) ||
        (item.dataOperation !== undefined && item.type !== "AccessRelationship") || !REVIEW.has(item.review as string)) return false;
    const source = elements.get(item.sourceId); const target = elements.get(item.targetId);
    if (!source || !target || !archimatePairAllowed(item.type as ArchiMateRelationshipType, source.type, target.type)) return false;
    relationships.set(item.id, item as unknown as AddRelationship);
  }

  if (!Array.isArray(value.catalogs.dataEntities) || !value.catalogs.dataEntities.every(item => isRecord(item) && elements.get(String(item.elementId))?.type === "DataObject" &&
      (item.owner === null || isText(item.owner, 300)) && (item.description === null || isText(item.description))) ||
      !Array.isArray(value.catalogs.applicationPortfolio) || !value.catalogs.applicationPortfolio.every(item => isRecord(item) && elements.get(String(item.elementId))?.type === "ApplicationComponent" && item.planned === false &&
      (item.description === null || isText(item.description))) ||
      !Array.isArray(value.catalogs.interfaces) || !value.catalogs.interfaces.every(item => isRecord(item) && elements.get(String(item.elementId))?.type === "ApplicationInterface" &&
      (item.protocol === null || isText(item.protocol, 64)) && (item.contract === null || isText(item.contract)))) return false;
  if (!Array.isArray(value.matrices.applicationData) || !value.matrices.applicationData.every(item => isRecord(item) && elements.get(String(item.applicationId))?.type === "ApplicationComponent" && elements.get(String(item.dataId))?.type === "DataObject" &&
      [item.create, item.read, item.update, item.delete].every(cell => ["yes", "no", "unknown"].includes(String(cell))) && Array.isArray(item.evidence) && item.evidence.every(isEvidence)) ||
      !Array.isArray(value.matrices.applicationInteractions) || !value.matrices.applicationInteractions.every(item => isRecord(item) && elements.get(String(item.sourceApplicationId))?.type === "ApplicationComponent" && elements.get(String(item.targetApplicationId))?.type === "ApplicationComponent" && isText(item.mechanism, 1000) && Array.isArray(item.evidence) && item.evidence.every(isEvidence))) return false;
  for (const [key, type] of [["dataStructure", "DataObject"], ["applicationCooperation", null]] as const) {
    const view = value.views[key];
    if (!isRecord(view) || !Array.isArray(view.elementIds) || !Array.isArray(view.relationshipIds)) return false;
    const elementIds = view.elementIds as unknown[];
    const relationshipIds = view.relationshipIds as unknown[];
    if (!elementIds.every(id => typeof id === "string" && (type ? elements.get(id)?.type === type : elements.has(id))) ||
        !relationshipIds.every(id => typeof id === "string" && relationships.has(id) && elementIds.includes(relationships.get(id)!.sourceId) && elementIds.includes(relationships.get(id)!.targetId))) return false;
  }
  return true;
}
