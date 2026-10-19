import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import test from "node:test";
import { pack, type Header } from "tar-stream";
import {
  parseSnapshotArchive,
  SnapshotArchiveError,
  type SnapshotLimits,
} from "../apps/worker/src/snapshot/archive.ts";

type Entry = Partial<Header> & { name: string; bytes?: Uint8Array | string };

async function archive(entries: Entry[]): Promise<Buffer> {
  const tar = pack();
  for (const entry of entries) {
    const bytes = entry.bytes === undefined ? Buffer.alloc(0) : Buffer.from(entry.bytes);
    const header: Partial<Header> & Pick<Header, "name"> = {
      name: entry.name,
      type: entry.type ?? "file",
      size: entry.size ?? bytes.byteLength,
      mode: 0o644,
      mtime: new Date(0),
      linkname: entry.linkname ?? "",
      uid: 0,
      gid: 0,
      uname: "",
      gname: "",
      devmajor: 0,
      devminor: 0,
    };
    await new Promise<void>((resolve, reject) => {
      tar.entry(header, bytes, (error) => (error ? reject(error) : resolve()));
    });
  }
  tar.finalize();
  const chunks: Buffer[] = [];
  for await (const chunk of tar) chunks.push(Buffer.from(chunk as Uint8Array));
  return gzipSync(Buffer.concat(chunks));
}

async function rejectCode(
  bytes: Uint8Array,
  code: string,
  limits?: Partial<SnapshotLimits>,
  signal?: AbortSignal,
): Promise<void> {
  await assert.rejects(
    parseSnapshotArchive(bytes, { limits, signal }),
    (error: unknown) => expectCode(error, code),
  );
}

function expectCode(error: unknown, code: string): boolean {
  assert.ok(error instanceof SnapshotArchiveError);
  assert.equal(error.code, code);
  assert.doesNotMatch(error.message, /repo|secret|token|unsafe\/path/i);
  return true;
}

const root = "source-repo-0123456789abcdef";

test("parses a GitHub-style archive in memory and returns stable archive and file hashes", async () => {
  const content = Buffer.from("export const answer = 42;\n");
  const bytes = await archive([
    { name: `${root}/`, type: "directory" },
    { name: `${root}/src/`, type: "directory" },
    { name: `${root}/src/index.ts`, bytes: content },
  ]);

  const parsed = await parseSnapshotArchive(bytes);

  assert.equal(parsed.archiveSha256, createHash("sha256").update(bytes).digest("hex"));
  assert.equal(parsed.byteLength, bytes.byteLength);
  assert.equal(parsed.extractedBytes, content.byteLength);
  assert.deepEqual(parsed.files.map((file) => file.relativePath), ["src/index.ts"]);
  assert.equal(parsed.files[0]?.sha256, createHash("sha256").update(content).digest("hex"));
  assert.equal(parsed.files[0]?.byteLength, content.byteLength);
  assert.deepEqual(Buffer.from(parsed.files[0]?.bytes ?? []), content);
});

test("accepts an inferred common root when the archive omits its directory entry", async () => {
  const bytes = await archive([{ name: `${root}/readme.md`, bytes: "hello" }]);
  const parsed = await parseSnapshotArchive(bytes);
  assert.deepEqual(parsed.files.map((file) => file.relativePath), ["readme.md"]);
});

test("rejects traversal, absolute, drive, backslash, and control-character paths", async () => {
  const paths = [
    `${root}/../escape.php`,
    `/etc/passwd`,
    `${root}/C:/windows/system.ini`,
    `${root}/nested\\escape.php`,
    `${root}/bad\u0001name.php`,
  ];
  for (const name of paths) {
    await rejectCode(await archive([{ name, bytes: "x" }]), "UNSAFE_PATH");
  }
});

test("rejects a root-level file and archives that switch their common root", async () => {
  await rejectCode(await archive([{ name: "README.md", bytes: "x" }]), "UNSAFE_PATH");
  await rejectCode(await archive([
    { name: `${root}/one.ts`, bytes: "x" },
    { name: "other-root/two.ts", bytes: "x" },
  ]), "UNSAFE_PATH");
});

