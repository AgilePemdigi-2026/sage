CREATE TABLE "AddBaseline" (
    "id" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "analysisId" TEXT NOT NULL,
    "sourceCkgHash" VARCHAR(64) NOT NULL,
    "modelHash" VARCHAR(64) NOT NULL,
    "schemaVersion" TEXT NOT NULL,
    "canonicalContent" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AddBaseline_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "AddRevision" (
    "id" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "analysisId" TEXT NOT NULL,
    "addBaselineId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "overlay" JSONB NOT NULL,
    "contentHash" VARCHAR(64) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AddRevision_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AddBaseline_analysisId_ownerUserId_key" ON "AddBaseline"("analysisId", "ownerUserId");
CREATE UNIQUE INDEX "AddBaseline_id_analysisId_ownerUserId_key" ON "AddBaseline"("id", "analysisId", "ownerUserId");
CREATE INDEX "AddBaseline_ownerUserId_createdAt_idx" ON "AddBaseline"("ownerUserId", "createdAt");
CREATE UNIQUE INDEX "AddRevision_analysisId_ownerUserId_revision_key" ON "AddRevision"("analysisId", "ownerUserId", "revision");
CREATE INDEX "AddRevision_addBaselineId_revision_idx" ON "AddRevision"("addBaselineId", "revision");
CREATE INDEX "AddRevision_ownerUserId_createdAt_idx" ON "AddRevision"("ownerUserId", "createdAt");
ALTER TABLE "AddBaseline" ADD CONSTRAINT "AddBaseline_analysisId_ownerUserId_fkey" FOREIGN KEY ("analysisId", "ownerUserId") REFERENCES "Analysis"("id", "ownerUserId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AddRevision" ADD CONSTRAINT "AddRevision_analysisId_ownerUserId_fkey" FOREIGN KEY ("analysisId", "ownerUserId") REFERENCES "Analysis"("id", "ownerUserId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AddRevision" ADD CONSTRAINT "AddRevision_addBaselineId_analysisId_ownerUserId_fkey" FOREIGN KEY ("addBaselineId", "analysisId", "ownerUserId") REFERENCES "AddBaseline"("id", "analysisId", "ownerUserId") ON DELETE CASCADE ON UPDATE CASCADE;
