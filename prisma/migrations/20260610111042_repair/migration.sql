-- AlterTable
-- Guarded: this drift-repair migration carries a timestamp (11:10:42) that sorts
-- BEFORE the migration that creates "ProfilePhotoView" (20260610120000, 12:00:00).
-- On a fresh database the table does not exist yet when this runs, so the bare
-- ALTER fails with 42P01. The guard makes it a no-op on fresh databases while
-- preserving the original behavior on databases where the table already exists.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = 'ProfilePhotoView'
  ) THEN
    ALTER TABLE "ProfilePhotoView"
      ALTER COLUMN "_id" DROP DEFAULT,
      ALTER COLUMN "updatedAt" DROP DEFAULT;
  END IF;
END $$;
