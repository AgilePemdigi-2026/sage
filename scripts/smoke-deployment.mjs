import { isPrivateNamedVolume } from "./check-deployment.mjs";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = resolve(scriptPath, "../..");
const defaultComposeFile = resolve(repositoryRoot, "compose.coolify.yaml");
const noEnvFile = process.platform === "win32" ? "NUL" : "/dev/null";

function parseArgs(args) {
  const result = { composeFile: defaultComposeFile, envFile: noEnvFile, project: "", publicUrl: "", help: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") result.help = true;
    else if (arg === "--compose" && args[index + 1]) result.composeFile = resolve(args[++index]);
    else if (arg === "--env-file" && args[index + 1]) result.envFile = resolve(args[++index]);
    else if (arg === "--project" && args[index + 1]) result.project = args[++index];
    else if (arg === "--url" && args[index + 1]) result.publicUrl = args[++index];
    else throw new Error("USAGE");
  }
  return result;
}

function runDocker(args) {
  try {
    return execFileSync("docker", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 20_000,
      maxBuffer: 1024 * 1024,
    });
  } catch {
    return null;
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function configMountMatches(service, source, target, readOnly) {
  if (!isRecord(service) || !Array.isArray(service.volumes) || service.volumes.length !== 1) return false;
  const mount = service.volumes[0];
  return isRecord(mount)
    && mount.type === "volume"
    && mount.source === source
    && mount.target === target
    && Boolean(mount.read_only) === readOnly;
}

function hasSafeConfiguredStorage(config) {
  if (!isRecord(config) || !isRecord(config.services) || Object.keys(config.services).length !== 4
    || !isRecord(config.volumes)) return false;
  const { db, migrate, web, worker } = config.services;
  if (![db, migrate, web, worker].every(isRecord)) return false;
  if (!isPrivateNamedVolume(config.volumes.database, config.name)
    || !isPrivateNamedVolume(config.volumes.storage, config.name)) return false;
  if (!configMountMatches(db, "database", "/var/lib/postgresql/data", false)
    || !configMountMatches(web, "storage", "/app/storage", true)
    || !configMountMatches(worker, "storage", "/app/storage", false)
    || (migrate.volumes !== undefined && (!Array.isArray(migrate.volumes) || migrate.volumes.length !== 0))) return false;
  for (const service of Object.values(config.services)) {
    if (!isRecord(service)
      || Object.hasOwn(service, "build")
      || Object.hasOwn(service, "container_name")
      || service.network_mode === "host"
      || service.privileged === true
      || (Array.isArray(service.ports) && service.ports.length > 0)) return false;
  }
  return Array.isArray(web.expose) && web.expose.some((port) => String(port) === "3000");
}

function parseComposePs(output) {
  try {
    const parsed = JSON.parse(output);
    if (Array.isArray(parsed)) return parsed.filter(isRecord);
    if (isRecord(parsed)) return [parsed];
  } catch {
    // Compose versions can emit one JSON object per line. Parse only those rows.
  }
  const rows = [];
  for (const line of output.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (isRecord(parsed)) rows.push(parsed);
    } catch {
      return null;
    }
  }
  return rows.length > 0 ? rows : null;
}

function rowValue(row, ...keys) {
  for (const key of keys) if (typeof row[key] === "string" || typeof row[key] === "number") return row[key];
  return undefined;
}

function rowsForService(rows, serviceName) {
  return rows.filter((row) => rowValue(row, "Service", "service") === serviceName);
}

function healthyServiceRow(rows, serviceName) {
  return rowsForService(rows, serviceName).find((row) => String(rowValue(row, "State", "state") ?? "").toLowerCase() === "running"
    && String(rowValue(row, "Health", "health") ?? "").toLowerCase() === "healthy");
}

function migrationSucceeded(rows) {
  return rowsForService(rows, "migrate").some((row) => String(rowValue(row, "State", "state") ?? "").toLowerCase() === "exited"
    && Number(rowValue(row, "ExitCode", "exitCode", "exit_code")) === 0);
}

function inspectMounts(row) {
  const containerId = rowValue(row, "ID", "Id", "id");
  if (typeof containerId !== "string" || !/^[a-f0-9]{12,64}$/iu.test(containerId)) return null;
  const output = runDocker(["inspect", "--format", "{{json .Mounts}}", containerId]);
  if (output === null) return null;
  try {
    const parsed = JSON.parse(output);
    return Array.isArray(parsed) ? parsed.filter(isRecord) : null;
  } catch {
    return null;
  }
}

function isExpectedRuntimeVolume(mounts, destination, readWrite, project) {
  if (!Array.isArray(mounts) || mounts.length !== 1) return false;
  const mount = mounts[0];
  const name = mount.Name ?? mount.name;
  const projectPrefix = typeof name === "string" && (name.startsWith(`${project}_`) || name.startsWith(`${project}-`));
  if (mount.Type !== "volume" || mount.Destination !== destination || mount.RW !== readWrite || !projectPrefix) return false;
  const output = runDocker(["volume", "inspect", "--format", "{{json .}}", name]);
  if (output === null) return false;
  try {
    const definition = JSON.parse(output);
    return definition.Driver === "local" && (definition.Options === null
      || (isRecord(definition.Options) && Object.keys(definition.Options).length === 0));
  } catch { return false; }
}

function isHttpsOrigin(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && url.origin !== "null"
      && url.username === ""
      && url.password === ""
      && url.pathname === "/"
      && url.search === ""
      && url.hash === ""
      && value === url.origin;
  } catch {
    return false;
  }
}

