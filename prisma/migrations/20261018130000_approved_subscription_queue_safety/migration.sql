-- Additive corrections to the queue foundation. No financial history is deleted.
ALTER TYPE "CustomOrderStatus" ADD VALUE IF NOT EXISTS 'QUEUED';
ALTER TYPE "CustomOrderTimelineEventType" ADD VALUE IF NOT EXISTS 'QUEUE_UPDATED';
ALTER TYPE "CustomOrderOutboxStatus" ADD VALUE IF NOT EXISTS 'SKIPPED';

ALTER TABLE "Brand"
  ADD COLUMN "activeOrderCapOverrideUntil" TIMESTAMP(3),
  ADD COLUMN "customOrderLegacyEligible" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "assignedSubscriptionTierKey" "SubscriptionTierKey",
  ADD COLUMN "queuePriorityStreak" INTEGER NOT NULL DEFAULT 0;
-- Only brands present at cutover are grandfathered. Future inserts default false.
UPDATE "Brand" SET "customOrderLegacyEligible" = true;

ALTER TABLE "SubscriptionTier"
  ALTER COLUMN "maxActive" DROP NOT NULL,
  ALTER COLUMN "maxInDelivery" DROP NOT NULL;
UPDATE "SubscriptionTier" SET "maxActive" = NULL, "maxInDelivery" = NULL, "queueJumpAllowed" = false WHERE "key" = 'LEGACY';
UPDATE "SubscriptionTier" SET "queueJumpAllowed" = false WHERE "key" IN ('THREAD', 'ASO_OKE');
ALTER TABLE "SubscriptionTier" ADD CONSTRAINT "SubscriptionTier_valid_capacity" CHECK (("maxActive" IS NULL OR "maxActive" >= 0) AND ("maxInDelivery" IS NULL OR "maxInDelivery" >= 0) AND "maxUpNext" = 1 AND "monthlyPriceNgn" >= 0);

-- This type is new in the immediately preceding foundation migration. Recreate
-- it so the new PENDING default can be used in the same migration transaction.
ALTER TYPE "BrandSubscriptionStatus" RENAME TO "BrandSubscriptionStatus_old";
CREATE TYPE "BrandSubscriptionStatus" AS ENUM ('PENDING','ACTIVE','PAST_DUE','CANCELLED');
DROP INDEX "BrandSubscription_one_active_per_brand";
ALTER TABLE "BrandSubscription" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "BrandSubscription" ALTER COLUMN "status" TYPE "BrandSubscriptionStatus" USING ("status"::text::"BrandSubscriptionStatus");
ALTER TABLE "BrandSubscription" ALTER COLUMN "status" SET DEFAULT 'PENDING';
DROP TYPE "BrandSubscriptionStatus_old";
ALTER TABLE "BrandSubscription"
  ADD COLUMN "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "recoveryUntil" TIMESTAMP(3),
  ADD COLUMN "scheduledTierKey" "SubscriptionTierKey",
  ADD COLUMN "providerAuthorizationCode" TEXT,
  ADD COLUMN "providerCustomerEmail" TEXT,
  ADD COLUMN "providerAuthorizationJson" JSONB,
  ADD COLUMN "billingAnchorDay" INTEGER,
  ADD COLUMN "recurringConsentAt" TIMESTAMP(3),
  ADD COLUMN "recurringPolicyVersion" TEXT;
CREATE UNIQUE INDEX "BrandSubscription_one_active_per_brand" ON "BrandSubscription" ("brandId") WHERE "status" = 'ACTIVE';
CREATE UNIQUE INDEX "BrandSubscription_one_open_agreement" ON "BrandSubscription" ("brandId") WHERE "status" IN ('ACTIVE','PAST_DUE');

ALTER TABLE "CustomOrder"
  ALTER COLUMN "lane" DROP NOT NULL,
  ALTER COLUMN "lane" DROP DEFAULT,
  ADD COLUMN "retainedAt" TIMESTAMP(3),
  ADD COLUMN "activatedAt" TIMESTAMP(3),
  ADD COLUMN "orderRevision" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "queuePolicyVersion" INTEGER,
  ADD COLUMN "queuePriority" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "adminPromotionHeld" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "jumpFeeAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN "cancelledAt" TIMESTAMP(3),
  ADD COLUMN "cancellationReason" TEXT,
  ADD COLUMN "cancellationActorType" "CustomOrderActorType",
  ADD COLUMN "predecessorOrderId" UUID;

-- Unpaid compatibility rows are never admitted to the paid queue.
UPDATE "CustomOrder" SET "lane" = NULL WHERE "status" IN ('DRAFT','PENDING_PAYMENT');
UPDATE "CustomOrder" SET "lane" = CASE WHEN "paymentStatus" = 'PAID' THEN 'ACTIVE'::"CustomOrderLane" ELSE NULL END WHERE "status" = 'PENDING_BRAND_ACCEPTANCE';
UPDATE "CustomOrder" SET "activatedAt" = COALESCE("acceptedAt", "createdAt") WHERE "lane" IN ('ACTIVE','IN_DELIVERY') AND "status" NOT IN ('DISPUTED','DELIVERY_ISSUE_REPORTED');

