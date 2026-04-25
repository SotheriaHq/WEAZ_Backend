ALTER TABLE "PaymentAttempt"
ADD COLUMN "providerReference" TEXT,
ADD COLUMN "providerTransactionId" TEXT,
ADD COLUMN "providerAccessCode" TEXT,
ADD COLUMN "providerChannel" TEXT,
ADD COLUMN "finalizedAt" TIMESTAMP(3);

ALTER TABLE "PaymentEvent"
ADD COLUMN "providerEventKey" TEXT,
ADD COLUMN "providerEventType" TEXT,
ADD COLUMN "providerEventReceivedAt" TIMESTAMP(3),
ADD COLUMN "processedAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "PaymentEvent_providerEventKey_key" ON "PaymentEvent"("providerEventKey");
CREATE INDEX "PaymentEvent_providerEventType_createdAt_idx" ON "PaymentEvent"("providerEventType", "createdAt");
