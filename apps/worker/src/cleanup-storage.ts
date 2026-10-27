import { lstat, realpath, rmdir, unlink } from "node:fs/promises";
import { join } from "node:path";

const STORAGE_KEY = /^(?:snapshot-[A-Za-z0-9]{6}\/archive\.tar\.gz|export-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/document\.(?:md|pdf)(?:\.pending)?)$/i;

function missing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

/** Only remove exact reserved files; never recurse through a storage directory. */
export async function removeCleanupStorageFile(storageRoot: string, storageKey: string, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  if (typeof storageKey !== "string" || !STORAGE_KEY.test(storageKey)) throw new Error("CLEANUP_STORAGE_INVALID");
  const root = await realpath(storageRoot);
  const [folderName] = storageKey.split("/");
  const folder = join(root, folderName);
  let directory;
  try { directory = await lstat(folder); } catch (error) { if (missing(error)) return; throw error; }
  if (!directory.isDirectory() || directory.isSymbolicLink() || await realpath(folder) !== folder) {
    throw new Error("CLEANUP_STORAGE_INVALID");
  }
  const file = join(root, storageKey);
  signal?.throwIfAborted();
  try {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("CLEANUP_STORAGE_INVALID");
    await unlink(file);
  } catch (error) { if (!missing(error)) throw error; }
  // An empty directory is harmless if a process stops here; retry remains idempotent.
}

export async function finishCleanupStorageFolders(storageRoot: string, keys: readonly string[], signal?: AbortSignal): Promise<void> {
  const root = await realpath(storageRoot);
  for (const name of new Set(keys.map(key => {
    if (!STORAGE_KEY.test(key)) throw new Error("CLEANUP_STORAGE_INVALID");
    return key.split("/")[0];
  }))) {
    signal?.throwIfAborted();
    const folder = join(root, name);
    try {
      const stat = await lstat(folder);
      if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(folder) !== folder) throw new Error("CLEANUP_STORAGE_INVALID");
      await rmdir(folder); // Unexpected files are preserved and make cleanup retryable.
    } catch (error) { if (!missing(error)) throw error; }
  }
}
