-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('PENDING_SELECTION', 'PAYSTACK', 'FLUTTERWAVE', 'BANK_TRANSFER', 'PAY_ON_DELIVERY');

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "discountAmount" DECIMAL(10,2) NOT NULL DEFAULT 0,
ADD COLUMN     "paidAt" TIMESTAMP(3),
ADD COLUMN     "paymentGateway" TEXT,
ADD COLUMN     "paymentMethod" "PaymentMethod" NOT NULL DEFAULT 'PENDING_SELECTION',
ADD COLUMN     "paymentReference" TEXT,
ADD COLUMN     "promoCode" TEXT,
ADD COLUMN     "shippingCost" DECIMAL(10,2) NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "Order_paymentReference_idx" ON "Order"("paymentReference");
