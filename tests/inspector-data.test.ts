import assert from "node:assert/strict";
import test from "node:test";
import type { CcmSnapshot, EvidenceSpan } from "@sage/contracts";
import {
  parseNodeInspectorPayload,
  parseSourcePayload,
  sourceRangeForEvidence,
} from "../apps/web/components/live-graph/inspector-data.ts";

const snapshot: CcmSnapshot = { repository: "owner/repo", branch: "main", commitSha: "c".repeat(40) };
const expected = {
  analysisId: "analysis-1",
  accountKey: "account-1",
  ckgSha256: "a".repeat(64),
  configurationHash: "b".repeat(64),
  snapshot,
};
const evidence: EvidenceSpan = {
  filePath: "src/main.ts",
  fileSha256: "d".repeat(64),
  startByte: 5,
  endByte: 12,
  startLine: 4,
  endLine: 5,
  startColumn: 2,
  endColumn: 6,
  role: "reference",
};
const node = {
  id: "node-target",
  kind: "Function",
  name: "target",
  qualifiedName: "module.target",
  language: "typescript",
  filePath: "src/main.ts",
  location: evidence,
  parentId: "module-main",
  origin: "source",
  signature: null,
};
const peer = {
  ...node,
  id: "node-peer",
  name: "caller",
  qualifiedName: "module.caller",
  location: null,
};
const file = { id: `file-${"e".repeat(64)}`, path: evidence.filePath, sha256: evidence.fileSha256, sizeBytes: 128 };
const payload = {
  ...expected,
  node,
  incoming: [{
    edge: { id: "edge-in", sourceId: peer.id, targetId: node.id, kind: "CALLS", resolution: "Unresolved", evidence: [evidence], unresolvedReason: "UNKNOWN_RECEIVER" },
    peer,
  }],
  outgoing: [{
    edge: { id: "edge-out", sourceId: node.id, targetId: peer.id, kind: "CALLS", resolution: "Exact", evidence: [evidence], unresolvedReason: null },
    peer,
  }],
  files: [file],
};

test("parses canonical direct relations and retains unresolved incoming edges", () => {
  const result = parseNodeInspectorPayload(payload, { ...expected, nodeId: node.id });
  assert.equal(result.incoming[0].edge.resolution, "Unresolved");
  assert.equal(result.incoming[0].edge.unresolvedReason, "UNKNOWN_RECEIVER");
  assert.equal(result.outgoing[0].peer.id, peer.id);
});

test("rejects node detail from another account, snapshot, or relation direction", () => {
  assert.throws(() => parseNodeInspectorPayload({ ...payload, accountKey: "other-account" }, { ...expected, nodeId: node.id }));
  assert.throws(() => parseNodeInspectorPayload({ ...payload, snapshot: { ...snapshot, branch: "other" } }, { ...expected, nodeId: node.id }));
  assert.throws(() => parseNodeInspectorPayload({
    ...payload,
    incoming: [{ ...payload.incoming[0], edge: { ...payload.incoming[0].edge, targetId: peer.id } }],
  }, { ...expected, nodeId: node.id }));
});

test("validates the source response against its opaque file ID and requested bounds", () => {
  const sourcePayload = {
    ...expected,
    file,
    startLine: 1,
    endLine: 7,
    totalLines: 9,
    text: "one\r\ntwo\r\nthree\r\nfour\r\nfive\r\nsix\r\nseven",
  };
  assert.equal(parseSourcePayload(sourcePayload, { ...expected, file, startLine: 1, endLine: 8 }).endLine, 7);
  assert.throws(() => parseSourcePayload({ ...sourcePayload, file: { ...file, id: "another-file" } }, { ...expected, file, startLine: 1, endLine: 8 }));
  assert.throws(() => parseSourcePayload({ ...sourcePayload, ckgSha256: "f".repeat(64) }, { ...expected, file, startLine: 1, endLine: 8 }));
});

test("bounds source windows to 200 lines around the AST evidence", () => {
  assert.deepEqual(sourceRangeForEvidence({ startLine: 1, endLine: 1 }), { startLine: 1, endLine: 4 });
  assert.deepEqual(sourceRangeForEvidence({ startLine: 100, endLine: 500 }), { startLine: 100, endLine: 299 });
  assert.deepEqual(sourceRangeForEvidence({ startLine: 10, endLine: 12 }, 3), { startLine: 10, endLine: 12 });
});
