import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { CcmV1 } from "@sage/contracts";
import { buildAddBaseline, isAddBaselineModel } from "../packages/documents/src/baseline-add.ts";
import { extractDataArtifacts } from "../packages/documents/src/semantic/data-artifacts.ts";
import { buildSemanticModel } from "../packages/documents/src/semantic/build.ts";
import { extractDockerCompose } from "../packages/documents/src/semantic/docker-compose.ts";
import { isSemanticModel } from "../packages/documents/src/semantic/validation.ts";
import type { SemanticInput } from "../packages/documents/src/semantic/model.ts";

const sourceCkgHash = "a".repeat(64);
const commitSha = "b".repeat(40);
const compose = `services:
  web:
    build:
      context: .
    restart: unless-stopped
    ports:
      - "3000:3000"
    environment:
      NLP_SERVICE_URL: "http://nlp:8000/nlp/analyze-feedback"
    depends_on:
      - nlp
  nlp:
    build: ./nlp
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "python", "-c", "print('ok')"]
  db:
    image: postgres:16
  migrate:
    build: ./database
    restart: "no"
    command: ["python", "migrate.py"]
`;
const appSource = `export async function analyzeFeedback(text: string) {
  const url = process.env.NLP_SERVICE_URL;
  return fetch(url, { method: "POST", body: JSON.stringify({ text }) });
}
`;
const routeSource = `export async function POST(request: Request) {
  const input = await request.json();
  return Response.json(await analyzeFeedback(input.text));
}
`;
const feedbackStore = `import { database } from "./db";
const COLUMNS = "id_feedback, judul_feedback, isi_feedback";
export async function listFeedback() {
  return database().query(\`select \${COLUMNS} from feedback_stakeholder order by created_at desc\`);
}
export async function createFeedback() {
  return database().query("insert into feedback_stakeholder(id_feedback) values ($1)");
}
export async function updateFeedback() {
  return database().query("update feedback_stakeholder set isi_feedback = $1 where id_feedback = $2");
}
export async function deleteFeedback() {
  return database().query("delete from feedback_stakeholder where id_feedback = $1");
}
export async function saveWithOptimisticLock() {
  return database().query("with eligible as (" +
    " select id_feedback from feedback_stakeholder where id_feedback = $1 for update of feedback_stakeholder" +
    ") select extract(epoch from f.updated_at)::text from feedback_stakeholder f join eligible e using (id_feedback)");
}
export async function upsertFeedback() {
  return database().query("insert into feedback_stakeholder(id_feedback) values ($1) on conflict (id_feedback) do update set isi_feedback = excluded.isi_feedback");
}
`;
const databaseBinding = `import { Pool } from "pg";
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
export function database() { return pool; }
`;
const schema = `create table feedback_stakeholder (
  id_feedback uuid primary key,
  isi_feedback text not null
);
`;
const pythonSource = `from fastapi import FastAPI
app = FastAPI()
@app.get("/health")
def health():
    return {"ok": True}
`;

function semanticInput(overrides: Record<string, string> = {}): SemanticInput {
  const sources = {
    "compose.yaml": compose,
    "src/lib/nlp.ts": appSource,
    "src/lib/server/db.ts": databaseBinding,
    "src/lib/server/feedback-store.ts": feedbackStore,
    "src/app/api/feedback/route.ts": routeSource,
    "nlp/main.py": pythonSource,
    "db/migrations/001_schema.sql": schema,
    ...overrides,
  };
  const encoded = Object.fromEntries(Object.entries(sources).map(([path, text]) => [path, new TextEncoder().encode(text)]));
  const ccm = {
    schemaVersion: 1,
    snapshot: { repository: "AgilePemdigi-2026/ReqFlow", branch: "main", commitSha },
    provenance: { analyzer: { name: "fixture", version: "1" }, resolver: { name: "fixture", version: "1" }, configHash: "c".repeat(64) },
    files: Object.entries(encoded).map(([path, bytes]) => ({ path, language: path.endsWith(".py") ? "python" : "typescript", sha256: createHash("sha256").update(bytes).digest("hex"), sizeBytes: bytes.byteLength, status: "processed" })),
    nodes: [], edges: [], limitations: [],
  } as unknown as CcmV1;
  return { ccm, sourceCkgHash, sources: encoded, documentationSources: encoded, snapshotPaths: Object.keys(encoded) };
}

