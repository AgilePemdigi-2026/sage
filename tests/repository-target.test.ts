import assert from "node:assert/strict";
import test from "node:test";
import {
  GitHubRepositoryClient,
  GitHubRepositoryError,
  type GitHubRepositoryErrorCode,
} from "../apps/web/lib/github/client.ts";

const api = "https://api.github.com";
const token = "ghu_target_test_secret";
const publicSha = "a".repeat(40);

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/vnd.github+json", ...headers },
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
  assert.doesNotMatch(error.message, /ghu_target_test_secret/);
}

function publicClient(handler: (url: URL, init: RequestInit | undefined) => Response | Promise<Response>) {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    requests.push({ url: url.toString(), init });
    if (url.pathname === "/repos/open-org/repo" && url.search === "") return json(publicRepository());
    return handler(url, init);
  }) as typeof fetch;
  return { client: new GitHubRepositoryClient({ accessToken: token, fetcher }), requests };
}

function privateClient(handler: (url: URL, init: RequestInit | undefined) => Response | Promise<Response>) {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    requests.push({ url: url.toString(), init });
    if (url.pathname === "/repos/secret-org/repo" && url.search === "") return json({ message: "Not Found" }, 404);
    if (url.pathname === "/user/installations" && url.search === "?per_page=30&page=1") return json({ total_count: 1, installations: [installation()] });
    if (url.pathname === "/user/installations/271/repositories" && url.search === "?per_page=30&page=1") {
      return json({ total_count: 1, repositories: [privateRepository()] });
    }
    return handler(url, init);
  }) as typeof fetch;
  return { client: new GitHubRepositoryClient({ accessToken: token, fetcher }), requests };
}

test("public branch listing uses the actual branches endpoint without a user token", async () => {
  const branch = "feature/ref/日本語";
  const path = "/repos/open-org/repo/branches";
  const { client, requests } = publicClient((url) => {
    if (url.pathname === path) {
      return json([
        { name: branch, commit: { sha: publicSha }, protected: true, protection_url: "private" },
        { name: "main", commit: { sha: "b".repeat(40) } },
      ], 200, { Link: `<${api}/repositories/100/branches?per_page=30&page=2>; rel="next"` });
    }
    throw new Error("unexpected request");
  });

  const page = await client.listBranches("open-org/repo", { page: 1 });

  assert.deepEqual(page, {
    items: [
      { name: branch, commitSha: publicSha },
      { name: "main", commitSha: "b".repeat(40) },
    ],
    nextPage: 2,
  });
  assert.equal(requests.length, 2);
  assert.equal(new Headers(requests[0]?.init?.headers).get("Authorization"), null);
  assert.equal(new Headers(requests[1]?.init?.headers).get("Authorization"), null);
  assert.equal(requests[1]?.url, `${api}${path}?per_page=30&page=1`);
});

test("branch pagination falls back to a full array when GitHub omits Link metadata", async () => {
  const path = "/repos/open-org/repo/branches";
  const branches = Array.from({ length: 30 }, (_, index) => ({ name: `branch-${index}`, commit: { sha: publicSha } }));
  const { client } = publicClient((url) => {
    if (url.pathname !== path) throw new Error("unexpected request");
    return json(branches);
  });

  const page = await client.listBranches("open-org/repo", { page: 3 });

  assert.equal(page.items.length, 30);
  assert.equal(page.nextPage, 4);
});

test("branch pagination rejects a Link next URL outside the fixed GitHub API route", async () => {
  const path = "/repos/open-org/repo/branches";
  const { client } = publicClient((url) => {
    if (url.pathname !== path) throw new Error("unexpected request");
    return json([{ name: "main", commit: { sha: publicSha } }], 200, { Link: "<https://attacker.test/steal?page=2&per_page=30>; rel=\"next\"" });
  });

  await assert.rejects(client.listBranches("open-org/repo"), (error: unknown) => {
    errorCode(error, "UNAVAILABLE", 503);
    return true;
  });
});

