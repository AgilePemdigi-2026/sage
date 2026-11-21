import { createHash, randomUUID } from "node:crypto";
import type { PrismaClient } from "../generated/client.ts";
import { isAddBaselineModel, type AddBaselineModel } from "../../documents/src/baseline-add.ts";
import { emptyAddReviewOverlay, parseAddReviewOverlay } from "../../documents/src/add-overlay.ts";

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const canonicalJson = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => {
  if (item && typeof item === "object" && !Array.isArray(item)) return Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)));
  return item;
});
export class AddBaselineConflictError extends Error { constructor() { super("ADD baseline changed while it was being generated."); this.name = "AddBaselineConflictError"; } }

function parseStoredBaseline(row: { sourceCkgHash: string; schemaVersion: string; modelHash: string; canonicalContent: string }): AddBaselineModel {
  if (sha256(row.canonicalContent) !== row.modelHash) throw new Error("Stored ADD baseline integrity check failed.");
  const parsed: unknown = JSON.parse(row.canonicalContent);
  if (!isAddBaselineModel(parsed) || parsed.schemaVersion !== row.schemaVersion || parsed.sourceCkgHash !== row.sourceCkgHash) {
    throw new Error("Stored ADD baseline snapshot check failed.");
  }
  return parsed;
}

export async function readAddBaseline(db: PrismaClient, ownerUserId: string, analysisId: string) {
  const rows = await db.$queryRaw<Array<{ id: string; sourceCkgHash: string; modelHash: string; schemaVersion: string; canonicalContent: string }>>`
    SELECT add."id", add."sourceCkgHash", add."modelHash", add."schemaVersion", add."canonicalContent"
    FROM "AddBaseline" add JOIN "Analysis" analysis ON analysis."id" = add."analysisId" AND analysis."ownerUserId" = add."ownerUserId"
    WHERE add."analysisId" = ${analysisId} AND add."ownerUserId" = ${ownerUserId} AND analysis."deletionRequestedAt" IS NULL
      AND analysis."status" IN ('COMPLETED', 'COMPLETED_WITH_LIMITATIONS')
  `;
  const row = rows[0];
  if (!row) return null;
  const model = parseStoredBaseline(row);
  const revisions = await db.$queryRaw<Array<{ revision: number; overlay: unknown; contentHash: string }>>`
    SELECT "revision", "overlay", "contentHash" FROM "AddRevision"
    WHERE "analysisId" = ${analysisId} AND "ownerUserId" = ${ownerUserId} AND "addBaselineId" = ${row.id}
    ORDER BY "revision" DESC LIMIT 1
  `;
  const saved = revisions[0];
  if (!saved) return { id: row.id, sourceCkgHash: row.sourceCkgHash, modelHash: row.modelHash, model, revision: 0, overlay: emptyAddReviewOverlay() };
  if (!Number.isSafeInteger(saved.revision) || saved.revision < 1) throw new Error("Stored ADD review integrity check failed.");
  const serialized = canonicalJson(saved.overlay);
  if (sha256(serialized) !== saved.contentHash) throw new Error("Stored ADD review integrity check failed.");
  const overlay = parseAddReviewOverlay(model, saved.overlay, saved.revision);
  return { id: row.id, sourceCkgHash: row.sourceCkgHash, modelHash: row.modelHash, model, revision: saved.revision, overlay };
}

