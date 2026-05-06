-- Phase 1 user-management refactor: add a dedicated profile table while
-- keeping legacy User profile columns in place for compatibility.
CREATE TABLE "UserProfile" (
    "_id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "phoneNumber" TEXT,
    "address" TEXT,
    "profileImage" TEXT,
    "profileImageId" UUID,
    "bannerImage" TEXT,
    "bannerImageId" UUID,
    "profileVisibility" "ProfileVisibility" NOT NULL DEFAULT 'UNLOCKED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserProfile_pkey" PRIMARY KEY ("_id")
);

CREATE UNIQUE INDEX "UserProfile_userId_key" ON "UserProfile"("userId");
CREATE INDEX "UserProfile_profileVisibility_idx" ON "UserProfile"("profileVisibility");

ALTER TABLE "UserProfile"
ADD CONSTRAINT "UserProfile_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("_id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "UserProfile"
ADD CONSTRAINT "UserProfile_profileImageId_fkey"
FOREIGN KEY ("profileImageId") REFERENCES "FileUpload"("_id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "UserProfile"
ADD CONSTRAINT "UserProfile_bannerImageId_fkey"
FOREIGN KEY ("bannerImageId") REFERENCES "FileUpload"("_id") ON DELETE SET NULL ON UPDATE CASCADE;
