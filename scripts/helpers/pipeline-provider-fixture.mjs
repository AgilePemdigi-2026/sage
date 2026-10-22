import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const expectedDatabase = "sage_pipeline16";
if (process.env.SAGE_PIPELINE_TESTS !== "1") {
  throw new Error("Pipeline provider fixture requires SAGE_PIPELINE_TESTS=1.");
}
let configuredDatabase;
try {
  const databaseUrl = new URL(process.env.DATABASE_URL ?? "");
  assert.ok(databaseUrl.protocol === "postgresql:" || databaseUrl.protocol === "postgres:");
  configuredDatabase = decodeURIComponent(databaseUrl.pathname.slice(1));
} catch {
  throw new Error("Pipeline provider fixture requires a valid DATABASE_URL for sage_pipeline16.");
}
if (configuredDatabase !== expectedDatabase) {
  throw new Error("Pipeline provider fixture only allows the isolated sage_pipeline16 database.");
}

const API_ORIGIN = "https://api.github.com";
const CODELOAD_ORIGIN = "https://codeload.github.com";
const FIXTURE_OWNER = "sage-pipeline16-fixture";
const FIXTURE_REPOSITORY = "private-sample";
const FIXTURE_FULL_NAME = `${FIXTURE_OWNER}/${FIXTURE_REPOSITORY}`;
const FIXTURE_REPOSITORY_ID = "160016";
const FIXTURE_INSTALLATION_ID = "160016";
const FIXTURE_COMMIT = "16".repeat(20);
const DENIED_TOKEN = "sage-pipeline16-provider-denied";
const originalFetch = globalThis.fetch.bind(globalThis);

const require = createRequire(import.meta.url);
const tarStream = require("tar-stream");
const { pack } = tarStream;

function json(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/vnd.github+json; charset=utf-8", ...headers },
  });
}

async function makeArchive() {
  const tar = pack();
  const root = `sage-pipeline16-${FIXTURE_COMMIT.slice(0, 8)}`;
  const files = [
    ["src/model.ts", new URL("../../tests/fixtures/resolver/typescript/src/model.ts", import.meta.url)],
    ["src/endpoint.ts", new URL("../../tests/fixtures/resolver/typescript/src/endpoint.ts", import.meta.url)],
    ["src/contracts.php", new URL("../../tests/fixtures/resolver/php/src/contracts.php", import.meta.url)],
    ["src/php-endpoint.php", new URL("../../tests/fixtures/resolver/php/src/endpoint.php", import.meta.url)],
    ["src/factory.php", new URL("../../tests/fixtures/resolver/php/src/factory.php", import.meta.url)],
  ];

  function add(name, bytes, type) {
    return new Promise((resolve, reject) => {
      tar.entry({
        name,
        type,
        size: bytes.byteLength,
        mode: type === "directory" ? 0o755 : 0o644,
        mtime: new Date(0),
        uid: 0,
        gid: 0,
        uname: "",
        gname: "",
      }, bytes, error => error ? reject(error) : resolve());
    });
  }

  await add(`${root}/`, Buffer.alloc(0), "directory");
  await add(`${root}/src/`, Buffer.alloc(0), "directory");
  for (const [path, url] of files) await add(`${root}/${path}`, await readFile(url), "file");
  await add(`${root}/.gitmodules`, Buffer.from('[submodule "private-components"]\n\tpath = vendor/private-components\n\turl = https://example.invalid/private-components.git\n'), "file");
  tar.finalize();
  const chunks = [];
  for await (const chunk of tar) chunks.push(Buffer.from(chunk));
  return gzipSync(Buffer.concat(chunks));
}

const archivePromise = makeArchive();
const repositoryBody = {
  id: Number(FIXTURE_REPOSITORY_ID),
  owner: { login: FIXTURE_OWNER, type: "Organization" },
  name: FIXTURE_REPOSITORY,
  full_name: FIXTURE_FULL_NAME,
  private: true,
  default_branch: "main",
  archived: false,
};

function sameFixtureRepo(pathname) {
  return pathname.toLowerCase() === `/repos/${FIXTURE_OWNER}/${FIXTURE_REPOSITORY}`.toLowerCase();
}

function sameFixtureUserRepositoryList(url) {
  return url.pathname.toLowerCase() === `/users/${FIXTURE_OWNER}/repos`.toLowerCase()
    && url.searchParams.get("per_page") === "30"
    && url.searchParams.get("page") === "1"
    && [...url.searchParams.keys()].every(key => key === "per_page" || key === "page");
}

