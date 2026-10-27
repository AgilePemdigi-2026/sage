import { readSnapshotArchive } from "../apps/worker/src/snapshot/storage.ts";
import { parseSnapshotArchive } from "../apps/worker/src/snapshot/archive.ts";
import { compactAnalysisStorage, database, disconnectDatabase } from "@sage/database";

/** Local operator maintenance. Dry-run by default; never prints source or connection strings. */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let apply = false;
  let limit = 10;
  let analysisId: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--apply") apply = true;
    else if (args[i] === "--limit") { limit = Number(args[++i]); }
    else if (args[i] === "--analysis-id") { analysisId = args[++i]; }
    else throw new Error("Invalid arguments.");
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 ||
      (analysisId !== undefined && !/^[A-Za-z0-9_-]{8,64}$/.test(analysisId)) || args.at(-1) === "--analysis-id") throw new Error("Invalid arguments.");
  const db = database();
  const rows = analysisId ? [{ id: analysisId }] : await db.analysis.findMany({
    where: { OR: [{ graphBundle: { is: { storageLayoutVersion: 1 } } }, { architectureDocument: { is: { storageLayoutVersion: 1 } } }] },
    orderBy: { id: "asc" }, take: limit, select: { id: true },
  });
  const summary = {
    mode: apply ? "apply" : "audit", examined: 0, eligible: 0, compacted: 0, unchanged: 0, skipped: 0,
    graphs: 0, documents: 0, canonicalBytes: 0, removableMirrorBytes: 0, skipReasons: {} as Record<string, number>,
  };
  for (const row of rows) {
    const analysis = await db.analysis.findFirst({ where: { id: row.id }, select: { ownerUserId: true, status: true, deletionRequestedAt: true } });
    let sourceBytes: Record<string, Uint8Array> | undefined;
    if (analysis && analysis.deletionRequestedAt === null && !["QUEUED", "RUNNING"].includes(analysis.status)) {
      const snapshot = await db.storageObject.findFirst({
        where: { analysisId: row.id, ownerUserId: analysis.ownerUserId, type: "SOURCE_ARCHIVE", status: "ACTIVE" },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { id: true },
      });
      if (snapshot) {
        try {
          const bytes = await readSnapshotArchive(db, { ownerUserId: analysis.ownerUserId, analysisId: row.id,
            storageObjectId: snapshot.id, storageRoot: process.env.STORAGE_ROOT ?? "/app/storage" });
          const archive = await parseSnapshotArchive(bytes);
          sourceBytes = Object.fromEntries(archive.files.map(file => [file.relativePath, file.bytes]));
        } catch { /* Missing/corrupt source is unverified, never grounds for dropping mirrors. */ }
      }
    }
    const result = await compactAnalysisStorage(db, row.id, { apply, sourceBytes });
    summary.examined += 1;
    summary[result.status] += 1;
    summary.graphs += result.graphs;
    summary.documents += result.documents;
    summary.canonicalBytes += result.canonicalBytes;
    summary.removableMirrorBytes += result.removableMirrorBytes;
    if (result.reason) summary.skipReasons[result.reason] = (summary.skipReasons[result.reason] ?? 0) + 1;
  }
  console.log(JSON.stringify(summary));
}
main().catch(() => {
  console.error("Canonical storage maintenance failed; source, credentials and database details are omitted.");
  process.exitCode = 1;
}).finally(async () => { await disconnectDatabase(); });
