import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

type Evidence = { startByte: number; endByte: number; startLine: number; endLine: number; startColumn: number; endColumn: number };
type FixtureFile = { path: string; sha256: string; sizeBytes: number; language: string | null; syntaxValid: boolean | null };
type Oracle = { path: string; kind: string; target: string; snippet: string; evidence: Evidence };
export type FixtureManifest = { schemaVersion: number; reviewStatus: string; files: FixtureFile[]; oracles: Oracle[] };

export const fixtureRoot = new URL("../tests/fixtures/", import.meta.url);

export async function verifyFixtures() {
  const manifest = JSON.parse(await readFile(new URL("manifest.json", fixtureRoot), "utf8")) as FixtureManifest;
  const contents = new Map<string, Buffer>();
  for (const item of manifest.files) {
    if (item.path.split("/").some((part) => part === ".." || part === "") || item.path.startsWith("/")) throw new Error("FIXTURE_PATH_INVALID");
    const data = await readFile(new URL(item.path, fixtureRoot));
    if (data.length !== item.sizeBytes || createHash("sha256").update(data).digest("hex") !== item.sha256) throw new Error(`FIXTURE_HASH_MISMATCH: ${item.path}`);
    contents.set(item.path, data);
  }
  for (const oracle of manifest.oracles) {
    const data = contents.get(oracle.path);
    if (!data) throw new Error("ORACLE_FILE_UNKNOWN");
    const e = oracle.evidence;
    if (e.startByte < 0 || e.endByte > data.length || e.startByte >= e.endByte) throw new Error("ORACLE_BOUNDS_INVALID");
    if (data.subarray(e.startByte, e.endByte).toString("utf8") !== oracle.snippet) throw new Error("ORACLE_SNIPPET_MISMATCH");
    for (const [byte, line, column] of [[e.startByte, e.startLine, e.startColumn], [e.endByte, e.endLine, e.endColumn]]) {
      const prefix = data.subarray(0, byte).toString("utf8");
      const lines = prefix.split("\n");
      if (lines.length !== line || Array.from(lines.at(-1)!).length + 1 !== column) throw new Error("ORACLE_POSITION_MISMATCH");
    }
  }
  return manifest;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const manifest = await verifyFixtures();
  console.log(JSON.stringify({ files: manifest.files.length, oracles: manifest.oracles.length, integrity: "PASS", semanticAcceptance: "NOT_RUN", reviewStatus: manifest.reviewStatus }));
}
