import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PrismaClient } from "../packages/database/generated/client.ts";
import { writeSnapshotArchive, readSnapshotArchive } from "../apps/worker/src/snapshot/storage.ts";

test("snapshot storage is owner-scoped, hash-checked and removes partial writes", async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), "sage-storage-test-"));
  const archive = Buffer.from("archive fixture"); const sha256 = createHash("sha256").update(archive).digest("hex");
  let row: Record<string, unknown> | null = null;
  const tx = { $queryRaw: async (query: TemplateStringsArray) => {
    const sql = query.join("?");
    if (sql.includes('AS "reservations"')) return [{ slotKey: "analysis", jobType: "ANALYSIS", reservations: [] }];
    if (sql.includes('SELECT "deletionRequestedAt"')) return [{ deletionRequestedAt: null }];
    return [{ active: true }];
  }, job: { updateMany: async () => ({ count: 1 }) }, storageObject: {
    create: async ({ data }: { data: Record<string, unknown> }) => { row = { ...data, id: "stored" }; return { id: "stored", sha256 }; },
    findFirst: async ({ where }: { where: Record<string, unknown> }) => row && where.ownerUserId === row.ownerUserId && where.analysisId === row.analysisId ? row : null,
  } };
  const db = { ...tx, $transaction: async (action: (value: typeof tx) => unknown) => action(tx) } as unknown as PrismaClient;
  try {
    const result = await writeSnapshotArchive(db, { storageRoot, claim: { ownerUserId: "owner", analysisId: "analysis", jobId: "job", attempt: 1, leaseToken: "11111111-1111-4111-8111-111111111111", leaseExpiresAt: new Date(Date.now() + 30000) }, archive, sha256 });
    const input = { storageRoot, ownerUserId: "owner", analysisId: "analysis", storageObjectId: result.storageObjectId };
    assert.deepEqual(await readSnapshotArchive(db, input), archive);
    await assert.rejects(readSnapshotArchive(db, { ...input, ownerUserId: "foreign" }));
    await assert.rejects(readSnapshotArchive(db, { ...input, analysisId: "foreign" }));
    const folder = (await readdir(storageRoot))[0]; const path = join(storageRoot, folder, "archive.tar.gz");
    await writeFile(path, Buffer.alloc(archive.length, 1)); await assert.rejects(readSnapshotArchive(db, input));
    await rm(path); await symlink("/etc/passwd", path); await assert.rejects(readSnapshotArchive(db, input));
    const failed = { $transaction: async () => { throw new Error("database failure"); }, storageObject: { create: async () => { throw new Error("database failure"); } } } as unknown as PrismaClient;
    await assert.rejects(writeSnapshotArchive(failed, { storageRoot, claim: { ownerUserId: "owner", analysisId: "analysis", jobId: "job", attempt: 1, leaseToken: "11111111-1111-4111-8111-111111111111", leaseExpiresAt: new Date(Date.now() + 30000) }, archive, sha256 }));
    assert.equal((await readdir(storageRoot)).length, 1);
  } finally { await rm(storageRoot, { recursive: true, force: true }); }
});
