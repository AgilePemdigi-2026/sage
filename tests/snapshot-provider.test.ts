import assert from "node:assert/strict";
import test from "node:test";
import { fetchRepositoryArchive } from "../packages/github/archive.ts";
import { GitHubRepositoryError, type GitHubRepositoryErrorCode } from "../packages/github/client.ts";

const api = "https://api.github.com";
const codeload = "https://codeload.github.com";
const token = "ghu_snapshot_test_secret";
const sha = "a".repeat(40);
const archiveBytes = new Uint8Array([31, 139, 8, 0, 1, 2, 3]);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/vnd.github+json" },
  });
}

function publicRepository(overrides: Record<string, unknown> = {}) {
  return {
    id: 100,
    name: "repo",
    full_name: "open-org/repo",
    private: false,
    owner: { login: "open-org", type: "Organization" },
    default_branch: "main",
    archived: false,
    ...overrides,
  };
}

function privateRepository(overrides: Record<string, unknown> = {}) {
  return {
    id: 200,
    name: "repo",
    full_name: "secret-org/repo",
    private: true,
    owner: { login: "secret-org", type: "Organization" },
    default_branch: "main",
    archived: false,
    permissions: { pull: true, push: false },
    ...overrides,
  };
}

function installation() {
  return {
    id: 271,
    account: { login: "secret-org", type: "Organization" },
    repository_selection: "selected",
    permissions: { metadata: "read", contents: "read" },
    suspended_at: null,
  };
}

function errorCode(error: unknown, code: GitHubRepositoryErrorCode, status: number): void {
  assert.ok(error instanceof GitHubRepositoryError);
  assert.equal(error.code, code);
  assert.equal(error.status, status);
  assert.doesNotMatch(error.message, /ghu_snapshot_test_secret|signed-codeload-secret/);
}

function publicFetcher(
  handler: (url: URL, init: RequestInit | undefined) => Response | Promise<Response>,
  repositoryOverrides: Record<string, unknown> = {},
) {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    requests.push({ url: `${url.origin}${url.pathname}`, init });
    if (url.origin === api && url.pathname === "/repos/open-org/repo" && url.search === "") {
      return json(publicRepository(repositoryOverrides));
    }
    return handler(url, init);
  }) as typeof fetch;
  return { fetcher, requests };
}

function privateFetcher(handler: (url: URL, init: RequestInit | undefined) => Response | Promise<Response>) {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    requests.push({ url: `${url.origin}${url.pathname}`, init });
    if (url.origin === api && url.pathname === "/repos/secret-org/repo" && url.search === "") return json({ message: "Not Found" }, 404);
    if (url.origin === api && url.pathname === "/user/installations" && url.search === "?per_page=30&page=1") {
      return json({ total_count: 1, installations: [installation()] });
    }
    if (url.origin === api && url.pathname === "/user/installations/271/repositories" && url.search === "?per_page=30&page=1") {
      return json({ total_count: 1, repositories: [privateRepository()] });
    }
    return handler(url, init);
  }) as typeof fetch;
  return { fetcher, requests };
}

test("public archive fetch rechecks repository identity and downloads only the immutable requested SHA", async () => {
  const apiPath = `/repos/open-org/repo/tarball/${sha}`;
  const location = `${codeload}/open-org/repo/legacy.tar.gz/${sha}`;
  const { fetcher, requests } = publicFetcher((url, init) => {
    if (url.origin === api && url.pathname === apiPath) {
      assert.equal(init?.method, "GET");
      assert.equal(init?.redirect, "manual");
      assert.equal(new Headers(init?.headers).get("X-GitHub-Api-Version"), "2026-03-10");
      assert.equal(new Headers(init?.headers).get("Authorization"), null);
      return new Response(null, { status: 302, headers: { Location: location } });
    }
    if (url.origin === codeload && url.pathname === `/open-org/repo/legacy.tar.gz/${sha}`) {
      assert.equal(init?.redirect, "error");
      assert.equal(new Headers(init?.headers).get("Authorization"), null);
      return new Response(archiveBytes);
    }
    throw new Error("unexpected provider request");
  }, { default_branch: "branch-that-moved" });

  const bytes = await fetchRepositoryArchive({
    repository: "open-org/repo",
    githubRepositoryId: "100",
    commitSha: sha,
    accessToken: token,
    fetcher,
  });

  assert.deepEqual(bytes, archiveBytes);
  assert.deepEqual(requests.map(({ url }) => new URL(url).pathname), [
    "/repos/open-org/repo",
    apiPath,
    `/open-org/repo/legacy.tar.gz/${sha}`,
  ]);
  assert.equal(new URL(requests[1]!.url).pathname, apiPath);
  assert.equal(new Headers(requests[0]?.init?.headers).get("Authorization"), null);
  assert.equal(new Headers(requests[1]?.init?.headers).get("Authorization"), null);
  assert.equal(new Headers(requests[2]?.init?.headers).get("Authorization"), null);
});

