import assert from "node:assert/strict";
import { Given, Then, When } from "@cucumber/cucumber";
import type { Route } from "playwright";
import type { SageWorld, SyntheticAccount } from "../support/world.ts";

type Repository = {
  readonly id: string;
  readonly fullName: string;
  readonly private: boolean;
  readonly defaultBranch: string;
};
type Branch = { readonly name: string; readonly commitSha: string };
type TargetRequest = { readonly repository: string; readonly branch: string; readonly commit: string | null };
type AccountFixtures = {
  readonly publicRepository: Repository;
  readonly privateRepository: Repository;
  readonly branches: readonly Branch[];
};
type ApiControl = {
  activeAccount: SyntheticAccount | null;
  readonly fixtures: Map<string, AccountFixtures>;
  publicFailuresRemaining: number;
  branchFailuresRemaining: number;
  emptyBranchResponsesRemaining: number;
  targetFailuresRemaining: number;
  readonly accountHeaders: string[];
  readonly mismatchedAccountHeaders: string[];
  readonly targetRequests: TargetRequest[];
  unexpectedApiRequests: number;
  analysisRequests: number;
  pageErrors: number;
};

const FULL_SHA = "4e2c15d5c357d8a451bd99d4544f111353dcad80";
const apiControls = new WeakMap<SageWorld, ApiControl>();

function controlFor(world: SageWorld): ApiControl {
  let control = apiControls.get(world);
  if (!control) {
    control = {
      activeAccount: null,
      fixtures: new Map(),
      publicFailuresRemaining: 0,
      branchFailuresRemaining: 0,
      emptyBranchResponsesRemaining: 0,
      targetFailuresRemaining: 0,
      accountHeaders: [],
      mismatchedAccountHeaders: [],
      targetRequests: [],
      unexpectedApiRequests: 0,
      analysisRequests: 0,
      pageErrors: 0,
    };
    apiControls.set(world, control);
  }
  return control;
}

function fixturesFor(account: SyntheticAccount): AccountFixtures {
  const suffix = account.alias.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  return {
    publicRepository: {
      id: `bdd-public-${suffix}`,
      fullName: `${account.login}/sprint-${suffix}`,
      private: false,
      defaultBranch: "main",
    },
    privateRepository: {
      id: `bdd-private-${suffix}`,
      fullName: `org-${suffix}/internal-${suffix}`,
      private: true,
      defaultBranch: "main",
    },
    branches: [
      { name: "main", commitSha: FULL_SHA },
      { name: "feature/sprint-one", commitSha: FULL_SHA },
    ],
  };
}

async function fulfillJson(route: Route, status: number, payload: unknown): Promise<void> {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(payload),
  });
}

