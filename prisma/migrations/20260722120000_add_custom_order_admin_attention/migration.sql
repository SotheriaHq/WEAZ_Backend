-- Persistent "needs admin attention" flag on custom orders.
-- Set by the ops cron when an admin-review is triggered; cleared by any admin action.
ALTER TABLE "CustomOrder"
  ADD COLUMN "adminAttentionRequiredAt" TIMESTAMP(3),
  ADD COLUMN "adminAttentionReason" TEXT,
  ADD COLUMN "adminAttentionClearedAt" TIMESTAMP(3),
  ADD COLUMN "adminAttentionClearedById" UUID;

-- Cheap indexed count for the admin dashboard flag + attention-only table filter.
CREATE INDEX "CustomOrder_adminAttentionRequiredAt_idx"
  ON "CustomOrder"("adminAttentionRequiredAt");
