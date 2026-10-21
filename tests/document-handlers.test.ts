import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { pack } from "tar-stream";
import test from "node:test";
import { canonicalizeCcm, canonicalizeCkg } from "../packages/contracts/src/index.ts";
import { projectArchitectureDocument } from "@sage/documents/model";
import { createDocumentStageHandlers } from "../apps/worker/src/document-handlers.ts";
import type { AnalysisStageContext } from "../apps/worker/src/stage-runner.ts";
import type { AnalysisStageTargetContext } from "../packages/database/src/stages.ts";
import type { AnalysisJobClaim } from "../packages/database/src/queue.ts";
import type { PrismaClient } from "../packages/database/generated/client.ts";
import type { AnalysisStageArtifact } from "../apps/worker/src/stage-runner.ts";

const ccm = JSON.parse(readFileSync(new URL("../packages/contracts/examples/minimum-ccm.json", import.meta.url), "utf8"));
const exampleSource = new Uint8Array(readFileSync(new URL("../packages/contracts/examples/minimum-ccm.source.ts", import.meta.url)));
const claim: AnalysisJobClaim = {
  jobId: "job-document-stage",
  analysisId: "analysis-document-stage",
  ownerUserId: "owner-document-stage",
  attempt: 1,
  leaseToken: "11111111-1111-4111-8111-111111111111",
  leaseExpiresAt: new Date(Date.now() + 30_000),
};

function hash(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function asStageArtifact(value: unknown): AnalysisStageArtifact {
  assert.notEqual(value, undefined);
  return JSON.parse(JSON.stringify(value)) as AnalysisStageArtifact;
}

function asArtifactRecord(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

async function tarArchive(sourceBytes: Readonly<Record<string, Uint8Array>>): Promise<Uint8Array> {
  const stream = pack();
  const chunks: Buffer[] = [];
  const collecting = (async () => { for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array)); })();
  await new Promise<void>((resolve, reject) => stream.entry({ name: "snapshot/", type: "directory", mtime: new Date(0) }, error => error ? reject(error) : resolve()));
  for (const [path, bytes] of Object.entries(sourceBytes)) {
    await new Promise<void>((resolve, reject) => stream.entry({ name: `snapshot/${path}`, size: bytes.byteLength, type: "file", mtime: new Date(0) }, Buffer.from(bytes), error => error ? reject(error) : resolve()));
  }
  stream.finalize();
  await collecting;
  return gzipSync(Buffer.concat(chunks));
}

async function fixture() {
  const sourceBytes = { [ccm.files[0].path]: exampleSource };
  const configuration = { z: 1, aa: 2 };
  const configHash = hash(JSON.stringify({ aa: 2, z: 1 }));
  const canonicalCcm = canonicalizeCcm(ccm, sourceBytes);
  assert.ok(canonicalCcm.ok);
  const canonicalCkg = canonicalizeCkg(canonicalCcm.value, sourceBytes, configHash);
  assert.ok(canonicalCkg.ok);
  const target: AnalysisStageTargetContext = {
    analysisId: claim.analysisId,
    repositoryId: "repo-document-stage",
    repositoryFullName: ccm.snapshot.repository,
    repositoryVisibility: "PUBLIC",
    branchName: ccm.snapshot.branch,
    commitSha: ccm.snapshot.commitSha,
    configurationHash: configHash,
    analyzerVersion: "document-stage-test",
    schemaVersion: "1",
  };
  const sourceFiles: Record<string, Uint8Array> = { ...sourceBytes };
  const archive = await tarArchive(sourceFiles);
  const storageRoot = await mkdtemp(join(tmpdir(), "sage-document-stage-"));
  const storageKey = "snapshot-a1B2c3/archive.tar.gz";
  await mkdir(join(storageRoot, "snapshot-a1B2c3"), { recursive: true });
  await writeFile(join(storageRoot, storageKey), archive);
  const storageRecord = {
    storageKey,
    sha256: hash(archive),
    byteLength: BigInt(archive.byteLength),
  };
  const queries: unknown[] = [];
  const fakeDb = {
    storageObject: {
      findFirst: async (query: unknown) => { queries.push(query); return storageRecord; },
    },
  } as unknown as PrismaClient;
  const handlers = createDocumentStageHandlers({ claim, storageRoot, db: fakeDb });
  const context: AnalysisStageContext = {
    target,
    configuration,
    previousStages: {
      COMMON_CODE_MODEL: asStageArtifact({ ccm: canonicalCcm.value, contentSha256: canonicalCcm.sha256 }),
      KNOWLEDGE_GRAPH: asStageArtifact({ graph: canonicalCkg.value, contentSha256: canonicalCkg.sha256, graphBundleId: "graph-bundle-document-stage" }),
    },
    sourceSnapshot: {
      storageObjectId: "snapshot-document-stage",
      archiveSha256: storageRecord.sha256,
      archiveBytes: archive.byteLength,
      commitSha: target.commitSha,
      files: Object.keys(sourceFiles).length,
      extractedBytes: Object.values(sourceFiles).reduce((total, bytes) => total + bytes.byteLength, 0),
    },
  };
  const projected = projectArchitectureDocument(canonicalCkg.json, sourceBytes, canonicalCkg.sha256);
  assert.ok(projected.ok);
  return { handlers, context, queries, projected, target, storageRoot, cleanup: () => rm(storageRoot, { recursive: true, force: true }) };
}

