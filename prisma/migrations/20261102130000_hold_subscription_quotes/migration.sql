CREATE TABLE "BrandSubscriptionQuote" (
  "id" UUID PRIMARY KEY, "brandId" UUID NOT NULL, "actorId" UUID NOT NULL,
  "tierKey" "SubscriptionTierKey" NOT NULL, "kind" TEXT NOT NULL,
  "amount" DECIMAL(12,2) NOT NULL, "monthlyPriceNgn" DECIMAL(12,2) NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'NGN', "agreementFingerprint" TEXT,
  "periodStart" TIMESTAMP(3) NOT NULL, "periodEnd" TIMESTAMP(3) NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL, "usedAt" TIMESTAMP(3), "usedByRequestId" UUID, "invoiceId" UUID,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BrandSubscriptionQuote_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "Brand"("_id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "BrandSubscriptionQuote_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "BrandSubscriptionInvoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "BrandSubscriptionQuote_kind_check" CHECK ("kind" IN ('INITIAL','UPGRADE','DOWNGRADE','UNCHANGED')),
  CONSTRAINT "BrandSubscriptionQuote_amount_check" CHECK ("amount">=0 AND "monthlyPriceNgn">=0 AND "currency"='NGN')
);
CREATE INDEX "BrandSubscriptionQuote_brandId_actorId_expiresAt_idx" ON "BrandSubscriptionQuote"("brandId","actorId","expiresAt");
CREATE INDEX "BrandSubscriptionQuote_unused_expiry_idx" ON "BrandSubscriptionQuote"("expiresAt","id") WHERE "usedAt" IS NULL;
CREATE INDEX "BrandSubscriptionQuote_invoiceId_idx" ON "BrandSubscriptionQuote"("invoiceId");
