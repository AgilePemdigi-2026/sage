import { randomBytes as cryptoRandomBytes, timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import { open, lstat, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

export const LOOPBACK_HOST = "127.0.0.1";
export const LOOPBACK_PORT = 7010;
export const SETUP_URL = `http://${LOOPBACK_HOST}:${LOOPBACK_PORT}/`;
export const REDIRECT_URL = `http://${LOOPBACK_HOST}:${LOOPBACK_PORT}/callback`;
export const AUTH_BASE_URL = "http://localhost:3000";
export const OAUTH_CALLBACK_URL = `${AUTH_BASE_URL}/auth/github/callback`;
export const APP_HOME_URL = "https://github.com/AgilePemdigi-2026/sage";
export const STATE_TTL_MS = 10 * 60 * 1000;
export const CONVERSION_TIMEOUT_MS = 15 * 1000;

export const ENV_KEYS = Object.freeze([
  "GITHUB_APP_ID",
  "GITHUB_APP_CLIENT_ID",
  "GITHUB_APP_CLIENT_SECRET",
  "GITHUB_APP_PRIVATE_KEY_BASE64",
  "GITHUB_APP_SLUG",
  "GITHUB_APP_URL",
  "AUTH_BASE_URL",
]);

const SAFE_NAME_MAX_LENGTH = 34;
const CONVERSION_ENDPOINT_PREFIX = "https://api.github.com/app-manifests/";
const execFileAsync = promisify(execFile);

export function validateAppName(name) {
  return typeof name === "string"
    && name.trim() === name
    && name.length > 0
    && name.length <= SAFE_NAME_MAX_LENGTH
    && !/[\u0000-\u001f\u007f]/u.test(name);
}

export function validateManifestCode(code) {
  return typeof code === "string" && /^[A-Za-z0-9_-]{1,256}$/u.test(code);
}

export function createManifest(name, state) {
  if (!validateAppName(name)) throw new Error("Nama GitHub App tidak valid.");
  if (typeof state !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(state)) {
    throw new Error("State setup tidak valid.");
  }

  return {
    name,
    url: APP_HOME_URL,
    redirect_url: REDIRECT_URL,
    callback_urls: [OAUTH_CALLBACK_URL],
    public: true,
    default_permissions: {
      contents: "read",
      metadata: "read",
    },
    default_events: [],
  };
}

export function createOneTimeState({
  token = cryptoRandomBytes(32).toString("base64url"),
  now = Date.now(),
  ttlMs = STATE_TTL_MS,
} = {}) {
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(token)) {
    throw new Error("State setup tidak valid.");
  }
  if (!Number.isFinite(now) || !Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new Error("Masa berlaku state tidak valid.");
  }

  const expiresAt = now + ttlMs;
  let consumed = false;
  return Object.freeze({
    token,
    expiresAt,
    consume(candidate, currentTime = Date.now()) {
      if (consumed || !Number.isFinite(currentTime) || currentTime >= expiresAt) return false;
      if (typeof candidate !== "string"
        || !/^[A-Za-z0-9_-]{1,128}$/u.test(candidate)
        || candidate.length !== token.length) return false;
      const expected = Buffer.from(token, "utf8");
      const supplied = Buffer.from(candidate, "utf8");
      if (!timingSafeEqual(expected, supplied)) return false;
      consumed = true;
      return true;
    },
    get consumed() {
      return consumed;
    },
  });
}

export function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function createRegistrationPage(name, state) {
  const manifest = createManifest(name, state);
  const action = `https://github.com/settings/apps/new?state=${encodeURIComponent(state)}`;
  const manifestValue = escapeHtml(JSON.stringify(manifest));
  return `<!doctype html>
<html lang="id">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Setup GitHub App SAGE</title>
  <style>
    body { max-width: 42rem; margin: 3rem auto; padding: 0 1.25rem; color: #172033; font: 16px/1.6 system-ui, sans-serif; }
    main { border: 1px solid #d7deea; border-radius: 12px; padding: 1.5rem; }
    button { border: 0; border-radius: 8px; padding: .8rem 1rem; color: white; background: #1769aa; font: inherit; cursor: pointer; }
  </style>
</head>
<body>
  <main>
    <h1>Siapkan GitHub App SAGE</h1>
    <p>Tombol ini membuka konfigurasi awal di GitHub. Tinjau izin, lalu klik <strong>Create GitHub App</strong> di GitHub untuk membuat aplikasi atas akun Anda.</p>
    <p>Nama yang disiapkan: <strong>${escapeHtml(name)}</strong>. Izin repository hanya Contents: read dan Metadata: read; webhook tidak diaktifkan.</p>
    <form action="${escapeHtml(action)}" method="post">
      <input type="hidden" name="manifest" value="${manifestValue}">
      <button type="submit">Lanjutkan ke GitHub</button>
    </form>
  </main>
</body>
</html>`;
}

export function isAllowedHostHeader(hostHeader) {
  return typeof hostHeader === "string"
    && ["127.0.0.1:7010", "localhost:7010"].includes(hostHeader.toLowerCase());
}

export function normalizeAppResponse(payload) {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Respons GitHub tidak valid.");
  }

  const id = payload.id;
  const idString = typeof id === "number" && Number.isSafeInteger(id) && id > 0
    ? String(id)
    : typeof id === "string" && /^[1-9][0-9]*$/u.test(id)
      ? id
      : null;
  const clientId = payload.client_id;
  const clientSecret = payload.client_secret;
  const slug = payload.slug;
  const privateKey = payload.pem;
  const appName = payload.name;

  if (idString === null || !isSafeCredentialString(clientId) || !isSafeCredentialString(clientSecret)) {
    throw new Error("Respons kredensial GitHub tidak lengkap.");
  }
  if (typeof slug !== "string" || !/^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/u.test(slug)) {
    throw new Error("Slug GitHub App tidak valid.");
  }
  if (!validateAppName(appName)) throw new Error("Nama GitHub App pada respons tidak valid.");
  if (typeof privateKey !== "string" || !isValidPem(privateKey)) {
    throw new Error("Kunci privat GitHub tidak valid.");
  }

  return Object.freeze({
    appName,
    GITHUB_APP_ID: idString,
    GITHUB_APP_CLIENT_ID: clientId,
    GITHUB_APP_CLIENT_SECRET: clientSecret,
    GITHUB_APP_PRIVATE_KEY_BASE64: Buffer.from(privateKey, "utf8").toString("base64"),
    GITHUB_APP_SLUG: slug,
    GITHUB_APP_URL: `https://github.com/apps/${slug}`,
    AUTH_BASE_URL,
  });
}

