import { After, AfterAll, Before, setDefaultTimeout, Status, type ITestCaseHookParameter } from "@cucumber/cucumber";
import { disconnectDatabase } from "@sage/database";
import { chromium } from "playwright";
import type { SageWorld } from "./world.ts";

setDefaultTimeout(15_000);

Before({ tags: "@browser" }, async function (this: SageWorld) {
  const origin = this.assertSafeTestEnvironment().origin;
  this.browser = await chromium.launch({ headless: true });
  this.context = await this.browser.newContext({
    baseURL: origin,
    serviceWorkers: "block",
    viewport: { width: 1280, height: 900 },
  });
  await this.context.route("**/*", async route => {
    let requestOrigin: string;
    try {
      requestOrigin = new URL(route.request().url()).origin;
    } catch {
      this.blockedExternalRequests += 1;
      await route.abort("blockedbyclient");
      return;
    }
    if (requestOrigin !== origin) {
      this.blockedExternalRequests += 1;
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  });
  this.page = await this.context.newPage();
  this.page.setDefaultTimeout(10_000);
  this.page.on("request", request => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/auth/github") {
      this.oauthStartPostRequests += 1;
    }
  });
});

AfterAll(async function () {
  await disconnectDatabase();
});

After({ tags: "@browser" }, async function (this: SageWorld, scenario: ITestCaseHookParameter) {
  try {
    if (scenario.result?.status === Status.FAILED && this.page && !this.page.isClosed()) {
      // Keep evidence in memory; never persist request headers, cookies, or callback URLs.
      const screenshot = await this.page.screenshot({ fullPage: true, animations: "disabled" });
      await this.attach(screenshot, "image/png");
    }
  } finally {
    try {
      await this.context?.close();
    } finally {
      try {
        await this.browser?.close();
      } finally {
        await this.cleanupOwnedRows();
      }
    }
  }
});