-- Recover disputed lane only from recorded dispatch evidence. Uncertain
-- histories remain quarantined and block new promotions pending reconciliation.
UPDATE "CustomOrder" co SET "lane" = CASE
  WHEN co."deliveredAt" IS NOT NULL OR EXISTS (
    SELECT 1 FROM "CustomOrderTimelineEvent" event
    WHERE event."customOrderId" = co."id" AND (
      event."payloadJson"->>'status' IN ('IN_TRANSIT','DELIVERED_PENDING_BUYER_CONFIRMATION')
      OR event."eventType"::text = 'DELIVERED'
    )
  ) THEN 'IN_DELIVERY'::"CustomOrderLane"
  WHEN co."status" = 'DISPUTED' AND co."acceptedAt" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "CustomOrderTimelineEvent" event WHERE event."customOrderId" = co."id" AND event."payloadJson"->>'status' = 'IN_TRANSIT'
  ) THEN NULL
  ELSE NULL END
WHERE co."status" IN ('DISPUTED','DELIVERY_ISSUE_REPORTED');
UPDATE "CustomOrder" SET "adminPromotionHeld" = true, "adminAttentionRequiredAt" = COALESCE("adminAttentionRequiredAt", CURRENT_TIMESTAMP), "adminAttentionReason" = 'Historical disputed lane requires reconciliation before queue promotion'
WHERE "lane" IS NULL AND "status" IN ('DISPUTED','DELIVERY_ISSUE_REPORTED');
CREATE UNIQUE INDEX "CustomOrder_one_up_next_per_brand" ON "CustomOrder" ("brandId") WHERE "lane" = 'UP_NEXT';
CREATE INDEX "CustomOrder_waiting_selection_idx" ON "CustomOrder" ("brandId","lane","adminPromotionHeld","queuePriority","queuePosition");
ALTER TABLE "CustomOrder" ADD CONSTRAINT "CustomOrder_queue_money_and_retains" CHECK ("jumpFeeAmount" >= 0 AND "retainCount" BETWEEN 0 AND 1 AND ("lane" NOT IN ('PENDING','UP_NEXT') OR "paymentStatus" = 'PAID'));

-- Refuse to invent an allocation winner when old data needs reconciliation.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM "CustomOrderLedgerAllocation" GROUP BY "customOrderId","allocationType" HAVING COUNT(*) > 1) THEN
    RAISE EXCEPTION 'Duplicate custom-order financial allocations require reconciliation before enabling the queue';
  END IF;
END $$;
CREATE UNIQUE INDEX "CustomOrderLedgerAllocation_financial_event_key" ON "CustomOrderLedgerAllocation" ("customOrderId","allocationType");

CREATE TABLE "BrandSubscriptionInvoice" (
  "id" UUID NOT NULL PRIMARY KEY, "subscriptionId" UUID NOT NULL,
  "reference" TEXT NOT NULL, "amount" DECIMAL(12,2) NOT NULL, "currency" TEXT NOT NULL DEFAULT 'NGN',
  "status" TEXT NOT NULL DEFAULT 'PENDING', "periodStart" TIMESTAMP(3) NOT NULL, "periodEnd" TIMESTAMP(3) NOT NULL,
  "authorizationUrl" TEXT, "providerAccessCode" TEXT, "providerTransactionId" TEXT,
  "purpose" TEXT NOT NULL DEFAULT 'RENEWAL', "previousSubscriptionId" UUID, "lockedAt" TIMESTAMP(3),
  "attemptCount" INTEGER NOT NULL DEFAULT 0, "nextAttemptAt" TIMESTAMP(3), "lastError" TEXT, "paidAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BrandSubscriptionInvoice_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "BrandSubscription"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "BrandSubscriptionInvoice_money" CHECK ("amount" >= 0 AND "periodEnd" > "periodStart")
);
CREATE UNIQUE INDEX "BrandSubscriptionInvoice_reference_key" ON "BrandSubscriptionInvoice" ("reference");
CREATE UNIQUE INDEX "BrandSubscriptionInvoice_subscriptionId_periodStart_key" ON "BrandSubscriptionInvoice" ("subscriptionId","periodStart");
CREATE INDEX "BrandSubscriptionInvoice_status_nextAttemptAt_idx" ON "BrandSubscriptionInvoice" ("status","nextAttemptAt");

CREATE TABLE "CustomOrderQueueRefund" (
  "id" UUID NOT NULL PRIMARY KEY, "customOrderId" UUID NOT NULL, "paymentAttemptId" UUID NOT NULL,
  "amount" DECIMAL(12,2) NOT NULL, "currency" TEXT NOT NULL, "breakdownJson" JSONB NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'REQUESTED', "providerRefundId" TEXT, "attempts" INTEGER NOT NULL DEFAULT 0,
  "lockedAt" TIMESTAMP(3), "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastError" TEXT, "settledAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CustomOrderQueueRefund_customOrderId_fkey" FOREIGN KEY ("customOrderId") REFERENCES "CustomOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "CustomOrderQueueRefund_paymentAttemptId_fkey" FOREIGN KEY ("paymentAttemptId") REFERENCES "PaymentAttempt"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "CustomOrderQueueRefund_money" CHECK ("amount" >= 0)
);
CREATE UNIQUE INDEX "CustomOrderQueueRefund_customOrderId_key" ON "CustomOrderQueueRefund" ("customOrderId");
CREATE INDEX "CustomOrderQueueRefund_status_nextAttemptAt_idx" ON "CustomOrderQueueRefund" ("status","nextAttemptAt");
CREATE INDEX "CustomOrderQueueRefund_paymentAttemptId_idx" ON "CustomOrderQueueRefund" ("paymentAttemptId");
