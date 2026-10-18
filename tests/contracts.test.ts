import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  EDGE_KINDS,
  LANGUAGES,
  NODE_KINDS,
  NODE_ORIGINS,
  UNRESOLVED_REASONS,
  canonicalizeCcm,
  createEdgeId,
  createNodeId,
  validateCcm,
  type CcmEdge,
  type CcmNode,
  type CcmV1,
  type EvidenceRole,
} from "../packages/contracts/src/index.ts";

const snapshotSha = "a".repeat(40);
const configHash = "b".repeat(64);
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function sha256(source: Uint8Array): string {
  return createHash("sha256").update(source).digest("hex");
}

function positionAt(source: Uint8Array, byte: number): { line: number; column: number } {
  const lines = decoder.decode(source.subarray(0, byte)).split("\n");
  return { line: lines.length, column: Array.from(lines.at(-1) ?? "").length + 1 };
}

function makeSpan(source: Uint8Array, marker: string, role: EvidenceRole) {
  const markerBytes = encoder.encode(marker);
  const startByte = Buffer.from(source).indexOf(Buffer.from(markerBytes));
  assert.notEqual(startByte, -1, `missing marker ${marker}`);
  const endByte = startByte + markerBytes.byteLength;
  return {
    filePath: "tests/fixtures/source-bounds/a/same.ts",
    fileSha256: sha256(source),
    startByte,
    endByte,
    startLine: positionAt(source, startByte).line,
    startColumn: positionAt(source, startByte).column,
    endLine: positionAt(source, endByte).line,
    endColumn: positionAt(source, endByte).column,
    role,
  };
}

async function validFixture(): Promise<{ model: CcmV1; sourceBytes: Record<string, Uint8Array> }> {
  const fixturePath = "tests/fixtures/source-bounds/a/same.ts";
  const fixtureBytes = await readFile(new URL("./fixtures/source-bounds/a/same.ts", import.meta.url));
  const fixture = new Uint8Array(fixtureBytes);
  const dynamicPath = "src/unresolved.ts";
  const dynamicSource = encoder.encode("export function use(value: unknown) { return value.run(); }\n");
  const sourceBytes = { [fixturePath]: fixture, [dynamicPath]: dynamicSource };
  const fileRecords = [
    { path: fixturePath, language: "typescript" as const, sha256: sha256(fixture), sizeBytes: fixture.byteLength, status: "processed" as const },
    { path: dynamicPath, language: "typescript" as const, sha256: sha256(dynamicSource), sizeBytes: dynamicSource.byteLength, status: "processed" as const },
  ];
  const moduleLocation = makeSpan(fixture, decoder.decode(fixture), "declaration");
  const functionLocation = makeSpan(fixture, "function café() { return \"é\"; }", "declaration");
  const useLocation = (() => {
    const marker = "export function use(value: unknown) { return value.run(); }";
    const startByte = Buffer.from(dynamicSource).indexOf(Buffer.from(marker));
    const endByte = startByte + Buffer.byteLength(marker);
    const start = positionAt(dynamicSource, startByte);
    const end = positionAt(dynamicSource, endByte);
    return {
      filePath: dynamicPath,
      fileSha256: sha256(dynamicSource),
      startByte,
      endByte,
      startLine: start.line,
      startColumn: start.column,
      endLine: end.line,
      endColumn: end.column,
      role: "declaration" as const,
    };
  })();
  const referenceLocation = (() => {
    const marker = "value.run()";
    const startByte = Buffer.from(dynamicSource).indexOf(Buffer.from(marker));
    const endByte = startByte + Buffer.byteLength(marker);
    const start = positionAt(dynamicSource, startByte);
    const end = positionAt(dynamicSource, endByte);
    return {
      filePath: dynamicPath,
      fileSha256: sha256(dynamicSource),
      startByte,
      endByte,
      startLine: start.line,
      startColumn: start.column,
      endLine: end.line,
      endColumn: end.column,
      role: "reference" as const,
    };
  })();

  const moduleNode: CcmNode = {
    id: createNodeId({ snapshotSha, language: "typescript", filePath: fixturePath, kind: "Module", qualifiedName: fixturePath,
      startByte: moduleLocation.startByte, endByte: moduleLocation.endByte }),
    kind: "Module", name: "same.ts", qualifiedName: fixturePath, language: "typescript", filePath: fixturePath,
    location: moduleLocation, parentId: null, origin: "source", signature: null, attributes: {},
  };
  const functionNode: CcmNode = {
    id: createNodeId({ snapshotSha, language: "typescript", filePath: fixturePath, kind: "Function", qualifiedName: "café",
      startByte: functionLocation.startByte, endByte: functionLocation.endByte }),
    kind: "Function", name: "café", qualifiedName: "café", language: "typescript", filePath: fixturePath,
    location: functionLocation, parentId: moduleNode.id, origin: "source", signature: "café(): string", attributes: { exported: true },
  };
  const useNode: CcmNode = {
    id: createNodeId({ snapshotSha, language: "typescript", filePath: dynamicPath, kind: "Function", qualifiedName: "use",
      startByte: useLocation.startByte, endByte: useLocation.endByte }),
    kind: "Function", name: "use", qualifiedName: "use", language: "typescript", filePath: dynamicPath,
    location: useLocation, parentId: null, origin: "source", signature: "use(value: unknown): unknown", attributes: {},
  };
  const unresolvedNode: CcmNode = {
    id: createNodeId({ snapshotSha, language: "typescript", filePath: null, kind: "UnresolvedReference", qualifiedName: "value.run",
      startByte: null, endByte: null }),
    kind: "UnresolvedReference", name: "run", qualifiedName: "value.run", language: "typescript", filePath: null,
    location: null, parentId: null, origin: "unresolved", signature: null, attributes: { observedExpression: "value.run()" },
  };
  const containsEdge: CcmEdge = {
    id: "", sourceId: moduleNode.id, targetId: functionNode.id, kind: "CONTAINS", resolution: "Exact",
    evidence: [functionLocation], unresolvedReason: null,
  };
  containsEdge.id = createEdgeId({ snapshotSha, ...containsEdge });
  const unresolvedEdge: CcmEdge = {
    id: "", sourceId: useNode.id, targetId: unresolvedNode.id, kind: "CALLS", resolution: "Unresolved",
    evidence: [referenceLocation], unresolvedReason: "UNKNOWN_RECEIVER",
  };
  unresolvedEdge.id = createEdgeId({ snapshotSha, ...unresolvedEdge });

  return {
    model: {
      schemaVersion: 1,
      snapshot: { repository: "AgilePemdigi-2026/sage", branch: "feat/32-ccm-contract", commitSha: snapshotSha },
      provenance: {
        analyzer: { name: "sage-contracts", version: "0.1.0" },
        resolver: { name: "sage-static-resolver", version: "0.1.0" },
        configHash,
      },
      files: fileRecords,
      nodes: [moduleNode, functionNode, useNode, unresolvedNode],
      edges: [containsEdge, unresolvedEdge],
      limitations: [{ path: dynamicPath, reason: "Dynamic receiver type has no exact source target.", stage: "resolution" }],
    },
    sourceBytes,
  };
}

