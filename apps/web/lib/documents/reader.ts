import { readCanonicalDocumentForUser } from "@sage/database";
import { parseSnapshotArchive } from "../../../worker/src/snapshot/archive.ts";
import { readSnapshotArchive } from "../../../worker/src/snapshot/storage.ts";
import type { DocumentReadState } from "./types.ts";

const PUBLISHED_ANALYSIS_STATUSES = ["COMPLETED", "COMPLETED_WITH_LIMITATIONS"] as const;

export interface DocumentReadDatabase {
  analysis: {
    findFirst(args: { where: { id: string; ownerUserId: string }; select: { status: true } }): Promise<{ status: string } | null>;
  };
  storageObject: {
    findFirst(args: {
      where: { ownerUserId: string; analysisId: string; type: "SOURCE_ARCHIVE"; status: "ACTIVE" };
      orderBy: [{ createdAt: "desc" }, { id: "desc" }];
      select: { id: true };
    }): Promise<{ id: string } | null>;
  };
}

/**
 * Read one user's canonical document by replaying it against the latest active
 * source archive. The owner-bound status lookup always happens before storage.
 */
export async function loadDocumentForUser(
  db: DocumentReadDatabase,
  ownerUserId: string,
  analysisId: string,
  storageRoot: string,
): Promise<DocumentReadState> {
  const analysis = await db.analysis.findFirst({
    where: { id: analysisId, ownerUserId },
    select: { status: true },
  });
  if (!analysis) return { kind: "not-found" };
  if (!(PUBLISHED_ANALYSIS_STATUSES as readonly string[]).includes(analysis.status)) return { kind: "not-ready" };

  const snapshot = await db.storageObject.findFirst({
    where: { ownerUserId, analysisId, type: "SOURCE_ARCHIVE", status: "ACTIVE" },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { id: true },
  });
  if (!snapshot) throw new Error("Published document source archive is unavailable.");

  const storageDb = db as unknown as Parameters<typeof readSnapshotArchive>[0];
  const archive = await readSnapshotArchive(storageDb, {
    storageRoot,
    ownerUserId,
    analysisId,
    storageObjectId: snapshot.id,
  });
  const parsed = await parseSnapshotArchive(archive);
  const sourceBytes = Object.fromEntries(parsed.files.map(file => [file.relativePath, file.bytes]));
  const canonicalDb = db as unknown as Parameters<typeof readCanonicalDocumentForUser>[0];
  const canonical = await readCanonicalDocumentForUser(canonicalDb, ownerUserId, analysisId, sourceBytes);
  if (!canonical) throw new Error("Published architecture document is unavailable.");

  return {
    kind: "ready",
    value: {
      analysisId,
      contentHash: canonical.contentHash,
      document: canonical.document,
    },
  };
}