async function routeControlledApi(route: Route, control: ApiControl): Promise<void> {
  const request = route.request();
  const url = new URL(request.url());
  const path = url.pathname;

  if (path === "/api/analyses") {
    control.analysisRequests += 1;
    await route.abort("blockedbyclient");
    return;
  }

  const activeAccount = control.activeAccount;
  const accountKey = request.headers()["x-sage-account"] ?? "";
  if (activeAccount) control.accountHeaders.push(accountKey);
  if (!activeAccount || accountKey !== activeAccount.githubUserId) {
    control.mismatchedAccountHeaders.push(accountKey);
    await fulfillJson(route, 401, { error: { code: "AUTH_REQUIRED", message: "Sesi akun berubah. Muat ulang halaman." } });
    return;
  }

  if (path === "/api/auth/session" && request.method() === "GET") {
    await fulfillJson(route, 200, { data: { accountKey: activeAccount.githubUserId, login: activeAccount.login } });
    return;
  }

  const fixtures = control.fixtures.get(activeAccount.alias);
  if (!fixtures) {
    control.unexpectedApiRequests += 1;
    await route.abort("failed");
    return;
  }

  if (path === "/api/repositories/public" && request.method() === "GET") {
    if (control.publicFailuresRemaining > 0) {
      control.publicFailuresRemaining -= 1;
      await fulfillJson(route, 503, { error: { code: "GITHUB_UNAVAILABLE", message: "Daftar repository public belum tersedia. Coba lagi." } });
      return;
    }
    await fulfillJson(route, 200, { data: { items: [fixtures.publicRepository], nextPage: null } });
    return;
  }

  if (path === "/api/github/installations" && request.method() === "GET") {
    await fulfillJson(route, 200, {
      data: { items: [{ id: `installation-${activeAccount.alias}`, accountLogin: `org-${activeAccount.alias}` }], nextPage: null },
    });
    return;
  }

  if (/^\/api\/github\/installations\/[^/]+\/repositories$/.test(path) && request.method() === "GET") {
    await fulfillJson(route, 200, { data: { items: [fixtures.privateRepository], nextPage: null } });
    return;
  }

  if (path === "/api/repositories/branches" && request.method() === "GET") {
    if (control.branchFailuresRemaining > 0) {
      control.branchFailuresRemaining -= 1;
      await fulfillJson(route, 503, { error: { code: "GITHUB_UNAVAILABLE", message: "Branch dari GitHub belum dapat dimuat. Coba lagi." } });
      return;
    }
    if (control.emptyBranchResponsesRemaining > 0) {
      control.emptyBranchResponsesRemaining -= 1;
      await fulfillJson(route, 200, { data: { items: [], nextPage: null } });
      return;
    }
    await fulfillJson(route, 200, { data: { items: fixtures.branches, nextPage: null } });
    return;
  }

  if (path === "/api/repositories/target" && request.method() === "POST") {
    let body: unknown;
    try {
      body = JSON.parse(request.postData() ?? "null");
    } catch {
      control.unexpectedApiRequests += 1;
      await route.abort("failed");
      return;
    }
    const input = body as Partial<TargetRequest> | null;
    if (!input || typeof input.repository !== "string" || typeof input.branch !== "string"
      || !(input.commit === null || typeof input.commit === "string")) {
      control.unexpectedApiRequests += 1;
      await fulfillJson(route, 400, { error: { code: "INVALID_INPUT", message: "Target tidak valid." } });
      return;
    }
    control.targetRequests.push({ repository: input.repository, branch: input.branch, commit: input.commit });
    if (control.targetFailuresRemaining > 0) {
      control.targetFailuresRemaining -= 1;
      await fulfillJson(route, 503, { error: { code: "GITHUB_UNAVAILABLE", message: "Target belum dapat divalidasi. Coba lagi." } });
      return;
    }
    const repository = [fixtures.publicRepository, fixtures.privateRepository]
      .find(candidate => candidate.fullName === input.repository);
    if (!repository) {
      await fulfillJson(route, 404, { error: { code: "NOT_FOUND", message: "Repository tidak ditemukan." } });
      return;
    }
    const commitSha = input.commit || FULL_SHA;
    await fulfillJson(route, 200, {
      data: { repository, branch: input.branch, commitSha, branchHeadSha: FULL_SHA },
    });
    return;
  }

  control.unexpectedApiRequests += 1;
  await route.abort("failed");
}

function sameOriginLocalUrl(world: SageWorld, path: string): URL {
  assert.ok(path.startsWith("/") && !path.startsWith("//"), "Browser navigation must use a same-origin local path.");
  assert.ok(!path.includes("\\") && !/[\u0000-\u001f\u007f]/.test(path), "Browser navigation path contains an invalid character.");
  const baseUrl = new URL(world.baseUrl);
  const url = new URL(path, baseUrl);
  assert.equal(url.origin, baseUrl.origin, "Browser navigation must stay on the configured local origin.");
  return url;
}

