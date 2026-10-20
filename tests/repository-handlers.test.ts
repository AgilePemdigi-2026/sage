import test from "node:test";
import assert from "node:assert/strict";
import { createRepositoryHandlers, type RepositoryHandlerDependencies } from "../apps/web/lib/github/handlers.ts";

function fixture() {
  const calls: string[] = [];
  const sessions = new Map<string, { userId: string; githubUserId: string; githubLogin: string; accessToken: string }>([
    ["session-one", { userId: "user-one", githubUserId: "101", githubLogin: "iltizamhasan3", accessToken: "token-one" }],
    ["session-two", { userId: "user-two", githubUserId: "202", githubLogin: "rizqy-fadhil", accessToken: "token-two" }],
  ]);
  const deps: RepositoryHandlerDependencies = {
    env: { AUTH_BASE_URL: "http://localhost:3000" },
    readSession: async request => {
      const token = /(?:^|;\s*)sage_session=([^;]+)/.exec(request.headers.get("cookie") ?? "")?.[1];
      return token ? sessions.get(token) ?? null : sessions.get("session-one")!;
    },
    createClient: token => {
      const session = [...sessions.values()].find(value => value.accessToken === token);
      assert.ok(session);
      return {
        listInstallations: async () => { calls.push("list"); return { items: [], nextPage: null }; },
        listInstallationRepositories: async () => { calls.push(`repositories:${session.githubLogin}`); return { items: [], nextPage: null }; },
        listPublicRepositories: async login => {
          calls.push(`public:${session.githubLogin}:${login}`);
          return { items: [{ id: session.githubUserId, owner: login, name: "public", fullName: `${login}/public`, private: false, defaultBranch: "main", archived: false, installationId: null }], nextPage: null };
        },
        resolveRepository: async () => { calls.push("resolve"); return { id: "1", owner: "test", name: "public", fullName: "test/public", private: false, defaultBranch: "main", archived: false, installationId: null }; },
      };
    },
  };
  return { deps, calls, sessions };
}
const listRequest = () => new Request("http://localhost:3000/api/github/installations", { headers: { Cookie: "sage_session=session-one" } });
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

test("public listing and session identity are isolated between two concurrent GitHub accounts", async () => {
  const { deps, calls } = fixture();
  const handlers = createRepositoryHandlers(deps);
  const requestFor = (session: string, account: string, path: string) => new Request(`http://localhost:3000${path}`, {
    headers: { Cookie: `sage_session=${session}`, "X-SAGE-Account": account },
  });
  const [iltizamPublic, rizqyPublic, iltizamContext, rizqyContext] = await Promise.all([
    handlers.publicRepositories(requestFor("session-one", "101", "/api/repositories/public?page=1")),
    handlers.publicRepositories(requestFor("session-two", "202", "/api/repositories/public?page=1")),
    handlers.session(requestFor("session-one", "101", "/api/auth/session")),
    handlers.session(requestFor("session-two", "202", "/api/auth/session")),
  ]);
  const iltizamBody = await iltizamPublic.json();
  const rizqyBody = await rizqyPublic.json();
  assert.deepEqual(iltizamBody.data.items.map((repo: { fullName: string }) => repo.fullName), ["iltizamhasan3/public"]);
  assert.deepEqual(rizqyBody.data.items.map((repo: { fullName: string }) => repo.fullName), ["rizqy-fadhil/public"]);
  assert.deepEqual((await iltizamContext.json()).data, { accountKey: "101", login: "iltizamhasan3" });
  assert.deepEqual((await rizqyContext.json()).data, { accountKey: "202", login: "rizqy-fadhil" });
  assert.ok(!JSON.stringify(iltizamBody).includes("token-one"));
  assert.ok(!JSON.stringify(rizqyBody).includes("token-two"));
  assert.deepEqual(calls, [
    "public:iltizamhasan3:iltizamhasan3",
    "public:rizqy-fadhil:rizqy-fadhil",
  ]);
});

test("stale account scope is rejected before provider requests", async () => {
  const { deps, calls } = fixture();
  const handlers = createRepositoryHandlers(deps);
  const stale = new Request("http://localhost:3000/api/repositories/public", {
    headers: { Cookie: "sage_session=session-two", "X-SAGE-Account": "101" },
  });
  assert.equal((await handlers.publicRepositories(stale)).status, 401);
  const staleContext = new Request("http://localhost:3000/api/auth/session", {
    headers: { Cookie: "sage_session=session-two", "X-SAGE-Account": "101" },
  });
  assert.equal((await handlers.session(staleContext)).status, 401);
  assert.deepEqual(calls, []);
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
