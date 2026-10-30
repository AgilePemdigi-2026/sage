import { createHash } from "node:crypto";
import { constants, readFileSync } from "node:fs";
import { lstat, open, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeReferences as analyzeJavaScript } from "@sage/analyzer-js";
import { analyzeReferences as analyzePhp } from "@sage/analyzer-php";
import { canonicalizeCcm, canonicalizeCkg } from "@sage/contracts";

export const MAX_FILES = 2_000;
export const MAX_FILE_BYTES = 1_048_576;
export const MAX_TOTAL_BYTES = 104_857_600;

type Language = "javascript" | "php";
type BenchmarkFile = { path: string; sha256: string; sizeBytes: number };
export type RepositoryBenchmarkManifest = {
  schemaVersion: 1;
  id: string;
  repository: string;
  commitSha: string;
  language: Language;
  selection: string;
  files: BenchmarkFile[];
};

export class BenchmarkInputError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "BenchmarkInputError";
  }
}

type LoadedInput = {
  manifest: RepositoryBenchmarkManifest;
  sources: Record<string, Uint8Array>;
  inputFingerprint: string;
};

function fail(code: string): never {
  throw new BenchmarkInputError(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function digest(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function isSafeRelativePath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.startsWith("/") || value.includes("\\") || value.includes("\0")) {
    return false;
  }
  return value.split("/").every(part => part.length > 0 && part !== "." && part !== "..");
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key));
}

function validateManifest(value: unknown): RepositoryBenchmarkManifest {
  if (!isRecord(value) || !hasOnlyKeys(value, ["schemaVersion", "id", "repository", "commitSha", "language", "selection", "files"]) ||
      value.schemaVersion !== 1 || typeof value.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(value.id) ||
      typeof value.repository !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value.repository) ||
      typeof value.commitSha !== "string" || !/^[a-f0-9]{40}$/.test(value.commitSha) ||
      (value.language !== "javascript" && value.language !== "php") ||
      typeof value.selection !== "string" || value.selection.length < 1 || value.selection.length > 500 ||
      !Array.isArray(value.files) || value.files.length < 1 || value.files.length > MAX_FILES) {
    fail("BENCHMARK_MANIFEST_INVALID");
  }

  let totalBytes = 0;
  const paths = new Set<string>();
  const language = value.language;
  for (const item of value.files) {
    if (!isRecord(item) || !hasOnlyKeys(item, ["path", "sha256", "sizeBytes"]) || !isSafeRelativePath(item.path) ||
        typeof item.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(item.sha256) ||
        typeof item.sizeBytes !== "number" || !Number.isSafeInteger(item.sizeBytes) || item.sizeBytes < 0 || item.sizeBytes > MAX_FILE_BYTES) {
      fail("BENCHMARK_FILE_METADATA_INVALID");
    }
    const extension = item.path.slice(item.path.lastIndexOf(".")).toLowerCase();
    const supported = language === "php"
      ? extension === ".php"
      : [".js", ".mjs", ".cjs", ".jsx", ".ts", ".mts", ".cts", ".tsx"].includes(extension);
    if (!supported) fail("BENCHMARK_FILE_LANGUAGE_MISMATCH");
    if (paths.has(item.path)) fail("BENCHMARK_FILE_DUPLICATE");
    paths.add(item.path);
    totalBytes += item.sizeBytes;
    if (totalBytes > MAX_TOTAL_BYTES) fail("BENCHMARK_TOTAL_BYTES_EXCEEDED");
  }
  return value as unknown as RepositoryBenchmarkManifest;
}

async function assertRegularPath(root: string, filePath: string): Promise<{ path: string; dev: number; ino: number }> {
  let current = root;
  let fileDev = -1;
  let fileIno = -1;
  const parts = filePath.split("/");
  for (let index = 0; index < parts.length; index += 1) {
    current = resolve(current, parts[index]!);
    let info;
    try {
      info = await lstat(current);
    } catch {
      fail("BENCHMARK_FILE_MISSING");
    }
    if (info.isSymbolicLink()) fail("BENCHMARK_SYMLINK_REJECTED");
    if (index < parts.length - 1 ? !info.isDirectory() : !info.isFile()) fail("BENCHMARK_FILE_TYPE_INVALID");
    if (index === parts.length - 1) {
      if (info.size > MAX_FILE_BYTES) fail("BENCHMARK_FILE_SIZE_LIMIT_EXCEEDED");
      fileDev = info.dev;
      fileIno = info.ino;
    }
  }
  const canonical = await realpath(current);
  const relativePath = relative(root, canonical);
  if (relativePath === "" || relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    fail("BENCHMARK_PATH_ESCAPE");
  }
  return { path: canonical, dev: fileDev, ino: fileIno };
}

