import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { SCHEMA_VERSION, type CcmNode, type CcmV1 } from "@sage/contracts";
import { extractLaravel } from "../packages/documents/src/semantic/laravel.ts";
import type { SemanticInput } from "../packages/documents/src/semantic/model.ts";
import { isSemanticModel } from "../packages/documents/src/semantic/validation.ts";

const ROUTES = "routes/api.php";
function fixture(overrides: Record<string, string>): SemanticInput {
  const sources: Record<string, Uint8Array> = Object.fromEntries(Object.entries(overrides).map(([path, text]) => [path, new TextEncoder().encode(text)]));
  const files = Object.entries(sources).map(([path, bytes]) => ({ path, language: path.endsWith(".php") ? "php" as const : null, sha256: "a".repeat(64), sizeBytes: bytes.length, status: "processed" as const }));
  const nodes: CcmNode[] = [];
  for (const [path, textBytes] of Object.entries(sources)) {
    if (!path.includes("Controller")) continue;
    const text = new TextDecoder().decode(textBytes), match = /class\s+(\w+)/u.exec(text);
    if (!match) continue;
    nodes.push({ id: `class:${match[1]}`, kind: "Class", name: match[1]!, qualifiedName: match[1]!, language: "php", filePath: path, location: null, parentId: null, origin: "source", signature: null, attributes: {} });
  }
  const ccm = { schemaVersion: SCHEMA_VERSION, snapshot: { repository: "fixture/laravel", branch: "main", commitSha: "a".repeat(40) }, provenance: { analyzer: { name: "fixture", version: "1" }, resolver: { name: "fixture", version: "1" }, configHash: "b".repeat(64) }, files, nodes, edges: [], limitations: [] } as CcmV1;
  return { ccm, sourceCkgHash: "c".repeat(64), sources };
}

function pinnedEmosyncSources(): Record<string, string> {
  const root = fileURLToPath(new URL("../artifacts/semantic/corpora/emosync-backend/", import.meta.url));
  const sources: Record<string, string> = {};
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile() && entry.name.endsWith(".php")) sources[relative(root, absolute).replaceAll("\\", "/")] = readFileSync(absolute, "utf8");
    }
  };
  visit(root);
  return sources;
}

