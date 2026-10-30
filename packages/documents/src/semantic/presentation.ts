import type { PresentationOverlay, SemanticModel } from "./model.ts";

/** Presentation corrections never mutate source evidence or relationship endpoints. */
export function applyPresentation(model: SemanticModel, overlay: PresentationOverlay): SemanticModel {
  const labels = overlay.labels;
  const groups = overlay.groups;
  return {
    ...model,
    nodes: model.nodes.map(node => ({ ...node, label: Object.hasOwn(labels, node.id) ? labels[node.id]! : node.label,
      featureId: Object.hasOwn(groups, node.id) ? groups[node.id]! : node.featureId })),
    features: model.features.map(feature => ({ ...feature,
      label: Object.hasOwn(labels, feature.id) ? labels[feature.id]! : feature.label,
      nodeIds: [...new Set([...feature.nodeIds.filter(id => !Object.hasOwn(groups, id) || groups[id] === feature.id), ...model.nodes.filter(node => groups[node.id] === feature.id).map(node => node.id)])],
    })),
  };
}
