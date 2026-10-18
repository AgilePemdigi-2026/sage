import type { PrismaClient } from "../generated/client.ts";

function requireOwnerAndId(userId: string, id: string): void {
  if (typeof userId !== "string" || userId.trim().length === 0) throw new Error("Pemilik data tidak valid.");
  if (typeof id !== "string" || id.trim().length === 0) throw new Error("ID data tidak valid.");
}

// Every lookup includes the trusted owner resolved by the server-side session check.
// Do not replace these predicates with an ID-only lookup followed by an in-memory check.
export function findAnalysisForUser(db: PrismaClient, userId: string, analysisId: string) {
  requireOwnerAndId(userId, analysisId);
  return db.analysis.findFirst({ where: { id: analysisId, ownerUserId: userId } });
}

export function findJobForUser(db: PrismaClient, userId: string, jobId: string) {
  requireOwnerAndId(userId, jobId);
  return db.job.findFirst({ where: { id: jobId, ownerUserId: userId } });
}

export function findSourceFileForUser(db: PrismaClient, userId: string, sourceFileId: string) {
  requireOwnerAndId(userId, sourceFileId);
  return db.sourceFile.findFirst({ where: { id: sourceFileId, ownerUserId: userId } });
}

export function findGraphBundleForUser(db: PrismaClient, userId: string, graphBundleId: string) {
  requireOwnerAndId(userId, graphBundleId);
  return db.graphBundle.findFirst({ where: { id: graphBundleId, ownerUserId: userId } });
}

export function findArchitectureDocumentForUser(db: PrismaClient, userId: string, documentId: string) {
  requireOwnerAndId(userId, documentId);
  return db.architectureDocument.findFirst({ where: { id: documentId, ownerUserId: userId } });
}

export function findExportForUser(db: PrismaClient, userId: string, exportId: string) {
  requireOwnerAndId(userId, exportId);
  return db.export.findFirst({ where: { id: exportId, ownerUserId: userId } });
}

export function findStorageObjectForUser(db: PrismaClient, userId: string, storageObjectId: string) {
  requireOwnerAndId(userId, storageObjectId);
  return db.storageObject.findFirst({ where: { id: storageObjectId, ownerUserId: userId } });
}

export function findGitHubConnectionForUser(db: PrismaClient, userId: string, connectionId: string) {
  requireOwnerAndId(userId, connectionId);
  return db.gitHubConnection.findFirst({
    where: { id: connectionId, userId },
    select: { id: true, userId: true, githubUserId: true, githubLogin: true, tokenExpiresAt: true, revokedAt: true, status: true },
  });
}

export function findGitHubInstallationForUser(db: PrismaClient, userId: string, installationRecordId: string) {
  requireOwnerAndId(userId, installationRecordId);
  return db.gitHubInstallation.findFirst({ where: { id: installationRecordId, ownerUserId: userId } });
}
