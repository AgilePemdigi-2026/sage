import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { CcmV1 } from "@sage/contracts";
import { buildSemanticModel } from "../packages/documents/src/semantic/build.ts";
import { emptyFragment, evidenceSpan, humanLabel } from "../packages/documents/src/semantic/builder.ts";
import { extractNext } from "../packages/documents/src/semantic/next.ts";
import { isSemanticModel } from "../packages/documents/src/semantic/validation.ts";

function input(sources: Record<string, string>) {
  const encoded = Object.fromEntries(Object.entries(sources).map(([path, text]) => [path, new TextEncoder().encode(text)]));
  const ccm = {
    schemaVersion: 1,
    snapshot: { repository: "fixture/perpus", branch: "main", commitSha: "a".repeat(40) },
    provenance: { analyzer: { name: "fixture", version: "1" }, resolver: { name: "fixture", version: "1" }, configHash: "b".repeat(64) },
    files: Object.entries(encoded).map(([path, bytes]) => ({ path, language: path.endsWith(".tsx") ? "typescript" : "typescript", sha256: "c".repeat(64), sizeBytes: bytes.byteLength, status: "processed" })),
    nodes: [], edges: [], limitations: [],
  } as unknown as CcmV1;
  return { ccm, sourceCkgHash: "d".repeat(64), sources: encoded };
}

function pinnedSageSources(paths: string[]): Record<string, string> {
  const root = fileURLToPath(new URL("../artifacts/semantic/corpora/sage/", import.meta.url));
  return Object.fromEntries(paths.map(path => [path, readFileSync(join(root, path), "utf8")]));
}

test("Next.js form and nested UI callback connect only a literal HTTP action to a matching app route", () => {
  const result = extractNext(input({
    "src/app/auth/page.tsx": '<form action="/auth/login" method="post"><button>Masuk</button></form>',
    "src/app/auth/login/route.ts": 'export async function POST() { return Response.json({ ok: true }); }',
    "src/app/api/bookings/bulk/route.ts": 'export async function POST(req: Request) { return Response.json({ ok: true }); }',
    "src/components/cart.tsx": [
      'async function request(path: string, init: RequestInit) { return fetch(path, init); }',
      'async function submitBooking() { return request("/api/bookings/bulk", { method: "POST" }); }',
      'export function Cart() { return <button onClick={() => void submitBooking()}>Kirim peminjaman</button>; }',
    ].join("\n"),
  }));
  const ui = result.nodes.find(node => node.kind === "step" && node.label === "Kirim peminjaman");
  const endpoint = result.nodes.find(node => node.kind === "step" && node.label === "POST /api/bookings/bulk");
  assert.ok(ui && endpoint);
  assert.ok(result.edges.some(edge => edge.source === ui.id && edge.target === endpoint.id && edge.confidence === "proven"));
  assert.ok(result.nodes.some(node => node.kind === "actor" && node.confidence === "indicated"));
  assert.ok(result.features.some(feature => feature.label === "Auth"));
  assert.ok(result.frameworks.includes("Next.js App Router"));
});

test("route guards and direct ORM mutations produce evidenced decisions and storage relationships", () => {
  const result = extractNext(input({
    "src/app/api/loans/route.ts": [
      'export async function POST(req: Request) {',
      '  if (req.user.role !== "admin") return Response.json({ error: "forbidden" }, { status: 403 });',
      '  if (!req.body.bookId) return Response.json({ error: "missing" }, { status: 400 });',
      '  await prisma.loan.create({ data: req.body });',
      '  return Response.json({ ok: true }, { status: 201 });',
      '}',
    ].join("\n"),
  }));
  assert.ok(result.nodes.some(node => node.kind === "actor" && node.label === "Admin" && node.confidence === "proven"));
  assert.ok(result.nodes.some(node => node.kind === "decision" && node.label === "Pemeriksaan peran atau cakupan akses"));
  assert.ok(result.nodes.some(node => node.kind === "decision" && node.label === "Validasi input"));
  assert.ok(result.nodes.some(node => node.kind === "outcome" && node.label === "Permintaan ditolak (403)"));
  assert.ok(result.nodes.some(node => node.kind === "store" && node.label === "Loan"));
  const createEdge = result.edges.find(edge => edge.label === "menyimpan");
  assert.ok(createEdge);
  assert.equal(createEdge.confidence, "indicated");
  assert.match(createEdge.reason, /binding receiver belum diverifikasi/iu);
});

