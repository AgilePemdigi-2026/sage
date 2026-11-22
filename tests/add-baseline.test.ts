import assert from "node:assert/strict";
import test from "node:test";
import type { CcmV1, EvidenceSpan } from "@sage/contracts";
import { buildAddBaseline, isAddBaselineModel } from "../packages/documents/src/baseline-add.ts";
import { emptyAddReviewOverlay } from "../packages/documents/src/add-overlay.ts";
import { createAddMarkdown } from "../packages/documents/src/baseline-markdown.ts";
import { enrichAddNarrative } from "../packages/documents/src/baseline-llm.ts";
import { extractDataArtifacts } from "../packages/documents/src/semantic/data-artifacts.ts";
import { baselineCatalogMappings } from "../packages/documents/src/phase-c-add.ts";
import type { SemanticEdge, SemanticFeature, SemanticModel, SemanticNode } from "../packages/documents/src/semantic/model.ts";

const evidence: EvidenceSpan = {
  filePath: "app/routes.ts", fileSha256: "a".repeat(64), startByte: 0, endByte: 8,
  startLine: 1, endLine: 1, startColumn: 1, endColumn: 9, role: "reference",
};
const node = (id: string, kind: SemanticNode["kind"], label: string, featureId: string | null): SemanticNode => ({
  id, kind, label, featureId, confidence: "proven", reason: "Declared in source", evidence: [evidence], technicalNodeIds: [],
});
const edge = (id: string, source: string, target: string, label: string, confidence: SemanticEdge["confidence"] = "proven", dataOperation?: SemanticEdge["dataOperation"]): SemanticEdge => ({
  id, source, target, label, confidence, reason: "Direct source evidence", evidence: [evidence], ...(dataOperation ? { dataOperation } : {}),
});

function fixture(): { ccm: CcmV1; semantic: SemanticModel; sourceCkgHash: string } {
  const commitSha = "b".repeat(40);
  const sourceCkgHash = "c".repeat(64);
  const features: SemanticFeature[] = [{
    id: "feature:catalog", label: "Catalog", entryNodeIds: ["route:create-book"],
    nodeIds: ["feature:catalog", "route:create-book", "component:controller", "component:service", "store:book", "store:author"],
    edgeIds: ["e:feature-route", "e:route-controller", "e:controller-store", "e:controller-service", "e:fk"], evidence: [evidence],
  }];
  const nodes = [
    node("actor:client", "actor", "API client", null),
    node("feature:catalog", "feature", "Catalog", "feature:catalog"),
    node("route:create-book", "step", "POST /books", "feature:catalog"),
    node("component:controller", "component", "BookController@store", "feature:catalog"),
    node("component:service", "component", "persistBook", "feature:catalog"),
    node("store:book", "store", "Book", null),
    node("store:author", "store", "Author", null),
    node("decision:validation", "decision", "Validate request", "feature:catalog"),
  ];
  const edges = [
    edge("e:actor-route", "actor:client", "route:create-book", "sends request"),
    edge("e:feature-route", "feature:catalog", "route:create-book", "includes entry point"),
    edge("e:route-controller", "route:create-book", "component:controller", "invokes handler"),
    edge("e:controller-store", "component:controller", "store:book", "creates record", "proven", "create"),
    edge("e:controller-service", "component:controller", "component:service", "calls service"),
    edge("e:fk", "store:book", "store:author", "references data object"),
  ];
  const ccm = {
    schemaVersion: 1,
    snapshot: { repository: "sample/library", branch: "main", commitSha },
    provenance: { analyzer: { name: "fixture", version: "1" }, resolver: { name: "fixture", version: "1" }, configHash: "d".repeat(64) },
    files: [], nodes: [], edges: [], limitations: [],
  } as unknown as CcmV1;
  return {
    ccm,
    semantic: { schemaVersion: "sage-semantic-v2", extractorVersion: "fixture", sourceCkgHash, snapshot: ccm.snapshot, nodes, edges, features, frameworks: ["Laravel"], limitations: [] },
    sourceCkgHash,
  };
}

