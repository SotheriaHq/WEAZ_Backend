-- CreateEnum
CREATE TYPE "CustomOrderSourceType" AS ENUM ('PRODUCT', 'DESIGN');

-- CreateEnum
CREATE TYPE "CustomOrderStatus" AS ENUM ('DRAFT', 'PENDING_PAYMENT', 'PENDING_BRAND_ACCEPTANCE', 'ACCEPTED', 'IN_PRODUCTION', 'READY_FOR_DISPATCH', 'IN_TRANSIT', 'DELIVERED_PENDING_BUYER_CONFIRMATION', 'COMPLETED', 'REJECTED_BY_BRAND', 'CANCELLED_BY_BUYER_PRE_ACCEPTANCE', 'DELIVERY_ISSUE_REPORTED', 'REFUND_IN_PROGRESS', 'DISPUTED', 'CLOSED');

-- CreateEnum
CREATE TYPE "CustomOrderProgressStage" AS ENUM ('ORDER_PLACED', 'ORDER_RECEIVED', 'FABRIC_AND_PIECE_PURCHASE_GATHERING', 'DESIGN_MODE', 'FINAL_TOUCHES_AND_PACKAGING', 'READY_FOR_DELIVERY');

-- CreateEnum
CREATE TYPE "CustomFabricRuleBasisSource" AS ENUM ('SYSTEM', 'BRAND_FREEFORM');

-- CreateEnum
CREATE TYPE "CustomFabricRuleBasisStatus" AS ENUM ('BRAND_ONLY', 'APPROVED_GLOBAL', 'REJECTED');

-- CreateEnum
CREATE TYPE "FabricSourcingMode" AS ENUM ('BRAND_SOURCED', 'BUYER_SUPPLIED', 'EITHER');

-- CreateEnum
CREATE TYPE "CustomOrderExtensionTargetType" AS ENUM ('PRODUCTION', 'DELIVERY', 'BOTH');

