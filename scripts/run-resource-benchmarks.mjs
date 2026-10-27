import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const project = fileURLToPath(new URL("../", import.meta.url));
const workloadScript = resolve(project, "scripts/benchmark-resource-workload.ts");
const sharedBenchmarkScript = resolve(project, "scripts/benchmark-repository.ts");
export const RESOURCE_CASES = Object.freeze({
  "small-ts": { manifest: "docs/evidence/corpora/resource-small-ts.json", root: "packages/contracts/examples", language: "javascript" },
  "small-php": { manifest: "docs/evidence/corpora/resource-small-php.json", root: "tests/fixtures/php-namespaces", language: "php" },
  "medium-ts": { manifest: "docs/evidence/corpora/resource-medium-ts.json", root: "storage/benchmarks/qa01/sage-js", language: "javascript" },
  "medium-php": { manifest: "docs/evidence/corpora/resource-medium-php.json", root: "storage/benchmarks/qa01/php-parser", language: "php" },
  "reference-ts": { manifest: "docs/evidence/corpora/sage-js.json", root: "storage/benchmarks/qa01/sage-js", language: "javascript" },
  "reference-php": { manifest: "docs/evidence/corpora/php-parser.json", root: "storage/benchmarks/qa01/php-parser", language: "php" },
});
const defaultCases = Object.freeze(["small-ts", "small-php", "medium-ts", "medium-php"]);
const stages = Object.freeze(["loadInput", "adapter", "canonicalCcm", "canonicalCkg", "documentProjection", "markdownRender", "pdfRender"]);
const cpuKeys = Object.freeze(["usage_usec", "user_usec", "system_usec", "nr_periods", "nr_throttled", "throttled_usec"]);
const deadlineMs = 180_000;
const memoryBytes = 2 * 1024 ** 3;
const sha256Pattern = /^[a-f0-9]{64}$/;

export class ResourceBenchmarkError extends Error {
  constructor(readonlyCode) {
    super(readonlyCode);
    this.name = "ResourceBenchmarkError";
    this.code = readonlyCode;
  }
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function safeErrorCode(error, fallback = "BENCHMARK_RUNNER_FAILED") {
  const code = typeof error?.code === "string" && /^[A-Z][A-Z0-9_]{0,79}$/.test(error.code)
    ? error.code
    : typeof error?.message === "string" && /^[A-Z][A-Z0-9_]{0,79}$/.test(error.message)
      ? error.message
      : fallback;
  return /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : fallback;
}

export function parseArguments(argv, cwd = project) {
  const options = { image: "sage-worker:local", iterations: 3, output: null, cases: [] };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]?.replace(/^--/, "");
    if (!new Set(["image", "iterations", "output", "case"]).has(key) || !argv[index]?.startsWith("--")) {
      throw new ResourceBenchmarkError("BENCHMARK_ARGUMENT_INVALID");
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--") || value.includes("\0")) throw new ResourceBenchmarkError("BENCHMARK_ARGUMENT_INVALID");
    if (key === "case") {
      if (!Object.hasOwn(RESOURCE_CASES, value) || options.cases.includes(value)) throw new ResourceBenchmarkError("BENCHMARK_ARGUMENT_INVALID");
      options.cases.push(value);
    } else {
      if (seen.has(key)) throw new ResourceBenchmarkError("BENCHMARK_ARGUMENT_INVALID");
      seen.add(key);
      if (key === "iterations") {
        if (!/^[1-3]$/.test(value)) throw new ResourceBenchmarkError("BENCHMARK_ITERATIONS_INVALID");
        options.iterations = Number(value);
      } else if (key === "image") {
        if (value.length > 255 || /\s/.test(value)) throw new ResourceBenchmarkError("BENCHMARK_IMAGE_INVALID");
        options.image = value;
      } else {
        options.output = resolve(cwd, value);
      }
    }
    index += 1;
  }
  options.cases = options.cases.length ? options.cases : [...defaultCases];
  options.output ??= resolve(project, "artifacts/resource-benchmarks", `resource-benchmark-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}.json`);
  return options;
}

function validInteger(value, allowZero = true) {
  return Number.isSafeInteger(value) && (allowZero ? value >= 0 : value > 0);
}

