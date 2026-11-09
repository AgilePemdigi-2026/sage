import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { access, mkdir, writeFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
const execute = promisify(execFile);
const container = `sage-bdd-lifecycle-${randomBytes(5).toString("hex")}`;
const output = resolve("artifacts/bdd", `lifecycle-${Date.now()}`);
await mkdir(output, { recursive: true });
const children: ChildProcess[] = [];
let created = false;
const ownedStorage: string[] = [];
const results: Array<{ paused: boolean; signal: string; exitCode: number | null; servicesStopped: boolean; storageRemoved: boolean }> = [];
try {
  await execute("docker", ["run", "-d", "--name", container, "--memory", "512m", "--cpus", "0.5", "-e", "POSTGRES_USER=sage", "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "-p", "127.0.0.1::5432", "postgres:17-bookworm"]);
  created = true;
  let ready = false;
  for (let i = 0; i < 50; i++) {
    try { await execute("docker", ["exec", container, "pg_isready", "-h", "127.0.0.1", "-U", "sage"]); ready = true; break; }
    catch { await new Promise(done => setTimeout(done, 200)); }
  }
  assert.ok(ready);
  const port = (await execute("docker", ["port", container, "5432/tcp"])).stdout.trim().split(":").at(-1)!;
  const url = `postgresql://sage@127.0.0.1:${port}/sage_srs_bdd`;
  await execute("docker", ["exec", container, "createdb", "-U", "sage", "sage_srs_bdd"]);
  const env = { ...process.env, DATABASE_URL: url, SAGE_BDD_DATABASE_URL: url, SAGE_BDD_DATABASES: "1", CREDENTIAL_ENCRYPTION_KEY: randomBytes(32).toString("base64") };
  await execute(process.execPath, [resolve("node_modules/prisma/build/index.js"), "migrate", "deploy"], { cwd: resolve("packages/database"), env });
  for (const paused of [false, true]) {
    const source = `import {startFixtureServer,pauseFixtureWorker,fixtureResourceSnapshot} from './tests/bdd/sprint2/browser-fixture.ts';
      await startFixtureServer(); ${paused ? "pauseFixtureWorker(true);" : ""}
      console.log('FIXTURE_READY:'+JSON.stringify(fixtureResourceSnapshot())); setInterval(()=>{},1000);`;
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], { env, stdio: ["ignore", "pipe", "pipe"] });
    children.push(child);
    let log = "";
    child.stdout!.on("data", data => { log += String(data); });
    child.stderr!.on("data", data => { log += String(data); });
    const exit = new Promise<number | null>(done => child.once("close", done));
    for (let i = 0; i < 150 && !log.includes("FIXTURE_READY:"); i++) {
      assert.equal(child.exitCode, null, log.slice(-2000));
      await new Promise(done => setTimeout(done, 200));
    }
    const line = log.split("\n").find(line => line.startsWith("FIXTURE_READY:"));
    assert.ok(line, log.slice(-2000));
    const resources = JSON.parse(line.slice("FIXTURE_READY:".length)) as { servicePids: number[]; storage: string };
    ownedStorage.push(resources.storage);
    assert.equal(resources.servicePids.length, 2);
    await access(resources.storage);
    if (paused) {
      const state = (await execute("ps", ["-o", "stat=", "-p", String(resources.servicePids[1])])).stdout;
      assert.match(state, /T/, "Fault worker must actually be stopped before interruption");
    }
    const signal = paused ? "SIGINT" : "SIGTERM";
    child.kill(signal);
    const code = await Promise.race([exit, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Fixture interruption cleanup timed out")), 15000).unref())]);
    assert.equal(code, paused ? 130 : 143);
    for (const pid of resources.servicePids) assert.throws(() => process.kill(pid, 0), (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH");
    await assert.rejects(access(resources.storage), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");
    results.push({ paused, signal, exitCode: code, servicesStopped: true, storageRemoved: true });
  }
  await writeFile(resolve(output, "report.json"), JSON.stringify({ status: "PASS", checks: results, scope: "Actual production Next/worker interruption on disposable PostgreSQL; no OAuth or real user data" }, null, 2));
  console.log(`Fixture lifecycle PASS: ${output}`);
} finally {
  for (const child of children) if (child.exitCode === null && child.signalCode === null) { child.kill("SIGCONT"); child.kill("SIGTERM"); }
  for (const path of ownedStorage) await rm(path, { recursive: true, force: true });
  if (created) await execute("docker", ["rm", "-fv", container]);
}