test("database-shaped local objects are never reported as proven ORM access by receiver name alone", () => {
  const result = extractNext(input({
    "src/app/api/books/route.ts": [
      "export async function GET() {",
      "  const db = { books: { findMany() { return [1]; } } };",
      "  return Response.json(db.books.findMany());",
      "}",
    ].join("\n"),
  }));
  const readEdge = result.edges.find(edge => edge.label === "membaca");
  assert.ok(readEdge);
  assert.equal(readEdge.confidence, "indicated");
  assert.match(readEdge.reason, /binding receiver belum diverifikasi/iu);
});

test("Supabase fluent queries classify reads and writes from terminal operations only", () => {
  const result = extractNext(input({
    "src/app/api/books/route.ts": [
      'export async function GET() {',
      '  await supabase.from("books").select("id");',
      '  await supabase.from("books").update({ title: "New" });',
      '  await supabase.from("books").delete();',
      '  supabase.from("categories");',
      '  return Response.json({ ok: true }, { status: 200 });',
      '}',
    ].join("\n"),
  }));
  const storeEdges = result.edges.filter(edge => edge.source === result.nodes.find(node => node.kind === "component" && node.label === "GET API")?.id && ["membaca", "mengubah", "menghapus"].includes(edge.label));
  assert.deepEqual(storeEdges.map(edge => edge.label).sort(), ["membaca", "menghapus", "mengubah"]);
  assert.ok(storeEdges.every(edge => edge.confidence === "indicated"));
  assert.equal(result.nodes.some(node => node.kind === "store" && node.label === "Categories"), false);
});

test("pinned SAGE submission and export adapters resolve their static factory handlers and stage concepts", () => {
  const result = extractNext(input(pinnedSageSources([
    "apps/web/app/api/analyses/route.ts",
    "apps/web/lib/github/submission-handlers.ts",
    "apps/web/app/api/analyses/[analysisId]/exports/route.ts",
    "apps/web/app/api/analyses/[analysisId]/exports/[exportId]/route.ts",
    "apps/web/app/api/analyses/[analysisId]/exports/[exportId]/retry/route.ts",
    "apps/web/app/api/analyses/[analysisId]/exports/[exportId]/download/route.ts",
    "apps/web/lib/exports/server-handlers.ts",
    "apps/web/lib/exports/handlers.ts",
    "packages/contracts/src/stages.ts",
    "apps/web/lib/graphs/reader.ts",
    "scripts/benchmark-repository.ts",
    "scripts/verify-resolver-oracles.ts",
    "scripts/verify-fixtures.ts",
    "scripts/benchmark-resource-workload.ts",
  ])));
  const submission = result.nodes.find(node => node.kind === "component" && node.evidence.some(span => span.filePath === "apps/web/lib/github/submission-handlers.ts"));
  const submissionAuth = result.nodes.find(node => node.kind === "decision" && node.evidence.some(span => span.filePath === "apps/web/lib/github/submission-handlers.ts" && span.startLine === 24));
  const exportStep = result.nodes.find(node => node.kind === "step" && node.label === "POST /api/analyses/:analysisId/exports");
  const exportHandlers = result.nodes.filter(node => node.kind === "component" && node.evidence.some(span => span.filePath === "apps/web/lib/exports/handlers.ts"));
  assert.ok(submission && submissionAuth);
  assert.equal(submission.confidence, "proven");
  assert.ok(exportStep);
  assert.equal(exportStep.featureId, result.features.find(feature => feature.label === "Exports")?.id);
  assert.deepEqual(exportHandlers.map(node => node.label).sort(), ["Download API", "Get API", "Post API", "Retry API"].sort());
  assert.ok(exportHandlers.every(node => node.confidence === "proven"));
  assert.ok(result.limitations.some(item => item.filePath === "apps/web/lib/exports/handlers.ts" && /dependency injeksi/iu.test(item.reason)));
  assert.ok(result.nodes.some(node => node.kind === "concept" && node.label === "Analysis stage" && node.evidence.some(span => span.filePath === "packages/contracts/src/stages.ts")));
  assert.equal(result.edges.filter(edge => edge.label.startsWith("mencakup tahap") && edge.evidence.some(span => span.filePath === "packages/contracts/src/stages.ts")).length, 9);
  assert.ok(result.edges.some(edge => edge.label === "mencakup tahap 1" && edge.confidence === "proven" && edge.evidence.some(span => span.filePath === "packages/contracts/src/stages.ts")));
  for (const label of ["Repository Benchmark Manifest", "Resolver Oracle Manifest", "Fixture Manifest", "Oracle", "Workload Arguments", "Graph Read Database"]) {
    assert.equal(result.nodes.some(node => node.kind === "concept" && node.label === label), false, `${label} is tooling/helper data, not a recognized flow concept`);
  }
});

