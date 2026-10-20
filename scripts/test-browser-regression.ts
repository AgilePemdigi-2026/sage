import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const startedAt = new Date().toISOString();
const runId = process.env.QA_RUN_ID ?? startedAt.replaceAll(/[:.]/g, "-");
if (!/^[a-zA-Z0-9_-]+$/.test(runId)) throw new Error("QA_RUN_ID must be a simple directory name");
const output = resolve(process.env.QA_BROWSER_EVIDENCE_ROOT ?? resolve(process.env.STORAGE_ROOT ?? "artifacts", "browser-regression"), runId);
await mkdir(dirname(output), { recursive: true });
// Never mix a failed replay with an older PASS report or a concurrent run.
await mkdir(output);
const base = process.env.SAGE_HTTP_BASE_URL ?? process.env.BASE_URL ?? "http://web:3000";
const suites = [
  { name: "landing-health", script: "scripts/browser-smoke.ts", evidence: "environment" },
  { name: "auth-workspace", script: "scripts/test-auth-ui.ts", evidence: "auth" },
  { name: "repository-target", script: "scripts/test-target-ui.ts", evidence: "repository" },
  { name: "figma-preview", script: "scripts/test-figma-ui.ts", evidence: "figma" },
  { name: "ui-foundation", script: "scripts/test-ui-foundation.ts", evidence: "ui-foundation" },
  { name: "graph-foundation", script: "scripts/test-graph-foundation.ts", evidence: "graph-foundation" },
  { name: "ui-baseline", script: "scripts/test-ui-baseline.ts", evidence: "ui-baseline" },
];
const results: object[] = [];
let failed = false;
for (const suite of suites) {
  const began = Date.now();
  console.log(`[browser-regression] START ${suite.name}`);
  const evidence = resolve(output, suite.evidence);
  const digest = createHash("sha256").update(await readFile(suite.script)).digest("hex");
  const status = await new Promise<number>((done, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", suite.script], {
      stdio: "inherit",
      env: {
        ...process.env, BASE_URL: base,
        SAGE_HTTP_BASE_URL: suite.name === "auth-workspace" ? (process.env.AUTH_BASE_URL ?? "http://localhost:3000") : base,
        SAGE_HTTP_TRANSPORT_BASE_URL: base,
        STORAGE_ROOT: output, SAGE_TEST_FIXTURE_USER: "1", QA_RUN_ID: runId,
        AUTH_UI_EVIDENCE_DIR: resolve(output, "auth"), TARGET_UI_EVIDENCE_DIR: resolve(output, "repository"),
        FIGMA_UI_EVIDENCE_DIR: resolve(output, "figma"), UI_EVIDENCE_DIR: resolve(output, "ui-foundation"),
        GRAPH_EVIDENCE_DIR: resolve(output, "graph-foundation"), QA03_EVIDENCE_DIR: resolve(output, "ui-baseline"),
      },
    });
    child.once("error", reject);
    child.once("exit", code => done(code ?? 1));
  });
  failed ||= status !== 0;
  results.push({ name: suite.name, script: suite.script, sha256: digest, status: status === 0 ? "PASS" : "FAIL", exitCode: status, durationMs: Date.now() - began, evidence });
  console.log(`[browser-regression] ${status === 0 ? "PASS" : "FAIL"} ${suite.name}`);
}
const report = {
  startedAt, completedAt: new Date().toISOString(), runId, status: failed ? "FAIL" : "PASS",
  applicationBaseCommitSha: process.env.QA_APP_COMMIT_SHA ?? null,
  lockfileSha256: createHash("sha256").update(await readFile("package-lock.json")).digest("hex"),
  runtime: { node: process.version, platform: process.platform, arch: process.arch },
  scope: "Current landing/auth/workspace/repository UI and fixture previews; controlled responses and disposable sessions are labelled in suite reports.",
  limitations: ["No live GitHub approval or token exchange in this aggregate run.", "Repository responses are controlled; real provider requires a separate opted-in live test.", "Consumer pipeline is disabled. Product analysis results, PDF export, history and deletion remain NOT_IMPLEMENTED; fixture behavior does not close their acceptance."],
  results,
};
await writeFile(resolve(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ status: report.status, suites: results.length, report: resolve(output, "report.json") }));
if (failed) process.exitCode = 1;