test("ADD lists a consumer only for a proven call matching the declared method and path", () => {
  const input = fixture();
  input.semantic.nodes.push(node("step:submit", "step", "Submit book", "feature:catalog"));
  input.semantic.edges.push(edge("e:submit", "step:submit", "route:create-book", "GET /books"));
  const consumers = () => {
    const model = buildAddBaseline(input);
    return baselineCatalogMappings(model)("consumer", model.catalogs.interfaces[0]!.elementId);
  };
  assert.equal(consumers(), "");
  input.semantic.edges.push(edge("e:submit-matching", "step:submit", "route:create-book", "POST /books", "indicated"));
  assert.equal(consumers(), "");
  input.semantic.edges.push(edge("e:submit-proven", "step:submit", "route:create-book", "POST /books"));
  assert.notEqual(consumers(), "");
});

test("ADD projection produces distinct baseline views and source-backed ArchiMate relationships", () => {
  const input = fixture();
  const model = buildAddBaseline(input);
  const byId = new Map(model.elements.map(item => [item.id, item]));
  const pair = (type: string, sourceType: string, targetType: string) => model.relationships.some(relation => relation.type === type && byId.get(relation.sourceId)?.type === sourceType && byId.get(relation.targetId)?.type === targetType);

  assert.equal(model.schemaVersion, "sage-add-baseline-v1");
  assert.equal(model.snapshot.commitSha, input.ccm.snapshot.commitSha);
  assert.ok(model.catalogs.interfaces.some(row => row.protocol === "HTTP" && row.contract === "POST /books"), "HTTP methods belong in the contract and the protocol is HTTP");
  assert.ok(pair("AssignmentRelationship", "ApplicationComponent", "ApplicationFunction"));
  assert.ok(pair("CompositionRelationship", "ApplicationComponent", "ApplicationInterface"));
  assert.ok(pair("RealizationRelationship", "ApplicationFunction", "ApplicationService"));
  assert.ok(pair("TriggeringRelationship", "ApplicationInterface", "ApplicationFunction"));
  assert.ok(pair("AssignmentRelationship", "ApplicationInterface", "ApplicationService"));
  assert.ok(pair("AccessRelationship", "ApplicationFunction", "DataObject"));
  assert.ok(pair("AssociationRelationship", "DataObject", "DataObject"));
  assert.ok(!model.relationships.some(relation => relation.type === "ServingRelationship"), "feature grouping does not claim that a runtime interface serves a consumer");
  assert.ok(!model.relationships.some(relation => relation.type === "CompositionRelationship" && byId.get(relation.targetId)?.type === "DataObject"));
  assert.ok(!model.elements.some(item => item.name === "API client"), "semantic actors stay outside the Data/Application baseline scope");
  assert.ok(model.views.dataStructure.relationshipIds.some(id => model.relationships.find(relation => relation.id === id)?.type === "AssociationRelationship"));
  assert.ok(model.views.applicationCooperation.relationshipIds.length > 0);
  assert.ok(model.relationships.every(relation => relation.evidence.length > 0 && relation.reason.length > 0));
  assert.equal(model.catalogs.applicationPortfolio.length, 0, "the repository scope node is metadata, not an extracted application portfolio item");
  const markdown = createAddMarkdown(model, emptyAddReviewOverlay(), span => `https://github.com/sample/library/blob/${input.ccm.snapshot.commitSha}/${span.filePath}`);
  assert.doesNotMatch(markdown, /System-level scope represented by the analyzed repository snapshot|No source evidence/u, "the generated application portfolio omits the metadata-only repository scope node");
  assert.equal(isAddBaselineModel(model), true);
  const invalid = structuredClone(model);
  const repositoryScopeId = invalid.elements.find(item => item.type === "ApplicationComponent")!.id;
  invalid.relationships.push({ ...invalid.relationships[0]!, id: "invalid-pair", type: "AccessRelationship", sourceId: repositoryScopeId, targetId: invalid.catalogs.dataEntities[0]!.elementId });
  assert.equal(isAddBaselineModel(invalid), false, "the validator rejects a relationship outside the supported ArchiMate profile");
});