async function openRepositoryPage(world: SageWorld, path: string, alias: string): Promise<void> {
  const account = await world.createSyntheticAccount(alias);
  const control = controlFor(world);
  control.activeAccount = account;
  control.fixtures.set(alias, fixturesFor(account));
  const page = world.requirePage();
  page.on("pageerror", () => { control.pageErrors += 1; });
  await world.activateSyntheticAccount(alias);
  await page.route("**/api/**", route => routeControlledApi(route, control));
  await page.goto(sameOriginLocalUrl(world, path).toString(), { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: `Repository public milik @${account.connectionLogin}`, exact: true }).waitFor();
}

function fixturesForAlias(world: SageWorld, alias: string): AccountFixtures {
  const fixtures = controlFor(world).fixtures.get(alias);
  if (!fixtures) throw new Error("Fixture API repository belum tersedia.");
  return fixtures;
}

function requireActiveAlias(world: SageWorld, alias: string): SyntheticAccount {
  const account = controlFor(world).activeAccount;
  assert.ok(account, "Akun aktif untuk skenario browser belum tersedia.");
  assert.equal(account.alias, alias, "Akun aktif tidak sesuai dengan alias fixture pada skenario.");
  return account;
}

function fixtureRepository(world: SageWorld, kind: string, alias: string): Repository {
  const fixtures = fixturesForAlias(world, alias);
  if (kind === "public") return fixtures.publicRepository;
  if (kind === "private") return fixtures.privateRepository;
  throw new Error(`Jenis repository fixture tidak didukung: ${kind}`);
}

async function waitForFixtureRepository(world: SageWorld, kind: string, alias: string): Promise<void> {
  const page = world.requirePage();
  requireActiveAlias(world, alias);
  const repository = fixtureRepository(world, kind, alias);
  const action = page.getByRole("button", { name: `Pilih ${repository.fullName}`, exact: true });
  await action.waitFor();
  assert.equal(await action.count(), 1);
}

async function clickLocalAction(world: SageWorld, label: string): Promise<void> {
  const page = world.requirePage();
  const button = page.getByRole("button", { name: label, exact: true });
  const link = page.getByRole("link", { name: label, exact: true });
  await button.or(link).waitFor({ state: "visible" });
  const [buttonCount, linkCount] = await Promise.all([button.count(), link.count()]);
  assert.equal(buttonCount + linkCount, 1, `Expected one visible action named ${JSON.stringify(label)}.`);
  const action = buttonCount === 1 ? button : link;
  if (linkCount === 1) {
    const href = await link.getAttribute("href");
    assert.ok(href, `Link ${JSON.stringify(label)} must have a local destination.`);
    sameOriginLocalUrl(world, href);
  } else {
    const destination = await button.evaluate(element => {
      const explicit = element.getAttribute("formaction");
      if (explicit !== null) return explicit;
      return element.closest("form")?.getAttribute("action") ?? null;
    });
    if (destination) sameOriginLocalUrl(world, destination);
  }
  await action.click();
}

Given("I am on {string}", async function (this: SageWorld, path: string) {
  const destination = sameOriginLocalUrl(this, path);
  await this.requirePage().goto(destination.toString(), { waitUntil: "domcontentloaded" });
  assert.equal(new URL(this.requirePage().url()).origin, destination.origin);
});

When("I open {string} as synthetic account {string}", async function (this: SageWorld, path: string, alias: string) {
  await openRepositoryPage(this, path, alias);
});

When("I open {string}", async function (this: SageWorld, path: string) {
  const destination = sameOriginLocalUrl(this, path);
  await this.requirePage().goto(destination.toString(), { waitUntil: "domcontentloaded" });
  assert.equal(new URL(this.requirePage().url()).origin, destination.origin);
});

When("I press {string}", async function (this: SageWorld, label: string) {
  await clickLocalAction(this, label);
});

When("I fill in {string} with {string}", async function (this: SageWorld, label: string, value: string) {
  const field = this.requirePage().getByLabel(label, { exact: true });
  await field.fill(value);
  assert.equal(await field.inputValue(), value, `Field ${JSON.stringify(label)} did not retain its input.`);
});

