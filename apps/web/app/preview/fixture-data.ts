import { validateCcm } from "@sage/contracts";
import { createGraphFixture } from "../graph-preview/fixture-data.ts";
import type { PreviewData } from "../../components/sprint-ui/types.ts";

/** Shared source-backed example; this function never reads user sessions or saved analyses. */
export function createPreviewData(): PreviewData {
  const fixture = createGraphFixture();
  const result = validateCcm(fixture.payload, fixture.sourceBytes);
  if (!result.ok) throw new Error("Fixture pratinjau tidak valid.");
  return {
    model: result.value,
    sources: Object.fromEntries(Object.entries(fixture.sourceBytes).map(([path, bytes]) => [path, new TextDecoder("utf-8", { fatal: true }).decode(bytes)])),
  };
}
