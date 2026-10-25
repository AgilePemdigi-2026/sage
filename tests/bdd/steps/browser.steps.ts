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

async function openRepositoryPage(world: SageWorld, alias: string): Promise<void> {
  const account = await world.createSyntheticAccount(alias);
  const control = controlFor(world);
  control.activeAccount = account;
  control.fixtures.set(alias, fixturesFor(account));
  const page = world.requirePage();
  page.on("pageerror", () => { control.pageErrors += 1; });
  await world.activateSyntheticAccount(alias);
  await page.route("**/api/**", route => routeControlledApi(route, control));
  await page.goto(new URL("/workspace/repositories", world.baseUrl).toString(), { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: `Repository public milik @${account.connectionLogin}`, exact: true }).waitFor();
}

function activeFixtures(world: SageWorld): AccountFixtures {
  const account = controlFor(world).activeAccount;
  if (!account) throw new Error("Akun aktif untuk skenario browser belum tersedia.");
  const fixtures = controlFor(world).fixtures.get(account.alias);
  if (!fixtures) throw new Error("Fixture API repository belum tersedia.");
  return fixtures;
}

async function selectOwnedPublicRepository(world: SageWorld): Promise<void> {
  const page = world.requirePage();
  const repository = activeFixtures(world).publicRepository;
  await page.getByRole("button", { name: `Pilih ${repository.fullName}`, exact: true }).click();
}

Given("I am on the SAGE landing page", async function (this: SageWorld) {
  const page = this.requirePage();
  await page.goto(this.baseUrl.toString(), { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: /Pahami arsitektur/ }).waitFor();
});

When("I select the Connect with GitHub link", async function (this: SageWorld) {
  await this.requirePage().getByRole("link", { name: "Hubungkan GitHub", exact: true }).click();
});

Then("the sign-in form appears without starting an authorization request", async function (this: SageWorld) {
  const page = this.requirePage();
  await page.getByRole("heading", { name: "Masuk dengan GitHub", exact: true }).waitFor();
  const retry = page.getByRole("button", { name: "Masuk dengan GitHub", exact: true });
  assert.equal(await retry.count(), 1);
  assert.equal(await retry.isEnabled(), true);
  assert.equal(this.oauthStartPostRequests, 0);
  assert.equal(this.blockedExternalRequests, 0);
});

When("the controlled GitHub denial callback is returned", async function (this: SageWorld) {
  await this.visitControlledOAuthDenial();
});

Then("the UI shows a safe denial message and offers a retry action", async function (this: SageWorld) {
  const page = this.requirePage();
  await page.waitForURL(url => url.pathname === "/login" && url.searchParams.get("error") === "denied");
  await page.getByRole("alert").getByText(
    "Permintaan akses GitHub dibatalkan. Kamu bisa memulai login lagi kapan saja.",
    { exact: true },
  ).waitFor();
  const retry = page.getByRole("button", { name: "Masuk dengan GitHub", exact: true });
  assert.equal(await retry.count(), 1);
  assert.equal(await retry.isEnabled(), true);
  assert.equal((await this.requireContext().cookies(new URL(this.baseUrl).origin)).some(cookie => cookie.name === "sage_session"), false);
  assert.equal(page.url().includes("state="), false);
  assert.equal(page.url().includes("access_denied"), false);
  assert.equal(this.oauthStartPostRequests, 0);
  assert.equal(this.blockedExternalRequests, 0);
});

Given("the browser has no SAGE session cookie", async function (this: SageWorld) {
  await this.requireContext().clearCookies();
});

When("I open the workspace page", async function (this: SageWorld) {
  await this.requirePage().goto(new URL("/workspace", this.baseUrl).toString(), { waitUntil: "domcontentloaded" });
});

