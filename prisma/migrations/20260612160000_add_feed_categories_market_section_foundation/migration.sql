-- Phase 2 feed/market foundation.
-- Adds DB-driven feed categories and fills the missing market-section config fields
-- without removing the existing admin market-governance table.

ALTER TYPE "MarketSignalType" ADD VALUE IF NOT EXISTS 'SECTION_VIEW';
ALTER TYPE "MarketSignalType" ADD VALUE IF NOT EXISTS 'SECTION_VIEW_ALL_CLICK';
ALTER TYPE "MarketSignalType" ADD VALUE IF NOT EXISTS 'ITEM_IMPRESSION';
ALTER TYPE "MarketSignalType" ADD VALUE IF NOT EXISTS 'ITEM_VIEW';
ALTER TYPE "MarketSignalType" ADD VALUE IF NOT EXISTS 'ITEM_CLICK';

CREATE TYPE "FeedCategorySurface" AS ENUM ('DESIGN_FEED', 'MARKET_HOME');
CREATE TYPE "FeedCategoryStatus" AS ENUM ('DRAFT', 'ACTIVE', 'PAUSED', 'ARCHIVED');
CREATE TYPE "MarketSectionConfigStatus" AS ENUM ('DRAFT', 'ACTIVE', 'PAUSED', 'ARCHIVED');
CREATE TYPE "MarketSectionConfigSourceType" AS ENUM ('PRODUCT', 'COLLECTION', 'DESIGN', 'BRAND', 'MIXED');

CREATE TABLE "FeedCategory" (
    "_id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "key" VARCHAR(80) NOT NULL,
    "label" VARCHAR(120) NOT NULL,
    "description" VARCHAR(240),
    "surface" "FeedCategorySurface" NOT NULL DEFAULT 'DESIGN_FEED',
    "rankingProfileKey" VARCHAR(80),
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "fallbackCategoryKey" VARCHAR(80),
    "requiresAuth" BOOLEAN NOT NULL DEFAULT false,
    "requiresPersonalization" BOOLEAN NOT NULL DEFAULT false,
    "isDefaultForGuest" BOOLEAN NOT NULL DEFAULT false,
    "isDefaultForNewUser" BOOLEAN NOT NULL DEFAULT false,
    "isDefaultForReturningUser" BOOLEAN NOT NULL DEFAULT false,
    "status" "FeedCategoryStatus" NOT NULL DEFAULT 'ACTIVE',
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FeedCategory_pkey" PRIMARY KEY ("_id")
);

CREATE UNIQUE INDEX "FeedCategory_key_key" ON "FeedCategory"("key");
CREATE INDEX "FeedCategory_surface_status_displayOrder_idx" ON "FeedCategory"("surface", "status", "displayOrder");
CREATE INDEX "FeedCategory_status_displayOrder_idx" ON "FeedCategory"("status", "displayOrder");

ALTER TABLE "MarketSectionConfig"
  ADD COLUMN "status" "MarketSectionConfigStatus" NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN "sourceType" "MarketSectionConfigSourceType" NOT NULL DEFAULT 'PRODUCT',
  ADD COLUMN "rankingProfileKey" VARCHAR(80),
  ADD COLUMN "viewAllLabel" VARCHAR(80),
  ADD COLUMN "fallbackSectionKey" VARCHAR(80),
  ADD COLUMN "guestEnabled" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "requiresAuth" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "newBrandReservedRatio" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX "MarketSectionConfig_status_displayOrder_idx" ON "MarketSectionConfig"("status", "displayOrder");

