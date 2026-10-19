import type { CcmV1 } from "@sage/contracts";

export interface PreviewData {
  model: CcmV1;
  sources: Record<string, string>;
}
