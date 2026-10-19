import test from "node:test";
import assert from "node:assert/strict";
import { createTargetHandlers, type TargetHandlerDependencies } from "../apps/web/lib/github/target-handlers.ts";

function fixture() {
  const calls: string[] = [];
  const deps: TargetHandlerDependencies = {
    env: { AUTH_BASE_URL: "http://localhost:3000" },
    readSession: async () => ({ userId: "owner", accessToken: "server-only-test-token" }),
    createClient: () => ({
      listBranches: async () => { calls.push("branches"); return { items: [{ name: "main", commitSha: "a".repeat(40) }], nextPage: null }; },
      resolveTarget: async () => { calls.push("target"); return { repository: { id: "1", owner: "x", name: "y", fullName: "x/y", private: false, defaultBranch: "main", archived: false, installationId: null }, branch: "main", commitSha: "a".repeat(40), branchHeadSha: "a".repeat(40) }; },
    }),
  };
  return { deps, calls };
}
function post(body: string, origin = "http://localhost:3000") {
  return new Request("http://localhost:3000/api/repositories/target", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body });
}
test("target handlers only call provider after session and safe payload validation", async () => {
  const { deps, calls } = fixture(); const handlers = createTargetHandlers(deps);
  const response = await handlers.target(post('{"repository":"x/y","branch":"main"}'));
  assert.equal(response.status, 200); assert.ok(!(await response.text()).includes("server-only"));
  deps.readSession = async () => null;
  assert.equal((await handlers.target(post('{"repository":"x/y","branch":"main"}'))).status, 401);
  assert.deepEqual(calls, ["target"]);
});
test("target handlers reject forged ownership, bad JSON, CSRF and oversized input before provider", async () => {
  const { deps, calls } = fixture(); const handlers = createTargetHandlers(deps);
  assert.equal((await handlers.target(post('{}', "https://attacker.invalid"))).status, 403);
  for (const body of ['{}', 'null', '[]', '{', '{"repository":"x/y","branch":"main","userId":"foreign"}', '{"repository":"x/y","branch":1}', '{"repository":"x/y","branch":"main","commit":5}', 'a'.repeat(2049)]) assert.equal((await handlers.target(post(body))).status, 400);
  assert.deepEqual(calls, []);
});
test("branch handler rejects invalid pagination/duplicate parameters and uses no-store", async () => {
  const { deps, calls } = fixture(); const handlers = createTargetHandlers(deps);
  for (const query of ['repository=x/y&page=0', 'repository=x/y&page=101', 'repository=x/y&repository=other/repo', 'repository=x/y&token=unsafe', 'page=1']) assert.equal((await handlers.branches(new Request(`http://localhost/api/repositories/branches?${query}`))).status, 400);
  assert.deepEqual(calls, []);
  const response = await handlers.branches(new Request('http://localhost/api/repositories/branches?repository=x/y'));
  assert.equal(response.status, 200); assert.match(response.headers.get('cache-control')!, /no-store/);
});
