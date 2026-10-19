import assert from "node:assert/strict";
import test from "node:test";
import {
  GitHubRepositoryClient,
  GitHubRepositoryError,
  type GitHubRepositoryErrorCode,
} from "../apps/web/lib/github/client.ts";

const api = "https://api.github.com";
const token = "ghu_test_secret_token";

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/vnd.github+json", ...headers },
  });
}

function repository(overrides: Record<string, unknown> = {}) {
  return {
    id: 314,
    name: "private-repo",
    full_name: "private-org/private-repo",
    private: true,
    owner: { login: "private-org", type: "Organization" },
    default_branch: "main",
    archived: false,
    permissions: { pull: true, push: false },
    ...overrides,
  };
}

function installation(overrides: Record<string, unknown> = {}) {
  return {
    id: 271,
    account: { login: "private-org", type: "Organization" },
    repository_selection: "selected",
    permissions: { metadata: "read", contents: "read" },
    suspended_at: null,
    ...overrides,
  };
}

function errorCode(error: unknown, code: GitHubRepositoryErrorCode, status: number): void {
  assert.ok(error instanceof GitHubRepositoryError);
  assert.equal(error.code, code);
  assert.equal(error.status, status);
  assert.match(error.message, /[\u0900-\u097f\u00c0-\u024f\u0100-\u017f\u0020-\u007e]/);
}

test("public repository resolution uses an unauthenticated fixed GitHub API request", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(input), init });
    return json({
      ...repository({ private: false }),
      extra_private_field: "must not escape",
    });
  }) as typeof fetch;
  const client = new GitHubRepositoryClient({ accessToken: token, fetcher });

  const result = await client.resolveRepository("https://github.com/private-org/private-repo.git");

  assert.equal(result.fullName, "private-org/private-repo");
  assert.equal(result.private, false);
  assert.equal(result.installationId, null);
  assert.deepEqual(Object.keys(result).sort(), ["archived", "defaultBranch", "fullName", "id", "installationId", "name", "owner", "private"].sort());
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.url, `${api}/repos/private-org/private-repo`);
  assert.equal(requests[0]?.init?.method, "GET");
  assert.equal(requests[0]?.init?.redirect, "error");
  assert.equal(requests[0]?.init?.cache, "no-store");
  const headers = new Headers(requests[0]?.init?.headers);
  assert.equal(headers.get("Authorization"), null);
  assert.equal(headers.get("Accept"), "application/vnd.github+json");
  assert.equal(headers.get("X-GitHub-Api-Version"), "2026-03-10");
});

test("installation pages are bounded and return sanitized installation metadata", async () => {
  let requestUrl = "";
  let requestHeaders = new Headers();
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requestUrl = String(input);
    requestHeaders = new Headers(init?.headers);
    assert.equal(init?.redirect, "error");
    return json({
      total_count: 31,
      installations: Array.from({ length: 30 }, (_, index) => installation({
        id: 271 + index,
        app_slug: "private-app",
        access_tokens_url: "https://evil.test",
      })),
    });
  }) as typeof fetch;
  const client = new GitHubRepositoryClient({ accessToken: token, fetcher });

  const page = await client.listInstallations({ page: 1 });

  assert.equal(requestUrl, `${api}/user/installations?per_page=30&page=1`);
  assert.equal(page.items.length, 30);
  assert.deepEqual(page.items[0], {
    id: "271",
    accountLogin: "private-org",
    accountType: "Organization",
    repositorySelection: "selected",
    contentsPermission: "read",
    suspended: false,
  });
  assert.equal(page.nextPage, 2);
  assert.equal(requestHeaders.get("Authorization"), `Bearer ${token}`);
});

