import assert from "node:assert/strict";
import test from "node:test";
import { normalizeRepository, validateTarget } from "../apps/web/components/ui-foundation/target-validation.ts";
import { progressFixture, stageDefinitions } from "../apps/web/app/ui-preview/fixture-data.ts";

test("repository syntax: normalize slug/HTTPS without silently accepting another host or path", () => {
  for (const value of ["contoh/repository", "  contoh/repository  ", "https://github.com/contoh/repository", "https://github.com/contoh/repository/", "https://github.com/contoh/repository.git"]) assert.equal(normalizeRepository(value), "contoh/repository", value);
  for (const value of ["", "owner", "owner/repo/tree/main", "owner/..", "owner/.", "-owner/repo", "owner-/repo", "o--wner/repo", "https://github.com/owner/repo/../other", "https://github.com/owner/%2Frepo", "https://evil.test/owner/repo", "http://github.com/owner/repo", "https://github.com.evil.test/owner/repo", "https://user:pass@github.com/owner/repo", "https://github.com:443/owner/repo", "https://github.com/owner/repo?token=example", "https://github.com/owner/repo#readme", "javascript:alert(1)", "<script>/repo", "file:///owner/repo", "a".repeat(40) + "/repo", "owner/" + "a".repeat(101)]) assert.equal(normalizeRepository(value), null, value);
});
test("target syntax: optional commit, normalized whitespace, branch membership and SHA boundaries", () => {
  assert.deepEqual(validateTarget({ repository: " contoh/repo ", branch: " main ", commit: " " }, ["main"]), { valid: true, target: { repository: "contoh/repo", branch: "main", commit: null } });
  for (const commit of ["AbCd123", "a".repeat(40)]) assert.equal(validateTarget({ repository: "contoh/repo", branch: "main", commit }, ["main"]).valid, true);
  for (const commit of ["invalid", "a".repeat(6), "a".repeat(41), "<script>"]) {
    const result = validateTarget({ repository: "contoh/repo", branch: "main", commit }, ["main"]);
    assert.equal(result.valid, false); if (!result.valid) assert.ok(result.errors.commit);
  }
  const missing = validateTarget({ repository: "", branch: "main", commit: null }, []);
  assert.equal(missing.valid, false); if (!missing.valid) assert.deepEqual(Object.keys(missing.errors).sort(), ["branch", "repository"]);
  assert.equal(validateTarget({ repository: "contoh/repo", branch: "other", commit: null }, ["main"]).valid, false);
});
test("progress fixtures: exactly nine stages, sequential failure, no percent or fabricated ETA", () => {
  assert.equal(stageDefinitions.length, 9);
  for (const status of ["QUEUED", "RUNNING", "FAILED", "COMPLETED", "COMPLETED_WITH_LIMITATIONS"] as const) {
    const value = progressFixture(status);
    assert.equal(value.stages.length, 9); assert.equal(new Set(value.stages.map(stage => stage.key)).size, 9);
    assert.match(value.fullSha, /^[a-f\d]{40}$/);
    assert.equal("percentage" in value, false); assert.equal("eta" in value, false);
    if (status === "QUEUED") assert.ok(value.stages.every(stage => stage.status === "PENDING"));
    if (status === "FAILED") { assert.equal(value.stages[2].status, "FAILED"); assert.ok(value.stages.slice(3).every(stage => stage.status === "PENDING")); }
    if (status.startsWith("COMPLETED")) assert.ok(value.stages.every(stage => stage.status === "COMPLETED"));
  }
  const old = progressFixture("FAILED"), retry = progressFixture("RUNNING", true);
  assert.notEqual(old.analysisId, retry.analysisId); assert.equal(old.fullSha, retry.fullSha);
  assert.ok(progressFixture("COMPLETED_WITH_LIMITATIONS").limitations.length);
});