test("private branch reads recheck the installation and send the user token only to authenticated endpoints", async () => {
  const path = "/repos/secret-org/repo/branches/main";
  const { client, requests } = privateClient((url) => {
    if (url.pathname === path) return json({ name: "main", commit: { sha: publicSha } });
    throw new Error("unexpected request");
  });

  const target = await client.resolveTarget({ repository: "secret-org/repo", branch: "main" });

  assert.equal(target.repository.fullName, "secret-org/repo");
  assert.equal(target.repository.installationId, "271");
  assert.equal(target.branch, "main");
  assert.equal(target.commitSha, publicSha);
  assert.equal(target.branchHeadSha, publicSha);
  assert.equal(requests.length, 4);
  assert.equal(new Headers(requests[0]?.init?.headers).get("Authorization"), null);
  assert.equal(new Headers(requests[1]?.init?.headers).get("Authorization"), `Bearer ${token}`);
  assert.equal(new Headers(requests[2]?.init?.headers).get("Authorization"), `Bearer ${token}`);
  assert.equal(new Headers(requests[3]?.init?.headers).get("Authorization"), `Bearer ${token}`);
});

test("resolveTarget encodes slash and Unicode branch names and accepts an ancestor commit", async () => {
  const branch = "feature/ref/日本語";
  const branchHead = "c".repeat(40);
  const commit = "b".repeat(40);
  const repositoryPath = "/repos/open-org/repo";
  const { client, requests } = publicClient((url) => {
    if (url.pathname === `${repositoryPath}/branches/${encodeURIComponent(branch)}`) {
      return json({ name: branch, commit: { sha: branchHead } });
    }
    if (url.pathname === `${repositoryPath}/commits/${"b".repeat(7)}`) return json({ sha: commit, commit: { message: "not returned" } });
    if (url.pathname === `${repositoryPath}/compare/${commit}...${branchHead}`) {
      assert.equal(url.search, "?per_page=1");
      return json({ status: "ahead", merge_base_commit: { sha: commit }, commits: [{ message: "ignored" }] });
    }
    throw new Error("unexpected request");
  });

  const target = await client.resolveTarget({ repository: "open-org/repo", branch, commit: "b".repeat(7) });

  assert.equal(target.branch, branch);
  assert.equal(target.commitSha, commit);
  assert.equal(target.branchHeadSha, branchHead);
  assert.equal(requests[1]?.url, `${api}${repositoryPath}/branches/feature%2Fref%2F%E6%97%A5%E6%9C%AC%E8%AA%9E`);
  assert.equal(new Headers(requests[1]?.init?.headers).get("Authorization"), null);
  assert.equal(new Headers(requests[2]?.init?.headers).get("Authorization"), null);
  assert.equal(new Headers(requests[3]?.init?.headers).get("Authorization"), null);
});

test("resolveTarget accepts a full current HEAD and verifies an identical comparison", async () => {
  const head = "d".repeat(64);
  const repositoryPath = "/repos/open-org/repo";
  const { client, requests } = publicClient((url) => {
    if (url.pathname === `${repositoryPath}/branches/main`) return json({ name: "main", commit: { sha: head } });
    if (url.pathname === `${repositoryPath}/commits/${head}`) return json({ sha: head });
    if (url.pathname === `${repositoryPath}/compare/${head}...${head}`) return json({ status: "identical", merge_base_commit: { sha: head } });
    throw new Error("unexpected request");
  });

  const target = await client.resolveTarget({ repository: "open-org/repo", branch: "main", commit: head });

  assert.equal(target.commitSha, head);
  assert.equal(target.branchHeadSha, head);
  assert.equal(requests.length, 4);
});

test("resolveTarget rejects a commit outside the selected branch history", async () => {
  const commit = "e".repeat(40);
  const branchHead = "f".repeat(40);
  const repositoryPath = "/repos/open-org/repo";
  const { client } = publicClient((url) => {
    if (url.pathname === `${repositoryPath}/branches/main`) return json({ name: "main", commit: { sha: branchHead } });
    if (url.pathname === `${repositoryPath}/commits/${commit}`) return json({ sha: commit });
    if (url.pathname === `${repositoryPath}/compare/${commit}...${branchHead}`) return json({ status: "diverged", merge_base_commit: { sha: "9".repeat(40) } });
    throw new Error("unexpected request");
  });

  await assert.rejects(client.resolveTarget({ repository: "open-org/repo", branch: "main", commit }), (error: unknown) => {
    errorCode(error, "INVALID_INPUT", 400);
    return true;
  });
});