test("installation repository listing authenticates and exposes only repository metadata", async () => {
  const requests: Array<{ url: string; headers: Headers }> = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, headers: new Headers(init?.headers) });
    if (url === `${api}/user/installations?per_page=30&page=1`) return json({ total_count: 1, installations: [installation()] });
    if (url === `${api}/user/installations/271/repositories?per_page=30&page=4`) {
      return json({
        total_count: 2,
        repositories: [
          repository({ permissions: { pull: true, push: false }, secret: "hidden" }),
          repository({
            id: 315,
            name: "no-user-access",
            full_name: "private-org/no-user-access",
            permissions: { pull: false, push: false },
          }),
        ],
      });
    }
    throw new Error("unexpected request");
  }) as typeof fetch;
  const client = new GitHubRepositoryClient({ accessToken: token, fetcher });

  const page = await client.listInstallationRepositories("271", { page: 4 });

  assert.deepEqual(requests.map((request) => request.url), [
    `${api}/user/installations?per_page=30&page=1`,
    `${api}/user/installations/271/repositories?per_page=30&page=4`,
  ]);
  assert.equal(requests[0]?.headers.get("Authorization"), `Bearer ${token}`);
  assert.equal(requests[1]?.headers.get("Authorization"), `Bearer ${token}`);
  assert.equal(requests[1]?.headers.get("X-GitHub-Api-Version"), "2026-03-10");
  assert.deepEqual(page, {
    items: [{
      id: "314",
      owner: "private-org",
      name: "private-repo",
      fullName: "private-org/private-repo",
      private: true,
      defaultBranch: "main",
      archived: false,
      installationId: "271",
    }],
    nextPage: null,
  });
});

test("private repository resolution requires an active app installation, contents access, and user pull access", async () => {
  const requests: Array<{ url: string; headers: Headers }> = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, headers: new Headers(init?.headers) });
    if (url === `${api}/repos/private-org/private-repo`) return json({ message: "Not Found" }, 404);
    if (url === `${api}/user/installations?per_page=30&page=1`) return json({ total_count: 1, installations: [installation({ permissions: { metadata: "read", contents: "write" } })] });
    if (url === `${api}/user/installations/271/repositories?per_page=30&page=1`) return json({ total_count: 1, repositories: [repository()] });
    throw new Error("unexpected request");
  }) as typeof fetch;
  const client = new GitHubRepositoryClient({ accessToken: token, fetcher });

  const result = await client.resolveRepository("private-org/private-repo");

  assert.equal(result.private, true);
  assert.equal(result.installationId, "271");
  assert.equal(result.id, "314");
  assert.equal(requests.length, 3);
  assert.equal(requests[0]?.headers.get("Authorization"), null);
  assert.equal(requests[1]?.headers.get("Authorization"), `Bearer ${token}`);
  assert.equal(requests[2]?.headers.get("Authorization"), `Bearer ${token}`);
});

test("private repository resolution denies metadata-only apps and users without pull access", async (t) => {
  for (const scenario of [
    { name: "app lacks contents permission", contents: undefined, pull: true, code: "NOT_FOUND" as const, status: 404 },
    { name: "user lacks pull permission", contents: "read", pull: false, code: "PERMISSION_DENIED" as const, status: 403 },
  ]) {
    await t.test(scenario.name, async () => {
      const fetcher = (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === `${api}/repos/private-org/private-repo`) return json({ message: "Not Found" }, 404);
        if (url === `${api}/user/installations?per_page=30&page=1`) {
          const permissions = scenario.contents === undefined ? { metadata: "read" } : { metadata: "read", contents: scenario.contents };
          return json({ total_count: 1, installations: [installation({ permissions })] });
        }
        return json({ total_count: 1, repositories: [repository({ permissions: { pull: scenario.pull } })] });
      }) as typeof fetch;
      const client = new GitHubRepositoryClient({ accessToken: token, fetcher });

      await assert.rejects(client.resolveRepository("private-org/private-repo"), (error: unknown) => {
        errorCode(error, scenario.code, scenario.status);
        return true;
      });
    });
  }
});

