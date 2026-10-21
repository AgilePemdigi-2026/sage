import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import tar from "tar-stream";
import { canonicalizeCkg } from "@sage/contracts";
import { loadGraphForUser } from "../apps/web/lib/graphs/reader.ts";
import type { GraphReadDatabase } from "../apps/web/lib/graphs/reader.ts";
import { projectCcmForGraph } from "../apps/web/components/graph-foundation/graph-projection.ts";

const analysisId = "analysis-graph-17";
const ownerUserId = "owner-graph-17";
const configurationHash = "c".repeat(64);
const ccmUrl = new URL("../packages/contracts/examples/minimum-ccm.json", import.meta.url);
const sourceUrl = new URL("../packages/contracts/examples/minimum-ccm.source.ts", import.meta.url);

async function makeArchive(relativePath: string, source: Uint8Array): Promise<Buffer> {
  const pack = tar.pack();
  const chunks: Buffer[] = [];
  const complete = new Promise<Buffer>((resolve, reject) => {
    pack.on("data", chunk => chunks.push(Buffer.from(chunk as Uint8Array)));
    pack.on("end", () => resolve(gzipSync(Buffer.concat(chunks))));
    pack.on("error", reject);
  });
  pack.entry({ name: `repository-root/${relativePath}`, size: source.byteLength }, Buffer.from(source));
  pack.finalize();
  return complete;
}

async function publishedFixture(options: { corruptMirror?: boolean; missingBundle?: boolean; missingArchive?: boolean } = {}) {
  const [ccmText, sourceText] = await Promise.all([readFile(ccmUrl, "utf8"), readFile(sourceUrl)]);
  const ccm = JSON.parse(ccmText) as unknown;
  const sourceBytes = { "examples/minimum-ccm.source.ts": new Uint8Array(sourceText) };
  const canonical = canonicalizeCkg(ccm, sourceBytes, configurationHash);
  assert.equal(canonical.ok, true);
  if (!canonical.ok) throw new Error("Canonical fixture must validate");

  const archive = await makeArchive("examples/minimum-ccm.source.ts", sourceText);
  const storageRoot = await mkdtemp(join(tmpdir(), "sage-graph-reader-"));
  const storageKey = "snapshot-ABC123/archive.tar.gz";
  await mkdir(join(storageRoot, "snapshot-ABC123"));
  await writeFile(join(storageRoot, storageKey), archive);
  const storageObject = {
    id: "snapshot-object-17",
    storageKey,
    sha256: createHash("sha256").update(archive).digest("hex"),
    byteLength: BigInt(archive.byteLength),
  };
  const graphBundle = {
    id: "graph-bundle-17",
    schemaVersion: canonical.value.schemaVersion,
    configurationHash,
    canonicalContent: canonical.json,
    nodes: options.corruptMirror ? [] : JSON.stringify(canonical.value.ccm.nodes),
    edges: JSON.stringify(canonical.value.ccm.edges),
    nodeCount: canonical.value.counts.nodes,
    edgeCount: canonical.value.counts.edges,
    contentHash: canonical.sha256,
  };
  const analysisRecord = {
    status: "COMPLETED",
    configurationHash,
    repositoryFullNameSnapshot: canonical.value.ccm.snapshot.repository,
    branchName: canonical.value.ccm.snapshot.branch,
    commitSha: canonical.value.ccm.snapshot.commitSha,
    graphBundle: options.missingBundle ? null : graphBundle,
  };
  const calls: Array<{ delegate: string; args: unknown }> = [];
  const db = {
    analysis: {
      findFirst: async (args: unknown) => {
        calls.push({ delegate: "analysis", args });
        if ((args as { select?: Record<string, unknown> }).select?.graphBundle) return analysisRecord;
        return { status: "COMPLETED" };
      },
    },
    storageObject: {
      findFirst: async (args: unknown) => {
        calls.push({ delegate: "storageObject", args });
        if ((args as { where?: Record<string, unknown> }).where?.id) return storageObject;
        if (options.missingArchive) return null;
        return { id: storageObject.id };
      },
    },
  } as unknown as GraphReadDatabase;
  return { db, storageRoot, calls, canonical, storageObject };
}

