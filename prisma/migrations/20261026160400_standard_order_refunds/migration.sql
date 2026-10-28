-- Durable provider refunds for standard orders: one per order, never the whole
-- parent capture, with the same lifecycle as custom-order queue refunds.
CREATE TABLE "StandardOrderRefund" (
  "id" UUID NOT NULL,
  "requestKey" TEXT NOT NULL,
  "orderId" UUID NOT NULL,
  "paymentAttemptId" UUID NOT NULL,
  "escrowHoldId" UUID NOT NULL,
  "provider" TEXT NOT NULL,
  "trigger" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "amount" DECIMAL(12,2) NOT NULL,
  "currency" TEXT NOT NULL,
  "settlementAmount" DECIMAL(12,2) NOT NULL,
  "settlementCurrency" TEXT NOT NULL,
  "breakdownJson" JSONB NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'REQUESTED',
  "providerRefundId" TEXT,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "leaseToken" UUID,
  "lockedAt" TIMESTAMP(3),
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastError" TEXT,
  "actorId" UUID,
  "settledAt" TIMESTAMP(3),
  "buyerNotifiedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "StandardOrderRefund_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "StandardOrderRefund_status_check" CHECK ("status" IN
    ('REQUESTED', 'SUBMITTING', 'PROCESSING', 'SETTLED', 'FAILED', 'NEEDS_ATTENTION')),
  CONSTRAINT "StandardOrderRefund_trigger_check" CHECK ("trigger" IN
    ('RETURN', 'SLA_TIMEOUT', 'ADMIN_SLA_CANCEL', 'PRODUCT_REMOVAL', 'ADMIN')),
  CONSTRAINT "StandardOrderRefund_money" CHECK ("amount" > 0 AND "settlementAmount" >= 0 AND "attempts" >= 0),
  CONSTRAINT "StandardOrderRefund_currency_format" CHECK
    ("currency" ~ '^[A-Z]{3}$' AND "settlementCurrency" ~ '^[A-Z]{3}$'),
  CONSTRAINT "StandardOrderRefund_settled_at" CHECK (("status" = 'SETTLED') = ("settledAt" IS NOT NULL)),
  CONSTRAINT "StandardOrderRefund_provider_id" CHECK
    ("status" NOT IN ('PROCESSING', 'SETTLED') OR "providerRefundId" IS NOT NULL),
  CONSTRAINT "StandardOrderRefund_submission_lease" CHECK
    ("status" <> 'SUBMITTING' OR ("leaseToken" IS NOT NULL AND "lockedAt" IS NOT NULL))
);

CREATE UNIQUE INDEX "StandardOrderRefund_requestKey_key" ON "StandardOrderRefund"("requestKey");
CREATE UNIQUE INDEX "StandardOrderRefund_orderId_key" ON "StandardOrderRefund"("orderId");
CREATE UNIQUE INDEX "StandardOrderRefund_escrowHoldId_key" ON "StandardOrderRefund"("escrowHoldId");
CREATE UNIQUE INDEX "StandardOrderRefund_provider_providerRefundId_key"
  ON "StandardOrderRefund"("provider", "providerRefundId");
CREATE INDEX "StandardOrderRefund_status_nextAttemptAt_idx" ON "StandardOrderRefund"("status", "nextAttemptAt");
CREATE INDEX "StandardOrderRefund_paymentAttemptId_idx" ON "StandardOrderRefund"("paymentAttemptId");
CREATE INDEX "StandardOrderRefund_unnotified_idx" ON "StandardOrderRefund"("settledAt")
  WHERE "status" = 'SETTLED' AND "buyerNotifiedAt" IS NULL;

ALTER TABLE "StandardOrderRefund" ADD CONSTRAINT "StandardOrderRefund_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "Order"("_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StandardOrderRefund" ADD CONSTRAINT "StandardOrderRefund_paymentAttemptId_fkey"
  FOREIGN KEY ("paymentAttemptId") REFERENCES "PaymentAttempt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StandardOrderRefund" ADD CONSTRAINT "StandardOrderRefund_escrowHoldId_fkey"
  FOREIGN KEY ("escrowHoldId") REFERENCES "EscrowHold"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "EscrowHold" WHERE "totalAmount" < 0 OR "commissionAmount" < 0 OR "netBrandAmount" < 0
      OR "firstReleaseAmount" < 0 OR "secondReleaseAmount" < 0 OR "firstReleaseNetAmount" < 0
      OR "secondReleaseNetAmount" < 0 OR "firstReleaseCommissionAmount" < 0 OR "secondReleaseCommissionAmount" < 0
      OR currency !~ '^[A-Z]{3}$'
  ) THEN
    RAISE EXCEPTION 'Escrow holds contain negative amounts or malformed currencies. Reconcile them first.';
  END IF;
END $$;
ALTER TABLE "EscrowHold" ADD CONSTRAINT "EscrowHold_amounts_non_negative" CHECK (
  "totalAmount" >= 0 AND "commissionAmount" >= 0 AND "netBrandAmount" >= 0 AND
  "firstReleaseAmount" >= 0 AND "secondReleaseAmount" >= 0 AND
  "firstReleaseNetAmount" >= 0 AND "secondReleaseNetAmount" >= 0 AND
  "firstReleaseCommissionAmount" >= 0 AND "secondReleaseCommissionAmount" >= 0
);
ALTER TABLE "EscrowHold" ADD CONSTRAINT "EscrowHold_currency_format" CHECK ("currency" ~ '^[A-Z]{3}$');
