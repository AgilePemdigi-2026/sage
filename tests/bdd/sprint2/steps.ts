import { Given, When, Then, setDefaultTimeout } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
interface RegressionCase {
  title: string;
  boundary: string;
  files: string[];
  database?: string;
  flag?: string;
}
interface State {
  id: string;
  definition: RegressionCase;
  output: string;
  exit: number | null;
  attach: (body: string, type: string) => void;
}
const cases = JSON.parse(
  await readFile(new URL("./cases.json", import.meta.url), "utf8"),
) as Record<string, RegressionCase>;
setDefaultTimeout(420_000);
Given(
  "the Sprint 2 regression case {string}",
  function (this: State, id: string) {
    assert.ok(Object.hasOwn(cases, id), "Unknown regression case");
    this.id = id;
    this.definition = cases[id]!;
  },
);
When(
  "I execute its production regression checks",
  async function (this: State) {
    const env = { ...process.env };
    if (this.definition.database) {
      assert.equal(
        env.SAGE_BDD_DATABASES,
        "1",
        "Use the managed disposable database runner",
      );
      const url = new URL(env.SAGE_BDD_DATABASE_URL!);
      assert.equal(url.hostname, "127.0.0.1");
      url.pathname = `/${this.definition.database}`;
      env.DATABASE_URL = url.toString();
      env[this.definition.flag!] = "1";
    }
    const result = await new Promise<{ code: number | null; output: string }>(
      (done, reject) => {
        const child = spawn(
          process.execPath,
          [
            "--import",
            "tsx",
            "--test",
            "--test-reporter=tap",
            "--test-concurrency=1",
            ...this.definition.files,
          ],
          { env, stdio: ["ignore", "pipe", "pipe"], timeout: 150_000 },
        );
        let output = "";
        child.stdout.on("data", (b) => {
          output += String(b);
        });
        child.stderr.on("data", (b) => {
          output += String(b);
        });
        child.once("error", reject);
        child.once("close", (code) => done({ code, output }));
      },
    );
    this.output = result.output;
    this.exit = result.code;
    await writeFile(
      resolve(process.env.SAGE_BDD_REPORT_DIR!, `${this.id}.tap`),
      result.output,
    );
    this.attach(
      JSON.stringify({
        case: this.id,
        boundary: this.definition.boundary,
        files: this.definition.files,
        exit: result.code,
      }),
      "application/json",
    );
  },
);
Then(
  "every executed check passes without skipped tests",
  function (this: State) {
    assert.equal(this.exit, 0, this.output.slice(-6000));
    const totals = [...this.output.matchAll(/^# tests (\d+)$/gm)];
    assert.equal(totals.length, 1, "Missing test summary");
    assert.ok(Number(totals[0]![1]) > 0, "Empty suites cannot pass acceptance");
    assert.match(this.output, /^# fail 0$/m);
    assert.match(this.output, /^# skipped 0$/m);
    assert.match(this.output, /^# cancelled 0$/m);
  },
);

async function command(args: string[]): Promise<string> {
  return new Promise((done, reject) => {
    const child = spawn("gh", args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (b) => {
      output += String(b);
    });
    child.stderr.resume();
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0
        ? done(output)
        : reject(
            new Error("GitHub CLI probe failed; provider output withheld"),
          ),
    );
  });
}
interface ProviderState {
  repository: { private: boolean; permissions?: { pull: boolean } };
  commit: string;
}
Given("the GitHub CLI identity {string}", async function (identity: string) {
  assert.equal(
    (await command(["api", "user", "--jq", ".login"])).trim(),
    identity,
  );
});
When(
  "I inspect the public repository {string} through GitHub",
  async function (this: ProviderState, repository: string) {
    assert.equal(repository, "octocat/Hello-World");
    this.repository = JSON.parse(await command(["api", `repos/${repository}`]));
    this.commit = (
      await command(["api", `repos/${repository}/commits/HEAD`, "--jq", ".sha"])
    ).trim();
  },
);
When(
  "I inspect the explicitly authorized private fixture through GitHub",
  async function (this: ProviderState) {
    const repository = process.env.SAGE_BDD_PRIVATE_REPOSITORY;
    assert.ok(
      repository,
      "Provide SAGE_BDD_PRIVATE_REPOSITORY only for an explicitly authorized fixture",
    );
    assert.match(repository, /^[\w.-]+\/[\w.-]+$/u);
    this.repository = JSON.parse(await command(["api", `repos/${repository}`]));
    this.commit = (
      await command(["api", `repos/${repository}/commits/HEAD`, "--jq", ".sha"])
    ).trim();
  },
);
Then(
  "GitHub returns a readable public repository and a full commit SHA",
  function (this: ProviderState) {
    assert.equal(this.repository.private, false);
    assert.match(this.commit, /^[a-f0-9]{40}$/u);
  },
);
Then(
  "GitHub confirms private repository read permission and a full commit SHA",
  function (this: ProviderState) {
    assert.equal(this.repository.private, true);
    assert.equal(this.repository.permissions?.pull, true);
    assert.match(this.commit, /^[a-f0-9]{40}$/u);
  },
);
When(
  "I check the result workspace with Playwright and pinned source models",
  async function (this: State) {
    const result = await new Promise<{ code: number | null; output: string }>(
      (done, reject) => {
        const child = spawn(
          process.execPath,
          ["--import", "tsx", "scripts/test-semantic-workspace.ts"],
          {
            env: process.env,
            stdio: ["ignore", "pipe", "pipe"],
            timeout: 240_000,
          },
        );
        let output = "";
        child.stdout.on("data", (b) => {
          output += String(b);
        });
        child.stderr.on("data", (b) => {
          output += String(b);
        });
        child.once("error", reject);
        child.once("close", (code) => done({ code, output }));
      },
    );
    this.exit = result.code;
    this.output = result.output;
    await writeFile(
      resolve(process.env.SAGE_BDD_REPORT_DIR!, "browser.txt"),
      result.output,
    );
  },
);
Then(
  "the controlled browser regression passes without missing corpus checks",
  function (this: State) {
    assert.equal(this.exit, 0, this.output.slice(-6000));
    assert.match(this.output, /Semantic workspace browser fixture passed/u);
    assert.doesNotMatch(this.output, /smoke skipped|overview skipped/u);
  },
);

const browserRuns = new Map<
  string,
  Promise<{ code: number | null; output: string }>
>();
function exerciseBrowserSuite(name: string) {
  assert.ok(
    ["graph", "document", "markdown", "pdf", "pipeline", "history"].includes(
      name,
    ),
  );
  let run = browserRuns.get(name);
  if (!run) {
    run = new Promise<{ code: number | null; output: string }>(
      (done, reject) => {
        const child = spawn(
          process.execPath,
          ["--import", "tsx", "scripts/run-sprint2-browser-case.ts", name],
          {
            env: process.env,
            stdio: ["ignore", "pipe", "pipe"],
            timeout: 360_000,
          },
        );
        let output = "";
        child.stdout.on("data", (b) => {
          output += String(b);
        });
        child.stderr.on("data", (b) => {
          output += String(b);
        });
        child.once("error", reject);
        child.once("close", (code) => done({ code, output }));
      },
    );
    browserRuns.set(name, run);
  }
  return run;
}
When(
  "I test the application browser case {string}",
  async function (this: State, name: string) {
    const result = await exerciseBrowserSuite(name);
    this.exit = result.code;
    this.output = result.output;
    this.attach(result.output, "text/plain");
  },
);
Then("the production application browser checks pass", function (this: State) {
  assert.equal(this.exit, 0, this.output.slice(-6000));
  assert.match(this.output, /Sprint 2 application browser PASS:/u);
});
interface SourceCase {
  title: string;
  suite: string;
  checkpoints: string[];
}
interface SourceState extends State {
  sourceId: string;
  sourceCase: SourceCase;
}
const sourceCases = JSON.parse(
  await readFile(new URL("./srs-cases.json", import.meta.url), "utf8"),
) as Record<string, SourceCase>;
Given(
  "the SRS user story scenario {string}",
  function (this: SourceState, id: string) {
    assert.ok(Object.hasOwn(sourceCases, id));
    this.sourceId = id;
    this.sourceCase = sourceCases[id]!;
  },
);
When(
  "its production browser workflow is exercised",
  async function (this: SourceState) {
    const result = await exerciseBrowserSuite(this.sourceCase.suite);
    this.exit = result.code;
    this.output = result.output;
    this.attach(result.output, "text/plain");
  },
);
Then(
  "its source scenario checkpoints pass",
  async function (this: SourceState) {
    assert.equal(this.exit, 0, this.output.slice(-6000));
    const report = JSON.parse(
      await readFile(
        resolve(
          process.env.SAGE_BDD_REPORT_DIR!,
          `live-${this.sourceCase.suite}`,
          "report.json",
        ),
        "utf8",
      ),
    ) as { status: string; checks: string[] };
    assert.equal(report.status, "PASS");
    for (const checkpoint of this.sourceCase.checkpoints)
      assert.ok(
        report.checks.some((check) => check.includes(checkpoint)),
        `Missing executed checkpoint for ${this.sourceId}: ${checkpoint}`,
      );
    this.attach(
      JSON.stringify({
        sourceScenario: this.sourceId,
        checkpoints: this.sourceCase.checkpoints,
        scope:
          "Shared production browser suite with isolated database and synthetic sessions; not live OAuth",
      }),
      "application/json",
    );
  },
);
