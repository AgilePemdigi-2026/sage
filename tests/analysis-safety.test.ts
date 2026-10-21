import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { analyzeReferences as analyzeJs } from "@sage/analyzer-js";
import { analyzeReferences as analyzePhp } from "@sage/analyzer-php";
import { resolverOracleRoot, verifyResolverOracles, type ResolverLanguage } from "../scripts/verify-resolver-oracles.ts";

const snapshot = { repository: "fixture/resolver-oracles", branch: "test", commitSha: "e".repeat(40) };

async function markerExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

test("JS/TS and PHP analysis parse dangerous canaries without executing source", async () => {
  const manifest = await verifyResolverOracles();
  const collect = async (language: ResolverLanguage) => Object.fromEntries(await Promise.all(
    manifest.files.filter((file) => file.language === language).map(async (file) =>
      [file.path, new Uint8Array(await readFile(new URL(file.path, resolverOracleRoot)))] as const),
  ));
  const markerDir = await mkdtemp(join(tmpdir(), "sage-resolver-no-execution-"));
  const markerPath = join(markerDir, "source-executed.marker");
  const originalValue = process.env.SAGE_RESOLVER_CANARY_PATH;
  try {
    process.env.SAGE_RESOLVER_CANARY_PATH = markerPath;
    assert.equal(await markerExists(markerPath), false);

    const jsSources = await collect("javascript");
    const tsSources = await collect("typescript");
    const jsResult = analyzeJs({ snapshot, sources: { ...jsSources, ...tsSources } });
    assert.ok(jsResult.ccm, jsResult.errorCode ?? "JS/TS analyzer returned no CCM");
    assert.equal(jsResult.errorCode, null);
    for (const language of ["javascript", "typescript"] as const) {
      const unsafePath = `tests/fixtures/resolver/${language}/src/unsafe.${language === "typescript" ? "ts" : "js"}`;
      assert.equal(jsResult.ccm.files.find((file) => file.path === unsafePath)?.status, "processed", `${unsafePath} must actually be parsed`);
    }
    assert.equal(await markerExists(markerPath), false, "JS/TS analysis must not call writeFileSync from source");

    const phpSources = await collect("php");
    const phpResult = await analyzePhp({ snapshot, sources: phpSources });
    assert.ok(phpResult.ccm, phpResult.errorCode ?? "PHP analyzer returned no CCM");
    assert.equal(phpResult.errorCode, null);
    assert.equal(phpResult.ccm.files.find((file) => file.path === "tests/fixtures/resolver/php/src/unsafe.php")?.status, "processed");
    assert.equal(await markerExists(markerPath), false, "PHP analysis must not call file_put_contents from source");

    for (const [path, bytes] of Object.entries({ ...jsSources, ...tsSources, ...phpSources })) {
      const file = manifest.files.find((item) => item.path === path)!;
      if (file.canary) assert.ok(new TextDecoder().decode(bytes).includes(file.canary), `${path} contains its parse-only canary`);
    }
  } finally {
    if (originalValue === undefined) delete process.env.SAGE_RESOLVER_CANARY_PATH;
    else process.env.SAGE_RESOLVER_CANARY_PATH = originalValue;
    await rm(markerDir, { recursive: true, force: true });
  }
});
