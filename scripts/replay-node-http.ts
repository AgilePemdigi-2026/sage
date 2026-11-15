import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { buildSemanticModel, semanticModelHash } from "../packages/documents/src/semantic/build.ts";
import { canonicalSemanticContent } from "../packages/database/src/semantic.ts";

// Offline replay: private source stays outside the report and Git history.
const [snapshotArgument, ckgArgument, outputArgument] = process.argv.slice(2);
assert.ok(snapshotArgument && ckgArgument && outputArgument,
  "Usage: tsx scripts/replay-node-http.ts <snapshot-directory> <canonical-ckg.json> <report.json>");
const root = resolve(snapshotArgument);
const sources: Record<string, Uint8Array> = {};
async function collect(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await collect(path);
    else if (entry.isFile()) sources[relative(root, path).replaceAll("\\", "/")] = await readFile(path);
  }
}
await collect(root);
const json = (await readFile(ckgArgument, "utf8")).trimEnd();
const ckg = JSON.parse(json);
const sourceCkgHash = createHash("sha256").update(json).digest("hex");
const model = buildSemanticModel({ ccm: ckg.ccm, sources, sourceCkgHash });
canonicalSemanticContent(model, sourceCkgHash,
  new Set(ckg.ccm.nodes.map((node: { id: string }) => node.id)),
  new Map(ckg.ccm.files.map((file: { path: string; sha256: string }) => [file.path, file.sha256])),
  ckg.ccm.snapshot);
assert.ok(model.frameworks.includes("Node.js HTTP API"), "Snapshot must produce supported Node HTTP facts");
assert.ok(model.features.length > 0 && model.edges.length > 0, "Replay must produce connected feature facts");
const report = {
  schemaVersion: 1,
  extractorVersion: model.extractorVersion,
  sourceCkgHash,
  modelHash: semanticModelHash(model),
  features: model.features.length,
  nodes: model.nodes.length,
  edges: model.edges.length,
  limitations: model.limitations.length,
  canonicalEvidenceValidation: "PASS",
  scope: "Offline source replay with canonical hash/span validation; does not prove runtime reachability or OAuth/worker integration",
};
await writeFile(outputArgument, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx", mode: 0o600 });
console.log(JSON.stringify(report));
