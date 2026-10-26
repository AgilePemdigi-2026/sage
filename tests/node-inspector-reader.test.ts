import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import tar from "tar-stream";
import { createEdgeId, createNodeId } from "@sage/contracts";
import { canonicalizeCkg } from "@sage/contracts";
import { loadNodeInspectorForUser, loadSourceForUser } from "../apps/web/lib/graphs/reader.ts";
import { SOURCE_PREVIEW_MAX_BYTES } from "../apps/web/lib/graphs/inspector-types.ts";
import type { GraphReadDatabase } from "../apps/web/lib/graphs/reader.ts";

const analysisId = "analysis-node-19";
const ownerUserId = "owner-node-19";
const configurationHash = "c".repeat(64);
const sourcePath = "src/api.ts";
const sourceText = "\uFEFFexport class Café { call() { return helper(); } }\r\nexport function helper() { return \"naïve\"; }\r\n";
const sourceBytes = Buffer.from(sourceText, "utf8");
const sourceHash = createHash("sha256").update(sourceBytes).digest("hex");

function positionAt(source: string, utf16Offset: number) {
  const before = source.slice(0, utf16Offset);
  const lines = before.split("\n");
  return {
    line: lines.length,
    column: Array.from(lines.at(-1) ?? "").length + 1,
    byte: Buffer.byteLength(before, "utf8"),
  };
}

function makeCkg(source = sourceText) {
  const bytes = Buffer.from(source, "utf8");
  const hash = createHash("sha256").update(bytes).digest("hex");
  const evidence = (start: number, end: number, role: "declaration" | "reference") => {
    const at = positionAt(source, start);
    const through = positionAt(source, end);
    return {
      filePath: sourcePath,
      fileSha256: hash,
      startByte: at.byte,
      endByte: through.byte,
      startLine: at.line,
      endLine: through.line,
      startColumn: at.column,
      endColumn: through.column,
      role,
    };
  };
  const classStart = source.indexOf("export class Café");
  const classEnd = source.indexOf("\r\n");
  const helperStart = source.indexOf("export function helper");
  const helperEnd = source.indexOf("\r\n", helperStart);
  const callStart = source.indexOf("helper()");
  const callEvidence = evidence(callStart, callStart + "helper()".length, "reference");
  const classLocation = evidence(classStart, classEnd, "declaration");
  const helperLocation = evidence(helperStart, helperEnd, "declaration");
  const snapshot = { repository: "example/node-inspector", branch: "main", commitSha: "a".repeat(40) };
  const classNode = {
    id: createNodeId({ snapshotSha: snapshot.commitSha, language: "typescript", filePath: sourcePath, kind: "Class", qualifiedName: "Café", startByte: classLocation.startByte, endByte: classLocation.endByte }),
    kind: "Class",
    name: "Café",
    qualifiedName: "Café",
    language: "typescript",
    filePath: sourcePath,
    location: classLocation,
    parentId: null,
    origin: "source",
    signature: null,
    attributes: { privateAnalyzerNote: "should not cross the wire" },
  };
  const helperNode = {
    id: createNodeId({ snapshotSha: snapshot.commitSha, language: "typescript", filePath: sourcePath, kind: "Function", qualifiedName: "helper", startByte: helperLocation.startByte, endByte: helperLocation.endByte }),
    kind: "Function",
    name: "helper",
    qualifiedName: "helper",
    language: "typescript",
    filePath: sourcePath,
    location: helperLocation,
    parentId: null,
    origin: "source",
    signature: "helper(): string",
    attributes: {},
  };
  const edge = {
    id: "",
    sourceId: classNode.id,
    targetId: helperNode.id,
    kind: "CALLS" as const,
    resolution: "Exact" as const,
    evidence: [callEvidence],
    unresolvedReason: null,
  };
  const ccm = {
    schemaVersion: 1,
    snapshot,
    provenance: {
      analyzer: { name: "test", version: "1" },
      resolver: { name: "test", version: "1" },
      configHash: "b".repeat(64),
    },
    files: [
      { path: sourcePath, language: "typescript", sha256: hash, sizeBytes: bytes.byteLength, status: "processed" },
      { path: "src/unreferenced.ts", language: "typescript", sha256: createHash("sha256").update("export {};", "utf8").digest("hex"), sizeBytes: Buffer.byteLength("export {};"), status: "processed" },
      { path: "config/settings.json", language: null, sha256: createHash("sha256").update("{}", "utf8").digest("hex"), sizeBytes: 2, status: "excluded" },
    ],
    nodes: [classNode, helperNode],
    edges: [edge],
    limitations: [],
  };
  ccm.edges[0]!.id = createEdgeId({
    snapshotSha: snapshot.commitSha,
    sourceId: ccm.edges[0]!.sourceId,
    targetId: ccm.edges[0]!.targetId,
    kind: edge.kind,
    resolution: edge.resolution,
    evidence: edge.evidence,
    unresolvedReason: edge.unresolvedReason,
  });
  const sources = {
    [sourcePath]: new Uint8Array(bytes),
    "src/unreferenced.ts": new TextEncoder().encode("export {};"),
    "config/settings.json": new TextEncoder().encode("{}"),
  };
  const result = canonicalizeCkg(ccm, sources, configurationHash);
  if (!result.ok) throw new Error("Invalid test CKG");
  return { result, sources, sourceBytes: bytes, sourceHash: hash };
}

