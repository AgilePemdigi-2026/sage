import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = resolve(scriptPath, "../..");
const defaultComposeFile = resolve(repositoryRoot, "compose.coolify.yaml");
const noEnvFile = process.platform === "win32" ? "NUL" : "/dev/null";

const REQUIRED_SERVICES = ["db", "migrate", "web", "worker"];
const EXPECTED_MOUNTS = {
  db: [{ source: "database", target: "/var/lib/postgresql/data", readOnly: false }],
  migrate: [],
  web: [{ source: "storage", target: "/app/storage", readOnly: true }],
  worker: [{ source: "storage", target: "/app/storage", readOnly: false }],
};
const RESOURCE_LIMITS = {
  db: { memoryBytes: 1024 ** 3, cpus: 0.5, pids: 256 },
  migrate: { memoryBytes: 512 * 1024 ** 2, cpus: 0.5, pids: 128 },
  web: { memoryBytes: 768 * 1024 ** 2, cpus: 0.75, pids: 256 },
  worker: { memoryBytes: 2 * 1024 ** 3, cpus: 1.5, pids: 512 },
};
const IMAGE_WITH_DIGEST = /^[^\s@]+@sha256:[a-f0-9]{64}$/u;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function envOf(service) {
  return isRecord(service?.environment) ? service.environment : {};
}

function parseMemoryBytes(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : Number.NaN;
  if (typeof value !== "string") return Number.NaN;
  const match = /^(\d+(?:\.\d+)?)(b|k|kb|m|mb|g|gb)?$/iu.exec(value.trim());
  if (!match) return Number.NaN;
  const amount = Number(match[1]);
  const unit = (match[2] ?? "b").toLowerCase();
  const power = unit.startsWith("k") ? 1 : unit.startsWith("m") ? 2 : unit.startsWith("g") ? 3 : 0;
  const multiplier = unit === "kb" || unit === "mb" || unit === "gb" ? 1000 ** power : 1024 ** power;
  return amount * multiplier;
}

function parseCanonicalEncryptionKey(value) {
  if (typeof value !== "string" || value.length === 0) return false;
  const bytes = Buffer.from(value, "base64");
  return bytes.length === 32 && bytes.toString("base64") === value;
}

function isHttpsOrigin(value) {
  if (typeof value !== "string" || value.length === 0) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:"
      && parsed.origin !== "null"
      && parsed.username === ""
      && parsed.password === ""
      && parsed.pathname === "/"
      && parsed.search === ""
      && parsed.hash === ""
      && value === parsed.origin;
  } catch {
    return false;
  }
}

function isDatabaseUrl(value, password) {
  if (typeof value !== "string" || typeof password !== "string") return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "postgresql:"
      && parsed.username === "sage"
      && parsed.password === password
      && parsed.hostname === "db"
      && parsed.port === "5432"
      && parsed.pathname === "/sage"
      && parsed.search === ""
      && parsed.hash === "";
  } catch {
    return false;
  }
}

function add(issues, condition, code) {
  if (!condition) issues.push(code);
}

/**
 * Validate a resolved `docker compose config --format json` object.
 * Returns stable, non-sensitive issue codes and never returns interpolated values.
 * @param {unknown} config
 * @returns {string[]}
 */
