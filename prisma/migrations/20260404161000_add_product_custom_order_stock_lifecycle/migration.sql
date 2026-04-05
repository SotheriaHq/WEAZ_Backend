ALTER TABLE "Product"
ADD COLUMN "customOrderOutOfStockTriggeredAt" TIMESTAMP(3),
ADD COLUMN "customOrderOutOfStockReminderSentAt" TIMESTAMP(3),
ADD COLUMN "customOrderOutOfStockDiscontinueAt" TIMESTAMP(3);

CREATE INDEX "Product_customOrderOutOfStockDiscontinueAt_idx"
ON "Product"("customOrderOutOfStockDiscontinueAt");
