import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { PrismaClient } from "../../../../packages/database/generated/client.ts";

const MAX_EXPORT_BYTES = 32 * 1024 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const STORAGE_KEY_PATTERN = /^export-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/document\.md$/i;

export type ExportDownloadState =
  | { kind: "ready"; value: { bytes: Uint8Array; filename: string } }
  | { kind: "not-found" }
  | { kind: "not-ready" };

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function filename(repositoryFullName: string | null, commitSha: string): string {
  const rawSlug = repositoryFullName?.split("/").at(-1) ?? "analysis";
  const slug = rawSlug.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "analysis";
  const shortSha = /^[a-f0-9]{40,64}$/i.test(commitSha) ? commitSha.slice(0, 7).toLowerCase() : "snapshot";
  return `sage-${slug}-${shortSha}.md`;
}

/** Read only a READY owner-bound Markdown file and verify its private storage checksum. */
export async function loadExportDownloadForUser(
  db: PrismaClient,
  storageRoot: string,
  ownerUserId: string,
  analysisId: string,
  exportId: string,
): Promise<ExportDownloadState> {
  const record = await db.export.findFirst({
    where: { id: exportId, ownerUserId, analysisId, format: "MARKDOWN" },
    select: {
      id: true,
      format: true,
      status: true,
      contentHash: true,
      storageObject: { select: { storageKey: true, sha256: true, byteLength: true, type: true, status: true } },
      analysis: {
        select: {
          commitSha: true,
          repositoryFullNameSnapshot: true,
          repository: { select: { fullName: true } },
        },
      },
    },
  });
  if (!record) return { kind: "not-found" };
  if (record.status !== "READY") return { kind: "not-ready" };

  const object = record.storageObject;
  if (!object || object.type !== "EXPORT" || object.status !== "ACTIVE"
    || !record.contentHash || !SHA256_PATTERN.test(record.contentHash)
    || !SHA256_PATTERN.test(object.sha256) || object.sha256 !== record.contentHash
    || object.byteLength < 0n || object.byteLength > BigInt(MAX_EXPORT_BYTES)
    || !STORAGE_KEY_PATTERN.test(object.storageKey)) {
    throw new Error("Export storage metadata failed integrity checks.");
  }

  const root = await realpath(storageRoot);
  const [folderName] = object.storageKey.split("/");
  const folderPath = join(root, folderName);
  const folderStat = await lstat(folderPath);
  if (!folderStat.isDirectory() || folderStat.isSymbolicLink()) throw new Error("Export storage directory is invalid.");
  const resolvedFolder = await realpath(folderPath);
  if (resolvedFolder !== folderPath) throw new Error("Export storage directory is invalid.");

  const filePath = join(root, object.storageKey);
  const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes: Buffer;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || BigInt(stat.size) !== object.byteLength || stat.size > MAX_EXPORT_BYTES) throw new Error("Export storage file is invalid.");
    bytes = await handle.readFile();
  } finally {
    await handle.close();
  }
  if (sha256(bytes) !== object.sha256) throw new Error("Export storage checksum does not match.");

  const repositoryFullName = record.analysis.repositoryFullNameSnapshot ?? record.analysis.repository.fullName;
  return { kind: "ready", value: { bytes, filename: filename(repositoryFullName, record.analysis.commitSha) } };
}
