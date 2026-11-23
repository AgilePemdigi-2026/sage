import assert from "node:assert/strict";
import test from "node:test";
import type { CcmV1 } from "@sage/contracts";
import { createAddHandlers } from "../apps/web/lib/add/handlers.ts";
import type { AnalysisSession } from "../apps/web/lib/analyses/handlers.ts";
import { AddBaselineConflictError } from "../packages/database/src/add-baseline.ts";
import { emptyAddReviewOverlay } from "../packages/documents/src/add-overlay.ts";
import { buildAddBaseline } from "../packages/documents/src/baseline-add.ts";
import type { SemanticModel } from "../packages/documents/src/semantic/model.ts";

const owner = "owner-user";
const githubUserId = "gh-owner";
const ccm = {
  schemaVersion: 1,
  snapshot: { repository: "fixture/add-handler", branch: "main", commitSha: "a".repeat(40) },
  provenance: { analyzer: { name: "fixture", version: "1" }, resolver: { name: "fixture", version: "1" }, configHash: "b".repeat(64) },
  files: [], nodes: [], edges: [], limitations: [],
} as unknown as CcmV1;
const semantic: SemanticModel = {
  schemaVersion: "sage-semantic-v2", extractorVersion: "fixture", sourceCkgHash: "c".repeat(64), snapshot: ccm.snapshot,
  nodes: [], edges: [], features: [], frameworks: [], limitations: [],
};

function setup(options: { session?: AnalysisSession | null; concurrentRevision?: boolean } = {}) {
  let baseline: { id: string; modelHash: string; sourceCkgHash: string; model: unknown; revision: number; overlay: unknown } | null = null;
  let revision = 0;
  let saves = 0;
  const handlers = createAddHandlers({
    env: { AUTH_BASE_URL: "https://sage.test" },
    readSession: async () => options.session === undefined ? { userId: owner, githubUserId } : options.session,
    readInputs: async userId => userId === owner ? { ckg: ccm, ckgHash: "c".repeat(64), semantic } : null,
    readBaseline: async userId => userId === owner ? baseline : null,
    saveBaseline: async input => {
      saves += 1;
      const model = input.model;
      baseline = { id: "baseline-123", modelHash: "d".repeat(64), sourceCkgHash: model.sourceCkgHash, model, revision: 0, overlay: emptyAddReviewOverlay() };
      if (options.concurrentRevision) {
        baseline = { ...baseline, revision: 1, overlay: { ...emptyAddReviewOverlay(), revision: 1, status: "reviewed" } };
        return { id: baseline.id, modelHash: baseline.modelHash, model, created: false };
      }
      return { id: baseline.id, modelHash: baseline.modelHash, model, created: true };
    },
    saveRevision: async input => {
      if (input.ownerUserId !== owner || input.expectedRevision !== revision) throw new AddBaselineConflictError();
      revision += 1;
      const overlay = { ...(input.overlay as object), revision };
      if (baseline) baseline = { ...baseline, revision, overlay };
      return { id: `revision-${revision}`, revision, overlay, contentHash: "e".repeat(64) };
    },
  });
  return { handlers, get saves() { return saves; } };
}

test("concurrent ADD generation returns the persisted revision", async () => {
  const fixture = setup({ concurrentRevision: true });
  const response = await fixture.handlers.generate(request("POST", { allowLlm: false }, { origin: "https://sage.test" }), "analysis-123");
  const data = (await response.json() as { data: { revision: number; overlay: { status: string } } }).data;
  assert.equal(response.status, 200);
  assert.equal(data.revision, 1);
  assert.equal(data.overlay.status, "reviewed");
});

