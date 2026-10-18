import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { fixtureRoot, verifyFixtures } from "../scripts/verify-fixtures.ts";

test("manifest fixture dan evidence Unicode/CRLF cocok dengan source asli", async () => {
  const manifest = await verifyFixtures();
  assert.ok(manifest.files.some((file) => file.language === "php"));
  assert.ok(manifest.files.some((file) => file.language === "javascript"));
  assert.ok(manifest.files.some((file) => file.language === "typescript"));
  const source = await readFile(new URL("source-bounds/a/same.ts", fixtureRoot), "utf8");
  assert.ok(source.includes("\r\n"));
  assert.ok(source.includes("😀"));
  assert.equal(manifest.reviewStatus, "DRAFT_AWAITING_TEAM_REVIEW");
});