async function makeArchive(sources: Readonly<Record<string, Uint8Array>>): Promise<Buffer> {
  const pack = tar.pack();
  const chunks: Buffer[] = [];
  const completed = new Promise<Buffer>((resolve, reject) => {
    pack.on("data", chunk => chunks.push(Buffer.from(chunk as Uint8Array)));
    pack.on("end", () => resolve(gzipSync(Buffer.concat(chunks))));
    pack.on("error", reject);
  });
  for (const [path, bytes] of Object.entries(sources)) {
    await new Promise<void>((resolve, reject) => {
      pack.entry({ name: `repository-root/${path}`, size: bytes.byteLength }, Buffer.from(bytes), error => error ? reject(error) : resolve());
    });
  }
  pack.finalize();
  return completed;
}

async function fixture(source = sourceText, options: { corruptStoredArchive?: boolean; archiveSourceMismatch?: boolean } = {}) {
  const { result, sources, sourceBytes: bytes, sourceHash: hash } = makeCkg(source);
  const archiveSources = { ...sources };
  if (options.archiveSourceMismatch) {
    const corruptedSource = Buffer.from(archiveSources[sourcePath]!);
    const offset = corruptedSource.indexOf(Buffer.from("Café", "utf8"));
    corruptedSource[offset] = "B".charCodeAt(0);
    archiveSources[sourcePath] = new Uint8Array(corruptedSource);
  }
  const archive = await makeArchive(archiveSources);
  const storageRoot = await mkdtemp(join(tmpdir(), "sage-node-inspector-"));
  const storageKey = "snapshot-ABC123/archive.tar.gz";
  await mkdir(join(storageRoot, "snapshot-ABC123"));
  await writeFile(join(storageRoot, storageKey), archive);
  if (options.corruptStoredArchive) {
    const corrupt = Buffer.from(archive);
    corrupt[corrupt.length - 1] ^= 1;
    await writeFile(join(storageRoot, storageKey), corrupt);
  }
  const storageObject = {
    id: "snapshot-object-19",
    storageKey,
    sha256: createHash("sha256").update(archive).digest("hex"),
    byteLength: BigInt(archive.byteLength),
  };
  const graphBundle = {
    id: "graph-bundle-19",
    schemaVersion: result.value.schemaVersion,
    configurationHash,
    canonicalContent: result.json,
    nodes: JSON.stringify(result.value.ccm.nodes),
    edges: JSON.stringify(result.value.ccm.edges),
    nodeCount: result.value.counts.nodes,
    edgeCount: result.value.counts.edges,
    contentHash: result.sha256,
  };
  const analysisRecord = {
    status: "COMPLETED",
    configurationHash,
    repositoryFullNameSnapshot: result.value.ccm.snapshot.repository,
    branchName: result.value.ccm.snapshot.branch,
    commitSha: result.value.ccm.snapshot.commitSha,
    graphBundle,
  };
  const db = {
    analysis: {
      findFirst: async (args: unknown) => (args as { select?: Record<string, unknown> }).select?.graphBundle
        ? analysisRecord
        : { status: "COMPLETED" },
    },
    storageObject: {
      findFirst: async (args: unknown) => (args as { where?: Record<string, unknown> }).where?.id
        ? storageObject
        : { id: storageObject.id },
    },
  } as unknown as GraphReadDatabase;
  return { db, storageRoot, result, sources, sourceBytes: bytes, sourceHash: hash };
}

