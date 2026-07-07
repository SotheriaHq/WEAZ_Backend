-- Draft update rate limit: max 2 saves per rolling 24-hour window (per draft).
ALTER TABLE "Collection" ADD COLUMN IF NOT EXISTS "draftUpdatesInWindow" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Collection" ADD COLUMN IF NOT EXISTS "draftUpdateWindowStart" TIMESTAMP(3);

ALTER TABLE "Design" ADD COLUMN IF NOT EXISTS "draftUpdatesInWindow" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Design" ADD COLUMN IF NOT EXISTS "draftUpdateWindowStart" TIMESTAMP(3);