CREATE TYPE "MarketSignalTargetType" AS ENUM (
  'PRODUCT',
  'COLLECTION',
  'DESIGN',
  'BRAND',
  'CATEGORY',
  'SECTION',
  'SUGGESTION_BLOCK'
);

CREATE TYPE "MarketSignalType" AS ENUM (
  'IMPRESSION',
  'VIEW',
  'CLICK',
  'OPEN',
  'VIEW_ALL_CLICK',
  'HIDE',
  'NOT_INTERESTED',
  'DWELL_SHORT',
  'DWELL_MEDIUM',
  'DWELL_LONG',
  'SCROLL_SKIP',
  'LIKE',
  'SAVE',
  'COMMENT',
  'THREAD',
  'SHARE',
  'PROFILE_TAP',
  'PRODUCT_VIEW',
  'ADD_TO_CART',
  'WISHLIST',
  'PURCHASE',
  'MARKET_SECTION_VIEW',
  'MARKET_SECTION_SCROLL',
  'MARKET_SECTION_VIEW_ALL_CLICK',
  'MARKET_SECTION_DETAIL_VIEW',
  'MARKET_SECTION_DETAIL_SCROLL',
  'MARKET_SECTION_DISMISS',
  'MARKET_SECTION_BACK_TO_HOME',
  'SUGGESTION_BLOCK_VIEW',
  'SUGGESTION_ITEM_VIEW',
  'SUGGESTION_ITEM_CLICK',
  'SUGGESTION_ITEM_WISHLIST',
  'SUGGESTION_ITEM_CART_ADD',
  'SUGGESTION_ITEM_HIDE',
  'SUGGESTION_BLOCK_HIDE',
  'SUGGESTION_VIEW_ALL_CLICK'
);

CREATE TYPE "MarketSignalSurface" AS ENUM (
  'MARKET_HOME',
  'MARKET_SECTION_DETAIL',
  'DESIGN_FEED',
  'PRODUCT_DETAIL',
  'COLLECTION_DETAIL',
  'BRAND_DETAIL',
  'SEARCH',
  'SUGGESTION_BLOCK'
);

CREATE TYPE "MarketSuppressionType" AS ENUM (
  'HIDE_ITEM',
  'NOT_INTERESTED',
  'HIDE_BRAND',
  'HIDE_CATEGORY',
  'HIDE_SECTION',
  'HIDE_SUGGESTION_BLOCK',
  'SHOW_LESS'
);

CREATE TYPE "PersonalizationResetType" AS ENUM (
  'FEED',
  'MARKET',
  'SUGGESTIONS',
  'ALL'
);

CREATE TABLE "user_feed_signals" (
  "_id" UUID NOT NULL,
  "userId" UUID,
  "anonymousSessionId" VARCHAR(128),
  "targetType" "MarketSignalTargetType" NOT NULL,
  "targetId" VARCHAR(128) NOT NULL,
  "signalType" "MarketSignalType" NOT NULL,
  "value" DOUBLE PRECISION,
  "sectionKey" VARCHAR(80),
  "suggestionBlockKey" VARCHAR(80),
  "surface" "MarketSignalSurface",
  "screenContext" VARCHAR(120),
  "sessionId" VARCHAR(128),
  "batchId" VARCHAR(128),
  "position" INTEGER,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "user_feed_signals_pkey" PRIMARY KEY ("_id")
);

CREATE TABLE "user_seen_items" (
  "_id" UUID NOT NULL,
  "userId" UUID,
  "anonymousSessionId" VARCHAR(128),
  "targetType" "MarketSignalTargetType" NOT NULL,
  "targetId" VARCHAR(128) NOT NULL,
  "surface" "MarketSignalSurface" NOT NULL,
  "sectionKey" VARCHAR(80),
  "suggestionBlockKey" VARCHAR(80),
  "sessionId" VARCHAR(128),
  "batchId" VARCHAR(128),
  "seenAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "user_seen_items_pkey" PRIMARY KEY ("_id")
);

CREATE TABLE "market_section_signals" (
  "_id" UUID NOT NULL,
  "userId" UUID,
  "anonymousSessionId" VARCHAR(128),
  "sectionKey" VARCHAR(80) NOT NULL,
  "signalType" "MarketSignalType" NOT NULL,
  "value" DOUBLE PRECISION,
  "surface" "MarketSignalSurface",
  "screenContext" VARCHAR(120),
  "sessionId" VARCHAR(128),
  "batchId" VARCHAR(128),
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "market_section_signals_pkey" PRIMARY KEY ("_id")
);

CREATE TABLE "suggestion_signals" (
  "_id" UUID NOT NULL,
  "userId" UUID,
  "anonymousSessionId" VARCHAR(128),
  "blockKey" VARCHAR(80) NOT NULL,
  "targetType" "MarketSignalTargetType",
  "targetId" VARCHAR(128),
  "signalType" "MarketSignalType" NOT NULL,
  "value" DOUBLE PRECISION,
  "surface" "MarketSignalSurface",
  "screenContext" VARCHAR(120),
  "sessionId" VARCHAR(128),
  "batchId" VARCHAR(128),
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "suggestion_signals_pkey" PRIMARY KEY ("_id")
);