/** Loads only manifest-listed regular source files and checks their declared byte hashes. */
export async function loadBenchmarkInput(manifestPath: string, rootPath: string): Promise<LoadedInput> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
  } catch {
    fail("BENCHMARK_MANIFEST_READ_FAILED");
  }
  const manifest = validateManifest(raw);
  let rootInfo;
  try {
    rootInfo = await lstat(rootPath);
  } catch {
    fail("BENCHMARK_ROOT_INVALID");
  }
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) fail("BENCHMARK_ROOT_INVALID");
  const root = await realpath(rootPath);
  const sources: Record<string, Uint8Array> = {};
  for (const file of manifest.files) {
    const regularPath = await assertRegularPath(root, file.path);
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(regularPath.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch {
      fail("BENCHMARK_FILE_READ_FAILED");
    }
    try {
      const openedInfo = await handle.stat();
      if (!openedInfo.isFile() || openedInfo.dev !== regularPath.dev || openedInfo.ino !== regularPath.ino) {
        fail("BENCHMARK_FILE_CHANGED");
      }
      if (openedInfo.size > MAX_FILE_BYTES) fail("BENCHMARK_FILE_SIZE_LIMIT_EXCEEDED");
      if (openedInfo.size !== file.sizeBytes) fail("BENCHMARK_FILE_SIZE_MISMATCH");
      const bounded = Buffer.allocUnsafe(file.sizeBytes + 1);
      let bytesRead = 0;
      while (bytesRead < bounded.byteLength) {
        const read = await handle.read(bounded, bytesRead, bounded.byteLength - bytesRead, null);
        if (read.bytesRead === 0) break;
        bytesRead += read.bytesRead;
      }
      if (bytesRead > MAX_FILE_BYTES) fail("BENCHMARK_FILE_SIZE_LIMIT_EXCEEDED");
      if (bytesRead !== file.sizeBytes) fail("BENCHMARK_FILE_SIZE_MISMATCH");
      const bytes = bounded.subarray(0, bytesRead);
      if (digest(bytes) !== file.sha256) fail("BENCHMARK_FILE_HASH_MISMATCH");
      sources[file.path] = bytes;
    } finally {
      await handle.close();
    }
  }
  const fingerprintRecord = {
    schemaVersion: manifest.schemaVersion,
    id: manifest.id,
    repository: manifest.repository,
    commitSha: manifest.commitSha,
    language: manifest.language,
    selection: manifest.selection,
    files: manifest.files.map(({ path, sha256, sizeBytes }) => ({ path, sha256, sizeBytes })).sort((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
  };
  return { manifest, sources, inputFingerprint: digest(JSON.stringify(fingerprintRecord)) };
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

function nodePeakRssBytes(): number {
  // Node documents maxRSS in KiB on Linux and other Unix platforms.
  const value = process.resourceUsage().maxRSS * 1024;
  return Number.isSafeInteger(value) ? value : 0;
}

export type RepositoryBenchmarkResult = {
  schemaVersion: 1;
  status: "COMPLETE";
  id: string;
  repository: string;
  commitSha: string;
  language: Language;
  selection: string;
  inputFingerprint: string;
  reversedInputOrder: boolean;
  inputFileCount: number;
  inputBytes: number;
  analysisElapsedMs: number;
  nodePeakRssBytes: number;
  cgroupPeakChargedBytes: number | null;
  cgroupPeakReason: string | null;
  adapterStatus: "complete" | "partial";
  ccmContentSha256: string;
  ckgContentSha256: string;
  nodeCount: number;
  edgeCount: number;
  limitationCount: number;
};

export async function runRepositoryBenchmark(
  manifestPath: string,
  rootPath: string,
  reverseInputOrder = false,
): Promise<RepositoryBenchmarkResult> {
  const loaded = await loadBenchmarkInput(manifestPath, rootPath);
  const sources = reverseInputOrder ? Object.fromEntries(Object.entries(loaded.sources).reverse()) : loaded.sources;
  const snapshot = { repository: loaded.manifest.repository, branch: null, commitSha: loaded.manifest.commitSha };
  const started = process.hrtime.bigint();
  const result = loaded.manifest.language === "php"
    ? await analyzePhp({ snapshot, sources })
    : await analyzeJavaScript({ snapshot, sources });
  const analysisElapsedMs = Number(process.hrtime.bigint() - started) / 1_000_000;
  if ((result.status !== "complete" && result.status !== "partial") || result.errorCode !== null || !result.ccm ||
      !result.contentSha256 || !result.canonicalJson) fail("BENCHMARK_ADAPTER_FAILED");
  const canonical = canonicalizeCcm(result.ccm, sources);
  if (!canonical.ok) fail(`BENCHMARK_CCM_INVALID:${canonical.errorCode}`);
  if (canonical.json !== result.canonicalJson || canonical.sha256 !== result.contentSha256) fail("BENCHMARK_CCM_HASH_MISMATCH");
  const ckg = canonicalizeCkg(canonical.value, sources, result.ccm.provenance.configHash);
  if (!ckg.ok) fail(`BENCHMARK_CKG_INVALID:${ckg.errorCode}`);
  const cgroup = readCgroupMemoryPeak();
  const inputBytes = loaded.manifest.files.reduce((sum, file) => sum + file.sizeBytes, 0);
  return {
    schemaVersion: 1,
    status: "COMPLETE",
    id: loaded.manifest.id,
    repository: loaded.manifest.repository,
    commitSha: loaded.manifest.commitSha,
    language: loaded.manifest.language,
    selection: loaded.manifest.selection,
    inputFingerprint: loaded.inputFingerprint,
    reversedInputOrder: reverseInputOrder,
    inputFileCount: loaded.manifest.files.length,
    inputBytes,
    analysisElapsedMs,
    nodePeakRssBytes: nodePeakRssBytes(),
    cgroupPeakChargedBytes: cgroup.value,
    cgroupPeakReason: cgroup.reason,
    adapterStatus: result.status,
    ccmContentSha256: result.contentSha256,
    ckgContentSha256: ckg.sha256,
    nodeCount: ckg.value.counts.nodes,
    edgeCount: ckg.value.counts.edges,
    limitationCount: result.ccm.limitations.length,
  };
}

async function writeJsonAtomically(path: string, value: unknown): Promise<void> {
  const target = resolve(path);
  const temp = `${target}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  await rename(temp, target);
}

function parseArgs(argv: string[]): { manifest: string; root: string; output: string | null; reverse: boolean } {
  const values = new Map<string, string>();
  let reverse = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--reverse") {
      if (reverse) fail("BENCHMARK_ARGUMENT_INVALID");
      reverse = true;
      continue;
    }
    if (!["--manifest", "--root", "--output"].includes(arg) || values.has(arg) || !argv[index + 1] || argv[index + 1]!.startsWith("--")) {
      fail("BENCHMARK_ARGUMENT_INVALID");
    }
    values.set(arg, argv[++index]!);
  }
  const manifest = values.get("--manifest");
  const root = values.get("--root");
  if (!manifest || !root) fail("BENCHMARK_ARGUMENT_INVALID");
  return { manifest, root, output: values.get("--output") ?? null, reverse };
}

async function main(argv: string[]): Promise<void> {
  try {
    const options = parseArgs(argv);
    const result = await runRepositoryBenchmark(options.manifest, options.root, options.reverse);
    if (options.output) await writeJsonAtomically(options.output, result);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const code = error instanceof BenchmarkInputError ? error.code : "BENCHMARK_FAILED";
    process.stderr.write(`${JSON.stringify({ status: "FAILED", errorCode: code })}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main(process.argv.slice(2));
