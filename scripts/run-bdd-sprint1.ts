import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer } from "node:net";

const dryRun = process.argv.includes("--dry-run");
const args = process.argv.slice(2).filter(argument => argument !== "--dry-run");
const runId = process.env.SAGE_BDD_RUN_ID ?? new Date().toISOString().replaceAll(/[:.]/g, "-");
if (!/^[A-Za-z0-9_-]+$/.test(runId)) throw new Error("SAGE_BDD_RUN_ID must be a simple directory name.");
const reportDirectory = resolve("artifacts/bdd", runId);
await mkdir(resolve("artifacts/bdd"), { recursive: true });
await mkdir(reportDirectory); // An existing report must never be overwritten by a replay.
process.env.SAGE_BDD_REPORT_DIR = reportDirectory;
let server: ChildProcess | undefined;
let stopping = false;
let signalExit = 0;
const signalHandler = () => { signalExit = 130; server?.kill("SIGTERM"); };
process.once("SIGINT", signalHandler);
process.once("SIGTERM", signalHandler);

function run(command: string, commandArgs: string[]): Promise<number> {
  return new Promise((done, reject) => {
    const child = spawn(command, commandArgs, { stdio: "inherit", env: process.env });
    const stopChild = () => child.kill("SIGTERM");
    process.once("SIGINT", stopChild);
    process.once("SIGTERM", stopChild);
    child.once("error", reject);
    child.once("exit", code => {
      process.off("SIGINT", stopChild);
      process.off("SIGTERM", stopChild);
      done(code ?? 1);
    });
  });
}

try {
  if (!dryRun) {
    if (process.env.SAGE_BDD_TESTS !== "1" || new URL(process.env.DATABASE_URL ?? "").pathname !== "/sage_bdd_sprint1") {
      throw new Error("BDD requires SAGE_BDD_TESTS=1 and the disposable sage_bdd_sprint1 database.");
    }
    if (process.env.SAGE_BDD_MANAGED_SERVER === "1") {
      // Fail before migration/startup if another app owns the fixed test port.
      const probe = createServer();
      await new Promise<void>((done, reject) => {
        probe.once("error", () => reject(new Error("Owned BDD server requires unused loopback port 3000.")));
        probe.listen({ host: "127.0.0.1", port: 3000, exclusive: true }, () => probe.close(error => error ? reject(error) : done()));
      });
      if (signalExit) throw new Error("BDD run interrupted before server startup.");
      process.env.AUTH_BASE_URL = "http://127.0.0.1:3000";
      process.env.SAGE_BDD_BASE_URL = process.env.AUTH_BASE_URL;
      process.env.CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString("base64");
      // Synthetic App values allow redirect/error behavior without a live OAuth grant.
      process.env.GITHUB_APP_CLIENT_ID = "bdd-client";
      process.env.GITHUB_APP_CLIENT_SECRET = "bdd-secret";
      process.env.GITHUB_APP_SLUG = "bdd-sprint1";
      const migrationExit = await run("npm", ["run", "db:migrate"]);
      if (migrationExit !== 0) throw new Error("BDD database migrations failed.");
      server = spawn(process.execPath, ["apps/web/.next/standalone/apps/web/server.js"], {
        env: { ...process.env, HOSTNAME: "127.0.0.1", PORT: "3000" }, stdio: ["ignore", "ignore", "ignore"],
      });
      server.on("error", () => { stopping = true; });
      server.on("exit", () => { stopping = true; });
      let ready = false;
      for (let attempt = 0; attempt < 60 && !stopping && !signalExit; attempt++) {
        try {
          const health = await fetch(`${process.env.AUTH_BASE_URL}/api/health`, { signal: AbortSignal.timeout(1_000) });
          ready = health.ok && (await health.json() as { database?: string }).database === "ok"
            && !stopping && server.exitCode === null && server.signalCode === null;
          if (ready) break;
        } catch { /* Wait for the owned server only. */ }
        await new Promise(done => setTimeout(done, 500));
      }
      if (!ready) throw new Error("Owned BDD server did not become healthy.");
    }
  }
  let exitCode = await run(process.execPath, ["--import", "tsx", "node_modules/@cucumber/cucumber/bin/cucumber.js", ...(dryRun ? ["--dry-run"] : []), ...args]);
  if (server && (stopping || server.exitCode !== null || server.signalCode !== null)) exitCode = exitCode || 1;
  const features = JSON.parse(await readFile(resolve(reportDirectory, "cucumber.json"), "utf8")) as Array<{ elements?: Array<{ type?: string; steps?: Array<{ result?: { status?: string } }> }> }>;
  const scenarioCount = features.reduce((total, feature) => total + (feature.elements ?? []).filter(element => element.type === "scenario").length, 0);
  if (scenarioCount === 0) throw new Error("No BDD scenarios selected; an empty run is not acceptance evidence.");
  const statuses = features.flatMap(feature => (feature.elements ?? []).flatMap(element => (element.steps ?? []).map(step => step.result?.status)));
  const allowed = dryRun ? new Set(["skipped", "passed"]) : new Set(["passed"]);
  if (statuses.some(status => !status || !allowed.has(status))) exitCode = exitCode || 1;
  const manifest = {
    runId, checkedAt: new Date().toISOString(), mode: dryRun ? "DRY_RUN_NOT_EXECUTED" : "EXECUTED",
    status: exitCode === 0 && !signalExit ? (dryRun ? "VALIDATED_ONLY" : "PASS") : "FAIL",
    exitCode, scenarioCount, appCommit: process.env.SAGE_BDD_APP_COMMIT ?? null,
    lockfileSha256: createHash("sha256").update(await readFile("package-lock.json")).digest("hex"),
    node: process.version, scope: "Sprint 1 acceptance examples; controlled browser APIs and real isolated domain/database tests.",
    limitations: ["No live GitHub OAuth/permission proof.", "Trusted runner stubs test Sprint 1 sequencing, not full pipeline acceptance.", "This suite does not close Sprint 2 graph/export/history acceptance or formal oracle signoff."],
  };
  await writeFile(resolve(reportDirectory, "run.json"), JSON.stringify(manifest, null, 2) + "\n");
  console.log(`BDD ${manifest.status}: ${reportDirectory}`);
  process.exitCode = signalExit || exitCode;
} finally {
  if (server && server.exitCode === null) {
    server.kill("SIGTERM");
    await Promise.race([new Promise(done => server!.once("exit", done)), new Promise(done => setTimeout(done, 3_000))]);
    if (server.exitCode === null) server.kill("SIGKILL");
  }
  process.off("SIGINT", signalHandler);
  process.off("SIGTERM", signalHandler);
}
