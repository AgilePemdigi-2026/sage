import { createHash } from "node:crypto";
import type { SemanticFeature, SemanticInput, SemanticModel } from "./model.ts";
import { extractLaravel } from "./laravel.ts";
import { extractNext } from "./next.ts";
import { extractNodeHttp } from "./node-http.ts";
import { compactEvidence } from "./builder.ts";
import { analyzeDocumentation } from "./documentation.ts";
import { explainExtractedEdge } from "./explanations.ts";

/** Build deterministic source-grounded semantics; there are no model/network calls. */
export function buildSemanticModel(input: SemanticInput): SemanticModel {
  const fragments = [extractNext(input), extractLaravel(input), extractNodeHttp(input)];
  fragments.forEach((fragment, index) => {
    const extractor = ["next", "laravel", "node-http"][index]!;
    fragment.edges = fragment.edges.map(edge => {
      const explanation = edge.explanation ?? explainExtractedEdge(edge);
      return { ...edge, explanation: { ...explanation, rule: `${extractor}:${explanation.kind}` } };
    });
  });
  const nodes = uniqueById(fragments.flatMap(fragment => fragment.nodes));
  const edges = uniqueById(fragments.flatMap(fragment => fragment.edges)).map(edge => ({ ...edge, explanation: edge.explanation ?? explainExtractedEdge(edge) }));
  const features = mergeFeatures(fragments.flatMap(fragment => fragment.features));
  // An empty model is not evidence that an application has no flows.
  if (features.length === 0) {
    const firstSource = input.ccm.files.map(file => file.path).filter(path => path in input.sources && /\.[cm]?[jt]sx?$|\.php$/u.test(path)).sort()[0];
    if (firstSource) fragments.push({ nodes: [], edges: [], features: [], frameworks: [], limitations: [{ filePath: firstSource, reason: "Tidak ada user flow yang dikenali pada snapshot; pola aplikasi mungkin belum didukung. Ketiadaan hasil bukan bukti bahwa aplikasi tidak memiliki alur." }] });
  }
  const snapshot = JSON.parse(JSON.stringify(input.ccm.snapshot)) as SemanticModel["snapshot"];
  const value: SemanticModel = {
    schemaVersion: "sage-semantic-v2",
    extractorVersion: "0.4.0",
    sourceCkgHash: input.sourceCkgHash,
    snapshot,
    documentation: analyzeDocumentation({ sources: input.documentationSources ?? {}, snapshotPaths: input.snapshotPaths ?? Object.keys(input.sources) }),
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