INSERT INTO "FeedCategory" (
  "_id", "key", "label", "description", "surface", "rankingProfileKey",
  "displayOrder", "fallbackCategoryKey", "requiresAuth",
  "requiresPersonalization", "isDefaultForGuest", "isDefaultForNewUser",
  "isDefaultForReturningUser", "status", "metadata"
)
VALUES
  (gen_random_uuid(), 'discover', 'Discover', 'Broad runway/design discovery for authenticated new users.', 'DESIGN_FEED', 'deterministic-v1', 10, 'explore', false, false, false, true, false, 'ACTIVE', '{"phase":"phase2-foundation"}'::jsonb),
  (gen_random_uuid(), 'explore', 'Explore', 'Guest-safe broad design exploration.', 'DESIGN_FEED', 'deterministic-v1', 20, 'discover', false, false, true, false, true, 'ACTIVE', '{"phase":"phase2-foundation"}'::jsonb),
  (gen_random_uuid(), 'for-you', 'For You', 'Reserved personalization category; deterministic fallback until ranking ships.', 'DESIGN_FEED', 'deterministic-v1', 30, 'discover', true, true, false, false, false, 'ACTIVE', '{"phase":"phase2-foundation","personalizationReady":false}'::jsonb),
  (gen_random_uuid(), 'african-style', 'African Style', 'African fashion inspiration lane backed by deterministic feed filtering later.', 'DESIGN_FEED', 'deterministic-v1', 40, 'explore', false, false, false, false, false, 'ACTIVE', '{"phase":"phase2-foundation"}'::jsonb),
  (gen_random_uuid(), 'casual-style', 'Casual Style', 'Casual fashion inspiration lane backed by deterministic feed filtering later.', 'DESIGN_FEED', 'deterministic-v1', 50, 'explore', false, false, false, false, false, 'ACTIVE', '{"phase":"phase2-foundation"}'::jsonb)
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "MarketSectionConfig" (
  "_id", "sectionKey", "title", "subtitle", "enabled", "status", "sourceType",
  "rankingProfileKey", "displayOrder", "previewItemLimit", "detailPageLimit",
  "minimumItems", "viewAllEnabled", "viewAllLabel", "fallbackMode",
  "fallbackSectionKey", "guestEnabled", "requiresAuth", "newBrandReservedRatio",
  "metadata", "createdAt", "updatedAt"
)
VALUES
  (gen_random_uuid(), 'hot-right-now', 'Hot Right Now', 'Deterministic V1 heat from product views and thread activity.', true, 'ACTIVE', 'PRODUCT', 'deterministic-v1', 10, 8, 24, 1, true, 'See What''s Hot', 'CODE_DEFAULTS', 'fresh-drops', true, false, 0, '{"phase":"phase2-foundation"}'::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'fresh-drops', 'Fresh Drops', 'New products from open WEAZ stores.', true, 'ACTIVE', 'PRODUCT', 'deterministic-v1', 20, 8, 24, 1, true, 'View All Drops', 'CODE_DEFAULTS', 'hot-right-now', true, false, 0, '{"phase":"phase2-foundation"}'::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'picked-for-you', 'Picked For You', 'Deterministic starter picks until full personalization ships.', true, 'ACTIVE', 'PRODUCT', 'deterministic-v1', 30, 8, 24, 1, true, 'View All Picks', 'CODE_DEFAULTS', 'fresh-drops', true, false, 0, '{"phase":"phase2-foundation","personalizationReady":false}'::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'new-designers-to-watch', 'New Designers to Watch', 'Newer open stores with market-ready products.', true, 'ACTIVE', 'BRAND', 'deterministic-v1', 40, 6, 24, 1, true, 'Meet More Designers', 'CODE_DEFAULTS', 'fresh-drops', true, false, 20, '{"phase":"phase2-foundation"}'::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'shop-by-style', 'Shop by Style', 'Browse active market categories without making Market category-only.', true, 'ACTIVE', 'MIXED', 'deterministic-v1', 50, 10, 24, 1, true, 'Explore Styles', 'CODE_DEFAULTS', 'fresh-drops', true, false, 0, '{"phase":"phase2-foundation"}'::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'loved-near-you', 'Loved Near You', 'Location-aware ranking is deferred; using market heat for now.', true, 'ACTIVE', 'PRODUCT', 'deterministic-v1', 60, 8, 24, 1, true, 'View Loved Pieces', 'CODE_DEFAULTS', 'hot-right-now', true, false, 0, '{"phase":"phase2-foundation","locationRankingReady":false}'::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'shop-the-look', 'Shop the Look', 'Recently published store collections with visible products.', true, 'ACTIVE', 'COLLECTION', 'deterministic-v1', 70, 6, 24, 1, true, 'View All Looks', 'CODE_DEFAULTS', 'fresh-drops', true, false, 0, '{"phase":"phase2-foundation"}'::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'almost-gone', 'Almost Gone', 'Low-stock products from open WEAZ stores.', true, 'ACTIVE', 'PRODUCT', 'deterministic-v1', 80, 8, 24, 1, true, 'View Almost Gone', 'CODE_DEFAULTS', 'fresh-drops', true, false, 0, '{"phase":"phase2-foundation"}'::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'still-thinking-about-these', 'Still Thinking About These', 'Non-personalized revisit candidates until history ranking ships.', true, 'ACTIVE', 'PRODUCT', 'deterministic-v1', 90, 8, 24, 1, true, 'View More', 'CODE_DEFAULTS', 'fresh-drops', true, false, 0, '{"phase":"phase2-foundation","historyRankingReady":false}'::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'more-from-brands-you-like', 'More From Brands You Like', 'Brand-affinity ranking is deferred; using fresh products for now.', true, 'ACTIVE', 'PRODUCT', 'deterministic-v1', 100, 8, 24, 1, true, 'View More From Brands', 'CODE_DEFAULTS', 'fresh-drops', true, false, 0, '{"phase":"phase2-foundation","brandAffinityReady":false}'::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'style-picks-of-the-week', 'Style Picks of the Week', 'Curated-style rail backed by deterministic fresh products.', true, 'ACTIVE', 'PRODUCT', 'deterministic-v1', 110, 8, 24, 1, true, 'View Weekly Picks', 'CODE_DEFAULTS', 'fresh-drops', true, false, 0, '{"phase":"phase2-foundation"}'::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("sectionKey") DO NOTHING;

UPDATE "MarketSectionConfig"
SET
  "viewAllLabel" = COALESCE("viewAllLabel", CASE "sectionKey"
    WHEN 'hot-right-now' THEN 'See What''s Hot'
    WHEN 'fresh-drops' THEN 'View All Drops'
    WHEN 'new-designers-to-watch' THEN 'Meet More Designers'
    WHEN 'shop-by-style' THEN 'Explore Styles'
    ELSE 'View All'
  END),
  "fallbackSectionKey" = COALESCE("fallbackSectionKey", 'fresh-drops'),
  "rankingProfileKey" = COALESCE("rankingProfileKey", 'deterministic-v1');
