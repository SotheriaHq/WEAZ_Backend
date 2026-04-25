/*
  Warnings:

  - A unique constraint covering the columns `[checkoutSessionId]` on the table `PaymentAttempt` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateEnum
CREATE TYPE "CheckoutSessionStatus" AS ENUM ('PENDING_PAYMENT', 'PAYMENT_PROCESSING', 'PAID', 'COMPLETED', 'FAILED', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "CheckoutSessionLineType" AS ENUM ('STANDARD_ITEM', 'CUSTOM_ORDER');

-- CreateEnum
CREATE TYPE "CheckoutSessionLineStatus" AS ENUM ('PENDING', 'BLOCKED', 'RESERVED', 'COMMITTED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "InventoryReservationStatus" AS ENUM ('RESERVED', 'COMMITTED', 'RELEASED', 'EXPIRED');

-- AlterTable
ALTER TABLE "CustomOrder" ADD COLUMN     "unifiedCheckoutSessionId" UUID;

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "unifiedCheckoutSessionId" UUID;

-- AlterTable
ALTER TABLE "PaymentAttempt" ADD COLUMN     "checkoutSessionId" UUID;

-- CreateTable
CREATE TABLE "CheckoutSession" (
    "id" UUID NOT NULL,
    "buyerId" UUID NOT NULL,
    "status" "CheckoutSessionStatus" NOT NULL DEFAULT 'PENDING_PAYMENT',
    "idempotencyKey" TEXT NOT NULL,
    "paymentMethod" "PaymentMethod" NOT NULL DEFAULT 'PENDING_SELECTION',
    "shippingAddressJson" JSONB,
    "contactInfoJson" JSONB,
    "customerName" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'NGN',
    "subtotal" DECIMAL(10,2) NOT NULL,
    "shippingCost" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "discountAmount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "grandTotal" DECIMAL(10,2) NOT NULL,
    "summaryJson" JSONB,
    "blockedLinesJson" JSONB,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CheckoutSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CheckoutSessionLine" (
    "id" UUID NOT NULL,
    "checkoutSessionId" UUID NOT NULL,
    "lineType" "CheckoutSessionLineType" NOT NULL,
    "status" "CheckoutSessionLineStatus" NOT NULL DEFAULT 'PENDING',
    "lineOrder" INTEGER NOT NULL DEFAULT 0,
    "brandId" UUID,
    "productId" UUID,
    "checkoutIntentId" UUID,
    "customOrderId" UUID,
    "orderId" UUID,
    "cartItemId" UUID,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "unitPrice" DECIMAL(10,2) NOT NULL,
    "lineTotal" DECIMAL(10,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'NGN',
    "selectedSize" TEXT,
    "selectedColor" TEXT,
    "itemSnapshotJson" JSONB NOT NULL,
    "metadataJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CheckoutSessionLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryReservation" (
    "id" UUID NOT NULL,
    "checkoutSessionId" UUID NOT NULL,
    "checkoutSessionLineId" UUID,
    "productId" UUID NOT NULL,
    "productVariantId" UUID,
    "quantity" INTEGER NOT NULL,
    "reservedSize" TEXT,
    "reservedColor" TEXT,
    "status" "InventoryReservationStatus" NOT NULL DEFAULT 'RESERVED',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "committedAt" TIMESTAMP(3),
    "releasedAt" TIMESTAMP(3),
    "releaseReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InventoryReservation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CheckoutSession_buyerId_status_createdAt_idx" ON "CheckoutSession"("buyerId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "CheckoutSession_status_expiresAt_idx" ON "CheckoutSession"("status", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "CheckoutSession_buyerId_idempotencyKey_key" ON "CheckoutSession"("buyerId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "CheckoutSessionLine_checkoutSessionId_lineOrder_idx" ON "CheckoutSessionLine"("checkoutSessionId", "lineOrder");

-- CreateIndex
CREATE INDEX "CheckoutSessionLine_checkoutIntentId_idx" ON "CheckoutSessionLine"("checkoutIntentId");

-- CreateIndex
CREATE INDEX "CheckoutSessionLine_productId_idx" ON "CheckoutSessionLine"("productId");

-- CreateIndex
CREATE INDEX "CheckoutSessionLine_orderId_idx" ON "CheckoutSessionLine"("orderId");

-- CreateIndex
CREATE INDEX "CheckoutSessionLine_customOrderId_idx" ON "CheckoutSessionLine"("customOrderId");

-- CreateIndex
CREATE INDEX "CheckoutSessionLine_cartItemId_idx" ON "CheckoutSessionLine"("cartItemId");

-- CreateIndex
CREATE INDEX "InventoryReservation_checkoutSessionId_status_idx" ON "InventoryReservation"("checkoutSessionId", "status");

-- CreateIndex
CREATE INDEX "InventoryReservation_checkoutSessionLineId_idx" ON "InventoryReservation"("checkoutSessionLineId");

-- CreateIndex
CREATE INDEX "InventoryReservation_productId_status_expiresAt_idx" ON "InventoryReservation"("productId", "status", "expiresAt");

-- CreateIndex
CREATE INDEX "InventoryReservation_productVariantId_status_expiresAt_idx" ON "InventoryReservation"("productVariantId", "status", "expiresAt");

-- CreateIndex
CREATE INDEX "CustomOrder_unifiedCheckoutSessionId_idx" ON "CustomOrder"("unifiedCheckoutSessionId");

-- CreateIndex
CREATE INDEX "Order_unifiedCheckoutSessionId_idx" ON "Order"("unifiedCheckoutSessionId");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentAttempt_checkoutSessionId_key" ON "PaymentAttempt"("checkoutSessionId");

-- CreateIndex
CREATE INDEX "PaymentAttempt_subjectType_checkoutSessionId_idx" ON "PaymentAttempt"("subjectType", "checkoutSessionId");

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_unifiedCheckoutSessionId_fkey" FOREIGN KEY ("unifiedCheckoutSessionId") REFERENCES "CheckoutSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomOrder" ADD CONSTRAINT "CustomOrder_unifiedCheckoutSessionId_fkey" FOREIGN KEY ("unifiedCheckoutSessionId") REFERENCES "CheckoutSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckoutSession" ADD CONSTRAINT "CheckoutSession_buyerId_fkey" FOREIGN KEY ("buyerId") REFERENCES "User"("_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckoutSessionLine" ADD CONSTRAINT "CheckoutSessionLine_checkoutSessionId_fkey" FOREIGN KEY ("checkoutSessionId") REFERENCES "CheckoutSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckoutSessionLine" ADD CONSTRAINT "CheckoutSessionLine_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckoutSessionLine" ADD CONSTRAINT "CheckoutSessionLine_checkoutIntentId_fkey" FOREIGN KEY ("checkoutIntentId") REFERENCES "CustomOrderCheckoutIntent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckoutSessionLine" ADD CONSTRAINT "CheckoutSessionLine_customOrderId_fkey" FOREIGN KEY ("customOrderId") REFERENCES "CustomOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckoutSessionLine" ADD CONSTRAINT "CheckoutSessionLine_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckoutSessionLine" ADD CONSTRAINT "CheckoutSessionLine_cartItemId_fkey" FOREIGN KEY ("cartItemId") REFERENCES "CartItem"("_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryReservation" ADD CONSTRAINT "InventoryReservation_checkoutSessionId_fkey" FOREIGN KEY ("checkoutSessionId") REFERENCES "CheckoutSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryReservation" ADD CONSTRAINT "InventoryReservation_checkoutSessionLineId_fkey" FOREIGN KEY ("checkoutSessionLineId") REFERENCES "CheckoutSessionLine"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryReservation" ADD CONSTRAINT "InventoryReservation_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryReservation" ADD CONSTRAINT "InventoryReservation_productVariantId_fkey" FOREIGN KEY ("productVariantId") REFERENCES "ProductVariant"("_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentAttempt" ADD CONSTRAINT "PaymentAttempt_checkoutSessionId_fkey" FOREIGN KEY ("checkoutSessionId") REFERENCES "CheckoutSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;
