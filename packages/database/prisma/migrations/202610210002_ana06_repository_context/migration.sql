BEGIN;

ALTER TABLE "Analysis"
    ADD COLUMN "repositoryFullNameSnapshot" TEXT;

COMMIT;
