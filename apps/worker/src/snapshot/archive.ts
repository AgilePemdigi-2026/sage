import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { createGunzip } from "node:zlib";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { extract as createTarExtractor, type Header } from "tar-stream";

export type SnapshotLimits = {
  maxArchiveBytes: number;
  maxExtractedBytes: number;
  maxFiles: number;
  maxExtractionRatio: number;
  snapshotTimeoutSeconds: number;
};

export type SnapshotFile = {
  relativePath: string;
  sha256: string;
  byteLength: number;
  bytes: Uint8Array;
};

export type ParsedSnapshotArchive = {
  archiveSha256: string;
  byteLength: number;
  files: readonly SnapshotFile[];
  extractedBytes: number;
};

const DEFAULT_LIMITS: SnapshotLimits = {
  maxArchiveBytes: 25 * 1024 * 1024,
  maxExtractedBytes: 100 * 1024 * 1024,
  maxFiles: 2_000,
  maxExtractionRatio: 20,
  snapshotTimeoutSeconds: 60,
};

const TAR_BLOCK_BYTES = 512;
const TAR_END_BYTES = TAR_BLOCK_BYTES * 2;
const MAX_PATH_BYTES = 4_096;
const MAX_PATH_SEGMENTS = 128;
const MAX_RAW_TAR_HEADER_OVERHEAD = 4 * 1024 * 1024;

const SAFE_MESSAGES: Record<string, string> = {
  ABORTED: "Snapshot archive processing was cancelled.",
  ARCHIVE_TOO_LARGE: "Snapshot archive exceeds the configured size limit.",
  ENTRY_COUNT_LIMIT: "Snapshot archive contains too many entries.",
  EXTRACTED_TOO_LARGE: "Snapshot archive expands beyond the configured size limit.",
  EXPANSION_RATIO_LIMIT: "Snapshot archive exceeds the configured expansion ratio.",
  FILE_COUNT_LIMIT: "Snapshot archive contains too many files.",
  INVALID_LIMITS: "Snapshot archive limits are invalid.",
  MALFORMED_ARCHIVE: "Snapshot archive is malformed or incomplete.",
  PATH_COLLISION: "Snapshot archive contains colliding paths.",
  TIMEOUT: "Snapshot archive processing exceeded its time limit.",
  UNSAFE_PATH: "Snapshot archive contains an unsafe path.",
  UNSUPPORTED_ENTRY: "Snapshot archive contains an unsupported entry type.",
};

export class SnapshotArchiveError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(SAFE_MESSAGES[code] ?? "Snapshot archive could not be processed.");
    this.name = "SnapshotArchiveError";
    this.code = code;
  }
}

function fail(code: string): SnapshotArchiveError {
  return new SnapshotArchiveError(code);
}

function getLimits(overrides: Partial<SnapshotLimits> | undefined): SnapshotLimits {
  const limits = { ...DEFAULT_LIMITS, ...overrides };
  const positiveIntegers: Array<keyof SnapshotLimits> = ["maxArchiveBytes", "maxExtractedBytes", "maxFiles"];
  if (positiveIntegers.some((key) => !Number.isSafeInteger(limits[key]) || limits[key] <= 0)) {
    throw fail("INVALID_LIMITS");
  }
  if (
    !Number.isFinite(limits.maxExtractionRatio) || limits.maxExtractionRatio <= 0 ||
    !Number.isFinite(limits.snapshotTimeoutSeconds) || limits.snapshotTimeoutSeconds <= 0
  ) {
    throw fail("INVALID_LIMITS");
  }
  if (
    !Number.isSafeInteger(limits.maxFiles * 2 + 2) ||
    !Number.isSafeInteger(limits.maxExtractedBytes + (limits.maxFiles * 2 + 2) * TAR_BLOCK_BYTES + MAX_RAW_TAR_HEADER_OVERHEAD)
  ) {
    throw fail("INVALID_LIMITS");
  }
  return limits;
}

type NormalizedArchivePath = {
  root: string;
  relativePath: string | null;
};

function normalizeArchivePath(rawName: unknown, directory: boolean): NormalizedArchivePath {
  if (typeof rawName !== "string" || rawName.length === 0 || rawName.includes("\\") || /[\u0000-\u001f\u007f-\u009f]/u.test(rawName)) {
    throw fail("UNSAFE_PATH");
  }

  let path = rawName.normalize("NFC");
  if (directory && path.endsWith("/")) path = path.slice(0, -1);
  if (path.length === 0 || path.startsWith("/") || path.endsWith("/") || path.includes("//") || /^[A-Za-z]:/u.test(path)) {
    throw fail("UNSAFE_PATH");
  }

  const segments = path.split("/");
  if (segments.length > MAX_PATH_SEGMENTS || Buffer.byteLength(path, "utf8") > MAX_PATH_BYTES) {
    throw fail("UNSAFE_PATH");
  }
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === ".." || segment.includes(":"))) {
    throw fail("UNSAFE_PATH");
  }

  const root = segments[0];
  if (!root || root === "." || root === "..") throw fail("UNSAFE_PATH");
  if (segments.length === 1) {
    if (!directory) throw fail("UNSAFE_PATH");
    return { root, relativePath: null };
  }
  return { root, relativePath: segments.slice(1).join("/") };
}

