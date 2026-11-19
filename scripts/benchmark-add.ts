import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { relative, resolve } from "node:path";
import { analyzeSnapshotSources } from "../apps/worker/src/source-analysis.ts";
import type { SnapshotFile } from "../apps/worker/src/snapshot/archive.ts";
import { canonicalizeCkg } from "@sage/contracts";
import { buildAddBaseline, isAddBaselineModel } from "../packages/documents/src/baseline-add.ts";
import { emptyAddReviewOverlay } from "../packages/documents/src/add-overlay.ts";
import { createAddMarkdown } from "../packages/documents/src/baseline-markdown.ts";
import { buildSemanticModel, semanticModelHash } from "../packages/documents/src/semantic/build.ts";

const [inputArg, outputArg, aliasArg] = process.argv.slice(2);
if (!inputArg || !outputArg || !aliasArg || !/^[a-z0-9-]{2,40}$/u.test(aliasArg)) {
  throw new Error("Usage: npm run benchmark:add -- <pinned-corpus-directory> <new-output-directory> <safe-fixture-alias>");
}
async function readContainerPeakChargedBytes(): Promise<number | null> {
  try {
    const value = Number((await readFile("/sys/fs/cgroup/memory.peak", "utf8")).trim());
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  } catch {
    return null;
  }
}
async function readContainerCgroupLimits(): Promise<{ memoryMaxBytes: number | null; cpuQuotaMicros: number | null; cpuPeriodMicros: number | null; pidsMax: number | null }> {
  const readInteger = async (path: string): Promise<number | null> => {
    try {
      const value = (await readFile(path, "utf8")).trim();
      if (!/^\d+$/u.test(value)) return null;
      const parsed = Number(value);
      return Number.isSafeInteger(parsed) ? parsed : null;
    } catch {
      return null;
    }
  };
  let cpuQuotaMicros: number | null = null;
  let cpuPeriodMicros: number | null = null;
  try {
    const [quota, period] = (await readFile("/sys/fs/cgroup/cpu.max", "utf8")).trim().split(/\s+/u);
    if (/^\d+$/u.test(quota ?? "") && /^\d+$/u.test(period ?? "")) {
      cpuQuotaMicros = Number(quota);
      cpuPeriodMicros = Number(period);
      if (!Number.isSafeInteger(cpuQuotaMicros) || !Number.isSafeInteger(cpuPeriodMicros)) {
        cpuQuotaMicros = null;
        cpuPeriodMicros = null;
      }
    }
  } catch {
    // cgroup v2 limits are required by the runner and are checked there.
  }
  return {
    memoryMaxBytes: await readInteger("/sys/fs/cgroup/memory.max"),
    cpuQuotaMicros,
    cpuPeriodMicros,
    pidsMax: await readInteger("/sys/fs/cgroup/pids.max"),
  };
}
const input = resolve(inputArg);
const output = resolve(outputArg);
await mkdir(output, { recursive: true, mode: 0o700 });
const reportPath = resolve(output, `${aliasArg}-report.json`);
try { await readFile(reportPath); throw new Error("Refusing to overwrite an earlier ADD replay report."); }
catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause; }

