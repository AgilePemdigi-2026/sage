import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import type { PresentationOverlay, SemanticEdge, SemanticModel, SemanticNode, SemanticPayload } from "../packages/documents/src/semantic/model.ts";
import { aggregateArchitectureReferences, buildArchitectureProjection, type ArchitectureProjection } from "../apps/web/components/semantic-workspace/architecture-projection.ts";

const evidence = { filePath: "routes/api.php", fileSha256: "a".repeat(64), startByte: 0, endByte: 1, startLine: 1, endLine: 1, startColumn: 1, endColumn: 2, role: "reference" as const };
const sourceNode = (id: string, kind: SemanticNode["kind"], label: string, featureId: string | null): SemanticNode => ({ id, kind, label, featureId, confidence: "proven", reason: "Source declaration", evidence: [evidence], technicalNodeIds: [] });
const sourceEdge = (id: string, source: string, target: string, label: string, confidence: SemanticEdge["confidence"] = "proven"): SemanticEdge => ({ id, source, target, label, confidence, reason: "Direct source relation", evidence: [evidence] });

function payload(model: SemanticModel, overlay: PresentationOverlay = { labels: {}, groups: {} }): SemanticPayload {
  return { analysisId: "analysis", accountKey: "owner", modelHash: "b".repeat(64), model, revision: 0, overlay };
}

const fixture: SemanticModel = {
  schemaVersion: "sage-semantic-v1", extractorVersion: "0.2.0", sourceCkgHash: "c".repeat(64),
  snapshot: { repository: "fixture/api", branch: "main", commitSha: "d".repeat(40) }, frameworks: ["Laravel"], limitations: [],
  nodes: [
    sourceNode("feature:checkin", "feature", "Mood check-in", "feature:checkin"), sourceNode("feature:profile", "feature", "Profile", "feature:profile"),
    sourceNode("actor:auth", "actor", "Authenticated API client", null), sourceNode("actor:admin", "actor", "Administrator", null),
    sourceNode("route:post", "step", "POST /checkin", "feature:checkin"), sourceNode("controller:checkin", "component", "MoodCheckinController@store", "feature:checkin"),
    sourceNode("route:profile", "step", "GET /profile", "feature:profile"), sourceNode("controller:profile", "component", "ProfileController@show", "feature:profile"),
    sourceNode("store:user", "store", "User", null), sourceNode("decision:valid", "decision", "Validate mood", "feature:checkin"),
    sourceNode("step:ambiguous", "step", "Ambiguous branch", null), sourceNode("concept:hidden", "concept", "Unused detail", "feature:checkin"),
  ],
  edges: [
    sourceEdge("e:auth-post", "actor:auth", "route:post", "is protected by"), sourceEdge("e:post-controller", "route:post", "controller:checkin", "runs"),
    sourceEdge("e:controller-store", "controller:checkin", "store:user", "writes"), sourceEdge("e:auth-profile", "actor:auth", "route:profile", "is protected by"),
    sourceEdge("e:profile-controller", "route:profile", "controller:profile", "runs"), sourceEdge("e:profile-store", "controller:profile", "store:user", "reads"),
    sourceEdge("e:admin", "actor:admin", "route:profile", "is protected by", "indicated"),
    sourceEdge("e:ambiguous", "step:ambiguous", "store:user", "reads"),
  ],
  features: [
    { id: "feature:checkin", label: "Mood check-in", nodeIds: ["feature:checkin", "actor:auth", "route:post", "controller:checkin", "store:user", "decision:valid", "step:ambiguous", "concept:hidden"], entryNodeIds: ["route:post"], edgeIds: ["e:auth-post", "e:post-controller", "e:controller-store", "e:ambiguous"], evidence: [evidence] },
    { id: "feature:profile", label: "Profile", nodeIds: ["feature:profile", "actor:auth", "actor:admin", "route:profile", "controller:profile", "store:user", "step:ambiguous"], entryNodeIds: ["route:profile"], edgeIds: ["e:auth-profile", "e:profile-controller", "e:profile-store", "e:admin", "e:ambiguous"], evidence: [evidence] },
  ],
};