test("Compose extracts build-backed services and only a statically matched HTTP integration", () => {
  const input = semanticInput();
  const fragment = extractDockerCompose(input);
  assert.deepEqual(fragment.nodes.map(node => node.label).sort(), ["NLP", "Web"]);
  assert.equal(fragment.edges.length, 1);
  const link = fragment.edges[0]!;
  assert.equal(link.confidence, "proven");
  assert.match(link.label, /NLP_SERVICE_URL/u);
  assert.equal(link.evidence.find(span => span.filePath === "compose.yaml")?.startLine, 9);
  assert.ok(link.evidence.some(span => span.filePath === "src/lib/nlp.ts"));
  assert.ok(!fragment.nodes.some(node => /database|postgres|migrate/iu.test(node.label)), "database image and one-shot migration job are not application components");

  const withoutHttpCall = extractDockerCompose(semanticInput({ "src/lib/nlp.ts": "export const endpoint = process.env.NLP_SERVICE_URL;\n" }));
  assert.equal(withoutHttpCall.edges.length, 0, "an env var alone does not prove an HTTP integration");
});

test("Compose and source evidence flow into the ADD portfolio, cooperation view, and interaction matrix", () => {
  const input = semanticInput();
  const semantic = buildSemanticModel(input);
  const add = buildAddBaseline({ ccm: input.ccm, semantic, sourceCkgHash });
  assert.equal(isSemanticModel(semantic), true, "the canonical semantic validator accepts typed CRUD metadata");
  assert.equal(isAddBaselineModel(add), true, "the ADD validator accepts typed CRUD relationships");
  const components = add.catalogs.applicationPortfolio.map(row => add.elements.find(element => element.id === row.elementId)!);
  assert.deepEqual(components.map(component => component.name).sort(), ["NLP", "Web"], "only source-backed Compose services belong in the application portfolio");
  assert.ok(add.views.applicationCooperation.elementIds.some(id => add.elements.find(element => element.id === id)?.name === "ReqFlow"), "repository scope may remain as diagram context without masquerading as an extracted application");
  assert.equal(add.matrices.applicationInteractions.length, 1);
  const interaction = add.matrices.applicationInteractions[0]!;
  assert.equal(components.find(component => component.id === interaction.sourceApplicationId)?.name, "Web");
  assert.equal(components.find(component => component.id === interaction.targetApplicationId)?.name, "NLP");
  assert.match(interaction.mechanism, /HTTP request/u);
  assert.ok(interaction.evidence.some(span => span.filePath === "compose.yaml"));
  assert.ok(add.views.applicationCooperation.relationshipIds.some(id => add.relationships.find(edge => edge.id === id)?.type === "FlowRelationship"));
  assert.match(add.narratives.applicationViewInterpretation ?? "", /does not prove|tidak membuktikan/iu);
});

test("repository scope stays in view context while Application and NLP remain portfolio entries", () => {
  const input = semanticInput({ "compose.yaml": compose.replace("  web:\n", "  app:\n") });
  const semantic = buildSemanticModel(input);
  const add = buildAddBaseline({ ccm: input.ccm, semantic, sourceCkgHash });
  const names = add.catalogs.applicationPortfolio.map(row => add.elements.find(element => element.id === row.elementId)!.name);
  assert.deepEqual(names.sort(), ["Application", "NLP"]);
  assert.equal(add.elements.find(element => element.name === "ReqFlow")?.type, "ApplicationComponent");
  assert.equal(add.elements.find(element => element.name === "Application")?.type, "ApplicationComponent");
  assert.equal(add.elements.find(element => element.name === "NLP")?.type, "ApplicationComponent");
});

