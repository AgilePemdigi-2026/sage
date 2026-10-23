import { createHash, randomUUID } from "node:crypto";
import {
  createGitHubOAuthAttempt,
  createSession,
  database,
  storeGitHubCredential,
} from "@sage/database";
import { World, setWorldConstructor, type IWorldOptions } from "@cucumber/cucumber";
import type { Browser, BrowserContext, Page } from "playwright";

export type SyntheticAccount = {
  readonly alias: string;
  readonly userId: string;
  readonly githubUserId: string;
  readonly login: string;
  readonly connectionLogin: string;
  readonly sessionId: string;
  readonly sessionToken: string;
};

/** Scenario-scoped browser and opt-in fixture helpers for Sprint 1 BDD. */
export class SageWorld extends World {
  readonly baseUrl: string;
  browser: Browser | undefined;
  context: BrowserContext | undefined;
  page: Page | undefined;
  blockedExternalRequests = 0;
  oauthStartPostRequests = 0;

  private db: ReturnType<typeof database> | undefined;
  private readonly accounts = new Map<string, SyntheticAccount>();
  private readonly ownedUserIds: string[] = [];
  private readonly ownedSessionIds: string[] = [];
  private readonly ownedOAuthStateHashes: string[] = [];

  constructor(options: IWorldOptions) {
    super(options);
    this.baseUrl = process.env.SAGE_BDD_BASE_URL ?? "http://127.0.0.1:3000";
  }

  assertSafeTestEnvironment(): URL {
    if (process.env.SAGE_BDD_TESTS !== "1") {
      throw new Error("BDD browser/database access requires SAGE_BDD_TESTS=1.");
    }

    let databaseUrl: URL;
    let baseUrl: URL;
    let authBaseUrl: URL;
    try {
      databaseUrl = new URL(process.env.DATABASE_URL ?? "");
      baseUrl = new URL(this.baseUrl);
      authBaseUrl = new URL(process.env.AUTH_BASE_URL ?? "");
    } catch {
      throw new Error("BDD requires a valid disposable PostgreSQL URL and loopback HTTP app origin.");
    }

    if ((databaseUrl.protocol !== "postgres:" && databaseUrl.protocol !== "postgresql:")
      || databaseUrl.pathname !== "/sage_bdd_sprint1") {
      throw new Error("BDD database access is restricted to PostgreSQL database sage_bdd_sprint1.");
    }

    const hostname = baseUrl.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    const isLoopback = hostname === "localhost" || hostname === "::1"
      || /^127(?:\.\d{1,3}){3}$/.test(hostname);
    if (baseUrl.protocol !== "http:" || !isLoopback || baseUrl.pathname !== "/"
      || baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash
      || authBaseUrl.origin !== baseUrl.origin || authBaseUrl.pathname !== "/"
      || authBaseUrl.username || authBaseUrl.password || authBaseUrl.search || authBaseUrl.hash) {
      throw new Error("BDD browser access is restricted to the loopback HTTP origin shared with AUTH_BASE_URL.");
    }
    if (!process.env.CREDENTIAL_ENCRYPTION_KEY) {
      throw new Error("BDD requires a private CREDENTIAL_ENCRYPTION_KEY for synthetic credentials.");
    }
    return baseUrl;
  }

  requirePage(): Page {
    if (!this.page) throw new Error("Scenario ini tidak memiliki browser.");
    return this.page;
  }

  requireContext(): BrowserContext {
    if (!this.context) throw new Error("Scenario ini tidak memiliki konteks browser.");
    return this.context;
  }

  account(alias: string): SyntheticAccount {
    const account = this.accounts.get(alias);
    if (!account) throw new Error("Akun sintetis untuk skenario ini belum dibuat.");
    return account;
  }

  async createSyntheticAccount(alias: string): Promise<SyntheticAccount> {
    if (this.accounts.has(alias)) return this.account(alias);

    const db = this.getDatabase();
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const githubUserId = `bdd-user-${randomUUID()}`;
    const login = `bdd-${suffix}`;
    const connectionLogin = `bdd-connected-${suffix}`;
    const user = await db.user.create({
      data: { githubUserId, login, displayName: `BDD ${alias}` },
      select: { id: true },
    });
    this.ownedUserIds.push(user.id);

    try {
      await storeGitHubCredential(db, user.id, {
        githubUserId,
        githubLogin: connectionLogin,
        accessToken: `controlled-bdd-fixture-${randomUUID()}`,
      });
      const session = await createSession(db, user.id, { ttlMs: 60 * 60 * 1000 });
      this.ownedSessionIds.push(session.session.sessionId);
      const account: SyntheticAccount = {
        alias,
        userId: user.id,
        githubUserId,
        login,
        connectionLogin,
        sessionId: session.session.sessionId,
        sessionToken: session.token,
      };
      this.accounts.set(alias, account);
      return account;
    } catch {
      await this.deleteOwnedRows();
      throw new Error("Akun sintetis BDD tidak dapat disiapkan.");
    }
  }

  async activateSyntheticAccount(alias: string): Promise<void> {
    const context = this.requireContext();
    const account = this.account(alias);
    const baseUrl = new URL(this.baseUrl);
    await context.clearCookies();
    await context.addCookies([{
      name: "sage_session",
      value: account.sessionToken,
      url: baseUrl.origin,
      httpOnly: true,
      sameSite: "Lax",
      secure: baseUrl.protocol === "https:",
    }]);
  }

  async visitControlledOAuthDenial(): Promise<void> {
    const attempt = await createGitHubOAuthAttempt(this.getDatabase());
    this.ownedOAuthStateHashes.push(createHash("sha256").update(attempt.state).digest("hex"));

    const context = this.requireContext();
    const baseUrl = new URL(this.baseUrl);
    await context.addCookies([{
      name: "sage_oauth_browser",
      value: attempt.browserToken,
      url: new URL("/auth/github/callback", this.baseUrl).toString(),
      httpOnly: true,
      sameSite: "Lax",
      secure: baseUrl.protocol === "https:",
    }]);
    const callback = new URL("/auth/github/callback", this.baseUrl);
    callback.searchParams.set("state", attempt.state);
    callback.searchParams.set("error", "access_denied");
    await this.requirePage().goto(callback.toString(), { waitUntil: "domcontentloaded" });
  }

  async cleanupOwnedRows(): Promise<void> {
    if (!this.db) return;
    await this.deleteOwnedRows();
  }

  private getDatabase(): ReturnType<typeof database> {
    this.assertSafeTestEnvironment();
    this.db ??= database();
    return this.db;
  }

  private async deleteOwnedRows(): Promise<void> {
    if (!this.db) return;
    if (this.ownedOAuthStateHashes.length > 0) {
      await this.db.gitHubOAuthAttempt.deleteMany({
        where: { stateHash: { in: [...this.ownedOAuthStateHashes] } },
      });
      this.ownedOAuthStateHashes.length = 0;
    }
    if (this.ownedSessionIds.length > 0) {
      await this.db.session.deleteMany({ where: { id: { in: [...this.ownedSessionIds] } } });
      this.ownedSessionIds.length = 0;
    }
    if (this.ownedUserIds.length > 0) {
      await this.db.gitHubConnection.deleteMany({ where: { userId: { in: [...this.ownedUserIds] } } });
      await this.db.user.deleteMany({ where: { id: { in: [...this.ownedUserIds] } } });
      this.ownedUserIds.length = 0;
    }
    this.accounts.clear();
  }
}

setWorldConstructor(SageWorld);
