CREATE TYPE "StandardOrderReleaseStage" AS ENUM ('SHIPMENT_PORTION', 'FINAL_PORTION');

CREATE TABLE "PayoutLedgerSourceAllocation" (
    "id" UUID NOT NULL,
    "payoutId" UUID NOT NULL,
    "ledgerEntryId" UUID NOT NULL,
    "escrowHoldId" UUID,
    "releaseStage" "StandardOrderReleaseStage",
    "amount" DECIMAL(10,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'NGN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PayoutLedgerSourceAllocation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PayoutLedgerSourceAllocation_payoutId_ledgerEntryId_key" ON "PayoutLedgerSourceAllocation"("payoutId", "ledgerEntryId");
CREATE INDEX "PayoutLedgerSourceAllocation_payoutId_idx" ON "PayoutLedgerSourceAllocation"("payoutId");
CREATE INDEX "PayoutLedgerSourceAllocation_ledgerEntryId_idx" ON "PayoutLedgerSourceAllocation"("ledgerEntryId");
CREATE INDEX "PayoutLedgerSourceAllocation_escrowHoldId_releaseStage_idx" ON "PayoutLedgerSourceAllocation"("escrowHoldId", "releaseStage");

ALTER TABLE "PayoutLedgerSourceAllocation"
ADD CONSTRAINT "PayoutLedgerSourceAllocation_payoutId_fkey"
FOREIGN KEY ("payoutId") REFERENCES "Payout"("_id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PayoutLedgerSourceAllocation"
ADD CONSTRAINT "PayoutLedgerSourceAllocation_ledgerEntryId_fkey"
FOREIGN KEY ("ledgerEntryId") REFERENCES "LedgerEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PayoutLedgerSourceAllocation"
ADD CONSTRAINT "PayoutLedgerSourceAllocation_escrowHoldId_fkey"
FOREIGN KEY ("escrowHoldId") REFERENCES "EscrowHold"("id") ON DELETE SET NULL ON UPDATE CASCADE;
