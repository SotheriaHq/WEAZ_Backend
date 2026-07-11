-- Durable "published at least once" marker for the store setup state machine.
-- Studio access must key on an explicit Publish action, not data completeness.
ALTER TABLE "Brand" ADD COLUMN "storePublishedAt" TIMESTAMP(3);

-- Backfill: every store that is currently open was necessarily published.
UPDATE "Brand" SET "storePublishedAt" = CURRENT_TIMESTAMP WHERE "isStoreOpen" = true;
