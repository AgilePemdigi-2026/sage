import {
  database,
  readSemanticForUser,
  enqueueExport,
  findExportSnapshotForUser,
  retryExport,
} from "@sage/database";
import type { DocumentReadDatabase } from "../documents/reader.ts";
import { readAnalysisSession } from "../analyses/session.ts";
import { loadDocumentForUser } from "../documents/reader.ts";
import { createExportHandlers } from "./handlers.ts";
import { loadAnyExportDownloadForUser } from "./reader.ts";

const storageRoot = process.env.STORAGE_ROOT ?? "storage";

export const exportHandlers = createExportHandlers({
  env: process.env,
  readSession: readAnalysisSession,
  readDocument: (ownerUserId, analysisId) => loadDocumentForUser(
    database() as unknown as DocumentReadDatabase,
    ownerUserId,
    analysisId,
    storageRoot,
  ),
  readSemantic: (ownerUserId, analysisId) => readSemanticForUser(database(), ownerUserId, analysisId),
  enqueue: input => enqueueExport(database(), input),
  find: (ownerUserId, analysisId, exportId) => findExportSnapshotForUser(database(), { ownerUserId, analysisId, exportId }),
  retry: input => retryExport(database(), input),
  readDownload: (ownerUserId, analysisId, exportId) => loadAnyExportDownloadForUser(
    database(), storageRoot, ownerUserId, analysisId, exportId,
  ),
});
