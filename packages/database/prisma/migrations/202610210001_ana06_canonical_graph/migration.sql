BEGIN;

ALTER TABLE "GraphBundle"
    ADD COLUMN "canonicalContent" TEXT;

COMMIT;
