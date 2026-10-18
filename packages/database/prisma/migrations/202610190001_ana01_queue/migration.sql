-- Analysis queue invariants require PostgreSQL partial indexes because Prisma
-- cannot represent these predicates without a preview schema feature.
BEGIN;

ALTER TABLE "Job"
    ADD COLUMN "queueSequence" BIGINT;

ALTER TABLE "WorkerSlot"
    ADD COLUMN "leaseTokenHash" TEXT,
    ADD COLUMN "lastEnqueueSequence" BIGINT NOT NULL DEFAULT 0;

WITH ordered_analysis_jobs AS (
    SELECT "id", row_number() OVER (ORDER BY "enqueuedAt", "id") AS sequence
    FROM "Job"
    WHERE "type" = 'ANALYSIS'
)
UPDATE "Job" AS job
SET "queueSequence" = ordered_analysis_jobs.sequence
FROM ordered_analysis_jobs
WHERE job."id" = ordered_analysis_jobs."id";

UPDATE "WorkerSlot"
SET "lastEnqueueSequence" = COALESCE(
    (SELECT MAX("queueSequence") FROM "Job" WHERE "type" = 'ANALYSIS'),
    0
);

-- The pre-ANA-01 worker did not claim database jobs, so legacy RUNNING states
-- have no lease token with which a new worker could safely resume them.
UPDATE "AnalysisStage" AS stage
SET "status" = 'FAILED', "errorCode" = 'WORKER_INTERRUPTED',
    "finishedAt" = clock_timestamp(), "updatedAt" = clock_timestamp()
WHERE stage."status" = 'RUNNING';

UPDATE "Job"
SET "status" = 'FAILED', "errorCode" = 'WORKER_INTERRUPTED',
    "finishedAt" = clock_timestamp(), "updatedAt" = clock_timestamp()
WHERE "type" = 'ANALYSIS' AND "status" = 'RUNNING';

UPDATE "Analysis"
SET "status" = 'FAILED', "errorCode" = 'WORKER_INTERRUPTED',
    "completedAt" = clock_timestamp(), "updatedAt" = clock_timestamp()
WHERE "status" = 'RUNNING';

UPDATE "WorkerSlot"
SET "jobId" = NULL, "ownerUserId" = NULL, "leaseUntil" = NULL,
    "heartbeatAt" = NULL, "leaseTokenHash" = NULL, "updatedAt" = clock_timestamp()
WHERE "slotKey" = 'analysis';

ALTER TABLE "Job"
    ADD CONSTRAINT "Job_analysis_queueSequence_check"
    CHECK ("type" <> 'ANALYSIS' OR ("analysisId" IS NOT NULL AND "queueSequence" IS NOT NULL));

CREATE UNIQUE INDEX "Job_analysis_queueSequence_key"
    ON "Job" ("queueSequence")
    WHERE "type" = 'ANALYSIS';

CREATE UNIQUE INDEX "Job_one_per_analysis_key"
    ON "Job" ("analysisId")
    WHERE "type" = 'ANALYSIS';

CREATE UNIQUE INDEX "Analysis_one_running_idx"
    ON "Analysis" ((true))
    WHERE "status" = 'RUNNING';

CREATE UNIQUE INDEX "Job_one_running_analysis_idx"
    ON "Job" ((true))
    WHERE "type" = 'ANALYSIS' AND "status" = 'RUNNING';

COMMIT;
