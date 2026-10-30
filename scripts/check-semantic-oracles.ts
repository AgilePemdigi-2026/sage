import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

type Evidence = {
  filePath: string;
  fileSha256: string;
  startLine: number;
  endLine: number;
};
type Fact = {
  id: string;
  kind: string;
  label: string;
  confidence?: string;
  reason?: string;
  source?: string;
  target?: string;
  evidence: Evidence[];
};
type Model = {
  schemaVersion: string;
  extractorVersion: string;
  sourceCkgHash: string;
  snapshot: { repository: string; commitSha: string };
  nodes: Fact[];
  edges: Fact[];
  features: Fact[];
  limitations?: Array<{ filePath: string; reason: string }>;
};
type OracleFlow = {
  name: string;
  evidence: string[];
  negative: string;
};
type OracleSnapshot = {
  repository: string;
  requestedRepository?: string;
  commit: string;
  flows: OracleFlow[];
};
type CheckResult = {
  id: string;
  passed: boolean;
  detail: string;
  factIds?: string[];
};
type EvidenceResult = {
  reference: string;
  passed: boolean;
  matchingFactIds: string[];
  sourceSha256?: string;
  detail?: string;
};
type SnapshotResult = {
  repository: string;
  commit: string;
  modelFile: string;
  modelLoaded: boolean;
  counts?: { nodes: number; edges: number; features: number; limitations: number };
  evidence: Array<{ flow: string; items: EvidenceResult[] }>;
  checks: CheckResult[];
};

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const oraclePath = resolve(root, "docs/evidence/semantic/oracle.json");
const corpusRoot = resolve(root, "artifacts/semantic/corpora");
const disclaimer =
  "Static snapshot oracle: checks verify source evidence coverage and bounded semantic claims; they do not execute the repositories or prove runtime behavior.";

function within(base: string, candidate: string): boolean {
  const relativePath = relative(base, candidate);
  return relativePath !== "" && relativePath !== ".." &&
    !relativePath.startsWith(".." + sep) && !isAbsolute(relativePath);
}

function parseEvidenceReference(reference: string): { path: string; startLine: number; endLine: number } | null {
  const match = /^(.*):(\d+)-(\d+)$/.exec(reference);
  if (!match) return null;
  const startLine = Number(match[2]);
  const endLine = Number(match[3]);
  if (!match[1] || !Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine) ||
    startLine < 1 || endLine < startLine) return null;
  return { path: match[1], startLine, endLine };
}

function spansOverlap(span: Evidence, startLine: number, endLine: number): boolean {
  return span.startLine <= endLine && span.endLine >= startLine;
}

function textOf(fact: Fact): string {
  return [fact.label, fact.reason ?? ""].join(" ");
}

function factsOf(model: Model): Fact[] {
  return [...model.nodes, ...model.edges, ...model.features.map((feature) => ({ ...feature, kind: "feature" }))];
}

function factsAt(model: Model, path: string, startLine: number, endLine: number): Fact[] {
  return factsOf(model).filter((fact) => fact.evidence.some((span) =>
    span.filePath === path && spansOverlap(span, startLine, endLine)));
}

function factEvidenceAt(fact: Fact, path: string, startLine: number, endLine: number): Evidence[] {
  return fact.evidence.filter((span) =>
    span.filePath === path && spansOverlap(span, startLine, endLine));
}

function nodesAt(model: Model, path: string, startLine: number, endLine: number, kind?: string): Fact[] {
  return model.nodes.filter((node) => (kind === undefined || node.kind === kind) &&
    factEvidenceAt(node, path, startLine, endLine).length > 0);
}

function edgesAt(model: Model, path: string, startLine: number, endLine: number): Fact[] {
  return model.edges.filter((edge) => factEvidenceAt(edge, path, startLine, endLine).length > 0);
}

function endpoint(model: Model, id: string | undefined): Fact | undefined {
  return id ? model.nodes.find((node) => node.id === id) : undefined;
}

