import type { Metadata } from "next";
import { GraphPreviewClient } from "../../components/graph-foundation/graph-preview-client";
import { createGraphFixture } from "./fixture-data";
import { validateCcm } from "@sage/contracts";

export const metadata: Metadata = {
  title: "SAGE — Pratinjau knowledge graph",
  description: "Pratinjau interaktif graph dari fixture source code yang divalidasi.",
  robots: { index: false, follow: false },
};

export default function GraphPreviewPage() {
  const fixture = createGraphFixture();
  const validation = validateCcm(fixture.payload, fixture.sourceBytes);
  if (!validation.ok) return <GraphPreviewClient model={null} validationError={validation.errorCode} />;
  return <GraphPreviewClient model={validation.value} />;
}