test("CRUD matrix derives all operations from backend SQL and assigns them to the owning Compose service", () => {
  const input = semanticInput();
  const semantic = buildSemanticModel(input);
  const add = buildAddBaseline({ ccm: input.ccm, semantic, sourceCkgHash });
  const apps = new Map(add.catalogs.applicationPortfolio.map(row => [row.elementId, add.elements.find(element => element.id === row.elementId)!.name]));
  const feedbackRows = add.matrices.applicationData.filter(row => add.elements.find(element => element.id === row.dataId)?.name.toLowerCase() === "feedback stakeholder");
  assert.deepEqual(feedbackRows.map(row => apps.get(row.applicationId)), ["Web"]);
  assert.equal(feedbackRows[0]!.create, "yes");
  assert.equal(feedbackRows[0]!.read, "yes");
  assert.equal(feedbackRows[0]!.update, "yes");
  assert.equal(feedbackRows[0]!.delete, "yes");
  const crudEdges = semantic.edges.filter(edge => edge.target && feedbackRows[0]!.evidence.some(span => span.filePath === "db/migrations/001_schema.sql") && edge.dataOperation);
  assert.deepEqual(new Set(crudEdges.map(edge => edge.dataOperation)), new Set(["create", "read", "update", "delete", "upsert"]));
  assert.ok(crudEdges.every(edge => edge.confidence === "proven" && edge.evidence.some(span => span.filePath.endsWith("/db.ts"))),
    "confirmed CRUD carries explicit operation metadata and driver-binding evidence");
  assert.ok(!semantic.limitations.some(item => /Static SQL (?:reads|updates) references (?:eligible|updated_at|of|set)/iu.test(item.reason)),
    "CTE aliases, column expressions, lock clauses, and upsert syntax are not misread as table names");
});

test("CRUD ownership follows the backend operation source when schema evidence belongs to another build context", () => {
  const input = semanticInput({
    "compose.yaml": `services:
  web:
    build:
      context: .
    restart: unless-stopped
  api:
    build:
      context: ./api
    restart: unless-stopped
`,
    "db/migrations/001_schema.sql": `create table feedback_stakeholder (id_feedback uuid primary key);`,
    "api/server/feedback.ts": `import { Pool } from "pg";
const pool = new Pool();
export async function removeFeedback() { return pool.query("delete from feedback_stakeholder"); }`,
  });
  const semantic = buildSemanticModel(input);
  const add = buildAddBaseline({ ccm: input.ccm, semantic, sourceCkgHash });
  const apiRow = add.matrices.applicationData.find(item =>
    add.elements.find(element => element.id === item.dataId)?.name.toLowerCase() === "feedback stakeholder" &&
    add.elements.find(element => element.id === item.applicationId)?.name === "API");
  assert.ok(apiRow, "the nested API build context receives its own CRUD matrix row");
  assert.equal(apiRow.delete, "yes");
  assert.ok(apiRow.evidence.some(span => span.filePath === "api/server/feedback.ts"));
  assert.ok(!apiRow.evidence.some(span => span.filePath === "src/lib/server/feedback-store.ts"),
    "CRUD ownership and evidence are derived from each backend operation source, not mixed with other service evidence");
});