test("Laravel parses literal routes, nested prefix and auth/admin middleware, and restores group scope", () => {
  const input = fixture({
    [ROUTES]: `<?php
// Catatan: mood pengguna dipetakan dari alur yang eksplisit.
use App\\Http\\Controllers\\ProfileController as Profile;
Route::prefix('v1')->middleware('auth:sanctum')->group(function () {
    Route::get('/checkin', [MoodCheckinController::class, 'index']);
    Route::prefix('admin')->middleware('admin')->group(function () {
        Route::post('/dashboard', [AdminDashboardController::class, 'index']);
    });
    Route::match([
        'put',
        'post',
    ], '/settings', [SettingsController::class, 'update']);
});
Route::get('/profile', [Profile::class, 'show'])->middleware('auth:sanctum');
Route::get('/health', [HealthController::class, 'show']);
Route::get('/status', [SystemStatusController::class, 'show']);
`,
    "app/Http/Controllers/MoodCheckinController.php": "<?php class MoodCheckinController { public function index() { return response()->json([]); } }",
    "app/Http/Controllers/AdminDashboardController.php": "<?php class AdminDashboardController { public function index() { return response()->json([]); } }",
    "app/Http/Controllers/SettingsController.php": "<?php class SettingsController { public function update() { return response()->json([]); } }",
    "app/Http/Controllers/ProfileController.php": "<?php namespace App\\Http\\Controllers; class ProfileController { public function show() { return response()->json([]); } }",
    "app/Http/Controllers/HealthController.php": "<?php class HealthController { public function show() { return response()->json([]); } }",
    "app/Http/Controllers/SystemStatusController.php": "<?php class SystemStatusController { public function show() { return response()->json([]); } }",
  });
  const result = extractLaravel(input);
  const routeSteps = result.nodes.filter(node => node.kind === "step");
  assert.deepEqual(routeSteps.map(node => node.label).sort(), ["POST /v1/admin/dashboard", "GET /health", "GET /profile", "GET /status", "GET /v1/checkin", "PUT/POST /v1/settings"].sort());
  const checkin = routeSteps.find(node => node.label.includes("checkin"))!;
  const routeSource = `<?php
// Catatan: mood pengguna dipetakan dari alur yang eksplisit.
use App\\Http\\Controllers\\ProfileController as Profile;
Route::prefix('v1')->middleware('auth:sanctum')->group(function () {
    Route::get('/checkin', [MoodCheckinController::class, 'index']);
    Route::prefix('admin')->middleware('admin')->group(function () {
        Route::post('/dashboard', [AdminDashboardController::class, 'index']);
    });
    Route::match([
        'put',
        'post',
    ], '/settings', [SettingsController::class, 'update']);
});
Route::get('/profile', [Profile::class, 'show'])->middleware('auth:sanctum');
Route::get('/health', [HealthController::class, 'show']);
Route::get('/status', [SystemStatusController::class, 'show']);
`;
  const checkinEvidence = checkin.evidence[0]!;
  const checkinStart = routeSource.indexOf("Route::get('/checkin'");
  const checkinEnd = routeSource.indexOf(";", checkinStart);
  assert.equal(checkinEvidence.startByte, new TextEncoder().encode(routeSource.slice(0, checkinStart)).length, "evidence offsets count UTF-8 bytes after Unicode source text");
  assert.equal(checkinEvidence.endByte, new TextEncoder().encode(routeSource.slice(0, checkinEnd)).length);
  assert.equal(checkinEvidence.startLine, 5);
  const checkinActor = result.edges.find(edge => edge.target === checkin.id)!;
  assert.equal(result.nodes.find(node => node.id === checkinActor.source)?.label, "Authenticated API client");
  const admin = routeSteps.find(node => node.label.includes("dashboard"))!;
  assert.equal(result.nodes.find(node => node.id === result.edges.find(edge => edge.target === admin.id)!.source)?.label, "Administrator API client");
  const health = routeSteps.find(node => node.label === "GET /health")!;
  const statusStep = routeSteps.find(node => node.label === "GET /status")!;
  const healthActor = result.nodes.find(node => node.id === result.edges.find(edge => edge.target === health.id)!.source)!;
  const statusActor = result.nodes.find(node => node.id === result.edges.find(edge => edge.target === statusStep.id)!.source)!;
  assert.equal(healthActor.label, "API client");
  assert.equal(statusActor.id, healthActor.id);
  assert.equal(healthActor.featureId, null, "shared actors are represented through feature node membership, not last-feature ownership");
  assert.ok(result.features.filter(feature => [health.id, statusStep.id].some(id => feature.entryNodeIds.includes(id))).every(feature => feature.nodeIds.includes(healthActor.id)));
  const profile = routeSteps.find(node => node.label === "GET /profile")!;
  assert.equal(result.nodes.find(node => node.id === result.edges.find(edge => edge.target === profile.id)!.source)?.label, "Authenticated API client");
  assert.equal(result.features.find(feature => feature.label === "Mood Checkin")?.entryNodeIds.includes(checkin.id), true);
  assert.equal(result.frameworks.includes("Laravel API"), true);
  assert.equal(isSemanticModel({ schemaVersion: "sage-semantic-v1", extractorVersion: "test", sourceCkgHash: input.sourceCkgHash, snapshot: input.ccm.snapshot, ...result }), true, "the emitted fragment has valid feature nodes, edge endpoints, and evidence spans");
});