function opaqueFileId(path = sourcePath, hash = sourceHash) {
  return `file-${createHash("sha256").update(`${path}\0${hash}`, "utf8").digest("hex")}`;
}

test("node inspector returns exact canonical node bounds, direct edges, peers, and only referenced processed files", async () => {
  const testFixture = await fixture();
  try {
    const classNode = testFixture.result.value.ccm.nodes.find(node => node.kind === "Class")!;
    const helperNode = testFixture.result.value.ccm.nodes.find(node => node.kind === "Function")!;
    const edge = testFixture.result.value.ccm.edges[0]!;
    const result = await loadNodeInspectorForUser(testFixture.db, ownerUserId, analysisId, classNode.id, testFixture.storageRoot);
    assert.equal(result.kind, "ready");
    if (result.kind !== "ready") return;
    assert.deepEqual(result.value.node.location, classNode.location);
    assert.equal(result.value.node.id, classNode.id);
    assert.equal("attributes" in result.value.node, false);
    assert.deepEqual(result.value.outgoing, [{
      edge,
      peer: {
        id: helperNode.id,
        kind: helperNode.kind,
        name: helperNode.name,
        qualifiedName: helperNode.qualifiedName,
        language: helperNode.language,
        filePath: helperNode.filePath,
        location: helperNode.location,
        parentId: helperNode.parentId,
        origin: helperNode.origin,
        signature: helperNode.signature,
      },
    }]);
    assert.deepEqual(result.value.incoming, []);
    assert.deepEqual(result.value.files, [{
      id: opaqueFileId(),
      path: sourcePath,
      sha256: sourceHash,
      sizeBytes: sourceBytes.byteLength,
    }]);
    assert.equal(JSON.stringify(result.value).includes("privateAnalyzerNote"), false);
    assert.equal(JSON.stringify(result.value).includes(sourceText), false, "node payload never contains source bytes");

    const helperDetail = await loadNodeInspectorForUser(testFixture.db, ownerUserId, analysisId, helperNode.id, testFixture.storageRoot);
    assert.equal(helperDetail.kind, "ready");
    if (helperDetail.kind === "ready") {
      assert.deepEqual(helperDetail.value.incoming.map(relation => relation.peer.id), [classNode.id]);
      assert.deepEqual(helperDetail.value.outgoing, []);
    }

    const unknownNode = await loadNodeInspectorForUser(testFixture.db, ownerUserId, analysisId, `node_${"f".repeat(64)}`, testFixture.storageRoot);
    assert.deepEqual(unknownNode, { kind: "item-not-found" });
  } finally {
    await rm(testFixture.storageRoot, { recursive: true, force: true });
  }
});

