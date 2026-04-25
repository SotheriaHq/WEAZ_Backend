-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AdminAuditAction" ADD VALUE 'ADMIN_PAYOUT_CLAIM';
ALTER TYPE "AdminAuditAction" ADD VALUE 'ADMIN_PAYOUT_RELEASE';
ALTER TYPE "AdminAuditAction" ADD VALUE 'ADMIN_PAYOUT_ASSIGN';
ALTER TYPE "AdminAuditAction" ADD VALUE 'ADMIN_DISPUTE_CLAIM';
ALTER TYPE "AdminAuditAction" ADD VALUE 'ADMIN_DISPUTE_RELEASE';
ALTER TYPE "AdminAuditAction" ADD VALUE 'ADMIN_DISPUTE_ASSIGN';

-- AlterTable
ALTER TABLE "CommissionRule" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "Dispute" ADD COLUMN     "assignedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "ExchangeRateSnapshot" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "FinancialDocument" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "Payout" ADD COLUMN     "approvedAt" TIMESTAMP(3),
ADD COLUMN     "approvedById" UUID,
ADD COLUMN     "assignedAdminId" UUID,
ADD COLUMN     "assignedAt" TIMESTAMP(3),
ADD COLUMN     "claimedAt" TIMESTAMP(3),
ADD COLUMN     "failureReason" TEXT,
ADD COLUMN     "gatewayReference" TEXT,
ADD COLUMN     "paidAt" TIMESTAMP(3),
ADD COLUMN     "processedAt" TIMESTAMP(3),
ADD COLUMN     "releasedAt" TIMESTAMP(3),
ADD COLUMN     "statusReason" TEXT;

-- AlterTable
ALTER TABLE "ReconciliationItem" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "ReconciliationRun" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- CreateTable
CREATE TABLE "MessageDeliveryReceipt" (
    "id" UUID NOT NULL,
    "messageId" UUID NOT NULL,
    "recipientId" UUID NOT NULL,
    "deliveredAt" TIMESTAMP(3),
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MessageDeliveryReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MessageDeliveryReceipt_recipientId_deliveredAt_idx" ON "MessageDeliveryReceipt"("recipientId", "deliveredAt");

-- CreateIndex
CREATE INDEX "MessageDeliveryReceipt_messageId_deliveredAt_idx" ON "MessageDeliveryReceipt"("messageId", "deliveredAt");

-- CreateIndex
CREATE UNIQUE INDEX "MessageDeliveryReceipt_messageId_recipientId_key" ON "MessageDeliveryReceipt"("messageId", "recipientId");

-- CreateIndex
CREATE INDEX "Payout_status_createdAt_idx" ON "Payout"("status", "createdAt");

-- CreateIndex
CREATE INDEX "Payout_assignedAdminId_status_idx" ON "Payout"("assignedAdminId", "status");

-- AddForeignKey
ALTER TABLE "MessageDeliveryReceipt" ADD CONSTRAINT "MessageDeliveryReceipt_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageDeliveryReceipt" ADD CONSTRAINT "MessageDeliveryReceipt_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "User"("_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payout" ADD CONSTRAINT "Payout_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "User"("_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payout" ADD CONSTRAINT "Payout_assignedAdminId_fkey" FOREIGN KEY ("assignedAdminId") REFERENCES "User"("_id") ON DELETE SET NULL ON UPDATE CASCADE;
