import {
  database,
  enqueueMarkdownExport,
  findMarkdownExportForUser,
  retryMarkdownExport,
} from "@sage/database";
import type { DocumentReadDatabase } from "../documents/reader.ts";
import { readAnalysisSession } from "../analyses/session.ts";
import { loadDocumentForUser } from "../documents/reader.ts";
import { createExportHandlers } from "./handlers.ts";
import { loadExportDownloadForUser } from "./reader.ts";

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
  enqueue: input => enqueueMarkdownExport(database(), input),
  find: (ownerUserId, analysisId, exportId) => findMarkdownExportForUser(database(), { ownerUserId, analysisId, exportId }),
  retry: input => retryMarkdownExport(database(), input),
  readDownload: (ownerUserId, analysisId, exportId) => loadExportDownloadForUser(
    database(), storageRoot, ownerUserId, analysisId, exportId,
  ),
});
