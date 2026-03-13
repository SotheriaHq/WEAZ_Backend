DO $$ BEGIN
    CREATE TYPE "CustomOrderRetentionHoldType" AS ENUM ('LEGAL', 'SUPPORT');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

ALTER TABLE "CustomOrder"
ADD COLUMN "retentionHoldType" "CustomOrderRetentionHoldType",
ADD COLUMN "retentionHoldReason" TEXT,
ADD COLUMN "retentionHoldUntil" TIMESTAMP(3),
ADD COLUMN "retentionHoldSetById" UUID,
ADD COLUMN "retentionHoldSetAt" TIMESTAMP(3);

ALTER TABLE "CustomOrderLedgerAllocation"
ADD COLUMN "payoutId" UUID;

CREATE INDEX "CustomOrder_measurementRetentionUntil_retentionHoldUntil_anonym_idx"
ON "CustomOrder"("measurementRetentionUntil", "retentionHoldUntil", "anonymizedAt");

CREATE INDEX "CustomOrderLedgerAllocation_payoutId_idx"
ON "CustomOrderLedgerAllocation"("payoutId");

ALTER TABLE "CustomOrderLedgerAllocation"
ADD CONSTRAINT "CustomOrderLedgerAllocation_payoutId_fkey"
FOREIGN KEY ("payoutId") REFERENCES "Payout"("_id") ON DELETE SET NULL ON UPDATE CASCADE;