export async function saveAddBaseline(db: PrismaClient, input: { ownerUserId: string; analysisId: string; model: AddBaselineModel }) {
  if (!isAddBaselineModel(input.model)) throw new Error("ADD baseline model validation failed.");
  const canonicalContent = JSON.stringify(input.model);
  if (Buffer.byteLength(canonicalContent, "utf8") > 12 * 1024 * 1024) throw new Error("ADD baseline exceeds its storage limit.");
  const modelHash = sha256(canonicalContent);
  return db.$transaction(async tx => {
    const active = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "Analysis" WHERE "id" = ${input.analysisId} AND "ownerUserId" = ${input.ownerUserId}
        AND "status" IN ('COMPLETED', 'COMPLETED_WITH_LIMITATIONS') AND "deletionRequestedAt" IS NULL FOR UPDATE
    `;
    if (!active[0]) throw new AddBaselineConflictError();
    const prior = await tx.$queryRaw<Array<{ id: string; modelHash: string; sourceCkgHash: string; schemaVersion: string; canonicalContent: string }>>`
      SELECT "id", "modelHash", "sourceCkgHash", "schemaVersion", "canonicalContent" FROM "AddBaseline"
      WHERE "analysisId" = ${input.analysisId} AND "ownerUserId" = ${input.ownerUserId} FOR UPDATE
    `;
    if (prior[0]) {
      if (prior[0].sourceCkgHash !== input.model.sourceCkgHash) throw new AddBaselineConflictError();
      const model = parseStoredBaseline(prior[0]);
      return { id: prior[0].id, modelHash: prior[0].modelHash, model, created: false };
    }
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      INSERT INTO "AddBaseline" ("id", "ownerUserId", "analysisId", "sourceCkgHash", "modelHash", "schemaVersion", "canonicalContent", "createdAt", "updatedAt")
      SELECT ${`add_${randomUUID().replaceAll("-", "")}`}, analysis."ownerUserId", analysis."id", ${input.model.sourceCkgHash}, ${modelHash}, ${input.model.schemaVersion}, ${canonicalContent}, NOW(), NOW()
      FROM "Analysis" analysis WHERE analysis."id" = ${input.analysisId} AND analysis."ownerUserId" = ${input.ownerUserId}
        AND analysis."status" IN ('COMPLETED', 'COMPLETED_WITH_LIMITATIONS') AND analysis."deletionRequestedAt" IS NULL
      ON CONFLICT ("analysisId", "ownerUserId") DO NOTHING RETURNING "id"
    `;
    if (!rows[0]) throw new AddBaselineConflictError();
    return { id: rows[0].id, modelHash, model: input.model, created: true };
  });
}

export async function saveAddRevision(db: PrismaClient, input: {
  ownerUserId: string;
  analysisId: string;
  expectedRevision: number;
  overlay: unknown;
}) {
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) throw new Error("ADD_REVIEW_INVALID");
  return db.$transaction(async tx => {
    const active = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "Analysis" WHERE "id" = ${input.analysisId} AND "ownerUserId" = ${input.ownerUserId}
        AND "status" IN ('COMPLETED', 'COMPLETED_WITH_LIMITATIONS') AND "deletionRequestedAt" IS NULL FOR UPDATE
    `;
    if (!active[0]) throw new AddBaselineConflictError();
    const baselines = await tx.$queryRaw<Array<{ id: string; sourceCkgHash: string; schemaVersion: string; canonicalContent: string; modelHash: string }>>`
      SELECT "id", "sourceCkgHash", "schemaVersion", "canonicalContent", "modelHash" FROM "AddBaseline"
      WHERE "analysisId" = ${input.analysisId} AND "ownerUserId" = ${input.ownerUserId} FOR UPDATE
    `;
    const baseline = baselines[0];
    if (!baseline) throw new AddBaselineConflictError();
    const model = parseStoredBaseline(baseline);
    const currentRows = await tx.$queryRaw<Array<{ revision: number; overlay: unknown; contentHash: string }>>`
      SELECT "revision", "overlay", "contentHash" FROM "AddRevision" WHERE "analysisId" = ${input.analysisId} AND "ownerUserId" = ${input.ownerUserId}
      ORDER BY "revision" DESC LIMIT 1
    `;
    const currentRevision = currentRows[0]?.revision ?? 0;
    if (currentRows[0]) {
      if (!Number.isSafeInteger(currentRevision) || currentRevision < 1 || sha256(canonicalJson(currentRows[0].overlay)) !== currentRows[0].contentHash) {
        throw new Error("Stored ADD review integrity check failed.");
      }
      parseAddReviewOverlay(model, currentRows[0].overlay, currentRevision);
    }
    if (currentRevision !== input.expectedRevision) throw new AddBaselineConflictError();
    const overlay = parseAddReviewOverlay(model, input.overlay, currentRevision + 1);
    const canonical = canonicalJson(overlay);
    const contentHash = sha256(canonical);
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      INSERT INTO "AddRevision" ("id", "ownerUserId", "analysisId", "addBaselineId", "revision", "overlay", "contentHash", "createdAt")
      VALUES (${`addrev_${randomUUID().replaceAll("-", "")}`}, ${input.ownerUserId}, ${input.analysisId}, ${baseline.id}, ${overlay.revision}, ${canonical}::jsonb, ${contentHash}, NOW())
      RETURNING "id"
    `;
    if (!rows[0]) throw new AddBaselineConflictError();
    return { id: rows[0].id, revision: overlay.revision, overlay, contentHash };
  });
}
