-- Add tags array column to collections for market filtering
ALTER TABLE "Collection"
ADD COLUMN "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

