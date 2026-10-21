import { database, getAnalysisDetailForUser, listAnalysesForUser } from "@sage/database";
import { readAnalysisSession } from "./session.ts";
import { createHistoryHandlers } from "./handlers.ts";

/** Wiring produksi. Unit test mengganti deps; objek ini hanya mengikat database nyata. */
export const analysisHandlers = createHistoryHandlers({
  readSession: readAnalysisSession,
  list: (userId, options) => listAnalysesForUser(database(), userId, options),
  detail: (userId, analysisId) => getAnalysisDetailForUser(database(), userId, analysisId),
});