test("CRUD matrix includes only evidenced accesses and does not turn absence into No", () => {
  const model = buildAddBaseline(fixture());
  const byId = new Map(model.elements.map(item => [item.id, item]));
  assert.equal(model.matrices.applicationData.length, 1, "unaccessed entity does not produce a fake application-data row");
  const row = model.matrices.applicationData[0]!;
  assert.equal(byId.get(row.dataId)?.name, "Book");
  assert.equal(row.create, "yes");
  assert.equal(row.read, "unknown");
  assert.equal(row.update, "unknown");
  assert.equal(row.delete, "unknown");
  assert.ok(row.evidence.length > 0);
  assert.ok(model.matrices.applicationInteractions.length === 0, "internal calls are not application integrations");
});

test("indicated backend access remains unknown in the CRUD matrix", () => {
  const input = fixture();
  input.semantic.edges.find(item => item.id === "e:controller-store")!.confidence = "indicated";
  const model = buildAddBaseline(input);
  const row = model.matrices.applicationData[0]!;
  assert.equal(row.create, "unknown", "an unresolved ORM binding cannot become confirmed CRUD");
  assert.ok(model.relationships.some(item => item.confidence === "indicated" && item.type === "AccessRelationship"), "the indicated source evidence remains visible for review");
});

test("ADD projection is deterministic and rejects mixed snapshot identities", () => {
  const input = fixture();
  assert.deepEqual(buildAddBaseline(input), buildAddBaseline(input));
  const mismatched = { ...input, semantic: { ...input.semantic, snapshot: { ...input.semantic.snapshot, commitSha: "e".repeat(40) } } };
  assert.throws(() => buildAddBaseline(mismatched), /snapshot mismatch/u);
  assert.throws(() => buildAddBaseline({ ...input, sourceCkgHash: "invalid" }), /snapshot mismatch/u);
});

test("optional LLM can rewrite bounded baseline and diagram narratives without changing facts", async () => {
  const model = buildAddBaseline(fixture());
  let sentBody = "";
  const result = await enrichAddNarrative({ model, env: { LLM_BASE_URL: "https://llm.test/v1", LLM_API_KEY: "test-key", LLM_MODEL: "test-model" },
    fetcher: async (_input, init) => {
      sentBody = String(init?.body ?? "");
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        dataBaseline: "Reviewed data narrative.", applicationBaseline: "Reviewed application narrative.",
        dataViewIntroduction: "Reviewed data introduction.", dataViewInterpretation: "Reviewed data interpretation.",
        applicationViewIntroduction: "Reviewed application introduction.", applicationViewInterpretation: "Reviewed application interpretation.",
      }) } }] }), { status: 200 });
    } });
  assert.equal(result.outcome, "used");
  assert.equal(result.model.narratives.dataBaseline, "Reviewed data narrative.");
  assert.equal(result.model.narratives.applicationBaseline, "Reviewed application narrative.");
  assert.equal(result.model.narratives.dataViewIntroduction, "Reviewed data introduction.");
  assert.equal(result.model.narratives.dataViewInterpretation, "Reviewed data interpretation.");
  assert.equal(result.model.narratives.applicationViewIntroduction, "Reviewed application introduction.");
  assert.equal(result.model.narratives.applicationViewInterpretation, "Reviewed application interpretation.");
  assert.deepEqual(result.model.elements, model.elements, "LLM output cannot add or edit architecture facts");
  assert.deepEqual(result.model.relationships, model.relationships);
  assert.ok(sentBody.includes("BookController@store"));
  assert.ok(!sentBody.includes("source bytes"));

  const before = structuredClone(model);
  const invalid = await enrichAddNarrative({ model, env: { LLM_BASE_URL: "https://llm.test/v1", LLM_API_KEY: "test-key", LLM_MODEL: "test-model" },
    fetcher: async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ dataBaseline: "Invented", applicationBaseline: "Narrative", elements: [] }) } }] }), { status: 200 }) });
  assert.equal(invalid.outcome, "unavailable");
  assert.deepEqual(invalid.model, before);
});

