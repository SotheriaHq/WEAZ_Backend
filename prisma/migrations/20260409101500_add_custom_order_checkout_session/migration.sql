-- CreateEnum
CREATE TYPE "CustomOrderCheckoutStatus" AS ENUM ('SUBMITTED', 'PAYMENT_INITIATED', 'PAID_CONFIRMED', 'ABANDONED');

-- CreateTable
CREATE TABLE "CustomOrderCheckoutSession" (
    "id" UUID NOT NULL,
    "buyerId" UUID NOT NULL,
    "checkoutIntentId" UUID NOT NULL,
    "customOrderId" UUID,
    "status" "CustomOrderCheckoutStatus" NOT NULL DEFAULT 'SUBMITTED',
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paymentInitiatedAt" TIMESTAMP(3),
    "paidConfirmedAt" TIMESTAMP(3),
    "abandonedAt" TIMESTAMP(3),
    "lastAttemptId" UUID,
    "lastAttemptReference" TEXT,
    "lastAttemptStatus" TEXT,
    "attemptsCount" INTEGER NOT NULL DEFAULT 0,
    "resumeToken" TEXT NOT NULL,
    "resumePath" TEXT,
    "uiStateJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomOrderCheckoutSession_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "CustomOrderCheckoutSession"
ADD CONSTRAINT "CustomOrderCheckoutSession_buyerId_fkey"
FOREIGN KEY ("buyerId") REFERENCES "User"("_id")
ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomOrderCheckoutSession"
ADD CONSTRAINT "CustomOrderCheckoutSession_checkoutIntentId_fkey"
FOREIGN KEY ("checkoutIntentId") REFERENCES "CustomOrderCheckoutIntent"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomOrderCheckoutSession"
ADD CONSTRAINT "CustomOrderCheckoutSession_customOrderId_fkey"
FOREIGN KEY ("customOrderId") REFERENCES "CustomOrder"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateIndex
CREATE UNIQUE INDEX "CustomOrderCheckoutSession_checkoutIntentId_key" ON "CustomOrderCheckoutSession"("checkoutIntentId");

-- CreateIndex
CREATE UNIQUE INDEX "CustomOrderCheckoutSession_resumeToken_key" ON "CustomOrderCheckoutSession"("resumeToken");

-- CreateIndex
CREATE INDEX "CustomOrderCheckoutSession_buyerId_status_createdAt_idx" ON "CustomOrderCheckoutSession"("buyerId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "CustomOrderCheckoutSession_customOrderId_idx" ON "CustomOrderCheckoutSession"("customOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "CustomOrderCheckoutSession_customOrderId_key" ON "CustomOrderCheckoutSession"("customOrderId");
