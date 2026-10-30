import {
  appendPresentationRevision,
  database,
  readSemanticForUser,
  readSemanticPublicationStateForUser,
} from "@sage/database";
import { readAnalysisSession } from "../analyses/session.ts";
import { createSemanticHandlers } from "./handlers.ts";

export const semanticHandlers = createSemanticHandlers({
  env: process.env,
  readSession: readAnalysisSession,
  readSemantic: (ownerUserId, analysisId, revision) =>
    readSemanticForUser(database(), ownerUserId, analysisId, revision),
  readState: (ownerUserId, analysisId) =>
    readSemanticPublicationStateForUser(database(), ownerUserId, analysisId),
  savePresentation: input => appendPresentationRevision(database(), input),
});
