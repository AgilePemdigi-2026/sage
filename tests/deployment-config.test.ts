import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error The runtime checker is plain JavaScript so it can run without tsx.
import { validateDeploymentConfig } from "../scripts/check-deployment.mjs";

const password = "a".repeat(64);
const encryptionKey = Buffer.alloc(32, 7).toString("base64");
const workerImage = `registry.example/sage-worker:release@sha256:${"b".repeat(64)}`;
const webImage = `registry.example/sage-web:release@sha256:${"a".repeat(64)}`;
const postgresImage = `postgres:17-bookworm@sha256:${"c".repeat(64)}`;

function validConfig() {
  const databaseUrl = `postgresql://sage:${password}@db:5432/sage`;
  return {
    services: {
      db: {
        image: postgresImage,
        environment: { POSTGRES_USER: "sage", POSTGRES_DB: "sage", POSTGRES_PASSWORD: password },
        volumes: [{ type: "volume", source: "database", target: "/var/lib/postgresql/data" }],
        healthcheck: { test: ["CMD-SHELL", "pg_isready -U sage -d sage"] },
        mem_limit: 1024 ** 3,
        cpus: 0.5,
        pids_limit: 256,
      },
      migrate: {
        image: workerImage,
        environment: { DATABASE_URL: databaseUrl },
        volumes: [],
        depends_on: { db: { condition: "service_healthy" } },
        restart: "no",
        mem_limit: 512 * 1024 ** 2,
        cpus: 0.5,
        pids_limit: 128,
      },
      web: {
        image: webImage,
        environment: {
          DATABASE_URL: databaseUrl,
          CREDENTIAL_ENCRYPTION_KEY: encryptionKey,
          AUTH_BASE_URL: "https://sage.example.com",
          GITHUB_APP_CLIENT_ID: "Iv1.test-client",
          GITHUB_APP_CLIENT_SECRET: "test-secret",
          GITHUB_APP_SLUG: "sage-test",
        },
        expose: ["3000"],
        volumes: [{ type: "volume", source: "storage", target: "/app/storage", read_only: true }],
        depends_on: { migrate: { condition: "service_completed_successfully" } },
        healthcheck: { test: ["CMD", "node", "health"] },
        mem_limit: 768 * 1024 ** 2,
        cpus: 0.75,
        pids_limit: 256,
      },
      worker: {
        image: workerImage,
        environment: {
          DATABASE_URL: databaseUrl,
          CREDENTIAL_ENCRYPTION_KEY: encryptionKey,
          AUTH_BASE_URL: "https://sage.example.com",
        },
        volumes: [{ type: "volume", source: "storage", target: "/app/storage" }],
        depends_on: { migrate: { condition: "service_completed_successfully" } },
        healthcheck: { test: ["CMD", "node", "worker-health"] },
        mem_limit: 2 * 1024 ** 3,
        cpus: 1.5,
        pids_limit: 512,
      },
    },
    volumes: { database: {}, storage: {} },
  };
}

test("accepts the locked-down four-service production deployment shape", () => {
  assert.deepEqual(validateDeploymentConfig(validConfig()), []);
});

test("rejects mutable or mismatched production images", () => {
  const config = validConfig();
  config.services.web.image = "registry.example/sage-web:latest";
  config.services.migrate.image = `registry.example/sage-worker:other@sha256:${"d".repeat(64)}`;
  const issues = validateDeploymentConfig(config);
  assert.ok(issues.includes("WEB_IMAGE_DIGEST"));
  assert.ok(issues.includes("MIGRATION_IMAGE_MATCH"));
});

test("rejects published ports and host-mounted application storage", () => {
  const config = validConfig();
  Object.assign(config.services.db, { ports: [{ target: 5432, published: "5432", host_ip: "0.0.0.0" }] });
  config.services.worker.volumes = [{ type: "bind", source: "/srv/sage", target: "/app/storage" }];
  const issues = validateDeploymentConfig(config);
  assert.ok(issues.includes("PORTS_FORBIDDEN"));
  assert.ok(issues.includes("VOLUME_LAYOUT"));
});

test("rejects mismatched encryption keys and a non-public auth origin", () => {
  const config = validConfig();
  config.services.worker.environment.CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 8).toString("base64");
  config.services.web.environment.AUTH_BASE_URL = "http://localhost:3000";
  const issues = validateDeploymentConfig(config);
  assert.ok(issues.includes("ENCRYPTION_KEY_MATCH"));
  assert.ok(issues.includes("AUTH_BASE_URL_ORIGIN"));
});

test("rejects weak credentials, missing health, broken startup ordering, and excessive limits", () => {
  const config = validConfig();
  config.services.db.environment.POSTGRES_PASSWORD = "short";
  config.services.worker.healthcheck = { test: [] };
  config.services.web.depends_on.migrate.condition = "service_started";
  config.services.worker.mem_limit = 3 * 1024 ** 3;
  const issues = validateDeploymentConfig(config);
  assert.ok(issues.includes("POSTGRES_PASSWORD_FORMAT"));
  assert.ok(issues.includes("HEALTHCHECK_REQUIRED"));
  assert.ok(issues.includes("MIGRATION_STARTUP_ORDER"));
  assert.ok(issues.includes("RESOURCE_MEMORY_LIMIT"));
});

test("rejects migration database drift and unexpected Postgres identity", () => {
  const config = validConfig();
  config.services.migrate.environment.DATABASE_URL = `postgresql://sage:${"f".repeat(64)}@db:5432/sage`;
  config.services.db.environment.POSTGRES_USER = "root";
  const issues = validateDeploymentConfig(config);
  assert.ok(issues.includes("DATABASE_URL_LAYOUT"));
  assert.ok(issues.includes("POSTGRES_IDENTITY"));
});

test("rejects disabled health, external volumes, host networking, and extra services", () => {
  const config = validConfig();
  config.services.db.healthcheck = { test: ["NONE"] };
  Object.assign(config.volumes.storage, { external: true });
  Object.assign(config.services.worker, { network_mode: "host" });
  Object.assign(config.services, { debug: { image: "busybox:latest" } });
  const issues = validateDeploymentConfig(config);
  assert.ok(issues.includes("HEALTHCHECK_REQUIRED"));
  assert.ok(issues.includes("NAMED_VOLUMES_REQUIRED"));
  assert.ok(issues.includes("HOST_NETWORK_FORBIDDEN"));
  assert.ok(issues.includes("SERVICES_REQUIRED"));
});


test("rejects named volume host-bind options and unsupported storage drivers", () => {
  const bound = validConfig();
  Object.assign(bound.volumes.storage, { driver: "local", driver_opts: { type: "none", o: "bind", device: "/srv/unrelated" } });
  assert.ok(validateDeploymentConfig(bound).includes("NAMED_VOLUMES_REQUIRED"));
  const remote = validConfig();
  Object.assign(remote.volumes.storage, { driver: "third-party" });
  assert.ok(validateDeploymentConfig(remote).includes("NAMED_VOLUMES_REQUIRED"));
});

test("requires resolved explicit volume names to remain in their Compose project namespace", () => {
  const aliased = validConfig();
  Object.assign(aliased, { name: "sage-testing" });
  Object.assign(aliased.volumes.storage, { name: "other-product_storage" });
  assert.ok(validateDeploymentConfig(aliased).includes("NAMED_VOLUMES_REQUIRED"));
  Object.assign(aliased.volumes.storage, { name: "sage-testing_storage", driver: "local" });
  assert.deepEqual(validateDeploymentConfig(aliased), []);
});