export function validateDeploymentConfig(config) {
  const issues = [];
  if (!isRecord(config) || !isRecord(config.services)) return ["CONFIG_SHAPE"];

  const services = config.services;
  add(issues, REQUIRED_SERVICES.every((name) => isRecord(services[name]))
    && Object.keys(services).length === REQUIRED_SERVICES.length, "SERVICES_REQUIRED");
  for (const service of Object.values(services)) {
    if (isRecord(service)) {
      add(issues, !Object.hasOwn(service, "build"), "BUILD_FORBIDDEN");
      add(issues, !Object.hasOwn(service, "container_name"), "CONTAINER_NAME_FORBIDDEN");
      const ports = service.ports;
      add(issues, ports === undefined || (Array.isArray(ports) && ports.length === 0), "PORTS_FORBIDDEN");
      add(issues, service.network_mode !== "host", "HOST_NETWORK_FORBIDDEN");
      add(issues, service.privileged !== true, "PRIVILEGED_FORBIDDEN");
    }
  }

  const db = services.db;
  const migrate = services.migrate;
  const web = services.web;
  const worker = services.worker;
  if (![db, migrate, web, worker].every(isRecord)) return [...new Set([...issues, "SERVICES_REQUIRED"])];

  add(issues, typeof web.image === "string" && IMAGE_WITH_DIGEST.test(web.image), "WEB_IMAGE_DIGEST");
  add(issues, typeof worker.image === "string" && IMAGE_WITH_DIGEST.test(worker.image), "WORKER_IMAGE_DIGEST");
  add(issues, migrate.image === worker.image, "MIGRATION_IMAGE_MATCH");
  add(issues, typeof db.image === "string" && /^postgres:17-[^\s@]+@sha256:[a-f0-9]{64}$/u.test(db.image), "POSTGRES_IMAGE_DIGEST");

  const topVolumes = isRecord(config.volumes) ? config.volumes : {};
  const databaseVolume = topVolumes.database;
  const storageVolume = topVolumes.storage;
  add(issues, isRecord(databaseVolume) && isRecord(storageVolume)
    && databaseVolume.external !== true && storageVolume.external !== true, "NAMED_VOLUMES_REQUIRED");
  for (const [serviceName, expectedMounts] of Object.entries(EXPECTED_MOUNTS)) {
    const mounts = services[serviceName].volumes;
    const actualMounts = Array.isArray(mounts) ? mounts : [];
    const matches = actualMounts.length === expectedMounts.length && expectedMounts.every((expected, index) => {
      const actual = actualMounts[index];
      return isRecord(actual)
        && actual.type === "volume"
        && actual.source === expected.source
        && actual.target === expected.target
        && Boolean(actual.read_only) === expected.readOnly;
    });
    add(issues, matches, "VOLUME_LAYOUT");
  }

  for (const serviceName of ["db", "web", "worker"]) {
    const healthcheck = services[serviceName].healthcheck;
    const activeHealthcheck = isRecord(healthcheck)
      && healthcheck.disable !== true
      && Array.isArray(healthcheck.test)
      && healthcheck.test.length > 0
      && healthcheck.test[0] !== "NONE";
    add(issues, activeHealthcheck, "HEALTHCHECK_REQUIRED");
  }
  const dbDependency = isRecord(migrate.depends_on) ? migrate.depends_on.db : undefined;
  add(issues, isRecord(dbDependency) && dbDependency.condition === "service_healthy", "MIGRATION_DATABASE_ORDER");
  for (const serviceName of ["web", "worker"]) {
    const migrationDependency = isRecord(services[serviceName].depends_on) ? services[serviceName].depends_on.migrate : undefined;
    add(issues, isRecord(migrationDependency) && migrationDependency.condition === "service_completed_successfully",
      "MIGRATION_STARTUP_ORDER");
  }
  const migrateEnvironment = envOf(migrate);
  add(issues, migrate.restart === "no", "MIGRATION_RESTART_POLICY");
  add(issues, Array.isArray(web.expose) && web.expose.some((port) => String(port) === "3000"), "WEB_EXPOSE_REQUIRED");

  for (const [serviceName, ceiling] of Object.entries(RESOURCE_LIMITS)) {
    const service = services[serviceName];
    const memory = parseMemoryBytes(service.mem_limit);
    const cpus = Number(service.cpus);
    const pids = Number(service.pids_limit);
    add(issues, Number.isFinite(memory) && memory > 0 && memory <= ceiling.memoryBytes, "RESOURCE_MEMORY_LIMIT");
    add(issues, Number.isFinite(cpus) && cpus > 0 && cpus <= ceiling.cpus, "RESOURCE_CPU_LIMIT");
    add(issues, Number.isSafeInteger(pids) && pids > 0 && pids <= ceiling.pids, "RESOURCE_PIDS_LIMIT");
  }

  const dbEnvironment = envOf(db);
  add(issues, dbEnvironment.POSTGRES_USER === "sage" && dbEnvironment.POSTGRES_DB === "sage", "POSTGRES_IDENTITY");
  const webEnvironment = envOf(web);
  const workerEnvironment = envOf(worker);
  const postgresPassword = dbEnvironment.POSTGRES_PASSWORD;
  add(issues, typeof postgresPassword === "string" && /^[a-fA-F0-9]{32,}$/u.test(postgresPassword)
    && postgresPassword.length % 2 === 0, "POSTGRES_PASSWORD_FORMAT");
  add(issues, isDatabaseUrl(webEnvironment.DATABASE_URL, postgresPassword)
    && webEnvironment.DATABASE_URL === workerEnvironment.DATABASE_URL
    && webEnvironment.DATABASE_URL === migrateEnvironment.DATABASE_URL,
  "DATABASE_URL_LAYOUT");

  const webEncryptionKey = webEnvironment.CREDENTIAL_ENCRYPTION_KEY;
  add(issues, parseCanonicalEncryptionKey(webEncryptionKey), "ENCRYPTION_KEY_FORMAT");
  add(issues, parseCanonicalEncryptionKey(workerEnvironment.CREDENTIAL_ENCRYPTION_KEY)
    && workerEnvironment.CREDENTIAL_ENCRYPTION_KEY === webEncryptionKey, "ENCRYPTION_KEY_MATCH");

  const authBaseUrl = webEnvironment.AUTH_BASE_URL;
  add(issues, isHttpsOrigin(authBaseUrl) && workerEnvironment.AUTH_BASE_URL === authBaseUrl, "AUTH_BASE_URL_ORIGIN");
  const clientId = webEnvironment.GITHUB_APP_CLIENT_ID;
  const clientSecret = webEnvironment.GITHUB_APP_CLIENT_SECRET;
  add(issues, typeof clientId === "string" && /^[A-Za-z0-9._-]{1,256}$/u.test(clientId), "GITHUB_CLIENT_ID");
  add(issues, typeof clientSecret === "string" && clientSecret.length > 0 && clientSecret.length <= 4096,
    "GITHUB_CLIENT_SECRET");
  const slug = webEnvironment.GITHUB_APP_SLUG;
  add(issues, slug === undefined || slug === "" || (typeof slug === "string"
    && /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/u.test(slug)), "GITHUB_APP_SLUG");

  return [...new Set(issues)];
}

