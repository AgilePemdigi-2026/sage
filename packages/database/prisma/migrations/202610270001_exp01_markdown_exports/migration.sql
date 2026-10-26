BEGIN;

ALTER TABLE "Export" ADD COLUMN "documentHash" VARCHAR(64);

UPDATE "Export" AS export
SET "documentHash" = document."contentHash"
FROM "ArchitectureDocument" AS document
WHERE document."id" = export."architectureDocumentId"
  AND document."analysisId" = export."analysisId"
  AND document."ownerUserId" = export."ownerUserId";

ALTER TABLE "Export" ALTER COLUMN "documentHash" SET NOT NULL;

CREATE UNIQUE INDEX "Export_owner_analysis_format_documentHash_rendererVersion_key"
  ON "Export" ("ownerUserId", "analysisId", "format", "documentHash", "rendererVersion");

CREATE INDEX "Export_ownerUserId_analysisId_format_status_idx"
  ON "Export" ("ownerUserId", "analysisId", "format", "status");

ALTER TABLE "Job"
  ADD CONSTRAINT "Job_export_queueSequence_check"
  CHECK ("type" <> 'EXPORT' OR ("analysisId" IS NOT NULL AND "exportId" IS NOT NULL AND "queueSequence" IS NOT NULL));

CREATE UNIQUE INDEX "Job_export_queueSequence_key"
  ON "Job" ("queueSequence")
  WHERE "type" = 'EXPORT';

COMMIT;
