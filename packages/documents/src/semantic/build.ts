import { createHash } from "node:crypto";
import type { SemanticFeature, SemanticInput, SemanticModel } from "./model.ts";
import { extractLaravel } from "./laravel.ts";
import { extractNext } from "./next.ts";
import { compactEvidence } from "./builder.ts";

/** Build deterministic source-grounded semantics; there are no model/network calls. */
export function buildSemanticModel(input: SemanticInput): SemanticModel {
  const fragments = [extractNext(input), extractLaravel(input)];
  const nodes = uniqueById(fragments.flatMap(fragment => fragment.nodes));
  const edges = uniqueById(fragments.flatMap(fragment => fragment.edges));
  const features = mergeFeatures(fragments.flatMap(fragment => fragment.features));
  const snapshot = JSON.parse(JSON.stringify(input.ccm.snapshot)) as SemanticModel["snapshot"];
  const value: SemanticModel = {
    schemaVersion: "sage-semantic-v1",
    extractorVersion: "0.1.0",
    sourceCkgHash: input.sourceCkgHash,
    snapshot,
    nodes,
    edges,
    features,
    frameworks: [...new Set(fragments.flatMap(fragment => fragment.frameworks))].sort(),
    limitations: [...new Map(fragments.flatMap(fragment => fragment.limitations)
      .map(item => [`${item.filePath}\0${item.reason}`, item])).values()]
      .sort((a, b) => a.filePath.localeCompare(b.filePath) || a.reason.localeCompare(b.reason)),
  };
  return value;
}

export function semanticModelHash(model: SemanticModel): string {
  return createHash("sha256").update(JSON.stringify(model), "utf8").digest("hex");
}

function uniqueById<T extends { id: string }>(items: T[]): T[] {
  const map = new Map<string, T>();
  for (const item of items) if (!map.has(item.id)) map.set(item.id, item);
  return [...map.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function mergeFeatures(items: SemanticFeature[]): SemanticFeature[] {
  const map = new Map<string, SemanticFeature>();
  for (const item of items) {
    const current = map.get(item.id);
    if (!current) map.set(item.id, structuredClone(item));
    else {
      current.entryNodeIds = [...new Set([...current.entryNodeIds, ...item.entryNodeIds])].sort();
      current.nodeIds = [...new Set([...current.nodeIds, ...item.nodeIds])].sort();
      current.edgeIds = [...new Set([...current.edgeIds, ...item.edgeIds])].sort();
      current.evidence = compactEvidence([...current.evidence, ...item.evidence]);
    }
  }
  return [...map.values()].sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
}
