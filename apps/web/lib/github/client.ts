const API_ORIGIN = "https://api.github.com";
const API_VERSION = "2026-03-10";
const PAGE_SIZE = 30;
const MAX_PAGE = 100;
const MAX_RESOLVE_PAGES = 10;
const MAX_REQUESTS_PER_CLIENT = 30;
const MAX_CLIENT_DURATION_MS = 60_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;

export type GitHubRepositoryErrorCode =
  | "AUTH_REQUIRED"
  | "PERMISSION_DENIED"
  | "NOT_FOUND"
  | "RATE_LIMIT"
  | "UNAVAILABLE"
  | "INVALID_INPUT";

const ERROR_MESSAGES: Record<GitHubRepositoryErrorCode, string> = {
  AUTH_REQUIRED: "Hubungkan kembali akun GitHub Anda untuk melanjutkan.",
  PERMISSION_DENIED: "Akun GitHub Anda tidak memiliki izin untuk repositori ini.",
  NOT_FOUND: "Repositori tidak ditemukan atau tidak dapat diakses.",
  RATE_LIMIT: "Batas permintaan GitHub tercapai. Coba lagi nanti.",
  UNAVAILABLE: "GitHub tidak dapat menyelesaikan permintaan saat ini. Coba lagi.",
  INVALID_INPUT: "Masukkan nama repositori GitHub yang valid.",
};

const HTTP_STATUS: Record<GitHubRepositoryErrorCode, number> = {
  AUTH_REQUIRED: 401,
  PERMISSION_DENIED: 403,
  NOT_FOUND: 404,
  RATE_LIMIT: 429,
  UNAVAILABLE: 503,
  INVALID_INPUT: 400,
};

export class GitHubRepositoryError extends Error {
  readonly code: GitHubRepositoryErrorCode;
  readonly status: number;

  constructor(code: GitHubRepositoryErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "GitHubRepositoryError";
    this.code = code;
    this.status = HTTP_STATUS[code];
  }
}

export type GitHubContentPermission = "read" | "write";

export type GitHubInstallation = {
  readonly id: string;
  readonly accountLogin: string;
  readonly accountType: "User" | "Organization";
  readonly repositorySelection: "all" | "selected";
  readonly contentsPermission: GitHubContentPermission | null;
  readonly suspended: boolean;
};

export type GitHubRepository = {
  readonly id: string;
  readonly owner: string;
  readonly name: string;
  readonly fullName: string;
  readonly private: boolean;
  readonly defaultBranch: string | null;
  readonly archived: boolean;
  readonly installationId: string | null;
};

export type GitHubPage<T> = {
  readonly items: T[];
  readonly nextPage: number | null;
};

export type GitHubRepositoryClientOptions = {
  readonly accessToken: string | null | undefined;
  readonly fetcher?: typeof fetch;
};

type RawPage<T> = {
  readonly items: T[];
  readonly nextPage: number | null;
};

type ListedRepository = {
  readonly repository: GitHubRepository;
  readonly userCanRead: boolean;
};

function fail(code: GitHubRepositoryErrorCode): never {
  throw new GitHubRepositoryError(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseId(value: unknown): string | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === "string" && /^\d{1,32}$/.test(value) && /[1-9]/.test(value)) return value;
  return null;
}

function parseOwner(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 39 || !/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(value)) return null;
  return value;
}

function parseRepositoryName(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 100 || value === "." || value === ".." || !/^[A-Za-z0-9._-]+$/.test(value)) return null;
  return value;
}

