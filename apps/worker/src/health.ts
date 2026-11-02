import { readFile } from "node:fs/promises";

try {
  const lastSeen = Number(await readFile("/tmp/sage-worker-heartbeat", "utf8"));
  const age = Date.now() - lastSeen;
  if (!Number.isSafeInteger(lastSeen) || lastSeen <= 0 || age < 0 || age > 20_000) process.exitCode = 1;
} catch {
  process.exitCode = 1;
}