function request(method: string, body?: unknown, options: { origin?: string; account?: string } = {}) {
  return new Request("https://sage.test/api/analyses/analysis-123/add", {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(options.origin === undefined ? {} : { origin: options.origin }),
      ...(options.account === undefined ? {} : { "x-sage-account": options.account }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

test("ADD GET and generation bind results to the active owner and GitHub account", async () => {
  const fixture = setup();
  const before = await fixture.handlers.get(request("GET"), "analysis-123");
  assert.equal(before.status, 409);
  assert.equal((await before.json() as { data: { status: string } }).data.status, "not-generated");

  const mismatch = await fixture.handlers.generate(request("POST", { allowLlm: false }, { origin: "https://sage.test", account: "gh-other" }), "analysis-123");
  assert.equal(mismatch.status, 401);

  const generated = await fixture.handlers.generate(request("POST", { allowLlm: false }, { origin: "https://sage.test", account: githubUserId }), "analysis-123");
  assert.equal(generated.status, 201);
  const data = (await generated.json() as { data: { model: ReturnType<typeof buildAddBaseline>; accountKey: string } }).data;
  assert.equal(data.accountKey, githubUserId);
  const read = await fixture.handlers.get(request("GET"), "analysis-123");
  assert.equal((await read.json() as { data: { analysisId?: string } }).data.analysisId, "analysis-123");
  assert.equal(data.model.generation.llmOutcome, "not-requested");
  assert.equal(fixture.saves, 1);

  const repeated = await fixture.handlers.generate(request("POST", { allowLlm: false }, { origin: "https://sage.test" }), "analysis-123");
  assert.equal(repeated.status, 200);
  assert.equal(fixture.saves, 1, "a retry returns the immutable existing baseline instead of duplicating it");

  const noSession = setup({ session: null });
  assert.equal((await noSession.handlers.get(request("GET"), "analysis-123")).status, 401);
});

test("ADD generation validates origin and consent body without calling an unconfigured LLM", async () => {
  const fixture = setup();
  assert.equal((await fixture.handlers.generate(request("POST", { allowLlm: false }, { origin: "https://attacker.test" }), "analysis-123")).status, 403);
  assert.equal((await fixture.handlers.generate(request("POST", { allowLlm: "yes" }, { origin: "https://sage.test" }), "analysis-123")).status, 400);
  const response = await fixture.handlers.generate(request("POST", { allowLlm: true }, { origin: "https://sage.test" }), "analysis-123");
  assert.equal(response.status, 201);
  const result = (await response.json() as { data: { model: ReturnType<typeof buildAddBaseline> } }).data.model;
  assert.equal(result.generation.llmOutcome, "not-configured");
  assert.equal(result.generation.llmModel, null);
});

test("ADD review requires same origin, validates overlay IDs, and rejects stale revisions", async () => {
  const fixture = setup();
  await fixture.handlers.generate(request("POST", { allowLlm: false }, { origin: "https://sage.test" }), "analysis-123");
  const badOrigin = await fixture.handlers.updateReview(request("PATCH", { expectedRevision: 0, overlay: { ...emptyAddReviewOverlay(), elements: {} } }, { origin: "https://attacker.test" }), "analysis-123");
  assert.equal(badOrigin.status, 403);
  const invalid = await fixture.handlers.updateReview(request("PATCH", { expectedRevision: 0, overlay: { ...emptyAddReviewOverlay(), elements: { missing: { name: "Injected" } } } }, { origin: "https://sage.test" }), "analysis-123");
  assert.equal(invalid.status, 422);
  const first = await fixture.handlers.updateReview(request("PATCH", { expectedRevision: 0, overlay: { ...emptyAddReviewOverlay(), status: "reviewed", elements: {} } }, { origin: "https://sage.test" }), "analysis-123");
  assert.equal(first.status, 201);
  assert.equal((await first.json() as { data: { revision: number } }).data.revision, 1);
  const stale = await fixture.handlers.updateReview(request("PATCH", { expectedRevision: 0, overlay: { ...emptyAddReviewOverlay(), elements: {} } }, { origin: "https://sage.test" }), "analysis-123");
  assert.equal(stale.status, 409);
});
