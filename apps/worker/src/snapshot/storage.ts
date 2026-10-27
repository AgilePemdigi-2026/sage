import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { createHash } from "node:crypto";
import type { PrismaClient } from "../../../../packages/database/generated/client.ts";
import { registerSnapshotArchive } from "../../../../packages/database/src/snapshot.ts";
import { reserveJobStorage } from "@sage/database";
import type { AnalysisJobClaim } from "../../../../packages/database/src/queue.ts";
import { SnapshotArchiveError } from "./archive.ts";
export async function writeSnapshotArchive(db: PrismaClient, input: { storageRoot: string; claim: AnalysisJobClaim; signal?: AbortSignal; archive: Uint8Array; sha256: string }) {
  const archive = Buffer.from(input.archive);
  if (createHash("sha256").update(archive).digest("hex") !== input.sha256) throw new SnapshotArchiveError("SNAPSHOT_INVALID");
  input.signal?.throwIfAborted();
  await mkdir(input.storageRoot, { recursive: true, mode: 0o700 });
  const root = await realpath(input.storageRoot);
  const folder = await mkdtemp(join(root, "snapshot-"));
  const storageKey = `${basename(folder)}/archive.tar.gz`;
  try {
    if (!await reserveJobStorage(db, input.claim, storageKey)) throw new SnapshotArchiveError("SNAPSHOT_INVALID");
    await writeFile(join(folder, "archive.tar.gz"), archive, { flag: "wx", mode: 0o600 });
    input.signal?.throwIfAborted();
    const record = await registerSnapshotArchive(db, input.claim, { storageKey, sha256: input.sha256, byteLength: archive.byteLength, signal: input.signal });
    return { storageObjectId: record.id, archiveSha256: record.sha256, archiveBytes: archive.byteLength };
  } catch (e) { await rm(folder, { recursive: true, force: true }); throw e; }
}
export async function readSnapshotArchive(db: PrismaClient, input: { storageRoot: string; ownerUserId: string; analysisId: string; storageObjectId: string }) {
  const record = await db.storageObject.findFirst({ where: { id: input.storageObjectId, ownerUserId: input.ownerUserId, analysisId: input.analysisId, type: "SOURCE_ARCHIVE", status: "ACTIVE" }, select: { storageKey: true, sha256: true, byteLength: true } });
  if (!record || !/^snapshot-[A-Za-z0-9]{6}\/archive\.tar\.gz$/.test(record.storageKey) || record.byteLength > 26214400n) throw new SnapshotArchiveError("SNAPSHOT_INVALID");
  const root = await realpath(input.storageRoot); const folder = join(root, record.storageKey.split("/")[0]);
  if (!(await lstat(folder)).isDirectory() || (await lstat(folder)).isSymbolicLink()) throw new SnapshotArchiveError("SNAPSHOT_INVALID");
  const handle = await open(join(root, record.storageKey), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat(); if (!stat.isFile() || BigInt(stat.size) !== record.byteLength || stat.size > 26214400) throw new SnapshotArchiveError("SNAPSHOT_INVALID");
    const bytes = await readFile(handle);
    if (createHash("sha256").update(bytes).digest("hex") !== record.sha256) throw new SnapshotArchiveError("SNAPSHOT_INVALID");
    return bytes;
  } finally { await handle.close(); }
}