async function checkPublicHealth(origin) {
  try {
    const response = await fetch(new URL("/api/health", origin), {
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status !== 200) return false;
    const body = await response.json();
    return body?.status === "ok" && body?.service === "web" && body?.database === "ok";
  } catch {
    return false;
  }
}

async function run() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch {
    console.log("DEPLOYMENT_SMOKE_FAILED USAGE");
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    console.log("Usage: node scripts/smoke-deployment.mjs --project NAME [--env-file PATH] [--compose PATH] [--url HTTPS_ORIGIN]");
    console.log("Checks the explicitly named Compose project. With no --env-file, only the current process environment is used.");
    return;
  }

  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/u.test(options.project)) {
    console.log("DEPLOYMENT_SMOKE_FAILED PROJECT_REQUIRED");
    process.exitCode = 2;
    return;
  }
  if (!existsSync(options.composeFile) || !existsSync(options.envFile)) {
    console.log("DEPLOYMENT_SMOKE_FAILED INPUT_FILE");
    process.exitCode = 1;
    return;
  }
  if (options.publicUrl && !isHttpsOrigin(options.publicUrl)) {
    console.log("DEPLOYMENT_SMOKE_FAILED PUBLIC_URL_ORIGIN");
    process.exitCode = 2;
    return;
  }

  const composeArgs = ["compose", "--project-name", options.project, "--env-file", options.envFile,
    "--file", options.composeFile];
  const configOutput = runDocker([...composeArgs, "config", "--format", "json"]);
  if (configOutput === null) {
    console.log("DEPLOYMENT_SMOKE_FAILED COMPOSE_CONFIG");
    process.exitCode = 1;
    return;
  }
  let composeConfig;
  try {
    composeConfig = JSON.parse(configOutput);
  } catch {
    console.log("DEPLOYMENT_SMOKE_FAILED COMPOSE_CONFIG_OUTPUT");
    process.exitCode = 1;
    return;
  }
  if (!hasSafeConfiguredStorage(composeConfig)) {
    console.log("DEPLOYMENT_SMOKE_FAILED STORAGE_CONFIG");
    process.exitCode = 1;
    return;
  }

  const psOutput = runDocker([...composeArgs, "ps", "--all", "--format", "json"]);
  if (psOutput === null) {
    console.log("DEPLOYMENT_SMOKE_FAILED COMPOSE_PS");
    process.exitCode = 1;
    return;
  }
  const rows = parseComposePs(psOutput);
  if (!rows) {
    console.log("DEPLOYMENT_SMOKE_FAILED COMPOSE_PS_OUTPUT");
    process.exitCode = 1;
    return;
  }

  const issues = [];
  const dbRow = healthyServiceRow(rows, "db");
  const webRow = healthyServiceRow(rows, "web");
  const workerRow = healthyServiceRow(rows, "worker");
  if (!dbRow) issues.push("DB_UNHEALTHY");
  if (!migrationSucceeded(rows)) issues.push("MIGRATION_NOT_SUCCESSFUL");
  if (!webRow) issues.push("WEB_UNHEALTHY");
  if (!workerRow) issues.push("WORKER_UNHEALTHY");

  if (dbRow && webRow && workerRow) {
    const dbMounts = inspectMounts(dbRow);
    const webMounts = inspectMounts(webRow);
    const workerMounts = inspectMounts(workerRow);
    const databaseVolumeSafe = isExpectedRuntimeVolume(dbMounts, "/var/lib/postgresql/data", true, options.project);
    const webStorageSafe = isExpectedRuntimeVolume(webMounts, "/app/storage", false, options.project);
    const workerStorageSafe = isExpectedRuntimeVolume(workerMounts, "/app/storage", true, options.project);
    const webStorageName = webMounts?.[0]?.Name ?? webMounts?.[0]?.name;
    const workerStorageName = workerMounts?.[0]?.Name ?? workerMounts?.[0]?.name;
    if (!databaseVolumeSafe || !webStorageSafe || !workerStorageSafe || webStorageName !== workerStorageName) {
      issues.push("STORAGE_RUNTIME");
    }
  }

  if (!issues.includes("WEB_UNHEALTHY")) {
    const healthCommand = ["compose", "--project-name", options.project, "--env-file", options.envFile,
      "--file", options.composeFile, "exec", "-T", "web", "node", "-e",
      "fetch('http://127.0.0.1:3000/api/health',{redirect:'manual'}).then(async r=>{if(r.status!==200)process.exit(1);const b=await r.json();if(b.status!=='ok'||b.service!=='web'||b.database!=='ok')process.exit(1)}).catch(()=>process.exit(1))"];
    if (runDocker(healthCommand) === null) issues.push("WEB_API_HEALTH");
  }
  if (!issues.includes("WORKER_UNHEALTHY")) {
    const workerHealthCommand = ["compose", "--project-name", options.project, "--env-file", options.envFile,
      "--file", options.composeFile, "exec", "-T", "worker", "node", "--import", "tsx", "apps/worker/src/health.ts"];
    if (runDocker(workerHealthCommand) === null) issues.push("WORKER_HEARTBEAT_HEALTH");
  }
  if (options.publicUrl && !(await checkPublicHealth(options.publicUrl))) issues.push("PUBLIC_API_HEALTH");

  if (issues.length > 0) {
    console.log(`DEPLOYMENT_SMOKE_FAILED ${issues.join(" ")}`);
    process.exitCode = 1;
    return;
  }
  console.log("DEPLOYMENT_SMOKE_OK");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await run();
