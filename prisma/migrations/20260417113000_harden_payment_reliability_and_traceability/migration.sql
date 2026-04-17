-- AlterTable
ALTER TABLE "PaymentAttempt"
ADD COLUMN "finalizationFailureCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "finalizationFirstFailedAt" TIMESTAMP(3),
ADD COLUMN "finalizationLastFailedAt" TIMESTAMP(3),
ADD COLUMN "finalizationLastFailureReason" TEXT,
ADD COLUMN "finalizationCompensationStatus" TEXT;

-- AlterTable
ALTER TABLE "PayoutEvent"
ADD COLUMN "correlationId" TEXT;

-- CreateTable
CREATE TABLE "PaymentAttemptRetryHistory" (
    "id" UUID NOT NULL,
    "paymentAttemptId" UUID NOT NULL,
    "providerEventKey" TEXT,
    "source" TEXT NOT NULL,
    "queueAttempt" INTEGER,
    "queueJobId" TEXT,
    "errorReason" TEXT NOT NULL,
    "payload" JSONB,
    "correlationId" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentAttemptRetryHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentAttemptCheckoutIntentLink" (
    "id" UUID NOT NULL,
    "paymentAttemptId" UUID NOT NULL,
    "checkoutIntentId" UUID NOT NULL,
    "checkoutSessionId" UUID,
    "checkoutSessionLineId" UUID,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "finalizedAt" TIMESTAMP(3),
    "metadataJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentAttemptCheckoutIntentLink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PaymentAttempt_finalizationFailureCount_updatedAt_idx" ON "PaymentAttempt"("finalizationFailureCount", "updatedAt");

-- CreateIndex
CREATE INDEX "PaymentAttempt_finalizationCompensationStatus_updatedAt_idx" ON "PaymentAttempt"("finalizationCompensationStatus", "updatedAt");

-- CreateIndex
CREATE INDEX "PayoutEvent_correlationId_createdAt_idx" ON "PayoutEvent"("correlationId", "createdAt");

-- CreateIndex
CREATE INDEX "PaymentAttemptRetryHistory_paymentAttemptId_occurredAt_idx" ON "PaymentAttemptRetryHistory"("paymentAttemptId", "occurredAt");

-- CreateIndex
CREATE INDEX "PaymentAttemptRetryHistory_providerEventKey_occurredAt_idx" ON "PaymentAttemptRetryHistory"("providerEventKey", "occurredAt");

-- CreateIndex
CREATE INDEX "PaymentAttemptRetryHistory_correlationId_occurredAt_idx" ON "PaymentAttemptRetryHistory"("correlationId", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentAttemptCheckoutIntentLink_paymentAttemptId_checkoutIntentId_key" ON "PaymentAttemptCheckoutIntentLink"("paymentAttemptId", "checkoutIntentId");

-- CreateIndex
CREATE INDEX "PaymentAttemptCheckoutIntentLink_checkoutIntentId_createdAt_idx" ON "PaymentAttemptCheckoutIntentLink"("checkoutIntentId", "createdAt");

-- CreateIndex
CREATE INDEX "PaymentAttemptCheckoutIntentLink_paymentAttemptId_status_createdAt_idx" ON "PaymentAttemptCheckoutIntentLink"("paymentAttemptId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "PaymentAttemptCheckoutIntentLink_checkoutSessionId_idx" ON "PaymentAttemptCheckoutIntentLink"("checkoutSessionId");

-- CreateIndex
CREATE INDEX "PaymentAttemptCheckoutIntentLink_checkoutSessionLineId_idx" ON "PaymentAttemptCheckoutIntentLink"("checkoutSessionLineId");

-- AddForeignKey
ALTER TABLE "PaymentAttemptRetryHistory" ADD CONSTRAINT "PaymentAttemptRetryHistory_paymentAttemptId_fkey" FOREIGN KEY ("paymentAttemptId") REFERENCES "PaymentAttempt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentAttemptCheckoutIntentLink" ADD CONSTRAINT "PaymentAttemptCheckoutIntentLink_paymentAttemptId_fkey" FOREIGN KEY ("paymentAttemptId") REFERENCES "PaymentAttempt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentAttemptCheckoutIntentLink" ADD CONSTRAINT "PaymentAttemptCheckoutIntentLink_checkoutIntentId_fkey" FOREIGN KEY ("checkoutIntentId") REFERENCES "CustomOrderCheckoutIntent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentAttemptCheckoutIntentLink" ADD CONSTRAINT "PaymentAttemptCheckoutIntentLink_checkoutSessionId_fkey" FOREIGN KEY ("checkoutSessionId") REFERENCES "CheckoutSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentAttemptCheckoutIntentLink" ADD CONSTRAINT "PaymentAttemptCheckoutIntentLink_checkoutSessionLineId_fkey" FOREIGN KEY ("checkoutSessionLineId") REFERENCES "CheckoutSessionLine"("id") ON DELETE SET NULL ON UPDATE CASCADE;