When("I select {string} from {string}", async function (this: SageWorld, value: string, label: string) {
  const field = this.requirePage().getByLabel(label, { exact: true });
  await field.selectOption(value);
  assert.equal(await field.inputValue(), value, `Field ${JSON.stringify(label)} did not select ${JSON.stringify(value)}.`);
});

Then("I should see {string}", async function (this: SageWorld, text: string) {
  assert.notEqual(text, "", "The expected visible text cannot be empty.");
  await this.requirePage().waitForFunction(expected => document.body?.innerText.includes(expected), text);
});

Then("I should be on {string}", async function (this: SageWorld, path: string) {
  const expected = sameOriginLocalUrl(this, path);
  await this.requirePage().waitForURL(actual => actual.origin === expected.origin
    && actual.pathname === expected.pathname
    && actual.search === expected.search
    && actual.hash === expected.hash);
});

Then("no OAuth authorization request or external request was started", function (this: SageWorld) {
  assert.equal(this.oauthStartPostRequests, 0);
  assert.equal(this.blockedExternalRequests, 0);
});

When("the controlled GitHub denial callback is returned", async function (this: SageWorld) {
  await this.visitControlledOAuthDenial();
});

Then("the denial response exposes no OAuth state and starts no authorization request", async function (this: SageWorld) {
  const page = this.requirePage();
  assert.equal((await this.requireContext().cookies(new URL(this.baseUrl).origin)).some(cookie => cookie.name === "sage_session"), false);
  assert.equal(page.url().includes("state="), false);
  assert.equal(page.url().includes("access_denied"), false);
  assert.equal(this.oauthStartPostRequests, 0);
  assert.equal(this.blockedExternalRequests, 0);
});

Given("the browser has no SAGE session cookie", async function (this: SageWorld) {
  await this.requireContext().clearCookies();
});

Then("no external request was made", function (this: SageWorld) {
  assert.equal(this.blockedExternalRequests, 0);
});

Given("repository APIs are controlled for the browser scenario", function (this: SageWorld) {
  controlFor(this);
});

Given("the public repository list API fails on the first request", function (this: SageWorld) {
  controlFor(this).publicFailuresRemaining = 1;
});

Given("the branch API fails on the first request", function (this: SageWorld) {
  controlFor(this).branchFailuresRemaining = 1;
});

Given("the branch API returns an empty list on the first request", function (this: SageWorld) {
  controlFor(this).emptyBranchResponsesRemaining = 1;
});

Given("the target validation API fails on the first request", function (this: SageWorld) {
  controlFor(this).targetFailuresRemaining = 1;
});

When("I select the public repository for synthetic account {string}", async function (this: SageWorld, alias: string) {
  const page = this.requirePage();
  requireActiveAlias(this, alias);
  const repository = fixtureRepository(this, "public", alias);
  await page.getByRole("button", { name: `Pilih ${repository.fullName}`, exact: true }).click();
});

Then("I should see the public repository for synthetic account {string}", async function (this: SageWorld, alias: string) {
  await waitForFixtureRepository(this, "public", alias);
});

Then("I should see the authorized private repository for synthetic account {string}", async function (this: SageWorld, alias: string) {
  await waitForFixtureRepository(this, "private", alias);
});

Then("the target request for repository {string} of synthetic account {string} uses branch {string} and commit {string}", function (
  this: SageWorld,
  kind: string,
  alias: string,
  branch: string,
  commit: string,
) {
  const control = controlFor(this);
  requireActiveAlias(this, alias);
  const request: TargetRequest = { repository: fixtureRepository(this, kind, alias).fullName, branch, commit: commit || null };
  assert.deepEqual(control.targetRequests.at(-1), request);
  assert.equal(control.unexpectedApiRequests, 0);
});

Then("no analysis request was made", function (this: SageWorld) {
  assert.equal(controlFor(this).analysisRequests, 0);
});