function validCpuStat(value) {
  return isRecord(value) && Object.keys(value).length === cpuKeys.length && cpuKeys.every(key => validInteger(value[key]));
}

function validMetrics(metrics) {
  if (!isRecord(metrics)) return false;
  const nullableCountKeys = ["inputFileCount", "inputBytes", "ccmBytes", "ckgBytes", "documentBytes", "markdownBytes", "pdfBytes", "nodeCount", "edgeCount", "limitationCount"];
  if (nullableCountKeys.some(key => metrics[key] !== null && !validInteger(metrics[key]))) return false;
  const nullableHashKeys = ["inputFingerprint", "ccmContentSha256", "ckgContentSha256", "documentSha256", "markdownSha256", "pdfSha256"];
  if (nullableHashKeys.some(key => metrics[key] !== null && (typeof metrics[key] !== "string" || !sha256Pattern.test(metrics[key])))) return false;
  return metrics.adapterStatus === null || metrics.adapterStatus === "complete" || metrics.adapterStatus === "partial";
}

/** Validate workload evidence while retaining legitimate stage failures as failed samples. */
export function validateWorkloadPayload(value, expectedManifestId, expectedLanguage) {
  if (!isRecord(value) || value.schemaVersion !== 1 || (value.status !== "COMPLETE" && value.status !== "FAILED")) {
    return { valid: false, failureCode: "BENCHMARK_OUTPUT_INVALID", result: null };
  }
  if ((value.manifestId !== expectedManifestId && value.manifestId !== null) ||
      (value.language !== expectedLanguage && value.language !== null) || !isRecord(value.stageTimingsMs) ||
      Object.keys(value.stageTimingsMs).length !== stages.length || stages.some(key => {
        const timing = value.stageTimingsMs[key];
        return timing !== null && (typeof timing !== "number" || !Number.isFinite(timing) || timing < 0);
      }) || typeof value.coreElapsedMs !== "number" || !Number.isFinite(value.coreElapsedMs) || value.coreElapsedMs < 0 ||
      Math.abs(value.coreElapsedMs - stages.reduce((sum, key) => sum + (value.stageTimingsMs[key] ?? 0), 0)) > 0.1 ||
      !validInteger(value.nodePeakRssBytes) || !validMetrics(value.metrics)) {
    return { valid: false, failureCode: "BENCHMARK_MEASUREMENT_INVALID", result: null };
  }
  if ((value.cgroupPeakChargedBytes !== null && !validInteger(value.cgroupPeakChargedBytes)) ||
      (value.cgroupPeakReason !== null && typeof value.cgroupPeakReason !== "string") ||
      (value.cgroupCpuStatStart !== null && !validCpuStat(value.cgroupCpuStatStart)) ||
      (value.cgroupCpuStatEnd !== null && !validCpuStat(value.cgroupCpuStatEnd)) ||
      (value.cgroupCpuStatDelta !== null && !validCpuStat(value.cgroupCpuStatDelta)) ||
      (value.cgroupCpuStatReason !== null && typeof value.cgroupCpuStatReason !== "string")) {
    return { valid: false, failureCode: "BENCHMARK_MEASUREMENT_INVALID", result: null };
  }

  if (value.status === "COMPLETE") {
    const metrics = value.metrics;
    const completeMetrics = metrics.inputFingerprint && metrics.inputFileCount > 0 && metrics.inputBytes !== null &&
      metrics.adapterStatus && metrics.ccmContentSha256 && metrics.ccmBytes !== null && metrics.ckgContentSha256 &&
      metrics.ckgBytes !== null && metrics.documentSha256 && metrics.documentBytes !== null && metrics.markdownSha256 &&
      metrics.markdownBytes !== null && metrics.pdfSha256 && metrics.pdfBytes > 0 && metrics.nodeCount !== null &&
      metrics.edgeCount !== null && metrics.limitationCount !== null;
    if (!completeMetrics || stages.some(key => typeof value.stageTimingsMs[key] !== "number") ||
        value.failureStage !== null || value.failureCode !== null || !validInteger(value.nodePeakRssBytes, false) ||
        !validInteger(value.cgroupPeakChargedBytes, false) || !validCpuStat(value.cgroupCpuStatStart) ||
        !validCpuStat(value.cgroupCpuStatEnd) || !validCpuStat(value.cgroupCpuStatDelta) || value.cgroupCpuStatReason !== null) {
      return { valid: false, failureCode: "BENCHMARK_MEASUREMENT_INCOMPLETE", result: null };
    }
    return { valid: true, failureCode: null, result: value };
  }

  const failureIndex = stages.indexOf(value.failureStage);
  if (failureIndex < 0 || typeof value.failureCode !== "string" || !/^[A-Z][A-Z0-9_]{0,79}$/.test(value.failureCode) ||
      typeof value.stageTimingsMs[value.failureStage] !== "number" ||
      stages.slice(0, failureIndex).some(key => typeof value.stageTimingsMs[key] !== "number") ||
      stages.slice(failureIndex + 1).some(key => value.stageTimingsMs[key] !== null) || value.nodePeakRssBytes === 0) {
    return { valid: false, failureCode: "BENCHMARK_FAILURE_EVIDENCE_INVALID", result: null };
  }
  return { valid: true, failureCode: value.failureCode, result: value };
}

