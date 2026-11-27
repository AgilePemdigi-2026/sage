import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { pack } from "tar-stream";
import { GitHubRepositoryError } from "./client.ts";

export type SourceSelection = { totalFiles: number; includedFiles: number; omitted: Array<{ path: string; reason: string }> };
const MAX_FILE = 1024 * 1024;
const MAX_FILES = 250;
const MAX_TOTAL = 20 * 1024 * 1024;
// A recursive tree may include thousands of vendor paths even when the
// selected source is small. Bound metadata separately from source content.
const MAX_TREE_RESPONSE = 4 * 1024 * 1024;
const BINARY = /\.(?:onnx|pt|pth|h5|hdf5|pkl|pickle|safetensors|bin|zip|gz|7z|pdf|png|jpe?g|gif|webp|ico|woff2?|ttf|mp[34]|wav|sqlite3?)$/i;
const DEPENDENCY = /(?:^|\/)(?:node_modules|vendor|\.git|\.next|__pycache__)(?:\/|$)/;
const unsafe = (path: string) => !path || path.length > 4096 || path.includes("\\") || /[\x00-\x1f\x7f]/.test(path) || path.split("/").some(p => !p || p === "." || p === "..");

/** Bounded source-only archive, fetched from immutable Git blobs with hash verification. */
export async function fetchSourceArchive(input: {
  owner: string; name: string; sha: string; token: string | null;
  signal: AbortSignal; fetcher: typeof fetch; maxArchiveBytes: number;
}): Promise<{ archive: Uint8Array; selection: SourceSelection } | null> {
  const failed = new AbortController();
  const signal = AbortSignal.any([input.signal, failed.signal]);
  const base = `https://api.github.com/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.name)}/git`;
  async function get(path: string, limit: number): Promise<Buffer> {
    signal.throwIfAborted();
    const headers = new Headers({ Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2026-03-10" });
    if (input.token) headers.set("Authorization", `Bearer ${input.token}`);
    const response = await input.fetcher(base + path, { headers, signal, cache: "no-store", redirect: "error" });
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      throw new GitHubRepositoryError(response.status === 429 || (response.status === 403 && (response.headers.get("x-ratelimit-remaining") === "0" || response.headers.has("retry-after"))) ? "RATE_LIMIT" : response.status === 401 ? "AUTH_REQUIRED" : response.status === 403 ? "PERMISSION_DENIED" : "UNAVAILABLE");
    }
    if (!response.body) throw new GitHubRepositoryError("UNAVAILABLE");
    const reader = response.body.getReader(); const chunks: Buffer[] = []; let size = 0;
    try {
      while (true) {
        const part = await reader.read(); if (part.done) break;
        size += part.value.byteLength;
        if (size > limit) throw new GitHubRepositoryError("UNAVAILABLE");
        chunks.push(Buffer.from(part.value));
      }
    } finally { await reader.cancel().catch(() => undefined); }
    return Buffer.concat(chunks, size);
  }
  const tree = JSON.parse((await get(`/trees/${input.sha}?recursive=1`, MAX_TREE_RESPONSE)).toString("utf8"));
  if (tree.truncated !== false || !Array.isArray(tree.tree) || tree.tree.length > 10000) throw new GitHubRepositoryError("UNAVAILABLE");
  // Small repositories keep the original whole-archive path and its coverage.
  const total = tree.tree.filter((entry: { type: string }) => entry.type === "blob").reduce((sum: number, entry: { size: number }) => sum + (Number.isSafeInteger(entry.size) && entry.size >= 0 ? entry.size : MAX_TOTAL + 1), 0);
  if (total <= MAX_TOTAL) return null;
  const selected: Array<{ path: string; sha: string; size: number }> = [];
  const selection: SourceSelection = { totalFiles: 0, includedFiles: 0, omitted: [] };
  let planned = 0;
  for (const entry of tree.tree) {
    if (entry.type === "tree") continue;
    if (typeof entry.path !== "string" || unsafe(entry.path)) throw new GitHubRepositoryError("UNAVAILABLE");
    selection.totalFiles++;
    const reason = entry.type !== "blob" || entry.mode !== "100644" && entry.mode !== "100755" ? "Non-regular Git entry" : DEPENDENCY.test(entry.path) ? "Dependency or generated directory" : BINARY.test(entry.path) ? "Binary asset or model" : Number.isSafeInteger(entry.size) && entry.size > MAX_FILE ? "File exceeds source size limit" : null;
    if (reason) { selection.omitted.push({ path: entry.path, reason }); continue; }
    if (!Number.isSafeInteger(entry.size) || entry.size < 0 || typeof entry.sha !== "string" || !/^[a-f0-9]{40}$/.test(entry.sha)) throw new GitHubRepositoryError("UNAVAILABLE");
    planned += entry.size;
    selected.push(entry);
  }
  // If per-blob fetching exceeds its budget, let the caller try the immutable
  // whole archive. Its download and extraction limits still apply.
  if (planned > MAX_TOTAL || selected.length > MAX_FILES) return null;
  const files: Array<{ path: string; bytes: Buffer }> = new Array(selected.length);
  let next = 0;
  // Four requests at once, with a strict overall deadline supplied by the caller.
  try { await Promise.all(Array.from({ length: Math.min(4, selected.length) }, async () => {
    while (next < selected.length) {
      const index = next++; const entry = selected[index]!;
      const body = JSON.parse((await get(`/blobs/${entry.sha}`, 2 * MAX_FILE)).toString("utf8"));
      if (body.encoding !== "base64" || body.sha !== entry.sha || body.size !== entry.size || typeof body.content !== "string") throw new GitHubRepositoryError("UNAVAILABLE");
      const content = body.content.replace(/\s/g, "");
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(content)) throw new GitHubRepositoryError("UNAVAILABLE");
      const bytes = Buffer.from(content, "base64");
      if (bytes.length !== entry.size || createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex") !== entry.sha) throw new GitHubRepositoryError("UNAVAILABLE");
      files[index] = { path: entry.path, bytes };
    }
  })); } catch (error) { failed.abort(); throw error; }
  const tar = pack(); const chunks: Buffer[] = [];
  const collecting = (async () => { for await (const chunk of tar) chunks.push(Buffer.from(chunk as Uint8Array)); })();
  for (const file of files) await new Promise<void>((resolve, reject) => tar.entry({ name: `source-${input.sha}/${file.path}`, size: file.bytes.length, mode: 0o644, mtime: new Date(0) }, file.bytes, error => error ? reject(error) : resolve()));
  tar.finalize(); await collecting;
  const archive = gzipSync(Buffer.concat(chunks));
  if (archive.length > input.maxArchiveBytes) throw new GitHubRepositoryError("UNAVAILABLE");
  selection.includedFiles = files.length;
  return { archive, selection };
}