const started = performance.now();
const processCpuStarted = process.cpuUsage();
const cpuMs = (usage: NodeJS.CpuUsage) => ({ user: usage.user / 1000, system: usage.system / 1000, total: (usage.user + usage.system) / 1000 });
let report: Record<string, unknown>;
try {
  const snapshot = JSON.parse(await readFile(resolve(input, ".snapshot.json"), "utf8")) as { repository?: unknown; commit?: unknown };
  if (typeof snapshot.repository !== "string" || typeof snapshot.commit !== "string" || !/^[a-f0-9]{40}$/u.test(snapshot.commit)) throw new Error("Pinned snapshot metadata is required.");
  const files: SnapshotFile[] = [];
  async function collect(directory: string): Promise<void> {
    for (const item of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (item.name === ".snapshot.json") continue;
      const full = resolve(directory, item.name);
      if (item.isDirectory()) await collect(full);
      else if (item.isFile()) {
        const bytes = await readFile(full);
        files.push({ relativePath: relative(input, full).replaceAll("\\", "/"), bytes, byteLength: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") });
      }
    }
  }
  await collect(input);

  const sourceStarted = performance.now();
  const sourceCpuStarted = process.cpuUsage();
  const analyzed = await analyzeSnapshotSources({
    snapshot: { repository: snapshot.repository, branch: "pinned", commitSha: snapshot.commit }, files,
  });
  const sourceCpu = cpuMs(process.cpuUsage(sourceCpuStarted));
  if (!analyzed.ccm) throw new Error(`Source analysis failed: ${analyzed.errorCode ?? "unknown"}.`);
  const sources = Object.fromEntries(files.map(file => [file.relativePath, file.bytes]));
  const graph = canonicalizeCkg(analyzed.ccm, sources, "f".repeat(64));
  if (!graph.ok) throw new Error(`Canonical graph validation failed: ${graph.errorCode}.`);
  const sourceAnalysisMs = performance.now() - sourceStarted;

  const semanticStarted = performance.now();
  const semanticCpuStarted = process.cpuUsage();
  const semantic = buildSemanticModel({ ccm: analyzed.ccm, sourceCkgHash: graph.sha256, sources, documentationSources: sources, snapshotPaths: Object.keys(sources) });
  const semanticCpu = cpuMs(process.cpuUsage(semanticCpuStarted));
  const semanticMs = performance.now() - semanticStarted;
  const semanticHash = semanticModelHash(semantic);
  const baselineStarted = performance.now();
  const baselineCpuStarted = process.cpuUsage();
  const baseline = buildAddBaseline({ ccm: analyzed.ccm, semantic, sourceCkgHash: graph.sha256 });
  const baselineCpu = cpuMs(process.cpuUsage(baselineCpuStarted));
  const baselineMs = performance.now() - baselineStarted;
  if (!isAddBaselineModel(baseline)) throw new Error("Generated ADD does not satisfy the supported model profile.");

  const sourceMap = new Map(files.map(file => [file.relativePath, file.bytes]));
  const evidence = [...baseline.elements.flatMap(item => item.evidence), ...baseline.relationships.flatMap(item => item.evidence),
    ...baseline.matrices.applicationData.flatMap(item => item.evidence), ...baseline.matrices.applicationInteractions.flatMap(item => item.evidence)];
  for (const span of evidence) {
    const bytes = sourceMap.get(span.filePath);
    if (!bytes || span.endByte > bytes.byteLength || span.startByte < 0 || span.endByte <= span.startByte || createHash("sha256").update(bytes).digest("hex") !== span.fileSha256) {
      throw new Error("ADD evidence does not match bytes in the pinned corpus.");
    }
  }

  const replaySources = Object.fromEntries(Object.entries(sources).reverse());
  const replaySemantic = buildSemanticModel({ ccm: analyzed.ccm, sourceCkgHash: graph.sha256, sources: replaySources,
    documentationSources: replaySources, snapshotPaths: Object.keys(replaySources).reverse() });
  if (semanticModelHash(replaySemantic) !== semanticHash) throw new Error("Semantic replay changed with source enumeration order.");
  const replayBaseline = buildAddBaseline({ ccm: analyzed.ccm, semantic: replaySemantic, sourceCkgHash: graph.sha256 });
  const baselineHash = createHash("sha256").update(JSON.stringify(baseline)).digest("hex");
  if (createHash("sha256").update(JSON.stringify(replayBaseline)).digest("hex") !== baselineHash) throw new Error("ADD replay is not deterministic.");

  const typeCounts = Object.fromEntries([...new Set(baseline.elements.map(item => item.type))].sort().map(type => [type, baseline.elements.filter(item => item.type === type).length]));
  const relationCounts = Object.fromEntries([...new Set(baseline.relationships.map(item => item.type))].sort().map(type => [type, baseline.relationships.filter(item => item.type === type).length]));
  const canonicalModelBytes = Buffer.byteLength(JSON.stringify(baseline), "utf8");
  const markdownBytes = Buffer.byteLength(createAddMarkdown(baseline, emptyAddReviewOverlay(), span => {
    const path = span.filePath.split("/").map(encodeURIComponent).join("/");
    return `https://github.com/${snapshot.repository}/blob/${snapshot.commit}/${path}#L${span.startLine}-L${span.endLine}`;
  }), "utf8");
  report = {
    status: "PASS",
    fixture: aliasArg,
    commit: snapshot.commit,
    runtime: { node: process.version, platform: process.platform, architecture: process.arch },
    source: { fileCount: files.length, bytes: files.reduce((sum, file) => sum + file.byteLength, 0), analysisMs: sourceAnalysisMs, cpuMs: sourceCpu },
    semantic: { features: semantic.features.length, nodes: semantic.nodes.length, edges: semantic.edges.length, milliseconds: semanticMs, cpuMs: semanticCpu, hash: semanticHash },
    add: { schemaVersion: baseline.schemaVersion, archimateVersion: baseline.archimateVersion, elements: baseline.elements.length, elementTypeCounts: typeCounts,
      relationships: baseline.relationships.length, relationshipTypeCounts: relationCounts, dataEntities: baseline.catalogs.dataEntities.length,
      interfaces: baseline.catalogs.interfaces.length, crudRows: baseline.matrices.applicationData.length, limitations: baseline.limitations.length,
      milliseconds: baselineMs, cpuMs: baselineCpu, canonicalHash: baselineHash, evidenceSpans: evidence.length, artifactBytes: { canonicalModel: canonicalModelBytes, markdown: markdownBytes, pdf: null } },
    elapsedMs: performance.now() - started,
    processCpuMs: cpuMs(process.cpuUsage(processCpuStarted)),
    processPeakRssBytes: process.resourceUsage().maxRSS * 1024,
    containerPeakChargedBytes: await readContainerPeakChargedBytes(),
    containerCgroupLimits: await readContainerCgroupLimits(),
    scope: "Pinned source, deterministic static analysis, ADD profile validation, evidence byte/hash checks, and in-memory Markdown size; PDF size is not measured because the new ADD PDF renderer is not yet integrated. No source or relationship contents are written to this report.",
  };
} catch (cause) {
  report = {
    status: "FAIL", fixture: aliasArg, elapsedMs: performance.now() - started,
    processCpuMs: cpuMs(process.cpuUsage(processCpuStarted)),
    processPeakRssBytes: process.resourceUsage().maxRSS * 1024,
    containerPeakChargedBytes: await readContainerPeakChargedBytes(),
    containerCgroupLimits: await readContainerCgroupLimits(),
    error: cause instanceof Error ? cause.message : String(cause),
  };
}
await writeFile(reportPath, JSON.stringify(report, null, 2), { flag: "wx", mode: 0o600 });
console.log(JSON.stringify(report));
if (report.status !== "PASS") process.exitCode = 1;
