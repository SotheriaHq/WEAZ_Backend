-- CreateEnum
CREATE TYPE "LedgerAccountType" AS ENUM ('ASSET', 'LIABILITY', 'REVENUE', 'EXPENSE');

-- CreateEnum
CREATE TYPE "LedgerEntryDirection" AS ENUM ('DEBIT', 'CREDIT');

-- CreateEnum
CREATE TYPE "LedgerTransactionType" AS ENUM (
  'PAYMENT_RECEIVED',
  'ESCROW_RELEASE',
  'PAYOUT_DISBURSED',
  'REFUND_ISSUED',
  'REVERSAL'
);

-- CreateTable
CREATE TABLE "LedgerAccount" (
  "id" UUID NOT NULL,
  "code" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "type" "LedgerAccountType" NOT NULL,
  "subType" TEXT NOT NULL,
  "parentAccountId" UUID,
  "entityType" TEXT,
  "entityId" UUID,
  "currency" TEXT NOT NULL DEFAULT 'NGN',
  "currentBalance" DECIMAL(18,2) NOT NULL DEFAULT 0,
  "isSystemAccount" BOOLEAN NOT NULL DEFAULT false,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "LedgerAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LedgerTransaction" (
  "id" UUID NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "type" "LedgerTransactionType" NOT NULL,
  "description" TEXT NOT NULL,
  "referenceType" TEXT,
  "referenceId" UUID,
  "totalAmount" DECIMAL(18,2) NOT NULL,
  "currency" TEXT NOT NULL,
  "baseCurrency" TEXT NOT NULL,
  "baseCurrencyAmount" DECIMAL(18,2) NOT NULL,
  "fxRateSnapshotId" UUID,
  "metadata" JSONB,
  "createdById" UUID,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "LedgerTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LedgerEntry" (
  "id" UUID NOT NULL,
  "transactionId" UUID NOT NULL,
  "accountId" UUID NOT NULL,
  "direction" "LedgerEntryDirection" NOT NULL,
  "amount" DECIMAL(18,2) NOT NULL,
  "balanceAfter" DECIMAL(18,2) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "LedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LedgerAccount_code_key" ON "LedgerAccount"("code");

-- CreateIndex
CREATE INDEX "LedgerAccount_entityType_entityId_idx" ON "LedgerAccount"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "LedgerAccount_type_subType_idx" ON "LedgerAccount"("type", "subType");

-- CreateIndex
CREATE UNIQUE INDEX "LedgerTransaction_idempotencyKey_key" ON "LedgerTransaction"("idempotencyKey");

-- CreateIndex
CREATE INDEX "LedgerTransaction_type_createdAt_idx" ON "LedgerTransaction"("type", "createdAt");

-- CreateIndex
CREATE INDEX "LedgerTransaction_referenceType_referenceId_idx" ON "LedgerTransaction"("referenceType", "referenceId");

-- CreateIndex
CREATE INDEX "LedgerEntry_transactionId_idx" ON "LedgerEntry"("transactionId");

-- CreateIndex
CREATE INDEX "LedgerEntry_accountId_createdAt_idx" ON "LedgerEntry"("accountId", "createdAt");

-- AddForeignKey
ALTER TABLE "LedgerAccount"
ADD CONSTRAINT "LedgerAccount_parentAccountId_fkey"
FOREIGN KEY ("parentAccountId") REFERENCES "LedgerAccount"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerTransaction"
ADD CONSTRAINT "LedgerTransaction_fxRateSnapshotId_fkey"
FOREIGN KEY ("fxRateSnapshotId") REFERENCES "ExchangeRateSnapshot"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerTransaction"
ADD CONSTRAINT "LedgerTransaction_createdById_fkey"
FOREIGN KEY ("createdById") REFERENCES "User"("_id")
ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEntry"
ADD CONSTRAINT "LedgerEntry_transactionId_fkey"
FOREIGN KEY ("transactionId") REFERENCES "LedgerTransaction"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEntry"
ADD CONSTRAINT "LedgerEntry_accountId_fkey"
FOREIGN KEY ("accountId") REFERENCES "LedgerAccount"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;