CREATE TABLE "user_content_suppressions" (
  "_id" UUID NOT NULL,
  "userId" UUID,
  "anonymousSessionId" VARCHAR(128),
  "targetType" "MarketSignalTargetType" NOT NULL,
  "targetId" VARCHAR(128),
  "brandId" UUID,
  "categoryId" UUID,
  "sectionKey" VARCHAR(80),
  "suggestionBlockKey" VARCHAR(80),
  "suppressionType" "MarketSuppressionType" NOT NULL,
  "reason" VARCHAR(240),
  "expiresAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "user_content_suppressions_pkey" PRIMARY KEY ("_id")
);

CREATE TABLE "personalization_resets" (
  "_id" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "resetAt" TIMESTAMP(3) NOT NULL,
  "resetType" "PersonalizationResetType" NOT NULL,
  "reason" VARCHAR(240),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "personalization_resets_pkey" PRIMARY KEY ("_id")
);

CREATE INDEX "user_feed_signals_userId_createdAt_idx"
ON "user_feed_signals"("userId", "createdAt");

CREATE INDEX "user_feed_signals_anonymousSessionId_createdAt_idx"
ON "user_feed_signals"("anonymousSessionId", "createdAt");

CREATE INDEX "user_feed_signals_targetType_targetId_createdAt_idx"
ON "user_feed_signals"("targetType", "targetId", "createdAt");

CREATE INDEX "user_feed_signals_sectionKey_createdAt_idx"
ON "user_feed_signals"("sectionKey", "createdAt");

CREATE INDEX "user_feed_signals_suggestionBlockKey_createdAt_idx"
ON "user_feed_signals"("suggestionBlockKey", "createdAt");

CREATE INDEX "user_feed_signals_userId_targetType_targetId_idx"
ON "user_feed_signals"("userId", "targetType", "targetId");

CREATE INDEX "user_seen_items_userId_createdAt_idx"
ON "user_seen_items"("userId", "createdAt");

CREATE INDEX "user_seen_items_anonymousSessionId_createdAt_idx"
ON "user_seen_items"("anonymousSessionId", "createdAt");

CREATE INDEX "user_seen_items_targetType_targetId_createdAt_idx"
ON "user_seen_items"("targetType", "targetId", "createdAt");

CREATE INDEX "user_seen_items_sectionKey_createdAt_idx"
ON "user_seen_items"("sectionKey", "createdAt");

CREATE INDEX "user_seen_items_suggestionBlockKey_createdAt_idx"
ON "user_seen_items"("suggestionBlockKey", "createdAt");

CREATE INDEX "user_seen_items_userId_targetType_targetId_idx"
ON "user_seen_items"("userId", "targetType", "targetId");

CREATE INDEX "market_section_signals_userId_createdAt_idx"
ON "market_section_signals"("userId", "createdAt");

CREATE INDEX "market_section_signals_anonymousSessionId_createdAt_idx"
ON "market_section_signals"("anonymousSessionId", "createdAt");

CREATE INDEX "market_section_signals_sectionKey_createdAt_idx"
ON "market_section_signals"("sectionKey", "createdAt");

CREATE INDEX "suggestion_signals_userId_createdAt_idx"
ON "suggestion_signals"("userId", "createdAt");

CREATE INDEX "suggestion_signals_anonymousSessionId_createdAt_idx"
ON "suggestion_signals"("anonymousSessionId", "createdAt");

CREATE INDEX "suggestion_signals_targetType_targetId_createdAt_idx"
ON "suggestion_signals"("targetType", "targetId", "createdAt");

CREATE INDEX "suggestion_signals_blockKey_createdAt_idx"
ON "suggestion_signals"("blockKey", "createdAt");

CREATE INDEX "user_content_suppressions_userId_createdAt_idx"
ON "user_content_suppressions"("userId", "createdAt");

CREATE INDEX "user_content_suppressions_anonymousSessionId_createdAt_idx"
ON "user_content_suppressions"("anonymousSessionId", "createdAt");

CREATE INDEX "user_content_suppressions_targetType_targetId_createdAt_idx"
ON "user_content_suppressions"("targetType", "targetId", "createdAt");

CREATE INDEX "user_content_suppressions_sectionKey_createdAt_idx"
ON "user_content_suppressions"("sectionKey", "createdAt");

CREATE INDEX "user_content_suppressions_suggestionBlockKey_createdAt_idx"
ON "user_content_suppressions"("suggestionBlockKey", "createdAt");

CREATE INDEX "user_content_suppressions_userId_targetType_targetId_idx"
ON "user_content_suppressions"("userId", "targetType", "targetId");

CREATE INDEX "user_content_suppressions_userId_brandId_idx"
ON "user_content_suppressions"("userId", "brandId");

CREATE INDEX "user_content_suppressions_expiresAt_idx"
ON "user_content_suppressions"("expiresAt");

CREATE INDEX "personalization_resets_userId_createdAt_idx"
ON "personalization_resets"("userId", "createdAt");

CREATE INDEX "personalization_resets_userId_resetAt_idx"
ON "personalization_resets"("userId", "resetAt");
