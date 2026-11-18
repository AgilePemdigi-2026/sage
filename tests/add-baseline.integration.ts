import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { CcmV1, EvidenceSpan } from "@sage/contracts";
import { buildAddBaseline, isAddBaselineModel } from "../packages/documents/src/baseline-add.ts";
import { emptyAddReviewOverlay } from "../packages/documents/src/add-overlay.ts";
import {
  AddBaselineConflictError,
  database,
  disconnectDatabase,
  readAddBaseline,
  saveAddBaseline,
  saveAddRevision,
} from "../packages/database/src/index.ts";
import type { SemanticEdge, SemanticFeature, SemanticModel, SemanticNode } from "../packages/documents/src/semantic/model.ts";

const enabled = process.env.SAGE_ADD_BASELINE_TESTS === "1";
const evidence: EvidenceSpan = {
  filePath: "src/catalog.ts", fileSha256: "a".repeat(64), startByte: 0, endByte: 8,
  startLine: 1, endLine: 1, startColumn: 1, endColumn: 9, role: "reference",
};

function fixture(owner: string): { model: ReturnType<typeof buildAddBaseline>; snapshot: { repository: string; branch: string; commitSha: string } } {
  const snapshot = { repository: `add-baseline-integration/${owner}`, branch: "main", commitSha: "b".repeat(40) };
  const sourceCkgHash = "c".repeat(64);
  const node = (id: string, kind: SemanticNode["kind"], label: string, featureId: string | null): SemanticNode => ({
    id, kind, label, featureId, confidence: "proven", reason: "Declared in source", evidence: [evidence], technicalNodeIds: [],
  });
  const edge = (id: string, source: string, target: string, label: string): SemanticEdge => ({
    id, source, target, label, confidence: "proven", reason: "Direct source evidence", evidence: [evidence],
  });
  const nodes = [
    node("actor:client", "actor", "API client", null),
    node("feature:catalog", "feature", "Catalog", "feature:catalog"),
    node("route:create-item", "step", "POST /items", "feature:catalog"),
    node("component:controller", "component", "ItemController@store", "feature:catalog"),
    node("store:item", "store", "Item", null),
  ];
  const edges = [
    edge("e:actor-route", "actor:client", "route:create-item", "sends request"),
    edge("e:feature-route", "feature:catalog", "route:create-item", "includes entry point"),
    edge("e:route-controller", "route:create-item", "component:controller", "invokes handler"),
    edge("e:controller-store", "component:controller", "store:item", "creates record"),
  ];
  const feature: SemanticFeature = {
    id: "feature:catalog", label: "Catalog", entryNodeIds: ["route:create-item"],
    nodeIds: nodes.filter(item => item.featureId === "feature:catalog" || item.kind === "store").map(item => item.id),
    edgeIds: edges.map(item => item.id), evidence: [evidence],
  };
  const ccm = {
    schemaVersion: 1,
    snapshot,
    provenance: { analyzer: { name: "fixture", version: "1" }, resolver: { name: "fixture", version: "1" }, configHash: "d".repeat(64) },
    files: [], nodes: [], edges: [], limitations: [],
  } as unknown as CcmV1;
  const semantic: SemanticModel = {
    schemaVersion: "sage-semantic-v2", extractorVersion: "integration-v1", sourceCkgHash,
    snapshot, nodes, edges, features: [feature], frameworks: ["Laravel"], limitations: [],
  };
  return { model: buildAddBaseline({ ccm, semantic, sourceCkgHash }), snapshot };
}

function assertDedicatedDatabase(): void {
  if (!enabled) throw new Error("Set SAGE_ADD_BASELINE_TESTS=1 to enable the disposable ADD persistence integration test.");
  const rawUrl = process.env.DATABASE_URL;
  if (!rawUrl) throw new Error("DATABASE_URL is required; it was not logged.");
  let parsed: URL;
  try { parsed = new URL(rawUrl); }
  catch { throw new Error("DATABASE_URL is invalid; it was not logged."); }
  const databaseName = decodeURIComponent(parsed.pathname.slice(1));
  if (databaseName !== "sage_add_baseline_20261119" || !["localhost", "127.0.0.1", "::1"].includes(parsed.hostname)) {
    throw new Error("ADD persistence tests only allow the loopback disposable database sage_add_baseline_20261119.");
  }
}

test("ADD persistence fixture is a valid source-bound baseline", () => {
  const { model, snapshot } = fixture("fixture-validation");
  assert.equal(isAddBaselineModel(model), true);
  assert.equal(model.snapshot.commitSha, snapshot.commitSha);
  assert.equal(model.sourceCkgHash, "c".repeat(64));
});

