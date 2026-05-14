-- CreateTable
CREATE TABLE "settlement_snapshot" (
    "id" UUID NOT NULL,
    "orderType" "SettlementOrderType" NOT NULL,
    "orderId" UUID,
    "customOrderId" UUID,
    "brandId" UUID NOT NULL,
    "grossAmount" DECIMAL(18,2) NOT NULL,
    "currency" TEXT NOT NULL,
    "commissionRuleId" UUID,
    "commissionSource" TEXT,
    "commissionRate" DECIMAL(5,2) NOT NULL,
    "commissionAmount" DECIMAL(18,2) NOT NULL,
    "brandNetAmount" DECIMAL(18,2) NOT NULL,
    "settlementPolicyId" UUID,
    "releaseMode" "SettlementReleaseMode" NOT NULL,
    "upfrontReleaseEnabled" BOOLEAN NOT NULL,
    "upfrontReleasePercent" DECIMAL(5,2) NOT NULL,
    "upfrontReleaseGrossAmount" DECIMAL(18,2) NOT NULL,
    "upfrontReleaseCommissionAmount" DECIMAL(18,2) NOT NULL,
    "upfrontReleaseNetBrandAmount" DECIMAL(18,2) NOT NULL,
    "finalReleaseGrossAmount" DECIMAL(18,2) NOT NULL,
    "finalReleaseCommissionAmount" DECIMAL(18,2) NOT NULL,
    "finalReleaseNetBrandAmount" DECIMAL(18,2) NOT NULL,
    "settlementDelayHours" INTEGER NOT NULL,
    "autoReleaseDays" INTEGER NOT NULL,
    "finalReleaseTrigger" "SettlementFinalReleaseTrigger" NOT NULL,
    "calculatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "settlement_snapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "settlement_snapshot_orderId_key"
ON "settlement_snapshot"("orderId")
WHERE "orderId" IS NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "settlement_snapshot_customOrderId_key"
ON "settlement_snapshot"("customOrderId")
WHERE "customOrderId" IS NOT NULL;

-- CreateIndex
CREATE INDEX "settlement_snapshot_brandId_orderType_createdAt_idx"
ON "settlement_snapshot"("brandId", "orderType", "createdAt");

-- CreateIndex
CREATE INDEX "settlement_snapshot_settlementPolicyId_idx"
ON "settlement_snapshot"("settlementPolicyId");

-- CreateIndex
CREATE INDEX "settlement_snapshot_commissionRuleId_idx"
ON "settlement_snapshot"("commissionRuleId");