function addCheck(result: SnapshotResult, id: string, passed: boolean, detail: string, factIds: string[] = []): void {
  result.checks.push({ id, passed, detail, ...(factIds.length ? { factIds: [...new Set(factIds)] } : {}) });
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function readCorpusFile(repository: string, relativePath: string): Promise<Buffer | null> {
  const slug = repository.split("/").at(-1);
  if (!slug || relativePath.startsWith("/") || relativePath.split("/").includes("..")) return null;
  const corpus = resolve(corpusRoot, slug);
  const candidate = resolve(corpus, relativePath);
  if (!within(corpus, candidate)) return null;
  try {
    return await readFile(candidate);
  } catch {
    return null;
  }
}

async function verifyEvidenceReference(repository: string, model: Model | null, reference: string): Promise<EvidenceResult> {
  const parsed = parseEvidenceReference(reference);
  if (!parsed) return { reference, passed: false, matchingFactIds: [], detail: "Malformed oracle evidence reference." };
  const bytes = await readCorpusFile(repository, parsed.path);
  if (!bytes) return { reference, passed: false, matchingFactIds: [], detail: "Pinned source file is missing." };
  const hash = createHash("sha256").update(bytes).digest("hex");
  const lineCount = bytes.toString("utf8").split(/\r?\n/).length;
  if (parsed.endLine > lineCount) {
    return {
      reference,
      passed: false,
      matchingFactIds: [],
      sourceSha256: hash,
      detail: "Oracle line range exceeds the pinned source file.",
    };
  }
  if (!model) {
    return { reference, passed: false, matchingFactIds: [], sourceSha256: hash, detail: "Semantic model is unavailable." };
  }
  const matches = factsOf(model).filter((fact) => fact.evidence.some((span) =>
    span.filePath === parsed.path &&
    span.fileSha256 === hash &&
    spansOverlap(span, parsed.startLine, parsed.endLine)));
  return {
    reference,
    passed: matches.length > 0,
    matchingFactIds: matches.slice(0, 12).map((fact) => fact.id),
    sourceSha256: hash,
    ...(matches.length ? {} : { detail: "No fact has the same path and source hash with an overlapping line range." }),
  };
}

async function verifySnapshotFiles(snapshot: OracleSnapshot): Promise<{
  corpus: Record<string, unknown> | null;
  model: Model | null;
  modelFile: string;
  sourceSnapshotFile: string;
}> {
  const slug = snapshot.repository.split("/").at(-1) ?? "unknown";
  const corpusPath = resolve(corpusRoot, slug);
  const modelFile = slug + "-semantic.json";
  const sourceSnapshotFile = resolve(corpusPath, ".snapshot.json");
  let corpus: Record<string, unknown> | null = null;
  let model: Model | null = null;
  try {
    corpus = await readJson<Record<string, unknown>>(sourceSnapshotFile);
  } catch {
    // A missing corpus snapshot is reported by the caller.
  }
  try {
    model = await readJson<Model>(resolve(activeModelDirectory, modelFile));
  } catch {
    // A missing/unreadable model is reported by the caller.
  }
  return { corpus, model, modelFile, sourceSnapshotFile };
}

function checkPerpus(result: SnapshotResult, model: Model): void {
  const pagePath = "src/app/catalog/page.tsx";
  const catalogueEdges = model.edges.filter((edge) =>
    /GET\s+\/api\/books/.test(edge.label) && factEvidenceAt(edge, pagePath, 26, 83).length > 0);
  addCheck(
    result,
    "perpus.catalog.page-load-books",
    catalogueEdges.length > 0,
    catalogueEdges.length ? "Catalog page is linked to the literal GET /api/books call." : "No catalog-page edge to GET /api/books was found.",
    catalogueEdges.map((edge) => edge.id),
  );

  const booksReadPath = "src/app/api/books/route.ts";
  const getFacts = factsAt(model, booksReadPath, 5, 41);
  const inventedAdminGate = getFacts.filter((fact) =>
    (fact.kind === "decision" || fact.kind === "actor" || fact.kind === "step") &&
    /admin|administrator|administrator|izin administrator/i.test(textOf(fact)));
  addCheck(
    result,
    "perpus.catalog.no-invented-admin-gate",
    inventedAdminGate.length === 0,
    inventedAdminGate.length ? "An admin/administrator claim is attached to the public-or-user GET handler." : "No admin-only claim is attached to the GET handler; POST rules are out of scope.",
    inventedAdminGate.map((fact) => fact.id),
  );

  const bulkPath = "src/app/api/bookings/bulk/route.ts";
  const bulkWrites = edgesAt(model, bulkPath, 20, 70);
  const bookingWrites = bulkWrites.filter((edge) =>
    /menyimpan|membuat|menulis|mencatat/i.test(edge.label) &&
    endpoint(model, edge.target)?.kind === "store" &&
    /booking/i.test(endpoint(model, edge.target)?.label ?? ""));
  const stockWrites = bulkWrites.filter((edge) =>
    /mengubah|menyimpan|membuat|menulis/i.test(edge.label) &&
    endpoint(model, edge.target)?.kind === "store" &&
    /^book$/i.test(endpoint(model, edge.target)?.label ?? ""));
  addCheck(
    result,
    "perpus.booking.creates-booking",
    bookingWrites.length > 0,
    bookingWrites.length ? "Bulk booking has a source-backed write to the Booking store." : "No source-backed Booking write relation was found.",
    bookingWrites.map((edge) => edge.id),
  );
  addCheck(
    result,
    "perpus.booking.decrements-book-stock",
    stockWrites.length > 0,
    stockWrites.length ? "Bulk booking has a source-backed Book update relation." : "No source-backed Book update relation was found.",
    stockWrites.map((edge) => edge.id),
  );

  const loanWrites = bulkWrites.filter((edge) =>
    /menyimpan|membuat|mengubah|menulis|mencatat|writes|creates|updates/i.test(edge.label) &&
    /loan|pinjaman|transaction/i.test(endpoint(model, edge.target)?.label ?? ""));
  addCheck(
    result,
    "perpus.booking.not-immediate-loan",
    loanWrites.length === 0,
    loanWrites.length ? "Bulk booking is represented as writing a loan/transaction." : "Bulk booking has no loan/transaction write; transaction counts remain reads.",
    loanWrites.map((edge) => edge.id),
  );

  const borrowPath = "src/app/api/transactions/borrow/route.ts";
  const borrowDecisions = nodesAt(model, borrowPath, 7, 12, "decision").filter((node) =>
    /admin|administrator|role|peran/i.test(textOf(node)));
  const borrowAdminFailures = nodesAt(model, borrowPath, 7, 14, "outcome").filter((node) =>
    /403|hanya admin|administrator/i.test(textOf(node)));
  addCheck(
    result,
    "perpus.direct-borrow.admin-guard",
    borrowDecisions.length > 0 && borrowAdminFailures.length > 0,
    borrowDecisions.length > 0 && borrowAdminFailures.length > 0
      ? "The direct-borrow endpoint has a role/admin decision and a denied outcome."
      : "The direct-borrow role guard or denied outcome is absent from the model.",
    [...borrowDecisions, ...borrowAdminFailures].map((node) => node.id),
  );

  const ebookPath = "src/app/api/ebooks/rent/route.ts";
  const ebookStep = nodesAt(model, ebookPath, 5, 43, "step").filter((node) => /POST\s+\/api\/ebooks\/rent/.test(node.label));
  const ebookWrites = edgesAt(model, ebookPath, 5, 43).filter((edge) =>
    /menyimpan|membuat|menulis/i.test(edge.label) &&
    endpoint(model, edge.target)?.kind === "store" &&
    /ebook rental/i.test(endpoint(model, edge.target)?.label ?? ""));
  const unlimitedClaims = factsAt(model, ebookPath, 5, 43).filter((fact) =>
    /unlimited|tidak terbatas|tanpa batas|selamanya|seumur hidup|permanen/i.test(textOf(fact)));
  const unsupportedEligibility = factsAt(model, ebookPath, 5, 43).filter((fact) =>
    /premium|berbayar|langganan|subscription|umur minimum|minimum age/i.test(textOf(fact)));
  addCheck(
    result,
    "perpus.ebook.rent-record",
    ebookStep.length > 0 && ebookWrites.length > 0,
    ebookStep.length > 0 && ebookWrites.length > 0 ? "E-book rental endpoint and Rental write are represented." : "The rent endpoint or Ebook Rental write is missing.",
    [...ebookStep, ...ebookWrites].map((fact) => fact.id),
  );
  addCheck(
    result,
    "perpus.ebook.no-unlimited-or-invented-eligibility",
    unlimitedClaims.length === 0 && unsupportedEligibility.length === 0,
    unlimitedClaims.length || unsupportedEligibility.length
      ? "The rent flow contains an unsupported unlimited-duration or eligibility claim."
      : "No unlimited-duration or premium/age eligibility claim is attached to the rent source.",
    [...unlimitedClaims, ...unsupportedEligibility].map((fact) => fact.id),
  );
}

async function stageDefinitions(repository: string): Promise<Array<{ key: string; label: string; line: number }>> {
  const path = "packages/contracts/src/stages.ts";
  const bytes = await readCorpusFile(repository, path);
  if (!bytes) return [];
  const lines = bytes.toString("utf8").split(/\r?\n/);
  const output: Array<{ key: string; label: string; line: number }> = [];
  for (const [index, line] of lines.entries()) {
    const match = /\{\s*sequence:\s*\d+,\s*key:\s*"([^"]+)",\s*label:\s*"([^"]+)"/.exec(line);
    if (match) output.push({ key: match[1], label: match[2], line: index + 1 });
  }
  return output;
}

async function checkImportOnlyProvenEdges(repository: string, model: Model): Promise<Fact[]> {
  const importLines = new Map<string, Set<number>>();
  for (const path of [
    "apps/web/lib/github/target-handlers.ts",
    "apps/web/lib/github/submission-handlers.ts",
    "packages/contracts/src/stages.ts",
  ]) {
    const bytes = await readCorpusFile(repository, path);
    if (!bytes) continue;
    const lines = bytes.toString("utf8").split(/\r?\n/);
    importLines.set(path, new Set(lines.flatMap((line, index) =>
      /^\s*import\b/.test(line) ? [index + 1] : [])));
  }
  const nodeById = new Map(model.nodes.map((node) => [node.id, node]));
  return model.edges.filter((edge) => {
    if (edge.confidence !== "proven" || edge.evidence.length === 0) return false;
    const source = nodeById.get(edge.source ?? "");
    const target = nodeById.get(edge.target ?? "");
    if (!source || !target || !["step", "decision", "outcome", "feature"].includes(source.kind) ||
      !["step", "decision", "outcome", "feature"].includes(target.kind)) return false;
    return edge.evidence.every((span) => importLines.get(span.filePath)?.has(span.startLine) === true &&
      importLines.get(span.filePath)?.has(span.endLine) === true);
  });
}

async function checkSage(result: SnapshotResult, model: Model, repository: string): Promise<void> {
  const loginPath = "apps/web/app/login/page.tsx";
  const oauthPath = "apps/web/app/auth/github/route.ts";
  const oauthEdges = model.edges.filter((edge) =>
    /POST\s+\/auth\/github/.test(edge.label) && factEvidenceAt(edge, loginPath, 33, 45).length > 0);
  addCheck(
    result,
    "sage.login.starts-github-oauth",
    oauthEdges.length > 0,
    oauthEdges.length ? "The login submit action links to the GitHub OAuth-start endpoint." : "The login submit action is not linked to POST /auth/github.",
    oauthEdges.map((edge) => edge.id),
  );

  const successAfterOAuth = nodesAt(model, oauthPath, 7, 15, "outcome").filter((node) =>
    /login berhasil|berhasil login|authorization complete|authorized successfully|autentikasi berhasil/i.test(textOf(node)));
  addCheck(
    result,
    "sage.oauth-start-is-not-login-success",
    successAfterOAuth.length === 0,
    successAfterOAuth.length ? "OAuth start is represented as a completed login/authorization." : "OAuth start is not claimed to prove successful authorization.",
    successAfterOAuth.map((node) => node.id),
  );

  const definitions = await stageDefinitions(repository);
  const stagePath = "packages/contracts/src/stages.ts";
  const stageNodes = model.nodes.filter((node) => node.kind === "concept" &&
    factEvidenceAt(node, stagePath, 1, 12).length > 0);
  const missingStages = definitions.filter((definition) => !stageNodes.some((node) =>
    node.label === definition.label &&
    factEvidenceAt(node, stagePath, definition.line, definition.line).length > 0));
  addCheck(
    result,
    "sage.pipeline-all-declared-stages",
    definitions.length === 9 && missingStages.length === 0,
    definitions.length !== 9
      ? "The pinned stage catalog did not parse as the expected nine explicit declarations."
      : missingStages.length
        ? "Missing stage concepts grounded at declarations: " + missingStages.map((stage) => stage.key).join(", ")
        : "All nine stage concepts are represented with evidence on their declaration lines.",
    stageNodes.map((node) => node.id),
  );

  const targetPath = "apps/web/lib/github/target-handlers.ts";
  const submissionPath = "apps/web/lib/github/submission-handlers.ts";
  const targetEntries = [...nodesAt(model, targetPath, 1, 120, "step"),
    ...nodesAt(model, targetPath, 1, 120, "component")].filter((node) =>
    /\/api\/repositories\/(target|branches)|^(Target|Branches) API$/i.test(node.label));
  const submissionEntries = [...nodesAt(model, submissionPath, 1, 100, "step"),
    ...nodesAt(model, submissionPath, 1, 100, "component")].filter((node) =>
    /\/api\/analyses|^Analyses API$/i.test(node.label));
  addCheck(
    result,
    "sage.target-and-analysis-entrypoints",
    targetEntries.length > 0 && submissionEntries.length > 0,
    targetEntries.length > 0 && submissionEntries.length > 0
      ? "Target resolution and analysis submission entrypoints have source-backed semantic facts."
      : "Target resolution or submission entrypoint is missing from the semantic model.",
    [...targetEntries, ...submissionEntries].map((node) => node.id),
  );

  const sessionDecisions = [...nodesAt(model, targetPath, 1, 120, "decision"),
    ...nodesAt(model, submissionPath, 1, 100, "decision")].filter((node) =>
    /session|sesi|authentication|autentikasi/i.test(textOf(node)));
  addCheck(
    result,
    "sage.target-resolution-requires-session",
    sessionDecisions.length > 0,
    sessionDecisions.length ? "A session/authentication decision is represented on target or submission handlers." : "No session/authentication decision is represented on target/submission handlers.",
    sessionDecisions.map((node) => node.id),
  );

  const importOnlyEdges = await checkImportOnlyProvenEdges(repository, model);
  addCheck(
    result,
    "sage.no-proven-flow-from-imports",
    importOnlyEdges.length === 0,
    importOnlyEdges.length ? "A proven semantic flow edge is supported only by import-line evidence." : "No proven semantic flow edge is based only on import-line evidence.",
    importOnlyEdges.map((edge) => edge.id),
  );

  const exportPath = "apps/web/lib/exports/handlers.ts";
  const exportPostFacts = factsAt(model, exportPath, 84, 127);
  const queuedFacts = exportPostFacts.filter((fact) =>
    /enqueue|queued|queue|antre|antrean|202/.test(textOf(fact).toLowerCase()));
  addCheck(
    result,
    "sage.export-represents-queued-result",
    queuedFacts.length > 0,
    queuedFacts.length ? "Export submission includes a queued/202 result in its evidence-backed model facts." : "No queued/202 result is represented for the export submission handler.",
    queuedFacts.map((fact) => fact.id),
  );
  const falseDownloadClaims = exportPostFacts.filter((fact) =>
    /unduh berhasil|berhasil diunduh|download complete|downloaded successfully|file sudah diunduh/i.test(textOf(fact)));
  addCheck(
    result,
    "sage.export-queue-is-not-download",
    falseDownloadClaims.length === 0,
    falseDownloadClaims.length ? "The export queue handler is claimed to have downloaded the artifact." : "The queue handler is not described as a completed download.",
    falseDownloadClaims.map((fact) => fact.id),
  );
}

function checkEmosync(result: SnapshotResult, model: Model): void {
  const apiPath = "routes/api.php";
  const loginSteps = nodesAt(model, apiPath, 18, 25, "step").filter((node) => /POST\s+\/login/.test(node.label));
  const checkinSteps = nodesAt(model, apiPath, 35, 42, "step").filter((node) => /POST\s+\/checkin/.test(node.label));
  addCheck(
    result,
    "emosync.api-login-and-mood-entrypoints",
    loginSteps.length > 0 && checkinSteps.length > 0,
    loginSteps.length > 0 && checkinSteps.length > 0
      ? "Login and mood-check-in API entrypoints are represented from the route declarations."
      : "Login or mood-check-in API entrypoint is missing.",
    [...loginSteps, ...checkinSteps].map((node) => node.id),
  );

  const moodPath = "app/Http/Controllers/Api/MoodCheckinController.php";
  const duplicateOutcomes = nodesAt(model, moodPath, 40, 51, "outcome").filter((node) =>
    /already.*check.?in|sudah melakukan check-in hari ini/i.test(textOf(node)));
  const duplicateResponseHas422 = duplicateOutcomes.some((node) =>
    factEvidenceAt(node, moodPath, 40, 51).some((span) => span.startLine <= 49 && span.endLine >= 49));
  addCheck(
    result,
    "emosync.duplicate-checkin-is-422-failure",
    duplicateOutcomes.length > 0 && duplicateResponseHas422,
    duplicateOutcomes.length > 0 && duplicateResponseHas422
      ? "The same-day duplicate outcome is backed by evidence spanning the HTTP 422 response."
      : "The same-day duplicate outcome or its 422 response evidence is missing.",
    duplicateOutcomes.map((node) => node.id),
  );
  const duplicateSuccesses = factsAt(model, moodPath, 40, 51).filter((fact) =>
    (fact.kind === "outcome" || fact.kind === "edge") &&
    /201|created successfully|berhasil disimpan|check-in berhasil|respons selesai/i.test(textOf(fact)));
  addCheck(
    result,
    "emosync.duplicate-checkin-not-success",
    duplicateSuccesses.length === 0,
    duplicateSuccesses.length ? "The duplicate-day branch is also represented as successful creation." : "The duplicate-day branch is not represented as successful creation.",
    duplicateSuccesses.map((fact) => fact.id),
  );

  const adminPath = "app/Http/Middleware/AdminMiddleware.php";
  const adminDecisions = nodesAt(model, adminPath, 11, 18, "decision").filter((node) =>
    /admin|administrator|is_admin/i.test(textOf(node)));
  const adminFailures = nodesAt(model, adminPath, 13, 18, "outcome").filter((node) =>
    /unauthorized|admin access required|forbidden|403/i.test(textOf(node)));
  const adminGuardEdges = edgesAt(model, adminPath, 11, 18).filter((edge) =>
    /jika kondisi terpenuhi|fails if condition/i.test(edge.label) &&
    adminDecisions.some((decision) => edge.source === decision.id) &&
    adminFailures.some((failure) => edge.target === failure.id));
  addCheck(
    result,
    "emosync.admin-requires-admin-role-and-403",
    adminDecisions.length > 0 && adminFailures.length > 0 && adminGuardEdges.length > 0,
    adminDecisions.length > 0 && adminFailures.length > 0 && adminGuardEdges.length > 0
      ? "The explicit administrator condition leads to the denied outcome backed by the 403 response."
      : "The explicit admin decision, denied outcome, or their evidence-backed relation is missing.",
    [...adminDecisions, ...adminFailures, ...adminGuardEdges].map((fact) => fact.id),
  );

  const frontendWords = /\b(page|screen|button|form|frontend|front-end)\b|halaman|layar|tombol|formulir/i;
  const backendFrontendClaims = model.nodes.filter((node) =>
    (node.kind === "component" || node.kind === "step") &&
    frontendWords.test(node.label) &&
    node.evidence.some((span) => span.filePath.endsWith(".php") && (
      span.filePath.startsWith("routes/") ||
      span.filePath.startsWith("app/Http/Controllers/Api/") ||
      span.filePath.startsWith("app/Http/Middleware/")
    )));
  addCheck(
    result,
    "emosync.no-invented-frontend",
    backendFrontendClaims.length === 0,
    backendFrontendClaims.length ? "Backend route/controller evidence is used to claim a frontend screen or interaction." : "Backend route/controller evidence does not claim frontend screens or navigation.",
    backendFrontendClaims.map((node) => node.id),
  );
}

async function main(): Promise<void> {
  const modelDirectoryArgument = process.argv[2];
  if (!modelDirectoryArgument) {
    throw new Error("Usage: npx tsx scripts/check-semantic-oracles.ts <model-directory>");
  }
  activeModelDirectory = resolve(root, modelDirectoryArgument);
  if (!within(root, activeModelDirectory)) throw new Error("Model directory must be inside the SAGE checkout.");

  const oracle = await readJson<{ version: number; snapshots: OracleSnapshot[] }>(oraclePath);
  if (oracle.version !== 1 || !Array.isArray(oracle.snapshots) || oracle.snapshots.length !== 3) {
    throw new Error("Semantic oracle must contain exactly three pinned snapshots.");
  }

  const snapshots: SnapshotResult[] = [];
  for (const expected of oracle.snapshots) {
    const loaded = await verifySnapshotFiles(expected);
    const result: SnapshotResult = {
      repository: expected.repository,
      commit: expected.commit,
      modelFile: loaded.modelFile,
      modelLoaded: loaded.model !== null,
      evidence: [],
      checks: [],
      ...(loaded.model ? {
        counts: {
          nodes: loaded.model.nodes.length,
          edges: loaded.model.edges.length,
          features: loaded.model.features.length,
          limitations: loaded.model.limitations?.length ?? 0,
        },
      } : {}),
    };
    addCheck(
      result,
      "snapshot.pinned-corpus",
      loaded.corpus?.repository === expected.repository && loaded.corpus?.commit === expected.commit &&
        (expected.requestedRepository === undefined || loaded.corpus?.requestedRepository === expected.requestedRepository),
      loaded.corpus
        ? "Pinned corpus snapshot identity " + String(loaded.corpus.repository) + "@" + String(loaded.corpus.commit)
        : "Pinned corpus snapshot is missing.",
    );
    addCheck(
      result,
      "snapshot.model-loaded",
      loaded.model !== null,
      loaded.model ? "Semantic model loaded from " + loaded.modelFile + "." : "Semantic model is missing or invalid in the supplied model directory.",
    );
    addCheck(
      result,
      "snapshot.model-identity",
      loaded.model?.snapshot.repository === expected.repository && loaded.model.snapshot.commitSha === expected.commit,
      loaded.model
        ? "Model snapshot identity " + loaded.model.snapshot.repository + "@" + loaded.model.snapshot.commitSha
        : "Cannot verify model identity without a parsed model.",
    );

    for (const flow of expected.flows) {
      const items: EvidenceResult[] = [];
      for (const reference of flow.evidence) {
        items.push(await verifyEvidenceReference(expected.repository, loaded.model, reference));
      }
      result.evidence.push({ flow: flow.name, items });
      addCheck(
        result,
        "evidence." + flow.name,
        items.length > 0 && items.every((item) => item.passed),
        items.every((item) => item.passed)
          ? "All " + items.length + " source ranges have matching path/hash/line evidence."
          : items.filter((item) => !item.passed).map((item) => item.reference + ": " + (item.detail ?? "missing match")).join("; "),
        items.flatMap((item) => item.matchingFactIds),
      );
    }

    if (loaded.model) {
      const repository = expected.repository;
      if (repository.endsWith("/sistem-informasi-perpus")) checkPerpus(result, loaded.model);
      else if (repository.endsWith("/sage")) await checkSage(result, loaded.model, repository);
      else if (repository.endsWith("/emosync-backend")) checkEmosync(result, loaded.model);
      else addCheck(result, "semantic.scenario-coverage", false, "No bounded semantic checks are defined for this snapshot.");
    }
    snapshots.push(result);
  }

  const failed = snapshots.flatMap((snapshot) => snapshot.checks
    .filter((check) => !check.passed)
    .map((check) => ({ repository: snapshot.repository, id: check.id, detail: check.detail })));
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    oracle: "docs/evidence/semantic/oracle.json",
    modelDirectory: relative(root, activeModelDirectory) || ".",
    disclaimer,
    snapshots,
    summary: {
      totalSnapshots: snapshots.length,
      loadedModels: snapshots.filter((snapshot) => snapshot.modelLoaded).length,
      totalChecks: snapshots.reduce((sum, snapshot) => sum + snapshot.checks.length, 0),
      passedChecks: snapshots.reduce((sum, snapshot) => sum + snapshot.checks.filter((check) => check.passed).length, 0),
      failedChecks: failed.length,
      failures: failed,
    },
  };
  const reportPath = resolve(activeModelDirectory, "semantic-oracle-check.json");
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", "utf8");
  console.log(JSON.stringify(report.summary, null, 2));
  console.log("Report: " + relative(root, reportPath));
  if (failed.length) process.exitCode = 1;
}

let activeModelDirectory = root;
main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
