-- CreateEnum
CREATE TYPE "GitHubConnectionStatus" AS ENUM ('ACTIVE', 'EXPIRED', 'REVOKED');

-- CreateEnum
CREATE TYPE "GitHubInstallationStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'REMOVED');

-- CreateEnum
CREATE TYPE "RepositoryVisibility" AS ENUM ('PUBLIC', 'PRIVATE', 'INTERNAL', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "AnalysisStatus" AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'COMPLETED_WITH_LIMITATIONS', 'FAILED');

-- CreateEnum
CREATE TYPE "AnalysisStageStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "JobType" AS ENUM ('ANALYSIS', 'EXPORT', 'CLEANUP');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "ExportFormat" AS ENUM ('MARKDOWN', 'PDF');

-- CreateEnum
CREATE TYPE "ExportStatus" AS ENUM ('QUEUED', 'GENERATING', 'READY', 'FAILED');

-- CreateEnum
CREATE TYPE "StorageObjectType" AS ENUM ('SOURCE_ARCHIVE', 'SOURCE_FILE', 'GRAPH_BUNDLE', 'ARCHITECTURE_DOCUMENT', 'EXPORT', 'OTHER');

-- CreateEnum
CREATE TYPE "StorageObjectStatus" AS ENUM ('ACTIVE', 'DELETION_PENDING', 'DELETED');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "githubUserId" TEXT NOT NULL,
    "login" TEXT NOT NULL,
    "displayName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GitHubConnection" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "githubUserId" TEXT NOT NULL,
    "githubLogin" TEXT NOT NULL,
    "encryptedToken" TEXT NOT NULL,
    "tokenNonce" TEXT NOT NULL,
    "tokenAuthTag" TEXT NOT NULL,
    "encryptionKeyId" TEXT NOT NULL,
    "tokenExpiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "status" "GitHubConnectionStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GitHubConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GitHubInstallation" (
    "id" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "installationId" TEXT NOT NULL,
    "accountLogin" TEXT NOT NULL,
    "accountType" TEXT NOT NULL,
    "permissions" JSONB,
    "suspendedAt" TIMESTAMP(3),
    "status" "GitHubInstallationStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GitHubInstallation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Repository" (
    "id" TEXT NOT NULL,
    "githubRepositoryId" TEXT NOT NULL,
    "ownerLogin" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "visibility" "RepositoryVisibility" NOT NULL DEFAULT 'UNKNOWN',
    "defaultBranch" TEXT,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Repository_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Analysis" (
    "id" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "retryParentId" TEXT,
    "branchName" TEXT NOT NULL,
    "commitSha" TEXT NOT NULL,
    "configuration" JSONB NOT NULL,
    "configurationHash" TEXT NOT NULL,
    "analyzerVersion" TEXT NOT NULL,
    "schemaVersion" TEXT NOT NULL,
    "status" "AnalysisStatus" NOT NULL DEFAULT 'QUEUED',
    "errorCode" TEXT,
    "resultHash" TEXT,
    "queuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Analysis_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Job" (
    "id" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "analysisId" TEXT,
    "exportId" TEXT,
    "type" "JobType" NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'QUEUED',
    "enqueuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "leaseExpiresAt" TIMESTAMP(3),
    "heartbeatAt" TIMESTAMP(3),
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "errorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnalysisStage" (
    "id" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "analysisId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "key" TEXT NOT NULL,
    "status" "AnalysisStageStatus" NOT NULL DEFAULT 'PENDING',
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "errorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AnalysisStage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SourceFile" (
    "id" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "analysisId" TEXT NOT NULL,
    "storageObjectId" TEXT,
    "path" TEXT NOT NULL,
    "language" TEXT,
    "byteLength" BIGINT NOT NULL,
    "sha256" TEXT NOT NULL,
    "processingStatus" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SourceFile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnalysisLimitation" (
    "id" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "analysisId" TEXT NOT NULL,
    "path" TEXT,
    "stageKey" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "safeExplanation" TEXT NOT NULL,
    "affectedPartCount" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AnalysisLimitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GraphBundle" (
    "id" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "analysisId" TEXT NOT NULL,
    "schemaVersion" TEXT NOT NULL,
    "configurationHash" TEXT NOT NULL,
    "nodes" JSONB NOT NULL,
    "edges" JSONB NOT NULL,
    "nodeCount" INTEGER NOT NULL,
    "edgeCount" INTEGER NOT NULL,
    "contentHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GraphBundle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ArchitectureDocument" (
    "id" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "analysisId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "documentModelVersion" TEXT NOT NULL,
    "interfaceCatalog" JSONB NOT NULL,
    "softwareEngineeringDiagram" JSONB NOT NULL,
    "umlClassDiagram" JSONB NOT NULL,
    "contentHash" TEXT NOT NULL,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ArchitectureDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Export" (
    "id" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "analysisId" TEXT NOT NULL,
    "architectureDocumentId" TEXT NOT NULL,
    "storageObjectId" TEXT,
    "format" "ExportFormat" NOT NULL,
    "rendererVersion" TEXT NOT NULL,
    "status" "ExportStatus" NOT NULL DEFAULT 'QUEUED',
    "contentHash" TEXT,
    "errorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "readyAt" TIMESTAMP(3),

    CONSTRAINT "Export_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StorageObject" (
    "id" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "analysisId" TEXT NOT NULL,
    "type" "StorageObjectType" NOT NULL,
    "storageKey" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "byteLength" BIGINT NOT NULL,
    "status" "StorageObjectStatus" NOT NULL DEFAULT 'ACTIVE',
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StorageObject_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkerSlot" (
    "slotKey" TEXT NOT NULL DEFAULT 'analysis',
    "jobId" TEXT,
    "ownerUserId" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "heartbeatAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkerSlot_pkey" PRIMARY KEY ("slotKey")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_githubUserId_key" ON "User"("githubUserId");

-- CreateIndex
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");

-- CreateIndex
CREATE INDEX "Session_userId_expiresAt_idx" ON "Session"("userId", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "Session_id_userId_key" ON "Session"("id", "userId");

-- CreateIndex
CREATE INDEX "GitHubConnection_userId_status_idx" ON "GitHubConnection"("userId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "GitHubConnection_userId_githubUserId_key" ON "GitHubConnection"("userId", "githubUserId");

-- CreateIndex
CREATE UNIQUE INDEX "GitHubConnection_id_userId_key" ON "GitHubConnection"("id", "userId");

-- CreateIndex
CREATE INDEX "GitHubInstallation_ownerUserId_status_idx" ON "GitHubInstallation"("ownerUserId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "GitHubInstallation_ownerUserId_installationId_key" ON "GitHubInstallation"("ownerUserId", "installationId");

-- CreateIndex
CREATE UNIQUE INDEX "GitHubInstallation_id_ownerUserId_key" ON "GitHubInstallation"("id", "ownerUserId");

-- CreateIndex
CREATE UNIQUE INDEX "Repository_githubRepositoryId_key" ON "Repository"("githubRepositoryId");

-- CreateIndex
CREATE UNIQUE INDEX "Repository_fullName_key" ON "Repository"("fullName");

-- CreateIndex
CREATE INDEX "Repository_ownerLogin_name_idx" ON "Repository"("ownerLogin", "name");

-- CreateIndex
CREATE INDEX "Analysis_ownerUserId_createdAt_idx" ON "Analysis"("ownerUserId", "createdAt");

-- CreateIndex
CREATE INDEX "Analysis_repositoryId_commitSha_idx" ON "Analysis"("repositoryId", "commitSha");

-- CreateIndex
CREATE INDEX "Analysis_retryParentId_ownerUserId_idx" ON "Analysis"("retryParentId", "ownerUserId");

-- CreateIndex
CREATE UNIQUE INDEX "Analysis_id_ownerUserId_key" ON "Analysis"("id", "ownerUserId");

-- CreateIndex
CREATE INDEX "Job_ownerUserId_status_enqueuedAt_idx" ON "Job"("ownerUserId", "status", "enqueuedAt");

-- CreateIndex
CREATE INDEX "Job_analysisId_ownerUserId_idx" ON "Job"("analysisId", "ownerUserId");

-- CreateIndex
CREATE INDEX "Job_exportId_ownerUserId_idx" ON "Job"("exportId", "ownerUserId");

-- CreateIndex
CREATE UNIQUE INDEX "Job_id_ownerUserId_key" ON "Job"("id", "ownerUserId");

-- CreateIndex
CREATE INDEX "AnalysisStage_ownerUserId_status_idx" ON "AnalysisStage"("ownerUserId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "AnalysisStage_analysisId_sequence_key" ON "AnalysisStage"("analysisId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "AnalysisStage_analysisId_key_key" ON "AnalysisStage"("analysisId", "key");

-- CreateIndex
CREATE INDEX "SourceFile_ownerUserId_analysisId_idx" ON "SourceFile"("ownerUserId", "analysisId");

-- CreateIndex
CREATE UNIQUE INDEX "SourceFile_analysisId_path_key" ON "SourceFile"("analysisId", "path");

-- CreateIndex
CREATE INDEX "AnalysisLimitation_ownerUserId_analysisId_idx" ON "AnalysisLimitation"("ownerUserId", "analysisId");

-- CreateIndex
CREATE INDEX "AnalysisLimitation_analysisId_stageKey_idx" ON "AnalysisLimitation"("analysisId", "stageKey");

-- CreateIndex
CREATE INDEX "GraphBundle_ownerUserId_createdAt_idx" ON "GraphBundle"("ownerUserId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "GraphBundle_analysisId_ownerUserId_key" ON "GraphBundle"("analysisId", "ownerUserId");

-- CreateIndex
CREATE INDEX "ArchitectureDocument_ownerUserId_generatedAt_idx" ON "ArchitectureDocument"("ownerUserId", "generatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ArchitectureDocument_analysisId_ownerUserId_key" ON "ArchitectureDocument"("analysisId", "ownerUserId");

-- CreateIndex
CREATE UNIQUE INDEX "ArchitectureDocument_id_analysisId_ownerUserId_key" ON "ArchitectureDocument"("id", "analysisId", "ownerUserId");

-- CreateIndex
CREATE INDEX "Export_ownerUserId_status_createdAt_idx" ON "Export"("ownerUserId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "Export_analysisId_ownerUserId_idx" ON "Export"("analysisId", "ownerUserId");

-- CreateIndex
CREATE UNIQUE INDEX "Export_id_ownerUserId_key" ON "Export"("id", "ownerUserId");

-- CreateIndex
CREATE UNIQUE INDEX "StorageObject_storageKey_key" ON "StorageObject"("storageKey");

-- CreateIndex
CREATE INDEX "StorageObject_ownerUserId_status_createdAt_idx" ON "StorageObject"("ownerUserId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "StorageObject_analysisId_ownerUserId_idx" ON "StorageObject"("analysisId", "ownerUserId");

-- CreateIndex
CREATE UNIQUE INDEX "StorageObject_id_ownerUserId_key" ON "StorageObject"("id", "ownerUserId");

-- CreateIndex
CREATE UNIQUE INDEX "StorageObject_id_analysisId_ownerUserId_key" ON "StorageObject"("id", "analysisId", "ownerUserId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkerSlot_jobId_key" ON "WorkerSlot"("jobId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkerSlot_jobId_ownerUserId_key" ON "WorkerSlot"("jobId", "ownerUserId");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GitHubConnection" ADD CONSTRAINT "GitHubConnection_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GitHubInstallation" ADD CONSTRAINT "GitHubInstallation_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Analysis" ADD CONSTRAINT "Analysis_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Analysis" ADD CONSTRAINT "Analysis_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Analysis" ADD CONSTRAINT "Analysis_retryParentId_ownerUserId_fkey" FOREIGN KEY ("retryParentId", "ownerUserId") REFERENCES "Analysis"("id", "ownerUserId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_analysisId_ownerUserId_fkey" FOREIGN KEY ("analysisId", "ownerUserId") REFERENCES "Analysis"("id", "ownerUserId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_exportId_ownerUserId_fkey" FOREIGN KEY ("exportId", "ownerUserId") REFERENCES "Export"("id", "ownerUserId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnalysisStage" ADD CONSTRAINT "AnalysisStage_analysisId_ownerUserId_fkey" FOREIGN KEY ("analysisId", "ownerUserId") REFERENCES "Analysis"("id", "ownerUserId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SourceFile" ADD CONSTRAINT "SourceFile_analysisId_ownerUserId_fkey" FOREIGN KEY ("analysisId", "ownerUserId") REFERENCES "Analysis"("id", "ownerUserId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SourceFile" ADD CONSTRAINT "SourceFile_storageObjectId_analysisId_ownerUserId_fkey" FOREIGN KEY ("storageObjectId", "analysisId", "ownerUserId") REFERENCES "StorageObject"("id", "analysisId", "ownerUserId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnalysisLimitation" ADD CONSTRAINT "AnalysisLimitation_analysisId_ownerUserId_fkey" FOREIGN KEY ("analysisId", "ownerUserId") REFERENCES "Analysis"("id", "ownerUserId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GraphBundle" ADD CONSTRAINT "GraphBundle_analysisId_ownerUserId_fkey" FOREIGN KEY ("analysisId", "ownerUserId") REFERENCES "Analysis"("id", "ownerUserId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArchitectureDocument" ADD CONSTRAINT "ArchitectureDocument_analysisId_ownerUserId_fkey" FOREIGN KEY ("analysisId", "ownerUserId") REFERENCES "Analysis"("id", "ownerUserId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Export" ADD CONSTRAINT "Export_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Export" ADD CONSTRAINT "Export_analysisId_ownerUserId_fkey" FOREIGN KEY ("analysisId", "ownerUserId") REFERENCES "Analysis"("id", "ownerUserId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Export" ADD CONSTRAINT "Export_architectureDocumentId_analysisId_ownerUserId_fkey" FOREIGN KEY ("architectureDocumentId", "analysisId", "ownerUserId") REFERENCES "ArchitectureDocument"("id", "analysisId", "ownerUserId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Export" ADD CONSTRAINT "Export_storageObjectId_analysisId_ownerUserId_fkey" FOREIGN KEY ("storageObjectId", "analysisId", "ownerUserId") REFERENCES "StorageObject"("id", "analysisId", "ownerUserId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StorageObject" ADD CONSTRAINT "StorageObject_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StorageObject" ADD CONSTRAINT "StorageObject_analysisId_ownerUserId_fkey" FOREIGN KEY ("analysisId", "ownerUserId") REFERENCES "Analysis"("id", "ownerUserId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkerSlot" ADD CONSTRAINT "WorkerSlot_jobId_ownerUserId_fkey" FOREIGN KEY ("jobId", "ownerUserId") REFERENCES "Job"("id", "ownerUserId") ON DELETE SET NULL ON UPDATE CASCADE;
