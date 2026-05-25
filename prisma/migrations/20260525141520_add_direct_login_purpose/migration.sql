-- AlterEnum
ALTER TYPE "LoginCodePurpose" ADD VALUE 'DIRECT_LOGIN';

-- RenameIndex
ALTER INDEX "UserSizeRecommendationSnapshot_userId_garmentCategory_generated" RENAME TO "UserSizeRecommendationSnapshot_userId_garmentCategory_gener_idx";

-- RenameIndex
ALTER INDEX "market_section_signals_anon_clientEventId_idx" RENAME TO "market_section_signals_anonymousSessionId_clientEventId_idx";

-- RenameIndex
ALTER INDEX "market_signal_aggregate_daily_anon_bucketDate_idx" RENAME TO "market_signal_aggregate_daily_anonymousSessionId_bucketDate_idx";

-- RenameIndex
ALTER INDEX "market_signal_aggregate_daily_blockKey_bucketDate_idx" RENAME TO "market_signal_aggregate_daily_suggestionBlockKey_bucketDate_idx";

-- RenameIndex
ALTER INDEX "market_signal_aggregate_daily_target_bucketDate_idx" RENAME TO "market_signal_aggregate_daily_targetType_targetId_bucketDat_idx";

-- RenameIndex
ALTER INDEX "market_signal_batch_receipts_anon_batchId_key" RENAME TO "market_signal_batch_receipts_anonymousSessionId_batchId_key";

-- RenameIndex
ALTER INDEX "market_signal_batch_receipts_anon_createdAt_idx" RENAME TO "market_signal_batch_receipts_anonymousSessionId_createdAt_idx";

-- RenameIndex
ALTER INDEX "suggestion_signals_anon_clientEventId_idx" RENAME TO "suggestion_signals_anonymousSessionId_clientEventId_idx";

-- RenameIndex
ALTER INDEX "user_feed_signals_anon_clientEventId_idx" RENAME TO "user_feed_signals_anonymousSessionId_clientEventId_idx";

-- RenameIndex
ALTER INDEX "user_seen_items_anon_clientEventId_idx" RENAME TO "user_seen_items_anonymousSessionId_clientEventId_idx";
