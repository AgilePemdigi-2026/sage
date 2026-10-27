import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finishCleanupStorageFolders, removeCleanupStorageFile } from "../apps/worker/src/cleanup-storage.ts";

test("cleanup removes exact snapshot/export files idempotently and preserves unrelated files", async () => {
  const root = await mkdtemp(join(tmpdir(), "sage-cleanup-files-"));
  const keys = ["snapshot-abc123/archive.tar.gz", "export-11111111-1111-4111-8111-111111111111/document.pdf", "export-11111111-1111-4111-8111-111111111111/document.pdf.pending"];
  try {
    for (const key of keys) { await mkdir(join(root, key.split("/")[0]), { recursive: true }); await writeFile(join(root, key), "fixture"); }
    await writeFile(join(root, "unrelated.txt"), "keep");
    for (const key of keys) { await removeCleanupStorageFile(root, key); await removeCleanupStorageFile(root, key); }
    await finishCleanupStorageFolders(root, keys);
    await finishCleanupStorageFolders(root, keys);
    for (const key of keys) await assert.rejects(access(join(root, key)));
    assert.equal(await readFile(join(root, "unrelated.txt"), "utf8"), "keep");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("cleanup rejects traversal and symlinks and refuses to remove unexpected files recursively", async () => {
  const root = await mkdtemp(join(tmpdir(), "sage-cleanup-guard-"));
  const outside = await mkdtemp(join(tmpdir(), "sage-cleanup-outside-"));
  try {
    await writeFile(join(outside, "archive.tar.gz"), "private neighbor");
    await symlink(outside, join(root, "snapshot-abc123"));
    await assert.rejects(removeCleanupStorageFile(root, "snapshot-abc123/archive.tar.gz"));
    await assert.rejects(removeCleanupStorageFile(root, "../archive.tar.gz"));
    await rm(join(root, "snapshot-abc123")); await mkdir(join(root, "snapshot-abc123"));
    await symlink(join(outside, "archive.tar.gz"), join(root, "snapshot-abc123/archive.tar.gz"));
    await assert.rejects(removeCleanupStorageFile(root, "snapshot-abc123/archive.tar.gz"));
    await writeFile(join(root, "snapshot-abc123/unexpected.txt"), "keep");
    await assert.rejects(finishCleanupStorageFolders(root, ["snapshot-abc123/archive.tar.gz"]));
    assert.equal(await readFile(join(outside, "archive.tar.gz"), "utf8"), "private neighbor");
    assert.equal(await readFile(join(root, "snapshot-abc123/unexpected.txt"), "utf8"), "keep");
    await assert.rejects(removeCleanupStorageFile(root, "snapshot-abc123/archive.tar.gz", AbortSignal.abort()));
  } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});
