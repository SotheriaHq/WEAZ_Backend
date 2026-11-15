BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
-- AlterTable
ALTER TABLE "FeaturedItem" ADD COLUMN     "placementKey" VARCHAR(80) NOT NULL DEFAULT 'HOME_FEATURED',
ADD COLUMN     "position" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "FeaturedItem" ADD CONSTRAINT featured_placement_shape_check CHECK (length(trim("placementKey"))>0 AND position>=0);
-- Existing active-only entity uniqueness is deliberately unchanged.
COMMIT;