type PathNode = { canonicalPath: string; kind: "directory" | "file"; explicit: boolean };

function pathKey(path: string): string {
  return path.normalize("NFKC").toUpperCase().toLowerCase().normalize("NFC");
}

function registerPath(nodes: Map<string, PathNode>, path: string, kind: "directory" | "file"): void {
  const segments = path.split("/");
  let parent = "";
  for (const segment of segments.slice(0, -1)) {
    parent = parent ? `${parent}/${segment}` : segment;
    const key = pathKey(parent);
    const existing = nodes.get(key);
    if (existing && (existing.kind !== "directory" || existing.canonicalPath !== parent)) {
      throw fail("PATH_COLLISION");
    }
    if (!existing) nodes.set(key, { canonicalPath: parent, kind: "directory", explicit: false });
  }

  const key = pathKey(path);
  const existing = nodes.get(key);
  if (existing) {
    if (kind === "directory" && existing.kind === "directory" && !existing.explicit && existing.canonicalPath === path) {
      existing.explicit = true;
      return;
    }
    throw fail("PATH_COLLISION");
  }
  nodes.set(key, { canonicalPath: path, kind, explicit: true });
}

function safeHeaderSize(header: Header): number {
  if (!Number.isSafeInteger(header.size) || header.size < 0) throw fail("MALFORMED_ARCHIVE");
  return header.size;
}

function validateTarEnd(rawBytes: number, tail: Buffer): void {
  if (rawBytes < TAR_END_BYTES || rawBytes % TAR_BLOCK_BYTES !== 0 || tail.length !== TAR_END_BYTES) {
    throw fail("MALFORMED_ARCHIVE");
  }
  for (const byte of tail) if (byte !== 0) throw fail("MALFORMED_ARCHIVE");
}

/**
 * Parses an in-memory GitHub tar.gz snapshot without touching the filesystem.
 * The archive is capped before decompression, raw tar bytes are capped before
 * tar-stream sees them, and every returned source file carries its own digest.
 */
