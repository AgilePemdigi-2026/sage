import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseSource } from "@sage/analyzer-js";
import { parsePhp } from "@sage/analyzer-php";
import { renderProbe } from "@sage/documents";
import { database, disconnectDatabase } from "@sage/database";
import { fixtureRoot, verifyFixtures } from "./verify-fixtures.ts";

const output = join(process.env.STORAGE_ROOT ?? "artifacts", "environment");
await mkdir(output, { recursive: true });
const run = { date: new Date().toISOString(), node: process.version, platform: process.platform, arch: process.arch, checks: [] as object[], scope: "ENV-01 compatibility and QA-01 seed integrity; not application acceptance" };

try {
  const db = database();
  await db.$queryRaw`SELECT 1`;
  assert.ok(await db.workerHeartbeat.count() > 0, "worker heartbeat must be present");
  run.checks.push({ name: "database-and-migration", status: "PASS" });

  const manifest = await verifyFixtures();
  run.checks.push({ name: "fixture-integrity", files: manifest.files.length, oracles: manifest.oracles.length, status: "PASS", semanticAcceptance: "NOT_RUN" });
  for (const item of manifest.files.filter((file) => file.language)) {
    const source = await readFile(new URL(item.path, fixtureRoot), "utf8");
    const start = performance.now();
    const result = item.language === "php" ? await parsePhp(source) : parseSource(source, item.path);
    assert.equal(result.valid, item.syntaxValid, item.path);
    run.checks.push({ name: item.path, status: "PASS", milliseconds: Math.round((performance.now() - start) * 100) / 100, sizeBytes: item.sizeBytes, ...result });
  }
  const render = await renderProbe(join(output, "renderer-probe.pdf"));
  assert.ok(render.svg.includes("<svg"));
  assert.ok((await readFile(render.pdfPath)).subarray(0, 5).toString() === "%PDF-");
  await writeFile(join(output, "renderer-probe.svg"), render.svg);
  run.checks.push({ name: "chromium-mermaid-pdf", status: "PASS", chromium: render.browserVersion });
  await writeFile(join(output, "report.json"), JSON.stringify({ ...run, peakRssKiB: process.resourceUsage().maxRSS }, null, 2) + "\n");
  console.log(JSON.stringify({ status: "PASS", checks: run.checks.length, output, peakRssKiB: process.resourceUsage().maxRSS }));
} finally {
  await disconnectDatabase();
}