function parseArgs(args) {
  const result = { composeFile: defaultComposeFile, envFile: noEnvFile, help: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") result.help = true;
    else if (arg === "--compose" && args[index + 1]) result.composeFile = resolve(args[++index]);
    else if (arg === "--env-file" && args[index + 1]) result.envFile = resolve(args[++index]);
    else throw new Error("USAGE");
  }
  return result;
}

function run() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch {
    console.log("DEPLOYMENT_CHECK_FAILED USAGE");
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    console.log("Usage: node scripts/check-deployment.mjs [--env-file PATH] [--compose PATH]");
    console.log("With no --env-file, only the current process environment is used.");
    return;
  }
  if (!existsSync(options.composeFile) || !existsSync(options.envFile)) {
    console.log("DEPLOYMENT_CHECK_FAILED INPUT_FILE");
    process.exitCode = 1;
    return;
  }

  let config;
  try {
    const output = execFileSync("docker", ["compose", "--env-file", options.envFile, "--file", options.composeFile,
      "config", "--format", "json"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 });
    config = JSON.parse(output);
  } catch {
    console.log("DEPLOYMENT_CHECK_FAILED COMPOSE_CONFIG");
    process.exitCode = 1;
    return;
  }

  const issues = validateDeploymentConfig(config);
  if (issues.length > 0) {
    console.log(`DEPLOYMENT_CHECK_FAILED ${issues.join(" ")}`);
    process.exitCode = 1;
    return;
  }
  console.log("DEPLOYMENT_CONFIG_OK");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) run();
