import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { fetchSourceArchive } from "../packages/github/source-archive.ts";
import { parseSnapshotArchive } from "../apps/worker/src/snapshot/archive.ts";
const bytes = Buffer.from("<?php class Controller {}");
const sha = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
const entry = { path: "app/Controller.php", type: "blob", mode: "100644", sha, size: bytes.length };
const model = { path: "models/weights.onnx", type: "blob", mode: "100644", sha: "b".repeat(40), size: 30 * 1024 * 1024 };
const input = { owner: "example", name: "app", sha: "a".repeat(40), token: "test-token", signal: AbortSignal.timeout(5000), maxArchiveBytes: 25 * 1024 * 1024 };
function fixture(tree: unknown[], corrupt = false, truncated = false) {
 const urls: string[] = [];
 const fetcher = (async (url, init) => {
  urls.push(String(url));
  assert.equal(new URL(String(url)).origin, "https://api.github.com");
  assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer test-token");
  if (String(url).includes("/trees/")) return Response.json({ tree, truncated });
  assert.equal(String(url).endsWith("/blobs/" + sha), true);
  return Response.json({ sha, encoding: "base64", size: bytes.length, content: (corrupt ? Buffer.alloc(bytes.length) : bytes).toString("base64") });
 }) as typeof fetch;
 return { fetcher, urls };
}
test("large binary is never requested and source snapshot retains original paths and bytes", async () => {
 const f = fixture([entry, model]);
 const result = await fetchSourceArchive({ ...input, fetcher: f.fetcher });
 assert.ok(result);
 assert.deepEqual(result.selection.omitted, [{ path: model.path, reason: "Binary asset or model" }]);
 const parsed = await parseSnapshotArchive(result.archive);
 assert.equal(parsed.files[0]?.relativePath, entry.path);
 assert.deepEqual(Buffer.from(parsed.files[0]!.bytes), bytes);
 assert.equal(f.urls.length, 2);
});
test("small repositories keep the whole-archive path", async () => {
 const f = fixture([entry]);
 assert.equal(await fetchSourceArchive({ ...input, fetcher: f.fetcher }), null);
 assert.equal(f.urls.length, 1);
});
test("truncated trees, traversal paths, and blob hash mismatches fail closed", async () => {
 for (const f of [fixture([entry, model], false, true), fixture([{ ...entry, path: "../bad.php" }, model]), fixture([entry, model], true)]) {
  await assert.rejects(fetchSourceArchive({ ...input, fetcher: f.fetcher }));
 }
});
test("symlinks are omitted and never followed", async () => {
 const f = fixture([entry, model, { ...entry, path: "linked.php", mode: "120000" }]);
 const result = await fetchSourceArchive({ ...input, fetcher: f.fetcher });
 assert.equal(result?.selection.includedFiles, 1);
 assert.equal(result?.selection.omitted.length, 2);
 assert.equal(f.urls.length, 2);
});

 test("selection metadata preserves legacy manifests and rejects malformed additions", async () => {
  const { snapshotManifest } = await import("../apps/worker/src/snapshot/selection.ts");
  const manifest = { storageObjectId: "id", archiveSha256: "sha", archiveBytes: 1, commitSha: "commit", files: 2, extractedBytes: 3 };
  assert.equal(snapshotManifest(manifest), manifest);
  const selected = { ...manifest, sourceSelection: { totalFiles: 3, includedFiles: 2, omitted: [{ path: "model.onnx", reason: "binary" }] } };
  assert.deepEqual(snapshotManifest(selected), manifest);
  assert.ok("sourceSelection" in selected);
  const invalid = { ...manifest, sourceSelection: { totalFiles: 1, includedFiles: 2, omitted: [] } };
  assert.equal(snapshotManifest(invalid), invalid);
  const extra = { ...selected, unexpected: true };
  assert.deepEqual(snapshotManifest(extra), { ...manifest, unexpected: true });
 });
