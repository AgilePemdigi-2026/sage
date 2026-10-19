import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { userInfo } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  LOOPBACK_HOST,
  LOOPBACK_PORT,
  SETUP_URL,
  STATE_TTL_MS,
  assertEnvTargetReady,
  convertManifestCode,
  createOneTimeState,
  createRegistrationPage,
  isAllowedHostHeader,
  validateManifestCode,
  persistAppConfig,
  validateAppName,
} from "./lib/github-app-bootstrap.mjs";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC_ERROR = "Setup GitHub App gagal. Periksa konfigurasi lalu jalankan ulang.";

function defaultAppName() {
  const username = userInfo().username
    .replace(/[^A-Za-z0-9-]/gu, "-")
    .replace(/-+/gu, "-")
    .replace(/^-|-$/gu, "")
    .slice(0, 14) || "local";
  return `SAGE-I2-${username}-${randomBytes(4).toString("hex")}`;
}

function parseArgs(args) {
  let name;
  let help = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") {
      if (args.length !== 1) throw new Error("Argumen CLI tidak valid.");
      help = true;
      continue;
    }
    if (argument === "--name") {
      if (name !== undefined || index + 1 >= args.length) throw new Error("Argumen CLI tidak valid.");
      name = args[index + 1];
      index += 1;
      continue;
    }
    if (argument.startsWith("--name=")) {
      if (name !== undefined) throw new Error("Argumen CLI tidak valid.");
      name = argument.slice("--name=".length);
      continue;
    }
    throw new Error("Argumen CLI tidak valid.");
  }

  const selectedName = name ?? defaultAppName();
  if (!validateAppName(selectedName)) throw new Error("Nama GitHub App tidak valid (maksimum 34 karakter).");
  return { help, name: selectedName };
}

function writeResponse(response, status, body, contentType = "text/plain; charset=utf-8") {
  if (response.writableEnded) return;
  response.statusCode = status;
  response.setHeader("Content-Type", contentType);
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action https://github.com; base-uri 'none'; frame-ancestors 'none'");
  response.setHeader("Connection", "close");
  response.end(body);
}

function validRequestUrl(request, hostHeader) {
  if (typeof request.url !== "string" || !request.url.startsWith("/")) return null;
  try {
    const parsed = new URL(request.url, `http://${hostHeader.toLowerCase()}`);
    if (parsed.origin !== `http://${hostHeader.toLowerCase()}`) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function startBootstrapServer({
  name,
  projectRoot = PROJECT_ROOT,
  fetchImpl = globalThis.fetch,
  filesystem,
  now = Date.now,
  stateToken,
  port = LOOPBACK_PORT,
} = {}) {
  if (!validateAppName(name)) throw new Error("Nama GitHub App tidak valid.");
  if (port !== LOOPBACK_PORT) throw new Error("Port setup lokal tidak valid.");

  await assertEnvTargetReady(projectRoot, filesystem ? { filesystem } : undefined);
  const state = createOneTimeState({ ...(stateToken ? { token: stateToken } : {}), now: now(), ttlMs: STATE_TTL_MS });
  let consumed = false;
  let settled = false;
  let timeout;
  let resolveResult;
  let rejectResult;
  const result = new Promise((resolvePromise, rejectPromise) => {
    resolveResult = resolvePromise;
    rejectResult = rejectPromise;
  });
  const server = createServer(async (request, response) => {
    const hostHeader = request.headers.host;
    if (!isAllowedHostHeader(hostHeader)) {
      writeResponse(response, 400, "Permintaan lokal tidak valid.");
      return;
    }
    const parsed = validRequestUrl(request, hostHeader);
    if (!parsed) {
      writeResponse(response, 404, "Tidak ditemukan.");
      return;
    }
    if (settled || consumed || now() >= state.expiresAt) {
      writeResponse(response, 404, "Tidak ditemukan.");
      return;
    }

    if (request.method === "GET" && parsed.pathname === "/" && parsed.search === "") {
      writeResponse(response, 200, createRegistrationPage(name, state.token), "text/html; charset=utf-8");
      return;
    }
    if (parsed.pathname !== "/callback") {
      writeResponse(response, 404, "Tidak ditemukan.");
      return;
    }
    if (request.method !== "GET") {
      writeResponse(response, 405, "Metode tidak diizinkan.");
      return;
    }

    const parameterNames = [...parsed.searchParams.keys()];
    const codes = parsed.searchParams.getAll("code");
    const states = parsed.searchParams.getAll("state");
    if (parameterNames.some((key) => key !== "code" && key !== "state")
      || codes.length !== 1
      || states.length !== 1
      || !state.consume(states[0], now())) {
      writeResponse(response, 400, "Callback GitHub tidak valid atau sudah kedaluwarsa.");
      return;
    }

    consumed = true;
    if (!validateManifestCode(codes[0])) {
      writeResponse(response, 400, "Callback GitHub tidak valid.");
      settleError(new Error(PUBLIC_ERROR));
      return;
    }

    try {
      const appConfig = await convertManifestCode(codes[0], { fetchImpl });
      const { appName, ...environment } = appConfig;
      await persistAppConfig(projectRoot, environment, filesystem ? { filesystem } : undefined);
      writeResponse(response, 200, "Setup selesai. Anda dapat menutup tab ini.");
      settleSuccess(appName);
    } catch {
      writeResponse(response, 500, "Setup gagal. Periksa terminal dan jalankan ulang bila diperlukan.");
      settleError(new Error(PUBLIC_ERROR));
    }
  });

  server.headersTimeout = 5_000;
  server.requestTimeout = 15_000;
  server.keepAliveTimeout = 1_000;

  const stop = () => {
    clearTimeout(timeout);
    if (server.listening) server.close();
  };
  const settleSuccess = (appName) => {
    if (settled) return;
    settled = true;
    stop();
    resolveResult({ appName });
  };
  const settleError = (error) => {
    if (settled) return;
    settled = true;
    stop();
    rejectResult(error);
  };

  const listening = new Promise((resolvePromise, rejectPromise) => {
    const onListening = () => {
      server.off("error", onError);
      resolvePromise();
    };
    const onError = () => {
      server.off("listening", onListening);
      rejectPromise(new Error("Server setup lokal tidak dapat dimulai."));
    };
    server.once("listening", onListening);
    server.once("error", onError);
  });
  server.listen(port, LOOPBACK_HOST);
  try {
    await listening;
  } catch (error) {
    server.close();
    throw error;
  }

  timeout = setTimeout(() => settleError(new Error("Setup lokal kedaluwarsa.")), STATE_TTL_MS);
  timeout.unref();

  return {
    url: SETUP_URL,
    result,
    close() {
      settleError(new Error("Setup GitHub App dihentikan."));
    },
  };
}

function showHelp() {
  process.stdout.write("Penggunaan: node scripts/setup-github-app.mjs [--name NAMA]\n");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    showHelp();
    return;
  }

  const session = await startBootstrapServer(options);
  process.stdout.write(`GitHub App: ${options.name}\nSetup lokal: ${session.url}\n`);
  try {
    const result = await session.result;
    process.stdout.write(`Setup selesai untuk ${result.appName}; konfigurasi tersimpan di .env.\n`);
  } finally {
    session.close();
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch(() => {
    process.stderr.write(`${PUBLIC_ERROR}\n`);
    process.exitCode = 1;
  });
}