test("private archive fetch verifies current Contents access and sends the user token only to api.github.com", async () => {
  const apiPath = `/repos/secret-org/repo/tarball/${sha}`;
  const location = `${codeload}/secret-org/repo/legacy.tar.gz/${sha}?token=signed-codeload-secret`;
  const { fetcher, requests } = privateFetcher((url, init) => {
    if (url.origin === api && url.pathname === apiPath) {
      assert.equal(init?.redirect, "manual");
      assert.equal(new Headers(init?.headers).get("Authorization"), `Bearer ${token}`);
      return new Response(null, { status: 302, headers: { Location: location } });
    }
    if (url.origin === codeload) {
      assert.equal(url.pathname, `/secret-org/repo/legacy.tar.gz/${sha}`);
      assert.equal(url.searchParams.has("token"), true);
      assert.equal(new Headers(init?.headers).get("Authorization"), null);
      assert.equal(new Headers(init?.headers).has("X-GitHub-Api-Version"), false);
      return new Response(archiveBytes);
    }
    throw new Error("unexpected provider request");
  });

  const bytes = await fetchRepositoryArchive({
    repository: "secret-org/repo",
    githubRepositoryId: "200",
    commitSha: sha,
    accessToken: token,
    fetcher,
  });

  assert.deepEqual(bytes, archiveBytes);
  assert.equal(requests.length, 5);
  assert.deepEqual(requests.slice(0, 4).map(({ init }) => new Headers(init?.headers).get("Authorization")), [
    null,
    `Bearer ${token}`,
    `Bearer ${token}`,
    `Bearer ${token}`,
  ]);
  assert.equal(new Headers(requests[4]?.init?.headers).get("Authorization"), null);
});

test("repository ID mismatch prevents archive access, even when the name resolves", async () => {
  const { fetcher, requests } = publicFetcher(() => {
    throw new Error("archive must not be requested");
  });

  await assert.rejects(fetchRepositoryArchive({
    repository: "open-org/repo",
    githubRepositoryId: "999",
    commitSha: sha,
    accessToken: token,
    fetcher,
  }), (error: unknown) => {
    errorCode(error, "NOT_FOUND", 404);
    return true;
  });
  assert.equal(requests.length, 1);
});

test("private archives fail closed when current user pull access has been revoked", async () => {
  const { fetcher, requests } = privateFetcher((url) => {
    if (url.origin === api && url.pathname === `/repos/secret-org/repo/tarball/${sha}`) {
      throw new Error("archive must not be requested");
    }
    throw new Error("unexpected provider request");
  });
  const originalFetcher = fetcher;
  const revokedFetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.origin === api && url.pathname === "/user/installations/271/repositories" && url.search === "?per_page=30&page=1") {
      requests.push({ url: `${url.origin}${url.pathname}`, init });
      return json({ total_count: 1, repositories: [privateRepository({ permissions: { pull: false, push: false } })] });
    }
    return originalFetcher(input, init);
  }) as typeof fetch;

  await assert.rejects(fetchRepositoryArchive({
    repository: "secret-org/repo",
    githubRepositoryId: "200",
    commitSha: sha,
    accessToken: token,
    fetcher: revokedFetcher,
  }), (error: unknown) => {
    errorCode(error, "PERMISSION_DENIED", 403);
    return true;
  });
  assert.equal(requests.some(({ url }) => new URL(url).pathname === `/repos/secret-org/repo/tarball/${sha}`), false);
});

test("only the observed codeload HTTPS host and exact repository/SHA path are accepted", async (t) => {
  const invalidLocations = [
    `https://attacker.test/open-org/repo/legacy.tar.gz/${sha}`,
    `http://codeload.github.com/open-org/repo/legacy.tar.gz/${sha}`,
    `https://codeload.github.com/other-org/repo/legacy.tar.gz/${sha}`,
    `https://codeload.github.com/open-org/other/legacy.tar.gz/${sha}`,
    `https://codeload.github.com/open-org/repo/legacy.tar.gz/${"b".repeat(40)}`,
    `https://user@codeload.github.com/open-org/repo/legacy.tar.gz/${sha}`,
    `https://codeload.github.com.evil.test/open-org/repo/legacy.tar.gz/${sha}`,
  ];
  for (const location of invalidLocations) {
    await t.test(new URL(location).hostname, async () => {
      let codeloadRequests = 0;
      const { fetcher } = publicFetcher((url) => {
        if (url.origin === api && url.pathname === `/repos/open-org/repo/tarball/${sha}`) {
          return new Response(null, { status: 302, headers: { Location: location } });
        }
        if (url.hostname === "codeload.github.com") codeloadRequests++;
        throw new Error("unexpected provider request");
      });
      await assert.rejects(fetchRepositoryArchive({
        repository: "open-org/repo",
        githubRepositoryId: "100",
        commitSha: sha,
        accessToken: token,
        fetcher,
      }), (error: unknown) => {
        errorCode(error, "UNAVAILABLE", 503);
        return true;
      });
      assert.equal(codeloadRequests, 0);
    });
  }
});