function parseRepositoryInput(value: unknown): { owner: string; name: string } {
  if (typeof value !== "string" || value.length < 3 || value.length > 2048) return fail("INVALID_INPUT");

  let owner: string | undefined;
  let name: string | undefined;
  const urlMatch = /^https:\/\/github\.com\/([^/?#]+)\/([^/?#]+)$/i.exec(value);
  if (urlMatch) {
    owner = urlMatch[1];
    name = urlMatch[2]?.replace(/\.git$/i, "");
  } else if (!value.includes("://")) {
    const nameMatch = /^([^/]+)\/([^/]+)$/.exec(value);
    if (nameMatch) {
      owner = nameMatch[1];
      name = nameMatch[2];
    }
  }

  const parsedOwner = parseOwner(owner);
  const parsedName = parseRepositoryName(name);
  if (!parsedOwner || !parsedName) return fail("INVALID_INPUT");
  return { owner: parsedOwner, name: parsedName };
}

function parseContentPermission(value: unknown): GitHubContentPermission | null {
  return value === "read" || value === "write" ? value : null;
}

function parseInstallation(value: unknown): GitHubInstallation {
  if (!isRecord(value)) return fail("UNAVAILABLE");
  const id = parseId(value.id);
  const account = value.account;
  const accountLogin = isRecord(account) ? parseOwner(account.login) : null;
  const accountType = isRecord(account) && (account.type === "User" || account.type === "Organization")
    ? account.type
    : null;
  const repositorySelection = value.repository_selection === "all" || value.repository_selection === "selected"
    ? value.repository_selection
    : null;
  const permissions = value.permissions;
  if (!id || !accountLogin || !accountType || !repositorySelection || !isRecord(permissions)) return fail("UNAVAILABLE");
  if (value.suspended_at !== null && typeof value.suspended_at !== "string") return fail("UNAVAILABLE");

  return {
    id,
    accountLogin,
    accountType,
    repositorySelection,
    contentsPermission: parseContentPermission(permissions.contents),
    suspended: value.suspended_at !== null,
  };
}

function parseRepository(value: unknown, installationId: string | null): GitHubRepository {
  if (!isRecord(value)) return fail("UNAVAILABLE");
  const id = parseId(value.id);
  const owner = isRecord(value.owner) ? parseOwner(value.owner.login) : null;
  const name = parseRepositoryName(value.name);
  const defaultBranch = value.default_branch === null
    ? null
    : typeof value.default_branch === "string" && value.default_branch.length > 0 && value.default_branch.length <= 255
      ? value.default_branch
      : undefined;
  if (!id || !owner || !name || typeof value.private !== "boolean" || defaultBranch === undefined || typeof value.archived !== "boolean") {
    return fail("UNAVAILABLE");
  }
  return {
    id,
    owner,
    name,
    fullName: `${owner}/${name}`,
    private: value.private,
    defaultBranch,
    archived: value.archived,
    installationId,
  };
}

function parseNextPage(totalCount: unknown, itemCount: number, page: number): number | null {
  if (typeof totalCount !== "number" || !Number.isSafeInteger(totalCount) || totalCount < itemCount) return fail("UNAVAILABLE");
  if (page >= MAX_PAGE || totalCount <= page * PAGE_SIZE) return null;
  if (itemCount !== PAGE_SIZE) return fail("UNAVAILABLE");
  return page + 1;
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!/^application\/(?:[a-z0-9.+-]*\+)?json(?:\s*;|$)/i.test(contentType)) return fail("UNAVAILABLE");
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_RESPONSE_BYTES)) return fail("UNAVAILABLE");
  if (!response.body) return fail("UNAVAILABLE");

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        return fail("UNAVAILABLE");
      }
      chunks.push(value);
    }
  } catch {
    return fail("UNAVAILABLE");
  }

  try {
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!isRecord(parsed)) return fail("UNAVAILABLE");
    return parsed;
  } catch {
    return fail("UNAVAILABLE");
  }
}

function apiPath(owner: string, name: string): string {
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
}

function validPage(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > MAX_PAGE) return fail("INVALID_INPUT");
  return value;
}

function validInstallationId(value: unknown): string {
  const id = parseId(value);
  if (!id) return fail("INVALID_INPUT");
  return id;
}

