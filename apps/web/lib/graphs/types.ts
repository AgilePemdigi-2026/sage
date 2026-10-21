import type { CcmLimitation, CcmProvenance, CcmSnapshot, CkgCounts } from "@sage/contracts";
import type { GraphViewModel } from "../../components/graph-foundation/graph-projection.ts";

/** Owner-bound, complete graph projection; source bytes and storage paths stay server-side. */
export interface GraphPayload {
  analysisId: string;
  accountKey: string;
  ckgSha256: string;
  configurationHash: string;
  snapshot: CcmSnapshot;
  provenance: CcmProvenance;
  canonicalCounts: CkgCounts;
  filteredCounts: { nodes: number; edges: number };
  returnedCounts: { nodes: number; edges: number };
  paginated: false;
  limitations: CcmLimitation[];
  graph: GraphViewModel;
}

export type GraphReadState =
  | { kind: "ready"; value: Omit<GraphPayload, "accountKey"> }
  | { kind: "not-found" }
  | { kind: "not-ready" };