Then("I am redirected to sign-in with a safe session message", async function (this: SageWorld) {
  const page = this.requirePage();
  await page.waitForURL(url => url.pathname === "/login" && url.searchParams.get("error") === "session");
  await page.getByRole("alert").getByText("Sesi SAGE berakhir. Masuk lagi dengan GitHub.", { exact: true }).waitFor();
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

When("I open the repositories page as synthetic account {string}", async function (this: SageWorld, alias: string) {
  await openRepositoryPage(this, alias);
});

Then("I see the account's public repository and its authorized private repository", async function (this: SageWorld) {
  const page = this.requirePage();
  const account = controlFor(this).activeAccount;
  assert.ok(account);
  const fixtures = activeFixtures(this);
  await page.getByRole("button", { name: `Pilih ${fixtures.publicRepository.fullName}`, exact: true }).waitFor();
  await page.getByRole("button", { name: `org-${account.alias}`, exact: true }).click();
  await page.getByRole("button", { name: `Pilih ${fixtures.privateRepository.fullName}`, exact: true }).waitFor();
  assert.ok((await page.locator("body").innerText()).includes("Private · berizin"));
});

When("I search for a repository that is not in the loaded page", async function (this: SageWorld) {
  await this.requirePage().getByLabel("Cari pada repository App yang sudah dimuat", { exact: true }).fill("tidak-ada-di-halaman");
});

Then("the search result is empty without clearing the stored repository list", async function (this: SageWorld) {
  const page = this.requirePage();
  await page.getByText("Tidak ada hasil pencarian pada halaman yang dimuat.", { exact: true }).waitFor();
  const privateRepository = activeFixtures(this).privateRepository;
  await page.getByLabel("Cari pada repository App yang sudah dimuat", { exact: true }).fill(privateRepository.fullName);
  await page.getByRole("button", { name: `Pilih ${privateRepository.fullName}`, exact: true }).waitFor();
});

When("I select the account's public repository on branch {string}", async function (this: SageWorld, branchName: string) {
  await selectOwnedPublicRepository(this);
  await this.requirePage().getByLabel("Branch", { exact: true }).locator(`option[value="${branchName}"]`).waitFor({ state: "attached" });
  await this.requirePage().getByLabel("Branch", { exact: true }).selectOption(branchName);
});

When("I check the target without specifying a commit", async function (this: SageWorld) {
  const page = this.requirePage();
  await page.getByLabel("Commit (opsional)", { exact: true }).fill("");
  await page.getByRole("button", { name: "Periksa target", exact: true }).click();
  await page.getByRole("status").filter({ hasText: FULL_SHA }).waitFor();
});

Then("an empty commit uses the branch's full SHA", function (this: SageWorld) {
  const control = controlFor(this);
  assert.deepEqual(control.targetRequests.at(-1), {
    repository: activeFixtures(this).publicRepository.fullName,
    branch: "feature/sprint-one",
    commit: null,
  });
  assert.equal(control.analysisRequests, 0);
  assert.equal(control.unexpectedApiRequests, 0);
});

When("I check the target with a specific full SHA", async function (this: SageWorld) {
  const page = this.requirePage();
  await page.getByLabel("Commit (opsional)", { exact: true }).fill(FULL_SHA);
  await page.getByRole("button", { name: "Periksa target", exact: true }).click();
  await page.getByRole("status").filter({ hasText: FULL_SHA }).waitFor();
});

Then("the validation request includes the selected full SHA", function (this: SageWorld) {
  const control = controlFor(this);
  assert.deepEqual(control.targetRequests.at(-1), {
    repository: activeFixtures(this).publicRepository.fullName,
    branch: "feature/sprint-one",
    commit: FULL_SHA,
  });
  assert.equal(control.analysisRequests, 0);
  assert.equal(control.unexpectedApiRequests, 0);
});

When("I select the account's public repository", async function (this: SageWorld) {
  await selectOwnedPublicRepository(this);
});

Then("the UI shows a controlled branch error with a retry action", async function (this: SageWorld) {
  const page = this.requirePage();
  await page.getByRole("alert").getByText("Branch dari GitHub belum dapat dimuat. Coba lagi.", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Muat ulang branch", exact: true }).waitFor();
});

When("I retry branch loading", async function (this: SageWorld) {
  await this.requirePage().getByRole("button", { name: "Muat ulang branch", exact: true }).click();
  await this.requirePage().getByLabel("Branch", { exact: true }).locator('option[value="main"]').waitFor({ state: "attached" });
});

When("I submit target validation", async function (this: SageWorld) {
  await this.requirePage().getByRole("button", { name: "Periksa target", exact: true }).click();
});

Then("the UI shows a controlled target error without losing the selection", async function (this: SageWorld) {
  const page = this.requirePage();
  await page.getByRole("alert").getByText("Target belum dapat divalidasi. Coba lagi.", { exact: true }).waitFor();
  assert.equal(await page.getByLabel("Branch", { exact: true }).inputValue(), "main");
});

When("I retry target validation", async function (this: SageWorld) {
  const page = this.requirePage();
  await page.getByRole("button", { name: "Periksa target", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "Target tervalidasi" }).waitFor();
});

Then("target validation succeeds after the retry", function (this: SageWorld) {
  const control = controlFor(this);
  assert.equal(control.targetRequests.length, 2);
  assert.equal(control.analysisRequests, 0);
  assert.equal(control.unexpectedApiRequests, 0);
});

Then("the public repository list shows an error and a retry action", async function (this: SageWorld) {
  const page = this.requirePage();
  await page.getByRole("alert").filter({ hasText: "Daftar repository public belum tersedia. Coba lagi." }).waitFor();
  await page.getByRole("button", { name: "Coba lagi", exact: true }).waitFor();
});

When("I retry loading the public repository list", async function (this: SageWorld) {
  const page = this.requirePage();
  await page.getByRole("button", { name: "Coba lagi", exact: true }).click();
  const fixtures = activeFixtures(this);
  await page.getByRole("button", { name: `Pilih ${fixtures.publicRepository.fullName}`, exact: true }).waitFor();
});

Then("the public repository list recovers after the retry", function (this: SageWorld) {
  const control = controlFor(this);
  assert.equal(control.publicFailuresRemaining, 0);
  assert.equal(control.unexpectedApiRequests, 0);
  assert.equal(control.analysisRequests, 0);
});

Then("an empty branch list prevents target validation and can be reloaded", async function (this: SageWorld) {
  const page = this.requirePage();
  await page.getByText("Repository ini belum memiliki branch. Tambahkan commit di GitHub sebelum memilih target.", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Periksa target", exact: true }).isDisabled(), true);
  await page.getByRole("button", { name: "Muat ulang branch", exact: true }).click();
  await page.getByLabel("Branch", { exact: true }).locator('option[value="main"]').waitFor({ state: "attached" });
  assert.equal(controlFor(this).analysisRequests, 0);
  assert.equal(controlFor(this).unexpectedApiRequests, 0);
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

Then("only the new account's repositories are visible", async function (this: SageWorld) {
  const control = controlFor(this);
  const account = control.activeAccount;
  assert.ok(account);
  const fixtures = activeFixtures(this);
  const previousFixtures = control.fixtures.get("primary");
  assert.ok(previousFixtures);
  const page = this.requirePage();
  await page.getByRole("button", { name: `Pilih ${fixtures.publicRepository.fullName}`, exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: `Pilih ${fixtures.publicRepository.fullName}`, exact: true }).count(), 1);
  assert.equal(await page.getByRole("button", { name: `Pilih ${previousFixtures.publicRepository.fullName}`, exact: true }).count(), 0);
  assert.ok(control.mismatchedAccountHeaders.includes(this.account("primary").githubUserId));
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