function isRateLimited(response: Response): boolean {
  return response.status === 429
    || (response.status === 403 && (
      response.headers.get("x-ratelimit-remaining") === "0"
      || response.headers.has("retry-after")
    ));
}

function throwForResponse(response: Response): never {
  if (isRateLimited(response)) return fail("RATE_LIMIT");
  if (response.status === 401) return fail("AUTH_REQUIRED");
  if (response.status === 403) return fail("PERMISSION_DENIED");
  if (response.status === 404) return fail("NOT_FOUND");
  return fail("UNAVAILABLE");
}

export class GitHubRepositoryClient {
  private readonly accessToken: string | null;
  private readonly fetcher: typeof fetch;
  private readonly deadlineAt: number;
  private requestCount = 0;
  private readonly installationCache = new Map<string, Promise<GitHubInstallation>>();

  constructor(options: GitHubRepositoryClientOptions) {
    this.accessToken = typeof options.accessToken === "string" ? options.accessToken : null;
    this.fetcher = options.fetcher ?? fetch;
    this.deadlineAt = Date.now() + MAX_CLIENT_DURATION_MS;
  }

  async listInstallations(input: { readonly page?: number } = {}): Promise<GitHubPage<GitHubInstallation>> {
    const page = validPage(input.page ?? 1);
    const body = await this.getJson(`/user/installations?per_page=${PAGE_SIZE}&page=${page}`, true);
    if (!Array.isArray(body.installations) || body.installations.length > PAGE_SIZE) return fail("UNAVAILABLE");
    const items = body.installations.map(parseInstallation);
    return { items, nextPage: parseNextPage(body.total_count, items.length, page) };
  }

  async listInstallationRepositories(
    installationId: string,
    input: { readonly page?: number } = {},
  ): Promise<GitHubPage<GitHubRepository>> {
    const page = validPage(input.page ?? 1);
    const id = validInstallationId(installationId);
    const installation = await this.findAccessibleInstallation(id);
    if (installation.suspended || installation.contentsPermission === null) return fail("PERMISSION_DENIED");
    const listed = await this.listInstallationRepositoriesInternal(id, page);
    return { items: listed.items.filter((item) => item.userCanRead).map((item) => item.repository), nextPage: listed.nextPage };
  }

  async resolveRepository(input: string): Promise<GitHubRepository> {
    const { owner, name } = parseRepositoryInput(input);
    const path = apiPath(owner, name);
    const publicResponse = await this.request(path, false);
    if (publicResponse.status === 200) {
      const repository = parseRepository(await readJson(publicResponse), null);
      if (!repository.private) return repository;
    } else if (publicResponse.status !== 404) {
      return throwForResponse(publicResponse);
    }

    const installations = await this.readAllInstallationsForResolution();
    const wantedFullName = `${owner}/${name}`.toLocaleLowerCase("en-US");
    let sawRepository = false;
    let sawIncompleteScan = false;
    let sawScopedFailure = false;

    for (const installation of installations) {
      if (installation.suspended || installation.contentsPermission === null) continue;
      const scan = await this.readInstallationRepositoriesForResolution(installation.id);
      if (!scan.complete) sawIncompleteScan = true;
      if (scan.scopedFailure) sawScopedFailure = true;
      for (const listed of scan.items) {
        if (listed.repository.fullName.toLocaleLowerCase("en-US") !== wantedFullName) continue;
        sawRepository = true;
        if (listed.repository.private && listed.userCanRead) {
          return { ...listed.repository, installationId: installation.id };
        }
      }
    }

    if (sawIncompleteScan) return fail("UNAVAILABLE");
    if (sawScopedFailure) return fail("UNAVAILABLE");
    if (sawRepository) return fail("PERMISSION_DENIED");
    return fail("NOT_FOUND");
  }