test("private resolution skips suspended and metadata-only installations", async () => {
  const requestedRepositoryInstallations: string[] = [];
  const fetcher = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === `${api}/repos/private-org/private-repo`) return json({ message: "Not Found" }, 404);
    if (url === `${api}/user/installations?per_page=30&page=1`) {
      return json({
        total_count: 3,
        installations: [
          installation({ id: 271, permissions: { metadata: "read" } }),
          installation({ id: 272, suspended_at: "2026-10-18T00:00:00Z" }),
          installation({ id: 273 }),
        ],
      });
    }
    const repositoriesPrefix = `${api}/user/installations/`;
    if (url.startsWith(repositoriesPrefix)) {
      const id = url.slice(repositoriesPrefix.length).split("/")[0];
      requestedRepositoryInstallations.push(id ?? "");
      if (id === "273") return json({ total_count: 1, repositories: [repository()] });
    }
    throw new Error("unexpected request");
  }) as typeof fetch;
  const client = new GitHubRepositoryClient({ accessToken: token, fetcher });

  const result = await client.resolveRepository("private-org/private-repo");

  assert.equal(result.installationId, "273");
  assert.deepEqual(requestedRepositoryInstallations, ["273"]);
});

test("private resolution continues after a scoped installation permission failure", async () => {
  const requestedRepositoryInstallations: string[] = [];
  const fetcher = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === `${api}/repos/private-org/private-repo`) return json({ message: "Not Found" }, 404);
    if (url === `${api}/user/installations?per_page=30&page=1`) {
      return json({
        total_count: 2,
        installations: [installation({ id: 271 }), installation({ id: 272 })],
      });
    }
    if (url === `${api}/user/installations/271/repositories?per_page=30&page=1`) {
      requestedRepositoryInstallations.push("271");
      return json({ message: "Installation access changed" }, 403);
    }
    if (url === `${api}/user/installations/272/repositories?per_page=30&page=1`) {
      requestedRepositoryInstallations.push("272");
      return json({ total_count: 1, repositories: [repository()] });
    }
    throw new Error("unexpected request");
  }) as typeof fetch;
  const client = new GitHubRepositoryClient({ accessToken: token, fetcher });

  const result = await client.resolveRepository("private-org/private-repo");

  assert.equal(result.installationId, "272");
  assert.deepEqual(requestedRepositoryInstallations, ["271", "272"]);
});

test("private repository resolution does not claim an inaccessible repository exists", async () => {
  const fetcher = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === `${api}/repos/unknown-org/unknown-repo`) return json({ message: "Not Found" }, 404);
    if (url === `${api}/user/installations?per_page=30&page=1`) return json({ total_count: 0, installations: [] });
    throw new Error("unexpected request");
  }) as typeof fetch;
  const client = new GitHubRepositoryClient({ accessToken: token, fetcher });

  await assert.rejects(client.resolveRepository("unknown-org/unknown-repo"), (error: unknown) => {
    errorCode(error, "NOT_FOUND", 404);
    return true;
  });
});

test("invalid repository inputs never reach the network", async () => {
  let calls = 0;
  const client = new GitHubRepositoryClient({
    accessToken: token,
    fetcher: (async () => {
      calls++;
      return json({});
    }) as typeof fetch,
  });

  for (const input of [
    "https://github.com.evil.test/octo/repo",
    "http://github.com/octo/repo",
    "https://user:pass@github.com/octo/repo",
    "https://github.com:443/octo/repo",
    "https://github.com/octo/repo?tab=readme",
    "https://github.com/octo/repo/tree/main",
    "https://github.com/octo%2Fevil/repo",
    "octo/repo/extra",
    "../repo",
    "octo/..",
    "octo /repo",
  ]) {
    await assert.rejects(client.resolveRepository(input), (error: unknown) => {
      errorCode(error, "INVALID_INPUT", 400);
      return true;
    }, input);
  }
  assert.equal(calls, 0);
});