test("static SQL CRUD ignores client-side query lookalikes and records file-scoped server evidence", () => {
  const input = semanticInput({
    "src/components/ClientWidget.tsx": `\"use client\"; export async function click() { return database.query(\"delete from feedback_stakeholder\"); }`,
    "src/lib/server/dynamic-store.ts": "export async function remove(table: string) { return database().query(`delete from ${table}`); }",
    "src/lib/server/query-constants.ts": `export const TABLE = "feedback_stakeholder"; export const QUERY = \`select id_feedback from \${TABLE}\`;`,
    "src/lib/server/imported-query.ts": `import { QUERY } from "./query-constants"; import { database } from "./db"; export async function list() { return database().query(QUERY); }`,
    "src/lib/server/shadowed-query.ts": `import { QUERY } from "./query-constants"; import { database } from "./db"; export async function list(QUERY: string) { return database().query(QUERY); }`,
    "src/lib/server/reassigned-query.ts": `import { database } from "./db"; export async function remove() { let SQL = "delete from feedback_stakeholder"; SQL = "select 1"; return database().query(SQL); }`,
  });
  const semantic = buildSemanticModel(input);
  const add = buildAddBaseline({ ccm: input.ccm, semantic, sourceCkgHash });
  const row = add.matrices.applicationData.find(item => add.elements.find(element => element.id === item.dataId)?.name.toLowerCase() === "feedback stakeholder")!;
  assert.equal(row.delete, "yes", "server-side DELETE remains source-backed");
  assert.ok(row.evidence.some(span => span.filePath.includes("/server/")) && row.evidence.some(span => span.filePath.endsWith(".sql")), "CRUD evidence cites both the backend query and the matching schema declaration");
  assert.ok(!row.evidence.some(span => span.filePath.includes("ClientWidget")), "frontend source is excluded from the CRUD evidence register");
  assert.ok(!semantic.edges.some(edge => edge.evidence.some(span => span.filePath.includes("ClientWidget"))), "client-side query text is not CRUD evidence");
  assert.ok(!semantic.edges.some(edge => edge.evidence.some(span => span.filePath.includes("dynamic-store"))), "dynamic SQL is not asserted as a CRUD fact");
  assert.ok(semantic.limitations.some(item => item.filePath.includes("dynamic-store") && /does not resolve|dynamic SQL/u.test(item.reason)), "dynamic backend SQL remains visible as an explicit analyzer limitation");
  assert.ok(semantic.edges.some(edge => edge.label.toLowerCase() === "reads feedback stakeholder" && edge.evidence.some(span => span.filePath.includes("imported-query"))), `literal SQL constants are resolved across local backend imports: ${JSON.stringify(semantic.edges.filter(edge => edge.evidence.some(span => span.filePath.includes("imported-query"))))}`);
  assert.ok(semantic.edges.some(edge => edge.dataOperation === "read" && edge.evidence.some(span => span.filePath.includes("imported-query"))));
  assert.ok(semantic.edges.some(edge => edge.dataOperation === "read" && edge.evidence.some(span => span.filePath.endsWith("query-constants.ts"))),
    "the evidence register cites the imported declaration that contains the SQL text");
  assert.ok(!semantic.edges.some(edge => edge.dataOperation === "delete" && edge.evidence.some(span => span.filePath.includes("shadowed-query"))),
    "a function parameter that shadows an imported SQL constant is not mistaken for the constant");
  assert.ok(!semantic.edges.some(edge => edge.evidence.some(span => span.filePath.includes("reassigned-query"))),
    "a mutable SQL variable is not treated as an immutable query constant");
  const unverified = semanticInput({ "src/lib/server/unverified-query.ts": `export async function removeAnything() { return event.query("delete from feedback_stakeholder"); }` });
  const unverifiedSemantic = buildSemanticModel(unverified);
  assert.ok(!unverifiedSemantic.edges.some(edge => edge.dataOperation === "delete" && edge.evidence.some(span => span.filePath.includes("unverified-query"))),
    "a method named query without a verified database client is not a CRUD fact");
  assert.ok(unverifiedSemantic.limitations.some(item => item.filePath.includes("unverified-query") && /node-postgres/u.test(item.reason)));
});

test("SQL CRUD lexer ignores quoted text, EXPLAIN, CTE aliases, and schema-mismatched tables", () => {
  const input = semanticInput({
    "src/lib/server/sql-lexing.ts": `import { Pool } from "pg";
const pool = new Pool();
export async function inspect() {
  await pool.query("SELECT $$DELETE FROM feedback_stakeholder$$");
  await pool.query("SELECT 1 AS \\"DELETE FROM feedback_stakeholder\\"");
  await pool.query("SELECT E'text\\\\' DELETE FROM feedback_stakeholder; '");
  await pool.query("EXPLAIN DELETE FROM feedback_stakeholder");
  await pool.query("WITH feedback_stakeholder AS (SELECT 1) SELECT * FROM feedback_stakeholder");
  await pool.query("DELETE FROM archive.feedback_stakeholder");
  await pool.query("INSERT INTO feedback_stakeholder(id_feedback) VALUES (1); INSERT INTO audit_log(id) VALUES (2) ON CONFLICT(id) DO UPDATE SET id=2");
  await pool.query("INSERT INTO feedback_stakeholder(id_feedback) VALUES (1) ON CONFLICT(id_feedback) DO UPDATE SET id_feedback=excluded.id_feedback");
}
export async function unreachable() {
  return null;
  await pool.query("DELETE FROM feedback_stakeholder");
}`,
  });
  const semantic = buildSemanticModel(input);
  const sqlEdges = semantic.edges.filter(edge => edge.dataOperation && edge.evidence.some(span => span.filePath.endsWith("sql-lexing.ts")));
  assert.deepEqual(new Set(sqlEdges.map(edge => edge.dataOperation)), new Set(["create", "upsert"]));
  assert.equal(sqlEdges.filter(edge => edge.dataOperation === "update").length, 0, "upsert is represented as upsert and cannot be attributed to another statement's INSERT");
  assert.equal(sqlEdges.filter(edge => edge.dataOperation === "delete").length, 0, "quoted text, EXPLAIN, and a different schema do not create DELETE evidence");
  assert.equal(sqlEdges.filter(edge => edge.dataOperation === "read").length, 0, "a CTE alias is not resolved to a physical table with the same name");
  assert.ok(semantic.limitations.some(item => item.filePath.endsWith("sql-lexing.ts") && /archive\.feedback_stakeholder/u.test(item.reason)),
    "schema-qualified operations that do not match the schema snapshot remain explicit limitations");
  assert.ok(semantic.limitations.some(item => item.filePath.endsWith("sql-lexing.ts") && /unreachable \.query\(\)/u.test(item.reason)),
    "source code after an unconditional return is explicitly excluded");
});

