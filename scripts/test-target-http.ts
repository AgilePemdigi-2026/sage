import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { database, createSession } from "@sage/database";
const db = database(); let sessionId: string | undefined;
try {
  const user = await db.user.findFirst({ where: { login: process.env.SAGE_TEST_LOGIN ?? "" }, select: { id: true } }); assert.ok(user);
  const session = await createSession(db, user.id, { ttlMs: 120_000 }); sessionId = session.session.sessionId;
  const cookie = `sage_session=${session.token}`;
  const base = new URL(process.env.SAGE_HTTP_BASE_URL ?? "http://web:3000");
  const origin = process.env.AUTH_BASE_URL ?? "http://localhost:3000";
  const repository = process.env.SAGE_TEST_PRIVATE_REPOSITORY ?? "octocat/Hello-World";
  const call = (path: string, init: RequestInit = {}) => fetch(new URL(path, base), { redirect: "error", ...init });
  const checks: string[] = [];
  const before = await db.analysis.count({ where: { ownerUserId: user.id } });
  const branchResponse = await call(`/api/repositories/branches?repository=${encodeURIComponent(repository)}`, { headers: { Cookie: cookie } });
  assert.equal(branchResponse.status, 200); const branchData = await branchResponse.json(); assert.ok(branchData.data.items.length > 0);
  const branch = branchData.data.items[0].name; checks.push("real authorized repository branches returned through HTTP");
  const target = async (input: unknown, withCookie = true) => call("/api/repositories/target", { method: "POST", headers: { ...(withCookie ? { Cookie: cookie } : {}), Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(input) });
  assert.equal((await target({ repository, branch }, false)).status, 401); checks.push("target requires session");
  const headResponse = await target({ repository, branch, commit: null }); assert.equal(headResponse.status, 200); const head = (await headResponse.json()).data;
  assert.match(head.commitSha, /^[a-f0-9]{40}$/); assert.equal(head.commitSha, head.branchHeadSha); checks.push("optional empty commit resolves actual branch full SHA");
  const prefixResponse = await target({ repository, branch, commit: head.commitSha.slice(0, 12) }); assert.equal(prefixResponse.status, 200); const prefix = (await prefixResponse.json()).data;
  assert.equal(prefix.commitSha, head.commitSha); checks.push("commit prefix resolves full SHA with branch membership check");
  assert.equal((await target({ repository, branch, commit: "bad input" })).status, 400);
  const invalidBranch = await target({ repository, branch: "missing-branch-sage-fixture-7" }); assert.ok([400, 404].includes(invalidBranch.status)); checks.push("invalid commit and missing branch rejected before job creation");
  assert.equal(await db.analysis.count({ where: { ownerUserId: user.id } }), before); checks.push("validation never enqueues an analysis");
  await mkdir("artifacts/rep-01", { recursive: true });
  const report = { checkedAt: new Date().toISOString(), provider: "real GitHub", checks, privateFixture: !!process.env.SAGE_TEST_PRIVATE_REPOSITORY, limitations: ["Temporary server-seeded session; branch/target provider requests are real.", "Off-branch and ambiguous commit branches covered by controlled tests."] };
  await writeFile("artifacts/rep-01/http-report.json", JSON.stringify(report, null, 2)+'\n'); console.log(JSON.stringify(report));
} catch { console.error("Target HTTP verification failed; no private metadata or credentials printed."); process.exitCode = 1; }
finally { if (sessionId) await db.session.deleteMany({ where: { id: sessionId } }); await db.$disconnect(); }
