import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  APP_HOME_URL,
  AUTH_BASE_URL,
  OAUTH_CALLBACK_URL,
  REDIRECT_URL,
  convertManifestCode,
  createManifest,
  createOneTimeState,
  createRegistrationPage,
  formatEnvValue,
  isAllowedHostHeader,
  mergeEnvContent,
  normalizeAppResponse,
  persistAppConfig,
  validateAppName,
  validateManifestCode,
  type GitHubAppEnvironment,
} from "../scripts/lib/github-app-bootstrap.mjs";

const execFileAsync = promisify(execFile);
const fixturePem = "-----BEGIN RSA PRIVATE KEY-----\nfixture-private-key-data\n-----END RSA PRIVATE KEY-----\n";

function fixtureResponse() {
  return {
    name: "SAGE I2 Fixture",
    id: 123456,
    client_id: "fixture-client-id",
    client_secret: "fixture-client-secret",
    slug: "sage-i2-fixture",
    pem: fixturePem,
    webhook_secret: "must-not-be-stored",
  };
}

function fixtureEnvironment(): GitHubAppEnvironment {
  const normalized = normalizeAppResponse(fixtureResponse());
  return {
    GITHUB_APP_ID: normalized.GITHUB_APP_ID,
    GITHUB_APP_CLIENT_ID: normalized.GITHUB_APP_CLIENT_ID,
    GITHUB_APP_CLIENT_SECRET: normalized.GITHUB_APP_CLIENT_SECRET,
    GITHUB_APP_PRIVATE_KEY_BASE64: normalized.GITHUB_APP_PRIVATE_KEY_BASE64,
    GITHUB_APP_SLUG: normalized.GITHUB_APP_SLUG,
    GITHUB_APP_URL: normalized.GITHUB_APP_URL,
    AUTH_BASE_URL: normalized.AUTH_BASE_URL,
  };
}

async function makeTempProject(
  t: { after(callback: () => void | Promise<void>): void },
  gitignore = ".env\n.env.*\n",
) {
  const projectRoot = await mkdtemp(join(tmpdir(), "sage-github-app-test-"));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  await execFileAsync("git", ["init", "--quiet"], { cwd: projectRoot });
  await writeFile(join(projectRoot, ".gitignore"), gitignore, "utf8");
  return projectRoot;
}

test("manifest mengisi callback, redirect, visibility, dan izin minimum", () => {
  const manifest = createManifest("SAGE-I2-fixture", "state_fixture_123");
  assert.equal(manifest.name, "SAGE-I2-fixture");
  assert.equal(manifest.url, APP_HOME_URL);
  assert.equal(manifest.redirect_url, REDIRECT_URL);
  assert.deepEqual(manifest.callback_urls, [OAUTH_CALLBACK_URL]);
  assert.equal(manifest.public, true);
  assert.deepEqual(manifest.default_permissions, { contents: "read", metadata: "read" });
  assert.deepEqual(manifest.default_events, []);
  assert.equal("hook_attributes" in manifest, false);
  assert.equal("emails" in manifest, false);
  assert.equal(AUTH_BASE_URL, "http://localhost:3000");
});

test("validasi nama dan callback menolak input malformed", () => {
  assert.equal(validateAppName("SAGE-I2-iltizamhasan3"), true);
  assert.equal(validateAppName("x".repeat(35)), false);
  assert.equal(validateAppName("SAGE\nInjected"), false);
  assert.equal(validateAppName(" name "), false);
  assert.equal(validateManifestCode("callback-code_123"), true);
  assert.equal(validateManifestCode("../other-host"), false);
  assert.equal(validateManifestCode("bad\ncode"), false);
});

test("state punya TTL, membandingkan dengan aman, lalu hanya dapat dipakai sekali", () => {
  const state = createOneTimeState({ token: "state_fixture_123", now: 100, ttlMs: 10 });
  assert.equal(state.consume("wrong_state", 101), false);
  assert.equal(state.consume("state_fixture_123", 109), true);
  assert.equal(state.consumed, true);
  assert.equal(state.consume("state_fixture_123", 109), false);

  const expired = createOneTimeState({ token: "state_expired_123", now: 100, ttlMs: 10 });
  assert.equal(expired.consume("state_expired_123", 110), false);
  assert.equal(expired.consumed, false);
  const unicodeCandidate = createOneTimeState({ token: "a".repeat(43), now: 100, ttlMs: 10 });
  assert.equal(unicodeCandidate.consume("é".repeat(43), 101), false);
});

test("halaman registrasi memakai POST GitHub manual dan tidak memuat kode atau kredensial", () => {
  const page = createRegistrationPage("SAGE-I2-fixture", "state_fixture_123");
  assert.match(page, /action="https:\/\/github\.com\/settings\/apps\/new\?state=state_fixture_123" method="post"/u);
  assert.match(page, /name="manifest"/u);
  assert.match(page, /Create GitHub App/u);
  assert.doesNotMatch(page, /<script|client_secret|PRIVATE KEY|fixture-private-key/u);
  assert.equal(isAllowedHostHeader("127.0.0.1:7010"), true);
  assert.equal(isAllowedHostHeader("LOCALHOST:7010"), true);
  assert.equal(isAllowedHostHeader("127.0.0.1:3000"), false);
  assert.equal(isAllowedHostHeader("example.com:7010"), false);
});