async function docker(args, timeout = 30_000) {
  return exec("docker", args, { timeout, maxBuffer: 4 * 1024 * 1024 });
}

async function fileFingerprint(path) {
  const bytes = await readFile(path);
  return digest(bytes);
}

async function caseMetadata(id) {
  const spec = RESOURCE_CASES[id];
  if (!spec) throw new ResourceBenchmarkError("BENCHMARK_CASE_INVALID");
  const manifestPath = resolve(project, spec.manifest);
  const raw = await readFile(manifestPath);
  let manifest;
  try { manifest = JSON.parse(raw.toString("utf8")); } catch { throw new ResourceBenchmarkError("BENCHMARK_MANIFEST_INVALID"); }
  if (!isRecord(manifest) || manifest.schemaVersion !== 1 || manifest.id !== spec.manifest.split("/").at(-1).replace(/\.json$/, "") ||
      manifest.language !== spec.language || !Array.isArray(manifest.files) || manifest.files.length < 1 ||
      manifest.files.some(file => !isRecord(file) || typeof file.path !== "string" || !sha256Pattern.test(file.sha256) || !validInteger(file.sizeBytes))) {
    throw new ResourceBenchmarkError("BENCHMARK_MANIFEST_INVALID");
  }
  const fixtureSet = manifest.files.map(file => ({ path: file.path, sha256: file.sha256, sizeBytes: file.sizeBytes }))
    .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  return {
    id,
    manifestId: manifest.id,
    language: manifest.language,
    manifestPath,
    rootPath: resolve(project, spec.root),
    manifestSha256: digest(raw),
    fixtureSetSha256: digest(JSON.stringify(fixtureSet)),
    inputFileCount: fixtureSet.length,
    declaredInputBytes: fixtureSet.reduce((sum, file) => sum + file.sizeBytes, 0),
  };
}

function extractWorkloadOutput(output) {
  for (const line of output.split(/\r?\n/).reverse()) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (isRecord(parsed) && parsed.schemaVersion === 1) return parsed;
    } catch { /* Ignore runtime diagnostics; only a JSON evidence record is retained. */ }
  }
  return null;
}

function classifyExecError(error, fallback) {
  return error?.killed || error?.code === "ETIMEDOUT" ? "CONTAINER_DEADLINE_EXCEEDED" : fallback;
}

/** Docker attach exits nonzero for a legitimate failed workload; keep the domain failure. */
export function resolveSampleFailure(current, workloadFailure, exitCode, oomKilled) {
  if (oomKilled) return "CONTAINER_OOM_KILLED";
  if (current !== null && !["CONTAINER_EXECUTION_FAILED", "CONTAINER_EXIT_INVALID"].includes(current)) return current;
  if (workloadFailure !== null) return workloadFailure;
  if (exitCode !== 0) return "CONTAINER_EXIT_INVALID";
  return current;
}