test("flow concepts require a referenced contract and resolve relative re-exports", () => {
  const result = extractNext(input({
    "src/contracts.ts": 'export type { SignupInput as UserInput } from "./models"; export { SignupSchema } from "./models";',
    "src/models.ts": [
      "export interface SignupInput { name: string; email: string; }",
      "export const SignupSchema = z.object({ name: z.string(), email: z.string() });",
      "export interface RepositoryBenchmarkManifest { repository: string; limits: object; }",
      "export interface ResolverOracleManifest { schemaVersion: string; oracles: Oracle[]; }",
      "export interface FixtureManifest { name: string; sources: string[]; }",
      "export type Oracle = { path: string; target: string; snippet: string; };",
      "export type WorkloadArguments = { manifest: string; root: string; };",
      "export interface GraphReadDatabase { getAnalysis(id: string): unknown; saveAnalysis(id: string): unknown; }",
    ].join("\n"),
    "scripts/tooling.ts": [
      'export interface RepositoryBenchmarkManifest { repository: string; limits: object; }',
      'export interface ResolverOracleManifest { schemaVersion: string; oracles: unknown[]; }',
      'export interface FixtureManifest { name: string; sources: string[]; }',
      'export type Oracle = { path: string; target: string; snippet: string; };',
      'export type WorkloadArguments = { manifest: string; root: string; };',
      'export interface GraphReadDatabase { getAnalysis(id: string): unknown; saveAnalysis(id: string): unknown; }',
    ].join("\n"),
    "src/app/api/signup/route.ts": [
      'import type { UserInput } from "../../../contracts";',
      'import { SignupSchema } from "../../../contracts";',
      "export async function POST(request: Request, payload: UserInput) {",
      "  const parsed = SignupSchema.safeParse(payload);",
      '  if (!parsed.success) return Response.json({ error: "invalid" }, { status: 400 });',
      '  return Response.json({ ok: true }, { status: 201 });',
      "}",
    ].join("\n"),
  }));
  const inputContract = result.nodes.find(node => node.kind === "concept" && node.label === "Signup Input");
  const schemaContract = result.nodes.find(node => node.kind === "concept" && node.label === "Signup");
  const signup = result.features.find(feature => feature.label === "Auth");
  assert.ok(inputContract && schemaContract && signup);
  assert.equal(inputContract.confidence, "proven");
  assert.equal(schemaContract.confidence, "indicated");
  assert.equal(inputContract.featureId, signup.id);
  assert.equal(schemaContract.featureId, signup.id);
  assert.ok(result.edges.some(edge => edge.source === signup.id && edge.target === inputContract.id && edge.confidence === "indicated"));
  for (const label of ["Repository Benchmark Manifest", "Resolver Oracle Manifest", "Fixture Manifest", "Oracle", "Workload Arguments", "Graph Read Database"]) {
    assert.equal(result.nodes.some(node => node.kind === "concept" && node.label === label), false, `${label} is not referenced by the recognized route flow`);
  }
});

test("unresolved project type imports stay indicated with an explicit limitation", () => {
  const result = extractNext(input({
    "src/app/api/registration/route.ts": [
      'import type { RegistrationInput } from "@/contracts";',
      "export async function POST(request: Request, payload: RegistrationInput) {",
      '  return Response.json({ ok: true }, { status: 201 });',
      "}",
    ].join("\n"),
  }));
  const contract = result.nodes.find(node => node.kind === "concept" && node.label === "Registration Input");
  assert.ok(contract);
  assert.equal(contract.confidence, "indicated");
  assert.ok(result.edges.some(edge => edge.target === contract.id && edge.confidence === "indicated"));
  assert.ok(result.limitations.some(item => item.filePath === "src/app/api/registration/route.ts" && /alias source/iu.test(item.reason)));
});

