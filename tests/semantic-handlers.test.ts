import assert from "node:assert/strict";
import test from "node:test";
import { createSemanticHandlers } from "../apps/web/lib/semantic/handlers.ts";
import type { SemanticReadValue } from "../apps/web/lib/semantic/handlers.ts";
import type { SemanticModel } from "../packages/documents/src/semantic/model.ts";
import { validatePresentationOverlay } from "../packages/documents/src/semantic/validation.ts";

const sourceHash = "a".repeat(64);
const evidence = [{ filePath: "src/index.ts", fileSha256: sourceHash, startByte: 0, endByte: 1, startLine: 1, endLine: 1, startColumn: 1, endColumn: 2, role: "context" as const }];
const model: SemanticModel = {
  schemaVersion: "sage-semantic-v1",
  extractorVersion: "test",
  sourceCkgHash: sourceHash,
  snapshot: { repository: "owner/repo", branch: "main", commitSha: "b".repeat(40) },
  nodes: [
    { id: "actor-1", kind: "actor", label: "Developer", featureId: null, confidence: "proven", reason: "route evidence", evidence, technicalNodeIds: [] },
    { id: "feature-1", kind: "feature", label: "Analyze repository", featureId: "feature-1", confidence: "proven", reason: "route evidence", evidence, technicalNodeIds: [] },
    { id: "concept-1", kind: "concept", label: "Repository", featureId: "feature-1", confidence: "indicated", reason: "domain evidence", evidence, technicalNodeIds: [] },
  ],
  edges: [],
  features: [{ id: "feature-1", label: "Analyze repository", entryNodeIds: ["feature-1"], nodeIds: ["feature-1", "concept-1"], edgeIds: [], evidence }],
  frameworks: [],
  limitations: [],
};
const empty = { labels: {}, groups: {} };

function makeHandlers(options: {
  sessionUserId?: string;
  semanticOwnerId?: string;
  state?: "missing" | "legacy" | "ready";
  save?: (input: { ownerUserId: string; analysisId: string; expectedRevision: number; overlay: unknown }) => Promise<SemanticReadValue>;
} = {}) {
  const saved: Array<{ ownerUserId: string; analysisId: string; expectedRevision: number; overlay: unknown }> = [];
  const handlers = createSemanticHandlers({
    env: { AUTH_BASE_URL: "https://sage.test" },
    readSession: async () => options.sessionUserId === undefined ? null : { userId: options.sessionUserId, githubUserId: "gh-" + options.sessionUserId },
    readSemantic: async ownerUserId => {
      if (ownerUserId !== (options.semanticOwnerId ?? "owner")) return null;
      return { id: "semantic-1", modelHash: sourceHash, model, revision: 0, overlay: empty };
    },
    readState: async () => options.state ?? "missing",
    savePresentation: async input => {
      saved.push(input);
      if (options.save) return options.save(input);
      return { id: "semantic-1", modelHash: sourceHash, model, revision: input.expectedRevision + 1, overlay: validatePresentationOverlay(model, input.overlay) };
    },
  });
  return { handlers, saved };
}