function isSafeCredentialString(value) {
  return typeof value === "string" && /^[A-Za-z0-9._-]+$/u.test(value);
}

function isValidPem(value) {
  return /^-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----\r?\n[\s\S]+\r?\n-----END [A-Z0-9 ]*PRIVATE KEY-----\r?\n?$/u.test(value);
}

export async function convertManifestCode(code, {
  fetchImpl = globalThis.fetch,
  signal = AbortSignal.timeout(CONVERSION_TIMEOUT_MS),
} = {}) {
  if (!validateManifestCode(code)) throw new Error("Kode callback GitHub tidak valid.");
  if (typeof fetchImpl !== "function") throw new Error("Koneksi GitHub tidak tersedia.");

  const endpoint = `${CONVERSION_ENDPOINT_PREFIX}${encodeURIComponent(code)}/conversions`;
  let response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2026-03-10",
        "User-Agent": "SAGE-local-github-app-setup",
      },
      redirect: "error",
      signal,
    });
  } catch {
    throw new Error("Pertukaran konfigurasi dengan GitHub gagal atau melewati batas waktu.");
  }
  if (!response || response.status !== 201) {
    throw new Error("GitHub tidak mengembalikan konfigurasi aplikasi yang valid.");
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error("Respons konfigurasi GitHub tidak dapat dibaca.");
  }
  return normalizeAppResponse(payload);
}

export function formatEnvValue(value) {
  if (typeof value !== "string" || value.includes("\u0000")) {
    throw new Error("Nilai environment tidak valid.");
  }
  if (/^[A-Za-z0-9._:/@+-]*$/u.test(value)) return value;
  if (value.includes("$")) {
    if (value.includes("\\")) throw new Error("Nilai dengan dollar dan backslash tidak didukung.");
    return `'${value.replaceAll("'", "\\'")}'`;
  }
  return JSON.stringify(value);
}

function commentSuffix(value) {
  let quote = null;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (quote === '"' && escaped) {
      escaped = false;
      continue;
    }
    if (quote === '"' && char === "\\") {
      escaped = true;
      continue;
    }
    if (quote !== null) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "#" && (index === 0 || /\s/u.test(value[index - 1]))) return value.slice(index - 1 >= 0 && /\s/u.test(value[index - 1]) ? index - 1 : index);
  }
  return "";
}