/** A timed-out create may already have created the container on the daemon. */
export async function cleanupSampleContainer(name, invokeDocker = docker) {
  try {
    await invokeDocker(["rm", "--force", name]);
    return true;
  } catch (error) {
    return /No such (?:container|object):/i.test(String(error?.stderr ?? ""));
  }
}

/** One fresh offline cgroup per sample; docker rm --force runs after every attempted create. */
async function measure(options, corpus, iteration, runtimeImageId, preflightFailure = null) {
  const name = `sage-resource-${randomUUID()}`;
  const record = {
    corpus: corpus.id,
    manifestId: corpus.manifestId ?? null,
    iteration,
    manifestSha256: corpus.manifestSha256 ?? null,
    fixtureSetSha256: corpus.fixtureSetSha256 ?? null,
    inputFileCount: corpus.inputFileCount ?? null,
    declaredInputBytes: corpus.declaredInputBytes ?? null,
    wallElapsedMs: null,
    containerExitCode: null,
    oomKilled: false,
    result: null,
    failureCode: preflightFailure,
    cleanupFailure: false,
  };
  if (preflightFailure) return record;
  const args = ["create", "--name", name, "--network", "none", "--cpus", "1", "--memory", "2g", "--memory-swap", "2g",
    "--pids-limit", "256", "--shm-size", "256m", "--read-only", "--tmpfs", "/tmp:rw,nosuid,nodev,size=256m"];
  for (const [src, dst] of [
    [workloadScript, "/app/scripts/benchmark-resource-workload.ts"],
    [sharedBenchmarkScript, "/app/scripts/benchmark-repository.ts"],
    [corpus.rootPath, "/input"],
    [corpus.manifestPath, "/manifest.json"],
  ]) args.push("--mount", `type=bind,src=${src},dst=${dst},readonly`);
  args.push("--workdir", "/app", "--entrypoint", "node", runtimeImageId, "--import", "tsx",
    "/app/scripts/benchmark-resource-workload.ts", "--manifest", "/manifest.json", "--root", "/input");

  let created = false;
  let output = "";
  try {
    try {
      await docker(args);
      created = true;
    } catch (error) {
      record.failureCode = classifyExecError(error, "CONTAINER_CREATE_FAILED");
    }
    if (created) {
      const started = performance.now();
      try {
        output = (await docker(["start", "--attach", name], deadlineMs)).stdout;
      } catch (error) {
        output = typeof error?.stdout === "string" ? error.stdout : "";
        record.failureCode = classifyExecError(error, "CONTAINER_EXECUTION_FAILED");
      }
      record.wallElapsedMs = performance.now() - started;
      try {
        const inspected = JSON.parse((await docker(["inspect", "--format", "{{json .State}}", name])).stdout);
        record.containerExitCode = Number.isSafeInteger(inspected.ExitCode) ? inspected.ExitCode : null;
        record.oomKilled = inspected.OOMKilled === true;
        if (record.oomKilled) record.failureCode = "CONTAINER_OOM_KILLED";
        else if (inspected.Running === true) record.failureCode ??= "CONTAINER_DEADLINE_EXCEEDED";
      } catch {
        record.failureCode ??= "CONTAINER_INSPECT_FAILED";
      }
      const payload = extractWorkloadOutput(output);
      const checked = validateWorkloadPayload(payload, corpus.manifestId, corpus.language);
      if (checked.valid) {
        record.result = checked.result;
        record.failureCode = resolveSampleFailure(record.failureCode, checked.failureCode, record.containerExitCode, record.oomKilled);
      } else {
        record.failureCode ??= checked.failureCode;
      }
    }
  } finally {
    if (!(await cleanupSampleContainer(name))) {
      record.cleanupFailure = true;
      record.failureCode ??= "CONTAINER_CLEANUP_FAILED";
    }
  }
  return record;
}

function replayMetrics(result) {
  const metrics = result.metrics;
  return {
    inputFingerprint: metrics.inputFingerprint,
    ccmContentSha256: metrics.ccmContentSha256,
    ckgContentSha256: metrics.ckgContentSha256,
    documentSha256: metrics.documentSha256,
    markdownSha256: metrics.markdownSha256,
    inputFileCount: metrics.inputFileCount,
    inputBytes: metrics.inputBytes,
    nodeCount: metrics.nodeCount,
    edgeCount: metrics.edgeCount,
    limitationCount: metrics.limitationCount,
    ccmBytes: metrics.ccmBytes,
    ckgBytes: metrics.ckgBytes,
    documentBytes: metrics.documentBytes,
    markdownBytes: metrics.markdownBytes,
  };
}

