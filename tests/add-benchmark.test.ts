import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { SourceAnalysisResult } from "../apps/worker/src/source-analysis.ts";
import { analyzeSnapshotSources } from "../apps/worker/src/source-analysis.ts";
import type { SnapshotFile } from "../apps/worker/src/snapshot/archive.ts";
import { assertAddBenchmarkSourceQuality, summarizeAddBenchmarkSource } from "../scripts/add-benchmark-quality.ts";

function source(path: string, value: string): SnapshotFile {
  const bytes = new TextEncoder().encode(value);
  return { relativePath: path, bytes, byteLength: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") };
}

test("ADD benchmark gate requires each eligible language to process at least one source", async () => {
  const valid = await analyzeSnapshotSources({
    snapshot: { repository: "fixture/add-benchmark", branch: "main", commitSha: "a".repeat(40) },
    files: [source("src/main.ts", "export class Main {}\n")],
  });
  assert.equal(valid.status, "complete");
  assert.equal(summarizeAddBenchmarkSource(valid).counts.languages.typescript?.processed, 1);
  assert.doesNotThrow(() => assertAddBenchmarkSourceQuality(valid));

  const phpUnavailable: SourceAnalysisResult = {
    ...valid,
    status: "partial",
    report: {
      ...valid.report,
      counts: {
        ...valid.report.counts,
        languages: {
          ...valid.report.counts.languages,
          php: { recognized: 80, eligible: 80, processed: 0, failed: 80 },
        },
      },
    },
  };
  assert.equal(summarizeAddBenchmarkSource(phpUnavailable).counts.languages.php?.processed, 0);
  assert.throws(() => assertAddBenchmarkSourceQuality(phpUnavailable), /processed no eligible files for: php \(80 eligible, 80 failed\)/u);
});

test("ADD benchmark gate rejects failed source analysis even when a model is present", async () => {
  const failed = await analyzeSnapshotSources({
    snapshot: { repository: "fixture/add-benchmark", branch: "main", commitSha: "a".repeat(40) },
    files: [source("src/bad.ts", "export class {\n")],
  });
  assert.equal(failed.status, "failed");
  assert.ok(failed.ccm, "failed analysis keeps a validated status model for diagnostics");
  assert.throws(() => assertAddBenchmarkSourceQuality(failed), /Source analysis failed: PARSE_FAILED/u);
});
