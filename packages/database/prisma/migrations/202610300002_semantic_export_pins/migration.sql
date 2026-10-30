ALTER TABLE "Export" ADD COLUMN "semanticModelHash" VARCHAR(64), ADD COLUMN "presentationRevision" INTEGER;
ALTER TABLE "Export" ADD CONSTRAINT "Export_semantic_pin_pair" CHECK (("semanticModelHash" IS NULL AND "presentationRevision" IS NULL) OR ("semanticModelHash" IS NOT NULL AND "presentationRevision" IS NOT NULL AND "semanticModelHash" ~ '^[a-f0-9]{64}$' AND "presentationRevision" >= 0));
