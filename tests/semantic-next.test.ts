import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
  const fixtureRoot = fileURLToPath(new URL("./fixtures/semantic/sage-pinned/", import.meta.url));
  const manifest = JSON.parse(readFileSync(join(fixtureRoot, "manifest.json"), "utf8")) as {
    schemaVersion: number;
    repository: string;
    commit: string;
    oraclePath: string;
    files: Array<{ path: string; sha256: string; sizeBytes: number }>;
  };
  const oracle = JSON.parse(readFileSync(new URL("../docs/evidence/semantic/oracle.json", import.meta.url), "utf8")) as {
    snapshots: Array<{ repository: string; commit: string }>;
  };
  const pinnedSnapshot = oracle.snapshots.find(snapshot => snapshot.repository === manifest.repository);
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.oraclePath, "docs/evidence/semantic/oracle.json");
  assert.ok(pinnedSnapshot, "the SAGE fixture must refer to a snapshot in the pinned semantic oracle");
  assert.equal(manifest.commit, pinnedSnapshot.commit);
  assert.equal(manifest.repository, "AgilePemdigi-2026/sage");
  assert.equal(manifest.files.length, paths.length);
  assert.deepEqual(manifest.files.map(file => file.path), [...paths].sort());
  const fileByPath = new Map(manifest.files.map(file => [file.path, file]));
  return Object.fromEntries(paths.map(path => {
    assert.ok(!path.startsWith("/") && !path.split("/").includes(".."), "fixture paths must stay within the fixture directory");
    const bytes = readFileSync(join(fixtureRoot, path));
    const file = fileByPath.get(path);
    assert.ok(file, "fixture manifest is missing " + path);
    assert.equal(bytes.byteLength, file.sizeBytes, "fixture size changed: " + path);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), file.sha256, "fixture hash changed: " + path);
    return [path, bytes.toString("utf8")];
  }));
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
  assert.ok(result.nodes.some(node => node.kind === "outcome" && node.label.includes("Permintaan ditolak (403)")));
  assert.ok(result.nodes.some(node => node.kind === "store" && node.label === "Loan"));
  const createEdge = result.edges.find(edge => edge.label === "menyimpan");
  assert.ok(createEdge);
  assert.equal(createEdge.confidence, "indicated");
  assert.match(createEdge.reason, /binding receiver belum diverifikasi/iu);
});