test("Laravel resolves match methods and links handler guards, explicit HTTP outcomes, and model operations", () => {
  const controller = `<?php
class MoodCheckinController {
 public function store(Request $request) {
   $request->validate(['mood' => 'required']);
   if (MoodCheckin::whereDate('created_at', today())->exists()) {
     return response()->json(['error' => 'duplicate'], 422);
   }
   MoodCheckin::create(['mood' => $request->mood]);
   return response()->json(['ok' => true]);
 }
 public function unrelated() { if (false) { return response()->json([], 403); } }
}`;
  const input = fixture({
    [ROUTES]: `<?php Route::middleware('auth:sanctum')->group(function () {
    Route::post('/checkin', [MoodCheckinController::class, 'store']);
    Route::get('/history', [MoodHistoryController::class, 'index']);
});`,
    "app/Http/Controllers/MoodCheckinController.php": controller,
    "app/Http/Controllers/MoodHistoryController.php": "<?php class MoodHistoryController { public function index() { return MoodCheckin::first(); } }",
    "app/Models/MoodCheckin.php": "<?php class MoodCheckin extends Model {}",
  });
  const result = extractLaravel(input);
  const decision = result.nodes.find(node => node.kind === "decision" && node.label === "Pemeriksaan data hari ini");
  assert.ok(decision, "the data-existence guard has a readable business label");
  assert.ok(decision.reason.includes("MoodCheckin::whereDate('created_at', today())->exists()"), "the original source condition remains available in the reason and evidence");
  assert.equal(decision.confidence, "proven");
  const status = result.nodes.find(node => node.kind === "outcome" && node.label.includes("422"));
  assert.ok(status, "literal rejection status is represented");
  assert.equal(status.evidence[0]!.filePath, "app/Http/Controllers/MoodCheckinController.php");
  assert.equal(status.evidence[0]!.startLine, 6);
  const stores = result.nodes.filter(node => node.kind === "store");
  assert.equal(stores.length, 1);
  assert.equal(stores[0]!.label, "Mood Checkin");
  assert.equal(stores[0]!.confidence, "proven");
  assert.equal(stores[0]!.featureId, null, "a model used by two features remains shared instead of being owned by the last feature");
  assert.ok(result.features.filter(feature => feature.nodeIds.includes(stores[0]!.id)).length >= 2);
  assert.ok(result.edges.some(edge => edge.target === stores[0]!.id && edge.label === "membaca" && edge.confidence === "proven"), "the duplicate-check query links to the persisted model");
  assert.ok(result.edges.some(edge => edge.source === decision!.id && edge.target === status!.id && edge.confidence === "proven"));
  assert.equal(result.nodes.some(node => node.kind === "outcome" && node.label.includes("403")), false, "unrouted method decisions are not attached to the feature flow");
});

test("Laravel links injected and locally constructed service calls only to a unique accessible source method", () => {
  const input = fixture({
    [ROUTES]: `<?php
use App\\Http\\Controllers\\InjectedController as Injected;
use App\\Http\\Controllers\\LocalController;
use Other\\Http\\Controllers\\ForeignController as LookalikeController;
Route::post('/injected', [Injected::class, 'submit']);
Route::post('/local', [LocalController::class, 'submit']);
Route::post('/lookalike', [LookalikeController::class, 'submit']);
`,
    "app/Http/Controllers/InjectedController.php": `<?php
namespace App\\Http\\Controllers;
use App\\Services\\CheckinService as Checkin;
class InjectedController {
    public function __construct(private Checkin $workflow) {}
    public function submit() { return $this->workflow->record(); }
}`,
    "app/Http/Controllers/LocalController.php": `<?php
namespace App\\Http\\Controllers;
class LocalController {
    public function submit() {
        $service = new \\App\\Services\\LocalCheckinService();
        return $service->record();
    }
}`,
    "app/Http/Controllers/ForeignController.php": `<?php namespace App\\Http\\Controllers; class ForeignController { public function submit() { return true; } }`,
    "app/Services/CheckinService.php": `<?php
namespace App\\Services;
class CheckinService { public function record() { return true; } }`,
    "app/Services/LocalCheckinService.php": `<?php
namespace App\\Services;
class LocalCheckinService { public function record() { return true; } }`,
  });
  const result = extractLaravel(input);
  const calls = result.edges.filter(edge => edge.label === "memanggil layanan");
  assert.equal(calls.length, 2);
  assert.ok(result.nodes.some(node => node.kind === "component" && node.label === "CheckinService@record"));
  assert.ok(result.nodes.some(node => node.kind === "component" && node.label === "LocalCheckinService@record"));
  const lookalikeNode = result.nodes.find(node => node.kind === "component" && node.label === "LookalikeController@submit");
  assert.ok(lookalikeNode);
  assert.ok(lookalikeNode.evidence.every(span => span.filePath === ROUTES), "a same-basename controller in another namespace is not linked by path suffix");
  assert.ok(result.limitations.some(item => item.reason.includes("LookalikeController")));
  for (const edge of calls) {
    assert.equal(edge.confidence, "proven");
    assert.ok(edge.evidence.some(span => span.filePath.includes("Controllers/") && span.role === "reference"));
    assert.ok(edge.evidence.some(span => span.filePath.includes("Services/") && span.role === "declaration"));
  }
  assert.equal(result.limitations.some(item => item.reason.includes("service call")), false);
});

