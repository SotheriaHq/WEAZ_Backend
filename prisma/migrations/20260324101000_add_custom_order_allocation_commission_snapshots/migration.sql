-- AlterTable
ALTER TABLE "CustomOrderLedgerAllocation"
ADD COLUMN "commissionRate" DECIMAL(5,2) NOT NULL DEFAULT 0,
ADD COLUMN "commissionAmount" DECIMAL(10,2) NOT NULL DEFAULT 0,
ADD COLUMN "netBrandAmount" DECIMAL(10,2) NOT NULL DEFAULT 0;
