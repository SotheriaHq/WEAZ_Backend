BEGIN;

-- Lifecycle-based read-only custom-order conversations stay writable under
-- the approved queue policy. Explicit moderation/retention closures remain.
UPDATE "MessageThread" thread
SET "status" = 'OPEN', "readOnlyAt" = NULL, "updatedAt" = CURRENT_TIMESTAMP
WHERE thread."status" = 'READ_ONLY' AND thread."archivedAt" IS NULL AND (
  thread."contextType" = 'CUSTOM_ORDER' OR thread."customOrderId" IS NOT NULL OR EXISTS (
    SELECT 1 FROM "MessageThreadOrderLink" link
    WHERE link."threadId" = thread."id" AND link."customOrderId" IS NOT NULL
  )
);

-- Prisma supplies @updatedAt values. Match that schema without changing data.
ALTER TABLE "BrandSubscription" ALTER COLUMN "updatedAt" DROP DEFAULT;
ALTER TABLE "CapacityCampaign" ALTER COLUMN "updatedAt" DROP DEFAULT;
ALTER TABLE "RunwayBrandNotice" ALTER COLUMN "updatedAt" DROP DEFAULT;
ALTER TABLE "SubscriptionTier" ALTER COLUMN "updatedAt" DROP DEFAULT;

COMMIT;
