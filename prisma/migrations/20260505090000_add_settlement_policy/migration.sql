-- CreateEnum
CREATE TYPE "SettlementOrderType" AS ENUM ('STANDARD_ORDER', 'CUSTOM_ORDER');

-- CreateEnum
CREATE TYPE "SettlementPolicyScope" AS ENUM ('PLATFORM', 'BRAND');

-- CreateEnum
CREATE TYPE "SettlementReleaseMode" AS ENUM ('HOLD_UNTIL_DELIVERY', 'SPLIT_RELEASE');

-- CreateEnum
CREATE TYPE "SettlementFinalReleaseTrigger" AS ENUM ('BUYER_CONFIRMATION', 'BUYER_TIMEOUT', 'ADMIN_APPROVAL', 'DISPUTE_RESOLUTION');

-- CreateTable
CREATE TABLE "settlement_policy" (
    "id" UUID NOT NULL,
    "orderType" "SettlementOrderType" NOT NULL,
    "scope" "SettlementPolicyScope" NOT NULL DEFAULT 'PLATFORM',
    "brandId" UUID,
    "currency" TEXT,
    "releaseMode" "SettlementReleaseMode" NOT NULL DEFAULT 'HOLD_UNTIL_DELIVERY',
    "upfrontReleaseEnabled" BOOLEAN NOT NULL DEFAULT false,
    "upfrontReleasePercent" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "settlementDelayHours" INTEGER NOT NULL DEFAULT 48,
    "autoReleaseDays" INTEGER NOT NULL DEFAULT 7,
    "finalReleaseTrigger" "SettlementFinalReleaseTrigger" NOT NULL DEFAULT 'BUYER_CONFIRMATION',
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effectiveTo" TIMESTAMP(3),
    "createdById" UUID,
    "updatedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "settlement_policy_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "settlement_policy_orderType_scope_brandId_currency_isActive_effectiveFrom_idx" ON "settlement_policy"("orderType", "scope", "brandId", "currency", "isActive", "effectiveFrom");

-- CreateIndex
CREATE INDEX "settlement_policy_orderType_isDefault_isActive_idx" ON "settlement_policy"("orderType", "isDefault", "isActive");

-- CreateIndex
CREATE INDEX "settlement_policy_brandId_idx" ON "settlement_policy"("brandId");

-- CreateIndex
CREATE INDEX "settlement_policy_effectiveFrom_effectiveTo_idx" ON "settlement_policy"("effectiveFrom", "effectiveTo");

-- CreateIndex
CREATE UNIQUE INDEX "settlement_policy_active_default_combo_key" ON "settlement_policy"("orderType", "scope", COALESCE("brandId"::text, ''), COALESCE("currency", '')) WHERE "isDefault" = true AND "isActive" = true;