test("resolveTarget maps ambiguous commit prefixes and empty repositories to safe input errors", async (t) => {
  await t.test("ambiguous prefix", async () => {
    const head = "1".repeat(40);
    const repositoryPath = "/repos/open-org/repo";
    const { client } = publicClient((url) => {
      if (url.pathname === `${repositoryPath}/branches/main`) return json({ name: "main", commit: { sha: head } });
      if (url.pathname === `${repositoryPath}/commits/${"2".repeat(7)}`) return json({ message: "ambiguous commit prefix" }, 422);
      throw new Error("unexpected request");
    });

    await assert.rejects(client.resolveTarget({ repository: "open-org/repo", branch: "main", commit: "2".repeat(7) }), (error: unknown) => {
      errorCode(error, "INVALID_INPUT", 400);
      return true;
    });
  });

  await t.test("empty repository", async () => {
    const repositoryPath = "/repos/open-org/repo";
    const { client } = publicClient((url) => {
      if (url.pathname === `${repositoryPath}/branches/main`) return json({ message: "Repository is empty" }, 409);
      throw new Error("unexpected request");
    });

    await assert.rejects(client.resolveTarget({ repository: "open-org/repo", branch: "main" }), (error: unknown) => {
      errorCode(error, "INVALID_INPUT", 409);
      return true;
    });
  });
});

test("resolveTarget treats a tag-only name as a missing branch", async () => {
  const branch = "v1.2.3";
  const path = `/repos/open-org/repo/branches/${branch}`;
  const { client, requests } = publicClient((url) => {
    if (url.pathname === path) return json({ message: "Not Found" }, 404);
    throw new Error("unexpected request");
  });

  await assert.rejects(client.resolveTarget({ repository: "open-org/repo", branch }), (error: unknown) => {
    errorCode(error, "NOT_FOUND", 404);
    return true;
  });
  assert.equal(requests[1]?.url, `${api}${path}`);
  assert.equal(requests.length, 2);
});

test("malformed branch and comparison responses fail closed", async (t) => {
  await t.test("branch collection is not an array", async () => {
    const path = "/repos/open-org/repo/branches";
    const { client } = publicClient((url) => {
      if (url.pathname === path) return json({ branches: [] });
      throw new Error("unexpected request");
    });
    await assert.rejects(client.listBranches("open-org/repo"), (error: unknown) => {
      errorCode(error, "UNAVAILABLE", 503);
      return true;
    });
  });

  await t.test("branch response has a malformed SHA", async () => {
    const path = "/repos/open-org/repo/branches/main";
    const { client } = publicClient((url) => {
      if (url.pathname === path) return json({ name: "main", commit: { sha: "not-a-sha" } });
      throw new Error("unexpected request");
    });
    await assert.rejects(client.resolveTarget({ repository: "open-org/repo", branch: "main" }), (error: unknown) => {
      errorCode(error, "UNAVAILABLE", 503);
      return true;
    });
  });

  await t.test("comparison response omits its merge base", async () => {
    const repositoryPath = "/repos/open-org/repo";
    const commit = "8".repeat(40);
    const head = "9".repeat(40);
    const { client } = publicClient((url) => {
      if (url.pathname === `${repositoryPath}/branches/main`) return json({ name: "main", commit: { sha: head } });
      if (url.pathname === `${repositoryPath}/commits/${commit}`) return json({ sha: commit });
      if (url.pathname === `${repositoryPath}/compare/${commit}...${head}`) return json({ status: "ahead" });
      throw new Error("unexpected request");
    });
    await assert.rejects(client.resolveTarget({ repository: "open-org/repo", branch: "main", commit }), (error: unknown) => {
      errorCode(error, "UNAVAILABLE", 503);
      return true;
    });
  });
});

test("invalid branch and commit inputs are rejected before any GitHub request", async () => {
  let calls = 0;
  const client = new GitHubRepositoryClient({
    accessToken: token,
    fetcher: (async () => {
      calls++;
      return json(publicRepository());
    }) as typeof fetch,
  });

  for (const branch of ["", "refs/heads/main", "/main", "main/", "main//child", "main..next", "feature/.hidden", "feature/name.lock", "feature/@{1}", "feature name", "~branch", "main?", "a".repeat(256), "\ud800"]) {
    await assert.rejects(client.resolveTarget({ repository: "open-org/repo", branch }), (error: unknown) => {
      errorCode(error, "INVALID_INPUT", 400);
      return true;
    }, branch);
  }
  for (const commit of ["abc", "g".repeat(40), "a".repeat(41), "a".repeat(63), "a".repeat(65)]) {
    await assert.rejects(client.resolveTarget({ repository: "open-org/repo", branch: "main", commit }), (error: unknown) => {
      errorCode(error, "INVALID_INPUT", 400);
      return true;
    }, commit);
  }
  assert.equal(calls, 0);
});
