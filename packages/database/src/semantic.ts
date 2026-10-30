import { createHash } from "node:crypto";
import { Prisma } from "../generated/client.ts";
import type { PrismaClient } from "../generated/client.ts";
import { EMPTY_OVERLAY, type PresentationOverlay, type SemanticModel } from "../../documents/src/semantic/model.ts";
import { isSemanticModel, validatePresentationOverlay as normalizePresentationOverlay } from "../../documents/src/semantic/validation.ts";

const SHA256 = /^[a-f0-9]{64}$/;
const MAX_MODEL_BYTES = 24 * 1024 * 1024;
const MAX_OVERLAY_BYTES = 256 * 1024;

export class SemanticModelIntegrityError extends Error {
  constructor() { super("Model semantik tidak konsisten dengan source graph yang tersimpan."); this.name = "SemanticModelIntegrityError"; }
}
export class SemanticPresentationConflictError extends Error {
  constructor() { super("Koreksi tampilan berubah. Muat ulang sebelum menyimpan lagi."); this.name = "SemanticPresentationConflictError"; }
}

function hash(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
function plain(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
/** Serialize only bounded, plain JSON produced from the verified source CKG. */
export function canonicalSemanticContent(model: SemanticModel, sourceCkgHash: string, ckgNodeIds: ReadonlySet<string>, fileHashes: ReadonlyMap<string, string>, expectedSnapshot?: unknown): { content: string; modelHash: string } {
  if (!SHA256.test(sourceCkgHash) || !isSemanticModel(model, {
    sourceCkgHash,
    snapshot: expectedSnapshot,
    ckgNodeIds,
    fileHashes,
  })) throw new SemanticModelIntegrityError();
  const content = JSON.stringify(model);
  if (Buffer.byteLength(content, "utf8") > MAX_MODEL_BYTES) throw new SemanticModelIntegrityError();
  return { content, modelHash: hash(content) };
}

function canonicalOverlay(value: unknown, model: SemanticModel): { overlay: PresentationOverlay; contentHash: string } {
  const overlay = normalizePresentationOverlay(model, value);
  const serialized = JSON.stringify(overlay);
  if (Buffer.byteLength(serialized, "utf8") > MAX_OVERLAY_BYTES) throw new Error("Koreksi tampilan terlalu besar.");
  return { overlay, contentHash: hash(serialized) };
}

export function validatePresentationOverlay(value: unknown, model: SemanticModel): PresentationOverlay {
  return canonicalOverlay(value, model).overlay;
}

export async function persistAnalysisSemantic(
  tx: Prisma.TransactionClient,
  input: { ownerUserId: string; analysisId: string; sourceCkgHash: string; ccm: { snapshot: unknown; nodes: Array<{ id: string }>; files: Array<{ path: string; sha256: string }> }; model: SemanticModel },
): Promise<{ id: string; modelHash: string }> {
  const nodeIds = new Set(input.ccm.nodes.map(node => node.id));
  const fileHashes = new Map(input.ccm.files.map(file => [file.path, file.sha256] as const));
  const { content, modelHash } = canonicalSemanticContent(input.model, input.sourceCkgHash, nodeIds, fileHashes, input.ccm.snapshot);
  const where = { analysisId_ownerUserId: { analysisId: input.analysisId, ownerUserId: input.ownerUserId } };
  const existing = await tx.semanticModel.findUnique({ where, select: { id: true, sourceCkgHash: true, modelHash: true, schemaVersion: true, extractorVersion: true, canonicalContent: true } });
  if (existing) {
    if (existing.sourceCkgHash !== input.sourceCkgHash || existing.modelHash !== modelHash || existing.canonicalContent !== content ||
        existing.schemaVersion !== input.model.schemaVersion || existing.extractorVersion !== input.model.extractorVersion) throw new SemanticModelIntegrityError();
    return { id: existing.id, modelHash };
  }
  const stored = await tx.semanticModel.create({ data: {
    ownerUserId: input.ownerUserId, analysisId: input.analysisId, sourceCkgHash: input.sourceCkgHash,
    modelHash, schemaVersion: input.model.schemaVersion, extractorVersion: input.model.extractorVersion, canonicalContent: content,
  }, select: { id: true, modelHash: true } });
  return stored;
}

type SemanticReadDb = Pick<PrismaClient, "analysis" | "presentationRevision">;

async function readStoredSemantic(db: SemanticReadDb, ownerUserId: string, analysisId: string) {
  const row = await db.analysis.findFirst({
    where: { id: analysisId, ownerUserId, deletionRequestedAt: null, status: { in: ["COMPLETED", "COMPLETED_WITH_LIMITATIONS"] }, architectureDocument: { isNot: null } },
    select: {
      graphBundle: { select: { contentHash: true, canonicalContent: true } },
      semanticModel: { select: { id: true, modelHash: true, sourceCkgHash: true, schemaVersion: true, extractorVersion: true, canonicalContent: true } },
      presentationRevisions: { orderBy: { revision: "desc" }, take: 1, select: { revision: true, overlay: true, contentHash: true } },
    },
  });
  if (!row?.semanticModel) return null;
  if (!row.graphBundle || row.semanticModel.sourceCkgHash !== row.graphBundle.contentHash ||
      !row.graphBundle.canonicalContent || hash(row.graphBundle.canonicalContent) !== row.graphBundle.contentHash) {
    throw new SemanticModelIntegrityError();
  }
  let model: SemanticModel;
  let graphCcm: { snapshot: unknown; nodes: Array<{ id: string }>; files: Array<{ path: string; sha256: string }> };
  try {
    model = JSON.parse(row.semanticModel.canonicalContent) as SemanticModel;
    const envelope: unknown = JSON.parse(row.graphBundle.canonicalContent);
    if (!plain(envelope) || envelope.schemaVersion !== "sage-ckg-v1" || !plain(envelope.ccm)) throw new Error("invalid CKG");
    const ccm = envelope.ccm;
    if (!plain(ccm.snapshot) || typeof ccm.snapshot.repository !== "string" ||
        !(ccm.snapshot.branch === null || typeof ccm.snapshot.branch === "string") || typeof ccm.snapshot.commitSha !== "string" ||
        !Array.isArray(ccm.nodes) || !Array.isArray(ccm.files)) throw new Error("invalid CKG references");
    const nodeIds = new Set<string>();
    for (const node of ccm.nodes) {
      if (!plain(node) || typeof node.id !== "string" || !node.id || nodeIds.has(node.id)) throw new Error("invalid CKG node ids");
      nodeIds.add(node.id);
    }
    const files = new Map<string, string>();
    for (const file of ccm.files) {
      if (!plain(file) || typeof file.path !== "string" || !file.path || typeof file.sha256 !== "string" ||
          !SHA256.test(file.sha256) || files.has(file.path)) throw new Error("invalid CKG files");
      files.set(file.path, file.sha256);
    }
    graphCcm = { snapshot: ccm.snapshot, nodes: [...nodeIds].map(id => ({ id })), files: [...files].map(([path, sha256]) => ({ path, sha256 })) };
  } catch { throw new SemanticModelIntegrityError(); }
  const nodeIds = new Set(graphCcm.nodes.map(node => node.id));
  const files = new Map(graphCcm.files.map(file => [file.path, file.sha256] as const));
  const validated = canonicalSemanticContent(model, row.semanticModel.sourceCkgHash, nodeIds, files, graphCcm.snapshot);
  if (validated.content !== row.semanticModel.canonicalContent || validated.modelHash !== row.semanticModel.modelHash ||
      model.schemaVersion !== row.semanticModel.schemaVersion || model.extractorVersion !== row.semanticModel.extractorVersion) throw new SemanticModelIntegrityError();
  const latest = row.presentationRevisions[0];
  const overlay = latest ? canonicalOverlay(latest.overlay, model) : { overlay: EMPTY_OVERLAY, contentHash: hash(JSON.stringify(EMPTY_OVERLAY)) };
  if (latest && latest.contentHash !== overlay.contentHash) throw new SemanticModelIntegrityError();
  return { id: row.semanticModel.id, modelHash: validated.modelHash, model, revision: latest?.revision ?? 0, overlay: overlay.overlay };
}

/** Owner-scoped read of a published semantic model and its latest immutable presentation revision. */
export async function readSemanticForUser(db: PrismaClient, ownerUserId: string, analysisId: string, revision?: number) {
  if (typeof ownerUserId !== "string" || !ownerUserId.trim() || typeof analysisId !== "string" || !analysisId.trim()) return null;
  const latest = await readStoredSemantic(db, ownerUserId, analysisId);
  if (!latest) return null;
  if (revision === undefined || revision === latest.revision) return latest;
  if (!Number.isSafeInteger(revision) || revision < 0) return null;
  if (revision === 0) return { ...latest, revision: 0, overlay: EMPTY_OVERLAY };
  const row = await db.presentationRevision.findFirst({ where: { analysisId, ownerUserId, semanticModelId: latest.id, revision }, select: { revision: true, overlay: true, contentHash: true } });
  if (!row) return null;
  const overlay = canonicalOverlay(row.overlay, latest.model);
  if (overlay.contentHash !== row.contentHash) throw new SemanticModelIntegrityError();
  return { ...latest, revision: row.revision, overlay: overlay.overlay };
}

/** Distinguish an old published analysis from an analysis that does not belong to this user. */
export async function readSemanticPublicationStateForUser(db: PrismaClient, ownerUserId: string, analysisId: string): Promise<"missing" | "legacy" | "ready"> {
  if (typeof ownerUserId !== "string" || !ownerUserId.trim() || typeof analysisId !== "string" || !analysisId.trim()) return "missing";
  const row = await db.analysis.findFirst({
    where: { id: analysisId, ownerUserId, deletionRequestedAt: null, status: { in: ["COMPLETED", "COMPLETED_WITH_LIMITATIONS"] }, architectureDocument: { isNot: null } },
    select: { semanticModel: { select: { id: true } } },
  });
  if (!row) return "missing";
  return row.semanticModel ? "ready" : "legacy";
}

export class SemanticAnalysisNotFoundError extends Error {
  constructor() { super("Semantic model is unavailable."); this.name = "SemanticAnalysisNotFoundError"; }
}

/** Append a correction only if the caller still holds the latest revision. */
export async function appendPresentationRevision(db: PrismaClient, input: { ownerUserId: string; analysisId: string; expectedRevision: number; overlay: unknown }) {
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) throw new Error("Revision is invalid.");
  try {
    return await db.$transaction(async tx => {
      const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "SemanticModel" WHERE "analysisId" = ${input.analysisId} AND "ownerUserId" = ${input.ownerUserId} FOR UPDATE`;
      if (!locked.length) throw new SemanticAnalysisNotFoundError();
      const stored = await readStoredSemantic(tx, input.ownerUserId, input.analysisId);
      if (!stored) throw new SemanticAnalysisNotFoundError();
      if (stored.revision !== input.expectedRevision) throw new SemanticPresentationConflictError();
      const { overlay, contentHash } = canonicalOverlay(input.overlay, stored.model);
      const row = await tx.presentationRevision.create({ data: {
        ownerUserId: input.ownerUserId, analysisId: input.analysisId, semanticModelId: stored.id,
        revision: stored.revision + 1, overlay: overlay as unknown as Prisma.InputJsonValue, contentHash,
      }, select: { revision: true } });
      return { ...stored, revision: row.revision, overlay };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 2000, timeout: 10_000 });
  } catch (error) {
    if (error instanceof SemanticAnalysisNotFoundError || error instanceof SemanticPresentationConflictError) throw error;
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") throw new SemanticPresentationConflictError();
    throw error;
  }
}
