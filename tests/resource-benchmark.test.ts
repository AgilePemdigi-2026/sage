import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { loadBenchmarkInput } from "../scripts/benchmark-repository.ts";
import { parseArguments, RESOURCE_CASES, validateWorkloadPayload } from "../scripts/run-resource-benchmarks.mjs";

const project = resolve(new URL("../", import.meta.url).pathname);
const cpu = { usage_usec: 1_000, user_usec: 750, system_usec: 250, nr_periods: 4, nr_throttled: 1, throttled_usec: 20 };
const hashes = {
  inputFingerprint: "1".repeat(64), ccmContentSha256: "2".repeat(64), ckgContentSha256: "3".repeat(64),
  documentSha256: "4".repeat(64), markdownSha256: "5".repeat(64), pdfSha256: "6".repeat(64),
};

function completePayload() {
  const timings = {
    loadInput: 1, adapter: 2, canonicalCcm: 3, canonicalCkg: 4,
    documentProjection: 5, markdownRender: 6, pdfRender: 7,
  };
  return {
    schemaVersion: 1,
    status: "COMPLETE",
    manifestId: "resource-small-ts",
    language: "javascript",
    stageTimingsMs: timings,
    coreElapsedMs: Object.values(timings).reduce((sum, value) => sum + value, 0),
    nodePeakRssBytes: 20_000_000,
    cgroupPeakChargedBytes: 300_000_000,
    cgroupPeakReason: null,
    cgroupCpuStatStart: cpu,
    cgroupCpuStatEnd: { ...cpu, usage_usec: 2_000, user_usec: 1_500, system_usec: 500, nr_periods: 8, nr_throttled: 2, throttled_usec: 40 },
    cgroupCpuStatDelta: { ...cpu },
    cgroupCpuStatReason: null,
    metrics: {
      ...hashes,
      inputFileCount: 1, inputBytes: 23, adapterStatus: "complete", ccmBytes: 1_000, ckgBytes: 2_000,
      documentBytes: 3_000, markdownBytes: 4_000, pdfBytes: 5_000, nodeCount: 2, edgeCount: 1, limitationCount: 0,
    },
    failureStage: null,
    failureCode: null,
  };
}