async function providerFixture(request, url, token) {
  if (token === DENIED_TOKEN) return json({ message: "Resource not accessible by integration" }, 403);

  const path = url.pathname;
  if (path === "/user/installations" && request.method === "GET") {
    return json({
      total_count: 1,
      installations: [{
        id: Number(FIXTURE_INSTALLATION_ID),
        account: { login: FIXTURE_OWNER, type: "Organization" },
        repository_selection: "selected",
        permissions: { contents: "read" },
        suspended_at: null,
      }],
    });
  }
  if (path === `/user/installations/${FIXTURE_INSTALLATION_ID}/repositories` && request.method === "GET") {
    return json({ total_count: 1, repositories: [{ ...repositoryBody, permissions: { pull: true } }] });
  }
  if (path === `/repos/${FIXTURE_OWNER}/${FIXTURE_REPOSITORY}` && request.method === "GET") {
    return json(repositoryBody);
  }
  if (path === `/repos/${FIXTURE_OWNER}/${FIXTURE_REPOSITORY}/branches` && request.method === "GET") {
    return json([{ name: "main", commit: { sha: FIXTURE_COMMIT } }]);
  }
  if (path === `/repos/${FIXTURE_OWNER}/${FIXTURE_REPOSITORY}/branches/main` && request.method === "GET") {
    return json({ name: "main", commit: { sha: FIXTURE_COMMIT } });
  }
  if (path === `/repos/${FIXTURE_OWNER}/${FIXTURE_REPOSITORY}/commits/${FIXTURE_COMMIT}` && request.method === "GET") {
    return json({ sha: FIXTURE_COMMIT });
  }
  if (path === `/repos/${FIXTURE_OWNER}/${FIXTURE_REPOSITORY}/compare/${FIXTURE_COMMIT}...${FIXTURE_COMMIT}` && request.method === "GET") {
    return json({ status: "identical", merge_base_commit: { sha: FIXTURE_COMMIT }, ahead_by: 0, behind_by: 0 });
  }
  if (path === `/repos/${FIXTURE_OWNER}/${FIXTURE_REPOSITORY}/tarball/${FIXTURE_COMMIT}` && request.method === "GET") {
    const location = `${CODELOAD_ORIGIN}/${FIXTURE_OWNER}/${FIXTURE_REPOSITORY}/legacy.tar.gz/${FIXTURE_COMMIT}`;
    return new Response(null, { status: 302, headers: { Location: location } });
  }
  return json({ message: "Unmapped sage_pipeline16 provider fixture request" }, 501);
}

globalThis.fetch = async function pipeline16Fetch(input, init) {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (url.origin === API_ORIGIN) {
    const authorization = request.headers.get("authorization");
    const token = /^Bearer (sage-pipeline16-provider-(?:allowed|denied))$/.exec(authorization ?? "")?.[1];
    if (token) return providerFixture(request, url, token);

    // RepositoryAccessPanel also lists public repositories owned by the same
    // synthetic login. Keep this fixture response exact and unauthenticated,
    // while allowing every other provider request through to the real network.
    if (!authorization && request.method === "GET" && sameFixtureUserRepositoryList(url)) {
      return json([]);
    }

    // resolveRepository first performs an unauthenticated public-repository probe.
    // This exact private fixture probe must behave as GitHub would (not found) so
    // the authenticated installation permission check below remains authoritative.
    if (sameFixtureRepo(url.pathname) && request.method === "GET" && !authorization) {
      return json({ message: "Not Found" }, 404);
    }
  }
  if (url.origin === CODELOAD_ORIGIN &&
      url.pathname === `/${FIXTURE_OWNER}/${FIXTURE_REPOSITORY}/legacy.tar.gz/${FIXTURE_COMMIT}` &&
      request.method === "GET" && !request.headers.has("authorization")) {
    // Give the real queue consumer time to publish a visible RUNNING snapshot.
    await new Promise(resolve => setTimeout(resolve, 4_000));
    return new Response(await archivePromise, {
      status: 200,
      headers: { "Content-Type": "application/gzip", "Content-Length": String((await archivePromise).byteLength) },
    });
  }
  return originalFetch(input, init);
};

const modulePath = fileURLToPath(import.meta.url);
if (!modulePath.endsWith("pipeline-provider-fixture.mjs")) throw new Error("Pipeline provider fixture failed to initialize.");
