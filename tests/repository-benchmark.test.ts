import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { loadBenchmarkInput, runRepositoryBenchmark, type RepositoryBenchmarkManifest } from "../scripts/benchmark-repository.ts";

const source = Buffer.from("export class Service { run() { return 1; } }\n");
const sourcePath = "src/service.ts";

function createManifest(bytes = source): RepositoryBenchmarkManifest {
  return {
    schemaVersion: 1,
    id: "test-fixture",
    repository: "fixture/benchmark",
    commitSha: "a".repeat(40),
    language: "javascript",
    selection: "one hand-authored TypeScript source",
    files: [{
      path: sourcePath,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      sizeBytes: bytes.byteLength,
    }],
  };
}

async function setup(bytes = source): Promise<{ parent: string; root: string; manifestPath: string }> {
  const parent = await mkdtemp(join(tmpdir(), "sage-repository-benchmark-"));
  const root = join(parent, "source");
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, sourcePath), bytes);
  const manifestPath = join(parent, "manifest.json");
  await writeFile(manifestPath, JSON.stringify(createManifest(bytes)));
  return { parent, root, manifestPath };
}

test("repository benchmark verifies the pinned manifest and emits replayable CCM/CKG metrics", async () => {
  const context = await setup();
  try {
    const first = await runRepositoryBenchmark(context.manifestPath, context.root);
    const reversed = await runRepositoryBenchmark(context.manifestPath, context.root, true);
    assert.equal(first.status, "COMPLETE");
    assert.equal(first.adapterStatus, "complete");
    assert.equal(first.inputFileCount, 1);
    assert.equal(first.inputBytes, source.byteLength);
    assert.match(first.inputFingerprint, /^[a-f0-9]{64}$/);
    assert.match(first.ccmContentSha256, /^[a-f0-9]{64}$/);
    assert.match(first.ckgContentSha256, /^[a-f0-9]{64}$/);
    assert.ok(first.nodeCount > 0);
    assert.ok(first.analysisElapsedMs >= 0);
    assert.ok(first.nodePeakRssBytes > 0);
    assert.equal(reversed.reversedInputOrder, true);
    assert.equal(reversed.inputFingerprint, first.inputFingerprint);
    assert.equal(reversed.ccmContentSha256, first.ccmContentSha256);
    assert.equal(reversed.ckgContentSha256, first.ckgContentSha256);
  } finally {
    await rm(context.parent, { recursive: true, force: true });
  }
});

test("repository benchmark rejects stale bytes and source paths that traverse symlinks", async () => {
  const stale = await setup();
  try {
    await writeFile(join(stale.root, sourcePath), "export class Changed {}\n");
    await assert.rejects(loadBenchmarkInput(stale.manifestPath, stale.root), /BENCHMARK_FILE_SIZE_MISMATCH|BENCHMARK_FILE_HASH_MISMATCH/);
  } finally {
    await rm(stale.parent, { recursive: true, force: true });
  }

  const escaped = await setup();
  try {
    const outside = join(escaped.parent, "outside.ts");
    await writeFile(outside, source);
    await rm(join(escaped.root, sourcePath));
    await symlink(outside, join(escaped.root, sourcePath));
    await assert.rejects(loadBenchmarkInput(escaped.manifestPath, escaped.root), /BENCHMARK_SYMLINK_REJECTED/);
  } finally {
    await rm(escaped.parent, { recursive: true, force: true });
  }
});

test("repository benchmark rejects a same-size source whose pinned hash is wrong", async () => {
  const context = await setup();
  try {
    const manifest = JSON.parse(await readFile(context.manifestPath, "utf8")) as RepositoryBenchmarkManifest;
    manifest.files[0]!.sha256 = "0".repeat(64);
    await writeFile(context.manifestPath, JSON.stringify(manifest));
    await assert.rejects(loadBenchmarkInput(context.manifestPath, context.root), /BENCHMARK_FILE_HASH_MISMATCH/);
  } finally {
    await rm(context.parent, { recursive: true, force: true });
  }
});

test("repository benchmark rejects unsupported languages and declared resource overages", async () => {
  const context = await setup();
  try {
    const manifest = JSON.parse(await readFile(context.manifestPath, "utf8")) as RepositoryBenchmarkManifest;
    manifest.language = "php";
    await writeFile(context.manifestPath, JSON.stringify(manifest));
    await assert.rejects(loadBenchmarkInput(context.manifestPath, context.root), /BENCHMARK_FILE_LANGUAGE_MISMATCH/);

    manifest.language = "javascript";
    manifest.files[0]!.sizeBytes = 1_048_577;
    await writeFile(context.manifestPath, JSON.stringify(manifest));
    await assert.rejects(loadBenchmarkInput(context.manifestPath, context.root), /BENCHMARK_FILE_METADATA_INVALID/);
  } finally {
    await rm(context.parent, { recursive: true, force: true });
  }
});
