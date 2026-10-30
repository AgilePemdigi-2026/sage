import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeReferences as analyzeJavaScript } from "@sage/analyzer-js";
import { analyzeReferences as analyzePhp } from "@sage/analyzer-php";
import { canonicalizeCcm, canonicalizeCkg } from "@sage/contracts";
import { renderMarkdownDocument, renderPdfDocument } from "@sage/documents";
import { projectArchitectureDocument } from "@sage/documents/model";
import { BenchmarkInputError, loadBenchmarkInput } from "./benchmark-repository.ts";

const RESOURCE_STAGES = ["loadInput", "adapter", "canonicalCcm", "canonicalCkg", "documentProjection", "markdownRender", "pdfRender"] as const;
type ResourceStage = typeof RESOURCE_STAGES[number];
type CpuStat = { usage_usec: number; user_usec: number; system_usec: number; nr_periods: number; nr_throttled: number; throttled_usec: number };

type WorkloadMetrics = {
  inputFingerprint: string | null;
  inputFileCount: number | null;
  inputBytes: number | null;
  adapterStatus: "complete" | "partial" | null;
  ccmContentSha256: string | null;
  ccmBytes: number | null;
  ckgContentSha256: string | null;
  ckgBytes: number | null;
  documentSha256: string | null;
  documentBytes: number | null;
  markdownSha256: string | null;
  markdownBytes: number | null;
  pdfSha256: string | null;
  pdfBytes: number | null;
  nodeCount: number | null;
  edgeCount: number | null;
  limitationCount: number | null;
};

export type ResourceWorkloadResult = {
  schemaVersion: 1;
  status: "COMPLETE" | "FAILED";
  manifestId: string | null;
  language: "javascript" | "php" | null;
  stageTimingsMs: Record<ResourceStage, number | null>;
  coreElapsedMs: number;
  nodePeakRssBytes: number;
  cgroupPeakChargedBytes: number | null;
  cgroupPeakReason: string | null;
  cgroupCpuStatStart: CpuStat | null;
  cgroupCpuStatEnd: CpuStat | null;
  cgroupCpuStatDelta: CpuStat | null;
  cgroupCpuStatReason: string | null;
  metrics: WorkloadMetrics;
  failureStage: ResourceStage | null;
  failureCode: string | null;
};

class StageFailure extends Error {
  constructor(readonly stage: ResourceStage, readonly code: string) {
    super(code);
  }
}