function jsonRequest(method: string, body?: unknown, origin = "https://sage.test", url = "https://sage.test/api/analyses/analysis-1/semantic/presentation") {
  return new Request(url, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      origin,
      "x-sage-account": "gh-owner",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

test("semantic GET owner-scopes results and marks old analyses for reanalysis", async () => {
  const owned = makeHandlers({ sessionUserId: "owner", semanticOwnerId: "owner" });
  const ok = await owned.handlers.get(new Request("https://sage.test/api/analyses/analysis-1/semantic"), "analysis-1");
  assert.equal(ok.status, 200);
  assert.equal((await ok.json() as { data: { accountKey: string } }).data.accountKey, "gh-owner");

  const foreign = makeHandlers({ sessionUserId: "other", semanticOwnerId: "owner" });
  const hidden = await foreign.handlers.get(new Request("https://sage.test/api/analyses/analysis-1/semantic"), "analysis-1");
  assert.equal(hidden.status, 404);

  const legacy = makeHandlers({ sessionUserId: "owner", semanticOwnerId: "legacy", state: "legacy" });
  const old = await legacy.handlers.get(new Request("https://sage.test/api/analyses/analysis-1/semantic"), "analysis-1");
  assert.equal(old.status, 409);
});

test("semantic GET accepts only a single nonnegative pinned revision", async () => {
  const { handlers } = makeHandlers({ sessionUserId: "owner", semanticOwnerId: "owner" });
  const invalid = await handlers.get(new Request("https://sage.test/api/analyses/analysis-1/semantic?revision=-1"), "analysis-1");
  assert.equal(invalid.status, 400);
  const repeated = await handlers.get(new Request("https://sage.test/api/analyses/analysis-1/semantic?revision=0&revision=1"), "analysis-1");
  assert.equal(repeated.status, 400);
});

test("presentation PATCH rejects unknown node IDs, unsupported groups, and stale revisions", async () => {
  const { handlers, saved } = makeHandlers({ sessionUserId: "owner", semanticOwnerId: "owner" });
  const unknown = await handlers.patchPresentation(jsonRequest("PATCH", {
    expectedRevision: 0,
    overlay: { labels: { absent: "Unknown" }, groups: {} },
  }), "analysis-1");
  assert.equal(unknown.status, 400);
  const wrongKind = await handlers.patchPresentation(jsonRequest("PATCH", {
    expectedRevision: 0,
    overlay: { labels: {}, groups: { "actor-1": "feature-1" } },
  }), "analysis-1");
  assert.equal(wrongKind.status, 400);
  const unknownFeature = await handlers.patchPresentation(jsonRequest("PATCH", {
    expectedRevision: 0,
    overlay: { labels: {}, groups: { "concept-1": "feature-unknown" } },
  }), "analysis-1");
  assert.equal(unknownFeature.status, 400);
  assert.equal(saved.length, 0);

  const stale = makeHandlers({
    sessionUserId: "owner",
    semanticOwnerId: "owner",
    save: async () => { const error = new Error("stale"); error.name = "SemanticPresentationConflictError"; throw error; },
  });
  const conflict = await stale.handlers.patchPresentation(jsonRequest("PATCH", { expectedRevision: 0, overlay: empty }), "analysis-1");
  assert.equal(conflict.status, 409);
});

test("presentation PATCH accepts a valid overlay and an empty reset overlay", async () => {
  const { handlers, saved } = makeHandlers({ sessionUserId: "owner", semanticOwnerId: "owner" });
  const response = await handlers.patchPresentation(jsonRequest("PATCH", {
    expectedRevision: 0,
    overlay: { labels: { "concept-1": "  Data model  " }, groups: { "concept-1": "feature-1" } },
  }), "analysis-1");
  assert.equal(response.status, 200);
  assert.equal((saved[0]?.overlay as { labels: Record<string, string> }).labels["concept-1"], "  Data model  ");

  const reset = await handlers.patchPresentation(jsonRequest("PATCH", { expectedRevision: 0, overlay: empty }), "analysis-1");
  assert.equal(reset.status, 200);
  assert.deepEqual(saved[1]?.overlay, empty);
});

test("presentation PATCH enforces same-origin and rejects malformed labels", async () => {
  const { handlers, saved } = makeHandlers({ sessionUserId: "owner", semanticOwnerId: "owner" });
  const foreignOrigin = await handlers.patchPresentation(jsonRequest("PATCH", { expectedRevision: 0, overlay: empty }, "https://attacker.test"), "analysis-1");
  assert.equal(foreignOrigin.status, 403);
  const control = await handlers.patchPresentation(jsonRequest("PATCH", {
    expectedRevision: 0,
    overlay: { labels: { "concept-1": "invalid\nlabel" }, groups: {} },
  }), "analysis-1");
  assert.equal(control.status, 400);
  const tooLong = await handlers.patchPresentation(jsonRequest("PATCH", {
    expectedRevision: 0,
    overlay: { labels: { "concept-1": "x".repeat(121) }, groups: {} },
  }), "analysis-1");
  assert.equal(tooLong.status, 400);
  assert.equal(saved.length, 0);
});