function replayChecks(cases, samples, iterations) {
  return cases.map(id => {
    const group = samples.filter(sample => sample.corpus === id);
    const successful = group.filter(sample => sample.failureCode === null && sample.result?.status === "COMPLETE");
    if (group.length !== iterations || successful.length !== iterations) {
      return { corpus: id, status: "INCOMPLETE", successfulIterations: successful.length, expectedIterations: iterations };
    }
    const reference = JSON.stringify(replayMetrics(successful[0].result));
    const equal = successful.every(sample => JSON.stringify(replayMetrics(sample.result)) === reference);
    return { corpus: id, status: equal ? "PASS" : "FAIL", successfulIterations: successful.length, expectedIterations: iterations };
  });
}

function initialReport(options) {
  return {
    schemaVersion: 1,
    status: "RUNNING",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    scope: "Fresh-container local benchmark of direct analyzer adapters, canonical CCM/CKG generation, architecture document projection, Markdown rendering, and sequential offline PDF rendering. It excludes analyzeSnapshotSources scanning/merge, database, queue, network fetch, persistence, and UI stages.",
    environment: {
      image: options.image,
      imageId: null,
      architecture: null,
      gitHead: null,
      scriptFingerprintsSha256: null,
      limits: { cpus: 1, memoryBytes, swapBytes: 0, pids: 256, shmBytes: 256 * 1024 ** 2, tmpfsBytes: 256 * 1024 ** 2,
        network: "none", rootFilesystem: "read-only", freshContainerPerSample: true, externalDeadlineMs: deadlineMs },
    },
    plan: { cases: options.cases, iterationsPerCase: options.iterations, caseMode: options.cases.some(id => id.startsWith("reference-")) ? "includes full-reference boundary probes" : "small plus deterministic partial-corpus workloads" },
    corpora: [],
    samples: [],
    replayChecks: [],
    failureCodes: [],
    runnerFailureCode: null,
    limitations: [
      "Node peak RSS is process-level; cgroup memory.peak and cpu.stat include the whole container, including PHP child processes and Chromium.",
      "Container resource readings include Node startup and renderer work; stage wall times are measured inside the workload process.",
      "PDF SHA-256 and size are recorded for each sample; byte-level PDF replay is excluded because Chromium may vary PDF metadata or compression between renders.",
      "Each container starts with fresh cgroup counters, but the host or VM filesystem cache is not flushed.",
      "This bounded local workload is not an end-to-end service capacity or production concurrency gate.",
    ],
  };
}

async function reserveOutput(path, value) {
  const target = resolve(path);
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  try {
    await link(temporary, target);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    if (error?.code === "EEXIST") throw new ResourceBenchmarkError("BENCHMARK_OUTPUT_ALREADY_EXISTS");
    throw error;
  }
  await unlink(temporary);
  return target;
}