Then("{string} should be set to {string}", async function (this: SageWorld, label: string, value: string) {
  const field = this.requirePage().getByLabel(label, { exact: true });
  await field.getByRole("option", { name: value, exact: true }).waitFor({ state: "attached" });
  assert.equal(await field.inputValue(), value);
});

Then("there were {string} target validation requests", function (this: SageWorld, count: string) {
  const control = controlFor(this);
  const expected = Number(count);
  assert.ok(Number.isSafeInteger(expected) && expected >= 0);
  assert.equal(control.targetRequests.length, expected);
  assert.equal(control.analysisRequests, 0);
  assert.equal(control.unexpectedApiRequests, 0);
});

Then("the public repository list recovered after its retry", function (this: SageWorld) {
  const control = controlFor(this);
  assert.equal(control.publicFailuresRemaining, 0);
  assert.equal(control.unexpectedApiRequests, 0);
  assert.equal(control.analysisRequests, 0);
});

Then("the button {string} is disabled", async function (this: SageWorld, label: string) {
  const button = this.requirePage().getByRole("button", { name: label, exact: true });
  assert.equal(await button.count(), 1);
  assert.equal(await button.isDisabled(), true);
});

Then("the button {string} is enabled", async function (this: SageWorld, label: string) {
  const button = this.requirePage().getByRole("button", { name: label, exact: true });
  assert.equal(await button.count(), 1);
  assert.equal(await button.isEnabled(), true);
});

Then("no target validation request was made", function (this: SageWorld) {
  assert.equal(controlFor(this).targetRequests.length, 0);
});

When("the browser session switches to synthetic account {string}", async function (this: SageWorld, alias: string) {
  const account = await this.createSyntheticAccount(alias);
  const control = controlFor(this);
  control.activeAccount = account;
  control.fixtures.set(alias, fixturesFor(account));
  await this.activateSyntheticAccount(alias);
  const page = this.requirePage();
  const navigation = page.waitForNavigation({ waitUntil: "domcontentloaded" });
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await navigation;
  await page.getByRole("heading", { name: `Repository public milik @${account.connectionLogin}`, exact: true }).waitFor();
});

Then("only the repositories for synthetic account {string} are visible instead of those for {string}", async function (
  this: SageWorld,
  alias: string,
  previousAlias: string,
) {
  const control = controlFor(this);
  const account = requireActiveAlias(this, alias);
  const fixtures = fixturesForAlias(this, alias);
  const previousFixtures = fixturesForAlias(this, previousAlias);
  const page = this.requirePage();
  await page.getByRole("button", { name: `Pilih ${fixtures.publicRepository.fullName}`, exact: true }).waitFor();
  await page.getByRole("button", { name: `org-${alias}`, exact: true }).click();
  await page.getByRole("button", { name: `Pilih ${fixtures.privateRepository.fullName}`, exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: `Pilih ${fixtures.publicRepository.fullName}`, exact: true }).count(), 1);
  assert.equal(await page.getByRole("button", { name: `Pilih ${previousFixtures.publicRepository.fullName}`, exact: true }).count(), 0);
  assert.equal(await page.getByRole("button", { name: `Pilih ${fixtures.privateRepository.fullName}`, exact: true }).count(), 1);
  assert.equal(await page.getByRole("button", { name: `Pilih ${previousFixtures.privateRepository.fullName}`, exact: true }).count(), 0);
  assert.ok(control.mismatchedAccountHeaders.includes(this.account(previousAlias).githubUserId));
  assert.ok(control.accountHeaders.includes(account.githubUserId));
  assert.equal(control.unexpectedApiRequests, 0);
  assert.equal(control.analysisRequests, 0);
});

Then("the UI has no JavaScript errors or API requests outside the scenario", function (this: SageWorld) {
  const control = controlFor(this);
  assert.equal(control.pageErrors, 0);
  assert.equal(control.unexpectedApiRequests, 0);
  assert.equal(this.blockedExternalRequests, 0);
});
