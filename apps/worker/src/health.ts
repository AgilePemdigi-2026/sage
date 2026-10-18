import { readFile } from "node:fs/promises";

const lastSeen = Number(await readFile("/tmp/sage-worker-heartbeat", "utf8"));
if (!Number.isFinite(lastSeen) || Date.now() - lastSeen > 20000) process.exit(1);