test("initial overview draws only source-backed actor, route, controller, and store paths", () => {
  const before = structuredClone(fixture);
  const result = buildArchitectureProjection(payload(fixture));
  const ids = new Set(result.nodes.map(node => node.id));
  assert.ok(ids.has("actor:auth"));
  assert.ok(ids.has("store:user"));
  assert.ok(result.edges.length > 0, "the default canvas includes connected source paths before feature selection");
  assert.ok(result.edges.some(edge => edge.source === "actor:auth" && edge.target === "feature:checkin" && edge.labels.some(label => label.startsWith("is protected by"))));
  assert.ok(result.edges.some(edge => edge.source === "feature:checkin" && edge.target === "store:user"));
  assert.ok(result.edges.some(edge => edge.originalEndpoints.some(pair => pair.source === "controller:checkin" && pair.target === "store:user")));
  assert.ok(result.nodes.find(node => node.id === "feature:checkin")?.componentLabels.includes("MoodCheckinController@store"));
  for (const edge of result.edges) {
    assert.ok(edge.sourceEdgeIds.length > 0);
    assert.ok(edge.originalEndpoints.length === edge.sourceEdgeIds.length);
  }
  assert.ok(!result.edges.some(edge => edge.source === "feature:checkin" && edge.target === "feature:profile"), "shared data does not invent feature-to-feature calls");
  assert.ok(!result.edges.some(edge => edge.sourceEdgeIds.includes("e:ambiguous")), "ambiguous shared membership does not create cartesian feature links");
  assert.ok(result.hiddenNodeCount > 0 && result.hiddenEdgeCount > 0);
  assert.deepEqual(fixture, before, "projection does not mutate the canonical model");
});

test("overlay groups and labels drive the architecture summary and indication filter", () => {
  const result = buildArchitectureProjection(payload(fixture, {
    labels: { "feature:checkin": "Daily mood", "route:post": "POST /mood" },
    groups: { "controller:checkin": "feature:profile" },
  }));
  const checkin = result.nodes.find(node => node.id === "feature:checkin")!;
  const profile = result.nodes.find(node => node.id === "feature:profile")!;
  assert.equal(checkin.label, "Daily mood");
  assert.ok(checkin.routeLabels.includes("POST /mood"));
  assert.ok(!checkin.componentLabels.includes("MoodCheckinController@store"));
  assert.ok(profile.componentLabels.includes("MoodCheckinController@store"));
  const provenOnly = buildArchitectureProjection(payload(fixture), { showIndications: false });
  assert.ok(!provenOnly.edges.some(edge => edge.sourceEdgeIds.includes("e:admin")));
  assert.ok(provenOnly.edges.some(edge => edge.sourceEdgeIds.includes("e:auth-post")));
  assert.ok(!provenOnly.nodes.some(node => node.id === "actor:admin"), "an indicated actor disappears when indicated relationships are hidden");
});

test("feature filtering excludes global actors and stores that have no membership in the selected source scope", () => {
  const result = buildArchitectureProjection(payload(fixture), { featureIds: ["feature:checkin"] });
  assert.ok(result.nodes.some(node => node.id === "actor:auth"));
  assert.ok(!result.nodes.some(node => node.id === "actor:admin"));
  assert.ok(!result.nodes.some(node => node.id === "feature:profile"));
  assert.ok(!result.edges.some(edge => edge.source === "feature:profile" || edge.target === "feature:profile"));
  assert.deepEqual(buildArchitectureProjection(payload(fixture), { featureIds: ["missing"] }).nodes, []);
});

test("all source-backed previews survive long lists and summary IDs/evidence stay unique", () => {
  const routes = Array.from({ length: 30 }, (_, index) => sourceNode(`route:${index}`, "step", `GET /items/${index}`, "feature:checkin"));
  const edges = routes.map((route, index) => sourceEdge(`route-edge:${index}`, "actor:auth", route.id, "is protected by"));
  const large: SemanticModel = {
    ...fixture,
    nodes: [...fixture.nodes, ...routes],
    edges: [...fixture.edges, ...edges],
    features: fixture.features.map(feature => feature.id === "feature:checkin" ? {
      ...feature, nodeIds: [...feature.nodeIds, ...routes.map(node => node.id)], entryNodeIds: routes.map(node => node.id), edgeIds: [...feature.edgeIds, ...edges.map(edge => edge.id)],
    } : feature),
  };
  const result = buildArchitectureProjection(payload(large));
  const checkin = result.nodes.find(node => node.id === "feature:checkin")!;
  assert.equal(checkin.routeLabels.length, 30);
  assert.ok(routes.every(route => checkin.sourceNodeIds.includes(route.id)));
  const routeEdge = result.edges.find(edge => edge.source === "actor:auth" && edge.target === "feature:checkin")!;
  assert.equal(routeEdge.sourceEdgeIds.length, 31);
  assert.equal(routeEdge.labels.length, 31);
  assert.equal(routeEdge.evidence.length, 1, "same source span is represented once per aggregate edge");
  assert.deepEqual(buildArchitectureProjection(payload(large)), result, "output order is deterministic");
});

