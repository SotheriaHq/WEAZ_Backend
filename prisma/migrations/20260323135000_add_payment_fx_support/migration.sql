-- CreateEnum
CREATE TYPE "ExchangeRateSource" AS ENUM ('PARITY', 'FRANKFURTER', 'PAYSTACK', 'FLUTTERWAVE');

-- CreateTable
CREATE TABLE "ExchangeRateSnapshot" (
  "id" UUID NOT NULL,
  "provider" TEXT NOT NULL,
  "baseCurrency" TEXT NOT NULL,
  "quoteCurrency" TEXT NOT NULL,
  "rate" DECIMAL(18,8) NOT NULL,
  "capturedAt" TIMESTAMP(3) NOT NULL,
  "source" "ExchangeRateSource" NOT NULL,
  "rawPayload" JSONB,
  "createdById" UUID,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ExchangeRateSnapshot_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "PaymentAttempt"
ADD COLUMN "settlementCurrency" TEXT NOT NULL DEFAULT 'NGN',
ADD COLUMN "settlementAmount" DECIMAL(10,2),
ADD COLUMN "exchangeRateSnapshotId" UUID;

-- CreateIndex
CREATE INDEX "ExchangeRateSnapshot_baseCurrency_quoteCurrency_capturedAt_idx"
ON "ExchangeRateSnapshot"("baseCurrency", "quoteCurrency", "capturedAt");

-- CreateIndex
CREATE INDEX "ExchangeRateSnapshot_source_capturedAt_idx"
ON "ExchangeRateSnapshot"("source", "capturedAt");

-- CreateIndex
CREATE INDEX "PaymentAttempt_exchangeRateSnapshotId_idx"
ON "PaymentAttempt"("exchangeRateSnapshotId");

-- AddForeignKey
ALTER TABLE "ExchangeRateSnapshot"
ADD CONSTRAINT "ExchangeRateSnapshot_createdById_fkey"
FOREIGN KEY ("createdById") REFERENCES "User"("_id")
ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentAttempt"
ADD CONSTRAINT "PaymentAttempt_exchangeRateSnapshotId_fkey"
FOREIGN KEY ("exchangeRateSnapshotId") REFERENCES "ExchangeRateSnapshot"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
