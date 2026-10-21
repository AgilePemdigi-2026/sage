import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { canonicalizeCkg } from "@sage/contracts";
import { database, disconnectDatabase, enqueueAnalysis, failAnalysisJob, claimAnalysisJob } from "../packages/database/src/index.ts";
import { persistCanonicalGraph } from "../packages/database/src/graphs.ts";
import { persistCanonicalDocument, readCanonicalDocumentForUser } from "../packages/database/src/documents.ts";
import { completeAnalysisStage, initializeAnalysisStages, startAnalysisStage } from "../packages/database/src/stages.ts";
import type { AnalysisJobClaim } from "../packages/database/src/queue.ts";

function assertIsolatedDatabase(): void {
  if (process.env.SAGE_DOCUMENT_TESTS !== "1") {
    throw new Error("Set SAGE_DOCUMENT_TESTS=1 to run destructive document persistence integration tests.");
  }
  const rawUrl = process.env.DATABASE_URL;
  if (!rawUrl) throw new Error("DATABASE_URL is required for document persistence integration tests.");
  let databaseName: string;
  try { databaseName = decodeURIComponent(new URL(rawUrl).pathname.slice(1)); }
  catch { throw new Error("DATABASE_URL is invalid; it was not logged."); }
  if (databaseName !== "sage_document15") {
    throw new Error("Document persistence tests only allow the isolated sage_document15 database.");
  }
}

const STAGES_BEFORE_DOCUMENT = [
  "SNAPSHOT",
  "LANGUAGE_DETECTION",
  "STATIC_ANALYSIS",
  "COMMON_CODE_MODEL",
  "KNOWLEDGE_GRAPH",
  "INTERFACE_CATALOG",
  "SOFTWARE_ENGINEERING_DIAGRAM",
  "UML_CLASS_DIAGRAM",
] as const;

