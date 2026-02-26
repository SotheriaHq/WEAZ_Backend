-- Baseline migration to reconcile drift without data loss.
-- Adds missing enums/tables/columns and aligns constraints to current Prisma schema.

DO $$ BEGIN
  CREATE TYPE "PatchMode" AS ENUM ('USER_TO_BRAND', 'BRAND_TO_BRAND');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "ProfileVisibility" AS ENUM ('UNLOCKED', 'LOCKED');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "SavedItemType" AS ENUM ('COLLECTION', 'COLLECTION_MEDIA');
EXCEPTION WHEN duplicate_object THEN null; END $$;

ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "profileVisibility" "ProfileVisibility" NOT NULL DEFAULT 'UNLOCKED';

CREATE TABLE IF NOT EXISTS "CollectionPatch" (
  "_id" UUID NOT NULL,
  "collectionId" UUID NOT NULL,
  "patchingBrandId" UUID NOT NULL,
  "weight" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "CollectionPatch_pkey" PRIMARY KEY ("_id")
);

DO $$ BEGIN
  ALTER TABLE "CollectionPatch"
    ADD CONSTRAINT "CollectionPatch_collectionId_fkey"
    FOREIGN KEY ("collectionId") REFERENCES "Collection"("_id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "CollectionPatch"
    ADD CONSTRAINT "CollectionPatch_patchingBrandId_fkey"
    FOREIGN KEY ("patchingBrandId") REFERENCES "User"("_id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE TABLE IF NOT EXISTS "PatchConnection" (
  "_id" UUID NOT NULL,
  "requesterId" UUID NOT NULL,
  "targetId" UUID NOT NULL,
  "status" "PatchStatus" NOT NULL DEFAULT 'ACCEPTED',
  "mode" "PatchMode" NOT NULL DEFAULT 'USER_TO_BRAND',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "PatchConnection_pkey" PRIMARY KEY ("_id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "PatchConnection_requesterId_targetId_key"
  ON "PatchConnection"("requesterId", "targetId");
CREATE INDEX IF NOT EXISTS "PatchConnection_targetId_status_idx"
  ON "PatchConnection"("targetId", "status");
CREATE INDEX IF NOT EXISTS "PatchConnection_requesterId_status_idx"
  ON "PatchConnection"("requesterId", "status");

DO $$ BEGIN
  ALTER TABLE "PatchConnection"
    ADD CONSTRAINT "PatchConnection_requesterId_fkey"
    FOREIGN KEY ("requesterId") REFERENCES "User"("_id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "PatchConnection"
    ADD CONSTRAINT "PatchConnection_targetId_fkey"
    FOREIGN KEY ("targetId") REFERENCES "User"("_id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE TABLE IF NOT EXISTS "SavedItem" (
  "_id" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "targetType" "SavedItemType" NOT NULL,
  "targetId" UUID NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "SavedItem_pkey" PRIMARY KEY ("_id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "SavedItem_userId_targetType_targetId_key"
  ON "SavedItem"("userId", "targetType", "targetId");
CREATE INDEX IF NOT EXISTS "SavedItem_userId_createdAt_idx"
  ON "SavedItem"("userId", "createdAt");
CREATE INDEX IF NOT EXISTS "SavedItem_targetType_targetId_idx"
  ON "SavedItem"("targetType", "targetId");

DO $$ BEGIN
  ALTER TABLE "SavedItem"
    ADD CONSTRAINT "SavedItem_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("_id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DROP TABLE IF EXISTS "Patch";
