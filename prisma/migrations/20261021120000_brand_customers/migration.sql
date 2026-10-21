ALTER TABLE "Brand" ADD COLUMN "customerMinimumOrders" INTEGER NOT NULL DEFAULT 3;
ALTER TABLE "Brand" ADD CONSTRAINT "Brand_customerMinimumOrders_check" CHECK ("customerMinimumOrders" BETWEEN 1 AND 1000);
CREATE INDEX "Order_brand_paid_customer_idx" ON "Order" ("brandId", "buyerId", "createdAt" DESC)
  WHERE "paymentStatus" = 'PAID' AND "status" <> 'CANCELLED';
CREATE INDEX "CustomOrder_brand_paid_customer_idx" ON "CustomOrder" ("brandId", "buyerId", "createdAt" DESC)
  WHERE "paymentStatus" = 'PAID' AND "cancelledAt" IS NULL AND "anonymizedAt" IS NULL;
