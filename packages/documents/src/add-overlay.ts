import type { AddBaselineModel, AddElement } from "./baseline-add.ts";

export const ADD_REVIEW_SCHEMA = "sage-add-review-v1" as const;
export type AddReviewOverlay = {
  schemaVersion: typeof ADD_REVIEW_SCHEMA;
  revision: number;
  status: "draft" | "reviewed";
  elements: Record<string, { name?: string; featureGroup?: string | null; review?: "confirmed" | "rejected" }>;
};

export function emptyAddReviewOverlay(): AddReviewOverlay {
  return { schemaVersion: ADD_REVIEW_SCHEMA, revision: 0, status: "draft", elements: {} };
}

/** Accept only label/group/review corrections for existing source elements. Relationships and source facts stay immutable. */
export function parseAddReviewOverlay(model: AddBaselineModel, value: unknown, revision: number): AddReviewOverlay {
  if (!Number.isSafeInteger(revision) || revision < 0 || !value || typeof value !== "object" || Array.isArray(value)) throw new Error("ADD_REVIEW_INVALID");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !["schemaVersion", "revision", "status", "elements"].includes(key))) throw new Error("ADD_REVIEW_INVALID");
  if (input.schemaVersion !== ADD_REVIEW_SCHEMA || input.revision !== revision || (input.status !== "draft" && input.status !== "reviewed") || !input.elements || typeof input.elements !== "object" || Array.isArray(input.elements)) throw new Error("ADD_REVIEW_INVALID");
  const allowedIds = new Set(model.elements.map(element => element.id));
  const elements: AddReviewOverlay["elements"] = {};
  for (const [id, raw] of Object.entries(input.elements as Record<string, unknown>)) {
    if (!allowedIds.has(id) || !raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("ADD_REVIEW_INVALID");
    const patch = raw as Record<string, unknown>;
    if (Object.keys(patch).some(key => !["name", "featureGroup", "review"].includes(key))) throw new Error("ADD_REVIEW_INVALID");
    const next: AddReviewOverlay["elements"][string] = {};
    if (Object.hasOwn(patch, "name")) {
      if (typeof patch.name !== "string" || !patch.name.trim() || patch.name.trim().length > 180) throw new Error("ADD_REVIEW_INVALID");
      next.name = patch.name.trim();
    }
    if (Object.hasOwn(patch, "featureGroup")) {
      if (patch.featureGroup !== null && (typeof patch.featureGroup !== "string" || patch.featureGroup.trim().length > 180)) throw new Error("ADD_REVIEW_INVALID");
      next.featureGroup = typeof patch.featureGroup === "string" ? patch.featureGroup.trim() || null : null;
    }
    if (Object.hasOwn(patch, "review")) {
      if (patch.review !== "confirmed" && patch.review !== "rejected") throw new Error("ADD_REVIEW_INVALID");
      next.review = patch.review;
    }
    if (Object.keys(next).length) elements[id] = next;
  }
  return { schemaVersion: ADD_REVIEW_SCHEMA, revision, status: input.status, elements };
}

export function applyAddReviewOverlay(model: AddBaselineModel, overlay: AddReviewOverlay): AddBaselineModel {
  const patches = overlay.elements;
  const elements: AddElement[] = model.elements.map(element => {
    const patch = patches[element.id];
    if (!patch) return element;
    return {
      ...element,
      ...(patch.name === undefined ? {} : { name: patch.name }),
      ...(patch.featureGroup === undefined ? {} : { featureGroup: patch.featureGroup }),
      ...(patch.review === undefined ? {} : { review: patch.review }),
      ...(patch.review === "confirmed" ? { origin: "user-confirmed" as const } : {}),
    };
  });
  return { ...model, elements };
}
