import test from "node:test";
import assert from "node:assert/strict";
import { createRepositoryHandlers, type RepositoryHandlerDependencies } from "../apps/web/lib/github/handlers.ts";

function fixture() {
  const calls: string[] = [];
  const deps: RepositoryHandlerDependencies = {
    env: { AUTH_BASE_URL: "http://localhost:3000" },
    readSession: async () => ({ userId: "trusted-owner", accessToken: "test-server-token" }),
    createClient: token => {
      assert.equal(token, "test-server-token");
      return {
        listInstallations: async () => { calls.push("list"); return { items: [], nextPage: null }; },
        listInstallationRepositories: async () => { calls.push("repositories"); return { items: [], nextPage: null }; },
        resolveRepository: async () => { calls.push("resolve"); return { id: "1", owner: "test", name: "public", fullName: "test/public", private: false, defaultBranch: "main", archived: false, installationId: null }; },
      };
    },
  };
  return { deps, calls };
}
const listRequest = () => new Request("http://localhost:3000/api/github/installations");
function post(body = JSON.stringify({ repository: "test/public" }), origin = "http://localhost:3000") {
  return new Request("http://localhost:3000/api/repositories/resolve", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body });
}

test("repository routes require trusted session before provider requests and never return credential", async () => {
  const { deps, calls } = fixture();
  const handlers = createRepositoryHandlers(deps);
  const okay = await handlers.installations(listRequest());
  assert.equal(okay.status, 200); assert.match(okay.headers.get("cache-control")!, /no-store/);
  assert.ok(!(await okay.text()).includes("test-server-token"));
  deps.readSession = async () => null;
  assert.equal((await handlers.installations(listRequest())).status, 401);
  assert.equal((await handlers.resolve(post())).status, 401);
  assert.deepEqual(calls, ["list"]);
});

test("repository mutations reject cross-origin, malformed and oversized bodies without provider calls", async () => {
  const { deps, calls } = fixture(); const handlers = createRepositoryHandlers(deps);
  assert.equal((await handlers.resolve(post(undefined, "https://attacker.invalid"))).status, 403);
  for (const body of ["{", "[]", "null", '{"repository":1}', '{"repository":"x/y","userId":"other"}', "x".repeat(1025)]) {
    assert.equal((await handlers.resolve(post(body))).status, 400);
  }
  assert.deepEqual(calls, []);
});

test("repository pagination and installation IDs reject invalid values before provider requests", async () => {
  const { deps, calls } = fixture(); const handlers = createRepositoryHandlers(deps);
  for (const query of ["page=0", "page=-1", "page=101", "page=1&page=2", "ownerUserId=other", "page=1.5"]) {
    assert.equal((await handlers.installations(new Request(`http://localhost/api/github/installations?${query}`))).status, 400);
  }
  assert.equal((await handlers.installationRepositories(listRequest(), "../bad")).status, 400);
  assert.deepEqual(calls, []);
});

test("unexpected session/storage errors return safe response without internal details", async () => {
  const { deps } = fixture(); deps.readSession = async () => { throw new Error("secret-token /private/server/path"); };
  const response = await createRepositoryHandlers(deps).installations(listRequest());
  assert.equal(response.status, 503);
  const body = await response.text(); assert.ok(!body.includes("secret-token") && !body.includes("/private/"));
});
