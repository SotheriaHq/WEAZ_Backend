-- CreateEnum
CREATE TYPE "BrandVerificationStatus" AS ENUM ('NOT_SUBMITTED', 'PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "ReactivationRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AdminAuditAction" ADD VALUE 'ADMIN_USER_DATA_EXPORT';
ALTER TYPE "AdminAuditAction" ADD VALUE 'ADMIN_USER_DATA_WIPE';

-- AlterEnum
ALTER TYPE "FileType" ADD VALUE 'BRAND_VERIFICATION';

-- AlterTable
ALTER TABLE "Brand" ADD COLUMN     "verificationAddress" TEXT,
ADD COLUMN     "verificationCacKey" TEXT,
ADD COLUMN     "verificationClientEstimate" TEXT,
ADD COLUMN     "verificationNinKey" TEXT,
ADD COLUMN     "verificationPhoto1Key" TEXT,
ADD COLUMN     "verificationPhoto2Key" TEXT,
ADD COLUMN     "verificationRejectionReason" TEXT,
ADD COLUMN     "verificationReviewedAt" TIMESTAMP(3),
ADD COLUMN     "verificationReviewedById" UUID,
ADD COLUMN     "verificationStatus" "BrandVerificationStatus" NOT NULL DEFAULT 'NOT_SUBMITTED',
ADD COLUMN     "verificationSubmittedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "authVersion" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "BreakGlassRecoveryToken" (
    "_id" UUID NOT NULL,
    "jtiHash" TEXT NOT NULL,
    "ipAddress" TEXT,
    "userAgentHash" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BreakGlassRecoveryToken_pkey" PRIMARY KEY ("_id")
);

-- CreateTable
CREATE TABLE "AccountReactivationRequest" (
    "_id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "emailSnapshot" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "ReactivationRequestStatus" NOT NULL DEFAULT 'PENDING',
    "adminNote" TEXT,
    "reviewedById" UUID,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccountReactivationRequest_pkey" PRIMARY KEY ("_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BreakGlassRecoveryToken_jtiHash_key" ON "BreakGlassRecoveryToken"("jtiHash");

-- CreateIndex
CREATE INDEX "BreakGlassRecoveryToken_expiresAt_idx" ON "BreakGlassRecoveryToken"("expiresAt");

-- CreateIndex
CREATE INDEX "BreakGlassRecoveryToken_usedAt_idx" ON "BreakGlassRecoveryToken"("usedAt");

-- CreateIndex
CREATE INDEX "AccountReactivationRequest_status_createdAt_idx" ON "AccountReactivationRequest"("status", "createdAt");

-- CreateIndex
CREATE INDEX "AccountReactivationRequest_userId_createdAt_idx" ON "AccountReactivationRequest"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "AccountReactivationRequest_userId_status_createdAt_idx" ON "AccountReactivationRequest"("userId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "AdminAuditLog_action_ipAddress_userAgent_createdAt_idx" ON "AdminAuditLog"("action", "ipAddress", "userAgent", "createdAt");

-- CreateIndex
CREATE INDEX "PasswordResetToken_tokenHash_idx" ON "PasswordResetToken"("tokenHash");

-- AddForeignKey
ALTER TABLE "AccountReactivationRequest" ADD CONSTRAINT "AccountReactivationRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountReactivationRequest" ADD CONSTRAINT "AccountReactivationRequest_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("_id") ON DELETE SET NULL ON UPDATE CASCADE;
