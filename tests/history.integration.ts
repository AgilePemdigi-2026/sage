// Integration test destruktif terhadap database uji terisolasi yang sudah dimigrasi.
// Jalankan: SAGE_HISTORY_TESTS=1 DATABASE_URL='postgresql://sage:sage@localhost:5432/sage_hist01_fresh' npx tsx --test tests/history.integration.ts
import assert from "node:assert/strict";
import test from "node:test";
import { database, disconnectDatabase, getAnalysisDetailForUser, listAnalysesForUser } from "../packages/database/src/index.ts";

const allowedOptIn = process.env.SAGE_HISTORY_TESTS === "1";
if (!allowedOptIn) {
  test("history integration is opt-in", () => { assert.ok(true, "skip: set SAGE_HISTORY_TESTS=1 dan DATABASE_URL"); });
} else {
  if (!/\/sage_hist01(_fresh)?$/.test(process.env.DATABASE_URL ?? "")) {
    console.error("Integration menolak database selain sage_hist01 dan sage_hist01_fresh.");
    process.exit(1);
  }
  const db = database();
  const ownerIds: string[] = [];
  const analysisIds: string[] = [];
  let repositoryId = "";
  const runTag = Date.now();
  const suffixLabel = `hist-int-${runTag}`;

  test("setup: seed fixed users, repository, and 22 analyses", async () => {
    const repository = await db.repository.create({
      data: {
        githubRepositoryId: `${suffixLabel}-repo`, ownerLogin: "acme", name: "report-service", fullName: "acme/report-service",
      },
      select: { id: true },
    });
    repositoryId = repository.id;
    const ownerA = await db.user.create({ data: { githubUserId: `${suffixLabel}-a`, login: `${suffixLabel}-a` }, select: { id: true } });
    const ownerB = await db.user.create({ data: { githubUserId: `${suffixLabel}-b`, login: `${suffixLabel}-b` }, select: { id: true } });
    ownerIds.push(ownerA.id, ownerB.id);
    for (let index = 0; index < 22; index += 1) {
      const analysis = await db.analysis.create({
        data: {
          ownerUserId: ownerA.id, repositoryId: repository.id,
          branchName: index === 0 ? "feature/x" : "main", commitSha: "a".repeat(40),
          configuration: {}, configurationHash: "integration-config",
          analyzerVersion: "declarations-v1", schemaVersion: "1",
          // Invariant satu RUNNING aktif (Analysis_one_running_idx) membuat pola
          // "index % 2 === 0 ? COMPLETED : RUNNING" tidak mungkin dipenuhi pada skema nyata,
          // sehingga hanya satu analisis yang dibuat RUNNING dan sisanya COMPLETED.
          status: index === 3 ? "FAILED" : index === 1 ? "RUNNING" : "COMPLETED",
          errorCode: index === 3 ? "SNAPSHOT_INVALID" : null,
          createdAt: new Date(runTag + index),
          updatedAt: new Date(runTag + 1_000_000 + index),
        },
        select: { id: true },
      });
      analysisIds.push(analysis.id);
    }
    const foreign = await db.analysis.create({
      data: {
        ownerUserId: ownerB.id, repositoryId: repository.id, branchName: "main", commitSha: "b".repeat(40),
        configuration: {}, configurationHash: "integration-config",
        analyzerVersion: "declarations-v1", schemaVersion: "1", status: "COMPLETED",
      },
      select: { id: true },
    });
    analysisIds.push(foreign.id);
  });

  test("owner-scoped list only returns own analyses", async () => {
    const ownerA = ownerIds[0];
    const result = await listAnalysesForUser(db, ownerA);
    assert.equal(result.items.length, 20);
    for (const item of result.items) assert.notEqual(item.id, analysisIds.at(-1));
  });

  test("status filter and query filter behave", async () => {
    const ownerA = ownerIds[0];
    const failed = await listAnalysesForUser(db, ownerA, { status: "FAILED" });
    assert.equal(failed.items.length, 1);
    assert.equal(failed.items[0].errorCode, "SNAPSHOT_INVALID");
    const searched = await listAnalysesForUser(db, ownerA, { query: "acme" });
    assert.ok(searched.items.length > 0);
    const branchSearch = await listAnalysesForUser(db, ownerA, { query: "feature/x" });
    assert.equal(branchSearch.items.length, 1);
    const shaSearch = await listAnalysesForUser(db, ownerA, { query: "a".repeat(40) });
    assert.equal(shaSearch.items.length, 20);
  });

  test("cursor pagination is stable without duplicates or overlaps", async () => {
    const ownerA = ownerIds[0];
    const first = await listAnalysesForUser(db, ownerA);
    assert.equal(first.items.length, 20);
    assert.notEqual(first.nextCursor, null);
    const second = await listAnalysesForUser(db, ownerA, { cursor: first.nextCursor ?? "" });
    assert.equal(second.items.length, 2);
    const firstIds = new Set(first.items.map(item => item.id));
    for (const item of second.items) assert.equal(firstIds.has(item.id), false);
  });

  test("detail shows stored stage then nine-entry fill and owner isolation", async () => {
    const ownerA = ownerIds[0];
    const withStages = analysisIds[0];
    await db.analysisStage.create({
      data: { ownerUserId: ownerA, analysisId: withStages, sequence: 1, key: "SNAPSHOT", status: "RUNNING", startedAt: new Date() },
    });
    const detail = await getAnalysisDetailForUser(db, ownerA, withStages);
    assert.ok(detail);
    assert.equal(detail.stages.length, 9);
    assert.equal(detail.stages[0].status, "RUNNING");
    assert.ok(detail.stages.slice(1).every(stage => stage.status === "PENDING"));
    assert.equal(detail.results === null || detail.results.graphUrl.endsWith("/graph"), true);
    const crossOwner = await getAnalysisDetailForUser(db, ownerIds[1], withStages);
    assert.equal(crossOwner, null);
  });

  test.after(async () => {
    if (!allowedOptIn) return;
    await db.analysis.deleteMany({ where: { id: { in: analysisIds } } });
    await db.user.deleteMany({ where: { id: { in: ownerIds } } });
    await db.repository.deleteMany({ where: { id: repositoryId } });
    await disconnectDatabase();
  });
}