test("API errors map to safe typed errors without exposing response bodies or tokens", async (t) => {
  const cases: Array<{ name: string; status: number; headers?: Record<string, string>; code: GitHubRepositoryErrorCode; mappedStatus: number }> = [
    { name: "401", status: 401, code: "AUTH_REQUIRED", mappedStatus: 401 },
    { name: "403", status: 403, code: "PERMISSION_DENIED", mappedStatus: 403 },
    { name: "404", status: 404, code: "NOT_FOUND", mappedStatus: 404 },
    { name: "429", status: 429, code: "RATE_LIMIT", mappedStatus: 429 },
    { name: "403 rate limit", status: 403, headers: { "X-RateLimit-Remaining": "0" }, code: "RATE_LIMIT", mappedStatus: 429 },
    { name: "500", status: 500, code: "UNAVAILABLE", mappedStatus: 503 },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const privateDetails = `provider detail ${token}`;
      const client = new GitHubRepositoryClient({
        accessToken: token,
        fetcher: (async () => json({ message: privateDetails }, scenario.status, scenario.headers)) as typeof fetch,
      });
      await assert.rejects(client.listInstallations(), (error: unknown) => {
        errorCode(error, scenario.code, scenario.mappedStatus);
        assert.ok(error instanceof GitHubRepositoryError);
        assert.doesNotMatch(error.message, /provider detail|ghu_test_secret_token/);
        return true;
      });
    });
  }
});

test("redirects, malformed JSON, oversized bodies, missing tokens, and transport failures fail safely", async (t) => {
  await t.test("redirect response", async () => {
    const client = new GitHubRepositoryClient({ accessToken: token, fetcher: (async () => new Response(null, { status: 302, headers: { Location: "https://evil.test" } })) as typeof fetch });
    await assert.rejects(client.listInstallations(), (error: unknown) => {
      errorCode(error, "UNAVAILABLE", 503);
      return true;
    });
  });

  await t.test("oversized JSON response", async () => {
    const client = new GitHubRepositoryClient({
      accessToken: token,
      fetcher: (async () => new Response("{}", { status: 200, headers: { "Content-Type": "application/json", "Content-Length": "2097153" } })) as typeof fetch,
    });
    await assert.rejects(client.listInstallations(), (error: unknown) => {
      errorCode(error, "UNAVAILABLE", 503);
      return true;
    });
  });

  await t.test("malformed JSON response", async () => {
    const client = new GitHubRepositoryClient({ accessToken: token, fetcher: (async () => new Response("not-json", { status: 200, headers: { "Content-Type": "application/json" } })) as typeof fetch });
    await assert.rejects(client.listInstallations(), (error: unknown) => {
      errorCode(error, "UNAVAILABLE", 503);
      return true;
    });
  });

  await t.test("missing user access token", async () => {
    const client = new GitHubRepositoryClient({ accessToken: null, fetcher: (async () => json({})) as typeof fetch });
    await assert.rejects(client.listInstallations(), (error: unknown) => {
      errorCode(error, "AUTH_REQUIRED", 401);
      return true;
    });
  });

  await t.test("transport error", async () => {
    const client = new GitHubRepositoryClient({ accessToken: token, fetcher: (async () => { throw new Error(`network ${token}`); }) as typeof fetch });
    await assert.rejects(client.listInstallations(), (error: unknown) => {
      errorCode(error, "UNAVAILABLE", 503);
      assert.ok(error instanceof GitHubRepositoryError);
      assert.doesNotMatch(error.message, /network|ghu_test_secret_token/);
      return true;
    });
  });
});

test("each client enforces a shared GitHub request budget", async () => {
  let calls = 0;
  const client = new GitHubRepositoryClient({
    accessToken: token,
    fetcher: (async () => {
      calls++;
      return json({ total_count: 0, installations: [] });
    }) as typeof fetch,
  });

  for (let index = 0; index < 30; index++) await client.listInstallations();
  await assert.rejects(client.listInstallations(), (error: unknown) => {
    errorCode(error, "UNAVAILABLE", 503);
    return true;
  });
  assert.equal(calls, 30);
});