test("Laravel reports unresolved or inaccessible service calls without inventing traversal edges", () => {
  const input = fixture({
    [ROUTES]: `<?php use App\\Http\\Controllers\\SubmissionController; Route::post('/submit', [SubmissionController::class, 'submit']);`,
    "app/Http/Controllers/SubmissionController.php": `<?php
namespace App\\Http\\Controllers;
use App\\Services\\MissingPaymentService;
use App\\Services\\PrivatePaymentService;
use Other\\Services\\ForeignPaymentService;
class SubmissionController {
    public function __construct(private MissingPaymentService $missing, private PrivatePaymentService $private, private ForeignPaymentService $foreign) {}
    public function submit() {
        $this->missing->charge();
        $this->private->charge();
        $this->foreign->charge();
        $this->orphanService->run();
    }
}`,
    "app/Services/PrivatePaymentService.php": `<?php
namespace App\\Services;
class PrivatePaymentService { private function charge() { return true; } }`,
    "app/Services/ForeignPaymentService.php": `<?php
namespace App\\Services;
class ForeignPaymentService { public function charge() { return true; } }`,
    // An import by itself must not become a service node or edge.
    "app/Services/UnusedService.php": `<?php
namespace App\\Services;
class UnusedService { public function run() { return true; } }`,
  });
  const result = extractLaravel(input);
  assert.equal(result.edges.some(edge => edge.label === "memanggil layanan"), false);
  assert.equal(result.nodes.some(node => node.label.includes("Payment Service@charge") || node.label.includes("Unused Service@run")), false);
  assert.ok(result.limitations.some(item => item.reason.includes("MissingPaymentService@charge")));
  assert.ok(result.limitations.some(item => item.reason.includes("PrivatePaymentService@charge")));
  assert.ok(result.limitations.some(item => item.reason.includes("Other\\Services\\ForeignPaymentService@charge")));
  assert.ok(result.limitations.some(item => item.reason.includes("$this->orphanService->run")));
});

test("Laravel only reads HTTP statuses from response status arguments, never numeric payload fields", () => {
  const input = fixture({
    [ROUTES]: `<?php Route::post('/status', [StatusController::class, 'store']);`,
    "app/Http/Controllers/StatusController.php": `<?php class StatusController {
    public function store() {
        if ($invalid) {
            return response()->json(['code' => 401, 'items' => [403, 422]]);
        }
        return response()->json(['code' => 403], 201);
    }
}`,
  });
  const result = extractLaravel(input);
  const outcomes = result.nodes.filter(node => node.kind === "outcome").map(node => node.label);
  assert.ok(outcomes.some(label => label.includes("422")) === false);
  assert.ok(outcomes.some(label => label.includes("201")));
  assert.equal(outcomes.some(label => label.includes("401") || label.includes("403")), false);
});

