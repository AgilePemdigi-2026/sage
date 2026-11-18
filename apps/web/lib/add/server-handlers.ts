import { createHash } from "node:crypto";
import { database, readAddBaseline, readSemanticForUser, saveAddBaseline, saveAddRevision } from "@sage/database";
import { readAnalysisSession } from "../analyses/session.ts";
import { createAddHandlers } from "./handlers.ts";
import type { CcmV1 } from "@sage/contracts";
import type { SemanticModel } from "../../../../packages/documents/src/semantic/model.ts";

const digest = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const db = database();

export const addHandlers = createAddHandlers({
  env: process.env,
  readSession: readAnalysisSession,
  readInputs: async (ownerUserId, analysisId) => {
    const row = await db.analysis.findFirst({
      where: { id: analysisId, ownerUserId, deletionRequestedAt: null, status: { in: ["COMPLETED", "COMPLETED_WITH_LIMITATIONS"] } },
      select: { graphBundle: { select: { canonicalContent: true, contentHash: true } } },
    });
    const bundle = row?.graphBundle;
    if (!bundle?.canonicalContent || digest(bundle.canonicalContent) !== bundle.contentHash) return null;
    const semantic = await readSemanticForUser(db, ownerUserId, analysisId);
    if (!semantic || semantic.model.sourceCkgHash !== bundle.contentHash) return null;
    const parsed: unknown = JSON.parse(bundle.canonicalContent);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !("ccm" in parsed) || !("schemaVersion" in parsed) || parsed.schemaVersion !== "sage-ckg-v1") return null;
    const ccm = (parsed as { ccm?: unknown }).ccm;
    if (!ccm || typeof ccm !== "object" || Array.isArray(ccm) || !("snapshot" in ccm) || !Array.isArray((ccm as { nodes?: unknown }).nodes) || !Array.isArray((ccm as { files?: unknown }).files)) return null;
    return { ckg: ccm as CcmV1, ckgHash: bundle.contentHash, semantic: semantic.model as SemanticModel };
  },
  readBaseline: (ownerUserId, analysisId) => readAddBaseline(db, ownerUserId, analysisId),
  saveBaseline: input => saveAddBaseline(db, input),
  saveRevision: input => saveAddRevision(db, input),
});
