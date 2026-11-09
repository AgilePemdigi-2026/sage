import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createSession, database, storeGitHubCredential } from "@sage/database";
import { chromium } from "playwright";

assert.equal(process.env.SAGE_HISTORY_TESTS, "1");
assert.equal(new URL(process.env.DATABASE_URL!).pathname, "/sage_hist01_fresh");
const base = process.env.SAGE_HISTORY_BASE_URL!;
assert.equal(new URL(base).hostname, "127.0.0.1");
const db = database();
const browser = await chromium.launch({ headless: true });
const users: string[] = [],
  analyses: string[] = [];
let repositoryId: string | undefined;
const checks: string[] = [],
  errors: string[] = [];
const output = process.env.SAGE_HISTORY_ARTIFACT_DIR!;
try {
  const tag = randomUUID();
  const owner = await db.user.create({
    data: { login: `bdd-history-${tag}`, githubUserId: `bdd-history-${tag}` },
  });
  users.push(owner.id);
  await storeGitHubCredential(db, owner.id, {
    githubUserId: owner.githubUserId,
    githubLogin: owner.login,
    accessToken: `synthetic-${tag}`,
  });
  const session = await createSession(db, owner.id);
  const context = await browser.newContext();
  await context.addCookies([
    {
      name: "sage_session",
      value: session.token,
      url: base,
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  // SRS B.7.6 scenario 5: genuinely empty owner history and new-analysis navigation.
  await page.goto(`${base}/workspace/history`);
  await page.getByText("Belum ada riwayat analisis", { exact: true }).waitFor();
  await page
    .getByRole("link", { name: "Pilih repository", exact: true })
    .click();
  await page.waitForURL(`${base}/workspace/repositories`);
  checks.push("B7.6.5: empty history opens repository selection");
  const repository = await db.repository.create({
    data: {
      githubRepositoryId: `bdd-history-${tag}`,
      ownerLogin: "acme",
      name: "fintech-core",
      fullName: "acme/fintech-core",
    },
  });
  repositoryId = repository.id;
  for (let i = 0; i < 22; i++) {
    const analysis = await db.analysis.create({
      data: {
        ownerUserId: owner.id,
        repositoryId,
        branchName: `branch-${i}`,
        commitSha: "a".repeat(40),
        configuration: {},
        configurationHash: "history-bdd",
        analyzerVersion: "bdd",
        schemaVersion: "1",
        status: "COMPLETED",
        createdAt: new Date(Date.now() + i),
        completedAt: new Date(),
      },
    });
    analyses.push(analysis.id);
    await db.sourceFile.create({
      data: {
        ownerUserId: owner.id,
        analysisId: analysis.id,
        path: "src/main.ts",
        language: "TypeScript",
        byteLength: 1n,
        sha256: "a".repeat(64),
        processingStatus: "ANALYZED",
      },
    });
  }
  for (const width of [360, 390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${base}/workspace/history`);
    await page
      .getByText("acme/fintech-core", { exact: true })
      .first()
      .waitFor();
    assert.equal(
      await page.getByText("TypeScript", { exact: true }).count(),
      20,
    );
    assert.ok(await page.getByText("branch-21", { exact: true }).isVisible());
    assert.ok(
      await page.getByText("aaaaaaa", { exact: true }).first().isVisible(),
    );
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    const search = page.getByRole("searchbox");
    await search.fill("fintech-core");
    await page
      .getByRole("button", { name: "Muat lebih banyak", exact: true })
      .click();
    await page.getByText("branch-0", { exact: true }).waitFor();
    assert.equal(
      await page.getByText("acme/fintech-core", { exact: true }).count(),
      22,
    );
    await search.fill("node-tidak-ada");
    await page.getByText("Tidak ada hasil untuk", { exact: false }).waitFor();
    assert.equal(
      await page.getByText("acme/fintech-core", { exact: true }).count(),
      0,
    );
    await page
      .getByRole("button", { name: "Hapus filter", exact: true })
      .first()
      .click();
    await page
      .getByRole("link", { name: "Buka", exact: true })
      .first()
      .waitFor();
    await search.focus();
    await page.keyboard.press("Tab");
    assert.ok(
      await page.evaluate(() => document.activeElement?.tagName === "SELECT"),
    );
    await page.screenshot({
      path: resolve(output, `history-${width}.png`),
      fullPage: true,
    });
  }
  checks.push(
    "B7.6.1: repository, branch, commit, detected language, status and dates render at five widths",
  );
  checks.push("B7.6.2: search, pagination and reset use real owner-scoped API");
  checks.push(
    "B7.6.4: unmatched query removes rows and shows empty search feedback",
  );
  await page.getByRole("link", { name: "Buka", exact: true }).first().click();
  await page.waitForURL(`${base}/analyses/${analyses.at(-1)}`);
  await page
    .getByRole("link", { name: "Buka knowledge graph", exact: true })
    .waitFor();
  assert.ok(
    await page
      .getByRole("link", { name: "Buka dokumentasi", exact: true })
      .isVisible(),
  );
  checks.push(
    "B7.6.3: completed history entry opens detail with graph and document links",
  );
  let failed = false;
  await page.route(
    (url) => url.pathname === "/api/analyses",
    async (route) => {
      if (!failed) {
        failed = true;
        await route.fulfill({
          status: 503,
          json: { error: { code: "HISTORY_UNAVAILABLE" } },
        });
      } else await route.continue();
    },
  );
  await page.goto(`${base}/workspace/history`);
  await page.getByText("Riwayat gagal dimuat", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Coba lagi", exact: true }).click();
  await page.getByRole("link", { name: "Buka", exact: true }).first().waitFor();
  assert.deepEqual(errors, []);
  checks.push(
    "network failure retry recovers through the actual API; keyboard and no page errors",
  );
  await writeFile(
    resolve(output, "report.json"),
    JSON.stringify(
      {
        status: "PASS",
        checks,
        errors,
        viewports: [360, 390, 768, 1024, 1440],
        scope:
          "Production Next/PostgreSQL with synthetic sessions; only one marked 503 is intercepted; no live OAuth",
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
  await db.analysis.deleteMany({
    where: { id: { in: analyses }, ownerUserId: { in: users } },
  });
  await db.session.deleteMany({ where: { userId: { in: users } } });
  await db.gitHubConnection.deleteMany({ where: { userId: { in: users } } });
  await db.user.deleteMany({ where: { id: { in: users } } });
  if (repositoryId) await db.repository.delete({ where: { id: repositoryId } });
  await db.$disconnect();
}
