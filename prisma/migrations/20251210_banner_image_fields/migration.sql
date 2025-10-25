-- Add banner image metadata columns to User table
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "bannerImage" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "bannerImageId" UUID;

-- Ensure FK to FileUpload (optional relationship for banner assets)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints tc
    WHERE tc.constraint_name = 'User_bannerImageId_fkey'
      AND tc.table_name = 'User'
  ) THEN
    ALTER TABLE "User"
      ADD CONSTRAINT "User_bannerImageId_fkey"
      FOREIGN KEY ("bannerImageId")
      REFERENCES "FileUpload"("_id")
      ON DELETE SET NULL
      ON UPDATE CASCADE;
  END IF;
END $$;