test("Laravel gives if conditions readable generic labels and preserves their exact source expressions", () => {
  const input = fixture({
    [ROUTES]: `<?php Route::get('/checkin/status', [CheckinStatusController::class, 'show']);`,
    "app/Http/Controllers/CheckinStatusController.php": `<?php class CheckinStatusController {
    public function show($request) {
        if ($hasCheckedToday) { return response()->json([], 409); }
        if ($request->has('mood')) { return response()->json([], 422); }
    }
}`,
  });
  const result = extractLaravel(input);
  const businessDecision = result.nodes.find(node => node.kind === "decision" && node.label === "Periksa Has Checked Today");
  const inputDecision = result.nodes.find(node => node.kind === "decision" && node.label === "Kelengkapan input");
  assert.ok(businessDecision);
  assert.ok(inputDecision);
  assert.ok(businessDecision.reason.includes("$hasCheckedToday"));
  assert.ok(inputDecision.reason.includes("$request->has('mood')"));
  assert.ok(businessDecision.evidence.some(span => span.startLine === 3 && span.endLine === 3));
});

test("Laravel does not resolve an Eloquent model by basename across a wrong or missing import", () => {
  const input = fixture({
    [ROUTES]: `<?php
use App\\Http\\Controllers\\WrongImportController;
use App\\Http\\Controllers\\Api\\NoImportController;
Route::get('/books/wrong-import', [WrongImportController::class, 'index']);
Route::get('/books/no-import', [NoImportController::class, 'index']);
`,
    "app/Http/Controllers/WrongImportController.php": `<?php
namespace App\\Http\\Controllers;
use Other\\Book;
class WrongImportController { public function index() { return Book::all(); } }`,
    "app/Http/Controllers/NoImportController.php": `<?php
namespace App\\Http\\Controllers\\Api;
class NoImportController { public function index() { return Book::all(); } }`,
    "app/Models/Book.php": `<?php
namespace App\\Models;
class Book extends Model {}`,
  });
  const result = extractLaravel(input);
  assert.equal(result.nodes.some(node => node.kind === "store" && node.label === "Book"), false);
  assert.equal(result.edges.some(edge => edge.target.includes("store") && edge.confidence === "proven"), false);
  assert.ok(result.limitations.filter(item => item.reason.includes("Static model reference")).length >= 2);
});

