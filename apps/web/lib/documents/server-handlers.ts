import { database } from "@sage/database";
import { readAnalysisSession } from "../analyses/session.ts";
import { createDocumentHandlers } from "./handlers.ts";
import { loadDocumentForUser } from "./reader.ts";
import type { DocumentReadDatabase } from "./reader.ts";

const storageRoot = process.env.STORAGE_ROOT ?? "storage";

export const documentHandlers = createDocumentHandlers({
  readSession: readAnalysisSession,
  readDocument: (ownerUserId, analysisId) => loadDocumentForUser(
    database() as unknown as DocumentReadDatabase,
    ownerUserId,
    analysisId,
    storageRoot,
  ),
});
