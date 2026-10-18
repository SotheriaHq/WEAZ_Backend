-- Custom-order subscription queue.
--
-- Adds the lane a paid custom order sits in, the brand subscription that caps
-- Active and In Delivery seats, the placement-capture ledger type, and the
-- Runway notice a brand sees during a seasonal bonus or free-order period.
--
-- Existing orders are backfilled from their production status so a brand who
-- is already making a piece stays Active. Completed and cancelled rows become
-- Terminal and free the seat. The column is nullable until that backfill
-- finishes, then it is required. New inserts default to PENDING.

CREATE TYPE "CustomOrderLane" AS ENUM (
  'PENDING',
  'UP_NEXT',
  'ACTIVE',
  'IN_DELIVERY',
  'TERMINAL'
);

CREATE TYPE "SubscriptionTierKey" AS ENUM (
  'THREAD',
  'ASO_OKE',
  'ARU',
  'IGWE',
  'LEGACY'
);

CREATE TYPE "BrandSubscriptionStatus" AS ENUM (
  'ACTIVE',
  'PAST_DUE',
  'CANCELLED'
);

CREATE TYPE "CapacityCampaignResetMode" AS ENUM (
  'AUTOMATIC',
  'MANUAL'
);

CREATE TYPE "RunwayBrandNoticeKind" AS ENUM (
  'BONUS',
  'FREE_ORDER_PERIOD',
  'GENERAL'
);

-- Recreate the allocation enum so the new values can be used later in this
-- same migration. PostgreSQL will not accept a value added with ADD VALUE
-- until the transaction commits.
ALTER TYPE "CustomOrderLedgerAllocationType" RENAME TO "CustomOrderLedgerAllocationType_old";

CREATE TYPE "CustomOrderLedgerAllocationType" AS ENUM (
  'BRAND_ACCEPTANCE_PORTION',
  'FINAL_COMPLETION_PORTION',
  'PLACEMENT_CAPTURE',
  'JUMP_FEE'
);

ALTER TABLE "CustomOrderLedgerAllocation"
  ALTER COLUMN "allocationType" TYPE "CustomOrderLedgerAllocationType"
  USING ("allocationType"::text::"CustomOrderLedgerAllocationType");

DROP TYPE "CustomOrderLedgerAllocationType_old";

ALTER TABLE "Brand"
  ADD COLUMN "customOrderIntakeBlockedAt" TIMESTAMP(3),
  ADD COLUMN "customOrderIntakeBlockedById" UUID,
  ADD COLUMN "customOrderIntakeBlockReason" TEXT,
  ADD COLUMN "queueJumpEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "activeOrderCapOverride" INTEGER,
  ADD COLUMN "massCancelAttentionAt" TIMESTAMP(3),
  ADD COLUMN "massCancelAttentionReason" TEXT;

ALTER TABLE "CustomOrder"
  ADD COLUMN "lane" "CustomOrderLane",
  ADD COLUMN "queuePosition" INTEGER,
  ADD COLUMN "queuedAt" TIMESTAMP(3),
  ADD COLUMN "queueExpiresAt" TIMESTAMP(3),
  ADD COLUMN "retainCount" INTEGER NOT NULL DEFAULT 0;

UPDATE "CustomOrder"
SET "lane" = CASE
  WHEN "status" IN ('ACCEPTED', 'IN_PRODUCTION', 'READY_FOR_DISPATCH', 'DISPUTED', 'DELIVERY_ISSUE_REPORTED') THEN 'ACTIVE'::"CustomOrderLane"
  WHEN "status" IN ('IN_TRANSIT', 'DELIVERED_PENDING_BUYER_CONFIRMATION') THEN 'IN_DELIVERY'::"CustomOrderLane"
  WHEN "status" IN ('PENDING_PAYMENT', 'PENDING_BRAND_ACCEPTANCE', 'DRAFT') THEN 'PENDING'::"CustomOrderLane"
  ELSE 'TERMINAL'::"CustomOrderLane"
END
WHERE "lane" IS NULL;

ALTER TABLE "CustomOrder" ALTER COLUMN "lane" SET NOT NULL;
ALTER TABLE "CustomOrder" ALTER COLUMN "lane" SET DEFAULT 'PENDING';

