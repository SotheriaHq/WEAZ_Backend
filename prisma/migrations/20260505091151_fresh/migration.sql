-- AlterTable
ALTER TABLE "MessageThreadOrderLink" ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "updatedAt" DROP DEFAULT;

-- RenameIndex
ALTER INDEX "settlement_policy_orderType_scope_brandId_currency_isActive_eff" RENAME TO "settlement_policy_orderType_scope_brandId_currency_isActive_idx";