test("source reader verifies and returns bounded original UTF-8 lines with BOM and CRLF intact", async () => {
  const testFixture = await fixture();
  try {
    const result = await loadSourceForUser(testFixture.db, ownerUserId, analysisId, opaqueFileId(), 1, 2, testFixture.storageRoot);
    assert.equal(result.kind, "ready");
    if (result.kind !== "ready") return;
    assert.deepEqual(result.value.file, { id: opaqueFileId(), path: sourcePath, sha256: sourceHash, sizeBytes: sourceBytes.byteLength });
    assert.equal(result.value.startLine, 1);
    assert.equal(result.value.endLine, 2);
    assert.equal(result.value.totalLines, 3);
    assert.equal(result.value.text, sourceText.split("\n").slice(0, 2).join("\n") + "\n");
    assert.ok(result.value.text.startsWith("\uFEFF"));
    assert.ok(result.value.text.includes("Café"));
    assert.ok(result.value.text.endsWith("\r\n"));

    const finalLine = await loadSourceForUser(testFixture.db, ownerUserId, analysisId, opaqueFileId(), 3, 200, testFixture.storageRoot);
    assert.equal(finalLine.kind, "ready");
    if (finalLine.kind === "ready") {
      assert.equal(finalLine.value.endLine, 3, "the requested end is clamped to the real final line");
      assert.equal(finalLine.value.text, "");
    }

    const unknownFile = await loadSourceForUser(testFixture.db, ownerUserId, analysisId, `file-${"f".repeat(64)}`, 1, 2, testFixture.storageRoot);
    assert.deepEqual(unknownFile, { kind: "item-not-found" });

    const unreferencedHash = createHash("sha256").update("export {};", "utf8").digest("hex");
    const unreferenced = await loadSourceForUser(testFixture.db, ownerUserId, analysisId, opaqueFileId("src/unreferenced.ts", unreferencedHash), 1, 2, testFixture.storageRoot);
    assert.deepEqual(unreferenced, { kind: "item-not-found" }, "unreferenced processed source is not previewable");

    const excludedHash = createHash("sha256").update("{}", "utf8").digest("hex");
    const excluded = await loadSourceForUser(testFixture.db, ownerUserId, analysisId, opaqueFileId("config/settings.json", excludedHash), 1, 2, testFixture.storageRoot);
    assert.deepEqual(excluded, { kind: "item-not-found" }, "excluded config source is not previewable");
  } finally {
    await rm(testFixture.storageRoot, { recursive: true, force: true });
  }
});

test("source preview rejects a real line that exceeds the bounded text size", async () => {
  const paddedSource = `\uFEFFexport class Café { ${randomBytes(SOURCE_PREVIEW_MAX_BYTES).toString("base64")} call() { return helper(); } }\r\nexport function helper() { return \"naïve\"; }\r\n`;
  const testFixture = await fixture(paddedSource);
  try {
    const result = await loadSourceForUser(
      testFixture.db,
      ownerUserId,
      analysisId,
      opaqueFileId(sourcePath, testFixture.sourceHash),
      1,
      1,
      testFixture.storageRoot,
    );
    assert.deepEqual(result, { kind: "range-too-large" });
  } finally {
    await rm(testFixture.storageRoot, { recursive: true, force: true });
  }
});

test("node and source readers reject foreign or nonterminal analyses before archive access", async () => {
  for (const status of [null, "RUNNING", "FAILED"] as const) {
    let storageReads = 0;
    const db = {
      analysis: { findFirst: async () => status === null ? null : { status } },
      storageObject: { findFirst: async () => { storageReads += 1; throw new Error("storage must not be read"); } },
    } as unknown as GraphReadDatabase;
    const expected = status === null ? "not-found" : "not-ready";
    const node = await loadNodeInspectorForUser(db, ownerUserId, analysisId, nodeIdForTest, "/must-not-be-read");
    const source = await loadSourceForUser(db, ownerUserId, analysisId, opaqueFileId(), 1, 1, "/must-not-be-read");
    assert.deepEqual(node, { kind: expected });
    assert.deepEqual(source, { kind: expected });
    assert.equal(storageReads, 0);
  }
});

const nodeIdForTest = `node_${"a".repeat(64)}`;

test("source reader rejects a corrupted stored archive before returning any source", async () => {
  const testFixture = await fixture(sourceText, { corruptStoredArchive: true });
  try {
    await assert.rejects(loadSourceForUser(testFixture.db, ownerUserId, analysisId, opaqueFileId(), 1, 2, testFixture.storageRoot));
  } finally {
    await rm(testFixture.storageRoot, { recursive: true, force: true });
  }
});

test("source reader rejects archive bytes that no longer match the canonical file hash", async () => {
  const testFixture = await fixture(sourceText, { archiveSourceMismatch: true });
  try {
    await assert.rejects(loadSourceForUser(testFixture.db, ownerUserId, analysisId, opaqueFileId(), 1, 2, testFixture.storageRoot));
  } finally {
    await rm(testFixture.storageRoot, { recursive: true, force: true });
  }
});