test("document stages re-read the owner-bound snapshot and emit one deterministic projection", async () => {
  const value = await fixture();
  try {
    const interfaceCatalog = asArtifactRecord(await value.handlers.INTERFACE_CATALOG(value.context, new AbortController().signal));
    const softwareDiagram = asArtifactRecord(await value.handlers.SOFTWARE_ENGINEERING_DIAGRAM({
      ...value.context,
      previousStages: { ...value.context.previousStages, INTERFACE_CATALOG: asStageArtifact(interfaceCatalog) },
    }, new AbortController().signal));
    const umlDiagram = asArtifactRecord(await value.handlers.UML_CLASS_DIAGRAM({
      ...value.context,
      previousStages: {
        ...value.context.previousStages,
        INTERFACE_CATALOG: asStageArtifact(interfaceCatalog),
        SOFTWARE_ENGINEERING_DIAGRAM: asStageArtifact(softwareDiagram),
      },
    }, new AbortController().signal));

    for (const [artifact, kind, part] of [
      [interfaceCatalog, "INTERFACE_CATALOG", "interfaceCatalog"],
      [softwareDiagram, "SOFTWARE_ENGINEERING_DIAGRAM", "softwareEngineeringDiagram"],
      [umlDiagram, "UML_CLASS_DIAGRAM", "umlClassDiagram"],
    ] as const) {
      assert.equal(artifact.kind, kind);
      assert.equal(artifact.ckgSha256, value.projected.value.ckgSha256);
      assert.equal(artifact.documentSha256, value.projected.sha256);
      assert.deepEqual(artifact.artifact, value.projected.value[part]);
      assert.deepEqual(artifact.context, {
        analysisId: value.target.analysisId,
        repositoryId: value.target.repositoryId,
        repositoryFullName: value.target.repositoryFullName,
        repositoryVisibility: value.target.repositoryVisibility,
        branchName: value.target.branchName,
        commitSha: value.target.commitSha,
        configurationHash: value.target.configurationHash,
        analyzerVersion: value.target.analyzerVersion,
        schemaVersion: value.target.schemaVersion,
      });
    }
    assert.equal(value.queries.length, 3, "each handler rereads the stored snapshot");
    for (const query of value.queries as Array<{ where: Record<string, unknown> }>) {
      assert.deepEqual(query.where, {
        id: "snapshot-document-stage",
        ownerUserId: claim.ownerUserId,
        analysisId: claim.analysisId,
        type: "SOURCE_ARCHIVE",
        status: "ACTIVE",
      });
    }
  } finally {
    await value.cleanup();
  }
});