export function mergeEnvContent(content, values) {
  if (typeof content !== "string" || values === null || typeof values !== "object" || Array.isArray(values)) {
    throw new Error("Konfigurasi environment tidak valid.");
  }
  const entries = Object.entries(values);
  if (entries.length === 0 || entries.some(([key, value]) => !ENV_KEYS.includes(key) || typeof value !== "string")) {
    throw new Error("Konfigurasi GitHub App tidak valid.");
  }

  let result = content;
  for (const [key, value] of entries) {
    const assignment = new RegExp(`^(\\s*(?:export\\s+)?${key}\\s*=)(.*)$`, "u");
    const encoded = formatEnvValue(value);
    let found = false;
    const lines = result.split(/(?<=\n)/u);
    result = lines.map((line) => {
      const ending = line.endsWith("\r\n") ? "\r\n" : line.endsWith("\n") ? "\n" : "";
      const source = ending.length > 0 ? line.slice(0, -ending.length) : line;
      const match = assignment.exec(source);
      if (!match) return line;
      found = true;
      return `${match[1]}${encoded}${commentSuffix(match[2])}${ending}`;
    }).join("");
    if (!found) {
      const separator = result.length > 0 && !result.endsWith("\n") ? "\n" : "";
      result += `${separator}${key}=${encoded}\n`;
    }
  }
  return result;
}

export async function assertEnvTargetReady(projectRoot, { filesystem = { lstat, readFile } } = {}) {
  try {
    await execFileAsync("git", ["check-ignore", "--quiet", "--", ".env"], {
      cwd: projectRoot,
      encoding: "utf8",
      windowsHide: true,
    });
  } catch (error) {
    if (error.code === 1) {
      throw new Error(".env tidak akan ditulis karena Git tidak mengabaikan file root .env.");
    }
    throw new Error(".env tidak akan ditulis karena aturan ignore Git tidak dapat diverifikasi.");
  }

  const envPath = join(projectRoot, ".env");
  try {
    const info = await filesystem.lstat(envPath);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error(".env harus berupa file biasa; tidak ada rahasia yang ditulis.");
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return envPath;
}

async function atomicWriteEnv(envPath, content, {
  filesystem = { open, lstat, readFile, rename, unlink },
  randomBytes = cryptoRandomBytes,
  expectedContent,
} = {}) {
  const tempPath = join(dirname(envPath), `.env.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
  let fileHandle;
  try {
    fileHandle = await filesystem.open(tempPath, "wx", 0o600);
    await fileHandle.writeFile(content, "utf8");
    await fileHandle.chmod(0o600);
    await fileHandle.sync();
    await fileHandle.close();
    fileHandle = undefined;

    try {
      const info = await filesystem.lstat(envPath);
      if (!info.isFile() || info.isSymbolicLink()) {
        throw new Error(".env harus berupa file biasa; tidak ada rahasia yang ditulis.");
      }
      if (expectedContent === undefined) {
        throw new Error(".env berubah selama setup; tidak ada konfigurasi yang ditulis.");
      }
      const currentContent = await filesystem.readFile(envPath, "utf8");
      if (currentContent !== expectedContent) {
        throw new Error(".env berubah selama setup; tidak ada konfigurasi yang ditulis.");
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      if (expectedContent !== undefined) {
        throw new Error(".env berubah selama setup; tidak ada konfigurasi yang ditulis.");
      }
    }

    await filesystem.rename(tempPath, envPath);
  } catch (error) {
    if (fileHandle) await fileHandle.close().catch(() => {});
    await filesystem.unlink(tempPath).catch(() => {});
    throw error;
  }
}

export async function persistAppConfig(projectRoot, values, {
  filesystem = { open, lstat, readFile, rename, unlink },
  randomBytes = cryptoRandomBytes,
} = {}) {
  validateAppEnvironment(values);
  const envPath = await assertEnvTargetReady(projectRoot, { filesystem });
  let existingContent;
  try {
    existingContent = await filesystem.readFile(envPath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const nextContent = mergeEnvContent(existingContent ?? "", values);
  await atomicWriteEnv(envPath, nextContent, {
    filesystem,
    randomBytes,
    expectedContent: existingContent,
  });
}

function validateAppEnvironment(values) {
  const patterns = {
    GITHUB_APP_ID: /^[1-9][0-9]*$/u,
    GITHUB_APP_CLIENT_ID: /^[A-Za-z0-9._-]+$/u,
    GITHUB_APP_CLIENT_SECRET: /^[A-Za-z0-9._-]+$/u,
    GITHUB_APP_PRIVATE_KEY_BASE64: /^[A-Za-z0-9+/]+={0,2}$/u,
    GITHUB_APP_SLUG: /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/u,
    GITHUB_APP_URL: /^https:\/\/github\.com\/apps\/[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/u,
    AUTH_BASE_URL: /^http:\/\/localhost:3000$/u,
  };
  if (values === null || typeof values !== "object" || Array.isArray(values)) {
    throw new Error("Konfigurasi GitHub App tidak valid.");
  }
  const keys = Object.keys(values);
  if (keys.length !== ENV_KEYS.length
    || keys.some((key) => !ENV_KEYS.includes(key) || !patterns[key]?.test(values[key]))) {
    throw new Error("Konfigurasi GitHub App tidak valid.");
  }
}
