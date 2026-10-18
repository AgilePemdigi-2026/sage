import assert from "node:assert/strict";
import { database, disconnectDatabase } from "@sage/database";

const id = "environment-persistence-probe";
const marker = new Date("2000-01-01T00:00:00.000Z");
try {
  const db = database();
  if (process.argv[2] === "seed") {
    await db.workerHeartbeat.upsert({ where: { id }, create: { id, startedAt: marker }, update: { startedAt: marker } });
    console.log("Persistence marker seeded.");
  } else if (process.argv[2] === "check") {
    const row = await db.workerHeartbeat.findUniqueOrThrow({ where: { id } });
    assert.equal(row.startedAt.toISOString(), marker.toISOString());
    await db.workerHeartbeat.delete({ where: { id } });
    console.log("Persistence after restart: PASS; marker removed.");
  } else {
    throw new Error("Use seed or check.");
  }
} finally {
  await disconnectDatabase();
}
