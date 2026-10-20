import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { request } from "playwright";
import { createSession, database } from "@sage/database";

if (!process.env.SAGE_TEST_LOGIN) throw new Error("Set SAGE_TEST_LOGIN for an already-authorized test account; never supply tokens in arguments.");
const baseURL = process.env.SAGE_HTTP_BASE_URL ?? "http://web:3000";
const origin = process.env.AUTH_BASE_URL ?? "http://localhost:3000";
const output = resolve(process.env.PROVIDER_UI_EVIDENCE_DIR ?? resolve(process.env.STORAGE_ROOT ?? "artifacts", "browser-provider"));
const db = database();
let sessionId: string | undefined;
const client = await request.newContext({ baseURL });
const checks: string[] = [];
let phase = "setup";
let failed = false;
try {
  const user = await db.user.findFirst({ where: { login: process.env.SAGE_TEST_LOGIN }, select: { id: true } });
  assert.ok(user, "Already-authorized account required");
  const session = await createSession(db, user.id, { ttlMs: 180_000 });
  sessionId = session.session.sessionId;
  const headers = { Cookie: `sage_session=${session.token}`, Origin: origin };
  const before = await db.analysis.count({ where: { ownerUserId: user.id } });
  phase = "installation access";
  assert.equal((await client.get("/api/github/installations")).status(), 401);
  const installations = await client.get("/api/github/installations", { headers });
  assert.equal(installations.status(), 200);
  const items = (await installations.json()).data.items as Array<{ id: string }>;
  if (items.length) {
    const response = await client.get(`/api/github/installations/${encodeURIComponent(items[0].id)}/repositories`, { headers });
    assert.equal(response.status(), 200);
    assert.ok(Array.isArray((await response.json()).data.items));
  }
  checks.push(items.length
    ? "Playwright request: real installation and authorized repository metadata; anonymous request rejected"
    : "Playwright request: real installation list is empty; anonymous request rejected; installation repository metadata NOT_RUN");
  phase = "public repository validation";
  const publicRepository = "octocat/Hello-World";
  const publicResponse = await client.post("/api/repositories/resolve", { headers, data: { repository: publicRepository } });
  assert.equal(publicResponse.status(), 200);
  assert.equal((await publicResponse.json()).data.private, false);
  const badOrigin = await client.post("/api/repositories/resolve", { headers: { ...headers, Origin: "https://attacker.invalid" }, data: { repository: publicRepository } });
  assert.equal(badOrigin.status(), 403);
  const invalid = await client.post("/api/repositories/resolve", { headers, data: { repository: "https://127.0.0.1/private" } });
  assert.equal(invalid.status(), 400);
  checks.push("Playwright request: third-party public repository resolves; cross-origin and non-GitHub input rejected");
  for (const repository of [publicRepository, ...(process.env.SAGE_TEST_PRIVATE_REPOSITORY ? [process.env.SAGE_TEST_PRIVATE_REPOSITORY] : [])]) {
    phase = repository === publicRepository ? "public target" : "authorized private target";
    const resolution = await client.post("/api/repositories/resolve", { headers, data: { repository } });
    assert.equal(resolution.status(), 200);
    if (repository !== publicRepository) {
      assert.equal((await resolution.json()).data.private, true);
      const denied = await client.post("/api/repositories/resolve", { headers: { Origin: origin }, data: { repository } });
      assert.equal(denied.status(), 401);
    }
    const branches = await client.get(`/api/repositories/branches?repository=${encodeURIComponent(repository)}`, { headers });
    assert.equal(branches.status(), 200);
    const branch = (await branches.json()).data.items[0]?.name;
    assert.ok(branch);
    const target = await client.post("/api/repositories/target", { headers, data: { repository, branch, commit: null } });
    assert.equal(target.status(), 200);
    const data = (await target.json()).data;
    assert.match(data.commitSha, /^[a-f0-9]{40}$/);
    assert.equal(data.commitSha, data.branchHeadSha);
    const explicit = await client.post("/api/repositories/target", { headers, data: { repository, branch, commit: data.commitSha.slice(0, 12) } });
    assert.equal(explicit.status(), 200);
    assert.equal((await explicit.json()).data.commitSha, data.commitSha);
    const badCommit = await client.post("/api/repositories/target", { headers, data: { repository, branch, commit: "bad input" } });
    assert.equal(badCommit.status(), 400);
    checks.push(`Playwright request: ${repository === publicRepository ? "public" : "authorized private"} real branches, HEAD and prefix resolve full SHA; invalid commit rejected`);
  }
  assert.equal(await db.analysis.count({ where: { ownerUserId: user.id } }), before);
  checks.push("Read/validation probes do not create analysis jobs");
} catch {
  failed = true;
  console.error(`Provider Playwright check failed during ${phase}; credentials and provider payload omitted.`);
} finally {
  if (sessionId) await db.session.deleteMany({ where: { id: sessionId } });
  await client.dispose();
  await db.$disconnect();
  await mkdir(output, { recursive: true });
  const report = { checkedAt: new Date().toISOString(), status: failed ? "FAIL" : "PASS", checks, failedPhase: failed ? phase : null, privateFixtureRequested: !!process.env.SAGE_TEST_PRIVATE_REPOSITORY, scope: "Playwright APIRequestContext against real Next routes and GitHub provider, temporary session for existing authorization; not a fresh OAuth browser login.", limitations: ["Private denial for another authenticated user is a controlled boundary test, not exercised as live GitHub here.", "No submission/pipeline/results acceptance."] };
  await writeFile(resolve(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report));
}
if (failed) process.exitCode = 1;
