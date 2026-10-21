import type { ArchitectureDocumentV1 } from "@sage/documents/model";

/** Only an owner-bound, terminally published document can reach the browser. */
export interface DocumentPayload {
  analysisId: string;
  accountKey: string;
  contentHash: string;
  document: ArchitectureDocumentV1;
}

export type DocumentReadState =
  | { kind: "ready"; value: Omit<DocumentPayload, "accountKey"> }
  | { kind: "not-found" }
  | { kind: "not-ready" };