test("ADD persistence keeps the canonical model owner-scoped and review revisions append-only", { skip: !enabled }, async () => {
  assertDedicatedDatabase();
  const db = database();
  const suffix = randomUUID().replaceAll("-", "");
  const userIds: string[] = [];
  let repositoryId = "";
  let analysisId = "";

  try {
    const owner = await db.user.create({ data: { githubUserId: `add-owner-${suffix}`, login: `add-owner-${suffix}` }, select: { id: true } });
    userIds.push(owner.id);
    const other = await db.user.create({ data: { githubUserId: `add-other-${suffix}`, login: `add-other-${suffix}` }, select: { id: true } });
    userIds.push(other.id);

    const repository = await db.repository.create({
      data: {
        githubRepositoryId: `add-repo-${suffix}`, ownerLogin: "sage-add-integration", name: suffix,
        fullName: `sage-add-integration/${suffix}`, visibility: "PRIVATE",
      }, select: { id: true },
    });
    repositoryId = repository.id;
    const source = fixture(suffix);
    const analysis = await db.analysis.create({
      data: {
        ownerUserId: owner.id, repositoryId, repositoryFullNameSnapshot: source.snapshot.repository,
        branchName: source.snapshot.branch, commitSha: source.snapshot.commitSha,
        configuration: { fixture: "ADD persistence integration" }, configurationHash: "e".repeat(64),
        analyzerVersion: "add-persistence-integration-v1", schemaVersion: "1", status: "COMPLETED",
        resultHash: source.model.sourceCkgHash, completedAt: new Date(),
      }, select: { id: true },
    });
    analysisId = analysis.id;

    const created = await saveAddBaseline(db, { ownerUserId: owner.id, analysisId, model: source.model });
    assert.equal(created.created, true);
    const duplicateModel = structuredClone(source.model);
    duplicateModel.narratives.dataBaseline = "This regeneration must not replace the canonical baseline.";
    const duplicate = await saveAddBaseline(db, { ownerUserId: owner.id, analysisId, model: duplicateModel });
    assert.equal(duplicate.created, false, "generation is idempotent for the same analysis snapshot");
    assert.equal(duplicate.modelHash, created.modelHash);
    assert.deepEqual(duplicate.model, source.model, "a later generation cannot replace the canonical model");

    const beforeRevision = await readAddBaseline(db, owner.id, analysisId);
    assert.ok(beforeRevision);
    assert.equal(beforeRevision.modelHash, created.modelHash);
    assert.equal(beforeRevision.model.sourceCkgHash, source.model.sourceCkgHash);
    assert.deepEqual(beforeRevision.model, source.model, "read verifies and restores the canonical model hash");
    assert.equal(beforeRevision.revision, 0);

    assert.equal(await readAddBaseline(db, other.id, analysisId), null, "another owner cannot read the baseline");
    await assert.rejects(
      saveAddBaseline(db, { ownerUserId: other.id, analysisId, model: source.model }),
      AddBaselineConflictError,
      "another owner cannot attach a baseline to this analysis",
    );
    await assert.rejects(
      saveAddRevision(db, { ownerUserId: other.id, analysisId, expectedRevision: 0, overlay: emptyAddReviewOverlay() }),
      AddBaselineConflictError,
      "another owner cannot create a review revision",
    );

    const elementId = source.model.elements[0]?.id;
    assert.ok(elementId, "fixture creates an ADD element to review");
    const firstOverlay = {
      ...emptyAddReviewOverlay(), revision: 1, status: "reviewed" as const,
      elements: { [elementId]: { name: "Reviewed label", review: "confirmed" as const } },
    };
    const first = await saveAddRevision(db, { ownerUserId: owner.id, analysisId, expectedRevision: 0, overlay: firstOverlay });
    assert.equal(first.revision, 1);

    const staleOverlay = { ...firstOverlay, elements: { [elementId]: { name: "Stale label" } } };
    await assert.rejects(
      saveAddRevision(db, { ownerUserId: owner.id, analysisId, expectedRevision: 0, overlay: staleOverlay }),
      AddBaselineConflictError,
      "a stale client cannot overwrite a newer review revision",
    );

    const contenders = ["Current label A", "Current label B"].map(name => saveAddRevision(db, {
      ownerUserId: owner.id, analysisId, expectedRevision: 1,
      overlay: { ...emptyAddReviewOverlay(), revision: 2, elements: { [elementId]: { name } } },
    }));
    const concurrent = await Promise.allSettled(contenders);
    const winners = concurrent.filter((result): result is PromiseFulfilledResult<Awaited<(typeof contenders)[number]>> => result.status === "fulfilled");
    const conflicts = concurrent.filter(result => result.status === "rejected" && result.reason instanceof AddBaselineConflictError);
    assert.equal(winners.length, 1, "one concurrent writer may append for a given expected revision");
    assert.equal(conflicts.length, 1, "the concurrent stale writer receives a revision conflict");
    const second = winners[0]!.value;
    assert.equal(second.revision, 2);

    const revisions = await db.addRevision.findMany({
      where: { ownerUserId: owner.id, analysisId }, orderBy: { revision: "asc" },
      select: { revision: true, overlay: true, contentHash: true },
    });
    assert.deepEqual(revisions.map(item => item.revision), [1, 2], "updates append records rather than replacing history");
    assert.deepEqual(revisions[0]?.overlay, first.overlay, "the earlier revision remains unchanged");
    assert.equal(revisions[0]?.contentHash, first.contentHash);

    const current = await readAddBaseline(db, owner.id, analysisId);
    assert.ok(current);
    assert.equal(current.revision, 2);
    assert.deepEqual(current.overlay, second.overlay);
    assert.ok(["Current label A", "Current label B"].includes(current.overlay.elements[elementId]?.name ?? ""));
    assert.deepEqual(current.model, source.model, "review corrections are kept separate from the source model");
    assert.equal(current.modelHash, created.modelHash);
  } finally {
    if (analysisId) await db.analysis.deleteMany({ where: { id: analysisId } });
    if (userIds.length) await db.user.deleteMany({ where: { id: { in: userIds } } });
    if (repositoryId) await db.repository.deleteMany({ where: { id: repositoryId } });
    await disconnectDatabase();
  }
});
