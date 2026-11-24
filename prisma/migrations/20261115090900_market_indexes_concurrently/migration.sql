-- Intentionally no transaction wrapper: PostgreSQL concurrent builds cannot run
-- inside BEGIN/COMMIT. Existing FTS/trigram and variant-stock indexes are reused.
SET lock_timeout = '5s';
SET statement_timeout = '10min';

CREATE INDEX CONCURRENTLY "Product_market_first_publication_idx"
  ON "Product" ("firstPublishedAt" DESC, "_id" DESC)
  WHERE "isActive" AND "publicationStatus"='PUBLISHED'
    AND "deletedAt" IS NULL AND "archivedAt" IS NULL;

CREATE INDEX CONCURRENTLY "Product_market_effective_price_idx"
  ON "Product" ("effectivePrice", "_id")
  WHERE "isActive" AND "publicationStatus"='PUBLISHED'
    AND "deletedAt" IS NULL AND "archivedAt" IS NULL;

CREATE INDEX CONCURRENTLY "Product_market_category_publication_idx"
  ON "Product" ("categoryId", "firstPublishedAt" DESC, "_id" DESC)
  WHERE "isActive" AND "publicationStatus"='PUBLISHED'
    AND "deletedAt" IS NULL AND "archivedAt" IS NULL;

CREATE INDEX CONCURRENTLY "Product_market_brand_publication_idx"
  ON "Product" ("brandId", "firstPublishedAt" DESC, "_id" DESC)
  WHERE "isActive" AND "publicationStatus"='PUBLISHED'
    AND "deletedAt" IS NULL AND "archivedAt" IS NULL;

CREATE INDEX CONCURRENTLY "Product_market_tags_idx" ON "Product" USING GIN (tags);

-- Include products leaving the old price/filter/eligibility bounds: narrowing
-- this fence to the current result would miss a moved or unpublished member.
CREATE INDEX CONCURRENTLY "Product_market_price_change_idx"
  ON "Product" ("priceChangeXid", "_id");

CREATE INDEX CONCURRENTLY "Product_market_price_boundary_idx"
  ON "Product" ("effectivePriceValidUntil", "_id")
  WHERE "effectivePriceValidUntil" IS NOT NULL;

-- Mixed price-descending/UUID-ascending order cannot use a reversed scan of
-- the ascending index without sorting equal-price groups.
CREATE INDEX CONCURRENTLY "Product_market_effective_price_desc_idx"
  ON "Product" ("effectivePrice" DESC, "_id" ASC)
  WHERE "isActive" AND "publicationStatus"='PUBLISHED'
    AND "deletedAt" IS NULL AND "archivedAt" IS NULL;

-- Bounds the anomalous-cache branch after a backwards database clock change.
CREATE INDEX CONCURRENTLY "Product_market_price_computed_idx"
  ON "Product" ("effectivePriceComputedAt", "_id");

-- Age-ordered privacy deletion: the every-minute sweep reads only the expired
-- prefix instead of scanning and sorting each identity table. user_feed_signals
-- already has the equivalent index.
CREATE INDEX CONCURRENTLY "user_seen_items_createdAt__id_idx"
  ON "user_seen_items" ("createdAt", "_id");

CREATE INDEX CONCURRENTLY "market_section_signals_createdAt__id_idx"
  ON "market_section_signals" ("createdAt", "_id");

CREATE INDEX CONCURRENTLY "suggestion_signals_createdAt__id_idx"
  ON "suggestion_signals" ("createdAt", "_id");

CREATE INDEX CONCURRENTLY "market_signal_batch_receipts_createdAt__id_idx"
  ON "market_signal_batch_receipts" ("createdAt", "_id");

RESET statement_timeout;
RESET lock_timeout;
