import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { database, createSession, readGitHubCredential } from "@sage/database";
import { GitHubRepositoryClient } from "../packages/github/client.ts";
import { fetchRepositoryArchive } from "../packages/github/archive.ts";
import { parseSnapshotArchive } from "../apps/worker/src/snapshot/archive.ts";
const db = database(); let sessionId: string | undefined; const analysisIds: string[] = [];
const storageRoot = await mkdtemp(join(tmpdir(), "sage-live-snapshot-")); const checks: string[] = [];
try {
  const user = await db.user.findFirst({ where: { login: process.env.SAGE_TEST_LOGIN ?? "" }, select: { id: true } }); assert.ok(user);
  const connection = await db.gitHubConnection.findFirst({ where: { userId: user.id, status: "ACTIVE", revokedAt: null }, orderBy: { updatedAt: "desc" }, select: { id: true } }); assert.ok(connection);
  const credential = await readGitHubCredential(db, user.id, connection.id); assert.ok(credential);
  const privateFixture = process.env.SAGE_TEST_PRIVATE_REPOSITORY; assert.ok(privateFixture);
  for (const repositoryName of ["octocat/Hello-World", privateFixture]) {
    const client = new GitHubRepositoryClient({ accessToken: credential.accessToken });
    const metadata = await client.resolveRepository(repositoryName); assert.ok(metadata.defaultBranch);
    const target = await client.resolveTarget({ repository: repositoryName, branch: metadata.defaultBranch });
    const bytes = await fetchRepositoryArchive({ repository: metadata.fullName, githubRepositoryId: metadata.id, commitSha: target.commitSha, accessToken: credential.accessToken });
    const parsed = await parseSnapshotArchive(bytes); assert.ok(parsed.files.length > 0); assert.match(parsed.archiveSha256, /^[a-f0-9]{64}$/);
    checks.push(`${metadata.private ? "private authorized" : "public third-party"}: actual pinned archive downloaded, validated and hash-checked`);
  }
  const session = await createSession(db, user.id, { ttlMs: 120_000 }); sessionId = session.session.sessionId;
  const base = process.env.SAGE_HTTP_BASE_URL ?? "http://web:3000"; const origin = process.env.AUTH_BASE_URL ?? "http://localhost:3000";
  const key = randomUUID(); const payload = { repository: privateFixture, branch: (await new GitHubRepositoryClient({ accessToken: credential.accessToken }).resolveRepository(privateFixture)).defaultBranch };
  const post = (body: unknown, auth = true) => fetch(`${base}/api/analyses`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json", "Idempotency-Key": key, ...(auth ? { Cookie: `sage_session=${session.token}` } : {}) }, body: JSON.stringify(body), redirect: "error" });
  assert.equal((await post(payload, false)).status, 401);
  const first = await post(payload); assert.equal(first.status, 202); const receipt = (await first.json()).data; analysisIds.push(receipt.analysisId);
  const second = await post(payload); assert.equal(second.status, 200); const replay = (await second.json()).data;
  assert.equal(replay.analysisId, receipt.analysisId); assert.equal(replay.commitSha, receipt.commitSha);
  assert.equal((await post({ ...payload, commit: "a".repeat(40) })).status, 409);
  assert.equal(await db.job.count({ where: { analysisId: receipt.analysisId } }), 1);
  checks.push("HTTP private submission persists full SHA before 202, requires session, replays same key and rejects conflict without duplicate job");
  await mkdir("artifacts/rep-02", { recursive: true }); const report = { checkedAt: new Date().toISOString(), checks, limitations: ["Snapshot registration/handler lease behavior verified in isolated PostgreSQL integration; full pipeline consumer remains #16.", "Temporary seeded session exercises real HTTP/provider; HEAD movement and archive attacks use controlled fixtures.", "Only aggregate evidence saved; no private source content in report."] };
  await writeFile("artifacts/rep-02/live-report.json", JSON.stringify(report, null, 2) + "\n"); console.log(JSON.stringify(report));
} catch { console.error("Snapshot live verification failed; no credential or private source details printed."); process.exitCode = 1; }
finally {
  if (sessionId) await db.session.deleteMany({ where: { id: sessionId } });
  if (analysisIds.length) { await db.storageObject.deleteMany({ where: { analysisId: { in: analysisIds } } }); await db.job.deleteMany({ where: { analysisId: { in: analysisIds } } }); await db.analysis.deleteMany({ where: { id: { in: analysisIds } } }); }
  await rm(storageRoot, { recursive: true, force: true }); await db.$disconnect();
}