test("document stages reject a tampered graph, queued target, or configuration", async () => {
  const value = await fixture();
  try {
    const badGraph: AnalysisStageContext = {
      ...value.context,
      previousStages: {
        ...value.context.previousStages,
        KNOWLEDGE_GRAPH: { ...(value.context.previousStages.KNOWLEDGE_GRAPH as Record<string, unknown>), contentSha256: "f".repeat(64) },
      },
    };
    await assert.rejects(value.handlers.INTERFACE_CATALOG(badGraph, new AbortController().signal), /Snapshot/);

    const graphRecord = asArtifactRecord(value.context.previousStages.KNOWLEDGE_GRAPH);
    const graph = JSON.parse(JSON.stringify(graphRecord.graph)) as { ccm: { nodes: Array<{ location: { endByte: number } | null }> } };
    assert.ok(graph.ccm.nodes[0]?.location);
    graph.ccm.nodes[0].location.endByte = Number.MAX_SAFE_INTEGER;
    const graphJson = JSON.stringify(graph);
    const badEvidence: AnalysisStageContext = {
      ...value.context,
      previousStages: {
        ...value.context.previousStages,
        KNOWLEDGE_GRAPH: asStageArtifact({ ...graphRecord, graph, contentSha256: hash(graphJson) }),
      },
    };
    await assert.rejects(value.handlers.INTERFACE_CATALOG(badEvidence, new AbortController().signal), /Snapshot/);

    const badTarget: AnalysisStageContext = { ...value.context, target: { ...value.target, commitSha: "b".repeat(40) } };
    await assert.rejects(value.handlers.INTERFACE_CATALOG(badTarget, new AbortController().signal), /Snapshot/);

    const badConfiguration: AnalysisStageContext = { ...value.context, configuration: { unexpected: true } };
    await assert.rejects(value.handlers.INTERFACE_CATALOG(badConfiguration, new AbortController().signal), /Snapshot/);
  } finally {
    await value.cleanup();
  }
});

test("later document stages reject missing or changed earlier artifacts before persistence", async () => {
  const value = await fixture();
  try {
    const interfaceCatalog = asArtifactRecord(await value.handlers.INTERFACE_CATALOG(value.context, new AbortController().signal));
    const missingInterface: AnalysisStageContext = {
      ...value.context,
      previousStages: { ...value.context.previousStages },
    };
    await assert.rejects(value.handlers.SOFTWARE_ENGINEERING_DIAGRAM(missingInterface, new AbortController().signal), /Snapshot/);

    const tamperedInterface = JSON.parse(JSON.stringify(interfaceCatalog)) as Record<string, unknown>;
    tamperedInterface.documentSha256 = "f".repeat(64);
    const changedEarlier: AnalysisStageContext = {
      ...value.context,
      previousStages: { ...value.context.previousStages, INTERFACE_CATALOG: asStageArtifact(tamperedInterface) },
    };
    await assert.rejects(value.handlers.SOFTWARE_ENGINEERING_DIAGRAM(changedEarlier, new AbortController().signal), /Snapshot/);

    const changedContextArtifact = JSON.parse(JSON.stringify(interfaceCatalog)) as Record<string, unknown>;
    (changedContextArtifact.context as Record<string, unknown>).configurationHash = "f".repeat(64);
    const changedContext: AnalysisStageContext = {
      ...value.context,
      previousStages: { ...value.context.previousStages, INTERFACE_CATALOG: asStageArtifact(changedContextArtifact) },
    };
    await assert.rejects(value.handlers.SOFTWARE_ENGINEERING_DIAGRAM(changedContext, new AbortController().signal), /Snapshot/);

    const changedProjection = JSON.parse(JSON.stringify(interfaceCatalog)) as Record<string, unknown>;
    (changedProjection.artifact as { entries: unknown[] }).entries.push({ injected: true });
    const changedArtifact: AnalysisStageContext = {
      ...value.context,
      previousStages: { ...value.context.previousStages, INTERFACE_CATALOG: asStageArtifact(changedProjection) },
    };
    await assert.rejects(value.handlers.SOFTWARE_ENGINEERING_DIAGRAM(changedArtifact, new AbortController().signal), /Snapshot/);

    const missingIntermediateDiagram: AnalysisStageContext = {
      ...value.context,
      previousStages: { ...value.context.previousStages, INTERFACE_CATALOG: asStageArtifact(interfaceCatalog) },
    };
    await assert.rejects(value.handlers.ARCHITECTURE_DOCUMENT(missingIntermediateDiagram, new AbortController().signal), /Snapshot/);
    assert.equal(value.queries.length, 6, "stage 9 fails validation before reaching persistence");
  } finally {
    await value.cleanup();
  }
});

test("document stages honor cancellation and reject snapshots owned by another analysis", async () => {
  const value = await fixture();
  try {
    const readsBefore = value.queries.length;
    await assert.rejects(value.handlers.INTERFACE_CATALOG(value.context, AbortSignal.abort()), { name: "AbortError" });
    assert.equal(value.queries.length, readsBefore);

    const wrongOwnerContext: AnalysisStageContext = {
      ...value.context,
      sourceSnapshot: { ...(value.context.sourceSnapshot as Record<string, unknown>), commitSha: "b".repeat(40) },
    };
    await assert.rejects(value.handlers.INTERFACE_CATALOG(wrongOwnerContext, new AbortController().signal), /Snapshot/);
  } finally {
    await value.cleanup();
  }
});
