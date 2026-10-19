BEGIN;

ALTER TABLE "Analysis"
    ADD COLUMN "idempotencyKeyHash" VARCHAR(64),
    ADD COLUMN "requestHash" VARCHAR(64);

CREATE UNIQUE INDEX "Analysis_ownerUserId_idempotencyKeyHash_key"
    ON "Analysis" ("ownerUserId", "idempotencyKeyHash");

COMMIT;
