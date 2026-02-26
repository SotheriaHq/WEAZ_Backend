-- Mark auto-created store bucket collections and hide them from user-facing lists
ALTER TABLE "StoreCollection"
  ADD COLUMN IF NOT EXISTS "isSystemGenerated" BOOLEAN NOT NULL DEFAULT false;

-- Backfill known auto bucket rows from older versions.
UPDATE "StoreCollection"
SET
  "isSystemGenerated" = true,
  "visibility" = 'PRIVATE'::"CollectionVisibility"
WHERE "title" = 'Store Products'
  AND COALESCE("description", '') IN ('', 'System bucket for standalone products.');

-- Prevent duplicate auto buckets per owner under race conditions.
CREATE UNIQUE INDEX IF NOT EXISTS "StoreCollection_ownerId_system_unique_idx"
ON "StoreCollection" ("ownerId")
WHERE "isSystemGenerated" = true;
