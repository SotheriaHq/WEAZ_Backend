-- CreateEnum
CREATE TYPE "EscrowHoldStatus" AS ENUM ('HELD', 'PARTIALLY_RELEASED', 'RELEASED', 'FROZEN', 'REFUNDED', 'FORFEITED');

-- CreateEnum
CREATE TYPE "EscrowReleaseCondition" AS ENUM (
  'SHIPMENT_CONFIRMED',
  'BUYER_DELIVERY_CONFIRMED',
  'BUYER_TIMEOUT',
  'MANUAL_ADMIN',
  'DISPUTE_RESOLVED',
  'REFUND_COMPLETED'
);

-- AlterTable
ALTER TABLE "Order"
ADD COLUMN "buyerConfirmedDeliveryAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "EscrowHold" (
  "id" UUID NOT NULL,
  "orderId" UUID,
  "brandId" UUID NOT NULL,
  "buyerId" UUID,
  "totalAmount" DECIMAL(10,2) NOT NULL,
  "commissionRate" DECIMAL(5,2) NOT NULL,
  "commissionAmount" DECIMAL(10,2) NOT NULL,
  "netBrandAmount" DECIMAL(10,2) NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'NGN',
  "status" "EscrowHoldStatus" NOT NULL DEFAULT 'HELD',
  "firstReleaseAmount" DECIMAL(10,2) NOT NULL,
  "firstReleaseCommissionAmount" DECIMAL(10,2) NOT NULL,
  "firstReleaseNetAmount" DECIMAL(10,2) NOT NULL,
  "secondReleaseAmount" DECIMAL(10,2) NOT NULL,
  "secondReleaseCommissionAmount" DECIMAL(10,2) NOT NULL,
  "secondReleaseNetAmount" DECIMAL(10,2) NOT NULL,
  "firstReleasedAt" TIMESTAMP(3),
  "secondReleaseEligibleAt" TIMESTAMP(3),
  "secondReleaseCondition" "EscrowReleaseCondition",
  "secondReleasedAt" TIMESTAMP(3),
  "frozenAt" TIMESTAMP(3),
  "frozenReason" TEXT,
  "frozenById" UUID,
  "refundedAt" TIMESTAMP(3),
  "refundReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "EscrowHold_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EscrowHold_orderId_key" ON "EscrowHold"("orderId");

-- CreateIndex
CREATE INDEX "EscrowHold_brandId_status_idx" ON "EscrowHold"("brandId", "status");

-- CreateIndex
CREATE INDEX "EscrowHold_status_secondReleaseEligibleAt_idx" ON "EscrowHold"("status", "secondReleaseEligibleAt");

-- CreateIndex
CREATE INDEX "EscrowHold_buyerId_idx" ON "EscrowHold"("buyerId");

-- AddForeignKey
ALTER TABLE "EscrowHold"
ADD CONSTRAINT "EscrowHold_orderId_fkey"
FOREIGN KEY ("orderId") REFERENCES "Order"("_id")
ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EscrowHold"
ADD CONSTRAINT "EscrowHold_brandId_fkey"
FOREIGN KEY ("brandId") REFERENCES "Brand"("_id")
ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EscrowHold"
ADD CONSTRAINT "EscrowHold_buyerId_fkey"
FOREIGN KEY ("buyerId") REFERENCES "User"("_id")
ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EscrowHold"
ADD CONSTRAINT "EscrowHold_frozenById_fkey"
FOREIGN KEY ("frozenById") REFERENCES "User"("_id")
ON DELETE SET NULL ON UPDATE CASCADE;
