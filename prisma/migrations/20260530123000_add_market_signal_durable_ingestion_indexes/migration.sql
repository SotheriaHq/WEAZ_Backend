-- PROD-12: durable market/feed signal ingestion and bounded ranking reads.
-- These indexes are additive. Partial unique indexes enforce idempotency only
-- when the client supplied a durable event id and an actor scope exists.

CREATE UNIQUE INDEX IF NOT EXISTS "user_feed_signals_user_clientEventId_unique"
  ON "user_feed_signals"("userId", "clientEventId")
  WHERE "userId" IS NOT NULL AND "clientEventId" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "user_feed_signals_anonymousSessionId_clientEventId_unique"
  ON "user_feed_signals"("anonymousSessionId", "clientEventId")
  WHERE "anonymousSessionId" IS NOT NULL AND "clientEventId" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "user_seen_items_user_clientEventId_unique"
  ON "user_seen_items"("userId", "clientEventId")
  WHERE "userId" IS NOT NULL AND "clientEventId" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "user_seen_items_anonymousSessionId_clientEventId_unique"
  ON "user_seen_items"("anonymousSessionId", "clientEventId")
  WHERE "anonymousSessionId" IS NOT NULL AND "clientEventId" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "market_section_signals_user_clientEventId_unique"
  ON "market_section_signals"("userId", "clientEventId")
  WHERE "userId" IS NOT NULL AND "clientEventId" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "market_section_signals_anonymousSessionId_clientEventId_unique"
  ON "market_section_signals"("anonymousSessionId", "clientEventId")
  WHERE "anonymousSessionId" IS NOT NULL AND "clientEventId" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "suggestion_signals_user_clientEventId_unique"
  ON "suggestion_signals"("userId", "clientEventId")
  WHERE "userId" IS NOT NULL AND "clientEventId" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "suggestion_signals_anonymousSessionId_clientEventId_unique"
  ON "suggestion_signals"("anonymousSessionId", "clientEventId")
  WHERE "anonymousSessionId" IS NOT NULL AND "clientEventId" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "user_feed_signals_signalType_createdAt_idx"
  ON "user_feed_signals"("signalType", "createdAt");

CREATE INDEX IF NOT EXISTS "user_feed_signals_createdAt_id_idx"
  ON "user_feed_signals"("createdAt", "_id");

CREATE INDEX IF NOT EXISTS "market_signal_aggregate_daily_global_target_bucket_idx"
  ON "market_signal_aggregate_daily"("targetType", "targetId", "bucketDate")
  WHERE "userId" IS NULL AND "anonymousSessionId" IS NULL;

CREATE INDEX IF NOT EXISTS "market_signal_aggregate_daily_global_section_target_bucket_idx"
  ON "market_signal_aggregate_daily"("sectionKey", "targetType", "targetId", "bucketDate")
  WHERE "userId" IS NULL AND "anonymousSessionId" IS NULL;