async function writeReportAtomically(path, report) {
  const target = resolve(path);
  const temporary = `${target}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  await rename(temporary, target);
}

async function setRunnerFailure(report, code) {
  report.runnerFailureCode = code;
  report.status = "FAILED";
  report.finishedAt = new Date().toISOString();
}

async function main(argv) {
  let options;
  try {
    options = parseArguments(argv);
  } catch (error) {
    process.stderr.write(`${safeErrorCode(error, "BENCHMARK_ARGUMENT_INVALID")}\n`);
    process.exitCode = 1;
    return;
  }
  const report = initialReport(options);
  let outputPath;
  try {
    outputPath = await reserveOutput(options.output, report);
  } catch (error) {
    process.stderr.write(`${safeErrorCode(error, "BENCHMARK_OUTPUT_CREATE_FAILED")}\n`);
    process.exitCode = 1;
    return;
  }

  let preflightFailure = null;
  let runtimeImageId = null;
  const metadataById = new Map();
  try {
    try {
      report.environment.gitHead = (await exec("git", ["-C", project, "rev-parse", "HEAD"])).stdout.trim();
      report.environment.scriptFingerprintsSha256 = {
        runner: await fileFingerprint(fileURLToPath(import.meta.url)),
        workload: await fileFingerprint(workloadScript),
        benchmarkInputLoader: await fileFingerprint(sharedBenchmarkScript),
      };
    } catch (error) {
      preflightFailure = safeErrorCode(error, "BENCHMARK_SOURCE_FINGERPRINT_FAILED");
    }
    for (const id of options.cases) {
      try {
        const metadata = await caseMetadata(id);
        metadataById.set(id, metadata);
        report.corpora.push({ corpus: id, manifestId: metadata.manifestId, language: metadata.language,
          manifestSha256: metadata.manifestSha256, fixtureSetSha256: metadata.fixtureSetSha256,
          inputFileCount: metadata.inputFileCount, declaredInputBytes: metadata.declaredInputBytes });
      } catch (error) {
        metadataById.set(id, { id, manifestId: null, language: RESOURCE_CASES[id]?.language ?? null, metadataFailure: safeErrorCode(error, "BENCHMARK_MANIFEST_INVALID") });
        report.corpora.push({ corpus: id, manifestId: null, language: RESOURCE_CASES[id]?.language ?? null, metadataFailure: metadataById.get(id).metadataFailure });
      }
    }
    if (!preflightFailure) {
      try {
        const image = JSON.parse((await docker(["image", "inspect", options.image])).stdout)[0];
        report.environment.imageId = image.Id;
        report.environment.architecture = image.Architecture;
        runtimeImageId = image.Id;
        if (image.Os !== "linux" || !image.Id || !image.Architecture) preflightFailure = "BENCHMARK_IMAGE_METADATA_INVALID";
      } catch (error) {
        preflightFailure = classifyExecError(error, "BENCHMARK_IMAGE_UNAVAILABLE");
      }
    }
    await writeReportAtomically(outputPath, report);

    for (const id of options.cases) {
      const corpus = metadataById.get(id);
      for (let iteration = 1; iteration <= options.iterations; iteration += 1) {
        process.stderr.write(`Measuring ${id} ${iteration}/${options.iterations}\n`);
        const failure = corpus?.metadataFailure ?? preflightFailure;
        const record = failure ? {
          corpus: id, manifestId: corpus?.manifestId ?? null, iteration,
          manifestSha256: corpus?.manifestSha256 ?? null, fixtureSetSha256: corpus?.fixtureSetSha256 ?? null,
          inputFileCount: corpus?.inputFileCount ?? null, declaredInputBytes: corpus?.declaredInputBytes ?? null,
          wallElapsedMs: null, containerExitCode: null, oomKilled: false, result: null, failureCode: failure, cleanupFailure: false,
        } : await measure(options, corpus, iteration, runtimeImageId);
        report.samples.push(record);
        report.failureCodes = [...new Set(report.samples.map(sample => sample.failureCode).filter(Boolean))].sort();
        report.status = report.samples.some(sample => sample.failureCode) ? "RUNNING_WITH_FAILURES" : "RUNNING";
        await writeReportAtomically(outputPath, report);
      }
    }
    report.replayChecks = replayChecks(options.cases, report.samples, options.iterations);
    const replayFailed = report.replayChecks.some(check => check.status === "FAIL");
    const sampleFailed = report.samples.some(sample => sample.failureCode !== null);
    report.status = replayFailed || sampleFailed || report.runnerFailureCode ? "FAILED" : "COMPLETE";
    report.finishedAt = new Date().toISOString();
    await writeReportAtomically(outputPath, report);
    process.stdout.write(`Resource benchmark ${report.status}: ${outputPath}\n`);
    if (report.status !== "COMPLETE") process.exitCode = 1;
  } catch (error) {
    await setRunnerFailure(report, safeErrorCode(error));
    try { await writeReportAtomically(outputPath, report); } catch { /* Keep the last valid atomic report. */ }
    process.stderr.write(`${report.runnerFailureCode}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main(process.argv.slice(2));
