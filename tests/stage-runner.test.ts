import assert from "node:assert/strict";
import test from "node:test";
import { ANALYSIS_STAGE_DEFINITIONS, ANALYSIS_STAGE_STATUSES } from "../packages/contracts/src/stages.ts";
import { runAnalysisStages, type AnalysisStageHandlers } from "../apps/worker/src/stage-runner.ts";
import type { PrismaClient } from "../packages/database/generated/client.ts";

const validClaim = {
  jobId: "job-1",
  analysisId: "analysis-1",
  ownerUserId: "user-1",
  attempt: 1,
  leaseToken: "550e8400-e29b-41d4-a716-446655440000",
  leaseExpiresAt: new Date("2026-10-19T00:00:00.000Z"),
};

test("stage contract fixes the documented nine-stage sequential order and status vocabulary", () => {
  assert.deepEqual(ANALYSIS_STAGE_DEFINITIONS.map(({ sequence, key }) => [sequence, key]), [
    [1, "SNAPSHOT"],
    [2, "LANGUAGE_DETECTION"],
    [3, "STATIC_ANALYSIS"],
    [4, "COMMON_CODE_MODEL"],
    [5, "KNOWLEDGE_GRAPH"],
    [6, "INTERFACE_CATALOG"],
    [7, "SOFTWARE_ENGINEERING_DIAGRAM"],
    [8, "UML_CLASS_DIAGRAM"],
    [9, "ARCHITECTURE_DOCUMENT"],
  ]);
  assert.deepEqual(ANALYSIS_STAGE_STATUSES, ["PENDING", "RUNNING", "COMPLETED", "FAILED"]);
});

test("runner rejects incomplete or unsafe handler registries before database access", async () => {
  const noDatabase = {} as PrismaClient;
  await assert.rejects(runAnalysisStages(noDatabase, validClaim, {} as AnalysisStageHandlers), /tepat sembilan/);

  const handlers = Object.fromEntries(ANALYSIS_STAGE_DEFINITIONS.map(({ key }) => [key, async () => undefined])) as unknown as AnalysisStageHandlers;
  const withExtraKey = { ...handlers, UNKNOWN: async () => undefined } as unknown as AnalysisStageHandlers;
  await assert.rejects(runAnalysisStages(noDatabase, validClaim, withExtraKey), /tepat sembilan/);
  await assert.rejects(runAnalysisStages(noDatabase, validClaim, handlers, { leaseDurationMs: 999 }), /Durasi lease/);
});