test("SQL CRUD preserves quoted table identity and requires a matching schema", () => {
  const input = semanticInput({
    "db/migrations/002_case_sensitive.sql": `CREATE TABLE public."CaseSensitive" (id integer primary key);`,
    "src/lib/server/case-sensitive.ts": `import { Pool } from "pg";
const pool = new Pool();
export async function remove() {
  await pool.query("DELETE FROM archive.\\"CaseSensitive\\"");
  await pool.query("DELETE FROM public.\\"CaseSensitive\\"");
  await pool.query("DELETE FROM public.casesensitive");
}`,
  });
  const semantic = buildSemanticModel(input);
  const matches = semantic.edges.filter(edge => edge.dataOperation === "delete" && edge.evidence.some(span => span.filePath.endsWith("case-sensitive.ts")) &&
    edge.target === semantic.nodes.find(node => node.kind === "store" && node.dataIdentity?.name === "CaseSensitive")?.id);
  assert.equal(matches.length, 1, "only the exact quoted schema and table identity produce a CRUD edge");
});

test("SQL CRUD requires an unshadowed immutable pg binding and excludes client-reachable helpers", () => {
  const input = semanticInput({
    "src/lib/server/bindings.ts": `import { Pool, type PoolClient } from "pg";
const pool = new Pool();
let mutablePool: any = new Pool();
mutablePool = { query: () => null };
export const exportedPool = new Pool();
export const getPool = () => new Pool();
export async function shadowedClass(Pool: any) { return new Pool().query("delete from feedback_stakeholder"); }
export async function shadowedPool(pool: any) { return pool.query("delete from feedback_stakeholder"); }
export async function nestedShadow(pool: Pool) { { const pool = { query(text: string) { return text; } }; return pool.query("delete from feedback_stakeholder"); } }
export async function nestedDestructuredShadow(db: Pool) { { const { db } = { db: { query(text: string) { return text; } } }; return db.query("delete from feedback_stakeholder"); } }
export async function nestedDestructuredParameter(db: Pool) { const run = ({ db }: { db: { query(text: string): string } }) => db.query("delete from feedback_stakeholder"); return run({ db: { query: text => text } }); }
export async function mutable() { return mutablePool.query("delete from feedback_stakeholder"); }
export async function parameter(client: PoolClient) { return client.query("delete from feedback_stakeholder"); }
export async function stable() { return pool.query("delete from feedback_stakeholder"); }
export async function exported() { return exportedPool.query("delete from feedback_stakeholder"); }
export async function factory() { return getPool().query("delete from feedback_stakeholder"); }
`,
    "src/lib/server/types.d.ts": `import { Pool } from "pg"; export declare const QueryText: string;`,
    "src/app/page.tsx": `"use client"; import { remove } from "../services/client-store"; export default function Page() { return null; }`,
    "src/services/client-store.ts": `import { Pool } from "pg"; const pool = new Pool(); export async function remove() { return pool.query("delete from feedback_stakeholder"); }`,
  });
  const semantic = buildSemanticModel(input);
  const bindings = semantic.edges.filter(edge => edge.dataOperation === "delete" && edge.evidence.some(span => span.filePath.endsWith("bindings.ts")));
  assert.equal(bindings.length, 4, "typed PoolClient, module const, exported const, and expression-bodied factory bindings are accepted");
  assert.ok(bindings.some(edge => edge.evidence.some(span => span.startLine > 0)));
  assert.ok(!semantic.edges.some(edge => edge.dataOperation === "delete" && edge.evidence.some(span => span.filePath.endsWith("client-store.ts"))),
    "a helper reachable from a use-client root is not trusted as backend CRUD evidence");
  assert.ok(!semantic.edges.some(edge => edge.dataOperation === "delete" && edge.evidence.some(span => span.filePath.endsWith("bindings.ts") && [7, 8, 9].includes(span.startLine))),
    "shadowed and mutable database bindings do not produce proven CRUD edges");
});