-- CreateEnum
CREATE TYPE "CustomOrderExtensionResponseStatus" AS ENUM ('OPEN', 'ACCEPTED', 'COUNTERED', 'REJECTED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "CustomOrderActorType" AS ENUM ('BUYER', 'BRAND', 'ADMIN', 'SYSTEM');

-- CreateEnum
CREATE TYPE "CustomOrderTimelineEventType" AS ENUM ('OFFER_VERSION_LOCKED', 'PRICE_PREVIEW_CREATED', 'ORDER_CREATED', 'PAYMENT_INITIALIZED', 'PAYMENT_CONFIRMED', 'BRAND_ACCEPTED', 'BRAND_REJECTED', 'PROGRESS_STAGE_CHANGED', 'EXTENSION_REQUESTED', 'EXTENSION_RESOLVED', 'DELIVERED', 'BUYER_CONFIRMED_DELIVERY', 'DELIVERY_ISSUE_REPORTED', 'REFUND_INITIATED', 'DISPUTE_CREATED', 'ADMIN_ESCALATED');

-- CreateEnum
CREATE TYPE "CustomOrderIssueType" AS ENUM ('WRONG_ITEM', 'MATERIAL_DEFECT', 'MEASUREMENT_NON_COMPLIANCE', 'UNFINISHED_WORK', 'NON_DELIVERY', 'UNREASONABLE_DELAY', 'OTHER');

-- CreateEnum
CREATE TYPE "CustomOrderDisputeStatus" AS ENUM ('OPEN', 'BRAND_RESPONDED', 'ADMIN_REVIEW', 'RESOLVED', 'CLOSED');

-- CreateEnum
CREATE TYPE "CustomOrderDisputeResolution" AS ENUM ('FULL_REFUND', 'PARTIAL_REFUND', 'REMAKE', 'NO_ACTION', 'ESCALATED');

-- CreateEnum
CREATE TYPE "CustomOrderLedgerAllocationType" AS ENUM ('BRAND_ACCEPTANCE_PORTION', 'FINAL_COMPLETION_PORTION');

-- CreateEnum
CREATE TYPE "CustomOrderLedgerAllocationStatus" AS ENUM ('HELD', 'PAYOUT_ELIGIBLE', 'PAID_OUT', 'REVERSED', 'FORFEITED');

-- CreateEnum
CREATE TYPE "PaymentSubjectType" AS ENUM ('STANDARD_ORDER', 'CUSTOM_ORDER');

-- AlterEnum
ALTER TYPE "SizingMode" ADD VALUE 'RTW_PLUS_FITTINGS';

-- AlterTable
ALTER TABLE "Collection" ADD COLUMN     "customOrderEnabled" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "PaymentAttempt" ADD COLUMN     "customOrderId" UUID,
ADD COLUMN     "idempotencyKey" TEXT,
ADD COLUMN     "subjectType" "PaymentSubjectType" NOT NULL DEFAULT 'STANDARD_ORDER';

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "customOrderEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "standardCheckoutEnabled" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "CustomOrderOffer" (
    "id" UUID NOT NULL,
    "brandId" UUID NOT NULL,
    "sourceType" "CustomOrderSourceType" NOT NULL,
    "sourceId" UUID NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "title" TEXT NOT NULL,
    "buyerInstructionText" TEXT,
    "requiredMeasurementKeys" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "requiredFreeformPointIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "fabricRuleBasisId" UUID NOT NULL,
    "baseProductionCharge" DECIMAL(10,2) NOT NULL,
    "fabricCostPerYard" DECIMAL(10,2) NOT NULL,
    "rushEnabled" BOOLEAN NOT NULL DEFAULT false,
    "rushFee" DECIMAL(10,2),
    "rushProductionLeadDays" INTEGER,
    "productionLeadDays" INTEGER NOT NULL,
    "deliveryMinDays" INTEGER NOT NULL,
    "deliveryMaxDays" INTEGER NOT NULL,
    "deliveryScope" TEXT NOT NULL,
    "revisionPolicy" TEXT NOT NULL,
    "returnPolicy" TEXT NOT NULL,
    "defectPolicy" TEXT NOT NULL,
    "fabricSourcingMode" "FabricSourcingMode" NOT NULL,
    "notes" TEXT,
    "currentVersion" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomOrderOffer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomOrderOfferVersion" (
    "id" UUID NOT NULL,
    "offerId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "snapshotJson" JSONB NOT NULL,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomOrderOfferVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomFabricRuleBasis" (
    "id" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "measurementKeys" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "source" "CustomFabricRuleBasisSource" NOT NULL DEFAULT 'BRAND_FREEFORM',
    "status" "CustomFabricRuleBasisStatus" NOT NULL DEFAULT 'BRAND_ONLY',
    "brandId" UUID,
    "moderationNotes" TEXT,
    "reviewedById" UUID,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomFabricRuleBasis_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomFabricRule" (
    "id" UUID NOT NULL,
    "offerId" UUID NOT NULL,
    "priority" INTEGER NOT NULL,
    "conditionsJson" JSONB NOT NULL,
    "outputYards" DECIMAL(10,2) NOT NULL,
    "isFallback" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomFabricRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomOrder" (
    "id" UUID NOT NULL,
    "brandId" UUID NOT NULL,
    "buyerId" UUID NOT NULL,
    "sourceType" "CustomOrderSourceType" NOT NULL,
    "sourceId" UUID NOT NULL,
    "sourceTitleSnapshot" TEXT NOT NULL,
    "sourceSlugSnapshot" TEXT,
    "sourcePrimaryMediaUrlSnapshot" TEXT,
    "sourceBrandNameSnapshot" TEXT,
    "offerId" UUID NOT NULL,
    "offerVersionId" UUID NOT NULL,
    "status" "CustomOrderStatus" NOT NULL DEFAULT 'DRAFT',
    "paymentStatus" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "paymentMethod" "PaymentMethod" NOT NULL DEFAULT 'PENDING_SELECTION',
    "paymentReference" TEXT,
    "idempotencyKey" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'NGN',
    "checkoutIntentId" UUID,
    "baseProductionChargeSnapshot" DECIMAL(10,2) NOT NULL,
    "fabricCostPerYardSnapshot" DECIMAL(10,2) NOT NULL,
    "computedYards" DECIMAL(10,2) NOT NULL,
    "matchedFabricRuleId" UUID,
    "internalPriceBreakdownJson" JSONB NOT NULL,
    "buyerPriceSummaryJson" JSONB NOT NULL,
    "measurementSnapshotJson" JSONB NOT NULL,
    "measurementConfirmedAt" TIMESTAMP(3) NOT NULL,
    "rushSelected" BOOLEAN NOT NULL DEFAULT false,
    "rushFeeSnapshot" DECIMAL(10,2),
    "productionLeadDaysSnapshot" INTEGER NOT NULL,
    "deliveryMinDaysSnapshot" INTEGER NOT NULL,
    "deliveryMaxDaysSnapshot" INTEGER NOT NULL,
    "shippingAddressJson" JSONB,
    "contactInfoJson" JSONB,
    "promisedProductionAt" TIMESTAMP(3),
    "promisedDispatchAt" TIMESTAMP(3),
    "promisedDeliveryAt" TIMESTAMP(3),
    "currentProgressStage" "CustomOrderProgressStage" NOT NULL DEFAULT 'ORDER_PLACED',
    "currentProgressStageEnteredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastBrandProgressUpdateAt" TIMESTAMP(3),
    "buyerAcceptanceWindowEndsAt" TIMESTAMP(3),
    "acceptedAt" TIMESTAMP(3),
    "rejectedAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "buyerAcceptedAt" TIMESTAMP(3),
    "issueReportedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "measurementRetentionUntil" TIMESTAMP(3),
    "anonymizedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomOrderCheckoutIntent" (
    "id" UUID NOT NULL,
    "buyerId" UUID NOT NULL,
    "offerId" UUID NOT NULL,
    "offerVersionId" UUID NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'NGN',
    "previewHash" TEXT NOT NULL,
    "requestSnapshotJson" JSONB NOT NULL,
    "buyerPriceSummaryJson" JSONB NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomOrderCheckoutIntent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomOrderProgressEvent" (
    "id" UUID NOT NULL,
    "customOrderId" UUID NOT NULL,
    "stage" "CustomOrderProgressStage" NOT NULL,
    "note" TEXT,
    "changedById" UUID NOT NULL,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "buyerNotifiedAt" TIMESTAMP(3),
    "staleThresholdAt" TIMESTAMP(3),
    "staleBuyerWarnedAt" TIMESTAMP(3),
    "adminEscalatedAt" TIMESTAMP(3),

    CONSTRAINT "CustomOrderProgressEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomOrderExtensionRequest" (
    "id" UUID NOT NULL,
    "customOrderId" UUID NOT NULL,
    "requestedByBrandId" UUID NOT NULL,
    "targetType" "CustomOrderExtensionTargetType" NOT NULL,
    "requestedExtraDays" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "buyerResponseStatus" "CustomOrderExtensionResponseStatus" NOT NULL DEFAULT 'OPEN',
    "buyerCounterDays" INTEGER,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomOrderExtensionRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomOrderTimelineEvent" (
    "id" UUID NOT NULL,
    "customOrderId" UUID NOT NULL,
    "actorType" "CustomOrderActorType" NOT NULL,
    "actorId" TEXT,
    "eventType" "CustomOrderTimelineEventType" NOT NULL,
    "payloadJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomOrderTimelineEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomOrderIssue" (
    "id" UUID NOT NULL,
    "customOrderId" UUID NOT NULL,
    "issueType" "CustomOrderIssueType" NOT NULL,
    "description" TEXT NOT NULL,
    "evidenceJson" JSONB,
    "openedById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomOrderIssue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomOrderDispute" (
    "id" UUID NOT NULL,
    "customOrderId" UUID NOT NULL,
    "openedById" UUID NOT NULL,
    "status" "CustomOrderDisputeStatus" NOT NULL DEFAULT 'OPEN',
    "reasonType" "CustomOrderIssueType" NOT NULL,
    "buyerStatement" TEXT,
    "brandResponse" TEXT,
    "adminNotes" TEXT,
    "resolution" "CustomOrderDisputeResolution",
    "assignedAdminId" UUID,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "brandRespondByAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomOrderDispute_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomOrderLedgerAllocation" (
    "id" UUID NOT NULL,
    "customOrderId" UUID NOT NULL,
    "allocationType" "CustomOrderLedgerAllocationType" NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'NGN',
    "status" "CustomOrderLedgerAllocationStatus" NOT NULL DEFAULT 'HELD',
    "eligibleAt" TIMESTAMP(3),
    "paidOutAt" TIMESTAMP(3),
    "reversedAt" TIMESTAMP(3),
    "reversalReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomOrderLedgerAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CustomOrderOffer_brandId_isActive_idx" ON "CustomOrderOffer"("brandId", "isActive");

-- CreateIndex
CREATE INDEX "CustomOrderOffer_sourceType_sourceId_idx" ON "CustomOrderOffer"("sourceType", "sourceId");

-- CreateIndex
CREATE UNIQUE INDEX "CustomOrderOffer_sourceType_sourceId_key" ON "CustomOrderOffer"("sourceType", "sourceId");

-- CreateIndex
CREATE INDEX "CustomOrderOfferVersion_offerId_createdAt_idx" ON "CustomOrderOfferVersion"("offerId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "CustomOrderOfferVersion_offerId_version_key" ON "CustomOrderOfferVersion"("offerId", "version");

-- CreateIndex
CREATE INDEX "CustomFabricRuleBasis_status_createdAt_idx" ON "CustomFabricRuleBasis"("status", "createdAt");

-- CreateIndex
CREATE INDEX "CustomFabricRuleBasis_brandId_status_idx" ON "CustomFabricRuleBasis"("brandId", "status");

-- CreateIndex
CREATE INDEX "CustomFabricRule_offerId_priority_idx" ON "CustomFabricRule"("offerId", "priority");

-- CreateIndex
CREATE INDEX "CustomOrder_brandId_status_createdAt_idx" ON "CustomOrder"("brandId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "CustomOrder_buyerId_status_createdAt_idx" ON "CustomOrder"("buyerId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "CustomOrder_paymentReference_idx" ON "CustomOrder"("paymentReference");

-- CreateIndex
CREATE INDEX "CustomOrder_checkoutIntentId_idx" ON "CustomOrder"("checkoutIntentId");

-- CreateIndex
CREATE INDEX "CustomOrder_sourceType_sourceId_idx" ON "CustomOrder"("sourceType", "sourceId");

-- CreateIndex
CREATE INDEX "CustomOrder_currentProgressStage_lastBrandProgressUpdateAt_idx" ON "CustomOrder"("currentProgressStage", "lastBrandProgressUpdateAt");

-- CreateIndex
CREATE UNIQUE INDEX "CustomOrder_buyerId_idempotencyKey_key" ON "CustomOrder"("buyerId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "CustomOrderCheckoutIntent_previewHash_key" ON "CustomOrderCheckoutIntent"("previewHash");

-- CreateIndex
CREATE INDEX "CustomOrderCheckoutIntent_buyerId_expiresAt_idx" ON "CustomOrderCheckoutIntent"("buyerId", "expiresAt");

-- CreateIndex
CREATE INDEX "CustomOrderCheckoutIntent_offerId_offerVersionId_idx" ON "CustomOrderCheckoutIntent"("offerId", "offerVersionId");

-- CreateIndex
CREATE INDEX "CustomOrderProgressEvent_customOrderId_changedAt_idx" ON "CustomOrderProgressEvent"("customOrderId", "changedAt");

-- CreateIndex
CREATE INDEX "CustomOrderProgressEvent_stage_staleThresholdAt_idx" ON "CustomOrderProgressEvent"("stage", "staleThresholdAt");

-- CreateIndex
CREATE INDEX "CustomOrderExtensionRequest_customOrderId_buyerResponseStat_idx" ON "CustomOrderExtensionRequest"("customOrderId", "buyerResponseStatus");

-- CreateIndex
CREATE INDEX "CustomOrderTimelineEvent_customOrderId_createdAt_idx" ON "CustomOrderTimelineEvent"("customOrderId", "createdAt");

-- CreateIndex
CREATE INDEX "CustomOrderTimelineEvent_eventType_createdAt_idx" ON "CustomOrderTimelineEvent"("eventType", "createdAt");

-- CreateIndex
CREATE INDEX "CustomOrderIssue_customOrderId_createdAt_idx" ON "CustomOrderIssue"("customOrderId", "createdAt");

-- CreateIndex
CREATE INDEX "CustomOrderDispute_customOrderId_status_idx" ON "CustomOrderDispute"("customOrderId", "status");

-- CreateIndex
CREATE INDEX "CustomOrderDispute_status_openedAt_idx" ON "CustomOrderDispute"("status", "openedAt");

-- CreateIndex
CREATE INDEX "CustomOrderLedgerAllocation_customOrderId_allocationType_idx" ON "CustomOrderLedgerAllocation"("customOrderId", "allocationType");

-- CreateIndex
CREATE INDEX "CustomOrderLedgerAllocation_status_eligibleAt_idx" ON "CustomOrderLedgerAllocation"("status", "eligibleAt");

-- CreateIndex
CREATE INDEX "PaymentAttempt_subjectType_customOrderId_idx" ON "PaymentAttempt"("subjectType", "customOrderId");

-- CreateIndex
CREATE INDEX "PaymentAttempt_buyerId_subjectType_customOrderId_idempotenc_idx" ON "PaymentAttempt"("buyerId", "subjectType", "customOrderId", "idempotencyKey");

-- AddForeignKey
ALTER TABLE "CustomOrderOffer" ADD CONSTRAINT "CustomOrderOffer_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "Brand"("_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomOrderOffer" ADD CONSTRAINT "CustomOrderOffer_fabricRuleBasisId_fkey" FOREIGN KEY ("fabricRuleBasisId") REFERENCES "CustomFabricRuleBasis"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomOrderOfferVersion" ADD CONSTRAINT "CustomOrderOfferVersion_offerId_fkey" FOREIGN KEY ("offerId") REFERENCES "CustomOrderOffer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomFabricRuleBasis" ADD CONSTRAINT "CustomFabricRuleBasis_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "Brand"("_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomFabricRule" ADD CONSTRAINT "CustomFabricRule_offerId_fkey" FOREIGN KEY ("offerId") REFERENCES "CustomOrderOffer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomOrder" ADD CONSTRAINT "CustomOrder_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "Brand"("_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomOrder" ADD CONSTRAINT "CustomOrder_buyerId_fkey" FOREIGN KEY ("buyerId") REFERENCES "User"("_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomOrder" ADD CONSTRAINT "CustomOrder_offerId_fkey" FOREIGN KEY ("offerId") REFERENCES "CustomOrderOffer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomOrder" ADD CONSTRAINT "CustomOrder_offerVersionId_fkey" FOREIGN KEY ("offerVersionId") REFERENCES "CustomOrderOfferVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomOrder" ADD CONSTRAINT "CustomOrder_checkoutIntentId_fkey" FOREIGN KEY ("checkoutIntentId") REFERENCES "CustomOrderCheckoutIntent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomOrderProgressEvent" ADD CONSTRAINT "CustomOrderProgressEvent_customOrderId_fkey" FOREIGN KEY ("customOrderId") REFERENCES "CustomOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomOrderExtensionRequest" ADD CONSTRAINT "CustomOrderExtensionRequest_customOrderId_fkey" FOREIGN KEY ("customOrderId") REFERENCES "CustomOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomOrderTimelineEvent" ADD CONSTRAINT "CustomOrderTimelineEvent_customOrderId_fkey" FOREIGN KEY ("customOrderId") REFERENCES "CustomOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomOrderIssue" ADD CONSTRAINT "CustomOrderIssue_customOrderId_fkey" FOREIGN KEY ("customOrderId") REFERENCES "CustomOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomOrderDispute" ADD CONSTRAINT "CustomOrderDispute_customOrderId_fkey" FOREIGN KEY ("customOrderId") REFERENCES "CustomOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomOrderLedgerAllocation" ADD CONSTRAINT "CustomOrderLedgerAllocation_customOrderId_fkey" FOREIGN KEY ("customOrderId") REFERENCES "CustomOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;
