-- Preserve every recurring-billing capture independently from its invoice.
-- A second/late charge is a refundable liability, never a second paid period.
ALTER TABLE "BrandSubscriptionInvoice" ADD COLUMN "hostedReference" TEXT;
ALTER TABLE "BrandSubscriptionInvoice" ADD COLUMN "hostedAttemptReferences" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "BrandSubscription" ADD COLUMN "cancelRequestedAt" TIMESTAMP(3);
CREATE TABLE "BrandSubscriptionPaymentCapture" (
  "id" UUID NOT NULL,
  "invoiceId" UUID NOT NULL,
  "reference" TEXT NOT NULL,
  "providerTransactionId" TEXT,
  "amount" DECIMAL(12,2) NOT NULL,
  "currency" TEXT NOT NULL,
  "paidAt" TIMESTAMP(3) NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'APPLIED',
  "reason" TEXT,
  "providerRefundId" TEXT,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "lockedAt" TIMESTAMP(3),
  "nextAttemptAt" TIMESTAMP(3),
  "lastError" TEXT,
  "refundedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BrandSubscriptionPaymentCapture_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "BrandSubscriptionPaymentCapture_amount_nonnegative" CHECK ("amount" >= 0),
  CONSTRAINT "BrandSubscriptionPaymentCapture_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "BrandSubscriptionInvoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "BrandSubscriptionPaymentCapture_reference_key" ON "BrandSubscriptionPaymentCapture"("reference");
CREATE UNIQUE INDEX "BrandSubscriptionPaymentCapture_providerTransactionId_key" ON "BrandSubscriptionPaymentCapture"("providerTransactionId");
CREATE INDEX "BrandSubscriptionPaymentCapture_status_nextAttemptAt_idx" ON "BrandSubscriptionPaymentCapture"("status", "nextAttemptAt");
CREATE INDEX "BrandSubscriptionPaymentCapture_invoiceId_idx" ON "BrandSubscriptionPaymentCapture"("invoiceId");