function assertRejected(result: ReturnType<typeof validateCcm>, errorCode: string): void {
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.errorCode, errorCode);
}

test("registries expose the schema v1 kinds, relations, languages, origins and reasons", () => {
  assert.deepEqual(NODE_KINDS, ["Module", "Class", "Interface", "Function", "Method", "Property", "UnresolvedReference"]);
  assert.deepEqual(EDGE_KINDS, ["CONTAINS", "IMPORTS", "EXPORTS", "EXTENDS", "IMPLEMENTS", "TYPE_REFERENCES", "CALLS", "INSTANTIATES", "READS", "WRITES", "THROWS", "INCLUDES"]);
  assert.deepEqual(LANGUAGES, ["javascript", "typescript", "php"]);
  assert.deepEqual(NODE_ORIGINS, ["source", "stdlib", "external", "unresolved"]);
  assert.deepEqual(UNRESOLVED_REASONS, ["DYNAMIC_LOAD", "UNKNOWN_RECEIVER", "EXTERNAL_DEPENDENCY", "UNSUPPORTED_CONSTRUCT", "AMBIGUOUS_SYMBOL"]);
});

test("valid CCM verifies source hashes, placeholder evidence and Unicode/CRLF positions", async () => {
  const { model, sourceBytes } = await validFixture();
  const result = validateCcm(model, sourceBytes);
  assert.equal(result.ok, true);
  if (result.ok) {
    const span = result.value.nodes.find((node) => node.name === "café")!.location!;
    assert.equal(span.startLine, 2);
    assert.equal(span.startColumn, 8);
    assert.equal(decoder.decode(sourceBytes[span.filePath]!.slice(span.startByte, span.endByte)), "function café() { return \"é\"; }");
  }
});

