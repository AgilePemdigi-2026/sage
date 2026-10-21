import { database } from "@sage/database";
import { readAnalysisSession } from "../analyses/session.ts";
import { createGraphHandlers } from "./handlers.ts";
import { loadGraphForUser } from "./reader.ts";
import type { GraphReadDatabase } from "./reader.ts";

const storageRoot = process.env.STORAGE_ROOT ?? "storage";

export const graphHandlers = createGraphHandlers({
  readSession: readAnalysisSession,
  readGraph: (ownerUserId, analysisId) => loadGraphForUser(database() as unknown as GraphReadDatabase, ownerUserId, analysisId, storageRoot),
});
