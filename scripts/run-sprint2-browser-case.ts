import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const definitions = {
  history: [
    "sage_hist01_fresh",
    "SAGE_HISTORY",
    "scripts/test-sprint2-history.ts",
  ],
  graph: ["sage_graph17", "SAGE_GRAPH", "scripts/test-live-graph.ts"],
  document: [
    "sage_document15",
    "SAGE_DOCUMENT",
    "scripts/test-live-document.ts",
  ],
  markdown: ["sage_export20", "SAGE_EXPORT", "scripts/test-markdown-export.ts"],
  pdf: ["sage_pdf21", "SAGE_PDF", "scripts/test-pdf-export.ts"],
  pipeline: [
    "sage_pipeline16",
    "SAGE_PIPELINE",
    "scripts/test-live-pipeline.ts",
  ],
} as const;
const name = process.argv[2] as keyof typeof definitions;
assert.ok(Object.hasOwn(definitions, name), "Unknown browser case");
assert.equal(
  process.env.SAGE_BDD_DATABASES,
  "1",
  "Use the disposable Sprint 2 runner",
);
const [database, prefix, script] = definitions[name];
const url = new URL(process.env.SAGE_BDD_DATABASE_URL!);
assert.equal(url.hostname, "127.0.0.1");
url.pathname = `/${database}`;
const output = resolve(process.env.SAGE_BDD_REPORT_DIR!, `live-${name}`);
await mkdir(output);
const storage = await mkdtemp(resolve(tmpdir(), `sage-bdd-${name}-`));
const probe = createServer();
await new Promise<void>((done, reject) => {
  probe.once("error", reject);
  probe.listen(0, "127.0.0.1", done);
});
const address = probe.address();
assert.ok(address && typeof address !== "string");
const port = address.port;
await new Promise<void>((done, reject) =>
  probe.close((error) => (error ? reject(error) : done())),
);
const base = `http://127.0.0.1:${port}`;
const env = {
  ...process.env,
  DATABASE_URL: url.toString(),
  STORAGE_ROOT: storage,
  AUTH_BASE_URL: base,
  HOSTNAME: "127.0.0.1",
  PORT: String(port),
  GITHUB_APP_CLIENT_ID: "controlled-browser-client",
  GITHUB_APP_CLIENT_SECRET: "controlled-browser-secret",
  GITHUB_APP_SLUG: "controlled-browser",
  [`${prefix}_TESTS`]: "1",
  [`${prefix}_BASE_URL`]: base,
  [`${prefix}_ARTIFACT_DIR`]: output,
};
const services: ChildProcess[] = [];
const logs: Record<string, string> = {};
const hook =
  name === "pipeline"
    ? ["--import", resolve("scripts/helpers/pipeline-provider-fixture.mjs")]
    : [];
function start(label: string, args: string[], cwd?: string) {
  const child = spawn(process.execPath, args, {
    env,
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });
  logs[label] = "";
  child.stdout!.on("data", (b) => {
    logs[label] += String(b);
  });
  child.stderr!.on("data", (b) => {
    logs[label] += String(b);
  });
  child.on("error", (error) => {
    logs[label] += error.message;
  });
  services.push(child);
  return child;
}
const stop = () => {
  for (const child of services) child.kill("SIGTERM");
};
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
try {
  const web = start(
    "web",
    [
      ...hook,
      resolve("node_modules/next/dist/bin/next"),
      "start",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(port),
    ],
    resolve("apps/web"),
  );
  let ready = false;
  for (let i = 0; i < 80; i++) {
    assert.equal(web.exitCode, null, "Owned web process exited");
    try {
      const response = await fetch(`${base}/api/health`, {
        signal: AbortSignal.timeout(1000),
      });
      ready = response.ok;
    } catch {
      /* wait for own server */
    }
    if (ready) break;
    await new Promise((done) => setTimeout(done, 250));
  }
  assert.ok(ready, "Owned Next server did not become healthy");
  if (["markdown", "pdf", "pipeline"].includes(name)) {
    start("worker", [...hook, "--import", "tsx", "apps/worker/src/index.ts"]);
    for (let i = 0; i < 80 && !logs.worker?.includes('"worker_ready"'); i++)
      await new Promise((done) => setTimeout(done, 250));
    assert.ok(
      logs.worker?.includes('"worker_ready"'),
      "Owned production worker did not become ready",
    );
  }
  const test = start("test", ["--import", "tsx", script]);
  const code = await new Promise<number | null>((done, reject) => {
    const timeout = setTimeout(() => {
      test.kill("SIGTERM");
      reject(new Error("Browser suite timed out"));
    }, 300_000);
    test.once("error", reject);
    test.once("close", (code) => {
      clearTimeout(timeout);
      done(code);
    });
  });
  assert.equal(code, 0, logs.test?.slice(-5000));
  const report = JSON.parse(
    await readFile(resolve(output, "report.json"), "utf8"),
  );
  assert.equal(report.status, "PASS", "Browser report must pass");
  assert.ok(report.checks.length > 0, "Empty browser checks cannot pass");
  console.log(
    `Sprint 2 application browser PASS: ${name}; ${report.checks.length} checks`,
  );
} finally {
  process.off("SIGTERM", stop);
  process.off("SIGINT", stop);
  stop();
  await Promise.all(
    services.map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      await Promise.race([
        new Promise((done) => child.once("close", done)),
        new Promise((done) => setTimeout(done, 3000)),
      ]);
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
    }),
  );
  for (const [label, log] of Object.entries(logs))
    await writeFile(resolve(output, `${label}.log`), log);
  await rm(storage, { recursive: true, force: true });
}