function digest(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function readCgroupMemoryPeak(): { value: number | null; reason: string | null } {
  try {
    const raw = readFileSync("/sys/fs/cgroup/memory.peak", "utf8").trim();
    if (!/^[0-9]+$/.test(raw) || !Number.isSafeInteger(Number(raw))) return { value: null, reason: "CGROUP_MEMORY_PEAK_INVALID" };
    return { value: Number(raw), reason: null };
  } catch {
    return { value: null, reason: "CGROUP_MEMORY_PEAK_UNAVAILABLE" };
  }
}

function readCgroupCpuStat(): { value: CpuStat | null; reason: string | null } {
  try {
    const raw = readFileSync("/sys/fs/cgroup/cpu.stat", "utf8");
    const values = new Map(raw.trim().split(/\n/).map(line => line.trim().split(/\s+/)).map(([key, value]) => [key!, Number(value)]));
    const keys = ["usage_usec", "user_usec", "system_usec", "nr_periods", "nr_throttled", "throttled_usec"] as const;
    if (keys.some(key => !Number.isSafeInteger(values.get(key)) || values.get(key)! < 0)) {
      return { value: null, reason: "CGROUP_CPU_STAT_INVALID" };
    }
    return { value: Object.fromEntries(keys.map(key => [key, values.get(key)!])) as CpuStat, reason: null };
  } catch {
    return { value: null, reason: "CGROUP_CPU_STAT_UNAVAILABLE" };
  }
}

function subtractCpuStat(end: CpuStat | null, start: CpuStat | null): CpuStat | null {
  if (!end || !start) return null;
  return {
    usage_usec: Math.max(0, end.usage_usec - start.usage_usec),
    user_usec: Math.max(0, end.user_usec - start.user_usec),
    system_usec: Math.max(0, end.system_usec - start.system_usec),
    nr_periods: Math.max(0, end.nr_periods - start.nr_periods),
    nr_throttled: Math.max(0, end.nr_throttled - start.nr_throttled),
    throttled_usec: Math.max(0, end.throttled_usec - start.throttled_usec),
  };
}

function nodePeakRssBytes(): number {
  const maxRssKiB = process.resourceUsage().maxRSS;
  const bytes = maxRssKiB * 1024;
  return Number.isSafeInteger(bytes) && bytes > 0 ? bytes : 0;
}

function safeCode(error: unknown, fallback: string): string {
  const code = error instanceof BenchmarkInputError
    ? error.code
    : error instanceof Error && /^[A-Z][A-Z0-9_]{0,79}$/.test(error.message)
      ? error.message
      : fallback;
  return /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : fallback;
}

function emptyMetrics(): WorkloadMetrics {
  return {
    inputFingerprint: null, inputFileCount: null, inputBytes: null, adapterStatus: null,
    ccmContentSha256: null, ccmBytes: null, ckgContentSha256: null, ckgBytes: null,
    documentSha256: null, documentBytes: null, markdownSha256: null, markdownBytes: null,
    pdfSha256: null, pdfBytes: null, nodeCount: null, edgeCount: null, limitationCount: null,
  };
}

/** Runs the real adapter, canonical CKG, architecture projection, Markdown and Chromium PDF stages in this process. */
export async function runResourceWorkload(manifestPath: string, rootPath: string): Promise<ResourceWorkloadResult> {
  const stageTimingsMs: Record<ResourceStage, number | null> = Object.fromEntries(RESOURCE_STAGES.map(stage => [stage, null])) as Record<ResourceStage, number | null>;
  const metrics = emptyMetrics();
  const startCpu = readCgroupCpuStat();
  let manifestId: string | null = null;
  let language: ResourceWorkloadResult["language"] = null;
  let failureStage: ResourceStage | null = null;
  let failureCode: string | null = null;

  const stage = async <T>(name: ResourceStage, callback: () => Promise<T> | T): Promise<T> => {
    const start = process.hrtime.bigint();
    try {
      return await callback();
    } catch (error) {
      const knownCode = error instanceof StageFailure ? error.code : null;
      throw new StageFailure(name, knownCode ?? safeCode(error, `${name.replace(/[A-Z]/g, char => `_${char}`).toUpperCase()}_FAILED`));
    } finally {
      stageTimingsMs[name] = Number(process.hrtime.bigint() - start) / 1_000_000;
    }
  };

  try {
    const loaded = await stage("loadInput", () => loadBenchmarkInput(manifestPath, rootPath));
    manifestId = loaded.manifest.id;
    language = loaded.manifest.language;
    metrics.inputFingerprint = loaded.inputFingerprint;
    metrics.inputFileCount = loaded.manifest.files.length;
    metrics.inputBytes = loaded.manifest.files.reduce((sum, file) => sum + file.sizeBytes, 0);

    const sources = loaded.sources;
    const snapshot = { repository: loaded.manifest.repository, branch: null, commitSha: loaded.manifest.commitSha };
    const analyzed = await stage("adapter", async () => {
      const result = loaded.manifest.language === "php"
        ? await analyzePhp({ snapshot, sources })
        : await analyzeJavaScript({ snapshot, sources });
      if ((result.status !== "complete" && result.status !== "partial") || result.errorCode !== null || !result.ccm ||
          !result.contentSha256 || !result.canonicalJson) {
        throw new StageFailure("adapter", "BENCHMARK_ADAPTER_FAILED");
      }
      metrics.adapterStatus = result.status;
      return result;
    });

    const canonicalCcm = await stage("canonicalCcm", () => {
      const result = canonicalizeCcm(analyzed.ccm!, sources);
      if (!result.ok) throw new StageFailure("canonicalCcm", `BENCHMARK_CCM_INVALID_${result.errorCode}`);
      if (result.json !== analyzed.canonicalJson || result.sha256 !== analyzed.contentSha256) {
        throw new StageFailure("canonicalCcm", "BENCHMARK_CCM_HASH_MISMATCH");
      }
      metrics.ccmContentSha256 = result.sha256;
      metrics.ccmBytes = Buffer.byteLength(result.json, "utf8");
      metrics.limitationCount = analyzed.ccm!.limitations.length;
      return result;
    });

    const canonicalCkg = await stage("canonicalCkg", () => {
      const result = canonicalizeCkg(canonicalCcm.value, sources, analyzed.ccm!.provenance.configHash);
      if (!result.ok) throw new StageFailure("canonicalCkg", `BENCHMARK_CKG_INVALID_${result.errorCode}`);
      metrics.ckgContentSha256 = result.sha256;
      metrics.ckgBytes = Buffer.byteLength(result.json, "utf8");
      metrics.nodeCount = result.value.counts.nodes;
      metrics.edgeCount = result.value.counts.edges;
      return result;
    });

    const projected = await stage("documentProjection", () => {
      const result = projectArchitectureDocument(canonicalCkg.json, sources, canonicalCkg.sha256);
      if (!result.ok) throw new StageFailure("documentProjection", `BENCHMARK_DOCUMENT_INVALID_${result.errorCode}`);
      metrics.documentSha256 = result.sha256;
      metrics.documentBytes = Buffer.byteLength(result.json, "utf8");
      return result;
    });

    const markdown = await stage("markdownRender", () => {
      const rendered = renderMarkdownDocument(projected.value);
      metrics.markdownSha256 = digest(rendered);
      metrics.markdownBytes = Buffer.byteLength(rendered, "utf8");
      return rendered;
    });
    void markdown;

    await stage("pdfRender", async () => {
      try {
        const rendered = await renderPdfDocument(projected.value);
        metrics.pdfSha256 = digest(rendered);
        metrics.pdfBytes = rendered.byteLength;
      } catch (error) {
        const code = error instanceof Error && /^PDF_[A-Z0-9_]{1,77}$/.test(error.message) ? error.message : "PDF_RENDER_FAILED";
        throw new StageFailure("pdfRender", code);
      }
    });
  } catch (error) {
    failureStage = error instanceof StageFailure ? error.stage : "loadInput";
    failureCode = error instanceof StageFailure ? error.code : safeCode(error, "BENCHMARK_FAILED");
  }

  const endCpu = readCgroupCpuStat();
  const memory = readCgroupMemoryPeak();
  const cpuReason = startCpu.reason ?? endCpu.reason;
  const status = failureCode === null ? "COMPLETE" : "FAILED";
  return {
    schemaVersion: 1,
    status,
    manifestId,
    language,
    stageTimingsMs,
    coreElapsedMs: RESOURCE_STAGES.reduce((sum, name) => sum + (stageTimingsMs[name] ?? 0), 0),
    nodePeakRssBytes: nodePeakRssBytes(),
    cgroupPeakChargedBytes: memory.value,
    cgroupPeakReason: memory.reason,
    cgroupCpuStatStart: startCpu.value,
    cgroupCpuStatEnd: endCpu.value,
    cgroupCpuStatDelta: subtractCpuStat(endCpu.value, startCpu.value),
    cgroupCpuStatReason: cpuReason,
    metrics,
    failureStage,
    failureCode,
  };
}

export type WorkloadArguments = { manifest: string; root: string };

export function parseWorkloadArguments(argv: string[]): WorkloadArguments {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key !== "--manifest" && key !== "--root") throw new Error("BENCHMARK_ARGUMENT_INVALID");
    const value = argv[index + 1];
    if (!value || value.startsWith("--") || values.has(key)) throw new Error("BENCHMARK_ARGUMENT_INVALID");
    values.set(key, value);
    index += 1;
  }
  const manifest = values.get("--manifest");
  const root = values.get("--root");
  if (!manifest || !root || manifest.includes("\0") || root.includes("\0")) {
    throw new Error("BENCHMARK_ARGUMENT_INVALID");
  }
  return { manifest, root };
}

async function main(argv: string[]): Promise<void> {
  try {
    const options = parseWorkloadArguments(argv);
    const result = await runResourceWorkload(options.manifest, options.root);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.status !== "COMPLETE") process.exitCode = 1;
  } catch (error) {
    const code = safeCode(error, "BENCHMARK_ARGUMENT_INVALID");
    process.stdout.write(`${JSON.stringify({ schemaVersion: 1, status: "FAILED", failureStage: null, failureCode: code })}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main(process.argv.slice(2));
