ALTER TABLE "user_feed_signals" ADD COLUMN "clientEventId" VARCHAR(128);
ALTER TABLE "user_seen_items" ADD COLUMN "clientEventId" VARCHAR(128);
ALTER TABLE "market_section_signals" ADD COLUMN "clientEventId" VARCHAR(128);
ALTER TABLE "suggestion_signals" ADD COLUMN "clientEventId" VARCHAR(128);

CREATE TABLE "market_signal_batch_receipts" (
  "_id" UUID NOT NULL,
  "userId" UUID,
  "anonymousSessionId" VARCHAR(128),
  "batchId" VARCHAR(128) NOT NULL,
  "received" INTEGER NOT NULL DEFAULT 0,
  "persisted" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "market_signal_batch_receipts_pkey" PRIMARY KEY ("_id")
);

CREATE TABLE "market_signal_aggregate_daily" (
  "_id" UUID NOT NULL,
  "aggregateKey" VARCHAR(320) NOT NULL,
  "bucketDate" TIMESTAMP(3) NOT NULL,
  "userId" UUID,
  "anonymousSessionId" VARCHAR(128),
  "surface" "MarketSignalSurface",
  "sectionKey" VARCHAR(80),
  "suggestionBlockKey" VARCHAR(80),
  "targetType" "MarketSignalTargetType",
  "targetId" VARCHAR(128),
  "sectionImpressions" INTEGER NOT NULL DEFAULT 0,
  "itemImpressions" INTEGER NOT NULL DEFAULT 0,
  "productOpens" INTEGER NOT NULL DEFAULT 0,
  "itemOpens" INTEGER NOT NULL DEFAULT 0,
  "clicks" INTEGER NOT NULL DEFAULT 0,
  "viewAllClicks" INTEGER NOT NULL DEFAULT 0,
  "suppressions" INTEGER NOT NULL DEFAULT 0,
  "seenItems" INTEGER NOT NULL DEFAULT 0,
  "eventCount" INTEGER NOT NULL DEFAULT 0,
  "latestSeenAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "market_signal_aggregate_daily_pkey" PRIMARY KEY ("_id")
);

CREATE INDEX "user_feed_signals_userId_clientEventId_idx"
ON "user_feed_signals"("userId", "clientEventId");

CREATE INDEX "user_feed_signals_anon_clientEventId_idx"
ON "user_feed_signals"("anonymousSessionId", "clientEventId");

CREATE INDEX "user_feed_signals_clientEventId_createdAt_idx"
ON "user_feed_signals"("clientEventId", "createdAt");

CREATE INDEX "user_seen_items_userId_clientEventId_idx"
ON "user_seen_items"("userId", "clientEventId");

CREATE INDEX "user_seen_items_anon_clientEventId_idx"
ON "user_seen_items"("anonymousSessionId", "clientEventId");

CREATE INDEX "user_seen_items_clientEventId_createdAt_idx"
ON "user_seen_items"("clientEventId", "createdAt");

CREATE INDEX "market_section_signals_userId_clientEventId_idx"
ON "market_section_signals"("userId", "clientEventId");

CREATE INDEX "market_section_signals_anon_clientEventId_idx"
ON "market_section_signals"("anonymousSessionId", "clientEventId");

CREATE INDEX "market_section_signals_clientEventId_createdAt_idx"
ON "market_section_signals"("clientEventId", "createdAt");

CREATE INDEX "suggestion_signals_userId_clientEventId_idx"
ON "suggestion_signals"("userId", "clientEventId");

CREATE INDEX "suggestion_signals_anon_clientEventId_idx"
ON "suggestion_signals"("anonymousSessionId", "clientEventId");

CREATE INDEX "suggestion_signals_clientEventId_createdAt_idx"
ON "suggestion_signals"("clientEventId", "createdAt");

CREATE UNIQUE INDEX "market_signal_batch_receipts_userId_batchId_key"
ON "market_signal_batch_receipts"("userId", "batchId");

CREATE UNIQUE INDEX "market_signal_batch_receipts_anon_batchId_key"
ON "market_signal_batch_receipts"("anonymousSessionId", "batchId");

CREATE INDEX "market_signal_batch_receipts_userId_createdAt_idx"
ON "market_signal_batch_receipts"("userId", "createdAt");

CREATE INDEX "market_signal_batch_receipts_anon_createdAt_idx"
ON "market_signal_batch_receipts"("anonymousSessionId", "createdAt");

CREATE UNIQUE INDEX "market_signal_aggregate_daily_aggregateKey_key"
ON "market_signal_aggregate_daily"("aggregateKey");

CREATE INDEX "market_signal_aggregate_daily_bucketDate_idx"
ON "market_signal_aggregate_daily"("bucketDate");

CREATE INDEX "market_signal_aggregate_daily_sectionKey_bucketDate_idx"
ON "market_signal_aggregate_daily"("sectionKey", "bucketDate");

CREATE INDEX "market_signal_aggregate_daily_blockKey_bucketDate_idx"
ON "market_signal_aggregate_daily"("suggestionBlockKey", "bucketDate");

CREATE INDEX "market_signal_aggregate_daily_target_bucketDate_idx"
ON "market_signal_aggregate_daily"("targetType", "targetId", "bucketDate");

CREATE INDEX "market_signal_aggregate_daily_userId_bucketDate_idx"
ON "market_signal_aggregate_daily"("userId", "bucketDate");

CREATE INDEX "market_signal_aggregate_daily_anon_bucketDate_idx"
ON "market_signal_aggregate_daily"("anonymousSessionId", "bucketDate");
