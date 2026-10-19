BEGIN;

CREATE TABLE "GitHubOAuthAttempt" (
    "id" TEXT NOT NULL,
    "stateHash" TEXT NOT NULL,
    "browserTokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "encryptedVerifier" TEXT NOT NULL,
    "verifierNonce" TEXT NOT NULL,
    "verifierAuthTag" TEXT NOT NULL,
    "encryptionKeyId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GitHubOAuthAttempt_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "GitHubOAuthAttempt_stateHash_key" ON "GitHubOAuthAttempt"("stateHash");
CREATE INDEX "GitHubOAuthAttempt_expiresAt_idx" ON "GitHubOAuthAttempt"("expiresAt");

COMMIT;