CREATE INDEX "CustomOrder_brandId_lane_queuePosition_idx"
  ON "CustomOrder" ("brandId", "lane", "queuePosition");

CREATE INDEX "CustomOrder_lane_queueExpiresAt_idx"
  ON "CustomOrder" ("lane", "queueExpiresAt");

CREATE TABLE "SubscriptionTier" (
  "key" "SubscriptionTierKey" NOT NULL,
  "name" TEXT NOT NULL,
  "monthlyPriceNgn" INTEGER NOT NULL,
  "maxActive" INTEGER NOT NULL,
  "maxInDelivery" INTEGER NOT NULL,
  "maxUpNext" INTEGER NOT NULL DEFAULT 1,
  "queueJumpAllowed" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SubscriptionTier_pkey" PRIMARY KEY ("key")
);

INSERT INTO "SubscriptionTier"
  ("key", "name", "monthlyPriceNgn", "maxActive", "maxInDelivery", "maxUpNext", "queueJumpAllowed")
VALUES
  ('THREAD', 'Thread', 10000, 2, 2, 1, true),
  ('ASO_OKE', 'Aso-oke', 15000, 3, 4, 1, true),
  ('ARU', 'Aru', 30000, 4, 5, 1, true),
  ('IGWE', 'Igwe', 50000, 6, 5, 1, true),
  ('LEGACY', 'Legacy', 0, 1000000, 1000000, 1, true);

CREATE TABLE "BrandSubscription" (
  "id" UUID NOT NULL,
  "brandId" UUID NOT NULL,
  "tierKey" "SubscriptionTierKey" NOT NULL,
  "priceSnapshotNgn" INTEGER NOT NULL,
  "status" "BrandSubscriptionStatus" NOT NULL DEFAULT 'ACTIVE',
  "currentPeriodStart" TIMESTAMP(3) NOT NULL,
  "currentPeriodEnd" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BrandSubscription_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "BrandSubscription_brandId_status_idx" ON "BrandSubscription" ("brandId", "status");
CREATE INDEX "BrandSubscription_tierKey_idx" ON "BrandSubscription" ("tierKey");

ALTER TABLE "BrandSubscription"
  ADD CONSTRAINT "BrandSubscription_brandId_fkey"
  FOREIGN KEY ("brandId") REFERENCES "Brand"("_id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "BrandSubscription"
  ADD CONSTRAINT "BrandSubscription_tierKey_fkey"
  FOREIGN KEY ("tierKey") REFERENCES "SubscriptionTier"("key") ON DELETE RESTRICT ON UPDATE CASCADE;

-- One open subscription per brand. Cancelled and past-due rows stay as history.
CREATE UNIQUE INDEX "BrandSubscription_one_active_per_brand"
  ON "BrandSubscription" ("brandId")
  WHERE "status" = 'ACTIVE';

CREATE TABLE "CapacityCampaign" (
  "id" UUID NOT NULL,
  "deltaActive" INTEGER NOT NULL,
  "startsAt" TIMESTAMP(3) NOT NULL,
  "endsAt" TIMESTAMP(3) NOT NULL,
  "resetMode" "CapacityCampaignResetMode" NOT NULL,
  "resetAt" TIMESTAMP(3),
  "createdById" UUID NOT NULL,
  "note" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CapacityCampaign_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CapacityCampaign_startsAt_endsAt_idx" ON "CapacityCampaign" ("startsAt", "endsAt");

CREATE TABLE "RunwayBrandNotice" (
  "id" UUID NOT NULL,
  "title" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "kind" "RunwayBrandNoticeKind" NOT NULL,
  "startsAt" TIMESTAMP(3) NOT NULL,
  "endsAt" TIMESTAMP(3) NOT NULL,
  "publishedAt" TIMESTAMP(3),
  "endedAt" TIMESTAMP(3),
  "createdById" UUID NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RunwayBrandNotice_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "RunwayBrandNotice_publishedAt_startsAt_endsAt_idx"
  ON "RunwayBrandNotice" ("publishedAt", "startsAt", "endsAt");
