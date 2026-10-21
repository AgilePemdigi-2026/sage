import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const project = fileURLToPath(new URL("../", import.meta.url));
const ids = ["sage-js", "php-parser"];
const deadlineMs = 180_000;

function argumentsFor(argv) {
  const options = { dependencies: project, output: resolve(project, "artifacts/qa01-repository-benchmark.json"), image: "sage-worker:local" };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, "");
    if (!Object.hasOwn(options, key) || !argv[i + 1]) throw new Error("BENCHMARK_ARGUMENT_INVALID");
    options[key] = argv[i + 1];
  }
  return options;
}

async function docker(args, timeout = 30_000) {
  return exec("docker", args, { timeout, maxBuffer: 4 * 1024 * 1024 });
}

/** Fresh cgroup per run; always remove the container, including timeout/OOM failures. */
async function measure(options, id, iteration) {
  const name = `sage-qa01-${randomUUID()}`;
  const args = ["create", "--name", name, "--network", "none", "--cpus", "1", "--memory", "2g", "--memory-swap", "2g",
    "--pids-limit", "128", "--read-only", "--tmpfs", "/tmp:rw,nosuid,nodev,size=64m"];
  for (const [src, dst] of [
    [project, "/workspace"],
    [resolve(options.dependencies, "node_modules"), "/workspace/node_modules"],
    [resolve(options.dependencies, "packages/analyzer-php/vendor"), "/workspace/packages/analyzer-php/vendor"],
  ]) args.push("--mount", `type=bind,src=${src},dst=${dst},readonly`);
  args.push("--workdir", "/workspace", "--entrypoint", "node", options.image, "--import", "tsx", "scripts/benchmark-repository.ts",
    "--manifest", `docs/evidence/corpora/${id}.json`, "--root", `storage/benchmarks/qa01/${id}`);
  if (iteration === 3) args.push("--reverse");
  let output = "";
  let failure = null;
  let state = null;
  let wallElapsedMs = null;
  try {
    await docker(args);
    const start = performance.now();
    try {
      output = (await docker(["start", "--attach", name], deadlineMs)).stdout;
    } catch (error) {
      failure = error.killed ? "CONTAINER_DEADLINE_EXCEEDED" : "CONTAINER_EXECUTION_FAILED";
      output = error.stdout ?? "";
    }
    wallElapsedMs = performance.now() - start;
    state = JSON.parse((await docker(["inspect", "--format", "{{json .State}}", name])).stdout);
    if (state.OOMKilled) failure = "CONTAINER_OOM_KILLED";
    if (state.Running || state.ExitCode !== 0) failure ??= "CONTAINER_EXIT_INVALID";
    let result = null;
    try { result = JSON.parse(output); } catch { failure ??= "BENCHMARK_OUTPUT_INVALID"; }
    if (result?.status !== "COMPLETE" || !(result.cgroupPeakChargedBytes > 0)) failure ??= "BENCHMARK_MEASUREMENT_INCOMPLETE";
    return { iteration, wallElapsedMs, failure, containerExitCode: state.ExitCode, oomKilled: state.OOMKilled, result };
  } finally {
    // Killing the attached Docker CLI does not stop its container: force removal is mandatory.
    await docker(["rm", "--force", name]);
  }
}

async function main() {
  const options = argumentsFor(process.argv.slice(2));
  const image = JSON.parse((await docker(["image", "inspect", options.image])).stdout)[0];
  const records = [];
  const report = {
    schemaVersion: 1, status: "RUNNING", measuredAt: new Date().toISOString(),
    scope: "Two pinned real-repository source corpora, not universal repository capacity or end-to-end pipeline latency",
    environment: { imageId: image.Id, architecture: image.Architecture, cpus: 1, memoryBytes: 2 * 1024 ** 3,
      swapBytes: 0, network: "none", freshContainerPerIteration: true, iterationsPerCorpus: 3, deadlineMs },
    measurements: records,
    limitations: ["Container peak charged memory includes Node, PHP children, page cache and kernel charges; it is not process RSS.",
      "Host/VM filesystem caches are not flushed; each container is fresh but storage is not a cold-cache experiment.",
      "Analysis timing excludes GitHub fetch/extraction, queue, database, UI and export.",
      "Canonical replay establishes determinism on these corpora, not semantic completeness."],
  };
  await mkdir(dirname(resolve(options.output)), { recursive: true });
  for (const id of ids) {
    const manifest = await readFile(resolve(project, `docs/evidence/corpora/${id}.json`));
    for (let iteration = 1; iteration <= 3; iteration++) {
      process.stderr.write(`Measuring ${id} ${iteration}/3\n`);
      const record = await measure(options, id, iteration);
      records.push({ corpus: id, manifestSha256: createHash("sha256").update(manifest).digest("hex"), ...record });
      report.status = record.failure ? "FAILED" : "RUNNING";
      await writeFile(options.output, `${JSON.stringify(report, null, 2)}\n`);
      if (record.failure) throw new Error(record.failure);
    }
    const results = records.filter(record => record.corpus === id).map(record => record.result);
    const first = results[0];
    if (results.some(result => result.inputFingerprint !== first.inputFingerprint || result.ccmContentSha256 !== first.ccmContentSha256 ||
      result.ckgContentSha256 !== first.ckgContentSha256 || result.nodeCount !== first.nodeCount || result.edgeCount !== first.edgeCount)) {
      report.status = "FAILED";
      await writeFile(options.output, `${JSON.stringify(report, null, 2)}\n`);
      throw new Error("BENCHMARK_REPLAY_MISMATCH");
    }
  }
  report.status = "COMPLETE";
  await writeFile(options.output, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`Benchmark complete: ${options.output}\n`);
}

main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
