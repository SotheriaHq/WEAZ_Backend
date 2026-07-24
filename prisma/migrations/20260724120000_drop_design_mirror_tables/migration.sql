-- Design <-> Collection decoupling (boundary decouple): drop the standalone
-- Design mirror tables. Designs are persisted as Collection(domain = DESIGN);
-- these mirror tables (Design / DesignMedia / DesignDraftSession) were
-- non-authoritative and are unused after the read/write repoint to Collection.
--
-- The designId scalar columns on EntityFilter / Review / ReviewPrompt are
-- RETAINED for historical rows (no data loss) — only their foreign-key
-- constraints to the now-dropped Design table are removed.

-- DropForeignKey (retained tables that referenced the Design table)
ALTER TABLE "EntityFilter" DROP CONSTRAINT IF EXISTS "EntityFilter_designId_fkey";
ALTER TABLE "Review" DROP CONSTRAINT IF EXISTS "Review_designId_fkey";
ALTER TABLE "ReviewPrompt" DROP CONSTRAINT IF EXISTS "ReviewPrompt_designId_fkey";

-- DropTable (CASCADE clears the circular Design <-> DesignMedia foreign keys and
-- any remaining constraints that depend on these mirror tables)
DROP TABLE IF EXISTS "DesignDraftSession" CASCADE;
DROP TABLE IF EXISTS "DesignMedia" CASCADE;
DROP TABLE IF EXISTS "Design" CASCADE;