test("graph reader rejects missing, foreign, running and failed analyses before snapshot storage access", async () => {
  for (const status of [null, "RUNNING", "FAILED"] as const) {
    let storageLookups = 0;
    const db = {
      analysis: { findFirst: async () => status === null ? null : { status } },
      storageObject: { findFirst: async () => { storageLookups += 1; throw new Error("must not query storage"); } },
    } as unknown as GraphReadDatabase;
    const result = await loadGraphForUser(db, ownerUserId, analysisId, "/path/that/must/not/be/read");
    assert.deepEqual(result, { kind: status === null ? "not-found" : "not-ready" });
    assert.equal(storageLookups, 0);
  }
});

test("graph reader chooses the latest owner-bound active source archive and validates canonical content", async () => {
  const fixture = await publishedFixture();
  try {
    const result = await loadGraphForUser(fixture.db, ownerUserId, analysisId, fixture.storageRoot);
    assert.equal(result.kind, "ready");
    if (result.kind !== "ready") return;
    assert.deepEqual(result.value, {
      analysisId,
      ckgSha256: fixture.canonical.sha256,
      configurationHash,
      snapshot: fixture.canonical.value.ccm.snapshot,
      provenance: fixture.canonical.value.ccm.provenance,
      canonicalCounts: fixture.canonical.value.counts,
      filteredCounts: { nodes: fixture.canonical.value.counts.nodes, edges: fixture.canonical.value.counts.edges },
      returnedCounts: { nodes: fixture.canonical.value.counts.nodes, edges: fixture.canonical.value.counts.edges },
      paginated: false,
      limitations: fixture.canonical.value.ccm.limitations,
      graph: projectCcmForGraph(fixture.canonical.value.ccm),
    });

    const preflight = fixture.calls[0];
    assert.equal(preflight.delegate, "analysis");
    assert.deepEqual(preflight.args, { where: { id: analysisId, ownerUserId }, select: { status: true } });
    const archiveLookup = fixture.calls[1];
    assert.equal(archiveLookup.delegate, "storageObject");
    assert.deepEqual(archiveLookup.args, {
      where: { ownerUserId, analysisId, type: "SOURCE_ARCHIVE", status: "ACTIVE" },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { id: true },
    });
    const storageRead = fixture.calls[2];
    assert.equal(storageRead.delegate, "storageObject");
    assert.deepEqual((storageRead.args as { where: unknown }).where, {
      id: fixture.storageObject.id,
      ownerUserId,
      analysisId,
      type: "SOURCE_ARCHIVE",
      status: "ACTIVE",
    });
  } finally {
    await rm(fixture.storageRoot, { recursive: true, force: true });
  }
});

test("graph reader treats missing terminal artifacts as unavailable and rejects tampered mirrors", async () => {
  const missingArchive = await publishedFixture({ missingArchive: true });
  try {
    await assert.rejects(loadGraphForUser(missingArchive.db, ownerUserId, analysisId, missingArchive.storageRoot), {
      name: "GraphReadUnavailableError",
      message: "Published graph result is unavailable.",
    });
  } finally {
    await rm(missingArchive.storageRoot, { recursive: true, force: true });
  }

  const missing = await publishedFixture({ missingBundle: true });
  try {
    await assert.rejects(loadGraphForUser(missing.db, ownerUserId, analysisId, missing.storageRoot), {
      name: "GraphReadUnavailableError",
      message: "Published graph result is unavailable.",
    });
  } finally {
    await rm(missing.storageRoot, { recursive: true, force: true });
  }

  const tampered = await publishedFixture({ corruptMirror: true });
  try {
    await assert.rejects(loadGraphForUser(tampered.db, ownerUserId, analysisId, tampered.storageRoot), /Graph bundle/);
  } finally {
    await rm(tampered.storageRoot, { recursive: true, force: true });
  }
});
