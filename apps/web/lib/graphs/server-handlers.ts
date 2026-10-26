import { database } from "@sage/database";
import { readAnalysisSession } from "../analyses/session.ts";
import { createGraphHandlers } from "./handlers.ts";
import { createInspectorHandlers } from "./inspector-handlers.ts";
import { loadGraphForUser, loadNodeInspectorForUser, loadSourceForUser } from "./reader.ts";
import type { GraphReadDatabase } from "./reader.ts";

const storageRoot = process.env.STORAGE_ROOT ?? "storage";

export const graphHandlers = createGraphHandlers({
  readSession: readAnalysisSession,
  readGraph: (ownerUserId, analysisId) => loadGraphForUser(database() as unknown as GraphReadDatabase, ownerUserId, analysisId, storageRoot),
});

export const inspectorHandlers = createInspectorHandlers({
  readSession: readAnalysisSession,
  readNode: (ownerUserId, analysisId, nodeId) => loadNodeInspectorForUser(
    database() as unknown as GraphReadDatabase,
    ownerUserId,
    analysisId,
    nodeId,
    storageRoot,
  ),
  readSource: (ownerUserId, analysisId, fileId, startLine, endLine) => loadSourceForUser(
    database() as unknown as GraphReadDatabase,
    ownerUserId,
    analysisId,
    fileId,
    startLine,
    endLine,
    storageRoot,
  ),
});
