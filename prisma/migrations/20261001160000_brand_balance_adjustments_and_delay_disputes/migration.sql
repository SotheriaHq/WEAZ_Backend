-- The shopper is refunded first, and the brand carries the difference.
--
-- A refund on an order the brand has already been paid for leaves the platform
-- out of pocket. The decision is that WIEZ pays the shopper immediately and
-- recovers from the brand's later earnings, rather than making a shopper wait
-- for a brand to have money. Before this, that shortfall existed only as
-- arithmetic — `availableBalance = released - reserved - paidOut` quietly going
-- negative — with no record of WHY, no history, and nothing to show the brand.
--
-- `BrandBalanceAdjustment` makes the debt a thing: what caused it, how much is
-- left, and which order paid down which part of it. `BrandBalanceRecovery` is
-- the per-payment detail, so a brand's finance screen can read as a statement
-- instead of a single negative number nobody can explain.
--
-- Recovery is oldest-debt-first out of each later release. A brand carrying a
-- debt must acknowledge it before accepting new custom work, which is what
-- `CustomOrder.brandDebtAck*` records — the amount is stored alongside the
-- timestamp so the notice they agreed to can be reproduced after the balance
-- has moved on.

CREATE TYPE "BrandBalanceAdjustmentType" AS ENUM (
  'REFUND_CLAWBACK',
  'CHARGEBACK',
  'MANUAL_DEBIT',
  'MANUAL_CREDIT'
);

CREATE TYPE "BrandBalanceAdjustmentStatus" AS ENUM (
  'OUTSTANDING',
  'PARTIALLY_RECOVERED',
  'RECOVERED',
  'WAIVED'
);

CREATE TABLE "BrandBalanceAdjustment" (
  "id"              UUID NOT NULL DEFAULT gen_random_uuid(),
  "brandId"         UUID NOT NULL,
  "type"            "BrandBalanceAdjustmentType" NOT NULL,
  "status"          "BrandBalanceAdjustmentStatus" NOT NULL DEFAULT 'OUTSTANDING',
  "amount"          DECIMAL(18,2) NOT NULL,
  "recoveredAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
  "currency"        TEXT NOT NULL DEFAULT 'NGN',
  "reason"          TEXT NOT NULL,
  "customOrderId"   UUID,
  "orderId"         UUID,
  "createdById"     UUID,
  "settledAt"       TIMESTAMP(3),
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BrandBalanceAdjustment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BrandBalanceRecovery" (
  "id"            UUID NOT NULL DEFAULT gen_random_uuid(),
  "adjustmentId"  UUID NOT NULL,
  "amount"        DECIMAL(18,2) NOT NULL,
  "currency"      TEXT NOT NULL DEFAULT 'NGN',
  "customOrderId" UUID,
  "orderId"       UUID,
  "note"          TEXT,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BrandBalanceRecovery_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "BrandBalanceAdjustment"
  ADD CONSTRAINT "BrandBalanceAdjustment_brandId_fkey"
  FOREIGN KEY ("brandId") REFERENCES "Brand"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "BrandBalanceRecovery"
  ADD CONSTRAINT "BrandBalanceRecovery_adjustmentId_fkey"
  FOREIGN KEY ("adjustmentId") REFERENCES "BrandBalanceAdjustment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The outstanding-debt lookup runs on every payout check and on every custom
-- order a brand is asked to accept, so it is indexed on both access paths.
CREATE INDEX "BrandBalanceAdjustment_brandId_status_idx"
  ON "BrandBalanceAdjustment" ("brandId", "status");
CREATE INDEX "BrandBalanceAdjustment_brandId_createdAt_idx"
  ON "BrandBalanceAdjustment" ("brandId", "createdAt");
CREATE INDEX "BrandBalanceRecovery_adjustmentId_createdAt_idx"
  ON "BrandBalanceRecovery" ("adjustmentId", "createdAt");

ALTER TABLE "CustomOrder"
  ADD COLUMN "brandDebtAckAt" TIMESTAMP(3),
  ADD COLUMN "brandDebtAckAmount" DECIMAL(18,2);

-- A brand must never discover a debt by noticing its balance is short.
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'BRAND_BALANCE_ADJUSTED';
