CREATE TABLE "SemanticModel" (
    "id" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "analysisId" TEXT NOT NULL,
    "sourceCkgHash" VARCHAR(64) NOT NULL,
    "modelHash" VARCHAR(64) NOT NULL,
    "schemaVersion" TEXT NOT NULL,
    "extractorVersion" TEXT NOT NULL,
    "canonicalContent" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SemanticModel_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "PresentationRevision" (
    "id" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "analysisId" TEXT NOT NULL,
    "semanticModelId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "overlay" JSONB NOT NULL,
    "contentHash" VARCHAR(64) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PresentationRevision_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PresentationRevision_revision_positive" CHECK ("revision" > 0)
);
CREATE UNIQUE INDEX "SemanticModel_analysisId_ownerUserId_key" ON "SemanticModel"("analysisId", "ownerUserId");
CREATE UNIQUE INDEX "SemanticModel_id_analysisId_ownerUserId_key" ON "SemanticModel"("id", "analysisId", "ownerUserId");
CREATE INDEX "SemanticModel_ownerUserId_createdAt_idx" ON "SemanticModel"("ownerUserId", "createdAt");
CREATE UNIQUE INDEX "PresentationRevision_analysisId_ownerUserId_revision_key" ON "PresentationRevision"("analysisId", "ownerUserId", "revision");
CREATE UNIQUE INDEX "PresentationRevision_id_analysisId_ownerUserId_semanticModelId_revision_key" ON "PresentationRevision"("id", "analysisId", "ownerUserId", "semanticModelId", "revision");
CREATE INDEX "PresentationRevision_semanticModelId_revision_idx" ON "PresentationRevision"("semanticModelId", "revision");
CREATE INDEX "PresentationRevision_ownerUserId_createdAt_idx" ON "PresentationRevision"("ownerUserId", "createdAt");
ALTER TABLE "SemanticModel" ADD CONSTRAINT "SemanticModel_analysisId_ownerUserId_fkey" FOREIGN KEY ("analysisId", "ownerUserId") REFERENCES "Analysis"("id", "ownerUserId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PresentationRevision" ADD CONSTRAINT "PresentationRevision_analysisId_ownerUserId_fkey" FOREIGN KEY ("analysisId", "ownerUserId") REFERENCES "Analysis"("id", "ownerUserId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PresentationRevision" ADD CONSTRAINT "PresentationRevision_semanticModelId_analysisId_ownerUserId_fkey" FOREIGN KEY ("semanticModelId", "analysisId", "ownerUserId") REFERENCES "SemanticModel"("id", "analysisId", "ownerUserId") ON DELETE CASCADE ON UPDATE CASCADE;
