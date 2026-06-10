CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE "UserProfile"
ADD COLUMN "profilePhotoUpdatedAt" TIMESTAMP(3);

CREATE TABLE "ProfilePhotoView" (
  "_id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "ownerId" UUID NOT NULL,
  "viewerId" UUID NOT NULL,
  "photoUpdatedAt" TIMESTAMP(3) NOT NULL,
  "viewedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ProfilePhotoView_pkey" PRIMARY KEY ("_id")
);

ALTER TABLE "ProfilePhotoView"
ADD CONSTRAINT "ProfilePhotoView_ownerId_fkey"
FOREIGN KEY ("ownerId") REFERENCES "User"("_id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ProfilePhotoView"
ADD CONSTRAINT "ProfilePhotoView_viewerId_fkey"
FOREIGN KEY ("viewerId") REFERENCES "User"("_id")
ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX "ProfilePhotoView_ownerId_viewerId_photoUpdatedAt_key"
ON "ProfilePhotoView"("ownerId", "viewerId", "photoUpdatedAt");

CREATE INDEX "ProfilePhotoView_ownerId_photoUpdatedAt_idx"
ON "ProfilePhotoView"("ownerId", "photoUpdatedAt");

CREATE INDEX "ProfilePhotoView_viewerId_viewedAt_idx"
ON "ProfilePhotoView"("viewerId", "viewedAt");
