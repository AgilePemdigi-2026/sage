import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { database, readGitHubCredential } from "@sage/database";
import { GitHubRepositoryClient, GitHubRepositoryError } from "../apps/web/lib/github/client.ts";

const db = database();
const checks: string[] = [];
try {
  const login = process.env.SAGE_TEST_LOGIN;
  if (!login) throw new Error("Set SAGE_TEST_LOGIN to the already-authorized account.");
  const user = await db.user.findFirst({ where: { login }, select: { id: true } });
  assert.ok(user);
  const connection = await db.gitHubConnection.findFirst({ where: { userId: user.id, status: "ACTIVE" }, orderBy: { updatedAt: "desc" }, select: { id: true } });
  assert.ok(connection);
  const credential = await readGitHubCredential(db, user.id, connection.id);
  assert.ok(credential);
  const client = new GitHubRepositoryClient({ accessToken: credential.accessToken });
  const installations = await client.listInstallations({ page: 1 });
  assert.ok(Array.isArray(installations.items));
  checks.push("real user token lists current GitHub App installations");
  const publicRepo = await client.resolveRepository("octocat/Hello-World");
  assert.equal(publicRepo.private, false);
  assert.equal(publicRepo.fullName.toLowerCase(), "octocat/hello-world");
  checks.push("third-party public repository resolves through GitHub");
  let privateCheck = "NOT_RUN: private fixture not supplied";
  if (process.env.SAGE_TEST_PRIVATE_REPOSITORY) {
    const privateRepo = await client.resolveRepository(process.env.SAGE_TEST_PRIVATE_REPOSITORY);
    assert.equal(privateRepo.private, true); assert.ok(privateRepo.installationId);
    checks.push("authorized private repository resolves through App/user permission intersection");
    const noAccess = new GitHubRepositoryClient({ accessToken: "synthetic-invalid-token" });
    await assert.rejects(noAccess.resolveRepository(process.env.SAGE_TEST_PRIVATE_REPOSITORY), (error: unknown) => error instanceof GitHubRepositoryError && [401, 403, 404].includes(error.status));
    checks.push("same real private fixture is denied with invalid credential");
    privateCheck = "PASS";
  }
  await mkdir("artifacts/gh-02", { recursive: true });
  const report = { checkedAt: new Date().toISOString(), provider: "real GitHub", checks, installationCountOnFirstPage: installations.items.length, privateCheck, limitations: ["Direct server client probe; does not prove browser HTTP routes.", "Rate-limit/outage branches use controlled unit tests."] };
  await writeFile("artifacts/gh-02/live-report.json", `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
} catch {
  console.error("Live repository verification failed; no provider payload or credential was printed.");
  process.exitCode = 1;
} finally { await db.$disconnect(); }
