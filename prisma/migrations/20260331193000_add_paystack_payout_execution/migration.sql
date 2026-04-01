ALTER TABLE "Payout"
ADD COLUMN "provider" TEXT NOT NULL DEFAULT 'PAYSTACK',
ADD COLUMN "providerRecipientCode" TEXT,
ADD COLUMN "providerRecipientId" TEXT,
ADD COLUMN "providerTransferCode" TEXT,
ADD COLUMN "providerTransferId" TEXT,
ADD COLUMN "providerTransferReference" TEXT,
ADD COLUMN "providerTransferStatus" TEXT,
ADD COLUMN "providerTransferFailureCode" TEXT,
ADD COLUMN "providerTransferFailureMessage" TEXT,
ADD COLUMN "providerTransferPayload" JSONB,
ADD COLUMN "providerTransferInitiatedAt" TIMESTAMP(3),
ADD COLUMN "providerTransferFinalizedAt" TIMESTAMP(3),
ADD COLUMN "providerTransferReversedAt" TIMESTAMP(3);

CREATE TABLE "PayoutEvent" (
  "id" UUID NOT NULL,
  "payoutId" UUID NOT NULL,
  "type" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "providerEventKey" TEXT,
  "providerEventType" TEXT,
  "providerEventReceivedAt" TIMESTAMP(3),
  "processedAt" TIMESTAMP(3),
  "payload" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "PayoutEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Payout_providerTransferCode_key" ON "Payout"("providerTransferCode");
CREATE UNIQUE INDEX "Payout_providerTransferReference_key" ON "Payout"("providerTransferReference");
CREATE INDEX "Payout_providerTransferStatus_createdAt_idx" ON "Payout"("providerTransferStatus", "createdAt");

CREATE UNIQUE INDEX "PayoutEvent_providerEventKey_key" ON "PayoutEvent"("providerEventKey");
CREATE INDEX "PayoutEvent_payoutId_createdAt_idx" ON "PayoutEvent"("payoutId", "createdAt");
CREATE INDEX "PayoutEvent_providerEventType_createdAt_idx" ON "PayoutEvent"("providerEventType", "createdAt");

ALTER TABLE "PayoutEvent"
ADD CONSTRAINT "PayoutEvent_payoutId_fkey"
FOREIGN KEY ("payoutId") REFERENCES "Payout"("_id") ON DELETE CASCADE ON UPDATE CASCADE;
