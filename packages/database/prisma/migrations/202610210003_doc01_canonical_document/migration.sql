BEGIN;

ALTER TABLE "ArchitectureDocument"
    ADD COLUMN "canonicalContent" TEXT;

COMMIT;
