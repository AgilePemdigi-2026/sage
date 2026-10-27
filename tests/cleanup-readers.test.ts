import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PrismaClient } from "../packages/database/generated/client.ts";
import { loadAnyExportDownloadForUser } from "../apps/web/lib/exports/reader.ts";

test("export download rechecks deletion after loading private bytes and suppresses a revoked result", async () => {
  const root = await mkdtemp(join(tmpdir(), "sage-cleanup-download-"));
  const folder = "export-11111111-1111-4111-8111-111111111111";
  const bytes = Buffer.from("private Markdown evidence");
  const checksum = createHash("sha256").update(bytes).digest("hex");
  let deleted = true;
  const db = {
    export: { findFirst: async ({ where }: { where: unknown }) => {
      assert.deepEqual(where, { id: "export-23", ownerUserId: "owner-23", analysisId: "analysis-23", analysis: { deletionRequestedAt: null } });
      return {
        id: "export-23", format: "MARKDOWN", status: "READY", contentHash: checksum,
        storageObject: { storageKey: `${folder}/document.md`, sha256: checksum, byteLength: BigInt(bytes.length), type: "EXPORT", status: "ACTIVE" },
        analysis: { commitSha: "a".repeat(40), repositoryFullNameSnapshot: "fixture/cleanup", repository: { fullName: "fixture/cleanup" } },
      };
    } },
    analysis: { findFirst: async () => deleted ? null : { id: "analysis-23" } },
  } as unknown as PrismaClient;
  try {
    await mkdir(join(root, folder)); await writeFile(join(root, folder, "document.md"), bytes);
    assert.deepEqual(await loadAnyExportDownloadForUser(db, root, "owner-23", "analysis-23", "export-23"), { kind: "not-found" });
    deleted = false;
    const state = await loadAnyExportDownloadForUser(db, root, "owner-23", "analysis-23", "export-23");
    assert.equal(state.kind, "ready");
    if (state.kind === "ready") assert.deepEqual(Buffer.from(state.value.bytes), bytes);
  } finally { await rm(root, { recursive: true, force: true }); }
});