test("resource corpus manifests load exact fixtures and bounded deterministic subsets", async () => {
  for (const id of ["small-ts", "small-php"]) {
    const spec = RESOURCE_CASES[id]!;
    const manifestPath = resolve(project, spec.manifest);
    const rootPath = resolve(project, spec.root);
    const loaded = await loadBenchmarkInput(manifestPath, rootPath);
    assert.equal(loaded.manifest.id, spec.manifest.split("/").at(-1)!.replace(/\.json$/, ""));
    assert.equal(loaded.manifest.language, spec.language);
    assert.match(loaded.inputFingerprint, /^[a-f0-9]{64}$/);
  }

  const smallTs = JSON.parse(await readFile(resolve(project, RESOURCE_CASES["small-ts"]!.manifest), "utf8"));
  assert.deepEqual(smallTs.files.map((file: { path: string }) => file.path), ["minimum-ccm.source.ts"]);
  const smallPhp = JSON.parse(await readFile(resolve(project, RESOURCE_CASES["small-php"]!.manifest), "utf8"));
  assert.deepEqual(smallPhp.files.map((file: { path: string }) => file.path), ["contracts.php", "service.php"]);
  const mediumTs = JSON.parse(await readFile(resolve(project, RESOURCE_CASES["medium-ts"]!.manifest), "utf8"));
  const mediumPhp = JSON.parse(await readFile(resolve(project, RESOURCE_CASES["medium-php"]!.manifest), "utf8"));
  const pinnedTs = JSON.parse(await readFile(resolve(project, "docs/evidence/corpora/sage-js.json"), "utf8"));
  const pinnedPhp = JSON.parse(await readFile(resolve(project, "docs/evidence/corpora/php-parser.json"), "utf8"));
  for (const [subset, pinned, expectedCount] of [[mediumTs, pinnedTs, 12], [mediumPhp, pinnedPhp, 24]]) {
    assert.equal(subset.repository, pinned.repository);
    assert.equal(subset.commitSha, pinned.commitSha);
    assert.equal(subset.language, pinned.language);
    assert.equal(subset.files.length, expectedCount);
    assert.match(subset.selection, /Deterministic spread sample.*partial-corpus.*max 100000 source bytes/);
    assert.ok(subset.files.reduce((sum: number, file: { sizeBytes: number }) => sum + file.sizeBytes, 0) <= 100_000);
    const sorted = [...pinned.files].sort((left: { path: string }, right: { path: string }) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
    const selectedIndexes = [...new Set(Array.from({ length: expectedCount }, (_, index) => Math.round(index * (sorted.length - 1) / (expectedCount - 1))))];
    assert.deepEqual(subset.files, selectedIndexes.map(index => sorted[index]));
  }
});

test("resource benchmark arguments select bounded runs and reject invalid controls", () => {
  const defaults = parseArguments([]);
  assert.deepEqual(defaults.cases, ["small-ts", "small-php", "medium-ts", "medium-php"]);
  assert.equal(defaults.iterations, 3);
  assert.equal(defaults.image, "sage-worker:local");

  const reference = parseArguments(["--case", "reference-php", "--iterations", "2", "--image", "registry/sage:worker", "--output", "runs/out.json"], "/tmp");
  assert.deepEqual(reference.cases, ["reference-php"]);
  assert.equal(reference.iterations, 2);
  assert.equal(reference.output, "/tmp/runs/out.json");
  assert.throws(() => parseArguments(["--iterations", "4"]), /BENCHMARK_ITERATIONS_INVALID/);
  assert.throws(() => parseArguments(["--case", "unknown"]), /BENCHMARK_ARGUMENT_INVALID/);
  assert.throws(() => parseArguments(["--iterations", "1", "--iterations", "2"]), /BENCHMARK_ARGUMENT_INVALID/);
  assert.throws(() => parseArguments(["--case", "small-ts", "--case", "small-ts"]), /BENCHMARK_ARGUMENT_INVALID/);
});

test("resource measurement validation requires complete stage and cgroup evidence", () => {
  const checked = validateWorkloadPayload(completePayload(), "resource-small-ts", "javascript");
  assert.deepEqual({ valid: checked.valid, failureCode: checked.failureCode }, { valid: true, failureCode: null });

  const noPdf = completePayload();
  noPdf.cgroupPeakChargedBytes = null;
  noPdf.cgroupPeakReason = "CGROUP_MEMORY_PEAK_UNAVAILABLE";
  assert.equal(validateWorkloadPayload(noPdf, "resource-small-ts", "javascript").failureCode, "BENCHMARK_MEASUREMENT_INCOMPLETE");

  const badTiming = completePayload();
  badTiming.stageTimingsMs.pdfRender = -1;
  assert.equal(validateWorkloadPayload(badTiming, "resource-small-ts", "javascript").failureCode, "BENCHMARK_MEASUREMENT_INVALID");
});

test("expected stage failures remain valid failed-sample evidence", () => {
  const failure = completePayload();
  failure.status = "FAILED";
  failure.stageTimingsMs.pdfRender = 12;
  failure.coreElapsedMs = Object.values(failure.stageTimingsMs).reduce((sum, value) => sum + value, 0);
  failure.metrics.pdfSha256 = null;
  failure.metrics.pdfBytes = null;
  failure.failureStage = "pdfRender";
  failure.failureCode = "PDF_DOCUMENT_LIMIT_EXCEEDED";
  const checked = validateWorkloadPayload(failure, "resource-small-ts", "javascript");
  assert.equal(checked.valid, true);
  assert.equal(checked.failureCode, "PDF_DOCUMENT_LIMIT_EXCEEDED");
  assert.equal(checked.result?.metrics.documentSha256, hashes.documentSha256);

  const invalidFailure = { ...failure, stageTimingsMs: { ...failure.stageTimingsMs, markdownRender: null } };
  invalidFailure.coreElapsedMs = Object.values(invalidFailure.stageTimingsMs).reduce((sum, value) => sum + (value ?? 0), 0);
  assert.equal(validateWorkloadPayload(invalidFailure, "resource-small-ts", "javascript").failureCode, "BENCHMARK_FAILURE_EVIDENCE_INVALID");
});