test("conversion memanggil endpoint tetap dengan POST tanpa bearer token dan menormalkan respons", async () => {
  let observedUrl = "";
  let observedInit: RequestInit | undefined;
  const result = await convertManifestCode("fixture-code-123", {
    fetchImpl: async (input, init) => {
      observedUrl = String(input);
      observedInit = init;
      return new Response(JSON.stringify(fixtureResponse()), { status: 201 });
    },
  });

  assert.equal(observedUrl, "https://api.github.com/app-manifests/fixture-code-123/conversions");
  assert.equal(observedInit?.method, "POST");
  assert.equal(observedInit?.redirect, "error");
  const headers = new Headers(observedInit?.headers);
  assert.equal(headers.get("Accept"), "application/vnd.github+json");
  assert.equal(headers.get("X-GitHub-Api-Version"), "2026-03-10");
  assert.equal(headers.has("Authorization"), false);
  assert.equal(result.GITHUB_APP_ID, "123456");
  assert.equal(result.GITHUB_APP_URL, "https://github.com/apps/sage-i2-fixture");
  assert.equal(result.GITHUB_APP_PRIVATE_KEY_BASE64, Buffer.from(fixturePem).toString("base64"));
  assert.equal("webhook_secret" in result, false);
  assert.equal("pem" in result, false);
});

test("conversion menolak kode/respons malformed tanpa memaparkan kode", async () => {
  let called = false;
  await assert.rejects(
    convertManifestCode("../invalid", {
      fetchImpl: async () => {
        called = true;
        return new Response("{}", { status: 201 });
      },
    }),
    /Kode callback GitHub tidak valid/u,
  );
  assert.equal(called, false);
  assert.throws(() => normalizeAppResponse({ ...fixtureResponse(), slug: "https://evil.invalid" }), /Slug GitHub App tidak valid/u);
  assert.throws(() => normalizeAppResponse({ ...fixtureResponse(), pem: "not a key" }), /Kunci privat GitHub tidak valid/u);
});

test("serialisasi newline aman dan merge mempertahankan komentar serta nilai lain", () => {
  assert.equal(formatEnvValue("line one\nline two"), '"line one\\nline two"');
  assert.equal(formatEnvValue("abc_123-xyz"), "abc_123-xyz");
  assert.equal(formatEnvValue("$GITHUB_TOKEN"), "'$GITHUB_TOKEN'");
  const newlineAssignment = formatEnvValue("first line\nGITHUB_APP_ID=injected");
  assert.equal(newlineAssignment.includes("\\nGITHUB_APP_ID=injected"), true);
  assert.equal(newlineAssignment.split("\n").length, 1);
  const merged = mergeEnvContent(
    "# keep this comment\nOTHER_SECRET=keep-existing\nGITHUB_APP_CLIENT_SECRET=old-value # keep inline note\n",
    { GITHUB_APP_CLIENT_SECRET: "new-value" },
  );
  assert.match(merged, /^# keep this comment\n/u);
  assert.match(merged, /OTHER_SECRET=keep-existing/u);
  assert.match(merged, /GITHUB_APP_CLIENT_SECRET=new-value # keep inline note/u);
});

test("writer atomik menyimpan konfigurasi mode 0600 dan menjaga env/comment yang sudah ada", async (t) => {
  const projectRoot = await makeTempProject(t);
  const envPath = join(projectRoot, ".env");
  await writeFile(envPath, "# Existing config\nEXISTING_SECRET=fixture-existing-value\nGITHUB_APP_ID=old-id\n", { mode: 0o644 });

  await persistAppConfig(projectRoot, fixtureEnvironment());

  const content = await readFile(envPath, "utf8");
  const metadata = await stat(envPath);
  assert.match(content, /^# Existing config\n/u);
  assert.match(content, /EXISTING_SECRET=fixture-existing-value\n/u);
  assert.match(content, /GITHUB_APP_ID=123456\n/u);
  assert.match(content, /GITHUB_APP_PRIVATE_KEY_BASE64=/u);
  assert.match(content, /AUTH_BASE_URL=http:\/\/localhost:3000/u);
  assert.doesNotMatch(content, /must-not-be-stored/u);
  assert.equal(metadata.mode & 0o777, 0o600);
});

test("writer menolak symlink tanpa mengubah targetnya", async (t) => {
  const projectRoot = await makeTempProject(t);
  const envPath = join(projectRoot, ".env");
  const targetPath = join(projectRoot, "target.env");
  await writeFile(targetPath, "EXISTING_SECRET=fixture-unchanged\n", "utf8");
  await symlink(targetPath, envPath);
  await assert.rejects(persistAppConfig(projectRoot, fixtureEnvironment()), /file biasa/u);
  assert.equal(await readFile(targetPath, "utf8"), "EXISTING_SECRET=fixture-unchanged\n");
});

test("writer mengikuti semantik Git ignore untuk negasi wildcard", async (t) => {
  const projectRoot = await makeTempProject(t, ".env\n!*\n");
  await assert.rejects(persistAppConfig(projectRoot, fixtureEnvironment()), /Git tidak mengabaikan/u);
  await assert.rejects(readFile(join(projectRoot, ".env"), "utf8"), { code: "ENOENT" });
});

test("writer menolak .env yang sudah dilacak Git meskipun pattern ignore cocok", async (t) => {
  const projectRoot = await makeTempProject(t);
  const envPath = join(projectRoot, ".env");
  await writeFile(envPath, "EXISTING_SECRET=fixture-tracked-value\n", "utf8");
  await execFileAsync("git", ["add", "-f", "--", ".env"], { cwd: projectRoot });

  await assert.rejects(persistAppConfig(projectRoot, fixtureEnvironment()), /Git tidak mengabaikan/u);
  assert.equal(await readFile(envPath, "utf8"), "EXISTING_SECRET=fixture-tracked-value\n");
});
