BEGIN;
ALTER TABLE "SavedPaymentMethod" ADD COLUMN "nickname" VARCHAR(60);
ALTER TABLE "BrandSubscription" ADD COLUMN "savedPaymentMethodId" UUID;
ALTER TABLE "BrandSubscriptionInvoice" ADD COLUMN "payerEmail" TEXT;
ALTER TABLE "BrandSubscriptionInvoice" ADD COLUMN "paymentIdentityJson" JSONB;
UPDATE "BrandSubscriptionInvoice" i SET "payerEmail" = s."providerCustomerEmail" FROM "BrandSubscription" s WHERE i."subscriptionId" = s."id";
CREATE INDEX "BrandSubscription_savedPaymentMethodId_idx" ON "BrandSubscription"("savedPaymentMethodId");
ALTER TABLE "BrandSubscription" ADD CONSTRAINT "BrandSubscription_savedPaymentMethodId_fkey" FOREIGN KEY ("savedPaymentMethodId") REFERENCES "SavedPaymentMethod"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE TABLE "SubscriptionNoticeReceipt" (
  "userId" UUID NOT NULL,
  "brandId" UUID NOT NULL,
  "lastShownAt" TIMESTAMP(3) NOT NULL,
  "lastDismissedAt" TIMESTAMP(3),
  CONSTRAINT "SubscriptionNoticeReceipt_pkey" PRIMARY KEY ("userId", "brandId"),
  CONSTRAINT "SubscriptionNoticeReceipt_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("_id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "SubscriptionNoticeReceipt_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "Brand"("_id") ON DELETE CASCADE ON UPDATE CASCADE
);
COMMIT;
