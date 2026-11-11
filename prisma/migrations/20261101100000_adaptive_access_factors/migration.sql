-- CreateEnum
CREATE TYPE "SecurityRiskState" AS ENUM ('NORMAL', 'CHALLENGE', 'REVOKED');

-- CreateEnum
CREATE TYPE "SecurityFactorKind" AS ENUM ('TOTP', 'PASSKEY');

-- CreateEnum
CREATE TYPE "SecurityActionSensitivity" AS ENUM ('SENSITIVE_READ', 'CRITICAL_CHANGE');

-- AlterTable
ALTER TABLE "RefreshToken" ADD COLUMN     "riskObservedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "riskReasons" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "riskScore" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "riskSequence" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "riskState" "SecurityRiskState" NOT NULL DEFAULT 'NORMAL',
ADD COLUMN     "strongAuthVersion" INTEGER,
ADD COLUMN     "strongAuthenticatedAt" TIMESTAMP(3),
ALTER COLUMN "sessionVersion" SET DEFAULT 0;

-- CreateTable
CREATE TABLE "SecurityFactor" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "kind" "SecurityFactorKind" NOT NULL,
    "label" TEXT NOT NULL,
    "createdBySessionId" UUID NOT NULL,
    "secretCiphertext" TEXT,
    "credentialId" TEXT,
    "publicKey" BYTEA,
    "counter" BIGINT NOT NULL DEFAULT 0,
    "transports" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "lastUsedStep" BIGINT NOT NULL DEFAULT -1,
    "verifiedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SecurityFactor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SecurityRecoveryCode" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "factorId" UUID NOT NULL,
    "codeHash" TEXT NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SecurityRecoveryCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SecurityStepUpChallenge" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "authVersion" INTEGER NOT NULL,
    "operationDigest" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "route" TEXT NOT NULL,
    "sensitivity" "SecurityActionSensitivity" NOT NULL,
    "nonce" TEXT NOT NULL,
    "proofHash" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "usedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SecurityStepUpChallenge_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SecurityFactor_credentialId_key" ON "SecurityFactor"("credentialId");

-- CreateIndex
CREATE INDEX "SecurityFactor_userId_kind_revokedAt_idx" ON "SecurityFactor"("userId", "kind", "revokedAt");

-- CreateIndex
CREATE INDEX "SecurityFactor_expiresAt_idx" ON "SecurityFactor"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "SecurityRecoveryCode_codeHash_key" ON "SecurityRecoveryCode"("codeHash");

-- CreateIndex
CREATE INDEX "SecurityRecoveryCode_userId_usedAt_idx" ON "SecurityRecoveryCode"("userId", "usedAt");

-- CreateIndex
CREATE INDEX "SecurityStepUpChallenge_userId_sessionId_operationDigest_ex_idx" ON "SecurityStepUpChallenge"("userId", "sessionId", "operationDigest", "expiresAt");

-- CreateIndex
CREATE INDEX "SecurityStepUpChallenge_expiresAt_idx" ON "SecurityStepUpChallenge"("expiresAt");

-- AddForeignKey
ALTER TABLE "SecurityFactor" ADD CONSTRAINT "SecurityFactor_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SecurityRecoveryCode" ADD CONSTRAINT "SecurityRecoveryCode_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SecurityRecoveryCode" ADD CONSTRAINT "SecurityRecoveryCode_factorId_fkey" FOREIGN KEY ("factorId") REFERENCES "SecurityFactor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SecurityStepUpChallenge" ADD CONSTRAINT "SecurityStepUpChallenge_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SecurityStepUpChallenge" ADD CONSTRAINT "SecurityStepUpChallenge_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "RefreshToken"("_id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SecurityStepUpChallenge" ADD COLUMN "usedByRequestId" UUID;
CREATE UNIQUE INDEX "SecurityFactor_one_live_totp_per_user" ON "SecurityFactor"("userId") WHERE "kind" = 'TOTP' AND "revokedAt" IS NULL;