test("an imported database factory is not trusted when a local parameter shadows its name", () => {
  const input = semanticInput({
    "src/lib/server/db.ts": `import { Pool } from "pg";
const pool = new Pool();
export function database() { return pool; }
`,
    "src/lib/server/shadowed-factory.ts": `import { database } from "./db";
export function remove(database: () => { query(text: string): unknown }) {
  return database().query("delete from feedback_stakeholder");
}
`,
    "src/lib/server/shadowed-function.ts": `import { database } from "./db";
export function remove() {
  function database() { return { query(text: string) { return text; } }; }
  return database().query("delete from feedback_stakeholder");
}
`,
    "src/lib/server/real-factory.ts": `import { database } from "./db";
export function remove() {
  return database().query("delete from feedback_stakeholder");
}
`,
  });
  const semantic = buildSemanticModel(input);
  assert.ok(!semantic.edges.some(edge => edge.dataOperation === "delete" && edge.evidence.some(span => span.filePath.endsWith("shadowed-factory.ts"))),
    "a parameter named like an imported database factory cannot inherit that import's Pool evidence");
  assert.ok(!semantic.edges.some(edge => edge.dataOperation === "delete" && edge.evidence.some(span => span.filePath.endsWith("shadowed-function.ts"))),
    "a nested function named like an imported database factory cannot inherit that import's Pool evidence");
  assert.ok(semantic.edges.some(edge => edge.dataOperation === "delete" && edge.evidence.some(span => span.filePath.endsWith("real-factory.ts"))),
    "the unshadowed imported database factory still produces backend CRUD evidence");
  for (const path of ["shadowed-factory.ts", "shadowed-function.ts"]) {
    assert.ok(semantic.limitations.some(item => item.filePath.endsWith(path) && /could not be tied to a locally verified node-postgres/u.test(item.reason)),
      `the unsupported shadowed receiver in ${path} is reported as a limitation`);
  }
});

test("type-only imports from client modules do not suppress backend CRUD reachability", () => {
  const input = semanticInput({
    "src/app/page.tsx": `"use client";
import type { User } from "../services/users";
import { type User as PublicUser } from "../services/users";
export default function Page() { return null; }
`,
    "src/services/users.ts": `import { Pool } from "pg";
const pool = new Pool();
export async function removeUser() { return pool.query("delete from users"); }
`,
    "db/migrations/002_users.sql": `create table users (id integer primary key);`,
  });
  const semantic = buildSemanticModel(input);
  const edge = semantic.edges.find(item => item.dataOperation === "delete" && item.evidence.some(span => span.filePath === "src/services/users.ts"));
  assert.ok(edge, "erased type-only imports do not make a server-side service client-reachable");
  assert.equal(edge.confidence, "proven");
});

test("node-postgres connection results remain traceable through an explicit null-recovery catch", () => {
  const input = semanticInput({
    "src/app/api/feedbacks/route.ts": `import { database } from "../../../lib/server/db";
export async function GET() {
  const client = await database().connect().catch(() => null);
  if (!client) return Response.json({}, { status: 503 });
  return client.query("select id_feedback from feedback_stakeholder");
}`,
  });
  const semantic = buildSemanticModel(input);
  const edge = semantic.edges.find(item => item.dataOperation === "read" && item.evidence.some(span => span.filePath.endsWith("/feedbacks/route.ts")));
  assert.ok(edge, "the backend query is tied to a verified pool connection after its null guard");
  assert.ok(edge.evidence.some(span => span.filePath.endsWith("/server/db.ts")));
  assert.ok(edge.evidence.some(span => span.filePath.endsWith("001_schema.sql")));
  assert.equal(edge.confidence, "proven", "proven means statically traced source, not successful runtime execution");
});

test("arbitrary Compose YAML is not reported as a failed OpenAPI contract", () => {
  const input = semanticInput();
  const fragment = extractDataArtifacts(input);
  assert.ok(fragment.limitations.every(item => !/Structured contract file/u.test(item.reason)));
});

test("test and fixture schemas do not become application data entities", () => {
  const input = semanticInput({
    "tests/fixtures/unreleased-schema.sql": "create table fake_private_table (id integer primary key);",
    "src/lib/server/db.ts": databaseBinding,
  });
  const artifacts = extractDataArtifacts(input);
  assert.ok(!artifacts.nodes.some(node => node.label.toLowerCase() === "fake private table"));
});
