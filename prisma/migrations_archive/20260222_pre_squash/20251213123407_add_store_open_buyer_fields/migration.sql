-- AlterTable
ALTER TABLE "Brand" ADD COLUMN     "isStoreOpen" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "buyerId" UUID,
ADD COLUMN     "contactInfo" JSONB,
ADD COLUMN     "shippingAddress" JSONB;

-- CreateIndex
CREATE INDEX "Order_buyerId_idx" ON "Order"("buyerId");

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_buyerId_fkey" FOREIGN KEY ("buyerId") REFERENCES "User"("_id") ON DELETE SET NULL ON UPDATE CASCADE;