test("the pinned Laravel corpus resolves route aliases, guards, check-in outcomes, and Eloquent data", () => {
  const input = fixture(pinnedEmosyncSources());
  const result = extractLaravel(input);
  const steps = result.nodes.filter(node => node.kind === "step");
  assert.ok(steps.length >= 40, `expected the literal API routes from the corpus; parsed ${steps.length}`);
  const controllerSourceNodes = result.nodes.filter(node => node.kind === "component" && node.label.includes("@") && node.evidence.some(span => span.filePath.startsWith("app/Http/Controllers/")));
  assert.ok(controllerSourceNodes.length >= 20, `expected controller evidence beyond route declarations; resolved ${controllerSourceNodes.length} components`);
  assert.equal(result.limitations.some(item => item.reason.startsWith("Controller ") && item.reason.includes("belum dapat diselesaikan")), false, "all literal imported controller classes in the pinned corpus resolve to source");
  const findStep = (label: string) => steps.find(node => node.label === label);
  const register = findStep("POST /register")!, login = findStep("POST /login")!;
  assert.ok(register && login);
  const actorFor = (stepId: string) => result.nodes.find(node => node.id === result.edges.find(edge => edge.target === stepId)?.source);
  assert.equal(actorFor(register.id)?.label, "API client");
  assert.equal(actorFor(login.id)?.label, "API client");
  const checkin = findStep("POST /checkin")!;
  assert.ok(checkin);
  assert.equal(actorFor(checkin.id)?.label, "Authenticated API client");
  assert.ok(result.nodes.some(node => node.kind === "component" && node.label === "MoodCheckinController@store"));
  assert.ok(result.nodes.find(node => node.kind === "component" && node.label === "MoodCheckinController@store")?.evidence.some(span => span.filePath.endsWith("MoodCheckinController.php")), "the imported FQCN resolves to its actual controller source file");
  assert.ok(result.nodes.find(node => node.kind === "component" && node.label === "AuthController@login")?.evidence.some(span => span.filePath.endsWith("AuthController.php")));
  const model = result.nodes.find(node => node.kind === "store" && node.label === "Mood Checkin");
  assert.ok(model, "the direct Eloquent operations resolve to the model declaration");
  assert.ok(result.nodes.some(node => node.kind === "outcome" && node.label.includes("422")));
  const adminDashboard = findStep("GET /admin/dashboard")!;
  assert.ok(adminDashboard);
  const adminActor = actorFor(adminDashboard.id)!;
  assert.equal(adminActor?.label, "Administrator API client");
  assert.equal(adminActor?.confidence, "proven", `the bootstrap alias and explicit middleware guard prove the admin boundary: ${adminActor?.reason}; ${result.limitations.filter(item => item.reason.toLowerCase().includes("admin")).map(item => item.reason).join(" | ")}`);
  assert.equal(result.edges.find(edge => edge.source === adminActor.id && edge.target === adminDashboard.id)?.confidence, "proven");
  const adminMiddleware = result.nodes.find(node => node.kind === "component" && node.label === "AdminMiddleware@handle");
  assert.ok(adminMiddleware, "the configured Laravel middleware resolves to its handle method");
  const adminDecision = result.nodes.find(node => node.kind === "decision" && node.evidence.some(span => span.filePath.endsWith("AdminMiddleware.php")));
  assert.equal(adminDecision?.label, "Pemeriksaan izin administrator");
  assert.ok(adminDecision?.reason.includes("$request->user()->is_admin"));
  assert.ok(result.nodes.some(node => node.kind === "outcome" && node.label.includes("403") && node.evidence.some(span => span.filePath.endsWith("AdminMiddleware.php"))));
  const adminContinuation = result.edges.find(edge => edge.source === adminMiddleware.id && edge.target === result.nodes.find(node => node.kind === "component" && node.label === "AdminDashboardController@index")?.id && edge.label === "meneruskan permintaan ke");
  assert.ok(adminContinuation, "the middleware's $next call is connected to the statically routed controller");
  assert.ok(adminContinuation.evidence.some(span => span.filePath.endsWith("bootstrap/app.php")));
  assert.ok(adminContinuation.evidence.some(span => span.filePath.endsWith("AdminMiddleware.php")));
  assert.equal(result.nodes.some(node => node.kind === "component" && /frontend|screen|page/iu.test(node.label)), false, "backend source must not produce fictional interface nodes");
  assert.ok(result.limitations.some(item => item.filePath === ROUTES && item.reason.includes("Prefix runtime routes/api.php")));
});

test("an unresolved admin alias is indicated and does not invent a verified middleware flow", () => {
  const input = fixture({
    [ROUTES]: `<?php Route::middleware('admin')->group(function () { Route::get('/admin/report', [ReportController::class, 'index']); });`,
    "app/Http/Controllers/ReportController.php": `<?php class ReportController { public function index() { return []; } }`,
    "bootstrap/app.php": `<?php $middleware->alias(array_merge(['admin' => \\App\\Http\\Middleware\\AdminMiddleware::class], $runtimeAliases));`,
    "app/Http/Middleware/AdminMiddleware.php": `<?php namespace App\\Http\\Middleware; class AdminMiddleware { public function handle($request, $next) { if (!$request->user() || !$request->user()->is_admin) { return response()->json([], 403); } return $next($request); } }`,
  });
  const result = extractLaravel(input);
  const route = result.nodes.find(node => node.kind === "step")!;
  const actor = result.nodes.find(node => result.edges.some(edge => edge.source === node.id && edge.target === route.id));
  assert.equal(actor?.confidence, "indicated");
  assert.equal(result.nodes.some(node => node.kind === "component" && node.label === "AdminMiddleware@handle"), false);
  assert.equal(result.edges.some(edge => edge.label === "meneruskan permintaan ke"), false);
  assert.ok(result.limitations.some(item => item.reason.includes("Middleware alias admin")));
});