test("validator rejects duplicate identifiers, dangling parent/edge and invalid registries", async () => {
  const { model, sourceBytes } = await validFixture();
  const duplicate = structuredClone(model);
  duplicate.nodes.push(structuredClone(duplicate.nodes[0]!));
  assertRejected(validateCcm(duplicate, sourceBytes), "CCM_NODE_ID_DUPLICATE");

  const danglingParent = structuredClone(model);
  danglingParent.nodes.find((node) => node.name === "café")!.parentId = "node_missing";
  assertRejected(validateCcm(danglingParent, sourceBytes), "CCM_NODE_PARENT_DANGLING");

  const parentCycle = structuredClone(model);
  parentCycle.nodes[0]!.parentId = parentCycle.nodes[1]!.id;
  assertRejected(validateCcm(parentCycle, sourceBytes), "CCM_NODE_PARENT_CYCLE");

  const unsafePath = structuredClone(model);
  unsafePath.files[0]!.path = "../escape.ts";
  assertRejected(validateCcm(unsafePath, sourceBytes), "CCM_FILE_PATH_INVALID");

  const danglingEdge = structuredClone(model);
  danglingEdge.edges[0]!.targetId = "node_missing";
  assertRejected(validateCcm(danglingEdge, sourceBytes), "CCM_EDGE_ENDPOINT_DANGLING");

  const badNodeKind = structuredClone(model);
  (badNodeKind.nodes[1] as unknown as { kind: string }).kind = "Enum";
  assertRejected(validateCcm(badNodeKind, sourceBytes), "CCM_NODE_REGISTRY_INVALID");
});

test("validator rejects bad resolution, unresolved reason, evidence and source hash", async () => {
  const { model, sourceBytes } = await validFixture();
  const badResolution = structuredClone(model);
  (badResolution.edges[1] as unknown as { resolution: string }).resolution = "Inferred";
  assertRejected(validateCcm(badResolution, sourceBytes), "CCM_EDGE_RESOLUTION_INVALID");

  const badReason = structuredClone(model);
  (badReason.edges[1] as unknown as { unresolvedReason: string }).unresolvedReason = "DYNAMIC";
  assertRejected(validateCcm(badReason, sourceBytes), "CCM_EDGE_UNRESOLVED_REASON_INVALID");

  const badEvidence = structuredClone(model);
  badEvidence.edges[1]!.evidence[0]!.startColumn += 1;
  assertRejected(validateCcm(badEvidence, sourceBytes), "CCM_EVIDENCE_POSITION_INVALID");

  const wrongBytes = { ...sourceBytes, ["src/unresolved.ts"]: encoder.encode("tampered\n") };
  assertRejected(validateCcm(model, wrongBytes), "CCM_FILE_SIZE_MISMATCH");

  const wrongHash = structuredClone(model);
  wrongHash.files[0]!.sha256 = "0".repeat(64);
  assertRejected(validateCcm(wrongHash, sourceBytes), "CCM_FILE_HASH_MISMATCH");
});

test("canonical serialization and content hash are stable under array and object reordering", async () => {
  const { model, sourceBytes } = await validFixture();
  model.nodes.find((node) => node.name === "café")!.attributes = { z: "last", a: { y: 2, x: 1 } };
  const original = canonicalizeCcm(model, sourceBytes);
  assert.equal(original.ok, true);
  const reordered = structuredClone(model);
  reordered.files.reverse();
  reordered.nodes.reverse();
  reordered.edges.reverse();
  reordered.limitations.reverse();
  reordered.nodes.find((node) => node.name === "café")!.attributes = { a: { x: 1, y: 2 }, z: "last" };
  const again = canonicalizeCcm(reordered, sourceBytes);
  assert.equal(again.ok, true);
  if (original.ok && again.ok) {
    assert.equal(again.json, original.json);
    assert.equal(again.sha256, original.sha256);
  }
});

test("strict schema excludes envelope metadata and non-enumerable fields", async () => {
  const { model, sourceBytes } = await validFixture();
  const withJob = { ...model, jobId: "transient" };
  assertRejected(validateCcm(withJob, sourceBytes), "CCM_UNKNOWN_FIELD");

  const hiddenSnapshotField = structuredClone(model);
  Object.defineProperty(hiddenSnapshotField.snapshot, "repository", { value: "example/hidden", enumerable: false });
  assertRejected(validateCcm(hiddenSnapshotField, sourceBytes), "CCM_INPUT_INVALID");

  const hiddenAttribute = structuredClone(model);
  const attributes = hiddenAttribute.nodes.find((node) => node.name === "café")!.attributes;
  Object.defineProperty(attributes, "hidden", { value: "metadata", enumerable: false });
  assertRejected(validateCcm(hiddenAttribute, sourceBytes), "CCM_NODE_INVALID");
  assertRejected(canonicalizeCcm(hiddenAttribute, sourceBytes), "CCM_NODE_INVALID");
});

test("checked-in example payload validates against its separate source file", async () => {
  const payload = JSON.parse(await readFile(new URL("../packages/contracts/examples/minimum-ccm.json", import.meta.url), "utf8")) as unknown;
  const source = new Uint8Array(await readFile(new URL("../packages/contracts/examples/minimum-ccm.source.ts", import.meta.url)));
  const result = validateCcm(payload, { "examples/minimum-ccm.source.ts": source });
  assert.equal(result.ok, true);
});
