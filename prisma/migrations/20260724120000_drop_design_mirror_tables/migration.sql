-- Design <-> Collection decoupling (boundary decouple): drop the standalone
-- Design mirror tables. Designs are persisted as Collection(domain = DESIGN);
-- these mirror tables (Design / DesignMedia / DesignDraftSession) were
-- non-authoritative and are unused after the read/write repoint to Collection.
--
-- The designId scalar columns on EntityFilter / reviews / review_prompts are
-- RETAINED for historical rows (no data loss) — only their foreign-key
-- constraints to the now-dropped Design table are removed.
--
-- ─── 2026-07-30 correction ────────────────────────────────────────────────────
-- This migration FAILED on its first apply (2026-07-24 08:15 UTC, 0 steps
-- applied) and then blocked every later deploy with P3009. Deploys still ran
-- `npm ci` (postinstall: prisma generate) and `prisma generate` BEFORE the
-- migration step, so each failed deploy regenerated a Prisma client with no
-- Design models while the running source still included `designMedias` — which
-- is how SIT started returning 500 from every media URL, the owner catalog and
-- the drafts tab on 2026-07-28 17:52 (289 PrismaClientValidationErrors).
--
-- Two defects, both fixed below:
--   1. The ALTER TABLE statements used Prisma MODEL names, but Review and
--      ReviewPrompt are @@map'd to "reviews" and "review_prompts".
--      `DROP CONSTRAINT IF EXISTS` guards the CONSTRAINT, not the TABLE, so
--      `ALTER TABLE "Review"` raised 42P01 relation "Review" does not exist and
--      aborted the whole migration.
--   2. No `ALTER TABLE IF EXISTS`, so any absent table aborts it again.
--
-- Verified against wiez_sit before re-applying: the only foreign keys into these
-- three tables were reviews_designId_fkey and review_prompts_designId_fkey
-- (EntityFilter.designId carries no constraint at all, so that statement is a
-- deliberate no-op kept for other environments), and all three tables held
-- 0 rows — so this drops no data.

-- DropForeignKey (retained tables that referenced the Design table).
-- ALTER TABLE IF EXISTS is required: IF EXISTS on DROP CONSTRAINT does not make
-- a missing table tolerable.
ALTER TABLE IF EXISTS "EntityFilter" DROP CONSTRAINT IF EXISTS "EntityFilter_designId_fkey";
ALTER TABLE IF EXISTS "reviews" DROP CONSTRAINT IF EXISTS "reviews_designId_fkey";
ALTER TABLE IF EXISTS "review_prompts" DROP CONSTRAINT IF EXISTS "review_prompts_designId_fkey";

-- DropTable (CASCADE clears the circular Design <-> DesignMedia foreign keys and
-- any remaining constraints that depend on these mirror tables)
DROP TABLE IF EXISTS "DesignDraftSession" CASCADE;
DROP TABLE IF EXISTS "DesignMedia" CASCADE;
DROP TABLE IF EXISTS "Design" CASCADE;