test("legacy Laravel Kernel middleware aliases resolve imported classes from a static array", () => {
  const input = fixture({
    [ROUTES]: `<?php Route::middleware('admin')->group(function () { Route::get('/admin/report', [ReportController::class, 'index']); });`,
    "app/Http/Controllers/ReportController.php": `<?php class ReportController { public function index() { return []; } }`,
    "app/Http/Kernel.php": `<?php namespace App\\Http; use App\\Http\\Middleware\\StaffMiddleware as Staff; class Kernel { protected $middlewareAliases = ['admin' => Staff::class]; }`,
    "app/Http/Middleware/StaffMiddleware.php": `<?php namespace App\\Http\\Middleware; class StaffMiddleware { public function handle($request, $next) { if (!$request->user() || !$request->user()->is_admin) { return response()->json([], 403); } return $next($request); } }`,
  });
  const result = extractLaravel(input);
  assert.ok(result.nodes.some(node => node.kind === "component" && node.label === "StaffMiddleware@handle"));
  assert.ok(result.edges.some(edge => edge.label === "meneruskan permintaan ke" && edge.evidence.some(span => span.filePath === "app/Http/Kernel.php")));
  assert.equal(result.nodes.find(node => node.kind === "actor")?.confidence, "proven");
});

test("middleware does not claim controller forwarding when $next is nested in the rejecting branch", () => {
  const input = fixture({
    [ROUTES]: `<?php Route::middleware('admin')->group(function () { Route::get('/admin/report', [ReportController::class, 'index']); });`,
    "app/Http/Controllers/ReportController.php": `<?php class ReportController { public function index() { return []; } }`,
    "bootstrap/app.php": `<?php $middleware->alias(['admin' => \\App\\Http\\Middleware\\BrokenAdminMiddleware::class]);`,
    "app/Http/Middleware/BrokenAdminMiddleware.php": `<?php namespace App\\Http\\Middleware; class BrokenAdminMiddleware { public function handle($request, $next) { if (!$request->user() || !$request->user()->is_admin) { return response()->json([], 403); $next($request); } } }`,
  });
  const result = extractLaravel(input);
  assert.equal(result.nodes.find(node => node.kind === "actor")?.confidence, "proven", "the explicit denial guard remains evidenced");
  assert.equal(result.edges.some(edge => edge.label === "meneruskan permintaan ke"), false, "the nested $next call is unreachable after the branch return");
  assert.ok(result.limitations.some(item => item.reason.includes("tidak memiliki pemanggilan $next($request)")));
});

test("aggregate evidence stays compact for one hundred and one literal routes", () => {
  const routeLines = Array.from({ length: 101 }, (_, index) => `Route::get('/records/${index}', [RecordController::class, 'index']);`).join("\n");
  const input = fixture({
    [ROUTES]: `<?php\n${routeLines}`,
    "app/Http/Controllers/RecordController.php": `<?php class RecordController { public function index() { return []; } }`,
  });
  const fragment = extractLaravel(input);
  const model = { schemaVersion: "sage-semantic-v1", extractorVersion: "test", sourceCkgHash: input.sourceCkgHash, snapshot: input.ccm.snapshot, ...fragment };
  assert.equal(fragment.nodes.filter(node => node.kind === "step").length, 101);
  assert.ok(fragment.features.every(feature => feature.evidence.length === 1));
  assert.ok(fragment.nodes.filter(node => node.kind === "actor").every(node => node.evidence.length === 1));
  const routeEdges = fragment.edges.filter(edge => edge.label === "menerima permintaan dari" || edge.label === "menjalankan");
  assert.equal(routeEdges.length, 202);
  assert.ok(routeEdges.every(edge => edge.evidence.length === 1), "each route relationship keeps its own exact evidence range");
  assert.equal(isSemanticModel(model), true, "aggregate evidence is compact while each route edge keeps its exact source span");
});