test("feature confidence comes from its canonical source node and indicated routes are omitted with the filter", () => {
  const model: SemanticModel = {
    ...fixture,
    nodes: fixture.nodes.map(node => node.id === "feature:profile" || node.id === "route:profile" ? { ...node, confidence: "indicated" as const } : node),
  };
  const result = buildArchitectureProjection(payload(model), { showIndications: false });
  const profile = result.nodes.find(node => node.id === "feature:profile")!;
  assert.equal(profile.confidence, "indicated");
  assert.ok(!profile.routeLabels.includes("GET /profile"));
  assert.ok(!profile.sourceNodeIds.includes("route:profile"));
});

test("presentation reference buckets reduce duplicate labels without merging source identities or adding relationships", () => {
  const nodes = [
    { ...sourceNode("feature:a", "feature", "A", "feature:a"), sourceNodeIds: ["feature:a"], featureIds: ["feature:a"], routeLabels: [], componentLabels: [], decisionCount: 0, sourceFileCount: 1 },
    { ...sourceNode("feature:b", "feature", "B", "feature:b"), sourceNodeIds: ["feature:b"], featureIds: ["feature:b"], routeLabels: [], componentLabels: [], decisionCount: 0, sourceFileCount: 1 },
    { ...sourceNode("client:a", "actor", "API client", null), sourceNodeIds: ["client:a"], featureIds: ["feature:a"], routeLabels: [], componentLabels: [], decisionCount: 0, sourceFileCount: 1 },
    { ...sourceNode("client:b", "actor", "API client", null), sourceNodeIds: ["client:b"], featureIds: ["feature:a"], routeLabels: [], componentLabels: [], decisionCount: 0, sourceFileCount: 1 },
    { ...sourceNode("user:a", "store", "User", null), sourceNodeIds: ["user:a"], featureIds: ["feature:a"], routeLabels: [], componentLabels: [], decisionCount: 0, sourceFileCount: 1 },
    { ...sourceNode("user:b", "store", "User", null), sourceNodeIds: ["user:b"], featureIds: ["feature:b"], routeLabels: [], componentLabels: [], decisionCount: 0, sourceFileCount: 1 },
  ];
  const edgeRows = [
    { ...sourceEdge("source:client-a", "client:a", "feature:a", "calls"), labels: ["calls"], sourceEdgeIds: ["source:client-a"], originalEndpoints: [{ source: "client:a", target: "route:a" }] },
    { ...sourceEdge("source:client-b", "client:b", "feature:a", "calls"), labels: ["calls"], sourceEdgeIds: ["source:client-b"], originalEndpoints: [{ source: "client:b", target: "route:b" }] },
    { ...sourceEdge("source:user-a", "feature:a", "user:a", "writes"), labels: ["writes"], sourceEdgeIds: ["source:user-a"], originalEndpoints: [{ source: "controller:a", target: "user:a" }] },
    { ...sourceEdge("source:user-b", "feature:b", "user:b", "reads"), labels: ["reads"], sourceEdgeIds: ["source:user-b"], originalEndpoints: [{ source: "controller:b", target: "user:b" }] },
  ];
  const projection: ArchitectureProjection = {
    nodes, edges: edgeRows, featureIds: ["feature:a", "feature:b"],
    representedNodeIds: nodes.flatMap(node => node.sourceNodeIds), representedEdgeIds: edgeRows.flatMap(edge => edge.sourceEdgeIds),
    hiddenNodeCount: 2, hiddenEdgeCount: 3,
  };
  const before = structuredClone(projection);
  const result = aggregateArchitectureReferences(projection);
  assert.deepEqual(projection, before, "presentation aggregation does not mutate the incoming projection");
  const actor = result.nodes.find(node => node.isReferenceGroup && node.kind === "actor")!;
  const store = result.nodes.find(node => node.isReferenceGroup && node.kind === "store")!;
  assert.equal(actor.label, "API client references (2)");
  assert.deepEqual(actor.sourceNodeIds, ["client:a", "client:b"]);
  assert.deepEqual(actor.featureIds, ["feature:a"]);
  assert.equal(store.label, "User references (2)");
  assert.deepEqual(store.sourceNodeIds, ["user:a", "user:b"]);
  assert.match(store.reason, /does not prove one identity or datastore/u);
  assert.equal(result.nodes.length, 4);
  assert.equal(result.edges.length, 3);
  const groupedActorEdge = result.edges.find(edge => edge.source === actor.id)!;
  assert.deepEqual(groupedActorEdge.sourceEdgeIds, ["source:client-a", "source:client-b"]);
  assert.deepEqual(groupedActorEdge.originalEndpoints, [{ source: "client:a", target: "route:a" }, { source: "client:b", target: "route:b" }]);
  assert.ok(!result.edges.some(edge => edge.source === "feature:a" && edge.target === "feature:b"), "same-label stores do not create calls between their features");
  assert.deepEqual(new Set(result.edges.flatMap(edge => edge.sourceEdgeIds)), new Set(projection.representedEdgeIds));
  assert.deepEqual(result.representedNodeIds, [...projection.representedNodeIds].sort());
});