export async function parseSnapshotArchive(
  archive: Uint8Array,
  options: { limits?: Partial<SnapshotLimits>; signal?: AbortSignal } = {},
): Promise<ParsedSnapshotArchive> {
  const limits = getLimits(options.limits);
  if (!(archive instanceof Uint8Array)) throw fail("MALFORMED_ARCHIVE");
  if (archive.byteLength === 0) throw fail("MALFORMED_ARCHIVE");
  if (archive.byteLength > limits.maxArchiveBytes) throw fail("ARCHIVE_TOO_LARGE");

  const archiveBytes = Buffer.from(archive);
  const maxEntries = limits.maxFiles * 2 + 2;
  const maxRawTarBytes = limits.maxExtractedBytes + maxEntries * TAR_BLOCK_BYTES + MAX_RAW_TAR_HEADER_OVERHEAD;
  const controller = new AbortController();
  let timedOut = false;
  const deadline = performance.now() + limits.snapshotTimeoutSeconds * 1_000;
  const ensureActive = () => {
    if (timedOut || performance.now() >= deadline) {
      timedOut = true;
      controller.abort();
      throw fail("TIMEOUT");
    }
    if (controller.signal.aborted) throw fail("ABORTED");
  };
  const onCallerAbort = () => controller.abort();
  if (options.signal?.aborted) controller.abort();
  else options.signal?.addEventListener("abort", onCallerAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, limits.snapshotTimeoutSeconds * 1_000);
  timer.unref?.();

  const files: SnapshotFile[] = [];
  const paths = new Map<string, PathNode>();
  let rootName: string | null = null;
  let rootDirectorySeen = false;
  let entryCount = 0;
  let extractedBytes = 0;
  let rawTarBytes = 0;
  let rawTail = Buffer.alloc(0);
  let entryFailure: SnapshotArchiveError | null = null;

  const extractor = createTarExtractor();
  const rawTarGuard = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      try {
        ensureActive();
      } catch (error) {
        callback(error as Error);
        return;
      }
      rawTarBytes += chunk.byteLength;
      if (rawTarBytes > maxRawTarBytes) {
        callback(fail("EXTRACTED_TOO_LARGE"));
        return;
      }
      rawTail = Buffer.concat([rawTail, chunk]).subarray(-TAR_END_BYTES);
      callback(null, chunk);
    },
    flush(callback) {
      try {
        ensureActive();
        validateTarEnd(rawTarBytes, rawTail);
        callback();
      } catch (error) {
        callback(error as Error);
      }
    },
  });

  extractor.on("entry", (header, entry, next) => {
    try {
      ensureActive();
    } catch (error) {
      entryFailure = error instanceof SnapshotArchiveError ? error : fail("MALFORMED_ARCHIVE");
      extractor.destroy(entryFailure);
      return;
    }
    entryCount += 1;
    if (entryCount > maxEntries) {
      entryFailure = fail("ENTRY_COUNT_LIMIT");
      extractor.destroy(entryFailure);
      return;
    }

    void consumeEntry(header, entry as AsyncIterable<Uint8Array>).then(
      () => next(),
      (error: unknown) => {
        entryFailure = error instanceof SnapshotArchiveError ? error : fail("MALFORMED_ARCHIVE");
        extractor.destroy(entryFailure);
      },
    );
  });

  async function consumeEntry(header: Header, entry: AsyncIterable<Uint8Array>): Promise<void> {
    ensureActive();
    const isDirectory = header.type === "directory";
    if (!isDirectory && header.type !== "file") throw fail("UNSUPPORTED_ENTRY");
    const declaredSize = safeHeaderSize(header);
    if (isDirectory && declaredSize !== 0) throw fail("MALFORMED_ARCHIVE");

    const safePath = normalizeArchivePath(header.name, isDirectory);
    if (rootName === null) rootName = safePath.root;
    else if (safePath.root !== rootName) throw fail("UNSAFE_PATH");

    const relativePath = safePath.relativePath;
    if (relativePath === null) {
      if (!isDirectory) throw fail("UNSAFE_PATH");
      if (rootDirectorySeen) throw fail("PATH_COLLISION");
      rootDirectorySeen = true;
    } else {
      registerPath(paths, relativePath, isDirectory ? "directory" : "file");
    }

    if (isDirectory) {
      if (!(await entry[Symbol.asyncIterator]().next()).done) throw fail("MALFORMED_ARCHIVE");
      return;
    }

    if (files.length >= limits.maxFiles) throw fail("FILE_COUNT_LIMIT");
    if (declaredSize > limits.maxExtractedBytes - extractedBytes) throw fail("EXTRACTED_TOO_LARGE");
    if (declaredSize > archiveBytes.byteLength * limits.maxExtractionRatio - extractedBytes) {
      throw fail("EXPANSION_RATIO_LIMIT");
    }

    const bytes = Buffer.allocUnsafe(declaredSize);
    const digest = createHash("sha256");
    let fileBytes = 0;
    for await (const chunkValue of entry) {
      ensureActive();
      const chunk = Buffer.isBuffer(chunkValue) ? chunkValue : Buffer.from(chunkValue);
      fileBytes += chunk.byteLength;
      if (fileBytes > declaredSize || fileBytes > limits.maxExtractedBytes - extractedBytes) {
        throw fail("MALFORMED_ARCHIVE");
      }
      digest.update(chunk);
      chunk.copy(bytes, fileBytes - chunk.byteLength);
    }
    if (fileBytes !== declaredSize) throw fail("MALFORMED_ARCHIVE");

    files.push({ relativePath: relativePath as string, sha256: digest.digest("hex"), byteLength: fileBytes, bytes });
    extractedBytes += fileBytes;
  }

  try {
    ensureActive();
    await pipeline(
      Readable.from([archiveBytes]),
      createGunzip(),
      rawTarGuard,
      extractor as unknown as NodeJS.WritableStream,
      { signal: controller.signal },
    );
    ensureActive();
    if (entryFailure) throw entryFailure;
    if (rootName === null) throw fail("MALFORMED_ARCHIVE");

    const archiveSha256 = createHash("sha256").update(archiveBytes).digest("hex");
    ensureActive();
    return { archiveSha256, byteLength: archiveBytes.byteLength, files, extractedBytes };
  } catch (error) {
    if (entryFailure) throw entryFailure;
    if (timedOut) throw fail("TIMEOUT");
    if (options.signal?.aborted) throw fail("ABORTED");
    if (error instanceof SnapshotArchiveError) throw error;
    if (controller.signal.aborted) throw fail("ABORTED");
    throw fail("MALFORMED_ARCHIVE");
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onCallerAbort);
  }
}
