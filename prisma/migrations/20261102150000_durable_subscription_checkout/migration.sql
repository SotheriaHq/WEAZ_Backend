CREATE TABLE "BrandSubscriptionCheckoutCommand" (
  "id" UUID NOT NULL,
  "invoiceId" UUID NOT NULL,
  "reference" TEXT NOT NULL,
  "commandCiphertext" TEXT NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'READY',
  "leaseToken" UUID,
  "leaseUntil" TIMESTAMP(3),
  "dispatchedAt" TIMESTAMP(3),
  "nextAttemptAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BrandSubscriptionCheckoutCommand_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "BrandSubscriptionCheckoutCommand_invoiceId_fkey" FOREIGN KEY ("invoiceId")
    REFERENCES "BrandSubscriptionInvoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "BrandSubscriptionCheckoutCommand_state_check"
    CHECK ("state" IN ('READY','DISPATCHED','WAITING','SUCCEEDED','FAILED','REVIEW')),
  CONSTRAINT "BrandSubscriptionCheckoutCommand_lease_check"
    CHECK (("leaseToken" IS NULL) = ("leaseUntil" IS NULL))
);
CREATE UNIQUE INDEX "BrandSubscriptionCheckoutCommand_reference_key"
  ON "BrandSubscriptionCheckoutCommand"("reference");
CREATE INDEX "BrandSubscriptionCheckoutCommand_state_nextAttemptAt_idx"
  ON "BrandSubscriptionCheckoutCommand"("state","nextAttemptAt");
CREATE INDEX "BrandSubscriptionCheckoutCommand_invoiceId_createdAt_idx"
  ON "BrandSubscriptionCheckoutCommand"("invoiceId","createdAt");
CREATE UNIQUE INDEX "BrandSubscriptionCheckoutCommand_one_open_invoice"
  ON "BrandSubscriptionCheckoutCommand"("invoiceId")
  WHERE "state" IN ('READY','DISPATCHED','WAITING','REVIEW');