test("saved Emosync corpus has connected default overview and visible shared principal and storage links when available", { skip: !existsSync("artifacts/semantic/readability-20261101/emosync-backend-semantic.json") }, () => {
  const model = JSON.parse(readFileSync("artifacts/semantic/readability-20261101/emosync-backend-semantic.json", "utf8")) as SemanticModel;
  const result = buildArchitectureProjection(payload(model));
  assert.ok(result.edges.length > 0);
  const nodesById = new Map(model.nodes.map(node => [node.id, node]));
  const actorFeatureMemberships = new Map<string, Set<string>>();
  for (const feature of model.features) for (const id of feature.nodeIds) {
    if (nodesById.get(id)?.kind !== "actor") continue;
    const memberships = actorFeatureMemberships.get(id) ?? new Set<string>();
    memberships.add(feature.id); actorFeatureMemberships.set(id, memberships);
  }
  const mostSharedActor = [...actorFeatureMemberships.values()].sort((left, right) => right.size - left.size)[0];
  assert.ok(mostSharedActor && mostSharedActor.size >= 10, "the authenticated API client is referenced across the Emosync features");
  assert.ok([...result.edges].some(edge => {
    return [edge.source, edge.target].some(id => nodesById.get(id)?.kind === "store" && nodesById.get(id)?.label === "User");
  }), "source-backed paths to the shared User store are visible by default");
  const compact = aggregateArchitectureReferences(result);
  assert.equal(compact.featureIds.length, model.features.length, "all features remain discoverable");
  assert.equal(compact.nodes.length, result.nodes.length, "Emosync labels are unique, so canonical identities remain separate");
  assert.ok(compact.edges.length <= result.edges.length, "aggregation does not create new visible relationships");
  assert.deepEqual(new Set(compact.edges.flatMap(edge => edge.sourceEdgeIds)), new Set(result.edges.flatMap(edge => edge.sourceEdgeIds)));
});

test("saved Perpus compacts repeated role and table references without losing features or source relationships when available", { skip: !existsSync("artifacts/semantic/readability-20261101/sistem-informasi-perpus-semantic.json") }, () => {
  const model = JSON.parse(readFileSync("artifacts/semantic/readability-20261101/sistem-informasi-perpus-semantic.json", "utf8")) as SemanticModel;
  const original = buildArchitectureProjection(payload(model));
  const compact = aggregateArchitectureReferences(original);
  assert.equal(compact.featureIds.length, model.features.length);
  assert.ok(compact.nodes.length < original.nodes.length);
  assert.ok(compact.nodes.some(node => node.label === "Book references (23)" && node.kind === "store"));
  assert.ok(compact.nodes.some(node => node.label === "Admin references (19)" && node.kind === "actor"));
  assert.deepEqual(new Set(compact.edges.flatMap(edge => edge.sourceEdgeIds)), new Set(original.edges.flatMap(edge => edge.sourceEdgeIds)));
  assert.ok(compact.edges.length <= original.edges.length);
  const originalPairs = new Set(original.edges.flatMap(edge => edge.originalEndpoints.map(pair => `${pair.source}\0${pair.target}`)));
  const compactPairs = new Set(compact.edges.flatMap(edge => edge.originalEndpoints.map(pair => `${pair.source}\0${pair.target}`)));
  assert.deepEqual(compactPairs, originalPairs, "presentation buckets retain original edge endpoints and add none");
});