test("rejects symbolic links, hard links, and special tar entry types", async () => {
  for (const type of ["symlink", "link", "fifo", "block-device", "character-device"] as const) {
    await rejectCode(await archive([{ name: `${root}/link`, type, linkname: "target" }]), "UNSUPPORTED_ENTRY");
  }
});

test("rejects duplicate, case-folded, Unicode-normalized, and file-directory collisions", async () => {
  const cases: Entry[][] = [
    [
      { name: `${root}/same.ts`, bytes: "a" },
      { name: `${root}/same.ts`, bytes: "b" },
    ],
    [
      { name: `${root}/Readme.md`, bytes: "a" },
      { name: `${root}/README.md`, bytes: "b" },
    ],
    [
      { name: `${root}/café.ts`, bytes: "a" },
      { name: `${root}/cafe\u0301.ts`, bytes: "b" },
    ],
    [
      { name: `${root}/src`, bytes: "a" },
      { name: `${root}/src/index.ts`, bytes: "b" },
    ],
    [
      { name: `${root}/src/index.ts`, bytes: "a" },
      { name: `${root}/src/`, type: "directory" },
      { name: `${root}/src/`, type: "directory" },
    ],
    [
      { name: `${root}/`, type: "directory" },
      { name: `${root}/`, type: "directory" },
    ],
  ];
  for (const entries of cases) await rejectCode(await archive(entries), "PATH_COLLISION");
});

test("enforces archive, extracted-byte, file-count, entry-count, and ratio limits", async () => {
  const oneFile = await archive([{ name: `${root}/one.txt`, bytes: "123456" }]);
  await rejectCode(oneFile, "ARCHIVE_TOO_LARGE", { maxArchiveBytes: oneFile.byteLength - 1 });
  await rejectCode(oneFile, "EXTRACTED_TOO_LARGE", { maxExtractedBytes: 5 });
  await rejectCode(
    await archive([
      { name: `${root}/one.txt`, bytes: "a" },
      { name: `${root}/two.txt`, bytes: "b" },
    ]),
    "FILE_COUNT_LIMIT",
    { maxFiles: 1 },
  );
  await rejectCode(
    await archive([
      { name: `${root}/`, type: "directory" },
      { name: `${root}/a/`, type: "directory" },
      { name: `${root}/b/`, type: "directory" },
      { name: `${root}/c/`, type: "directory" },
      { name: `${root}/d/`, type: "directory" },
    ]),
    "ENTRY_COUNT_LIMIT",
    { maxFiles: 1 },
  );
  await rejectCode(oneFile, "EXPANSION_RATIO_LIMIT", { maxExtractionRatio: 0.01 });
});

test("rejects malformed gzip and truncated tar data", async () => {
  const valid = await archive([{ name: `${root}/x.txt`, bytes: "ok" }]);
  await rejectCode(valid.subarray(0, valid.byteLength - 5), "MALFORMED_ARCHIVE");

  const malformed = gzipSync(Buffer.from("not a tar archive"));
  await rejectCode(malformed, "MALFORMED_ARCHIVE");
});

test("rejects a cancelled operation and invalid limits", async () => {
  const bytes = await archive([{ name: `${root}/x.txt`, bytes: "x" }]);
  const controller = new AbortController();
  controller.abort();
  await rejectCode(bytes, "ABORTED", undefined, controller.signal);
  await rejectCode(bytes, "INVALID_LIMITS", { maxFiles: 0 });
});

test("enforces the deadline deterministically before asynchronous archive parsing completes", async (t) => {
  const bytes = await archive([{ name: `${root}/x.txt`, bytes: "x" }]);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => t.mock.timers.reset());

  const pending = parseSnapshotArchive(bytes, { limits: { snapshotTimeoutSeconds: 1 } });
  t.mock.timers.tick(1_000);
  await assert.rejects(pending, (error: unknown) => expectCode(error, "TIMEOUT"));
});