test("archive body is bounded by both declared and streamed byte counts", async (t) => {
  await t.test("declared size", async () => {
    const { fetcher } = publicFetcher((url) => {
      if (url.pathname === `/repos/open-org/repo/tarball/${sha}`) {
        return new Response(null, { status: 302, headers: { Location: `${codeload}/open-org/repo/legacy.tar.gz/${sha}` } });
      }
      if (url.origin === codeload) return new Response(archiveBytes, { headers: { "Content-Length": "9" } });
      throw new Error("unexpected provider request");
    });
    await assert.rejects(fetchRepositoryArchive({
      repository: "open-org/repo",
      githubRepositoryId: "100",
      commitSha: sha,
      accessToken: token,
      maxArchiveBytes: 8,
      fetcher,
    }), (error: unknown) => {
      errorCode(error, "UNAVAILABLE", 503);
      return true;
    });
  });

  await t.test("streamed size without Content-Length", async () => {
    const { fetcher } = publicFetcher((url) => {
      if (url.pathname === `/repos/open-org/repo/tarball/${sha}`) {
        return new Response(null, { status: 302, headers: { Location: `${codeload}/open-org/repo/legacy.tar.gz/${sha}` } });
      }
      if (url.origin === codeload) return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(5));
          controller.enqueue(new Uint8Array(5));
          controller.close();
        },
      }));
      throw new Error("unexpected provider request");
    });
    await assert.rejects(fetchRepositoryArchive({
      repository: "open-org/repo",
      githubRepositoryId: "100",
      commitSha: sha,
      accessToken: token,
      maxArchiveBytes: 8,
      fetcher,
    }), (error: unknown) => {
      errorCode(error, "UNAVAILABLE", 503);
      return true;
    });
  });
});

test("external cancellation and the operation deadline interrupt archive fetches safely", async (t) => {
  for (const mode of ["external", "timeout"] as const) {
    await t.test(mode, async () => {
      const controller = new AbortController();
      const { fetcher } = publicFetcher((url, init) => {
        if (url.pathname === `/repos/open-org/repo/tarball/${sha}`) {
          return new Response(null, { status: 302, headers: { Location: `${codeload}/open-org/repo/legacy.tar.gz/${sha}` } });
        }
        if (url.origin === codeload) {
          if (mode === "external") queueMicrotask(() => controller.abort());
          const signal = init?.signal;
          return new Promise<Response>((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(new Error(token)), { once: true });
          });
        }
        throw new Error("unexpected provider request");
      });

      await assert.rejects(fetchRepositoryArchive({
        repository: "open-org/repo",
        githubRepositoryId: "100",
        commitSha: sha,
        accessToken: token,
        signal: mode === "external" ? controller.signal : undefined,
        timeoutMs: mode === "timeout" ? 20 : 1_000,
        fetcher,
      }), (error: unknown) => {
        errorCode(error, "UNAVAILABLE", 503);
        return true;
      });
    });
  }
});

test("invalid archive identities and configured limits are rejected without network access", async () => {
  let calls = 0;
  const fetcher = (async () => {
    calls++;
    return json(publicRepository());
  }) as typeof fetch;
  for (const input of [
    { repository: "open-org/repo", githubRepositoryId: "0", commitSha: sha },
    { repository: "open-org/repo", githubRepositoryId: "100", commitSha: "a".repeat(39) },
    { repository: "open-org/repo", githubRepositoryId: "100", commitSha: "g".repeat(40) },
    { repository: "open-org/repo", githubRepositoryId: "100", commitSha: sha, maxArchiveBytes: 0 },
    { repository: "open-org/repo", githubRepositoryId: "100", commitSha: sha, maxArchiveBytes: 25 * 1024 * 1024 + 1 },
    { repository: "open-org/repo", githubRepositoryId: "100", commitSha: sha, timeoutMs: 60_001 },
  ]) {
    await assert.rejects(fetchRepositoryArchive({ ...input, accessToken: token, fetcher }), (error: unknown) => {
      errorCode(error, "INVALID_INPUT", 400);
      return true;
    });
  }
  assert.equal(calls, 0);
});

test("provider failures are mapped to safe errors without exposing raw response bodies", async () => {
  const { fetcher } = publicFetcher((url) => {
    if (url.pathname === `/repos/open-org/repo/tarball/${sha}`) return new Response(token, { status: 500 });
    throw new Error("unexpected provider request");
  });

  await assert.rejects(fetchRepositoryArchive({
    repository: "open-org/repo",
    githubRepositoryId: "100",
    commitSha: sha,
    accessToken: token,
    fetcher,
  }), (error: unknown) => {
    errorCode(error, "UNAVAILABLE", 503);
    return true;
  });
});
