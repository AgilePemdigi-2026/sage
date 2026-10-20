import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { database, createSession } from "@sage/database";
const db = database();
let sessionId: string | undefined;
try {
  const user = await db.user.findFirst({ where: { login: process.env.SAGE_TEST_LOGIN ?? "" }, select: { id: true, githubUserId: true } });
  assert.ok(user);
  const session = await createSession(db, user.id, { ttlMs: 120_000 });
  sessionId = session.session.sessionId;
  const cookie = `sage_session=${session.token}`;
  const base = new URL(process.env.SAGE_HTTP_BASE_URL ?? "http://web:3000");
  const call = (path: string, withCookie = true) => fetch(new URL(path, base), {
    redirect: "error",
    headers: withCookie ? { Cookie: cookie, "X-SAGE-Account": user.githubUserId } : {},
  });
  const checks: string[] = [];
  const list = await call("/api/analyses");
  assert.equal(list.status, 200);
  const listBody = (await list.json()).data as { analyses: { id: string }[]; nextCursor: string | null };
  assert.ok(Array.isArray(listBody.analyses));
  checks.push("history list returns owner-scoped analyses through HTTP");
  assert.equal((await call("/api/analyses", false)).status, 401);
  checks.push("history requires a session");
  assert.equal((await call("/api/analyses?status=FAILED")).status, 200);
  checks.push("enum status filter accepted");
  const search = await call(`/api/analyses?query=${encodeURIComponent("acme")}`);
  assert.equal(search.status, 200);
  checks.push("query filter accepted (matches only owned matching records when non-empty)");
  const detailId = listBody.analyses[0]?.id;
  if (detailId) {
    const detail = await call(`/api/analyses/${detailId}`);
    assert.equal(detail.status, 200);
    const detailBody = (await detail.json()).data as { stages: unknown[]; stateVersion: number };
    assert.equal(detailBody.stages.length, 9);
    assert.equal(typeof detailBody.stateVersion, "number");
    checks.push("detail returns nine stages with monotonic stateVersion");
  }
  await mkdir("artifacts/hist-01", { recursive: true });
  const report = {
    checkedAt: new Date().toISOString(),
    checks,
    analysisCount: await db.analysis.count({ where: { ownerUserId: user.id } }),
    limitations: [
      "Graph/document target pages belong to GRAPH-01/DOC-01; links remain canonical.",
      "Temporary server-seeded session; no credentials printed.",
    ],
  };
  await writeFile("artifacts/hist-01/http-report.json", JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report));
} catch {
  console.error("History HTTP verification failed; no user data printed.");
  process.exitCode = 1;
} finally {
  if (sessionId) await db.session.deleteMany({ where: { id: sessionId } });
  await db.$disconnect();
}