test("verified HTTP failure branches remain visible without guessing an unknown condition category", () => {
  const result = extractNext(input({
    "src/app/api/login/route.ts": [
      "export async function POST() {",
      '  if (!email || !password) return Response.json({ error: "Email dan password wajib diisi" }, { status: 400 });',
      '  if (missingUser) return Response.json({ error: "Akun tidak ditemukan" }, { status: 404 });',
      '  if (businessFailure) return { error: "Payload status bukan HTTP", status: 400 };',
      '  return Response.json({ ok: true }, { status: 200 });',
      "}",
    ].join("\n"),
  }));
  const unknownDecisions = result.nodes.filter(node => node.kind === "decision" && node.label === "Pemeriksaan kondisi");
  assert.equal(unknownDecisions.length, 2);
  assert.ok(unknownDecisions.every(node => node.confidence === "proven"));
  assert.ok(unknownDecisions.some(node => node.evidence.some(span => span.startLine === 2)));
  assert.ok(unknownDecisions.some(node => node.evidence.some(span => span.startLine === 3)));
  assert.ok(unknownDecisions.every(node => /tanpa menebak jenis autentikasi/iu.test(node.reason)));
  assert.ok(result.nodes.some(node => node.kind === "outcome" && node.label.includes("400") && node.label.includes("Email dan password wajib diisi")));
  assert.ok(result.nodes.some(node => node.kind === "outcome" && node.label.includes("404") && node.label.includes("Akun tidak ditemukan")));
  const payloadFailure = result.nodes.find(node => node.kind === "outcome" && node.label.includes("Payload status bukan HTTP"));
  assert.ok(payloadFailure);
  assert.equal(payloadFailure.confidence, "indicated");
  assert.equal(payloadFailure.label.includes("(400)"), false);
  assert.ok(result.nodes.some(node => node.kind === "outcome" && /200/u.test(node.label)));
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

test("transaction callback parameters link real table operations and plain business errors stay indicated", () => {
  const result = extractNext(input({
    "src/app/api/bookings/bulk/route.ts": [
      "export async function POST() {",
      '  const tx = { loan: { create() {} } }; tx.loan.create();',
      "  return prisma.$transaction(async (tx) => {",
      '    if (!stock.available) return { error: `Stok buku ${bookId} habis`, status: 400 };',
      '    await tx.booking.create({ data: { bookId: "b1" } });',
      '    await tx.book.updateMany({ where: { id: "b1" }, data: { stock: 0 } });',
      '    return { ok: true };',
      "  });",
      "}",
    ].join("\n"),
  }));
  const component = result.nodes.find(node => node.kind === "component" && node.label === "POST API");
  const stores = result.nodes.filter(node => node.kind === "store");
  assert.ok(component);
  assert.deepEqual(stores.map(node => node.label).sort(), ["Book", "Booking"]);
  assert.ok(result.edges.some(edge => edge.source === component.id && edge.label === "menyimpan" && edge.confidence === "indicated"));
  assert.ok(result.edges.some(edge => edge.source === component.id && edge.label === "mengubah" && edge.confidence === "indicated"));
  for (const store of stores) assert.ok(store.evidence.length >= 3, `${store.label} should cite the operation, transaction call, and callback parameter`);
  const failure = result.nodes.find(node => node.kind === "outcome" && node.label.startsWith("Gagal Stok buku"));
  assert.ok(failure);
  assert.match(failure.label, /habis/iu);
  assert.equal(failure.confidence, "indicated");
  assert.match(failure.reason, /status payload bukan status HTTP/iu);
  assert.equal(result.nodes.some(node => node.kind === "outcome" && /400/u.test(node.label)), false);
  assert.equal(stores.some(node => node.label === "Loan"), false, "a tx-shaped variable outside $transaction is not a transaction client");
});

test("verified local response helpers preserve both literal branches of a conditional HTTP status", () => {
  const result = extractNext(input({
    "src/app/api/exports/route.ts": [
      "function respond(value: unknown, status = 200) {",
      '  return Response.json(value, { status, headers: { "cache-control": "no-store" } });',
      "}",
      "export async function POST() {",
      "  const result = { created: true };",
      "  return respond({ queued: true }, result.created ? 202 : 200);",
      "}",
    ].join("\n"),
  }));
  const outcomes = result.nodes.filter(node => node.kind === "outcome" &&
    (/^Respons selesai \(200\)$/.test(node.label) || /^Permintaan diterima \(202\)$/.test(node.label)));
  assert.deepEqual(outcomes.map(node => node.label).sort(), ["Permintaan diterima (202)", "Respons selesai (200)"]);
  assert.ok(outcomes.every(node => node.confidence === "indicated"));
  assert.ok(outcomes.every(node => /result\.created/.test(node.reason)));
  assert.ok(outcomes.every(node =>
    node.evidence.some(span => span.startLine === 2) &&
    node.evidence.some(span => span.startLine === 6)));
  const outcomeIds = new Set(outcomes.map(node => node.id));
  const responseEdges = result.edges.filter(edge => outcomeIds.has(edge.target));
  assert.equal(responseEdges.length, 2);
  assert.ok(responseEdges.every(edge =>
    edge.evidence.some(span => span.startLine === 2) &&
    edge.evidence.some(span => span.startLine === 6)));
});

test("a shadowed helper named json is not treated as a verified HTTP response wrapper", () => {
  const result = extractNext(input({
    "src/app/api/export/route.ts": [
      "function json(value: unknown, status: number) { return Response.json(value, { status }); }",
      "export async function POST() {",
      "  const json = (value: unknown, status: number) => ({ value, status });",
      "  return json({ queued: true }, 202);",
      "}",
    ].join("\n"),
  }));
  assert.equal(result.nodes.some(node => node.kind === "outcome" && /202/.test(node.label)), false);
  assert.ok(result.limitations.some(item =>
    item.filePath === "src/app/api/export/route.ts" && /binding dan hasil Web Response helper tidak dapat diverifikasi/.test(item.reason)));
});

test("an imported json-like wrapper with literal status is not inferred without its implementation", () => {
  const result = extractNext(input({
    "src/app/api/export/route.ts": [
      'import { json } from "unknown-response-package";',
      "export async function POST() { return json({ queued: true }, 202); }",
    ].join("\n"),
  }));
  assert.equal(result.nodes.some(node => node.kind === "outcome" && /202/.test(node.label)), false);
  assert.ok(result.limitations.some(item =>
    item.filePath === "src/app/api/export/route.ts" && /memanggil helper "json"/.test(item.reason)));
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
  const exportResponses = result.nodes.filter(node =>
    node.kind === "outcome" &&
    (/^Respons selesai \(200\)$/.test(node.label) || /^Permintaan diterima \(202\)$/.test(node.label)) &&
    node.evidence.some(span => span.filePath === "apps/web/lib/exports/handlers.ts" && span.startLine <= 121 && span.endLine >= 121));
  assert.ok(submission && submissionAuth);
  assert.equal(submission.confidence, "proven");
  assert.ok(exportStep);
  assert.equal(exportStep.featureId, result.features.find(feature => feature.label === "Exports")?.id);
  assert.deepEqual(exportHandlers.map(node => node.label).sort(), ["Download API", "Get API", "Post API", "Retry API"].sort());
  assert.ok(exportHandlers.every(node => node.confidence === "proven"));
  assert.deepEqual(exportResponses.map(node => node.label).sort(), ["Permintaan diterima (202)", "Respons selesai (200)"]);
  assert.ok(exportResponses.every(node => node.confidence === "indicated"));
  assert.ok(exportResponses.every(node => node.evidence.some(span => span.startLine <= 30 && span.endLine >= 30)));
  const acceptedResponse = exportResponses.find(node => node.label === "Permintaan diterima (202)");
  assert.ok(acceptedResponse);
  assert.match(acceptedResponse.reason, /bukan bahwa hasil atau unduhan telah selesai/);
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
  const logoutEndpoint = result.nodes.find(node => node.kind === "step" && node.label === "POST /api/auth/logout");
  assert.ok(logoutEndpoint);
  const endpointActions = actions.filter(node => result.edges.some(edge => edge.source === node.id && edge.label.startsWith("POST /api/auth/")));
  assert.equal(endpointActions.length, 3);
  const buttonAction = endpointActions.find(node => node.evidence.some(span => span.filePath === "src/components/desktop-nav.tsx"));
  assert.ok(buttonAction);
  assert.deepEqual(buttonAction.evidence.map(span => span.filePath).sort(), ["src/components/desktop-nav.tsx", "src/components/mobile-nav.tsx"]);
  const buttonEdge = result.edges.find(edge => edge.source === buttonAction.id && edge.target === logoutEndpoint.id);
  assert.ok(buttonEdge);
  assert.deepEqual(buttonEdge.evidence.map(span => span.filePath).sort(), ["src/components/desktop-nav.tsx", "src/components/mobile-nav.tsx"]);
  const loginNavigation = result.edges.find(edge => edge.label === "membuka halaman" && edge.target === result.nodes.find(node => node.kind === "feature" && node.label === "Login")?.id);
  assert.ok(loginNavigation);
  assert.equal(loginNavigation.confidence, "indicated");
  assert.ok(result.limitations.some(item => item.filePath === "src/components/desktop-nav.tsx" && /useRouter/iu.test(item.reason)));
  assert.ok(actions.some(node => node.evidence.some(span => span.filePath === "src/components/logout-form.tsx")));
  assert.ok(actions.some(node => node.evidence.some(span => span.filePath === "src/components/archive-control.tsx")));
});

test("unverified router receiver navigation through a named callback stays indicated", () => {
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
  const navigation = result.edges.find(edge => edge.source === action.id && edge.target === destination.id && edge.label === "membuka halaman");
  assert.ok(navigation);
  assert.equal(navigation.confidence, "indicated");
  assert.ok(result.limitations.some(item => /useRouter/iu.test(item.reason)));
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

test("relative imports cannot escape the source snapshot and resolve a root-level lookalike", () => {
  const result = extractNext(input({
    "src/app/api/books/route.ts": 'import { handlers } from "../../../../../outside"; export const GET = handlers.list;',
    "outside.ts": [
      "export function createHandlers() { return { list() { if (!session) return Response.json({}, { status: 401 }); return Response.json({}); } }; }",
      "export const handlers = createHandlers();",
    ].join("\n"),
  }));
  const endpoint = result.nodes.find(node => node.kind === "step" && node.label === "GET /api/books");
  const delegate = result.nodes.find(node => node.kind === "component" && node.label.toLowerCase() === "handlers list api");
  assert.ok(endpoint && delegate);
  assert.equal(delegate.confidence, "indicated");
  assert.equal(delegate.evidence.some(span => span.filePath === "outside.ts"), false);
  assert.equal(result.nodes.some(node => node.kind === "decision" && node.evidence.some(span => span.filePath === "outside.ts")), false);
  assert.ok(result.limitations.some(item => item.filePath === "src/app/api/books/route.ts"));
});

test("delegated handler resolution respects a nearer parameter that shadows the imported object", () => {
  const result = extractNext(input({
    "src/app/api/books/route.ts": [
      'import { handlers } from "../../../lib/handlers";',
      'export async function GET(handlers: { list: () => unknown }) { return handlers.list(); }',
    ].join("\n"),
    "src/lib/handlers.ts": [
      "export function createHandlers() { return { list() { if (!session) return Response.json({}, { status: 401 }); return Response.json({}); } }; }",
      "export const handlers = createHandlers();",
    ].join("\n"),
  }));
  const delegate = result.nodes.find(node => node.kind === "component" && node.label === "GET API");
  assert.ok(delegate);
  assert.equal(delegate.evidence.some(span => span.filePath === "src/lib/handlers.ts"), false);
  assert.equal(result.nodes.some(node => node.kind === "decision" && node.evidence.some(span => span.filePath === "src/lib/handlers.ts")), false);
});

test("factory object handlers stay indicated when spreads, computed keys, duplicates, or mutable exports can override them", () => {
  const factories = [
    { label: "spread", handler: 'return { async list() { if (!request.user) return Response.json({}, { status: 401 }); return Response.json({}); }, ...overrides };', export: "export const handlers = createHandlers({});" },
    { label: "computed", handler: 'return { async list() { if (!request.user) return Response.json({}, { status: 401 }); return Response.json({}); }, [key]: async () => Response.json({}) };', export: "export const handlers = createHandlers();" },
    { label: "duplicate", handler: 'return { async list() { if (!request.user) return Response.json({}, { status: 401 }); return Response.json({}); }, async list() { return Response.json({}); } };', export: "export const handlers = createHandlers();" },
    { label: "mutable", handler: 'return { async list() { if (!request.user) return Response.json({}, { status: 401 }); return Response.json({}); } };', export: "export let handlers = createHandlers();" },
  ];
  for (const factory of factories) {
    const result = extractNext(input({
      "src/app/api/analysis/route.ts": 'import { handlers } from "../../../lib/handlers"; export const GET = handlers.list;',
      "src/lib/handlers.ts": `import { createHandlers } from "./factory"; ${factory.export}`,
      "src/lib/factory.ts": `export function createHandlers(overrides?: object) { ${factory.handler} }`,
    }));
    const delegated = result.nodes.find(node => node.kind === "component" && node.label.toLowerCase() === "handlers list api");
    assert.ok(delegated, factory.label);
    assert.equal(delegated.confidence, "indicated", factory.label);
    assert.equal(delegated.evidence.some(span => span.filePath === "src/lib/factory.ts"), false, factory.label);
    assert.equal(result.nodes.some(node => node.kind === "decision" && node.evidence.some(span => span.filePath === "src/lib/factory.ts")), false, factory.label);
  }
});

test("const factory objects stay unresolved when their method can be replaced or escape", () => {
  const mutations = [
    "handlers.list = () => Response.json({ public: true });",
    'Object.assign(handlers, { list: () => Response.json({ public: true }) });',
    'Object.defineProperty(handlers, "list", { value: () => Response.json({ public: true }) });',
    "const alias = handlers; alias.list = () => Response.json({ public: true });",
    "delete handlers.list;",
  ];
  for (const mutation of mutations) {
    const result = extractNext(input({
      "src/app/api/books/route.ts": 'import { handlers } from "../../../lib/handlers"; export async function GET() { return handlers.list(); }',
      "src/lib/handlers.ts": [
        "export function createHandlers() {",
        '  return { list() { if (!session) return Response.json({}, { status: 401 }); return Response.json({ ok: true }); } };',
        "}",
        "export const handlers = createHandlers();",
        mutation,
      ].join("\n"),
    }));
    const boundary = result.nodes.find(node => node.kind === "step" && node.label === "GET /api/books");
    const unresolved = result.nodes.find(node => node.kind === "component" && node.evidence.some(span => span.filePath === "src/app/api/books/route.ts"));
    assert.ok(boundary, mutation);
    assert.ok(unresolved, mutation);
    assert.equal(unresolved.confidence, "indicated", mutation);
    assert.equal(result.nodes.some(node => node.kind === "decision" && node.evidence.some(span => span.filePath === "src/lib/handlers.ts")), false, mutation);
    assert.ok(result.limitations.some(item => item.filePath === "src/app/api/books/route.ts"), mutation);
  }
});

test("UI callback resolution follows lexical bindings instead of a same-named nested helper", () => {
  const result = extractNext(input({
    "src/app/api/safe/route.ts": 'export async function POST() { return Response.json({ ok: true }); }',
    "src/app/api/danger/route.ts": 'export async function POST() { if (!session) return Response.json({}, { status: 401 }); return Response.json({ ok: true }); }',
    "src/app/page.tsx": [
      'function act() { return fetch("/api/safe", { method: "POST" }); }',
      "export default function Page() {",
      '  function unused() { function act() { return fetch("/api/danger", { method: "POST" }); } return act; }',
      '  return <button onClick={act}>Lanjutkan</button>;',
      "}",
    ].join("\n"),
  }));
  const action = result.nodes.find(node => node.kind === "step" && node.label === "Lanjutkan");
  const safe = result.nodes.find(node => node.kind === "step" && node.label === "POST /api/safe");
  const danger = result.nodes.find(node => node.kind === "step" && node.label === "POST /api/danger");
  assert.ok(action && safe && danger);
  assert.ok(result.edges.some(edge => edge.source === action.id && edge.target === safe.id && edge.confidence === "proven"));
  assert.equal(result.edges.some(edge => edge.source === action.id && edge.target === danger.id), false);

  const unresolved = extractNext(input({
    "src/app/api/danger/route.ts": 'export async function POST() { return Response.json({ ok: true }); }',
    "src/app/page.tsx": [
      "export default function Page() {",
      '  function unused() { function act() { return fetch("/api/danger", { method: "POST" }); } return act; }',
      '  return <button onClick={act}>Coba</button>;',
      "}",
    ].join("\n"),
  }));
  assert.equal(unresolved.nodes.some(node => node.kind === "step" && node.label === "Coba"), false);
  assert.equal(unresolved.edges.some(edge => edge.label === "POST /api/danger"), false);
  assert.ok(unresolved.limitations.some(item => item.filePath === "src/app/page.tsx" && /binding lexical/iu.test(item.reason)));
});

test("parameters, destructured properties, local values, and reassigned let functions mask outer callbacks", () => {
  const pages = [
    'function act() { return fetch("/api/admin"); } export default function Page({ act }) { return <button onClick={act}>Go</button>; }',
    'function act() { return fetch("/api/admin"); } export default function Page(props) { const act = props.handler; return <button onClick={act}>Go</button>; }',
    'let act = () => fetch("/api/admin"); act = props.handler; export default function Page() { return <button onClick={act}>Go</button>; }',
  ];
  for (const page of pages) {
    const result = extractNext(input({
      "src/app/api/admin/route.ts": 'export async function GET() { return Response.json({ ok: true }); }',
      "src/app/page.tsx": page,
    }));
    assert.equal(result.edges.some(edge => edge.label === "GET /api/admin" && edge.confidence === "proven"), false, page);
    assert.ok(result.limitations.some(item => item.filePath === "src/app/page.tsx" && /binding lexical/iu.test(item.reason)), page);
  }
});

test("shadowed fetch is not treated as the global HTTP primitive", () => {
  const result = extractNext(input({
    "src/app/api/admin/route.ts": 'export async function GET() { return Response.json({ ok: true }); }',
    "src/app/page.tsx": [
      'export default function Page() {',
      '  const load = (fetch: (value: string) => unknown) => fetch("/api/admin");',
      '  return <button onClick={() => load(() => undefined)}>Load</button>;',
      '}',
    ].join("\n"),
  }));
  assert.equal(result.edges.some(edge => edge.label === "GET /api/admin" && edge.confidence === "proven"), false);
  assert.ok(result.limitations.some(item => item.filePath === "src/app/page.tsx" && /HTTP yang tidak dapat ditentukan/iu.test(item.reason)));
});

test("shadowed Response bindings do not produce proven HTTP outcomes", () => {
  const result = extractNext(input({
    "src/app/api/private/route.ts": [
      'export async function GET(Response: { json: (body: unknown, init: unknown) => unknown }) {',
      '  if (!request.session) return Response.json({ error: "unauthorized" }, { status: 401 });',
      '  return Response.json({ ok: true }, { status: 200 });',
      '}',
    ].join("\n"),
  }));
  assert.equal(result.nodes.some(node => node.kind === "outcome" && /401/u.test(node.label)), false);
  assert.equal(result.nodes.some(node => node.kind === "outcome" && /200/u.test(node.label)), false);
  assert.ok(result.limitations.some(item => item.filePath === "src/app/api/private/route.ts" && /binding-nya tidak dapat diverifikasi/iu.test(item.reason)));
});

test("Next router navigation is proven only for a verified useRouter binding", () => {
  const unverified = extractNext(input({
    "src/app/login/page.tsx": 'export default function Login() { return <h1>Login</h1>; }',
    "src/components/nav.tsx": 'export function Nav() { return <button onClick={() => router.push("/login")}>Login</button>; }',
  }));
  const unverifiedNavigation = unverified.edges.find(edge => edge.label === "membuka halaman");
  assert.ok(unverifiedNavigation);
  assert.equal(unverifiedNavigation.confidence, "indicated");
  assert.match(unverifiedNavigation.reason, /tidak terbukti berasal dari hook useRouter/iu);

  const verified = extractNext(input({
    "src/app/login/page.tsx": 'export default function Login() { return <h1>Login</h1>; }',
    "src/components/nav.tsx": [
      'import { useRouter } from "next/navigation";',
      'export function Nav() { const router = useRouter(); return <button onClick={() => router.push("/login")}>Login</button>; }',
    ].join("\n"),
  }));
  const verifiedNavigation = verified.edges.find(edge => edge.label === "membuka halaman");
  assert.ok(verifiedNavigation);
  assert.equal(verifiedNavigation.confidence, "proven");
});

test("page loaders link a declared page boundary to matching API routes without promoting uncalled helpers", () => {
  const result = extractNext(input({
    "src/app/api/books/route.ts": 'export async function GET() { return Response.json([]); }',
    "src/app/catalog/page.tsx": [
      'export default async function CatalogPage() {',
      '  function unused() { fetch("/api/books"); }',
      '  const books = await fetch("/api/books");',
      '  return <h1>Katalog</h1>;',
      '}',
    ].join("\n"),
  }));
  const page = result.nodes.find(node => node.kind === "component" && node.label === "Catalog Page");
  const load = result.nodes.find(node => node.kind === "step" && node.label === "Memuat data");
  const endpoint = result.nodes.find(node => node.kind === "step" && node.label === "GET /api/books");
  assert.ok(page && load && endpoint);
  assert.ok(result.edges.some(edge => edge.source === page.id && edge.target === load.id && edge.label === "memuat data" && edge.confidence === "proven"));
  assert.ok(result.edges.some(edge => edge.source === load.id && edge.target === endpoint.id && edge.label === "GET /api/books" && edge.confidence === "proven"));
  assert.equal(result.edges.filter(edge => edge.target === endpoint.id && edge.source !== load.id && edge.label === "GET /api/books").length, 0);
});

test("React useEffect page loaders require a verified import for proven relationships", () => {
  const verified = extractNext(input({
    "src/app/api/books/route.ts": 'export async function GET() { return Response.json([]); }',
    "src/app/catalog/page.tsx": [
      'import { useEffect } from "react";',
      'export default function CatalogPage() { useEffect(() => { void fetch("/api/books"); }, []); return <h1>Katalog</h1>; }',
    ].join("\n"),
  }));
  const verifiedLoad = verified.nodes.find(node => node.kind === "step" && node.label === "Memuat data");
  assert.ok(verifiedLoad);
  assert.equal(verifiedLoad.confidence, "proven");

  const unverified = extractNext(input({
    "src/app/api/books/route.ts": 'export async function GET() { return Response.json([]); }',
    "src/app/catalog/page.tsx": 'export default function CatalogPage() { useEffect(() => { void fetch("/api/books"); }, []); return <h1>Katalog</h1>; }',
  }));
  const unverifiedLoad = unverified.nodes.find(node => node.kind === "step" && node.label === "Memuat data");
  assert.ok(unverifiedLoad);
  assert.equal(unverifiedLoad.confidence, "indicated");
  assert.ok(unverified.limitations.some(item => item.filePath === "src/app/catalog/page.tsx" && /import React tidak dapat diverifikasi/iu.test(item.reason)));
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
