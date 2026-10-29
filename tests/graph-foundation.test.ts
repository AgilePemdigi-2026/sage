import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { NODE_KINDS, validateCcm } from "@sage/contracts";
import { createGraphFixture, validateGraphFixture } from "./fixtures/ui/graph";
import { projectCcmForGraph } from "../apps/web/components/graph-foundation/graph-projection";

test("graph fixture validates against the exact source bytes it describes", () => {
  const fixture = createGraphFixture();
  const sourceHashes = Object.fromEntries(Object.entries(fixture.sourceBytes).map(([path, bytes]) => [
    path,
    createHash("sha256").update(bytes).digest("hex"),
  ]));
  const result = validateGraphFixture(fixture);

  assert.equal(result.ok, true);
  assert.deepEqual(new Set(fixture.payload.nodes.map((node) => node.kind)), new Set(NODE_KINDS));
  assert.deepEqual(Object.fromEntries(result.ok ? result.value.files.map((file) => [file.path, file.sha256]) : []), sourceHashes);
  assert.equal(result.ok ? result.value.edges.some((edge) => edge.kind === "CALLS" && edge.resolution === "Exact") : false, true);
  assert.equal(result.ok ? result.value.edges.some((edge) => edge.kind === "CALLS" && edge.resolution === "Unresolved" && result.value.nodes.find((node) => node.id === edge.targetId)?.origin === "unresolved") : false, true);
  const reportClass = fixture.payload.nodes.find(node => node.name === "ReportService")!;
  const declaration = reportClass.location!;
  assert.equal(new TextDecoder().decode(fixture.sourceBytes[declaration.filePath].subarray(declaration.startByte, declaration.endByte)), [
    "export class ReportService implements ReportInput {", '  readonly label = "report";',
    "  build(input: string): string {", "    return formatLabel(input);", "  }", "}",
  ].join("\n"));
  for (const edge of fixture.payload.edges.filter(edge => edge.kind === "CONTAINS")) {
    const child = fixture.payload.nodes.find(node => node.id === edge.targetId)!;
    assert.equal(child.parentId, edge.sourceId);
    assert.deepEqual(edge.evidence, [child.location]);
  }
});

test("graph projection preserves source facts and exposes category and resolution labels", () => {
  const fixture = createGraphFixture();
  const originalPayload = structuredClone(fixture.payload);
  const originalSourceHashes = Object.fromEntries(Object.entries(fixture.sourceBytes).map(([path, bytes]) => [
    path,
    createHash("sha256").update(bytes).digest("hex"),
  ]));
  const validation = validateCcm(fixture.payload, fixture.sourceBytes);
  assert.equal(validation.ok, true);
  if (!validation.ok) return;

  const view = projectCcmForGraph(validation.value);
  assert.deepEqual(fixture.payload, originalPayload);
  assert.deepEqual(Object.fromEntries(Object.entries(fixture.sourceBytes).map(([path, bytes]) => [path, createHash("sha256").update(bytes).digest("hex")])), originalSourceHashes);
  assert.ok(view.nodes.some((node) => node.category === "Berkas"));
  assert.ok(view.nodes.some((node) => node.category === "Struktur"));
  assert.ok(view.nodes.some((node) => node.category === "Simbol"));
  assert.ok(view.nodes.some((node) => node.category === "Belum terpecahkan"));
  assert.ok(view.edges.every((edge) => edge.label.includes(edge.resolution)));
  assert.ok(view.edges.some((edge) => edge.resolution === "Exact"));
  assert.ok(view.edges.some((edge) => edge.resolution === "Unresolved"));
});

test("invalid source bytes fail validation so the preview can show its error state", () => {
  const fixture = createGraphFixture();
  const tampered = { ...fixture.sourceBytes, "src/report.ts": Uint8Array.from(fixture.sourceBytes["src/report.ts"]) };
  tampered["src/report.ts"][0] ^= 1;
  const result = validateCcm(fixture.payload, tampered);

  assert.deepEqual(result, { ok: false, errorCode: "CCM_FILE_HASH_MISMATCH" });
});