test("OpenAPI interface labels retain literal paths and SQL foreign keys respect schema identity", () => {
  const openApi = new TextEncoder().encode(JSON.stringify({ openapi: "3.0.0", paths: { "/v1/books/{book_id}": { get: { operationId: "getBook" } } } }));
  const sql = new TextEncoder().encode([
    "CREATE TABLE a.users (id integer PRIMARY KEY);",
    "CREATE TABLE b.users (id integer PRIMARY KEY);",
    "CREATE TABLE b.orders (user_id integer REFERENCES b.users(id));",
    "CREATE TABLE public.events (user_id integer REFERENCES users(id));",
  ].join("\n"));
  const fragment = extractDataArtifacts({ ccm: {} as CcmV1, sourceCkgHash: "f".repeat(64), sources: { "openapi.json": openApi, "schema.sql": sql } });
  const route = fragment.nodes.find(item => item.kind === "component" && item.label.includes("/v1/books/"));
  assert.equal(route?.label, "GET /v1/books/{book_id}");
  const users = fragment.nodes.filter(item => item.kind === "store" && item.label.toLocaleLowerCase() === "users");
  const orders = fragment.nodes.find(item => item.kind === "store" && item.label.toLocaleLowerCase() === "orders");
  const qualified = fragment.edges.filter(item => item.source === orders?.id);
  assert.equal(users.length, 2);
  assert.equal(qualified.length, 1, "only the schema-qualified FK is represented");
  assert.equal(qualified[0]?.target, users.find(item => item.evidence[0]?.filePath === "schema.sql" && item.evidence[0]?.startLine === 2)?.id);
  assert.ok(!fragment.edges.some(item => item.source === fragment.nodes.find(node => node.label.toLocaleLowerCase() === "events")?.id), "ambiguous unqualified reference is omitted");
});

test("OpenAPI YAML exits path scope at root extensions and JSON Schema paths are not treated as an API", () => {
  const yaml = new TextEncoder().encode([
    'openapi: "3.0.0"',
    "paths:",
    "  /real:",
    "    get:",
    "      responses: {}",
    "x-example:",
    "  /fake:",
    "    post:",
    "      summary: This is example data, not an endpoint",
    "x-schema-example:",
    "  schemas:",
    "    Fake:",
    "      type: object",
    "components:",
    "  schemas:",
    "    Book:",
    "      type: object",
  ].join("\n"));
  const jsonSchema = new TextEncoder().encode(JSON.stringify({ $schema: "https://json-schema.org/draft/2020-12/schema", paths: { "/not-an-api": { post: {} } }, definitions: { Book: { type: "object" } } }));
  const fragment = extractDataArtifacts({ ccm: {} as CcmV1, sourceCkgHash: "f".repeat(64), sources: { "openapi.yaml": yaml, "schema.json": jsonSchema } });
  assert.deepEqual(fragment.nodes.filter(item => item.kind === "component").map(item => item.label), ["GET /real"]);
  assert.equal(fragment.nodes.filter(item => item.kind === "store" && item.label === "Book").length, 2, "OpenAPI and JSON Schema declarations remain cataloged");
  assert.ok(!fragment.nodes.some(item => item.kind === "store" && item.label === "Fake"), "schemas outside components.schemas are ignored");
});

