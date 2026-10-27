BEGIN;

ALTER TABLE "Analysis"
  ADD COLUMN "deletionRequestedAt" TIMESTAMP(3);

ALTER TABLE "Job"
  ADD COLUMN "cleanupAnalysisId" TEXT,
  ADD COLUMN "cleanupManifest" JSONB,
  ADD COLUMN "storageReservations" JSONB NOT NULL DEFAULT '[]'::jsonb;

CREATE UNIQUE INDEX "Job_cleanupAnalysisId_key" ON "Job"("cleanupAnalysisId");
CREATE INDEX "Job_cleanup_queue_idx" ON "Job"("status", "enqueuedAt", "id") WHERE "type" = 'CLEANUP';
CREATE INDEX "Analysis_owner_deletionRequestedAt_idx" ON "Analysis"("ownerUserId", "deletionRequestedAt");

COMMIT;