test("form actions use explicit or submit-button labels instead of flattening every field", () => {
  const result = extractNext(input({
    "src/app/signup/page.tsx": '<form action="/api/signup" method="post"><label>Nama lengkap<input name="name" /></label><label>Email<input name="email" /></label><label>Alamat lengkap<textarea name="address" /></label><button type="submit">Daftar akun</button></form>',
    "src/app/api/signup/route.ts": 'export async function POST() { return Response.json({ ok: true }, { status: 201 }); }',
  }));
  assert.ok(result.nodes.some(node => node.kind === "step" && node.label === "Daftar akun"));
  assert.equal(result.nodes.some(node => node.kind === "step" && node.label.includes("Nama lengkap Email Alamat lengkap")), false);
});

test("equivalent UI actions merge only when feature, event, and linked endpoint all match", () => {
  const result = extractNext(input({
    "src/app/api/auth/logout/route.ts": 'export async function POST() { return Response.json({}, { status: 200 }); }',
    "src/app/api/auth/archive/route.ts": 'export async function POST() { return Response.json({}, { status: 200 }); }',
    "src/app/login/page.tsx": 'export default function Login() { return <h1>Masuk</h1>; }',
    "src/components/desktop-nav.tsx": 'function logout() { fetch("/api/auth/logout", { method: "POST" }); router.push("/login"); } export function DesktopNav() { return <button onClick={logout}>Keluar</button>; }',
    "src/components/mobile-nav.tsx": 'function logout() { fetch("/api/auth/logout", { method: "POST" }); router.push("/login"); } export function MobileNav() { return <button onClick={logout}>Keluar</button>; }',
    "src/components/logout-form.tsx": 'function logout() { return fetch("/api/auth/logout", { method: "POST" }); } export function LogoutForm() { return <form onSubmit={logout}><button>Keluar</button></form>; }',
    "src/components/archive-control.tsx": 'function archive() { return fetch("/api/auth/archive", { method: "POST" }); } export function ArchiveControl() { return <button onClick={archive}>Keluar</button>; }',
  }));
  const actions = result.nodes.filter(node => node.kind === "step" && node.label === "Keluar");
  assert.equal(actions.length, 3);
  const logoutEndpoint = result.nodes.find(node => node.kind === "step" && node.label === "POST /api/auth/logout");
  assert.ok(logoutEndpoint);
  const buttonAction = actions.find(node => node.evidence.some(span => span.filePath === "src/components/desktop-nav.tsx"));
  assert.ok(buttonAction);
  assert.deepEqual(buttonAction.evidence.map(span => span.filePath).sort(), ["src/components/desktop-nav.tsx", "src/components/mobile-nav.tsx"]);
  const buttonEdge = result.edges.find(edge => edge.source === buttonAction.id && edge.target === logoutEndpoint.id);
  assert.ok(buttonEdge);
  assert.deepEqual(buttonEdge.evidence.map(span => span.filePath).sort(), ["src/components/desktop-nav.tsx", "src/components/mobile-nav.tsx"]);
  assert.ok(result.edges.some(edge => edge.source === buttonAction.id && edge.label === "membuka halaman" && edge.target === result.nodes.find(node => node.kind === "feature" && node.label === "Login")?.id));
  assert.ok(actions.some(node => node.evidence.some(span => span.filePath === "src/components/logout-form.tsx")));
  assert.ok(actions.some(node => node.evidence.some(span => span.filePath === "src/components/archive-control.tsx")));
});

test("literal router navigation through a named callback reaches a dynamic page route", () => {
  const result = extractNext(input({
    "apps/web/app/books/page.tsx": [
      'function openBook() { router.push("/books/123"); }',
      'export default function BooksPage() { return <button onClick={openBook}>Buka buku</button>; }',
    ].join("\n"),
    "apps/web/app/books/[bookId]/page.tsx": 'export default function BookPage() { return <h1>Detail buku</h1>; }',
  }));
  const action = result.nodes.find(node => node.kind === "step" && node.label === "Buka buku");
  const destination = result.nodes.find(node => node.kind === "feature" && node.label === "Books detail");
  assert.ok(action && destination);
  assert.ok(result.edges.some(edge => edge.source === action.id && edge.target === destination.id && edge.label === "membuka halaman"));
  assert.equal(result.limitations.length, 0);
});