test("SQL string contents do not become DDL facts while quoted identifiers remain readable", () => {
  const sql = new TextEncoder().encode([
    "SELECT 'CREATE TABLE fake(id int)';",
    "CREATE TABLE \"public\".\"users\" (\"id\" integer PRIMARY KEY);",
    "CREATE TABLE \"public\".\"orders\" (\"user_id\" integer REFERENCES \"public\".\"users\"(\"id\"), note text DEFAULT 'REFERENCES public.fake(id)');",
  ].join("\n"));
  const fragment = extractDataArtifacts({ ccm: {} as CcmV1, sourceCkgHash: "f".repeat(64), sources: { "schema.sql": sql } });
  const names = fragment.nodes.map(node => node.label.toLocaleLowerCase());
  assert.deepEqual(names.sort(), ["orders", "users"]);
  assert.equal(fragment.edges.length, 1, "the real FK is kept and references embedded in DEFAULT strings are ignored");
  assert.equal(fragment.edges[0]?.target, fragment.nodes.find(node => node.label.toLocaleLowerCase() === "users")?.id);
});

test("Markdown exports render source labels and narratives inertly and encode evidence URL parentheses", () => {
  const input = fixture();
  const model = buildAddBaseline(input);
  const evidencedEntity = model.elements.find(element => element.type === "DataObject" && element.name === "Book")!;
  evidencedEntity.name = '<img src=x onerror="alert(1)"> ![x](javascript:alert(1)) `*_##';
  model.narratives.dataBaseline = '<script>alert("x")</script> ![open](https://evil.test)';
  model.limitations.push("<svg onload=alert(1)> [click](javascript:alert(1))");
  evidencedEntity.evidence = [{ ...evidence, filePath: "api/(hostile).ts" }];
  const markdown = createAddMarkdown(model, emptyAddReviewOverlay(), span => `https://github.com/sample/library/blob/${input.ccm.snapshot.commitSha}/${span.filePath}#L${span.startLine}`);
  assert.ok(markdown.includes("&lt;img"));
  assert.ok(markdown.includes("&lt;script&gt;"));
  assert.ok(markdown.includes("&#33;&#91;x&#93;"));
  assert.ok(!markdown.includes("<img"));
  assert.ok(!markdown.includes("<script"));
  assert.ok(!markdown.includes("![open]"));
  assert.ok(!markdown.includes("[click](javascript:"));
  assert.ok(markdown.includes("api/%28hostile%29.ts"));
});

test("LLM request and response bodies remain within explicit byte caps", async () => {
  const model = buildAddBaseline(fixture());
  const huge = structuredClone(model);
  huge.elements = Array.from({ length: 1000 }, (_, index) => ({ ...model.elements[0]!, id: `element-${index}`, name: `Entity-${index}-${"x".repeat(500)}` }));
  let sentBytes = 0;
  const boundedRequest = await enrichAddNarrative({ model: huge, env: { LLM_BASE_URL: "https://llm.test/v1", LLM_API_KEY: "test-key", LLM_MODEL: "test-model" },
    fetcher: async (_input, init) => {
      sentBytes = Buffer.byteLength(String(init?.body ?? ""), "utf8");
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        dataBaseline: "Bounded", applicationBaseline: "Bounded", dataViewIntroduction: "Bounded",
        dataViewInterpretation: "bounded", applicationViewIntroduction: "Bounded", applicationViewInterpretation: "bounded",
      }) } }] }), { status: 200 });
    } });
  assert.equal(boundedRequest.outcome, "used");
  assert.ok(sentBytes <= 32 * 1024);

  const oversizedResponse = await enrichAddNarrative({ model, env: { LLM_BASE_URL: "https://llm.test/v1", LLM_API_KEY: "test-key", LLM_MODEL: "test-model" },
    fetcher: async () => new Response(JSON.stringify({ choices: [{ message: { content: "x".repeat(20 * 1024) } }] }), { status: 200 }) });
  assert.equal(oversizedResponse.outcome, "unavailable");
  assert.deepEqual(oversizedResponse.model, model, "oversized provider output falls back to deterministic narratives");
});
