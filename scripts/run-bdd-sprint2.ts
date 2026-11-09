import { spawn } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
const directory = resolve(
  "artifacts/bdd",
  `sprint2-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`,
);
await mkdir(directory, { recursive: true });
const contractsOnly = process.argv.includes("--contracts-only");
const browserCase = process.argv
  .find((argument) => argument.startsWith("--browser-case="))
  ?.split("=")[1];
if (
  browserCase &&
  !["graph", "document", "pdf", "markdown", "history", "pipeline"].includes(
    browserCase,
  )
)
  throw new Error("Unknown browser case");
const browserOnly =
  process.argv.includes("--browser-only") || Boolean(browserCase);
if (contractsOnly && browserOnly) throw new Error("Select only one test mode");
const container = `sage-bdd-sprint2-${randomBytes(5).toString("hex")}`;
const cases = JSON.parse(
  await readFile("tests/bdd/sprint2/cases.json", "utf8"),
) as Record<string, { database?: string }>;
const env = {
  ...process.env,
  SAGE_BDD_REPORT_DIR: directory,
  SAGE_BDD_CONTRACTS_ONLY: contractsOnly ? "1" : "0",
  SAGE_BDD_BROWSER_ONLY: browserOnly ? "1" : "0",
  SAGE_BDD_BROWSER_CASE: browserCase ?? "",
  CREDENTIAL_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
};
const children = new Set<ReturnType<typeof spawn>>();
let interrupted = false;
let created = false;
const stop = () => {
  interrupted = true;
  for (const child of children) child.kill("SIGTERM");
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
async function run(
  command: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; cwd?: string } = {},
) {
  if (interrupted) throw new Error("Interrupted");
  return new Promise<string>((done, reject) => {
    const child = spawn(command, args, {
      ...options,
      env: options.env ?? env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.add(child);
    let out = "";
    child.stdout!.on("data", (b) => {
      out += String(b);
    });
    child.stderr!.on("data", (b) => {
      out += String(b);
    });
    child.once("error", reject);
    child.once("close", (code) => {
      children.delete(child);
      if (code === 0) done(out);
      else
        reject(new Error(`${command} failed (${code}): ${out.slice(-5000)}`));
    });
  });
}
async function codeFingerprint() {
  const paths = (
    await run("git", ["ls-files", "-co", "--exclude-standard", "-z"])
  )
    .split("\0")
    .filter(
      (path) =>
        /^(apps|packages|scripts|tests)\//u.test(path) ||
        /^cucumber.*\.mjs$/u.test(path),
    )
    .filter((path) => path !== "apps/web/next-env.d.ts");
  const hash = createHash("sha256");
  for (const path of [...new Set(paths)].sort()) {
    let bytes: Buffer;
    try { bytes = await readFile(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    hash.update(path).update("\0").update(bytes).update("\0");
  }
  return hash.digest("hex");
}
let status = "FAIL";
try {
  const account = (await run("gh", ["api", "user", "--jq", ".login"])).trim();
  const expectedAccount = process.env.SAGE_BDD_GITHUB_ACCOUNT ?? "rizqy-fadhil";
  if (account !== expectedAccount)
    throw new Error(
      `Select the requested ${expectedAccount} CLI account before this run`,
    );
  const source = (await run("git", ["rev-parse", "HEAD"])).trim();
  const codeSha256 = await codeFingerprint();
  if (!contractsOnly) {
    await run("docker", [
      "run",
      "-d",
      "--name",
      container,
      "--label",
      "sage.disposable=bdd-sprint2",
      "--memory",
      "512m",
      "--cpus",
      "0.5",
      "-e",
      "POSTGRES_USER=sage",
      "-e",
      "POSTGRES_HOST_AUTH_METHOD=trust",
      "-p",
      "127.0.0.1::5432",
      "postgres:17-bookworm",
    ]);
    created = true;
    let ready = false;
    for (let i = 0; i < 40; i++) {
      try {
        await run("docker", [
          "exec",
          container,
          "pg_isready",
          "-h",
          "127.0.0.1",
          "-U",
          "sage",
        ]);
        ready = true;
        break;
      } catch {
        await new Promise((done) => setTimeout(done, 500));
      }
    }
    if (!ready) throw new Error("Owned PostgreSQL did not become ready");
    const port = (await run("docker", ["port", container, "5432/tcp"]))
      .trim()
      .split(":")
      .at(-1)!;
    Object.assign(env, {
      SAGE_BDD_DATABASES: "1",
      SAGE_BDD_DATABASE_URL: `postgresql://sage@127.0.0.1:${port}/postgres`,
    });
    for (const database of new Set(
      browserOnly
        ? [
            "sage_graph17",
            "sage_document15",
            "sage_export20",
            "sage_pdf21",
            "sage_pipeline16",
            "sage_hist01_fresh",
            "sage_srs_bdd",
          ]
        : [
            ...Object.values(cases).flatMap((definition) =>
              definition.database ? [definition.database] : [],
            ),
            "sage_graph17",
            "sage_srs_bdd",
          ],
    )) {
      const definition = { database };
      await run("docker", [
        "exec",
        container,
        "createdb",
        "-U",
        "sage",
        definition.database,
      ]);
      await run(
        process.execPath,
        [resolve("node_modules/prisma/build/index.js"), "migrate", "deploy"],
        {
          cwd: resolve("packages/database"),
          env: {
            ...env,
            DATABASE_URL: `postgresql://sage@127.0.0.1:${port}/${definition.database}`,
          },
        },
      );
    }
  }
  if (!contractsOnly) {
    console.log("Building the current application for isolated browser checks");
    await run(process.execPath, [
      "node_modules/next/dist/bin/next",
      "build",
      "apps/web",
    ]);
    if (!browserOnly) {
      await run("python3", ["scripts/prepare-semantic-corpora.py"]);
      const corpusDirectory = resolve(directory, "corpora");
      for (const corpus of [
        "sistem-informasi-perpus",
        "emosync-backend",
        "sage",
      ]) {
        await run(process.execPath, [
          "--import",
          "tsx",
          "scripts/benchmark-semantic.ts",
          `artifacts/semantic/corpora/${corpus}`,
          corpusDirectory,
        ]);
      }
      Object.assign(env, {
        SAGE_SEMANTIC_CORPUS: resolve(
          corpusDirectory,
          "sistem-informasi-perpus-semantic.json",
        ),
        SAGE_SEMANTIC_PERPUS_MOBILE_CORPUS: resolve(
          corpusDirectory,
          "sistem-informasi-perpus-semantic.json",
        ),
        SAGE_SEMANTIC_EMOSYNC_CORPUS: resolve(
          corpusDirectory,
          "emosync-backend-semantic.json",
        ),
        SAGE_SEMANTIC_SAGE_CORPUS: resolve(
          corpusDirectory,
          "sage-semantic.json",
        ),
        SAGE_SEMANTIC_REPORT_DIR: resolve(directory, "browser"),
      });
    }
  }
  console.log(
    "Running Cucumber contracts, database checks and SRS browser workflows",
  );
  const output = await run(process.execPath, [
    "--import",
    "tsx",
    "node_modules/@cucumber/cucumber/bin/cucumber.js",
    "--config",
    "cucumber-sprint2.mjs",
  ]);
  console.log(output);
  await writeFile(resolve(directory, "console.txt"), output);
  const report = JSON.parse(
    await readFile(resolve(directory, "cucumber.json"), "utf8"),
  ) as Array<{
    elements?: Array<{
      type: string;
      steps: Array<{ result: { status: string } }>;
    }>;
  }>;
  const scenarios = report
    .flatMap((f) => f.elements ?? [])
    .filter((x) => x.type === "scenario");
  const expectedCount = browserCase
    ? browserCase === "pipeline"
      ? 1
      : Object.values(
          JSON.parse(
            await readFile("tests/bdd/sprint2/srs-cases.json", "utf8"),
          ) as Record<string, { suite: string }>,
        ).filter((definition) => definition.suite === browserCase).length
    : browserOnly
      ? 1 +
        Object.keys(
          JSON.parse(
            await readFile("tests/bdd/sprint2/srs-cases.json", "utf8"),
          ),
        ).length
      : contractsOnly
        ? Object.values(cases).filter((value) => !value.database).length
        : (
            await Promise.all(
              (await readdir("tests/bdd/sprint2"))
                .filter((path) => path.endsWith(".feature"))
                .map((path) =>
                  readFile(resolve("tests/bdd/sprint2", path), "utf8"),
                ),
            )
          ).reduce(
            (sum, source) =>
              sum + (source.match(/^\s*Scenario:/gm)?.length ?? 0),
            0,
          );
  if (
    scenarios.length !== expectedCount ||
    scenarios.some((s) =>
      s.steps.some((step) => step.result.status !== "passed"),
    )
  )
    throw new Error("Incomplete or non-passing Cucumber execution");
  if (codeSha256 !== (await codeFingerprint()))
    throw new Error(
      "Source changed during the run; repeat against a stable source tree",
    );
  status = "PASS";
  await writeFile(
    resolve(directory, "run.json"),
    JSON.stringify(
      {
        status,
        sourceCommit: source,
        codeSha256,
        account,
        mode: contractsOnly ? "contracts-only" : browserOnly ? "browser-only" : "full",
        browserCase: browserCase ?? null,
        scope: contractsOnly
          ? "contract regression"
          : browserOnly
            ? `disposable PostgreSQL and production Next/worker Playwright (${browserCase ?? "all application browser suites"}); no contract or live GitHub CLI regression`
            : "contract, disposable PostgreSQL, production Next/worker Playwright, and live GitHub CLI regression",
        scenarios: scenarios.length,
        node: process.version,
        lockfileSha256: createHash("sha256")
          .update(await readFile("package-lock.json"))
          .digest("hex"),
        testSources: Object.fromEntries(
          await Promise.all(
            [
              "tests/bdd/sprint2/acceptance.feature",
              "tests/bdd/sprint2/graph.feature",
              "tests/bdd/sprint2/document.feature",
              "tests/bdd/sprint2/history.feature",
              "tests/bdd/sprint2/browser.steps.ts",
              "tests/bdd/sprint2/browser-fixture.ts",
              "tests/bdd/sprint2/srs-cases.json",
              "tests/bdd/sprint2/steps.ts",
              "tests/bdd/sprint2/cases.json",
              "scripts/run-bdd-sprint2.ts",
              "scripts/run-sprint2-browser-case.ts",
            ].map(async (path) => [
              path,
              createHash("sha256")
                .update(await readFile(path))
                .digest("hex"),
            ]),
          ),
        ),
        limitations: [
          "CLI identity does not prove SAGE OAuth as this account.",
          "Controlled provider fixtures do not prove live GitHub authorization.",
          "Each SRS scenario uses its own synthetic owner, analysis and browser context; the disposable server/database/worker are shared. Supporting regression suites may reuse a suite run.",
          "Full PDF visual acceptance, process restart recovery and fresh Docker-to-demo acceptance require separate runs.",
        ],
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : "BDD failed");
  process.exitCode = 1;
  await writeFile(
    resolve(directory, "failure.json"),
    JSON.stringify({
      status,
      error: error instanceof Error ? error.message : "Unknown failure",
    }),
  );
} finally {
  process.off("SIGINT", stop);
  process.off("SIGTERM", stop);
  if (created) {
    const child = spawn("docker", ["rm", "-fv", container], {
      stdio: "ignore",
    });
    await new Promise((done) => child.once("close", done));
  }
  console.log(`Sprint 2 BDD ${status}: ${directory}`);
}