test("route-like text/comments are ignored and dynamic declarations remain explicit limitations", () => {
  const input = fixture({
    [ROUTES]: `<?php
// Route::post('/fake', [FakeController::class, 'save']);
$example = "Route::get('/also-fake', [FakeController::class, 'show'])";
Route::get($dynamicPath, [DynamicController::class, 'show']);
Route::post('/real', $controllerCallable);
`,
  });
  const result = extractLaravel(input);
  assert.equal(result.nodes.filter(node => node.kind === "step").length, 0);
  assert.equal(result.nodes.some(node => node.label.includes("fake")), false);
  assert.ok(result.limitations.some(item => item.reason.includes("dinamis")));
  const textOnly = fixture({ [ROUTES]: `<?php
// Route::get('/comment', [CommentController::class, 'index']);
$example = "Route::get('/string', [StringController::class, 'index'])";
` });
  const ignored = extractLaravel(textOnly);
  assert.equal(ignored.nodes.length, 0);
  assert.equal(ignored.limitations.length, 0, "quoted/commented route-like text is not treated as an unsupported declaration");
});

test("unsupported route groups do not cause invented controller flows", () => {
  const input = fixture({
    [ROUTES]: `<?php
Route::middleware($configuredMiddleware)->group(function () {
    Route::get('/private', [PrivateController::class, 'show']);
});
Route::prefix($dynamicPrefix)->group(function () {
    Route::get('/hidden', [HiddenController::class, 'show']);
});`,
    // A dynamic exclusion can remove the known inherited authentication middleware.
    "routes/web.php": `<?php Route::middleware('auth:sanctum')->group(function () {
    Route::get('/maybe-public', [ProfileController::class, 'show'])->withoutMiddleware($runtimeMiddleware);
});`,
    "routes/admin.php": `<?php Route::group($runtimeGroupOptions, function () {
    Route::get('/unknown-scope', [AdminController::class, 'index']);
});`,
    "routes/role.php": `<?php Route::middleware('role:admin')->group(function () {
    Route::get('/role/reports', [RoleReportController::class, 'index']);
});`,
    "app/Http/Controllers/RoleReportController.php": `<?php class RoleReportController { public function index() { return []; } }`,
  });
  const result = extractLaravel(input);
  const steps = result.nodes.filter(node => node.kind === "step");
  assert.deepEqual(steps.map(node => node.label).sort(), ["GET /maybe-public", "GET /private", "GET /role/reports"].sort());
  assert.equal(result.nodes.some(node => node.label === "GET /hidden"), false, "a dynamic prefix must not be omitted from the path while still showing a false route");
  assert.equal(result.nodes.some(node => node.label === "GET /unknown-scope"), false, "dynamic group attributes must not be rendered as an unprefixed route");
  assert.equal(result.nodes.some(node => node.kind === "actor" && node.label === "Authenticated API client"), false, "unknown middleware modifications must not be treated as explicit authentication");
  const roleStep = steps.find(node => node.label === "GET /role/reports")!;
  assert.equal(result.nodes.find(node => result.edges.some(edge => edge.target === roleStep.id && edge.source === node.id))?.label, "API client", "a role parameter is not a Laravel middleware alias named admin");
  const actor = result.nodes.find(node => node.kind === "actor")!;
  assert.equal(actor.label, "API client", "unknown middleware must not be treated as explicit public access");
  assert.ok(result.limitations.some(item => item.reason.includes("middleware dinamis")));
  assert.ok(result.limitations.some(item => item.reason.includes("prefix dinamis")));
});
