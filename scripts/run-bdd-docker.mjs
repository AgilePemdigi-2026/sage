import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";

const project = `sage-bdd-${randomBytes(5).toString("hex")}`;
const compose = ["compose", "-p", project, "-f", "compose.bdd.yaml"];
const head = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" });
const env = { ...process.env, SAGE_BDD_APP_COMMIT: head.status === 0 ? head.stdout.trim() : "unknown" };
mkdirSync("artifacts/bdd", { recursive: true });
let exitCode = 1;
let interrupted = 0;
const onInterrupt = () => { interrupted = 130; };
const onTerminate = () => { interrupted = 143; };
process.once("SIGINT", onInterrupt);
process.once("SIGTERM", onTerminate);
try {
  const result = spawnSync("docker", [...compose, "up", "--build", "--abort-on-container-exit", "--exit-code-from", "bdd"], { stdio: "inherit", env });
  exitCode = interrupted || (result.status ?? 1);
} finally {
  const cleanup = spawnSync("docker", [...compose, "down", "--volumes", "--remove-orphans"], { stdio: "inherit", env });
  if (cleanup.status !== 0) exitCode = 1;
}
process.off("SIGINT", onInterrupt);
process.off("SIGTERM", onTerminate);
process.exitCode = interrupted || exitCode;
