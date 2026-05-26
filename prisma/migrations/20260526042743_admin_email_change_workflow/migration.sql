-- CreateEnum
CREATE TYPE "AdminEmailChangeStatus" AS ENUM ('PENDING_VERIFICATION', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'CANCELLED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationType" ADD VALUE 'ADMIN_EMAIL_CHANGE_REQUESTED';
ALTER TYPE "NotificationType" ADD VALUE 'ADMIN_EMAIL_CHANGE_APPROVED';
ALTER TYPE "NotificationType" ADD VALUE 'ADMIN_EMAIL_CHANGE_REJECTED';

-- CreateTable
CREATE TABLE "admin_email_change_requests" (
    "_id" UUID NOT NULL,
    "adminId" UUID NOT NULL,
    "currentEmail" TEXT NOT NULL,
    "newEmail" TEXT NOT NULL,
    "otpHash" TEXT,
    "otpExpiresAt" TIMESTAMP(3),
    "otpVerifiedAt" TIMESTAMP(3),
    "status" "AdminEmailChangeStatus" NOT NULL DEFAULT 'PENDING_VERIFICATION',
    "rejectionReason" TEXT,
    "reviewedById" UUID,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "admin_email_change_requests_pkey" PRIMARY KEY ("_id")
);

-- CreateIndex
CREATE INDEX "admin_email_change_requests_adminId_status_idx" ON "admin_email_change_requests"("adminId", "status");

-- CreateIndex
CREATE INDEX "admin_email_change_requests_status_createdAt_idx" ON "admin_email_change_requests"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "admin_email_change_requests" ADD CONSTRAINT "admin_email_change_requests_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "User"("_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_email_change_requests" ADD CONSTRAINT "admin_email_change_requests_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("_id") ON DELETE SET NULL ON UPDATE CASCADE;