test("wrapper callbacks stay indicated while statically returned factory handlers resolve by exported property", () => {
  const result = extractNext(input({
    "src/app/api/books/route.ts": 'export const POST = wrap(async (request: Request) => { if (!request.session) return Response.json({}, { status: 401 }); return Response.json({ ok: true }, { status: 201 }); });',
    "src/app/api/analyses/route.ts": 'import { handlers } from "../../../lib/server-handlers"; export const GET = handlers.list;',
    "src/lib/server-handlers.ts": 'import { createHandlers } from "./factories"; export const handlers = createHandlers();',
    "src/lib/factories.ts": 'export function createHandlers() { return { async list(request: Request) { if (!request.session) return Response.json({}, { status: 401 }); await db.analysis.findMany(); return Response.json({ rows: [] }, { status: 200 }); } }; }',
  }));
  const wrapped = result.nodes.find(node => node.kind === "decision" && node.evidence.some(span => span.filePath === "src/app/api/books/route.ts"));
  const delegated = result.nodes.find(node => node.kind === "component" && node.label === "List API");
  assert.ok(wrapped);
  assert.equal(wrapped.confidence, "indicated");
  assert.ok(delegated);
  assert.equal(delegated.confidence, "proven");
  assert.equal(delegated.evidence.some(span => span.filePath === "src/lib/factories.ts"), true);
  assert.ok(result.edges.some(edge => edge.source === delegated.id && edge.label === "membaca"));
});

test("dynamic paths, uncalled nested callbacks, tests and helper files do not become proven user flow", () => {
  const result = extractNext(input({
    "src/app/api/catalog/route.ts": 'export async function GET() { return Response.json([]); }',
    "src/app/catalog/page.tsx": 'export default function Catalog(){ function unused(){ fetch("/api/catalog"); } return <button onClick={() => fetch(makeUrl())}>Muat katalog</button>; }',
    "src/app/catalog/example.test.tsx": 'export function Example(){ return <button onClick={() => fetch("/api/catalog")}>Hapus</button>; }',
    "src/lib/request.ts": 'export function helper(path:string){ function notRun(){ fetch(path); } return path; }',
  }));
  assert.equal(result.nodes.some(node => node.label === "Hapus"), false);
  assert.equal(result.edges.some(edge => edge.label === "GET /api/catalog"), false);
  assert.ok(result.limitations.some(item => item.filePath === "src/app/catalog/page.tsx" && /dinamis|statis/iu.test(item.reason)));
});

test("evidence byte offsets retain UTF-8 and human labels are stable for source identifiers", () => {
  const bytes = new TextEncoder().encode("const label = 'Buku 📚';\nexport function borrowBook() {}");
  const span = evidenceSpan("src/app/page.tsx", bytes, 0, "const label = 'Buku 📚';".length, "context");
  assert.equal(span.endByte, new TextEncoder().encode("const label = 'Buku 📚';").byteLength);
  assert.equal(span.startLine, 1);
  assert.equal(humanLabel("bulkBorrowController"), "Bulk Borrow Controller");
  assert.deepEqual(emptyFragment(), { nodes: [], edges: [], features: [], frameworks: [], limitations: [] });
});

test("semantic model merges extractors deterministically without treating imports as user steps", async () => {
  const fixture = input({
    "src/app/api/books/route.ts": 'export async function GET() { return Response.json([]); }',
    "src/app/api/books/page.tsx": 'import { helper } from "../../lib/helper"; export default function Page(){ return <h1>Buku</h1>; }',
  });
  const first = buildSemanticModel(fixture);
  const second = buildSemanticModel(fixture);
  assert.equal(first.schemaVersion, "sage-semantic-v1");
  assert.deepEqual(first, second);
  assert.equal(isSemanticModel(first), true);
  assert.equal(first.nodes.some(node => node.label === "Helper" && node.kind === "step"), false);
});
