import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createSession, database } from "@sage/database";

const db = database();
let sessionId: string | undefined;
const checks: string[] = [];
try {
  const base = new URL(process.env.SAGE_HTTP_BASE_URL ?? "http://web:3000");
  const origin = process.env.AUTH_BASE_URL ?? "http://localhost:3000";
  const user = await db.user.findFirst({ where: { login: process.env.SAGE_TEST_LOGIN ?? "" }, select: { id: true } });
  assert.ok(user);
  const session = await createSession(db, user.id, { ttlMs: 120_000 }); sessionId = session.session.sessionId;
  const cookie = `sage_session=${session.token}`;
  const call = (path: string, init?: RequestInit) => fetch(new URL(path, base), { redirect: "error", ...init });
  assert.equal((await call("/api/github/installations")).status, 401); checks.push("HTTP rejects unauthenticated access");
  const list = await call("/api/github/installations", { headers: { Cookie: cookie } }); assert.equal(list.status, 200);
  const listText = await list.text(); const listed = JSON.parse(listText);
  assert.ok(Array.isArray(listed.data.items)); assert.ok(!listText.includes(session.token)); checks.push("HTTP returns real installation metadata without session secret");
  const forbidden = await call("/api/repositories/resolve", { method: "POST", headers: { Cookie: cookie, Origin: "https://attacker.invalid", "Content-Type": "application/json" }, body: JSON.stringify({ repository: "octocat/Hello-World" }) });
  assert.equal(forbidden.status, 403); checks.push("HTTP rejects cross-origin repository POST");
  const resolved = await call("/api/repositories/resolve", { method: "POST", headers: { Cookie: cookie, Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ repository: "octocat/Hello-World" }) });
  assert.equal(resolved.status, 200); const repo = await resolved.json(); assert.equal(repo.data.private, false); checks.push("HTTP resolves real third-party public repository");
  const invalid = await call("/api/repositories/resolve", { method: "POST", headers: { Cookie: cookie, Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ repository: "https://127.0.0.1/private" }) });
  assert.equal(invalid.status, 400); checks.push("HTTP rejects non-GitHub target");
  assert.equal((await call("/workspace/repositories", { headers: { Cookie: cookie } })).status, 200); checks.push("session-gated repository page renders");
  await mkdir("artifacts/gh-02", { recursive: true });
  const report = { checkedAt: new Date().toISOString(), checks, limitations: ["Session seeded by server helper for an already-authorized account; real browser login is covered separately in GH-01.", "Private fixture not exercised by this HTTP script."] };
  await writeFile("artifacts/gh-02/http-report.json", `${JSON.stringify(report, null, 2)}\n`); console.log(JSON.stringify(report));
} catch { console.error("Repository HTTP check failed; no credentials or provider payload printed."); process.exitCode = 1; }
finally { if (sessionId) await db.session.deleteMany({ where: { id: sessionId } }); await db.$disconnect(); }