test("DOC01 persistence is canonical, owner and lease fenced, immutable and hidden before publication", {
  skip: process.env.SAGE_DOCUMENT_TESTS !== "1",
}, async () => {
  assertIsolatedDatabase();
  const db = database();
  const suffix = randomUUID();
  const userIds: string[] = [];
  const jobs: string[] = [];
  const claims: AnalysisJobClaim[] = [];
  const analysisIds: string[] = [];
  let repositoryId = "";
  try {
    const owner = await db.user.create({
      data: { githubUserId: `doc15-owner-${suffix}`, login: `doc15-owner-${suffix}` },
    });
    userIds.push(owner.id);
    const other = await db.user.create({
      data: { githubUserId: `doc15-other-${suffix}`, login: `doc15-other-${suffix}` },
    });
    userIds.push(other.id);
    const repository = await db.repository.create({ data: {
      githubRepositoryId: `doc15-repo-${suffix}`,
      ownerLogin: "sage-document-test",
      name: suffix,
      fullName: `sage-document-test/${suffix}`,
      visibility: "PUBLIC",
    } });
    repositoryId = repository.id;

    const [sourceText, payloadText] = await Promise.all([
      readFile(new URL("../packages/contracts/examples/minimum-ccm.source.ts", import.meta.url), "utf8"),
      readFile(new URL("../packages/contracts/examples/minimum-ccm.json", import.meta.url), "utf8"),
    ]);
    const sourceBytes = { "examples/minimum-ccm.source.ts": new TextEncoder().encode(sourceText) };
    const enqueued = await enqueueAnalysis(db, {
      ownerUserId: owner.id,
      repositoryId,
      branchName: "main",
      commitSha: "a".repeat(40),
      configuration: { includeTests: false },
      analyzerVersion: "doc15-integration",
      schemaVersion: "1",
    });
    analysisIds.push(enqueued.analysisId);
    jobs.push(enqueued.jobId);
    const claim = await claimAnalysisJob(db, { leaseDurationMs: 300_000 });
    assert.ok(claim);
    claims.push(claim);
    assert.equal(claim.analysisId, enqueued.analysisId);

    const initialized = await initializeAnalysisStages(db, claim);
    assert.ok(initialized);
    const ccm = JSON.parse(payloadText) as Record<string, unknown>;
    ccm.snapshot = {
      repository: repository.fullName,
      branch: "main",
      commitSha: "a".repeat(40),
    };
    const canonicalGraph = canonicalizeCkg(ccm, sourceBytes, enqueued.configurationHash);
    if (!canonicalGraph.ok) throw new Error(`Fixture CKG is invalid: ${canonicalGraph.errorCode}`);

    for (const key of STAGES_BEFORE_DOCUMENT.slice(0, 4)) {
      assert.equal(await startAnalysisStage(db, claim, key), true);
      assert.equal(await completeAnalysisStage(db, claim, key), true);
    }
    assert.equal(await startAnalysisStage(db, claim, "KNOWLEDGE_GRAPH"), true);
    const storedGraph = await persistCanonicalGraph(db, {
      claim,
      ccm,
      sourceBytes,
      configurationHash: enqueued.configurationHash,
    });
    assert.ok(storedGraph);
    assert.equal(await completeAnalysisStage(db, claim, "KNOWLEDGE_GRAPH"), true);
    for (const key of STAGES_BEFORE_DOCUMENT.slice(5)) {
      assert.equal(await startAnalysisStage(db, claim, key), true);
      assert.equal(await completeAnalysisStage(db, claim, key), true);
    }

    const documentInput = {
      claim,
      canonicalCkgJson: canonicalGraph.json,
      sourceBytes,
      expectedCkgSha256: canonicalGraph.sha256,
    };

    // The stage gate rejects writes until stage 9 is active.
    await assert.rejects(persistCanonicalDocument(db, documentInput), /tahap architecture document/);
    assert.equal(await startAnalysisStage(db, claim, "ARCHITECTURE_DOCUMENT"), true);

    // A stale token and a forged owner are rejected by the database-clock lease fence.
    assert.equal(await persistCanonicalDocument(db, {
      ...documentInput,
      claim: { ...claim, leaseToken: "22222222-2222-4222-8222-222222222222" },
    }), null);
    assert.equal(await persistCanonicalDocument(db, {
      ...documentInput,
      claim: { ...claim, ownerUserId: other.id },
    }), null);

    // Each caller-supplied canonical dimension is checked before any document is written.
    await assert.rejects(persistCanonicalDocument(db, {
      ...documentInput,
      expectedCkgSha256: "d".repeat(64),
    }), /CKG canonical tidak valid/);
    const alteredSources = { ...sourceBytes, "examples/minimum-ccm.source.ts": new Uint8Array(sourceBytes["examples/minimum-ccm.source.ts"]!) };
    alteredSources["examples/minimum-ccm.source.ts"]![0] ^= 1;
    await assert.rejects(persistCanonicalDocument(db, { ...documentInput, sourceBytes: alteredSources }), /CKG canonical tidak valid/);
    const wrongConfigGraph = canonicalizeCkg(ccm, sourceBytes, "d".repeat(64));
    assert.equal(wrongConfigGraph.ok, true);
    if (!wrongConfigGraph.ok) throw new Error("Wrong-config CKG fixture must remain structurally valid");
    await assert.rejects(persistCanonicalDocument(db, {
      ...documentInput,
      canonicalCkgJson: wrongConfigGraph.json,
      expectedCkgSha256: wrongConfigGraph.sha256,
    }), /target analisis/);
    const wrongTargetCcm = structuredClone(ccm);
    (wrongTargetCcm.snapshot as Record<string, unknown>).repository = `other/${suffix}`;
    const wrongTargetGraph = canonicalizeCkg(wrongTargetCcm, sourceBytes, enqueued.configurationHash);
    assert.equal(wrongTargetGraph.ok, true);
    if (!wrongTargetGraph.ok) throw new Error("Wrong-target CKG fixture must remain structurally valid");
    await assert.rejects(persistCanonicalDocument(db, {
      ...documentInput,
      canonicalCkgJson: wrongTargetGraph.json,
      expectedCkgSha256: wrongTargetGraph.sha256,
    }), /target analisis/);

    // A graph row must exist and every canonical mirror must match before document insertion.
    await db.graphBundle.delete({ where: { analysisId_ownerUserId: { analysisId: claim.analysisId, ownerUserId: owner.id } } });
    await assert.rejects(persistCanonicalDocument(db, documentInput), /Graph bundle/);
    await db.graphBundle.create({ data: {
      ownerUserId: owner.id,
      analysisId: claim.analysisId,
      schemaVersion: canonicalGraph.value.schemaVersion,
      configurationHash: canonicalGraph.value.configurationHash,
      canonicalContent: canonicalGraph.json,
      nodes: JSON.stringify(canonicalGraph.value.ccm.nodes),
      edges: JSON.stringify(canonicalGraph.value.ccm.edges),
      nodeCount: canonicalGraph.value.counts.nodes,
      edgeCount: canonicalGraph.value.counts.edges,
      contentHash: canonicalGraph.sha256,
    } });
    const beforeMirrorMismatch = await db.graphBundle.findUniqueOrThrow({
      where: { analysisId_ownerUserId: { analysisId: claim.analysisId, ownerUserId: owner.id } },
    });
    await db.graphBundle.update({ where: { id: beforeMirrorMismatch.id }, data: { nodes: "[]" } });
    await assert.rejects(persistCanonicalDocument(db, documentInput), /Graph bundle/);
    await db.graphBundle.update({
      where: { id: beforeMirrorMismatch.id },
      data: { nodes: JSON.stringify(canonicalGraph.value.ccm.nodes) },
    });

    const storedDocument = await persistCanonicalDocument(db, documentInput);
    assert.ok(storedDocument);
    assert.equal(storedDocument.contentHash.length, 64);
    assert.deepEqual(await persistCanonicalDocument(db, documentInput), storedDocument, "identical replay preserves the same row and hash");
    const savedRow = await db.architectureDocument.findUniqueOrThrow({
      where: { analysisId_ownerUserId: { analysisId: claim.analysisId, ownerUserId: owner.id } },
    });
    assert.equal(typeof savedRow.interfaceCatalog, "string", "complex mirrors are persisted as JSON strings for PostgreSQL Unicode safety");
    assert.equal(typeof savedRow.softwareEngineeringDiagram, "string");
    assert.equal(typeof savedRow.umlClassDiagram, "string");
    const interfaceCatalogMirror = savedRow.interfaceCatalog as string;
    await db.architectureDocument.update({ where: { id: savedRow.id }, data: { contentHash: "f".repeat(64) } });
    await assert.rejects(persistCanonicalDocument(db, documentInput), /immutable/);
    await db.architectureDocument.update({ where: { id: savedRow.id }, data: { contentHash: savedRow.contentHash } });

    // Draft documents remain hidden while Analysis is RUNNING, and owner scoping hides them too.
    assert.equal(await readCanonicalDocumentForUser(db, owner.id, claim.analysisId, sourceBytes), null);
    assert.equal(await readCanonicalDocumentForUser(db, other.id, claim.analysisId, sourceBytes), null);
    await db.analysis.update({ where: { id: claim.analysisId }, data: { status: "COMPLETED", completedAt: new Date() } });
    const published = await readCanonicalDocumentForUser(db, owner.id, claim.analysisId, sourceBytes);
    assert.equal(published?.id, storedDocument.id);
    assert.equal(published?.contentHash, storedDocument.contentHash);

    // Corrupted document and graph mirrors fail closed on published reads.
    await db.architectureDocument.update({ where: { id: savedRow.id }, data: { interfaceCatalog: "{}" } });
    await assert.rejects(readCanonicalDocumentForUser(db, owner.id, claim.analysisId, sourceBytes), /canonical/);
    await db.architectureDocument.update({ where: { id: savedRow.id }, data: { interfaceCatalog: interfaceCatalogMirror } });
    await db.architectureDocument.update({ where: { id: savedRow.id }, data: { title: "Tampered title" } });
    await assert.rejects(readCanonicalDocumentForUser(db, owner.id, claim.analysisId, sourceBytes), /canonical/);
    await db.architectureDocument.update({ where: { id: savedRow.id }, data: { title: savedRow.title } });
    await db.architectureDocument.update({ where: { id: savedRow.id }, data: { documentModelVersion: "other-version" } });
    await assert.rejects(readCanonicalDocumentForUser(db, owner.id, claim.analysisId, sourceBytes), /canonical/);
    await db.architectureDocument.update({ where: { id: savedRow.id }, data: { documentModelVersion: savedRow.documentModelVersion } });
    await db.architectureDocument.update({ where: { id: savedRow.id }, data: { canonicalContent: "{}" } });
    await assert.rejects(readCanonicalDocumentForUser(db, owner.id, claim.analysisId, sourceBytes), /canonical/);
    await db.architectureDocument.update({ where: { id: savedRow.id }, data: { canonicalContent: savedRow.canonicalContent } });
    await db.architectureDocument.update({ where: { id: savedRow.id }, data: { contentHash: "e".repeat(64) } });
    await assert.rejects(readCanonicalDocumentForUser(db, owner.id, claim.analysisId, sourceBytes), /canonical/);
    await db.architectureDocument.update({ where: { id: savedRow.id }, data: { contentHash: savedRow.contentHash } });
    await db.graphBundle.update({ where: { id: beforeMirrorMismatch.id }, data: { nodes: "[]" } });
    await assert.rejects(readCanonicalDocumentForUser(db, owner.id, claim.analysisId, sourceBytes), /canonical/);
    await db.graphBundle.update({
      where: { id: beforeMirrorMismatch.id },
      data: { nodes: JSON.stringify(canonicalGraph.value.ccm.nodes) },
    });

    // Force the insert to outlive both lease timestamps; the final DB-clock check must roll it back.
    await db.architectureDocument.delete({ where: { id: savedRow.id } });
    await db.analysis.update({ where: { id: claim.analysisId }, data: { status: "RUNNING", completedAt: null } });
    const functionName = `doc15_delay_${suffix.replaceAll("-", "")}`;
    const triggerName = `${functionName}_trigger`;
    await db.$executeRawUnsafe(`CREATE FUNCTION "${functionName}"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.4); RETURN NEW; END $$`);
    await db.$executeRawUnsafe(`CREATE TRIGGER "${triggerName}" BEFORE INSERT ON "ArchitectureDocument" FOR EACH ROW EXECUTE FUNCTION "${functionName}"()`);
    try {
      await db.$executeRaw`UPDATE "WorkerSlot" SET "leaseUntil" = clock_timestamp() + interval '200 milliseconds' WHERE "jobId" = ${claim.jobId}`;
      await db.$executeRaw`UPDATE "Job" SET "leaseExpiresAt" = clock_timestamp() + interval '200 milliseconds' WHERE "id" = ${claim.jobId}`;
      assert.equal(await persistCanonicalDocument(db, documentInput), null);
      assert.equal(await db.architectureDocument.count({ where: { analysisId: claim.analysisId } }), 0);
    } finally {
      await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${triggerName}" ON "ArchitectureDocument"`);
      await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${functionName}"()`);
      await db.$executeRaw`UPDATE "WorkerSlot" SET "leaseUntil" = clock_timestamp() + interval '300 seconds' WHERE "jobId" = ${claim.jobId}`;
      await db.$executeRaw`UPDATE "Job" SET "leaseExpiresAt" = clock_timestamp() + interval '300 seconds' WHERE "id" = ${claim.jobId}`;
    }
  } finally {
    for (const claim of claims) await failAnalysisJob(db, claim, "DOC15_TEST_CLEANUP").catch(() => false);
    await db.$transaction(async tx => {
      if (jobs.length) {
        await tx.workerSlot.updateMany({
          where: { jobId: { in: jobs } },
          data: { jobId: null, ownerUserId: null, leaseUntil: null, heartbeatAt: null, leaseTokenHash: null },
        });
        await tx.job.deleteMany({ where: { id: { in: jobs }, ownerUserId: { in: userIds } } });
      }
      await tx.analysis.deleteMany({ where: { id: { in: analysisIds }, ownerUserId: { in: userIds } } });
      await tx.user.deleteMany({ where: { id: { in: userIds } } });
      if (repositoryId) await tx.repository.deleteMany({ where: { id: repositoryId } });
    });
    await disconnectDatabase();
  }
});
