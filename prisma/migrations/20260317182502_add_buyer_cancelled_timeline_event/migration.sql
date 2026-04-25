-- AlterEnum
ALTER TYPE "CustomOrderTimelineEventType" ADD VALUE 'BUYER_CANCELLED';

-- RenameIndex
ALTER INDEX "CustomOrderCheckoutIntent_configurationId_configurationVersionI" RENAME TO "CustomOrderCheckoutIntent_configurationId_configurationVers_idx";
