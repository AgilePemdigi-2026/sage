import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as jsAnalyzer from "@sage/analyzer-js";
import * as phpAnalyzer from "@sage/analyzer-php";
import { verifyResolverOracles, type ResolverLanguage } from "./verify-resolver-oracles.ts";

type AnalyzeReferencesInput = {
  snapshot: { repository: string; branch: null; commitSha: string };
  sources: Readonly<Record<string, Uint8Array>>;
};
type AnalyzeReferences = (input: AnalyzeReferencesInput) => unknown | Promise<unknown>;
type ReferenceAdapter = { analyzeReferences?: AnalyzeReferences };

const projectRoot = new URL("../", import.meta.url);
const adapters: Array<{ language: ResolverLanguage; inputLanguages: ResolverLanguage[]; module: ReferenceAdapter }> = [
  { language: "javascript", inputLanguages: ["javascript", "typescript"], module: jsAnalyzer as typeof jsAnalyzer & ReferenceAdapter },
  { language: "php", inputLanguages: ["php"], module: phpAnalyzer as typeof phpAnalyzer & ReferenceAdapter },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function adapterName(language: ResolverLanguage): string {
  return language === "javascript" ? "@sage/analyzer-js" : "@sage/analyzer-php";
}

async function main(): Promise<void> {
  const manifest = await verifyResolverOracles();
  const absent = adapters.filter((adapter) => typeof adapter.module.analyzeReferences !== "function").map((adapter) => adapterName(adapter.language));
  if (absent.length > 0) {
    console.log(JSON.stringify({
      status: "NOT_RUN",
      reason: "ANALYZE_REFERENCES_API_UNAVAILABLE",
      unavailableAdapters: absent,
      fixtureIntegrity: "PASS",
      semanticAcceptance: "NOT_RUN",
      limitations: ["No declaration-only or mock adapter fallback is used; elapsed time is withheld until the reference APIs exist."],
    }));
    process.exitCode = 2;
    return;
  }

  const measurements: Array<Record<string, unknown>> = [];
  const iterations = 3;

  for (const adapter of adapters) {
    const files = manifest.files.filter((file) => adapter.inputLanguages.includes(file.language));
    const sources: Record<string, Uint8Array> = {};
    for (const file of files) {
      sources[file.path] = await readFile(resolve(fileURLToPath(projectRoot), file.path));
    }
    const fixtureFingerprint = createHash("sha256")
      .update(files.map((file) => `${file.path}\0${file.sha256}`).sort().join("\n"))
      .digest("hex");
    const snapshot: AnalyzeReferencesInput["snapshot"] = {
      repository: "sage/resolver-oracle-fixtures",
      branch: null,
      commitSha: fixtureFingerprint,
    };
    const fileCount = files.length;
    const inputBytes = files.reduce((total, file) => total + file.sizeBytes, 0);

    for (let iteration = 1; iteration <= iterations; iteration += 1) {
      const rssBeforeBytes = process.memoryUsage().rss;
      const startedAt = process.hrtime.bigint();
      let result: unknown;
      let thrownMessage: string | null = null;
      try {
        result = await adapter.module.analyzeReferences!({ snapshot, sources });
      } catch (error) {
        thrownMessage = error instanceof Error ? error.message : String(error);
      }
      const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      const rssAfterBytes = process.memoryUsage().rss;
      const resultRecord = isRecord(result) ? result : null;
      const ccm = isRecord(resultRecord?.ccm) ? resultRecord.ccm : null;
      const nodes = Array.isArray(ccm?.nodes) ? ccm.nodes : null;
      const edges = Array.isArray(ccm?.edges) ? ccm.edges : null;
      const status = typeof resultRecord?.status === "string" ? resultRecord.status : null;
      const errorCode = resultRecord?.errorCode;
      const ccmHash = typeof resultRecord?.contentSha256 === "string"
        ? resultRecord.contentSha256
        : typeof ccm?.contentSha256 === "string" ? ccm.contentSha256 : null;
      const acceptedStatus = status === "complete" || status === "partial";
      const failed = thrownMessage !== null || result === undefined || result === null || !acceptedStatus || errorCode !== null ||
        ccm === null || nodes === null || edges === null;
      let failureReason: string | null = null;
      if (failed) {
        if (thrownMessage !== null) failureReason = "ADAPTER_THROWN";
        else if (result === undefined || result === null) failureReason = "EMPTY_RESULT";
        else if (status === "failed") failureReason = "ADAPTER_FAILED";
        else if (ccm === null) failureReason = "CCM_MISSING";
        else if (nodes === null || edges === null) failureReason = "CCM_SHAPE_INVALID";
        else if (!acceptedStatus) failureReason = "ADAPTER_STATUS_INVALID";
        else if (errorCode !== null) failureReason = "ADAPTER_ERROR_CODE_PRESENT";
        else failureReason = "ADAPTER_RESULT_INVALID";
      }
      const measurement = {
        adapter: adapterName(adapter.language),
        iteration,
        fixtureFingerprint,
        fileCount,
        inputBytes,
        elapsedMs,
        processRssBeforeBytes: rssBeforeBytes,
        processRssAfterBytes: rssAfterBytes,
        processRssDeltaBytes: rssAfterBytes - rssBeforeBytes,
        status: thrownMessage === null ? status : "THREW",
        errorCode: thrownMessage === null ? errorCode ?? null : "ANALYZE_REFERENCES_THROW",
        ccmNodeCount: nodes?.length ?? null,
        ccmEdgeCount: edges?.length ?? null,
        ccmHash,
        failureReason,
        thrownMessage,
      };
      measurements.push(measurement);
      if (failed) {
        console.log(JSON.stringify({
          status: "FAILED",
          reason: "ADAPTER_RESULT_NOT_COMPLETE",
          fixtureIntegrity: "PASS",
          semanticAcceptance: "NOT_RUN",
          measurements,
          limitations: ["A benchmark accepts complete or partial adapter status only when errorCode is null and CCM includes node and edge arrays."],
        }));
        process.exitCode = 1;
        return;
      }
    }
  }

  console.log(JSON.stringify({
    status: "COMPLETE",
    benchmarkScope: "small-hand-authored-resolver-fixtures",
    fixtureIntegrity: "PASS",
    semanticAcceptance: "NOT_RUN",
    iterationsPerAdapter: iterations,
    measurements,
    limitations: [
      "These six small hand-authored fixtures are a microbenchmark, not a representative real-repository performance sample.",
      "RSS is sampled from the calling Node process only; PHP child-process and worker peak RSS are not measured.",
      "Timing, CCM counts, and content hashes are descriptive and do not establish semantic correctness.",
    ],
  }));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