  private async readAllInstallationsForResolution(): Promise<GitHubInstallation[]> {
    const items: GitHubInstallation[] = [];
    let page = 1;
    for (let count = 0; count < MAX_RESOLVE_PAGES; count++) {
      const result = await this.listInstallations({ page });
      items.push(...result.items);
      if (result.nextPage === null) return items;
      page = result.nextPage;
    }
    return fail("UNAVAILABLE");
  }

  private async findAccessibleInstallation(installationId: string): Promise<GitHubInstallation> {
    const cached = this.installationCache.get(installationId);
    if (cached) return cached;
    const pending = (async () => {
      let page = 1;
      for (let count = 0; count < MAX_RESOLVE_PAGES; count++) {
        const result = await this.listInstallations({ page });
        const installation = result.items.find((item) => item.id === installationId);
        if (installation) return installation;
        if (result.nextPage === null) return fail("PERMISSION_DENIED");
        page = result.nextPage;
      }
      return fail("UNAVAILABLE");
    })();
    this.installationCache.set(installationId, pending);
    try {
      return await pending;
    } catch (error) {
      this.installationCache.delete(installationId);
      throw error;
    }
  }

  private async readInstallationRepositoriesForResolution(installationId: string): Promise<{
    readonly items: ListedRepository[];
    readonly complete: boolean;
    readonly scopedFailure: boolean;
  }> {
    const items: ListedRepository[] = [];
    let page = 1;
    for (let count = 0; count < MAX_RESOLVE_PAGES; count++) {
      let result: RawPage<ListedRepository>;
      try {
        result = await this.listInstallationRepositoriesInternal(installationId, page);
      } catch (error) {
        if (error instanceof GitHubRepositoryError && (error.code === "PERMISSION_DENIED" || error.code === "NOT_FOUND")) {
          return { items, complete: false, scopedFailure: true };
        }
        throw error;
      }
      items.push(...result.items);
      if (result.nextPage === null) return { items, complete: true, scopedFailure: false };
      page = result.nextPage;
    }
    return { items, complete: false, scopedFailure: false };
  }

  private async listInstallationRepositoriesInternal(installationId: string, page: number): Promise<RawPage<ListedRepository>> {
    const body = await this.getJson(`/user/installations/${encodeURIComponent(installationId)}/repositories?per_page=${PAGE_SIZE}&page=${page}`, true);
    if (!Array.isArray(body.repositories) || body.repositories.length > PAGE_SIZE) return fail("UNAVAILABLE");
    const items = body.repositories.map((value): ListedRepository => {
      if (!isRecord(value) || !isRecord(value.permissions)) return fail("UNAVAILABLE");
      return {
        repository: parseRepository(value, installationId),
        userCanRead: value.permissions.pull === true,
      };
    });
    return { items, nextPage: parseNextPage(body.total_count, items.length, page) };
  }

  private async getJson(path: string, authenticated: boolean): Promise<Record<string, unknown>> {
    const response = await this.request(path, authenticated);
    if (response.status !== 200) return throwForResponse(response);
    return readJson(response);
  }

  private async request(path: string, authenticated: boolean): Promise<Response> {
    const token = this.accessToken;
    if (authenticated && (!token || token.length > 4096 || !/^[\x21-\x7e]+$/.test(token))) return fail("AUTH_REQUIRED");
    if (this.requestCount >= MAX_REQUESTS_PER_CLIENT) return fail("UNAVAILABLE");
    const remainingMs = this.deadlineAt - Date.now();
    if (remainingMs <= 0) return fail("UNAVAILABLE");
    this.requestCount++;

    const headers = new Headers({
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": API_VERSION,
    });
    if (authenticated && token) headers.set("Authorization", `Bearer ${token}`);

    try {
      return await this.fetcher(`${API_ORIGIN}${path}`, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(Math.min(REQUEST_TIMEOUT_MS, remainingMs)),
        cache: "no-store",
        redirect: "error",
      });
    } catch {
      return fail("UNAVAILABLE");
    }
  }
}
